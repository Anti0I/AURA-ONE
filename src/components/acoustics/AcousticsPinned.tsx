"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACOUSTICS, PRODUCT, SPECS } from "@/data/specs";
import { useSectionProgress } from "@/lib/scroll/useSectionProgress";
import { clamp, cn, easeInOutQuart } from "@/lib/utils";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { Reveal } from "@/components/ui/Reveal";
import { useAcousticsDemo } from "./useAcousticsDemo";

/**
 * The acoustics section as a pinned scrollytelling frame.
 *
 * The same mechanism the walkthrough uses, applied a second time: a very tall
 * section, one `position: sticky` child, and progress read from a single
 * `getBoundingClientRect` per frame during the INPUT phase. No ScrollTrigger,
 * no pin-spacer, no plugin — the browser composites a sticky element for free.
 *
 * The frame holds still while three beats page through it. The header, the
 * meter and the latency figure stay put; the left column is replaced. Nothing
 * in here goes through React state per frame (hard rule 1) — beat positions are
 * written straight to `style` on refs. The one piece of state is which beat is
 * on screen, which changes three times in a whole visit and drives the rail's
 * `aria-current`, the signal chain, and stopping a demo the scroll has left.
 */

/**
 * Fraction of the section each beat owns, and how much of that is spent moving.
 *
 * `LEAD_IN` is derived rather than chosen: it is exactly one wipe long, so the
 * first beat starts fully below its window at the moment the section pins and
 * arrives as the run-up finishes. Picked as a round number instead, the first
 * beat is already half on screen before anyone has scrolled.
 *
 * The last beat has no exit. It holds until the section releases — the scroll
 * carries it away, which is the "unlock" and needs no animation to say so.
 * Wiping it out would leave the frame empty for the run-out.
 */
const SPAN = 0.28;
const WIPE = 0.34;
const LEAD_IN = WIPE * SPAN;

/**
 * Delay between the blocks of one beat, as a fraction of its own travel.
 *
 * Blocks, not lines. Wiping line by line means measuring line boxes and
 * re-measuring them on every width change, which is a class of bug rather than
 * a detail — the same reason `Reveal` splits on words. Four blocks leaving in
 * sequence reads the same way.
 */
const STAGGER = 0.14;
const BLOCKS = 4;
const USABLE = 1 - STAGGER * (BLOCKS - 1);

/**
 * How far a block travels, as a percentage of its own height.
 *
 * Which is why every mover is stretched to fill its window (`h-full`) and every
 * window has a fixed height. A CSS percentage translation is relative to the
 * *element*, not to whatever is clipping it — so a one-line title inside a
 * two-line window translated by 115% of one line is still sitting in the
 * window, in full view, having "left". That is what the first version did, and
 * it looked like two titles stacked rather than one replacing another.
 */
const TRAVEL = 115;

interface BeatRefs {
  root: HTMLElement | null;
  blocks: (HTMLElement | null)[];
}

export function AcousticsPinned() {
  const sectionRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const beats = useRef<BeatRefs[]>(
    ACOUSTICS.map(() => ({ root: null, blocks: [] })),
  );

  const { playing, start, stop, meterRef } = useAcousticsDemo();
  const [active, setActive] = useState(0);
  const lastActive = useRef(0);

  const onProgress = useCallback(
    (p: number) => {
      for (let i = 0; i < ACOUSTICS.length; i++) {
        const beat = beats.current[i];
        if (!beat?.root) continue;

        // 0 at the start of this beat's window, 1 at the end of it.
        const phase = (p - LEAD_IN) / SPAN - i;
        const enterRaw = clamp((phase + WIPE) / WIPE, 0, 1);
        // The last beat never leaves; see the note on LEAD_IN.
        const exitRaw =
          i === ACOUSTICS.length - 1
            ? 0
            : clamp((phase - (1 - WIPE)) / WIPE, 0, 1);

        const gone = enterRaw <= 0 || exitRaw >= 1;
        beat.root.style.visibility = gone ? "hidden" : "visible";
        // `will-change` is a promise to hold a compositor layer, and three
        // full-height beats holding one each for the rest of the visit is the
        // mistake the hero copy already taught us once.
        beat.root.style.willChange =
          gone || (enterRaw >= 1 && exitRaw <= 0)
            ? ""
            : "opacity, transform";
        if (gone) continue;

        for (let j = 0; j < beat.blocks.length; j++) {
          const el = beat.blocks[j];
          if (!el) continue;
          const eIn = easeInOutQuart(
            clamp((enterRaw - STAGGER * j) / USABLE, 0, 1),
          );
          const eOut = easeInOutQuart(
            clamp((exitRaw - STAGGER * j) / USABLE, 0, 1),
          );
          const y = (1 - eIn) * TRAVEL - eOut * TRAVEL;
          el.style.transform = `translate3d(0, ${y.toFixed(2)}%, 0)`;
          // Only the controls row carries opacity. The text blocks sit inside
          // clipping windows and are simply *gone* when translated out, which
          // is a harder edge than a fade and the reason for the windows.
          if (el.dataset.fade === "1") {
            el.style.opacity = String(eIn * (1 - eOut));
          }
        }
      }

      const rail = railRef.current;
      if (rail) rail.style.setProperty("--rail-progress", p.toFixed(4));

      // Switched at the middle of the wipe rather than at the window boundary,
      // so the rail changes over while the two beats are crossing instead of
      // after the new one has landed.
      const next = clamp(
        Math.floor((p - LEAD_IN) / SPAN + WIPE / 2),
        0,
        ACOUSTICS.length - 1,
      );
      if (next !== lastActive.current) {
        lastActive.current = next;
        setActive(next);
      }
    },
    [],
  );

  useSectionProgress(sectionRef, onProgress);

  const activeRow = ACOUSTICS[active] ?? ACOUSTICS[0]!;

  // A demo belongs to the beat that offered it. Carrying on into the next one
  // is the same mistake as a loop with no visibility gate, except audible.
  //
  // In an effect, not during render: `stop` sets state, and setting state
  // while rendering is a different component's problem to debug later.
  useEffect(() => {
    if (playing !== null && playing !== activeRow.id) stop();
  }, [activeRow.id, playing, stop]);

  const latency = SPECS.find((s) => s.label === "Round-trip latency");

  return (
    <section
      ref={sectionRef}
      id="acoustics"
      aria-labelledby="acoustics-heading"
      className="relative border-t border-line h-[380svh]"
    >
      <div className="sticky top-0 h-dvh overflow-hidden">
        <div className="mx-auto flex h-full max-w-[100rem] flex-col px-gutter pb-28 pt-24">
          <header className="max-w-[46ch] shrink-0">
            <p className="rule-label text-signal">04 // Acoustics</p>
            <Reveal
              as="h2"
              id="acoustics-heading"
              className="mt-4 text-title font-medium text-ink"
            >
              {`What ${PRODUCT.name} sounds like.`}
            </Reveal>
          </header>

          <div className="grid min-h-0 flex-1 items-stretch gap-10 pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
            {/* Left: the beats, stacked and paged. */}
            <div className="relative min-h-0">
              {ACOUSTICS.map((row, i) => (
                <article
                  key={row.id}
                  ref={(el) => {
                    beats.current[i]!.root = el;
                  }}
                  style={{ visibility: "hidden" }}
                  // Aligned to the top, not centred, and the title window has a
                  // fixed two-line height. Both are about what happens *during*
                  // a wipe rather than at rest: centred beats of unequal height
                  // put their titles at different heights, so the outgoing and
                  // incoming ones cross at an offset and the whole thing reads
                  // as two paragraphs colliding instead of one slot changing
                  // its contents. Every block now occupies the same slot in
                  // every beat, which is what makes the wipe legible.
                  className="absolute inset-x-0 top-[12%] flex flex-col"
                >
                  {/* Each window clips its own child. The font size lives on
                      the window so the `em` padding that keeps descenders off
                      the clip edge resolves against the right scale. */}
                  <p className="rule-label h-[1.7em] overflow-hidden">
                    <span
                      ref={(el) => {
                        beats.current[i]!.blocks[0] = el;
                      }}
                      className="block h-full"
                    >
                      {row.eyebrow}
                    </span>
                  </p>
                  {/* Two lines tall, with slack for the descenders on the
                      second one — the display scale runs a 1.02 line-height, so
                      glyphs overflow their own line box and a window sized to
                      the text exactly would shave them. */}
                  <h3 className="mt-5 h-[2.34em] max-w-[15ch] overflow-hidden text-title font-medium text-ink">
                    <span
                      ref={(el) => {
                        beats.current[i]!.blocks[1] = el;
                      }}
                      className="block h-full"
                    >
                      {row.title}
                    </span>
                  </h3>
                  <p className="mt-3 h-[6.9em] max-w-[46ch] overflow-hidden text-lead leading-relaxed text-ink-dim">
                    <span
                      ref={(el) => {
                        beats.current[i]!.blocks[2] = el;
                      }}
                      className="block h-full"
                    >
                      {row.body}
                    </span>
                  </p>

                  {/* Deliberately not inside a clipping window: it holds the
                      focus ring, and a clipped focus ring is the one piece of
                      feedback a keyboard user has. Moves on transform and
                      opacity instead. */}
                  <div
                    ref={(el) => {
                      beats.current[i]!.blocks[3] = el;
                    }}
                    data-fade="1"
                    className="mt-10 flex flex-wrap items-center gap-5"
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
                </article>
              ))}
            </div>

            {/* Right: stays put for the whole lock. */}
            <aside className="flex min-h-0 flex-col justify-center gap-5">
              <div className="rounded-tile border border-line bg-raised/60 p-6">
                <p className="rule-label">Output</p>
                <canvas
                  ref={meterRef}
                  aria-hidden
                  className="mt-5 h-40 w-full [--meter-dim:#1f1f25] [--meter-signal:#4fd1ff] xl:h-52"
                />
                {/* The axis the bars are plotted against. Without it the panel
                    is a rectangle with a line at the bottom, and a scale is the
                    difference between an instrument and an empty box. */}
                <p
                  aria-hidden
                  className="mt-2 flex justify-between text-label uppercase tracking-[0.14em] text-ink-faint"
                  data-numeric
                >
                  <span>38 Hz</span>
                  <span>1 kHz</span>
                  <span>16 kHz</span>
                </p>
                <p role="status" className="mt-5 text-base text-ink-dim">
                  {playing
                    ? `Playing: ${ACOUSTICS.find((r) => r.id === playing)?.title}`
                    : "Nothing playing."}
                </p>
              </div>

              <div className="rounded-tile border border-line bg-raised/60 p-6">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="rule-label">Signal chain</p>
                  {latency ? (
                    <p className="rule-label text-ink-dim" data-numeric>
                      {latency.value}
                      {latency.unit} round-trip
                    </p>
                  ) : null}
                </div>
                <ol className="mt-4 grid gap-2" role="list">
                  {activeRow.chain.map((node) => (
                    <li
                      key={node}
                      className="flex gap-3 text-base leading-relaxed text-ink-dim"
                    >
                      <span aria-hidden className="text-signal-dim">
                        →
                      </span>
                      {node}
                    </li>
                  ))}
                </ol>
              </div>
            </aside>
          </div>
        </div>

        <ProgressRail
          ref={railRef}
          steps={ACOUSTICS}
          active={active}
          sectionId="acoustics"
          // The middle of each beat's own window, so a click lands on a settled
          // beat rather than in the middle of a wipe.
          targets={[
            LEAD_IN + 0.5 * SPAN,
            LEAD_IN + 1.5 * SPAN,
            LEAD_IN + 2.5 * SPAN,
          ]}
          label="Acoustics demonstrations"
        />
      </div>
    </section>
  );
}
