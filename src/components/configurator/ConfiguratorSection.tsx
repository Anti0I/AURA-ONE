"use client";

import { useEffect, useRef } from "react";
import manifest from "@/data/sequence.json";
import { FrameSequencePlayer } from "@/lib/canvas/FrameSequencePlayer";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { readEnvironment } from "@/lib/motion";
import { MATERIALS, getMaterial } from "@/data/materials";
import { PHASES } from "@/data/story";
import { useAppStore } from "@/store/useAppStore";
import { tick } from "@/lib/audio/synth";
import { cn } from "@/lib/utils";
import type { SequenceManifest } from "@/types/sequence";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { BentoGrid } from "@/components/bento/BentoGrid";

const SEQUENCE = manifest as SequenceManifest;

/** Idle spin, in full turns per second. Slow enough to read the finish. */
const IDLE_SPIN = 0.055;

/**
 * Finish configurator.
 *
 * Reuses the first 30% of the sequence — the clean 360° turn — as a spin the
 * visitor can drag. No second render, no separate asset: the same 120 frames
 * the walkthrough scrubs are the ones being turned here, and the finish is a
 * canvas composite over them (see lib/canvas/tint.ts).
 *
 * That is the entire argument for rendering in neutral grey: four finishes cost
 * four objects in a data file. Baking them would have cost 360 more frames and
 * about 15 MB.
 */
export function ConfiguratorSection() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<FrameSequencePlayer | null>(null);

  const material = useAppStore((s) => s.material);
  const setMaterial = useAppStore((s) => s.setMaterial);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;

    const { tier } = readEnvironment();
    const player = new FrameSequencePlayer(canvas, SEQUENCE.variants[tier], {
      // The spin only ever touches the rotation phase, so a small window
      // covers it entirely and the cache never churns.
      cacheSize: 14,
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

    // Angle in turns. Only the rotation phase of the sequence is used.
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
      // One full turn per ~1.6 viewport widths of drag: fast enough to spin
      // it in one gesture, slow enough to stop on a detail.
      const turns = dx / (frame.clientWidth * 1.6);
      angle += turns;
      velocity = turns;
    };

    const onUp = (e: PointerEvent) => {
      dragging = false;
      frame.releasePointerCapture(e.pointerId);
    };

    frame.addEventListener("pointerdown", onDown);
    frame.addEventListener("pointermove", onMove);
    frame.addEventListener("pointerup", onUp);
    frame.addEventListener("pointercancel", onUp);

    const detach = onFrame((f) => {
      if (dragging) {
        // held
      } else if (Math.abs(velocity) > 0.0002) {
        // Flick carries on and decays, rather than stopping dead on release.
        angle += velocity;
        velocity *= Math.exp(-3.2 * f.delta);
      } else {
        angle += IDLE_SPIN * f.delta;
      }

      // Wrap into 0..1 and map onto the rotation phase of the sequence.
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

  const active = getMaterial(material);

  return (
    <section
      id="configurator"
      className="relative border-t border-line px-gutter py-24"
    >
      <div aria-hidden className="noise-field" />

      <header className="relative mb-12 flex flex-wrap items-end justify-between gap-6">
        <div>
          <SectionLabel index={4}>Configure</SectionLabel>
          <h2 className="mt-5 max-w-[18ch] text-title font-medium text-ink">
            Four finishes. One render.
          </h2>
        </div>
        <p className="max-w-[42ch] text-ink-dim">
          The sequence is rendered once in neutral grey. Every finish here is a
          composite applied while drawing, so adding one costs an object in a
          data file rather than another 120 frames.
        </p>
      </header>

      <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div
          ref={frameRef}
          // Height-capped like the scanner: a 4:3 frame at full width swallows
          // the viewport and pushes the finish list off screen.
          className="relative mx-auto aspect-[4/3] max-h-[62svh] w-full cursor-grab touch-none select-none overflow-hidden rounded-tile border border-line bg-surface active:cursor-grabbing"
        >
          <canvas
            ref={canvasRef}
            data-product-stage
            aria-hidden
            className="absolute inset-0 h-full w-full"
          />
          <p className="rule-label pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2">
            Drag to rotate
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <fieldset>
            <legend className="rule-label mb-3">Finish</legend>
            <ul className="flex flex-col gap-2">
              {MATERIALS.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setMaterial(option.id);
                      // Each finish gets its own pitch, which a sample could
                      // not do without shipping four of them.
                      tick(880 + MATERIALS.indexOf(option) * 110, 0.11);
                    }}
                    aria-pressed={material === option.id}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-tile border px-3 py-3 text-left transition-colors",
                      material === option.id
                        ? "border-signal bg-signal/5"
                        : "border-line hover:border-line-strong",
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-6 shrink-0 rounded-full border border-line-strong"
                      style={{ backgroundColor: option.tint }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-ink">{option.name}</span>
                      <span className="rule-label block">{option.code}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>

          <p className="mt-1 text-sm leading-relaxed text-ink-dim">
            {active.blurb}
          </p>
        </div>
      </div>

      <BentoGrid />
    </section>
  );
}
