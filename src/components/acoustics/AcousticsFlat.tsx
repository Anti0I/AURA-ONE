"use client";

import { useRef } from "react";
import { ACOUSTICS, PRODUCT, SPECS } from "@/data/specs";
import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/lib/utils";
import { useAcousticsDemo } from "./useAcousticsDemo";
import { useStarfield } from "./useStarfield";

/**
 * The acoustics section without the pin.
 *
 * What a narrow viewport gets, and what anyone who has asked for reduced motion
 * gets on any viewport. Not a courtesy branch: a section that demands three
 * screens of scroll gesture to reveal three paragraphs is tiring on a phone and
 * hostile to somebody who turned motion down on purpose. Everything the pinned
 * version can tell you is here, in one screen's worth of ordinary document.
 *
 * All three demos are reachable in the tab order at once, which is the other
 * half of the argument — in the pinned frame only the beat on screen is.
 *
 * It gets the starfield too, drawn exactly once and subscribed to nothing. The
 * section keeps its identity on every path, and somebody who asked for less
 * motion gets precisely that rather than a different-looking page.
 */
export function AcousticsFlat() {
  const { playing, meterRef, start } = useAcousticsDemo();
  const fieldRef = useRef<HTMLCanvasElement>(null);
  useStarfield(fieldRef, null);
  const latency = SPECS.find((s) => s.label === "Round-trip latency");

  return (
    <section
      id="acoustics"
      aria-labelledby="acoustics-heading"
      className="relative overflow-hidden border-t border-line bg-void px-gutter py-24"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 40% at 50% 22%, color-mix(in oklab, var(--color-signal-dim) 30%, transparent), transparent 70%)",
        }}
      />
      <canvas
        ref={fieldRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      <header className="relative mb-14 max-w-[52ch]">
        <p className="rule-label text-signal">04 // Acoustics</p>
        <Reveal
          as="h2"
          id="acoustics-heading"
          className="mt-4 text-title font-medium text-ink"
        >
          {`What ${PRODUCT.name} sounds like.`}
        </Reveal>
        <Reveal as="p" className="mt-5 text-lead text-ink-dim" delay={0.12}>
          Every sound below is generated in the browser from oscillators and a
          noise buffer. There is no audio file on this site to load, and there
          never was one to record.
        </Reveal>
      </header>

      <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <ul className="grid gap-4" role="list">
          {ACOUSTICS.map((row) => {
            const active = playing === row.id;
            return (
              <li key={row.id}>
                <article
                  className={cn(
                    "rounded-tile border border-line bg-raised/60 p-6 transition-colors duration-base",
                    active && "border-line-strong",
                  )}
                >
                  <p className="rule-label">{row.eyebrow}</p>
                  <h3 className="mt-3 text-lead font-medium text-ink">
                    {row.title}
                  </h3>
                  <p className="mt-3 max-w-[58ch] text-base leading-relaxed text-ink-dim">
                    {row.body}
                  </p>

                  <div className="mt-5 flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => start(row.id)}
                      className={cn(
                        "rounded-full border px-5 py-2 text-label uppercase tracking-[0.14em]",
                        "transition-colors duration-fast",
                        active
                          ? "border-signal text-signal"
                          : "border-line-strong text-ink hover:border-signal hover:text-signal",
                      )}
                    >
                      {active ? "Stop" : "Play"}
                      <span className="sr-only">{` — ${row.title}`}</span>
                    </button>
                    <p className="text-label uppercase tracking-[0.14em] text-ink-faint">
                      {row.detail}
                    </p>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>

        <aside className="flex flex-col gap-4">
          <div className="rounded-tile border border-line bg-raised/60 p-6">
            <p className="rule-label">Output</p>
            <canvas
              ref={meterRef}
              data-meter
              aria-hidden
              className="mt-4 h-28 w-full [--meter-dim:#1f1f25] [--meter-signal:#4fd1ff]"
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
            {/* The meter is decoration; this is the same fact in text, and it
                is what a screen reader and a reduced-motion visitor get. */}
            <p role="status" className="mt-4 text-base text-ink-dim">
              {playing
                ? `Playing: ${ACOUSTICS.find((r) => r.id === playing)?.title}`
                : "Nothing playing."}
            </p>
          </div>

          <div className="rounded-tile border border-line bg-raised/60 p-6">
            <p className="rule-label">Signal chain</p>
            <ol className="mt-4 grid gap-2" role="list">
              {(
                ACOUSTICS.find((r) => r.id === (playing ?? "sweep")) ??
                ACOUSTICS[0]!
              ).chain.map((node) => (
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
            <p className="mt-4 text-label uppercase tracking-[0.14em] text-ink-faint">
              Built in lib/audio/acoustics.ts
            </p>
          </div>

          {latency ? (
            <div className="rounded-tile border border-line bg-raised/60 p-6">
              <p className="rule-label">{latency.label}</p>
              <p className="mt-2 text-title font-medium text-ink" data-numeric>
                {latency.value}
                <span className="ml-1 text-lead text-ink-faint">
                  {latency.unit}
                </span>
              </p>
              <p className="mt-3 text-base leading-relaxed text-ink-dim">
                Microphone to driver, model included. Past roughly ten
                milliseconds the correction arrives after the sound it was
                meant to cancel, and starts adding to it instead.
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
