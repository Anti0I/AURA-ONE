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
  pointerX: 0,
  pointerY: 0,
  heapMB: null,
  canvasWidth: 0,
  canvasHeight: 0,
  dpr: 1,
};

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
