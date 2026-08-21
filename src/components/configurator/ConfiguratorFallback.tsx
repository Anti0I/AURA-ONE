"use client";

import { useEffect, useRef } from "react";
import manifest from "@/data/sequence.json";
import { FrameSequencePlayer } from "@/lib/canvas/FrameSequencePlayer";
import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { readEnvironment } from "@/lib/motion";
import { getMaterial } from "@/data/materials";
import { PHASES } from "@/data/story";
import { useAppStore } from "@/store/useAppStore";
import type { SequenceManifest } from "@/types/sequence";

const SEQUENCE = manifest as SequenceManifest;

/** Idle spin, in full turns per second. */
const IDLE_SPIN = 0.055;

/**
 * The configurator without WebGL.
 *
 * Reuses the rotation phase of the walkthrough's still sequence as a spin the
 * visitor can drag, and applies the finish as a canvas composite while drawing
 * — the technique the live version replaced. It is one axis only, because a
 * turntable of frames cannot be anything else.
 *
 * Kept rather than dropped because it is the only thing standing between a
 * visitor without WebGL and an empty box, and because the composite is where
 * the most useful thing this project learned about canvas lives: `"color"`
 * blend mode takes hue from the source and *luminosity from the backdrop*, so
 * it cannot darken anything. See `lib/canvas/tint.ts`.
 */
export function ConfiguratorFallback() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<FrameSequencePlayer | null>(null);

  const material = useAppStore((s) => s.material);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;

    const { tier } = readEnvironment();
    const player = new FrameSequencePlayer(canvas, SEQUENCE.variants[tier], {
      // Stills only. The video source exists for the walkthrough, where the
      // playhead moves in one direction most of the time; a drag reverses
      // constantly, and every reversal costs a seek back to a keyframe.
      video: null,
      // The spin only ever touches the rotation phase, so a small window
      // covers it entirely and the cache never churns.
      cacheSize: 14,
      maxCacheBytes: 48 * 1024 * 1024,
      lookAhead: 5,
      lookBehind: 5,
      // Drag needs to feel direct; the walkthrough's damping would read as lag
      // when your finger is on the object.
      damping: 0,
      fill: 0.94,
    });
    player.start();
    player.setTint(getMaterial(useAppStore.getState().material));
    playerRef.current = player;

    let angle = 0;
    let dragging = false;
    let lastX = 0;
    let velocity = 0;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      velocity = 0;
      frame.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const turns = dx / (frame.clientWidth * 1.6);
      angle += turns;
      velocity = turns;
    };

    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (frame.hasPointerCapture(e.pointerId)) {
        frame.releasePointerCapture(e.pointerId);
      }
    };

    frame.addEventListener("pointerdown", onDown);
    frame.addEventListener("pointermove", onMove);
    frame.addEventListener("pointerup", onUp);
    frame.addEventListener("pointercancel", onUp);

    // Same gate as the live version. An idle spin has no natural end.
    const detach = onFrameWhileVisible(frame, (f) => {
      if (dragging) {
        // held
      } else if (Math.abs(velocity) > 0.0002) {
        angle += velocity;
        velocity *= Math.exp(-3.2 * f.delta);
      } else {
        angle += IDLE_SPIN * f.delta;
      }

      const turn = ((angle % 1) + 1) % 1;
      player.setProgress(turn * PHASES.ROTATE_END);
    }, Priority.INPUT);

    return () => {
      detach();
      frame.removeEventListener("pointerdown", onDown);
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerup", onUp);
      frame.removeEventListener("pointercancel", onUp);
      player.destroy();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    playerRef.current?.setTint(getMaterial(material));
  }, [material]);

  return (
    <div
      ref={frameRef}
      data-product-stage
      className="relative mx-auto aspect-[4/3] max-h-[62svh] w-full cursor-grab touch-pan-y select-none overflow-hidden rounded-tile border border-line bg-surface active:cursor-grabbing"
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 h-full w-full"
      />
      <p className="rule-label pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2">
        Drag to rotate
      </p>
    </div>
  );
}
