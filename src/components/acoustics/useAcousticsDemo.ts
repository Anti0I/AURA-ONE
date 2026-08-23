"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Playback state and the spectrum meter, shared by both acoustics layouts.
 *
 * The section renders as a pinned scrollytelling frame on a wide viewport and
 * as a plain stacked list on a narrow one or under reduced motion. Those are
 * genuinely different documents — one pages through absolutely positioned
 * beats, the other is a list — so they are separate components, and everything
 * that is *not* layout lives here instead of being written twice.
 */

/**
 * Bars in the meter.
 *
 * A parameter rather than a constant because the two layouts give the meter
 * very different shapes: a 22rem panel in the flat list, and a strip across the
 * whole viewport in the pinned frame. The 44 bars that read as a spectrum in
 * the panel read as a picket fence at full width.
 */
const DEFAULT_BARS = 44;

/**
 * Reference lines across the meter, as fractions of full scale.
 *
 * Not decoration filling a gap — although it does that too. A resting spectrum
 * is a flat floor, and a flat floor at the bottom of a tall panel is
 * indistinguishable from a panel that failed to draw, which is exactly how the
 * first version read. A scale behind the bars says "instrument at rest" instead
 * of "nothing here", and it is true whether or not anything is playing.
 */
const GRID = [0.25, 0.5, 0.75];

export function useAcousticsDemo(bars = DEFAULT_BARS) {
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

  // ---- Meter ---------------------------------------------------------------
  // Two states, and the split is the point. While a demo plays this reads the
  // analyser on the frame loop; while nothing plays it draws a resting row of
  // bars **once** and subscribes to nothing. An idle meter redrawing an
  // unchanging picture sixty times a second is the same waste as any other loop
  // with no natural end — and the first version simply drew nothing when idle,
  // which left an empty rectangle that read as broken.
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
    const gap = Math.max(1, Math.round(width / (bars * 9)));
    const barWidth = (width - gap * (bars - 1)) / bars;
    const floor = Math.max(2 * dpr, height * 0.03);

    const paint = (levelAt: (i: number) => number) => {
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = dim;
      for (const line of GRID) {
        ctx.fillRect(0, Math.round(height * (1 - line)), width, 1);
      }

      for (let i = 0; i < bars; i++) {
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
          const from = Math.floor(Math.pow(i / bars, 2) * (count - 1));
          const to = Math.max(
            from + 1,
            Math.floor(Math.pow((i + 1) / bars, 2) * (count - 1)),
          );
          let peak = 0;
          for (let b = from; b < to; b++) peak = Math.max(peak, bins[b] ?? 0);
          return peak / 255;
        });
      },
      Priority.RENDER,
    );
  }, [bars, playing]);

  return { playing, start, stop, meterRef };
}
