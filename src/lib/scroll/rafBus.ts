/**
 * The page has exactly one animation loop.
 *
 * Every module that needs per-frame work — the smooth-scroll integrator, the
 * canvas blit, cursor damping, particles, the FPS meter — subscribes here
 * instead of calling `requestAnimationFrame` itself. Two reasons:
 *
 *  1. Ordering. Subscribers run in ascending `priority`, so scroll position is
 *     integrated and read before anything draws with it. Independent rAF
 *     callbacks give you a one-frame lag between the canvas and the text
 *     pinned beside it — a small error that reads unmistakably as "cheap".
 *  2. Cost. One loop means one `performance.now()` and one delta per frame,
 *     and the whole thing parks when nothing is subscribed.
 *
 * The read/write split matters as much as the ordering: INPUT tasks may read
 * layout (`getBoundingClientRect`), RENDER tasks may only write. Reading after
 * a write in the same frame forces a synchronous reflow, which is the classic
 * way a scroll-linked animation ends up costing 8 ms a frame for no reason.
 */

export interface FrameInfo {
  /** Seconds since the loop started. */
  time: number;
  /** Seconds since the previous frame, clamped to avoid tab-switch spikes. */
  delta: number;
  /** Raw timestamp from rAF, for consumers that need absolute time. */
  now: number;
}

export type FrameTask = (frame: FrameInfo) => void;

export const Priority = {
  /** Integrate scroll, read layout. Layout reads are legal only here. */
  INPUT: 0,
  /** Draw. Writes only — no layout reads. */
  RENDER: 100,
  /** Measurement that must observe the finished frame. */
  MEASURE: 200,
} as const;

interface Entry {
  task: FrameTask;
  priority: number;
}

const entries: Entry[] = [];
const frame: FrameInfo = { time: 0, delta: 0, now: 0 };

let running = false;
let rafId = 0;
let startedAt = 0;
let lastAt = 0;

/** A stall longer than this is a tab switch, not a slow frame. */
const MAX_DELTA = 1 / 20;

function loop(nowMs: number) {
  rafId = requestAnimationFrame(loop);

  frame.now = nowMs;
  frame.time = (nowMs - startedAt) / 1000;
  frame.delta = Math.min((nowMs - lastAt) / 1000, MAX_DELTA);
  lastAt = nowMs;

  // Indexed loop, no allocation, no iterator: this runs up to 120x/second.
  for (let i = 0; i < entries.length; i++) {
    entries[i]!.task(frame);
  }
}

function start() {
  if (running) return;
  running = true;
  startedAt = lastAt = performance.now();
  rafId = requestAnimationFrame(loop);
}

function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
}

/** Subscribe a per-frame task. Returns an unsubscribe function. */
export function onFrame(
  task: FrameTask,
  priority: number = Priority.RENDER,
): () => void {
  const entry: Entry = { task, priority };
  entries.push(entry);
  entries.sort((a, b) => a.priority - b.priority);
  if (entries.length === 1) start();

  return () => {
    const i = entries.indexOf(entry);
    if (i !== -1) entries.splice(i, 1);
    if (entries.length === 0) stop();
  };
}

/** Test/debug hook — never called from a render path. */
export function frameTaskCount() {
  return entries.length;
}
