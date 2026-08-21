"use client";

import { useCallback, useEffect, useRef } from "react";
import manifest from "@/data/sequence.json";
import { FrameSequencePlayer } from "@/lib/canvas/FrameSequencePlayer";
import { useSectionProgress } from "@/lib/scroll/useSectionProgress";
import { readEnvironment, type DeviceTier } from "@/lib/motion";
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
 * Camera framing, in fractions of the canvas.
 *
 * Two poses per tier, because the layouts are genuinely different rather than
 * one being a narrower version of the other. On a desktop the copy sits beside
 * the product and the framing moves sideways to make room; on a phone there is
 * no beside, so the copy goes underneath and the product moves *up* instead.
 *
 * Without the story pose, mobile captions land directly on top of the exploded
 * assembly and neither is readable.
 */
interface Framing {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const FRAMING: Record<DeviceTier, { hero: Framing; story: Framing }> = {
  desktop: {
    hero: { x: 0.17, y: -0.05, scale: 0.88 },
    story: { x: 0, y: 0, scale: 1 },
  },
  mobile: {
    hero: { x: 0.04, y: -0.16, scale: 0.84 },
    story: { x: 0, y: -0.18, scale: 0.78 },
  },
};

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
  const framing = useRef(FRAMING.desktop);

  // ---- Player lifecycle --------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { tier } = readEnvironment();
    const variant = SEQUENCE.variants[tier];
    framing.current = FRAMING[tier];

    const player = new FrameSequencePlayer(canvas, variant, {
      video: SEQUENCE.video[tier],
      // A window measured in frames covers half the scroll distance it used to,
      // now that there are twice as many frames — so it doubles. The byte cap
      // is what actually binds on a high-DPI display and it is unchanged in
      // spirit: it is a ceiling on decoded pixels, not on frames.
      cacheSize: tier === "mobile" ? 32 : 48,
      maxCacheBytes: (tier === "mobile" ? 56 : 160) * 1024 * 1024,
      lookAhead: tier === "mobile" ? 12 : 20,
      lookBehind: 8,
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
    // A budget in *time to first paint*, not a fraction of the timeline. The
    // video source streams, so these are the frames behind the opening
    // keyframe and a little after it — roughly the first hundred kilobytes.
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

      // Camera framing eases from the hero pose to the walkthrough pose over
      // exactly the span the headline takes to clear out.
      if (player) {
        const settle = easeOutExpo(clamp(p / HERO_HOLD, 0, 1));
        const { hero, story } = framing.current;
        player.setFraming(
          hero.x + (story.x - hero.x) * settle,
          hero.y + (story.y - hero.y) * settle,
          hero.scale + (story.scale - hero.scale) * settle,
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
            // Beside the product on a wide viewport, underneath it on a narrow
            // one. There is no "beside" at 390px, and a caption laid over the
            // exploded assembly makes both unreadable.
            className="pointer-events-none absolute inset-x-gutter bottom-28 z-10 will-change-[opacity,transform] md:inset-x-auto md:bottom-auto md:left-gutter md:top-1/2 md:max-w-[38ch] md:-translate-y-1/2"
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

        <SpecFlash ref={specRef} specs={SPECS} />
        <ProgressRail ref={railRef} />
      </div>
    </section>
  );
}
