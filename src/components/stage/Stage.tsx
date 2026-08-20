"use client";

import { useCallback, useEffect, useRef } from "react";
import manifest from "@/data/sequence.json";
import { FrameSequencePlayer } from "@/lib/canvas/FrameSequencePlayer";
import { useSectionProgress } from "@/lib/scroll/useSectionProgress";
import { readEnvironment } from "@/lib/motion";
import { clamp, easeOutExpo, mapRange } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { STORY, HERO_HOLD, beatOpacity, activeBeat } from "@/data/story";
import { PRODUCT, SPECS } from "@/data/specs";
import type { SequenceManifest } from "@/types/sequence";
import { HeroOverlay } from "./HeroOverlay";
import { ProgressRail } from "./ProgressRail";
import { SpecFlash } from "./SpecFlash";

const SEQUENCE = manifest as SequenceManifest;

/**
 * Where the product sits during the hero, before the walkthrough recentres it.
 * Fractions of the canvas: right of centre, slightly high, a touch smaller so
 * the headline reads as the larger element on the page.
 */
const HERO_FRAMING = { x: 0.17, y: -0.05, scale: 0.88 };

/**
 * Hero and scrollytelling in one pinned stage.
 *
 * They share a single canvas rather than handing off between two, which is
 * what makes the transition from "product at rest" to "product rotating" have
 * no seam at all: there is nothing to cross-fade, because it is the same
 * element the whole way down.
 *
 * Nothing below animates through React. The section's scroll progress is read
 * on the frame loop and written straight to `style` on a handful of refs, so a
 * full scrub of this section causes exactly zero re-renders. The one exception
 * is `storyPhase`, which changes three times in total and drives the rail's
 * ARIA state.
 */
export function Stage() {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const beatRefs = useRef<(HTMLDivElement | null)[]>([]);
  const railRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<FrameSequencePlayer | null>(null);

  const booted = useAppStore((s) => s.booted);
  const setStoryPhase = useAppStore((s) => s.setStoryPhase);
  const lastPhase = useRef<0 | 1 | 2>(0);

  // ---- Player lifecycle --------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { tier } = readEnvironment();
    const variant = SEQUENCE.variants[tier];

    const player = new FrameSequencePlayer(canvas, variant, {
      // Mobile ships half the frames, so a matched look-ahead in *seconds* of
      // scrolling is half the count. Same window in time, half the memory.
      cacheSize: tier === "mobile" ? 16 : 24,
      lookAhead: tier === "mobile" ? 6 : 10,
      reportTelemetry: true,
    });
    player.start();
    playerRef.current = player;
    if (process.env.NODE_ENV !== "production") {
      // Handle for the screenshot script and for poking at the cache in devtools.
      // The Dev Inspector reads telemetry instead, so this stays out of prod.
      (window as unknown as Record<string, unknown>).__player = player;
    }

    // The preloader's percentage is this number: frames actually decoded and
    // resident, not a timer pretending to be one. We hold the boot on the
    // opening run only — the rest streams in behind the hero.
    const store = useAppStore.getState();
    const opening = tier === "mobile" ? 12 : 24;
    void player.preload(opening, store.setBootProgress).then(() => {
      store.setBooted(true);
    });

    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, []);

  // ---- Per-frame scrub ---------------------------------------------------
  const onProgress = useCallback(
    (p: number) => {
      // The hero holds still for the first slice of the section, then the
      // sequence takes over the remainder.
      const t = clamp((p - HERO_HOLD) / (1 - HERO_HOLD), 0, 1);
      const player = playerRef.current;
      player?.setProgress(t);

      // Camera framing. The hero sits the product off to the right so the
      // headline has clean air beside it, then it settles to centre exactly as
      // the walkthrough takes over and the words move out of the way.
      if (player) {
        const settle = easeOutExpo(clamp(p / HERO_HOLD, 0, 1));
        player.setFraming(
          HERO_FRAMING.x * (1 - settle),
          HERO_FRAMING.y * (1 - settle),
          1 + (HERO_FRAMING.scale - 1) * (1 - settle),
        );
      }

      // Hero copy clears out before the device starts moving, so the two never
      // compete for attention.
      const hero = heroRef.current;
      if (hero) {
        const out = easeOutExpo(clamp(p / (HERO_HOLD * 0.85), 0, 1));
        hero.style.opacity = String(1 - out);
        hero.style.transform = `translate3d(0, ${(-out * 42).toFixed(2)}px, 0)`;
        hero.style.visibility = out >= 1 ? "hidden" : "visible";
      }

      for (let i = 0; i < STORY.length; i++) {
        const el = beatRefs.current[i];
        const beat = STORY[i];
        if (!el || !beat) continue;
        const o = beatOpacity(t, beat);
        el.style.opacity = String(o);
        // Rises as it appears and keeps rising as it leaves: the caption never
        // reverses direction, so successive beats read as one continuous move.
        el.style.transform = `translate3d(0, ${((1 - o) * 26).toFixed(2)}px, 0)`;
        el.style.visibility = o <= 0.001 ? "hidden" : "visible";
      }

      const rail = railRef.current;
      if (rail) rail.style.setProperty("--rail-progress", t.toFixed(4));

      // The spec sheet flashes up only at the bottom of the dive into silicon.
      const spec = specRef.current;
      if (spec) {
        const o = clamp(mapRange(t, 0.8, 0.88, 0, 1), 0, 1) *
          clamp(mapRange(t, 0.99, 0.94, 0, 1), 0, 1);
        spec.style.opacity = String(o);
        spec.style.visibility = o <= 0.001 ? "hidden" : "visible";
      }

      const phase = activeBeat(t);
      if (phase !== lastPhase.current) {
        lastPhase.current = phase;
        setStoryPhase(phase);
      }
    },
    [setStoryPhase],
  );

  useSectionProgress(sectionRef, onProgress);

  return (
    <section
      ref={sectionRef}
      id="stage"
      aria-label={`${PRODUCT.name} product walkthrough`}
      className="relative h-[460svh]"
    >
      <div className="sticky top-0 flex h-dvh w-full items-center justify-center overflow-hidden">
        <div aria-hidden className="noise-field z-20" />

        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 h-full w-full"
        />

        <HeroOverlay ref={heroRef} ready={booted} />

        {STORY.map((beat, i) => (
          <div
            key={beat.id}
            ref={(el) => {
              beatRefs.current[i] = el;
            }}
            style={{ opacity: 0, visibility: "hidden" }}
            className="pointer-events-none absolute left-gutter top-1/2 z-10 max-w-[34ch] -translate-y-1/2 will-change-[opacity,transform] md:max-w-[38ch]"
          >
            <p className="rule-label text-signal">{beat.eyebrow}</p>
            <h2 className="mt-4 text-title font-medium text-ink">
              {beat.title}
            </h2>
            <p className="mt-5 text-base leading-relaxed text-ink-dim">
              {beat.body}
            </p>
          </div>
        ))}

        <SpecFlash ref={specRef} specs={SPECS.filter((s) => s.featured)} />
        <ProgressRail ref={railRef} />
      </div>
    </section>
  );
}
