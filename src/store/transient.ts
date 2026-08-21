"use client";

import { useSyncExternalStore } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";

/**
 * Per-frame telemetry, deliberately outside React.
 *
 * Producers mutate `telemetry` fields directly — a property write, no
 * allocation, no notification. The Dev Inspector is the only consumer that
 * needs to *render* these numbers, and it subscribes at 10 Hz via
 * `useTelemetry()`. Reading a value 120 times a second is free; painting it
 * 120 times a second is not, and nobody can read a number that fast anyway.
 */
export interface Telemetry {
  /** Nearest frame index currently drawn. */
  frame: number;
  /** Un-rounded scroll->frame position, useful for spotting easing bugs. */
  frameFloat: number;
  /** 0..1 through the pinned scrollytelling section. */
  storyProgress: number;
  fps: number;
  fpsMin: number;
  /** Milliseconds spent inside the canvas draw call, rolling average. */
  drawMs: number;
  /** Decoded bitmaps currently retained. */
  lruSize: number;
  lruBytes: number;
  /** Frames requested from the worker but not yet decoded. */
  decodeQueue: number;
  /**
   * Largest jump, in frames, between two consecutively *displayed* pictures.
   *
   * This is the number behind "it skips". A scrub that stays continuous holds
   * this at 1; one that falls behind the scroll and then catches up in a lump
   * reports the size of the lump. Measured on what actually reached the canvas,
   * substitutes from `nearest()` included — the substitute is what the visitor
   * sees, so it is what has to be counted.
   */
  frameGapMax: number;
  /** Total distance travelled in drawn frames, for a mean alongside the max. */
  frameGapSum: number;
  /** Number of times a different picture reached the canvas. */
  framesDrawn: number;
  /**
   * Frames that arrived after the playhead had already left them behind.
   *
   * Decoded, composited, transferred and cached for nothing — and worse, they
   * evict frames the playhead is about to reach. A healthy scrub keeps this
   * near zero; a scheduler working against the scroll makes it climb.
   */
  decodeWaste: number;
  pointerX: number;
  pointerY: number;
  /** null where the browser does not expose it (everything but Chromium). */
  heapMB: number | null;
  canvasWidth: number;
  canvasHeight: number;
  dpr: number;
}

export const telemetry: Telemetry = {
  frame: 0,
  frameFloat: 0,
  storyProgress: 0,
  fps: 0,
  fpsMin: 0,
  drawMs: 0,
  lruSize: 0,
  lruBytes: 0,
  decodeQueue: 0,
  frameGapMax: 0,
  frameGapSum: 0,
  framesDrawn: 0,
  decodeWaste: 0,
  pointerX: 0,
  pointerY: 0,
  heapMB: null,
  canvasWidth: 0,
  canvasHeight: 0,
  dpr: 1,
};

/**
 * Clears the scrub-quality watermarks.
 *
 * They are watermarks rather than rates, so a measurement has to say when it
 * started. Without this every reading carries the boot, where a gap of thirty
 * is normal and meaningless because the sequence has not arrived yet.
 */
export function resetFrameStats() {
  telemetry.frameGapMax = 0;
  telemetry.frameGapSum = 0;
  telemetry.framesDrawn = 0;
  telemetry.decodeWaste = 0;
}

/**
 * Publishes the live telemetry object on `window`, but only for `?debug=1`.
 *
 * Nothing on the page needs this: the Dev Inspector imports `telemetry`
 * directly. A test does. `window.__player` is stripped from production builds
 * and CI builds production, which left the suite with no way to assert on
 * anything happening inside the canvas — and "it skips frames" is not a claim
 * the DOM can answer. Gating on a search parameter keeps a normal visit exactly
 * as it was, at the cost of one string comparison at boot.
 */
export function exposeTelemetry() {
  if (typeof window === "undefined") return;
  if (!new URLSearchParams(window.location.search).has("debug")) return;
  const w = window as unknown as Record<string, unknown>;
  w.__telemetry = telemetry;
  w.__resetFrameStats = resetFrameStats;
}

const SAMPLE_INTERVAL = 0.1; // seconds — 10 Hz

let version = 0;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;
let accumulator = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (listeners.size === 1) {
    accumulator = 0;
    detach = onFrame((f) => {
      accumulator += f.delta;
      if (accumulator < SAMPLE_INTERVAL) return;
      accumulator = 0;
      version++;
      for (const l of listeners) l();
    }, Priority.MEASURE);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

const getSnapshot = () => version;
const getServerSnapshot = () => 0;

/**
 * Re-renders the caller at 10 Hz and hands back the live mutable object.
 * The returned reference is stable — read fields off it during render.
 */
export function useTelemetry(): Telemetry {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return telemetry;
}
