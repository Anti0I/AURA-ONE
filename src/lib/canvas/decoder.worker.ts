/// <reference lib="webworker" />

/**
 * Frame decoder.
 *
 * Fetch and `createImageBitmap` both run here so the main thread never decodes
 * a frame. That is the single most important decision in the whole player:
 * decoding a 1440² WebP with alpha costs 4–9 ms, and on the main thread that
 * is a dropped frame every time the scrub outruns the cache.
 *
 * Two other things this file does that a naive implementation would not:
 *
 *  - Decodes to the *display* size via `createImageBitmap`'s resize options.
 *    A bitmap is stored uncompressed, so a 1440² frame is 8.3 MB of RGBA
 *    whether or not it is ever shown at that size. Decoding to 900² instead
 *    is a 2.5x memory saving for pixels nobody can see.
 *  - Runs a two-tier queue with a hard concurrency cap. Firing 24 fetches at
 *    once means the frame you actually need queues behind 23 you do not; the
 *    urgent lane exists so a fast scrub can always jump ahead.
 */

import type { DecodeRequest, DecodeResponse } from "@/types/sequence";

const MAX_IN_FLIGHT = 4;

interface Job {
  index: number;
  url: string;
  decodeWidth: number;
  generation: number;
}

const urgent: Job[] = [];
const normal: Job[] = [];
const queued = new Set<number>();

let generation = 0;
let inFlight = 0;

/**
 * Inclusive range of frames the player still wants.
 *
 * The video worker needs this because a stale decode blocks the frame on
 * screen behind it. This one needs it for a plainer reason: a stale fetch is
 * still one of only four connections, and the urgent lane cannot help if all
 * four are busy downloading frames nobody will look at. Both sources speak the
 * one protocol, and a message only half of them honoured would be the start of
 * them drifting apart.
 */
let windowLo = -Infinity;
let windowHi = Infinity;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: DecodeResponse, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer ?? []);
}

async function run(job: Job) {
  inFlight++;
  try {
    const response = await fetch(job.url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();

    // Generation may have moved on while the bytes were in flight — decoding
    // at a stale size would put a wrong-resolution bitmap in the cache.
    if (job.generation !== generation) return;

    const bitmap = await createImageBitmap(blob, {
      resizeWidth: job.decodeWidth,
      resizeHeight: job.decodeWidth,
      resizeQuality: "medium",
    });

    if (job.generation !== generation) {
      bitmap.close();
      return;
    }

    post(
      {
        type: "decoded",
        index: job.index,
        bitmap,
        bytes: bitmap.width * bitmap.height * 4,
        generation: job.generation,
      },
      [bitmap],
    );
  } catch (error) {
    post({
      type: "failed",
      index: job.index,
      generation: job.generation,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inFlight--;
    queued.delete(job.index);
    pump();
  }
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT) {
    const job = urgent.shift() ?? normal.shift();
    if (!job) return;
    if (job.generation !== generation) {
      queued.delete(job.index);
      continue;
    }
    void run(job);
  }
}

ctx.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const message = event.data;

  if (message.type === "drop") {
    generation = message.generation;
    urgent.length = 0;
    normal.length = 0;
    queued.clear();
    return;
  }

  if (message.type === "window") {
    windowLo = message.lo;
    windowHi = message.hi;
    const inWindow = (job: Job) => {
      if (job.index >= windowLo && job.index <= windowHi) return true;
      queued.delete(job.index);
      return false;
    };
    // Filtered in place: the arrays are the queue, and replacing them would
    // leave `pump` holding the old ones on the next tick.
    urgent.splice(0, urgent.length, ...urgent.filter(inWindow));
    normal.splice(0, normal.length, ...normal.filter(inWindow));
    return;
  }

  // `open` belongs to the video worker; the two share a request type so the
  // player can talk to either without branching.
  if (message.type !== "decode") return;

  generation = message.generation;
  if (message.index < windowLo || message.index > windowHi) return;
  if (queued.has(message.index)) return;
  queued.add(message.index);

  const job: Job = {
    index: message.index,
    url: message.url,
    decodeWidth: message.decodeWidth,
    generation: message.generation,
  };
  (message.urgent ? urgent : normal).push(job);
  pump();
};
