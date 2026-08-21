"use client";

import { useEffect, useRef, useState } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { readEnvironment } from "@/lib/motion";
import { getMaterial } from "@/data/materials";
import { useAppStore } from "@/store/useAppStore";
import { clamp, damp } from "@/lib/utils";
import type { Stage } from "@device/scene.mjs";

/** Idle spin, in turns per second. Slow enough to read the finish. */
const IDLE_SPIN = 0.045;

/** How far over the poles the camera may tip, in radians. */
const ELEVATION_LIMIT = Math.PI * 0.42;

/**
 * The configurator, rendered live.
 *
 * The walkthrough is a baked frame sequence because it needs deterministic
 * frames and a decode cost you can budget. This is the same scene, rendered the
 * other way, for the opposite reason: a turntable of frames can only ever spin
 * about one axis, and turning the product over is the whole point of a
 * configurator. Covering both axes as frames would have meant an azimuth ×
 * elevation matrix — about 6.5 MB for five discrete camera heights, which is
 * not the same thing as being able to look from anywhere.
 *
 * So the geometry has one definition and two renderers. Change the shell and
 * both the film and the object you can turn change with it.
 *
 * Three.js lands only in this chunk. The section is behind `next/dynamic` and
 * `LazySection`, so it is not in the bytes that decide how fast the hero
 * paints — but it is real weight, and `audit-budget.mjs` has a ceiling on it so
 * it cannot grow quietly.
 */
export function ConfiguratorLive({ onFail }: { onFail: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const [ready, setReady] = useState(false);

  const material = useAppStore((s) => s.material);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;

    let stage: Stage | null = null;
    let detach: (() => void) | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    // Orbit state, in radians. Lives outside React: it changes every frame and
    // nothing about it belongs in a render.
    let azimuth = 0.5;
    let elevation = 0.18;
    let targetAzimuth = azimuth;
    let targetElevation = elevation;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let spin = 0;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      spin = 0;
      frame.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      // One full turn per ~1.4 frame widths: fast enough to spin it in a single
      // gesture, slow enough to stop on a detail.
      const turns = dx / (frame.clientWidth * 1.4);
      targetAzimuth += turns * Math.PI * 2;
      spin = turns;

      // Vertical is clamped rather than wrapped. Tumbling past the poles is
      // disorienting and there is nothing to see under the device.
      targetElevation = clamp(
        targetElevation + dy / (frame.clientHeight * 1.1),
        -ELEVATION_LIMIT,
        ELEVATION_LIMIT,
      );
    };

    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (frame.hasPointerCapture(e.pointerId)) {
        frame.releasePointerCapture(e.pointerId);
      }
    };

    void (async () => {
      // Dynamic, so three.js is fetched when this section mounts rather than
      // when the module graph is built.
      const { createStage } = await import("@device/scene.mjs");
      if (cancelled) return;

      try {
        stage = createStage(canvas);
      } catch (error) {
        console.warn("[configurator] WebGL unavailable:", error);
        onFail();
        return;
      }

      stageRef.current = stage;
      stage.setFinish(getMaterial(useAppStore.getState().material));

      const { tier } = readEnvironment();
      const resize = () => {
        const rect = frame.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        stage?.setSize(rect.width, rect.height, window.devicePixelRatio || 1);
      };
      observer = new ResizeObserver(resize);
      observer.observe(frame);
      resize();

      frame.addEventListener("pointerdown", onDown);
      frame.addEventListener("pointermove", onMove);
      frame.addEventListener("pointerup", onUp);
      frame.addEventListener("pointercancel", onUp);

      setReady(true);

      // Render only while the section is actually on screen.
      //
      // An idle spin is a loop with no natural end, so without this the scene
      // keeps drawing at the display's refresh rate for the rest of the
      // session — several sections above it, and in a background tab. It costs
      // the visitor's battery to animate something nobody is looking at.
      let onScreen = false;
      const visibility = new IntersectionObserver(
        (entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting);
        },
        { rootMargin: "100px" },
      );
      visibility.observe(frame);
      const stopWatching = () => visibility.disconnect();

      detach = onFrame((f) => {
        if (!onScreen || document.visibilityState === "hidden") return;

        if (dragging) {
          // held
        } else if (Math.abs(spin) > 0.0002) {
          // A flick carries on and decays rather than stopping dead.
          targetAzimuth += spin * Math.PI * 2;
          spin *= Math.exp(-3.4 * f.delta);
        } else {
          targetAzimuth += IDLE_SPIN * Math.PI * 2 * f.delta;
        }

        // Damped rather than pinned, for the same reason the scanner's lens is:
        // a few frames of lag is what gives the object mass. On a phone the
        // damping is tighter, because a finger on the thing itself expects a
        // more direct response than a pointer near it does.
        const rate = tier === "mobile" ? 26 : 18;
        azimuth = damp(azimuth, targetAzimuth, rate, f.delta);
        elevation = damp(elevation, targetElevation, rate, f.delta);

        stage?.orbit(azimuth, elevation);
      }, Priority.RENDER);

      const detachFrame = detach;
      detach = () => {
        detachFrame?.();
        stopWatching();
      };
    })();

    return () => {
      cancelled = true;
      detach?.();
      observer?.disconnect();
      frame.removeEventListener("pointerdown", onDown);
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerup", onUp);
      frame.removeEventListener("pointercancel", onUp);
      stage?.dispose();
      stageRef.current = null;
    };
  }, [onFail]);

  useEffect(() => {
    stageRef.current?.setFinish(getMaterial(material));
  }, [material]);

  return (
    <div
      ref={frameRef}
      data-product-stage
      // `touch-pan-y`: horizontal drags turn the product, vertical ones belong
      // to the page. Claiming both axes here made the last section of the site
      // a dead zone that swallowed every scroll gesture aimed at it.
      className="relative mx-auto aspect-[4/3] max-h-[62svh] w-full cursor-grab touch-pan-y select-none overflow-hidden rounded-tile border border-line bg-surface active:cursor-grabbing"
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 h-full w-full"
        style={{ opacity: ready ? 1 : 0, transition: "opacity 400ms ease-out" }}
      />
      <p className="rule-label pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2">
        Drag to orbit
      </p>
    </div>
  );
}
