"use client";

import { useEffect, type RefObject } from "react";
import { Starfield, type StarfieldColors } from "@/lib/canvas/Starfield";
import { readEnvironment } from "@/lib/motion";
import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { damp } from "@/lib/utils";

/**
 * Drives the acoustics starfield, or draws it once and leaves.
 *
 * Two callers, two contracts. The pinned frame passes a ref it writes every
 * frame and gets a field that accelerates; the flat layout passes `null` and
 * gets a single still frame with no subscription to anything.
 */

/** What the field needs to know, written by the section during INPUT. */
export interface WarpState {
  /** Section progress, 0..1. */
  progress: number;
  /** How much beat text is on screen: 1 while one is held, 0 mid-flight. */
  presence: number;
}

/** Speed with nothing happening. A dead starfield is worse than none. */
const CRUISE = 0.18;

/** Added back as the text clears, so the gap between beats *is* the travel. */
const BOOST = 0.55;

/** How hard the scroll itself pushes. The "scroll faster, fly faster" term. */
const GAIN = 0.85;

/** Damping on the speed. Low enough to feel like mass, high enough to respond. */
const LAMBDA = 3.4;

/** How far the field dims under a beat that is being read. */
const DIM = 0.45;

function colorsFrom(el: Element): StarfieldColors {
  const styles = getComputedStyle(el);
  return {
    star: styles.getPropertyValue("--color-star").trim() || "#c9c4bb",
    warp: styles.getPropertyValue("--color-star-warp").trim() || "#e4d9c8",
  };
}

export function useStarfield(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  state: RefObject<WarpState> | null,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { dpr, tier } = readEnvironment();
    const colors = colorsFrom(canvas);
    // Fewer stars where the field is a still image anyway, and fewer again on a
    // phone. Density is the only dial here that costs linearly.
    const field = new Starfield(state === null ? 320 : tier === "mobile" ? 280 : 900);

    let width = 0;
    let height = 0;
    let dirty = false;

    // `contentRect` is handed to us by the observer, so this is not a layout
    // read and cannot force a reflow — which matters, because the alternative
    // is measuring from inside a RENDER task where reads are illegal.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0) return;
      width = rect.width;
      height = rect.height;
      dirty = true;
      if (state === null) applyStill();
    });

    function applyStill() {
      if (!canvas || !ctx) return;
      field.resize(canvas, width, height, dpr);
      dirty = false;
      field.paintStill(ctx, colors);
    }

    observer.observe(canvas);

    if (state === null) {
      return () => observer.disconnect();
    }

    let speed = CRUISE;
    let lastProgress = state.current.progress;

    const detach = onFrameWhileVisible(
      canvas,
      (frame) => {
        if (dirty) {
          field.resize(canvas, width, height, dpr);
          dirty = false;
        }
        if (height === 0) return;

        const { progress, presence } = state.current;
        // Scroll speed, in section-fractions per second. It decays on its own
        // when the page stops, because `useSectionProgress` stops reporting and
        // the difference goes to zero — no idle detection needed.
        const velocity = Math.abs(progress - lastProgress) / frame.delta;
        lastProgress = progress;

        const target = CRUISE + BOOST * (1 - presence) + GAIN * velocity;
        speed = damp(speed, target, LAMBDA, frame.delta);

        field.step(ctx, frame.delta, speed, 1 - DIM * presence, colors);
      },
      Priority.RENDER,
    );

    return () => {
      detach();
      observer.disconnect();
    };
  }, [canvasRef, state]);
}
