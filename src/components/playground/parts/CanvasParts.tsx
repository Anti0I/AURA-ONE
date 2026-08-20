"use client";

import { useEffect, useRef } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { clamp, easeOutExpo } from "@/lib/utils";
import type { SpectrumPart, WaveformPart } from "@/lib/ai/protocol";

/** Reads a CSS custom property so the widgets follow the design tokens. */
function token(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * Waveform.
 *
 * Drawn as a min/max envelope per pixel column rather than by plotting every
 * sample. A 4096-sample buffer across an 800-pixel canvas is five samples per
 * column; plotting them as a polyline throws away the peaks and produces a
 * thin, wrong-looking trace. The envelope is what an audio editor draws, and it
 * is also cheaper.
 */
export function WaveformWidget({ part }: { part: WaveformPart }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const signal = token("--color-signal", "#4fd1ff");
    const dim = token("--color-line-strong", "#2c2c35");
    const live = token("--color-live", "#c6ff3d");

    let reveal = 0;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const mid = h / 2;
      const columns = Math.floor(w);
      const perColumn = Math.max(1, Math.floor(part.samples.length / columns));
      const visible = Math.floor(columns * reveal);

      // Focus band behind the trace.
      if (part.focus) {
        ctx.fillStyle = "rgba(198,255,61,0.08)";
        const x0 = part.focus.from * w;
        ctx.fillRect(x0, 0, (part.focus.to - part.focus.from) * w, h);
      }

      ctx.strokeStyle = dim;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      for (let column = 0; column < visible; column++) {
        let min = 1;
        let max = -1;
        const start = column * perColumn;
        for (let i = 0; i < perColumn; i++) {
          const v = part.samples[start + i] ?? 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }

        const inFocus =
          part.focus &&
          column / columns >= part.focus.from &&
          column / columns <= part.focus.to;

        ctx.strokeStyle = inFocus ? live : signal;
        ctx.globalAlpha = inFocus ? 0.95 : 0.62;
        ctx.beginPath();
        ctx.moveTo(column + 0.5, mid - max * mid * 0.92);
        ctx.lineTo(column + 0.5, mid - min * mid * 0.92);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    // Sweeps in left to right, the way a recording fills a track. It also
    // usefully covers the moment the widget is inserted mid-stream.
    let elapsed = 0;
    const detach = onFrame((f) => {
      if (reveal >= 1) return;
      elapsed += f.delta;
      reveal = easeOutExpo(clamp(elapsed / 0.7, 0, 1));
      draw();
    }, Priority.RENDER);

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);

    return () => {
      detach();
      observer.disconnect();
    };
  }, [part]);

  return (
    <figure className="mt-4 rounded-tile border border-line bg-void/60 p-3">
      <canvas ref={canvasRef} className="block h-24 w-full" />
      <figcaption className="rule-label mt-2 flex justify-between gap-4">
        <span>{part.label}</span>
        {part.focus ? <span className="text-live">{part.focus.label}</span> : null}
      </figcaption>
    </figure>
  );
}

/**
 * Third-octave spectrum, before and after processing.
 *
 * Both series share one axis and one scale, because the entire point is the gap
 * between them. Drawing "after" as a second chart, or normalising each to its
 * own range, would hide the only thing the widget exists to show.
 */
export function SpectrumWidget({ part }: { part: SpectrumPart }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const signal = token("--color-signal", "#4fd1ff");
    const dim = token("--color-line-strong", "#2c2c35");

    let progress = 0;
    const all = [...part.before, ...part.after];
    const lo = Math.min(...all) - 3;
    const hi = Math.max(...all) + 3;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const n = part.before.length;
      const slot = w / n;
      const barWidth = Math.max(2, slot * 0.62);
      const norm = (v: number) => (v - lo) / (hi - lo);

      for (let i = 0; i < n; i++) {
        const x = i * slot + (slot - barWidth) / 2;
        const before = norm(part.before[i] ?? lo);
        const after = norm(part.after[i] ?? lo);
        // "After" animates down from "before", so the eye reads the reduction
        // as something that happened rather than as two separate readings.
        const shown = before + (after - before) * progress;

        ctx.fillStyle = dim;
        ctx.fillRect(x, h - before * h, barWidth, before * h);
        ctx.fillStyle = signal;
        ctx.fillRect(x, h - shown * h, barWidth, shown * h);
      }
    };

    let elapsed = 0;
    const detach = onFrame((f) => {
      if (progress >= 1) return;
      elapsed += f.delta;
      progress = easeOutExpo(clamp(elapsed / 1.1, 0, 1));
      draw();
    }, Priority.RENDER);

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);

    return () => {
      detach();
      observer.disconnect();
    };
  }, [part]);

  return (
    <figure className="mt-4 rounded-tile border border-line bg-void/60 p-3">
      <canvas ref={canvasRef} className="block h-28 w-full" />
      <figcaption className="rule-label mt-2 flex flex-wrap justify-between gap-4">
        <span>{part.label}</span>
        <span className="text-signal">
          <span data-numeric>−{part.reductionDb}</span> dB peak
        </span>
      </figcaption>
    </figure>
  );
}
