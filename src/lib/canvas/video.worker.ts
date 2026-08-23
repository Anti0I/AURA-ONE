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
 * 3.87 MB here against 9.95 MB as WebP stills.
 *
 * Three things this file has to get right:
 *
 *  - **Seeking backwards.** A frame can only be decoded from the keyframe at or
 *    before it, so a backwards jump costs up to a full GOP of decodes. Frames
 *    passed through on the way are composited and posted anyway rather than
 *    thrown away — the player is about to want most of them, and they have
 *    already been paid for.
 *  - **Streaming.** Parsing starts on the first network chunk, so the hero can
 *    draw as soon as the opening keyframe has landed rather than after 3.87 MB.
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

/**
 * How much buffered work the decoder may hold, in milliseconds.
 *
 * A decoder is a FIFO, so its queue is not a buffer — it is *latency*. A frame
 * requested now comes out after everything already queued has come out, and
 * queue depth measured in frames hides that completely: twenty-four frames is
 * forty milliseconds of latency where a composite costs 1.65 ms, and nine
 * hundred where it costs 38. Both of those are real machines. The first is a
 * discrete GPU, the second is the same code on a software rasteriser, and on
 * the second the picture froze for the better part of a second while the
 * decoder ran flat out delivering frames the playhead had passed long ago.
 *
 * So the depth is derived from measured cost instead. Roughly five animation
 * frames of work: enough that the decoder is never idle waiting to be topped
 * up, short enough that a request is served while it still means something.
 */
const TARGET_QUEUE_MS = 80;

/** Bounds on the derived depth. Two is the shallowest that still pipelines. */
const MIN_QUEUE = 2;
const MAX_QUEUE = 32;

let variant: VideoVariant | null = null;
let decoder: VideoDecoder | null = null;
let compositor: MatteCompositor | null = null;
const reader = new IvfReader();

/**
 * Frames a reset is worth, expressed as decodes.
 *
 * `reset()` plus `configure()` tears down and rebuilds the decoder's pipeline.
 * Jumping forward to a keyframe only pays when it saves more decodes than the
 * reset itself costs — under that, the cheapest thing a decoder can do is keep
 * going.
 */
const RESET_COST = 4;

/**
 * How far past the frame on screen the decode head may run.
 *
 * Decoding ahead is how a scrub stays smooth, but only up to a point: the head
 * cannot come back without a reset, so every frame it runs ahead is a frame the
 * playhead may later have to rewind for. Deep enough to keep the decoder busy
 * across a slow main thread, shallow enough that when the scroll stops the
 * overshoot is a fraction of a GOP rather than a full seek.
 */
const LEAD = 32;

/**
 * Measured cost of composing one frame, in milliseconds.
 *
 * Seeded high so the first few frames are served at a shallow depth: being
 * briefly too cautious costs a little throughput, being briefly too deep costs
 * a visible freeze.
 */
let composeMs = 8;

/** Queue depth the measured composite cost can afford. */
function queueDepth(): number {
  return Math.max(
    MIN_QUEUE,
    Math.min(MAX_QUEUE, Math.round(TARGET_QUEUE_MS / Math.max(0.2, composeMs))),
  );
}

let generation = 0;
let decodeWidth = 0;
/** Index of the last chunk handed to the decoder, or -1 for nothing yet. */
let head = -1;
let downloadDone = false;
let scheduled = false;

/** Frames the player has asked for and not yet been sent. */
const wanted = new Set<number>();

/**
 * The one frame the playhead is on, or -1.
 *
 * Latest wins, deliberately. Urgency used to be a flag that never downgraded,
 * so after a second of scrubbing thirty frames were all "urgent" and the
 * scheduler picked whichever was nearest the head — which is to say, the
 * oldest. Every frame it then delivered was aimed at where the playhead had
 * been when the request went out, and at speed that is a long way from where
 * the playhead is when the frame arrives: measured at fifty-four frames, far
 * outside the range `nearest()` will substitute across, so the canvas showed
 * nothing new for half a second and then jumped.
 *
 * A scrubber only ever has one frame that matters, and it is the most recent
 * one asked for.
 */
let urgentIndex = -1;

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

/** Inclusive range of frames the player still wants. See `window`. */
let windowLo = -Infinity;
let windowHi = Infinity;

function onFrame(frame: VideoFrame) {
  // The timestamp is the frame index; see `feed`.
  const index = frame.timestamp;
  inFlight.delete(index);

  try {
    if (!wanted.has(index) || !compositor || !variant || decodeWidth === 0) {
      return;
    }
    const startedAt = performance.now();
    const bitmap = compositor.compose(frame, decodeWidth, variant.matteX);
    // The number the queue depth is derived from. Measured rather than assumed
    // because it varies by three hundred times between a GPU and a software
    // rasteriser, and the right queue depth varies with it.
    composeMs += (performance.now() - startedAt - composeMs) * 0.2;
    wanted.delete(index);
    if (index === urgentIndex) urgentIndex = -1;
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
/**
 * Which outstanding request to work towards next.
 *
 * The order below is the whole scheduler, and every line of it was paid for.
 *
 * A decoder can only move forwards. Going back means `reset()`, which drops
 * everything in flight, so the cost of a rewind is not the seek — it is the
 * sweep it throws away. During a fast scrub the head is deliberately ahead of
 * the playhead, which means *the frame on screen is usually behind the head*.
 * Chasing it therefore rewinds, and because the playhead keeps moving it
 * rewinds again on the next tick, and again: measured as half a second in which
 * the decoder was continuously busy and delivered three frames.
 *
 * So the rule is: while there is anything ahead worth decoding, keep sweeping
 * forward. Rewind only when the sweep has genuinely run out — the scroll
 * reversed, or stopped past everything we have.
 */
function pickTarget(): number {
  let ahead = -1;
  let behind = -1;

  for (const index of wanted) {
    if (index >= reader.frames.length || inFlight.has(index)) continue;
    if (index > head && (ahead < 0 || index < ahead)) ahead = index;
    // The *lowest* one behind, not the nearest. Reaching anything behind the
    // head costs a rewind, and a scroll running backwards asks for a whole
    // ladder of them: taking the nearest one first means the next request is
    // behind the new head as well, and every frame costs its own reset. Going
    // to the bottom of the ladder instead turns the same work into one rewind
    // and one forward sweep that passes through all of them. They arrive in the
    // opposite order to the one the playhead wants, which does not matter —
    // they land in the cache either way.
    if (index <= head && (behind < 0 || index < behind)) behind = index;
  }

  const urgentUsable =
    urgentIndex >= 0 &&
    urgentIndex < reader.frames.length &&
    !inFlight.has(urgentIndex);

  // The frame on screen, when reaching it costs nothing but forward motion.
  if (urgentUsable && urgentIndex > head) return urgentIndex;
  // Otherwise keep the sweep going. Whatever comes out next is close to the
  // playhead by construction, because the head is bounded to `LEAD` past it.
  if (ahead >= 0) return ahead;
  // Nothing ahead. Now a rewind is the only way to make progress, so it is
  // worth what it costs — but never at the price of work already in flight.
  if (inFlight.size > 0) return -1;
  if (urgentUsable) return urgentIndex;
  return behind;
}

function pump() {
  if (!decoder || decoder.state !== "configured") return;
  if (decodeWidth === 0) return;

  if (downloadDone) {
    // Nothing more is coming that could satisfy these.
    for (const index of [...wanted]) {
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

  // Behind the head: there is no choice, a frame only decodes from the
  // keyframe at or before it. Ahead of the head: a choice, and the old rule
  // ("further than a GOP") got it wrong in both directions. What actually
  // decides it is where the target's keyframe sits. If it is at or behind the
  // head, walking forward is free of any reset and strictly cheaper. If it is
  // ahead, jumping there skips everything in between — but only pays once the
  // skip is bigger than the reset.
  const key = keyframeFor(target);
  const sweeping = target <= head;
  if (sweeping) {
    // Behind the head. No choice: a frame only decodes from the keyframe at or
    // before it.
    rewind(target);
  } else if (key > head + RESET_COST + inFlight.size) {
    // Ahead of the head, and far enough ahead that skipping to its keyframe
    // saves more than it costs.
    //
    // `inFlight.size` is the term that was missing, and leaving it out is what
    // made a fast forward scrub fall apart. A reset drops every chunk the
    // decoder is holding, so shortcutting past twelve frames while twenty-four
    // are in flight throws away twice what it saves — and then the next tick
    // does it again. The symptom was a decoder that looked saturated
    // (inflight=24) one moment and empty the next, delivering a tenth of what
    // it was capable of.
    rewind(target);
  }

  // Walk forward to the furthest thing asked for, but not past a bounded lead.
  // Frames in between are composited if they were wanted and dropped in
  // `onFrame` if they were not, which costs one decode either way.
  //
  // The bound is the part that matters. Left unbounded the head sprints to the
  // end of the film during a fast scrub — the requested ladder reaches that far
  // — and from then on every frame the playhead asks for is *behind* the head,
  // so every tick ends in a rewind and nothing is ever delivered.
  let furthest = target;
  // After a rewind the head is at the bottom of everything still wanted, so
  // the sweep should run all the way up through it — that rewind has already
  // been paid for and stopping short of the ladder means paying for another
  // one. Going forwards the lead stays bounded, because there the head is
  // ahead of the playhead and every frame it overruns is one the playhead may
  // have to rewind for later.
  const limit = sweeping ? reader.frames.length : target + LEAD;
  for (const index of wanted) {
    if (index < reader.frames.length && index > furthest && index <= limit) {
      furthest = index;
    }
  }

  const depth = queueDepth();
  while (head < furthest && decoder.decodeQueueSize < depth) {
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

  if (message.type === "window") {
    windowLo = message.lo;
    windowHi = message.hi;
    if (urgentIndex < windowLo || urgentIndex > windowHi) urgentIndex = -1;
    // Everything outside the window is work the playhead has already moved
    // past. Dropping it here is the difference between a scheduler that chases
    // the scroll and one that trails it: without this the queue only ever
    // shrank by being satisfied, so a fast scrub kept the decoder busy on
    // frames nobody would see, while the frame on screen waited behind them.
    for (const index of [...wanted]) {
      if (index < windowLo || index > windowHi) wanted.delete(index);
    }
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
  // A request that has already fallen outside the window arrived late — the
  // player moved on between posting it and this landing. Honour the window.
  if (message.index < windowLo || message.index > windowHi) return;
  wanted.add(message.index);
  if (message.urgent) urgentIndex = message.index;

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
