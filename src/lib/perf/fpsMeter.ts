"use client";

import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { telemetry } from "@/store/transient";

/** Frames kept for the rolling average and the sparkline. */
const WINDOW = 120;

const samples = new Float32Array(WINDOW);
let cursor = 0;
let filled = 0;
let worstSince = Infinity;
let sinceHeapRead = 0;
let refCount = 0;
let detach: (() => void) | null = null;

/**
 * Frame-rate meter.
 *
 * Instantaneous 1/delta is useless as a readout — it swings between 55 and 65
 * on a perfectly healthy 60 Hz display and looks like a problem. What matters
 * is the average over a window and, much more, the *worst* frame in it: a
 * scrub that averages 118 fps while dropping to 22 twice a second feels broken,
 * and only the minimum says so.
 *
 * The worst-case resets each time it is read, so the HUD shows "the worst frame
 * since you last looked" rather than the worst frame since page load, which
 * would freeze on whatever happened during the boot.
 */
export function startFpsMeter(): () => void {
  refCount++;
  if (detach) return stop;

  detach = onFrame((f) => {
    if (f.delta <= 0) return;
    const fps = 1 / f.delta;

    samples[cursor] = fps;
    cursor = (cursor + 1) % WINDOW;
    if (filled < WINDOW) filled++;
    if (fps < worstSince) worstSince = fps;

    let sum = 0;
    for (let i = 0; i < filled; i++) sum += samples[i]!;
    telemetry.fps = sum / filled;
    telemetry.fpsMin = worstSince;

    // `performance.memory` is a Chromium extension and is quantised anyway;
    // reading it every frame buys nothing but costs a bridge call.
    sinceHeapRead += f.delta;
    if (sinceHeapRead > 0.5) {
      sinceHeapRead = 0;
      const memory = (
        performance as Performance & { memory?: { usedJSHeapSize: number } }
      ).memory;
      telemetry.heapMB = memory ? memory.usedJSHeapSize / 1024 / 1024 : null;
    }
  }, Priority.MEASURE);

  return stop;
}

function stop() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  detach?.();
  detach = null;
  filled = 0;
  cursor = 0;
  worstSince = Infinity;
}

/** Clears the worst-frame watermark. Called when the HUD paints it. */
export function resetWorstFrame() {
  worstSince = telemetry.fps || Infinity;
}

/**
 * Copies the sparkline history in chronological order.
 * Writes into the caller's buffer so the HUD's draw loop allocates nothing.
 */
export function readHistory(out: Float32Array): number {
  const count = filled;
  for (let i = 0; i < count; i++) {
    out[i] = samples[(cursor - count + i + WINDOW * 2) % WINDOW]!;
  }
  return count;
}

export const FPS_WINDOW = WINDOW;
