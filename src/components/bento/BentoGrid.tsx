"use client";

import { useEffect, useRef, useState } from "react";
import {
  BATTERY,
  POWER_MODES,
  PRODUCT,
  averageDraw,
  runtimeHours,
} from "@/data/specs";
import { useAppStore } from "@/store/useAppStore";
import { buildSpecSheet, downloadBlob } from "@/lib/pdf/spec-sheet";
import { getMaterial } from "@/data/materials";
import { clamp } from "@/lib/utils";

/**
 * Metrics grid.
 *
 * Three tiles, each interactive rather than decorative. The battery and the
 * frequency-response figures come from the same constants the playground and
 * the generated PDF read, so nothing on this page can quote a number the rest
 * of the site disagrees with.
 */
export function BentoGrid() {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <BatteryTile />
      <ResponseTile />
      <DataSheetTile />
    </div>
  );
}

/* ------------------------------------------------------------------ battery */

function BatteryTile() {
  // Share of runtime spent doing inference, 0..1. The rest splits 2:1 between
  // playback and ANC, which is the mix the scenario data assumes.
  const [inferenceShare, setInferenceShare] = useState(0.1);

  const rest = 1 - inferenceShare;
  const mix = {
    playback: rest * (2 / 3),
    anc: rest * (1 / 3),
    inference: inferenceShare,
  };
  const draw = averageDraw(mix);
  const hours = runtimeHours(draw);
  const best = runtimeHours(POWER_MODES[1]!.mw);

  return (
    <Tile
      label="Battery"
      title={
        <>
          <span data-numeric>{hours.toFixed(1)}</span>
          <span className="ml-1.5 text-base text-ink-faint">hours</span>
        </>
      }
    >
      <p className="text-sm text-ink-dim">
        <span data-numeric>{draw.toFixed(1)}</span> mW average against{" "}
        <span data-numeric>{BATTERY.milliwattHours.toFixed(0)}</span> mWh.
      </p>

      <label className="mt-5 block">
        <span className="rule-label flex justify-between">
          <span>Inference share</span>
          <span data-numeric className="text-signal">
            {Math.round(inferenceShare * 100)}%
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(inferenceShare * 100)}
          onChange={(e) => setInferenceShare(Number(e.target.value) / 100)}
          className="mt-2 w-full accent-[var(--color-signal)]"
        />
      </label>

      {/* Runtime relative to the best case, as a single honest bar. */}
      <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-1 bg-signal transition-[width] duration-300 ease-[var(--ease-out-expo)]"
          style={{ width: `${clamp((hours / best) * 100, 4, 100)}%` }}
        />
      </div>
      <p className="rule-label mt-2">
        Best case <span data-numeric>{best.toFixed(1)}</span> h · playback only
      </p>
    </Tile>
  );
}

/* ----------------------------------------------------------------- response */

/** Third-octave centres, 20 Hz to 40 kHz. */
const CENTRES = [
  20, 31.5, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000,
  12500, 20000, 31500,
];

function ResponseTile() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tilt, setTilt] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const style = getComputedStyle(document.documentElement);
      const signal = style.getPropertyValue("--color-signal").trim() || "#4fd1ff";
      const line = style.getPropertyValue("--color-line").trim() || "#1f1f25";

      // 0 dB reference.
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      ctx.strokeStyle = signal;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      for (let i = 0; i < CENTRES.length; i++) {
        const f = i / (CENTRES.length - 1);
        // Flat through the middle, gentle roll-off at both ends, plus the
        // user's tilt applied as a linear slope across the band.
        const lowRoll = -6 * Math.exp(-((f / 0.1) ** 2)) * (1 - f);
        const highRoll = -8 * Math.exp(-(((1 - f) / 0.12) ** 2));
        const db = lowRoll + highRoll + (f - 0.5) * tilt * 2;
        const y = h / 2 - (db / 12) * (h / 2) * 0.9;
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(f * w, y);
      }
      ctx.stroke();

      if (hover !== null) {
        const x = (hover / (CENTRES.length - 1)) * w;
        ctx.strokeStyle = signal;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [tilt, hover]);

  const label =
    hover === null
      ? "5 Hz – 40 kHz · ±3 dB"
      : `${formatHz(CENTRES[hover]!)} · third-octave centre`;

  return (
    <Tile label="Frequency response" title="Planar driver">
      <canvas
        ref={canvasRef}
        className="mt-1 block h-24 w-full cursor-crosshair"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const f = (e.clientX - rect.left) / rect.width;
          setHover(Math.round(clamp(f, 0, 1) * (CENTRES.length - 1)));
        }}
        onPointerLeave={() => setHover(null)}
      />
      <p className="rule-label mt-2">{label}</p>

      <label className="mt-4 block">
        <span className="rule-label flex justify-between">
          <span>Tilt</span>
          <span data-numeric className="text-signal">
            {tilt > 0 ? "+" : ""}
            {tilt.toFixed(1)} dB
          </span>
        </span>
        <input
          type="range"
          min={-6}
          max={6}
          step={0.5}
          value={tilt}
          onChange={(e) => setTilt(Number(e.target.value))}
          className="mt-2 w-full accent-[var(--color-signal)]"
        />
      </label>
    </Tile>
  );
}

function formatHz(hz: number) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`;
}

/* ---------------------------------------------------------------- datasheet */

function DataSheetTile() {
  const material = useAppStore((s) => s.material);
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );

  const generate = async () => {
    setState("working");
    try {
      const blob = await buildSpecSheet(material);
      downloadBlob(blob, `aura-one-${getMaterial(material).code.toLowerCase()}.pdf`);
      setState("done");
    } catch {
      setState("error");
    }
  };

  return (
    <Tile label="Documentation" title="Data sheet">
      <p className="text-sm leading-relaxed text-ink-dim">
        Composed in the browser at click time from the same constants this page
        reads — not a checked-in file that drifts out of date. Includes the
        finish you have selected.
      </p>

      <button
        type="button"
        onClick={generate}
        disabled={state === "working"}
        className="rule-label mt-5 w-full rounded-full bg-signal px-4 py-2.5 text-void transition-colors hover:bg-ink disabled:opacity-50"
      >
        {state === "working"
          ? "Composing…"
          : state === "error"
            ? "Failed — try again"
            : `Download ${getMaterial(material).code} PDF`}
      </button>

      <p className="rule-label mt-3">
        {PRODUCT.name} · A4 · generated {new Date().toISOString().slice(0, 10)}
      </p>
    </Tile>
  );
}

/* --------------------------------------------------------------------- tile */

function Tile({
  label,
  title,
  children,
}: {
  label: string;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-tile border border-line bg-surface p-5">
      <p className="rule-label">{label}</p>
      <h3 className="mt-2 text-2xl leading-none text-ink">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}
