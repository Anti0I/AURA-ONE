/// <reference lib="webworker" />

/**
 * Frame source backed by WebCodecs.
 *
 * Speaks exactly the same protocol as `decoder.worker.ts` and hands back the
 * same `ImageBitmap`s, so the player, the LRU, the byte budget and the draw
 * path do not know or care which one is running. The still sequence stays as
 * the fallback for browsers without `VideoDecoder`.
 *
 * The reason a video is viable at all — after the whole player was built on the
 * premise that video cannot be scrubbed — is that the premise was never about
 * the codec. `video.currentTime = x` is a *request* to seek that the element
 * answers whenever it likes, coalescing and dropping seeks under a fast scrub.
 * `VideoDecoder` has no seeking in it: you hand it chunks, it hands back
 * frames, in order. What that buys is inter-frame prediction, and a slowly
 * rotating object is about as predictable as content gets — 240 frames cost
 * 3.34 MB here against 9.09 MB as WebP stills.
 *
 * Three things this file has to get right:
 *
 *  - **Seeking backwards.** A frame can only be decoded from the keyframe at or
 *    before it, so a backwards jump costs up to a full GOP of decodes. Frames
 *    passed through on the way are composited and posted anyway rather than
 *    thrown away — the player is about to want most of them, and they have
 *    already been paid for.
 *  - **Streaming.** Parsing starts on the first network chunk, so the hero can
 *    draw as soon as the opening keyframe has landed rather than after 3.34 MB.
 *  - **Closing frames.** A `VideoFrame` pins a decoder buffer. Hold a handful
 *    without closing them and the decoder stalls waiting on its own pool.
 */

import type {
  DecodeRequest,
  DecodeResponse,
  VideoVariant,
} from "@/types/sequence";
import { IvfReader } from "./ivf";
import { MatteCompositor } from "./matte";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Chunks in flight before we stop feeding and wait for `dequeue`. */
const MAX_QUEUE = 8;

let variant: VideoVariant | null = null;
let decoder: VideoDecoder | null = null;
let compositor: MatteCompositor | null = null;
const reader = new IvfReader();

/**
 * How far ahead of the decode head a request may sit before we give up on
 * walking to it and restart from its keyframe instead.
 *
 * Below the GOP length a jump is never worth it: decoding forward one frame at
 * a time is strictly cheaper than restarting and decoding the same count again.
 */
let jumpThreshold = 16;

let generation = 0;
let decodeWidth = 0;
/** Index of the last chunk handed to the decoder, or -1 for nothing yet. */
let head = -1;
let downloadDone = false;
let scheduled = false;

/** Frames the player has asked for and not yet been sent; value is urgency. */
const wanted = new Map<number, boolean>();

/**
 * Frames handed to the decoder that have not come back out yet.
 *
 * Without this the scheduler cannot tell "you already asked for that, it is
 * coming" from "that is behind the head, rewind" — and picks the second. The
 * first version did exactly that: the opening frame was fed, stayed in `wanted`
 * until its output arrived, and every subsequent network chunk saw a wanted
 * frame behind the head and reset the decoder. It never produced a single
 * frame, and it never errored either, because resetting a decoder is a
 * perfectly legal thing to do.
 */
const inFlight = new Set<number>();

function post(message: DecodeResponse, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer ?? []);
}

function fail(reason: string) {
  post({ type: "unsupported", reason });
  if (decoder && decoder.state !== "closed") decoder.close();
  decoder = null;
}

function config(): VideoDecoderConfig {
  const v = variant;
  if (!v) throw new Error("no variant");
  return {
    codec: v.codec,
    codedWidth: v.packedWidth,
    codedHeight: v.packedHeight,
    optimizeForLatency: true,
  };
}

// ---- Decoder ---------------------------------------------------------------

function onFrame(frame: VideoFrame) {
  // The timestamp is the frame index; see `feed`.
  const index = frame.timestamp;
  inFlight.delete(index);

  try {
    if (!wanted.has(index) || !compositor || !variant || decodeWidth === 0) {
      return;
    }
    const bitmap = compositor.compose(frame, decodeWidth, variant.matteX);
    wanted.delete(index);
    post(
      {
        type: "decoded",
        index,
        bitmap,
        bytes: bitmap.width * bitmap.height * 4,
        generation,
      },
      [bitmap],
    );
  } catch (error) {
    wanted.delete(index);
    post({
      type: "failed",
      index,
      generation,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // On every path. This is the buffer the decoder needs back.
    frame.close();
  }
}

async function open(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") {
    fail("VideoDecoder is not available");
    return false;
  }

  try {
    const support = await VideoDecoder.isConfigSupported(config());
    if (!support.supported) {
      fail(`${variant?.codec} is not supported`);
      return false;
    }
    compositor = new MatteCompositor(
      variant!.packedWidth,
      variant!.packedHeight,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return false;
  }

  decoder = new VideoDecoder({
    output: onFrame,
    error: (error) => fail(error.message),
  });
  decoder.configure(config());
  decoder.addEventListener("dequeue", () => pump());
  head = -1;
  return true;
}

/** Index of the keyframe at or before `index`. */
function keyframeFor(index: number): number {
  for (let i = Math.min(index, reader.frames.length - 1); i >= 0; i--) {
    if (reader.frames[i]?.key) return i;
  }
  return 0;
}

function feed(index: number) {
  const frame = reader.frames[index];
  if (!frame || !decoder) return;
  decoder.decode(
    new EncodedVideoChunk({
      type: frame.key ? "key" : "delta",
      // The timestamp is the frame index. Nothing here cares about wall-clock
      // time, and it is what lets `output` say which frame it just produced
      // without tracking submission order separately.
      timestamp: index,
      data: frame.data,
    }),
  );
  inFlight.add(index);
  head = index;
}

/** Drops everything queued and rewinds the head to just before `index`. */
function rewind(index: number) {
  decoder!.reset();
  decoder!.configure(config());
  inFlight.clear();
  head = keyframeFor(index) - 1;
}

/**
 * Which outstanding request to work towards next.
 *
 * The order matters more than it looks, because rewinding is not free: it drops
 * everything in flight, so a policy that simply picks the nearest request
 * spends its whole time restarting. The player asks for a window *around* the
 * playhead — look-behind included, for scroll reversals — and every one of
 * those behind-frames looks "nearest" the moment the head passes it.
 *
 * So: the frame on screen first, then anything ahead, and only when there is
 * nothing ahead left to do is it worth rewinding for the ones behind. That last
 * case sweeps forward to the end of the whole requested window in one pass, so
 * it happens once rather than repeatedly.
 */
function pickTarget(): number {
  let urgent = -1;
  let ahead = -1;
  let behind = -1;

  for (const [index, isUrgent] of wanted) {
    if (index >= reader.frames.length || inFlight.has(index)) continue;
    if (
      isUrgent &&
      (urgent < 0 || Math.abs(index - head) < Math.abs(urgent - head))
    ) {
      urgent = index;
    }
    if (index > head && (ahead < 0 || index < ahead)) ahead = index;
    if (index <= head && (behind < 0 || index > behind)) behind = index;
  }

  if (urgent >= 0) return urgent;
  if (ahead >= 0) return ahead;
  return behind;
}

function pump() {
  if (!decoder || decoder.state !== "configured") return;
  if (decodeWidth === 0) return;

  if (downloadDone) {
    // Nothing more is coming that could satisfy these.
    for (const index of [...wanted.keys()]) {
      if (index >= reader.frames.length) {
        wanted.delete(index);
        post({
          type: "failed",
          index,
          generation,
          message: "frame beyond end of stream",
        });
      }
    }
  }

  if (wanted.size === 0) return;

  const target = pickTarget();
  if (target < 0) return;

  // Behind the head, or too far in front to be worth walking to: restart from
  // the nearest keyframe. Dropping what is in flight is the right call — those
  // frames belong to a part of the timeline the playhead has left.
  if (target <= head || target - head > jumpThreshold) rewind(target);

  // Walk forward to the furthest thing anyone has asked for. Frames in between
  // are composited if they were wanted and dropped in `onFrame` if they were
  // not, which costs one decode either way — and the player is usually about to
  // want them.
  let furthest = target;
  for (const index of wanted.keys()) {
    if (index < reader.frames.length && index > furthest) furthest = index;
  }

  while (head < furthest && decoder.decodeQueueSize < MAX_QUEUE) {
    feed(head + 1);
  }
}

// ---- Download --------------------------------------------------------------

async function download(url: string) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok || !response.body) {
    fail(`HTTP ${response.status}`);
    return;
  }

  const stream = response.body.getReader();
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    // Parsing as the bytes land is what lets the opening keyframe decode after
    // roughly a hundred kilobytes rather than after the whole file.
    reader.push(value);
    pump();
  }
  downloadDone = true;
  pump();
}

// ---- Protocol --------------------------------------------------------------

ctx.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const message = event.data;

  if (message.type === "open") {
    variant = message.video;
    jumpThreshold = variant.gop;
    void (async () => {
      if (!(await open())) return;
      try {
        await download(variant!.url);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();
    return;
  }

  if (message.type === "drop") {
    generation = message.generation;
    wanted.clear();
    return;
  }

  if (message.type !== "decode") return;

  if (message.generation !== generation) {
    // The decode size changed, so everything already queued would come back at
    // the wrong resolution. The decoder is unaffected — only the compositor's
    // output size is — so there is nothing to reset here.
    generation = message.generation;
    wanted.clear();
  }

  decodeWidth = message.decodeWidth;
  // Urgency never downgrades: a frame that was urgent once is the one on
  // screen, and a later prefetch request for it should not demote it.
  wanted.set(
    message.index,
    message.urgent || (wanted.get(message.index) ?? false),
  );

  if (!scheduled) {
    scheduled = true;
    // One prefetch pass sends up to twenty requests. Coalescing them into a
    // single scheduling decision avoids re-planning the whole queue each time.
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }
};
