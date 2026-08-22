"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACOUSTICS, PRODUCT, SPECS } from "@/data/specs";
import {
  DEMO_SECONDS,
  acousticsAnalyser,
  disposeAcoustics,
  playDemo,
  type DemoHandle,
  type DemoId,
} from "@/lib/audio/acoustics";
import { setAudioEnabled } from "@/lib/audio/AudioBus";
import { prefersReducedMotion } from "@/lib/motion";
import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { useAppStore } from "@/store/useAppStore";
import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/lib/utils";

/**
 * What the product is actually for.
 *
 * The rest of the page is about how the thing is made: the shell, the
 * assembly, the silicon. None of it says what it sounds like, which for a
 * listening device is the only claim that matters — so this section makes the
 * claim in the one medium that can carry it, and does it without shipping a
 * single byte of audio. Everything you hear is generated in
 * `lib/audio/acoustics.ts` from oscillators and a noise buffer.
 *
 * Nothing plays until it is asked for. The context is created by the click,
 * which is both the browser's requirement and the right default.
 */

/** Bars in the meter. Enough to read as a spectrum, few enough to stay calm. */
const BARS = 44;

export function AcousticsSection() {
  const [playing, setPlaying] = useState<DemoId | null>(null);
  const handle = useRef<DemoHandle | null>(null);
  const timer = useRef(0);
  const meterRef = useRef<HTMLCanvasElement>(null);

  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const toggleAudio = useAppStore((s) => s.toggleAudio);

  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
    handle.current?.stop();
    handle.current = null;
    setPlaying(null);
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(timer.current);
      handle.current?.stop();
      disposeAcoustics();
    };
  }, []);

  const start = useCallback(
    (id: DemoId) => {
      // Whatever was running stops first: two demonstrations at once is not a
      // richer demonstration, it is a mess with no claim in it.
      window.clearTimeout(timer.current);
      handle.current?.stop();
      handle.current = null;

      if (playing === id) {
        setPlaying(null);
        return;
      }

      // The click is the gesture the AudioContext needs, and it is also
      // unambiguous consent — somebody pressing "hear the driver" has asked for
      // sound. Applied directly rather than waiting for the store, so the first
      // thing they hear is the thing they pressed; the store is then brought
      // into line so the header control tells the truth.
      if (!audioEnabled) {
        setAudioEnabled(true);
        toggleAudio();
      }

      const started = playDemo(id);
      if (!started) return; // no audio on this machine; the page is unharmed

      handle.current = started;
      setPlaying(id);
      timer.current = window.setTimeout(
        () => {
          handle.current = null;
          setPlaying(null);
        },
        DEMO_SECONDS[id] * 1000 + 120,
      );
    },
    [audioEnabled, playing, toggleAudio],
  );

  // ---- Meter -------------------------------------------------------------
  // Two states, and the split is the point. While a demo plays this reads the
  // analyser on the frame loop; while nothing plays it draws a resting row of
  // bars **once** and subscribes to nothing. An idle meter redrawing an
  // unchanging picture sixty times a second is the same waste as any other
  // loop with no natural end — and the first version of this simply drew
  // nothing when idle, which left an empty rectangle that read as broken.
  useEffect(() => {
    const canvas = meterRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const styles = getComputedStyle(canvas);
    const signal = styles.getPropertyValue("--meter-signal").trim();
    const dim = styles.getPropertyValue("--meter-dim").trim();

    const { width, height } = canvas;
    const gap = Math.max(1, Math.round(width / (BARS * 9)));
    const barWidth = (width - gap * (BARS - 1)) / BARS;
    const floor = Math.max(2 * dpr, height * 0.03);

    const paint = (levelAt: (i: number) => number) => {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < BARS; i++) {
        const level = levelAt(i);
        const barHeight = Math.max(floor, level * height);
        ctx.fillStyle = level > 0.04 ? signal : dim;
        ctx.fillRect(
          i * (barWidth + gap),
          height - barHeight,
          barWidth,
          barHeight,
        );
      }
    };

    if (playing === null || prefersReducedMotion()) {
      paint(() => 0);
      return;
    }

    const bins = new Uint8Array(1024);
    return onFrameWhileVisible(
      canvas,
      () => {
        const analyser = acousticsAnalyser();
        if (!analyser) return paint(() => 0);

        // `getByteFrequencyData` fills the first `frequencyBinCount` entries,
        // so one buffer large enough for any FFT size is reused rather than
        // allocating a fresh view on every frame.
        const count = analyser.frequencyBinCount;
        analyser.getByteFrequencyData(bins.subarray(0, count));

        paint((i) => {
          // Squared bin mapping, so the bass is not crushed into the first two
          // bars. A linear spectrum of a musical signal is a wall on the left
          // and nothing anywhere else.
          const from = Math.floor(Math.pow(i / BARS, 2) * (count - 1));
          const to = Math.max(
            from + 1,
            Math.floor(Math.pow((i + 1) / BARS, 2) * (count - 1)),
          );
          let peak = 0;
          for (let b = from; b < to; b++) peak = Math.max(peak, bins[b] ?? 0);
          return peak / 255;
        });
      },
      Priority.RENDER,
    );
  }, [playing]);

  const latency = SPECS.find((s) => s.label === "Round-trip latency");

  return (
    <section
      id="acoustics"
      aria-labelledby="acoustics-heading"
      className="relative border-t border-line px-gutter py-24"
    >
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
              aria-hidden
              className="mt-4 h-28 w-full [--meter-dim:#1f1f25] [--meter-signal:#4fd1ff]"
            />
            {/* The meter is decoration; this is the same fact in text, and it
                is what a screen reader and a reduced-motion visitor get. */}
            <p role="status" className="mt-4 text-base text-ink-dim">
              {playing
                ? `Playing: ${ACOUSTICS.find((r) => r.id === playing)?.title}`
                : "Nothing playing."}
            </p>
            {playing ? (
              <button
                type="button"
                onClick={stop}
                className="mt-4 text-label uppercase tracking-[0.14em] text-ink-faint underline underline-offset-4 hover:text-ink"
              >
                Stop playback
              </button>
            ) : null}
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
