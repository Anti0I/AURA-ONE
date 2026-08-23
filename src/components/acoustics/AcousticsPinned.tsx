"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACOUSTICS, PRODUCT } from "@/data/specs";
import { useSectionProgress } from "@/lib/scroll/useSectionProgress";
import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { cn, easeInOutQuart } from "@/lib/utils";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { Reveal } from "@/components/ui/Reveal";
import { useAcousticsDemo } from "./useAcousticsDemo";
import { useStarfield, type WarpState } from "./useStarfield";
import { activeStation, railTargets, stationPhase } from "./stations";

/**
 * The acoustics section as a 3D scene the scroll moves the camera through.
 *
 * The same mechanism the walkthrough uses — a very tall section, one
 * `position: sticky` child, progress from a single `getBoundingClientRect` per
 * frame during INPUT. No ScrollTrigger, no pin-spacer, no plugin.
 *
 * All three beats are in the scene the whole time. Each has a parking spot at
 * its own depth where it turns slowly on its own axis, and the scroll brings
 * them forward one at a time: out of the parking spot, flat and centred and
 * still, then back. Nothing is ever hidden and nothing is ever created — what
 * changes is which one you are being shown.
 *
 * One number carries all of it. `presence` from `stations.ts` is 0 at the
 * parking spot and 1 on the front, and it drives the position, the depth, the
 * scale, how far the tumble is allowed to swing, how bright the card is, and
 * whether its body copy exists. There is no second timeline to keep in step.
 *
 * Two things here are load-bearing rather than decorative:
 *
 * **A parked card never changes scale.** The compositor will rotate and
 * translate a rasterised layer for nothing, but a *scale* change forces it to
 * re-raster so the text stays sharp. Three text cards changing scale on every
 * frame for the whole visit is the one way this section could get expensive, so
 * every channel that varies at rest — the three rotations — is one the
 * compositor handles, and scale moves only inside the short approach and
 * retreat, where a little softness reads as speed anyway.
 *
 * **Opacity and `preserve-3d` cannot live on the same element.** Opacity is a
 * grouping property, and a grouping property computes `transform-style` back to
 * `flat`, which collapses the card's two faces into one plane. So the mover
 * carries the transform and the 3D context, and the faces carry the fade.
 */

/**
 * Where each beat waits, as a fraction of the stage and a depth in pixels.
 *
 * Fractions of the stage rather than of the card, because a percentage
 * translation resolves against the element being moved — which is how a
 * one-line title once "left" a window it was still sitting in. The stage box
 * comes from a `ResizeObserver`, so reading it is not a layout read.
 *
 * Three depths, three corners, three periods that do not divide into each
 * other. Fixed spots rather than an orbit: the point of having them visible at
 * all is that you can see where the next one is coming from.
 */
const PARK = [
  { x: -0.46, y: -0.3, z: -520, scale: 0.36, period: 14, phase: 0 },
  { x: 0.5, y: 0.26, z: -760, scale: 0.3, period: 18, phase: 2.1 },
  { x: -0.42, y: 0.34, z: -640, scale: 0.33, period: 16, phase: 4.3 },
] as const;

/** Degrees of wobble on the two axes that are not the spin. */
const TILT = 9;
const ROLL = 4;

/** How visible a parked card is. Scenery, not something anyone is reading. */
const PARKED_OPACITY = 0.46;

/** Perspective of the scene, in pixels. */
const PERSPECTIVE = 1400;

/** Wraps an angle into (-180, 180], so settling flat is at most a half turn. */
const wrap180 = (deg: number) => (((deg % 360) + 540) % 360) - 180;

interface BeatRefs {
  /** Carries the composed transform and the 3D context. Never opacity. */
  mover: HTMLElement | null;
  /** The two faces. They carry the fade, because the mover cannot. */
  faces: (HTMLElement | null)[];
  /** Blocks that exist only on the front: body, controls. */
  fades: (HTMLElement | null)[];
  /** The schematic grid, which is the inverse: only there while parked. */
  grid: HTMLElement | null;
  /** Free-running spin, and the flat angle it settles to. See `tumble`. */
  spin: number;
  flat: number;
}

export function AcousticsPinned() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLCanvasElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const beats = useRef<BeatRefs[]>(
    ACOUSTICS.map(() => ({
      mover: null,
      faces: [],
      fades: [],
      grid: null,
      spin: 0,
      flat: 0,
    })),
  );

  /** Per-beat `presence`, written during INPUT and read during RENDER. */
  const fronts = useRef<number[]>(ACOUSTICS.map(() => 0));

  // Written during INPUT, read by the starfield during RENDER. The field needs
  // its own subscription because `useSectionProgress` only reports when the
  // progress changes, and the field has to keep flying while the page is still.
  const warp = useRef<WarpState>({ progress: 0, presence: 0 });

  // 96 bars, not the panel default of 44: this meter is a strip across the
  // whole viewport now, and 44 of them at that width is a picket fence.
  const { playing, start, stop, meterRef } = useAcousticsDemo(96);
  useStarfield(fieldRef, warp);

  const [active, setActive] = useState(0);
  const [offered, setOffered] = useState<number | null>(0);
  const lastActive = useRef(0);
  const lastOffered = useRef<number | null>(0);

  // ---- INPUT: read the scroll, write nothing but refs ----------------------
  const onProgress = useCallback((p: number) => {
    const count = ACOUSTICS.length;
    let presence = 0;
    let front: number | null = null;

    for (let i = 0; i < count; i++) {
      const phase = stationPhase(p, i, count);
      fronts.current[i] = phase.presence;
      if (phase.presence > presence) presence = phase.presence;
      if (phase.presence >= 1) front = i;
    }

    warp.current.progress = p;
    warp.current.presence = presence;

    const rail = railRef.current;
    if (rail) rail.style.setProperty("--rail-progress", p.toFixed(4));

    const next = activeStation(p, count);
    if (next !== lastActive.current) {
      lastActive.current = next;
      setActive(next);
    }
    if (front !== lastOffered.current) {
      lastOffered.current = front;
      setOffered(front);
    }
  }, []);

  useSectionProgress(sectionRef, onProgress);

  // ---- RENDER: compose parking, approach and tumble into one write --------
  //
  // A separate task from `onProgress`, and it has to be. The tumble runs
  // whether or not anybody is scrolling, and `useSectionProgress` deliberately
  // says nothing when the progress has not changed — so a stage driven from
  // there alone would freeze the moment the page came to rest. The same split
  // the starfield uses, and it is gated on visibility for the same reason.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let width = 0;
    let height = 0;

    // `contentRect` is handed over by the observer, so this is not a layout
    // read and cannot force a reflow from inside the frame loop.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      width = rect.width;
      height = rect.height;
    });
    observer.observe(stage);

    const detach = onFrameWhileVisible(
      stage,
      ({ time, delta }) => {
        for (let i = 0; i < beats.current.length; i++) {
          const beat = beats.current[i]!;
          const park = PARK[i]!;
          if (!beat.mover) continue;

          const e = easeInOutQuart(fronts.current[i] ?? 0);
          const back = 1 - e;

          // The spin free-runs only while the beat is parked, and the angle it
          // will settle to is latched at the same moment. Both matter: if the
          // spin kept accumulating on the way in, the flat target would flip by
          // a whole turn somewhere mid-approach and the card would snap.
          if (e <= 0) {
            beat.spin += (360 / park.period) * delta;
            beat.flat = beat.spin - wrap180(beat.spin);
          }
          const rotY = beat.spin + (beat.flat - beat.spin) * e;

          // Tilt and roll are left free-running and simply scaled down. They
          // are bounded and small, so the product goes to zero smoothly and the
          // last of it reads as the card settling rather than as a cut.
          const rotX = Math.sin(time * 0.31 + park.phase) * TILT * back;
          const rotZ = Math.cos(time * 0.23 + park.phase) * ROLL * back;

          const x = back * park.x * width;
          const y = back * park.y * height;
          const z = back * park.z;
          const scale = park.scale + (1 - park.scale) * e;

          beat.mover.style.transform =
            `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) ` +
            `rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) ` +
            `rotateZ(${rotZ.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
          // `will-change` is a promise to hold a layer, not a hint that can be
          // left on. A 3D transform promotes the element by itself, so the
          // promise is only worth making while the scale is actually moving.
          beat.mover.style.willChange = e > 0 && e < 1 ? "transform" : "";

          const opacity = PARKED_OPACITY + (1 - PARKED_OPACITY) * e;
          for (const face of beat.faces) {
            if (face) face.style.opacity = opacity.toFixed(3);
          }
          // Body copy and the control exist on the front and nowhere else.
          // Three paragraphs at a third of full size, scattered across the
          // frame, is the same noise this section was rebuilt to remove — just
          // smaller. Parked cards are a number and a title.
          for (const el of beat.fades) {
            if (el) el.style.opacity = e.toFixed(3);
          }
          // The inverse, and it is not decoration. With the body and the
          // control faded out, a parked card is a large panel with a label in
          // one corner and nothing else — which reads as a card that failed to
          // load rather than as an object waiting its turn. The grid fills it
          // as a schematic and is gone by the time anything has to be read
          // over it.
          if (beat.grid) beat.grid.style.opacity = back.toFixed(3);
        }
      },
      Priority.RENDER,
    );

    return () => {
      detach();
      observer.disconnect();
    };
  }, []);

  const activeRow = ACOUSTICS[active] ?? ACOUSTICS[0]!;

  // A demo belongs to the beat that offered it. Carrying on after that beat has
  // left the front is the same mistake as a loop with no visibility gate,
  // except audible.
  //
  // In an effect, not during render: `stop` sets state.
  useEffect(() => {
    if (playing === null) return;
    if (offered === null || ACOUSTICS[offered]?.id !== playing) stop();
  }, [offered, playing, stop]);

  return (
    <section
      ref={sectionRef}
      id="acoustics"
      aria-labelledby="acoustics-heading"
      className="relative h-[380svh] border-t border-line"
    >
      <div className="sticky top-0 h-dvh overflow-hidden bg-void">
        {/* The galaxy behind the stars. A static CSS gradient rather than
            anything drawn, so it costs one paint at mount and nothing after —
            there is no reason for the loop to redraw a shape that never
            changes. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 46%, color-mix(in oklab, var(--color-signal-dim) 34%, transparent), transparent 70%)",
          }}
        />
        <canvas
          ref={fieldRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
        {/* The only two places text sits directly on the field are the top
            strip and the readout at the bottom; the beats have their own panel.
            So the field is pushed back exactly there and left alone in the
            middle, which is also where it is most worth looking at. Another
            static gradient — the alternative was dimming the whole field, and
            that costs the effect everywhere to fix it in two bands. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, var(--color-void) 0%, color-mix(in oklab, var(--color-void) 30%, transparent) 22%, transparent 42%, transparent 58%, color-mix(in oklab, var(--color-void) 55%, transparent) 78%, var(--color-void) 100%)",
          }}
        />

        <div className="relative flex h-full flex-col px-gutter pb-24 pt-12">
          {/* Deliberately quiet, and it stays put for the whole lock. The
              section label is not the headline here — the beat on the front is,
              and two things at display scale would fight. */}
          <header className="mx-auto w-full max-w-[100rem] shrink-0">
            <p className="rule-label text-signal">04 // Acoustics</p>
            <Reveal
              as="h2"
              id="acoustics-heading"
              className="mt-3 text-lead font-medium text-ink"
            >
              {`What ${PRODUCT.name} sounds like.`}
            </Reveal>
          </header>

          {/* The scene. Perspective lives here rather than on each card, so all
              three share one vanishing point and a card parked off to the side
              is genuinely skewed by its position — which is the difference
              between a scene and three things that have been scaled down. The
              front position is dead centre at z 0, where the distortion is
              exactly zero and the copy has no excuse to be soft.

              It cannot disturb the pin above it: `perspective` makes an element
              a containing block for *fixed* descendants, and sticky is not
              fixed. Measured on this page — `overflow` is the only property
              that breaks it, and this is inside the sticky element anyway. */}
          <div
            ref={stageRef}
            className="relative min-h-0 flex-1"
            style={{ perspective: `${PERSPECTIVE}px` }}
          >
            {ACOUSTICS.map((row, i) => (
              <article
                key={row.id}
                data-front={offered === i ? "1" : "0"}
                // Parked cards are scenery. Their Play button must not be a tab
                // stop and their copy must not be read out, and `visibility`
                // no longer does that job because they are visible now.
                inert={offered !== i}
                aria-hidden={offered !== i}
                className="absolute inset-0 flex items-center justify-center [transform-style:preserve-3d]"
              >
                <div
                  ref={(el) => {
                    beats.current[i]!.mover = el;
                  }}
                  className="relative w-full max-w-[62ch] [transform-style:preserve-3d]"
                >
                  {/* Front. No `backdrop-filter`: a backdrop filter makes the
                      compositor read what is behind the element every frame,
                      and what is behind this one is an animating canvas — the
                      same reason `mix-blend-mode` is banned over the stage. */}
                  <div
                    ref={(el) => {
                      beats.current[i]!.faces[0] = el;
                    }}
                    // /92 rather than /85: a card parked behind this one used
                    // to read through the body copy as a faint rectangle. Still
                    // translucent enough that the field shows as depth.
                    //
                    // No `overflow: hidden` to clip the grid to the corners
                    // either — the Play button lives in here, and a clip takes
                    // the focus ring with it. The grid carries its own radius.
                    className="relative rounded-tile border border-line-strong bg-void/92 p-7 [backface-visibility:hidden] sm:p-9"
                  >
                    <div
                      ref={(el) => {
                        beats.current[i]!.grid = el;
                      }}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-tile"
                      style={{
                        backgroundImage:
                          "repeating-linear-gradient(0deg, color-mix(in oklab, var(--color-line-strong) 80%, transparent) 0 1px, transparent 1px 58px), repeating-linear-gradient(90deg, color-mix(in oklab, var(--color-line-strong) 80%, transparent) 0 1px, transparent 1px 58px)",
                      }}
                    />
                    {/* Positioned, so the in-flow copy paints above the
                        absolutely positioned grid rather than under it. */}
                    <div className="relative">
                      <p className="rule-label text-signal">{row.eyebrow}</p>
                      {/* `text-heading`, not `text-title`. Measured, not
                          chosen: at title scale this card ran 568px tall in a
                          360px stage on a 720p laptop, so the paragraph under
                          it was clipped and the starfield the section is built
                          around had nowhere to show. */}
                      <h3 className="mt-4 max-w-[18ch] text-heading font-medium text-ink">
                        {row.title}
                      </h3>
                      <p
                        ref={(el) => {
                          beats.current[i]!.fades[0] = el;
                        }}
                        className="mt-4 text-lead leading-relaxed text-ink-dim"
                      >
                        {row.body}
                      </p>

                      <div
                        ref={(el) => {
                          beats.current[i]!.fades[1] = el;
                        }}
                        className="mt-7 flex flex-wrap items-center gap-5"
                      >
                        <button
                          type="button"
                          onClick={() => start(row.id)}
                          className={cn(
                            "rounded-full border px-6 py-2.5 text-label uppercase tracking-[0.14em]",
                            "transition-colors duration-fast",
                            playing === row.id
                              ? "border-signal text-signal"
                              : "border-line-strong text-ink hover:border-signal hover:text-signal",
                          )}
                        >
                          {playing === row.id ? "Stop" : "Play"}
                          <span className="sr-only">{` — ${row.title}`}</span>
                        </button>
                        <p className="text-label uppercase tracking-[0.14em] text-ink-faint">
                          {row.detail}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Back. Only ever seen at a third of full size, turning, so
                      it is scenery and is marked as such — the readable copy of
                      the signal chain is the one in the readout below. Rendering
                      the same array from `specs.ts` twice cannot produce two
                      answers; the rule about numbers living in one place is
                      about two *sources* disagreeing. */}
                  <div
                    ref={(el) => {
                      beats.current[i]!.faces[1] = el;
                    }}
                    aria-hidden
                    className="absolute inset-0 rounded-tile border border-line-strong bg-surface/90 p-7 [backface-visibility:hidden] [transform:rotateY(180deg)] sm:p-9"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(0deg, color-mix(in oklab, var(--color-line) 70%, transparent) 0 1px, transparent 1px 46px), repeating-linear-gradient(90deg, color-mix(in oklab, var(--color-line) 70%, transparent) 0 1px, transparent 1px 46px)",
                    }}
                  >
                    <p className="rule-label text-signal-dim">{row.eyebrow}</p>
                    <ol className="mt-6 grid gap-3">
                      {row.chain.map((node, at) => (
                        <li
                          key={node}
                          className="flex items-center gap-3 text-base text-ink-dim"
                        >
                          <span
                            className="rule-label text-signal-dim"
                            data-numeric
                          >
                            {String(at + 1).padStart(2, "0")}
                          </span>
                          {node}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </article>
            ))}
          </div>

          {/* The readout. Stays for the whole lock, across the full width —
              which is what lets the field be a background rather than a strip
              beside a panel, and keeps the meter to a single canvas and a
              single ref where a meter per card would have needed three.

              The card carries the argument; this carries the evidence. */}
          <div className="mx-auto grid w-full max-w-[100rem] shrink-0 gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-end">
            <div>
              <div className="flex items-baseline justify-between gap-6">
                <p className="rule-label">Output</p>
                {/* The meter is decoration; this is the same fact in text, and
                    it is what a screen reader gets. */}
                <p role="status" className="text-base text-ink-dim">
                  {playing
                    ? `Playing: ${ACOUSTICS.find((r) => r.id === playing)?.title}`
                    : "Nothing playing."}
                </p>
              </div>
              <canvas
                ref={meterRef}
                data-meter
                aria-hidden
                className="mt-2 h-16 w-full [--meter-dim:#1f1f25] [--meter-signal:#4fd1ff]"
              />
              <p
                aria-hidden
                className="rule-label mt-1 flex justify-between"
                data-numeric
              >
                <span>38 Hz</span>
                <span>1 kHz</span>
                <span>16 kHz</span>
              </p>
            </div>

            <div>
              <p className="rule-label">Signal chain</p>
              {/* Follows the beat the rail is marking, so it has something to
                  say mid-flight as well. Inline rather than stacked: it is a
                  chain, it reads as one, and the frame has no vertical space to
                  spare for three more lines. */}
              <ol
                className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1"
                role="list"
              >
                {activeRow.chain.map((node, at) => (
                  <li
                    key={node}
                    className="flex items-center gap-2 text-base text-ink-dim"
                  >
                    {at > 0 ? (
                      <span aria-hidden className="text-signal-dim">
                        →
                      </span>
                    ) : null}
                    {node}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>

        <ProgressRail
          ref={railRef}
          steps={ACOUSTICS}
          active={active}
          sectionId="acoustics"
          targets={railTargets(ACOUSTICS.length)}
          label="Acoustics demonstrations"
        />
      </div>
    </section>
  );
}
