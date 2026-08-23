"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACOUSTICS, PRODUCT } from "@/data/specs";
import { useSectionProgress } from "@/lib/scroll/useSectionProgress";
import { cn, easeInOutQuart } from "@/lib/utils";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { Reveal } from "@/components/ui/Reveal";
import { useAcousticsDemo } from "./useAcousticsDemo";
import { useStarfield, type WarpState } from "./useStarfield";
import { activeStation, railTargets, stationPhase } from "./stations";

/**
 * The acoustics section as a flight between three stations.
 *
 * The same mechanism the walkthrough uses — a very tall section, one
 * `position: sticky` child, progress from a single `getBoundingClientRect` per
 * frame during INPUT. No ScrollTrigger, no pin-spacer, no plugin.
 *
 * What changed, and why: the previous version cross-wiped one beat into the
 * next, which meant a stretch of every transition where half of one paragraph
 * sat above half of the next and neither could be read. Scrolling slowly landed
 * in it every time. The windows are now disjoint (`stations.ts`), so between
 * two beats there is genuinely nothing on screen — and that emptiness is the
 * point rather than the cost. The starfield behind runs at its fastest exactly
 * then, so the gap reads as travel.
 *
 * One number does three jobs. `presence` — how much beat text is on screen —
 * drives the card, dims the field under copy that is being read, and releases
 * the field to full speed once the copy has gone. There is no second timeline
 * to keep in sync with the first, because there is only one.
 *
 * Nothing here goes through React state per frame (hard rule 1). The one piece
 * of state is which beat the rail should mark, which changes twice in a visit.
 */

/** Scale the card arrives from, and the scale it departs through. */
const ENTER_SCALE = 0.74;
const EXIT_SCALE = 1.24;

/** Vertical travel of the card itself, in px. Small — the depth carries it. */
const CARD_RISE = 30;
const CARD_PASS = 26;

/**
 * Delay between the blocks of one beat, as a fraction of the beat's own travel.
 *
 * Entirely contained inside this beat's window, which is what the old wipe got
 * wrong: there, a staggered block could still be leaving after the next beat
 * had begun to arrive. Here the stagger cannot reach past its own station.
 */
const STAGGER = 0.13;
const BLOCKS = 4;
const USABLE = 1 - STAGGER * (BLOCKS - 1);
const BLOCK_RISE = 22;

const stagger = (t: number, j: number) =>
  easeInOutQuart(Math.min(Math.max((t - STAGGER * j) / USABLE, 0), 1));

interface BeatRefs {
  root: HTMLElement | null;
  card: HTMLElement | null;
  blocks: (HTMLElement | null)[];
}

export function AcousticsPinned() {
  const sectionRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLCanvasElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const beats = useRef<BeatRefs[]>(
    ACOUSTICS.map(() => ({ root: null, card: null, blocks: [] })),
  );

  // Written during INPUT, read by the starfield during RENDER. The field needs
  // its own subscription because `useSectionProgress` only reports when the
  // progress changes, and the field has to keep flying while the page is still.
  const warp = useRef<WarpState>({ progress: 0, presence: 0 });

  // 96 bars, not the panel default of 44: this meter is a strip across the
  // whole viewport now, and 44 of them at that width is a picket fence.
  const { playing, start, stop, meterRef } = useAcousticsDemo(96);
  useStarfield(fieldRef, warp);

  const [active, setActive] = useState(0);
  const lastActive = useRef(0);

  const onProgress = useCallback((p: number) => {
    const count = ACOUSTICS.length;
    let presence = 0;

    for (let i = 0; i < count; i++) {
      const beat = beats.current[i];
      if (!beat?.root) continue;

      const phase = stationPhase(p, i, count);
      if (phase.presence > presence) presence = phase.presence;

      beat.root.style.visibility = phase.gone ? "hidden" : "visible";
      // `will-change` is a promise to hold a compositor layer, not a hint that
      // can be left on. Three full-height beats each holding one for the rest
      // of the visit is a bug the hero copy already taught us once.
      beat.root.style.willChange =
        phase.gone || phase.presence >= 1 ? "" : "opacity, transform";
      if (phase.gone) continue;

      const eIn = easeInOutQuart(phase.enter);
      const eOut = easeInOutQuart(phase.exit);

      if (beat.card) {
        // The card travels the same z axis the stars do: it arrives out of the
        // vanishing point and departs *through* the camera rather than fading.
        // That is the whole reason the copy and the background read as one
        // thing instead of two animations sharing a screen.
        const scale =
          ENTER_SCALE + (1 - ENTER_SCALE) * eIn + (EXIT_SCALE - 1) * eOut;
        const y = (1 - eIn) * CARD_RISE - eOut * CARD_PASS;
        beat.card.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
        beat.card.style.opacity = (eIn * (1 - eOut)).toFixed(3);
      }

      for (let j = 0; j < beat.blocks.length; j++) {
        const el = beat.blocks[j];
        if (!el) continue;
        const bIn = stagger(phase.enter, j);
        const bOut = stagger(phase.exit, j);
        const y = (1 - bIn) * BLOCK_RISE - bOut * BLOCK_RISE;
        el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
        el.style.opacity = (bIn * (1 - bOut)).toFixed(3);
      }
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
  }, []);

  useSectionProgress(sectionRef, onProgress);

  const activeRow = ACOUSTICS[active] ?? ACOUSTICS[0]!;

  // A demo belongs to the beat that offered it. Carrying on into the next one
  // is the same mistake as a loop with no visibility gate, except audible.
  //
  // In an effect, not during render: `stop` sets state.
  useEffect(() => {
    if (playing !== null && playing !== activeRow.id) stop();
  }, [activeRow.id, playing, stop]);

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
              section label is not the headline here — the beat flying through
              the middle is, and two things at display scale would fight. */}
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

          {/* The stage. Every beat occupies all of it and is centred in it, so
              they arrive in the same place rather than at their own heights. */}
          <div className="relative min-h-0 flex-1">
            {ACOUSTICS.map((row, i) => (
              <article
                key={row.id}
                ref={(el) => {
                  beats.current[i]!.root = el;
                }}
                style={{ visibility: "hidden" }}
                className="absolute inset-0 flex items-center justify-center"
              >
                <div
                  ref={(el) => {
                    beats.current[i]!.card = el;
                  }}
                  // No `backdrop-filter`. A backdrop filter makes the
                  // compositor read what is behind the element every frame, and
                  // what is behind this one is an animating canvas — the same
                  // reason `mix-blend-mode` is banned over the stage. A flat
                  // translucent fill is one cheap composite and reads the same.
                  className="w-full max-w-[62ch] rounded-tile border border-line-strong bg-void/85 p-7 sm:p-9"
                >
                  <p
                    ref={(el) => {
                      beats.current[i]!.blocks[0] = el;
                    }}
                    className="rule-label text-signal"
                  >
                    {row.eyebrow}
                  </p>
                  {/* `text-heading`, not `text-title`. Measured, not chosen:
                      at title scale this card ran 568px tall in a 360px stage
                      on a 720p laptop, so the paragraph under it was clipped
                      and the starfield the section is built around had nowhere
                      to show. */}
                  <h3
                    ref={(el) => {
                      beats.current[i]!.blocks[1] = el;
                    }}
                    className="mt-4 max-w-[18ch] text-heading font-medium text-ink"
                  >
                    {row.title}
                  </h3>
                  <p
                    ref={(el) => {
                      beats.current[i]!.blocks[2] = el;
                    }}
                    className="mt-4 text-lead leading-relaxed text-ink-dim"
                  >
                    {row.body}
                  </p>

                  <div
                    ref={(el) => {
                      beats.current[i]!.blocks[3] = el;
                    }}
                    className="mt-7 flex flex-wrap items-center gap-5"
                  >
                    {/* Nothing clips this. The old layout ran every block
                        through an `overflow: hidden` window, which took the
                        focus ring with it — the only feedback a keyboard user
                        has about where they are. With one beat moving at a
                        time the windows are not needed at all. */}
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
              </article>
            ))}
          </div>

          {/* The readout. Stays for the whole lock, across the full width —
              which is what lets the field be a background rather than a strip
              beside a panel, and keeps the meter to a single canvas and a
              single ref where a meter per card would have needed three.

              The card carries the argument; this carries the evidence. The
              signal chain lives here rather than in the card for that reason
              and for a duller one: in the card it added a hundred pixels to
              something that already did not fit a 720p laptop. */}
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
              {/* Follows the beat on screen. Inline rather than stacked: it is
                  a chain, it reads as one, and the frame has no vertical space
                  to spare for three more lines. */}
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
