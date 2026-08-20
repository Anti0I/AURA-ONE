/**
 * The page has exactly one animation loop.
 *
 * Every module that needs per-frame work (canvas blit, cursor damping,
 * particles, FPS meter, HUD sampling) subscribes here instead of calling
 * `requestAnimationFrame` itself. Two reasons:
 *
 *  1. Ordering. Subscribers run in ascending `priority`, so scroll state is
 *     always committed before anything draws with it. Independent rAF
 *     callbacks give you a one-frame lag that reads as jitter at 120 Hz.
 *  2. Cost. One loop means one `performance.now()` and one delta computation
 *     per frame, and it can be parked entirely when the tab is hidden.
 *
 * The driver starts as native rAF so the preloader can animate before GSAP is
 * on the page, then hands over to `gsap.ticker` once the scroll module loads.
 * Sharing GSAP's ticker is what guarantees we draw *after* ScrollTrigger has
 * updated, in the same frame.
 */

export interface FrameInfo {
  /** Seconds since the loop started. */
  time: number;
  /** Seconds since the previous frame, clamped to avoid tab-switch spikes. */
  delta: number;
}

export type FrameTask = (frame: FrameInfo) => void;

export const Priority = {
  /** Scroll and pointer state commit. */
  INPUT: 0,
  /** Canvas draws that consume that state. */
  RENDER: 100,
  /** Measurement that must observe the finished frame. */
  MEASURE: 200,
} as const;

interface Entry {
  task: FrameTask;
  priority: number;
}

const entries: Entry[] = [];
const frame: FrameInfo = { time: 0, delta: 0 };

let running = false;
let rafId = 0;
let startedAt = 0;
let lastAt = 0;
let driver: "native" | "gsap" = "native";
let gsapTicker: { remove: (fn: () => void) => void } | null = null;

/** A stall longer than this is a tab switch, not a slow frame. */
const MAX_DELTA = 1 / 20;

function step(nowMs: number) {
  frame.time = (nowMs - startedAt) / 1000;
  frame.delta = Math.min((nowMs - lastAt) / 1000, MAX_DELTA);
  lastAt = nowMs;

  // Indexed loop, no allocation, no iterator: this runs 120x/second.
  for (let i = 0; i < entries.length; i++) {
    entries[i]!.task(frame);
  }
}

function nativeLoop(nowMs: number) {
  rafId = requestAnimationFrame(nativeLoop);
  step(nowMs);
}

function gsapLoop() {
  step(performance.now());
}

function start() {
  if (running) return;
  running = true;
  startedAt = lastAt = performance.now();

  if (driver === "gsap" && gsapTicker) {
    (gsapTicker as unknown as { add: (fn: () => void) => void }).add(gsapLoop);
  } else {
    rafId = requestAnimationFrame(nativeLoop);
  }
}

function stop() {
  if (!running) return;
  running = false;
  if (driver === "gsap" && gsapTicker) gsapTicker.remove(gsapLoop);
  else cancelAnimationFrame(rafId);
}

/**
 * Hand the loop over to GSAP's ticker. Called once by the scroll module after
 * it imports ScrollTrigger; safe to call more than once.
 */
export function useGsapDriver(ticker: {
  add: (fn: () => void) => void;
  remove: (fn: () => void) => void;
}) {
  if (driver === "gsap") return;
  const wasRunning = running;
  if (wasRunning) stop();
  driver = "gsap";
  gsapTicker = ticker;
  if (wasRunning) start();
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

/** Test/debug hook — never used in render paths. */
export function frameTaskCount() {
  return entries.length;
}
