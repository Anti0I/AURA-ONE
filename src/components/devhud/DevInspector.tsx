"use client";

import { useEffect, useRef } from "react";
import { useTelemetry } from "@/store/transient";
import { useAppStore } from "@/store/useAppStore";
import {
  FPS_WINDOW,
  readHistory,
  resetWorstFrame,
  startFpsMeter,
} from "@/lib/perf/fpsMeter";
import { onFrame, Priority, frameTaskCount } from "@/lib/scroll/rafBus";
import { readEnvironment } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The engineering HUD.
 *
 * Every number here is read from the live telemetry object the canvas writes to
 * during its draw — not from React state, and not from a separate measurement
 * pass that could disagree with what was actually drawn.
 *
 * The panel itself samples at 10 Hz. Painting a changing four-digit number 120
 * times a second costs real layout work in the middle of the frame budget the
 * HUD exists to measure, and nobody can read a number that fast anyway. The
 * sparkline is the exception: it draws to a canvas on the frame loop, where it
 * costs nothing.
 */
export function DevInspector() {
  const open = useAppStore((s) => s.devInspector);
  const toggle = useAppStore((s) => s.toggleDevInspector);

  useEffect(() => {
    if (!open) return;
    return startFpsMeter();
  }, [open]);

  // `d` toggles it. No modifier, because it is a developer affordance and the
  // page has no text input at all, so nothing else claims the keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "d" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA")
      ) {
        return;
      }
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  if (!open) return null;
  return <Panel onClose={toggle} />;
}

function Panel({ onClose }: { onClose: () => void }) {
  const t = useTelemetry();
  const store = useAppStore();
  const env = readEnvironment();

  const fpsHealthy = t.fps >= 55;
  const minHealthy = t.fpsMin >= 45;

  return (
    <aside
      aria-label="Developer inspector"
      className={cn(
        "fixed bottom-4 right-4 z-[90] w-[min(22rem,calc(100vw-2rem))]",
        "rounded-tile border border-line-strong bg-void/95 p-3 backdrop-blur-sm",
        "font-mono text-[11px] leading-tight text-ink-dim shadow-2xl",
      )}
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <span className="rule-label text-ink">Dev inspector</span>
        <button
          type="button"
          onClick={onClose}
          className="rule-label transition-colors hover:text-ink"
        >
          Close · D
        </button>
      </header>

      <Sparkline />

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        <Row label="fps" value={t.fps.toFixed(0)} tone={fpsHealthy ? "good" : "warn"} />
        <Row
          label="worst"
          value={Number.isFinite(t.fpsMin) ? t.fpsMin.toFixed(0) : "—"}
          tone={minHealthy ? "good" : "warn"}
        />
        <Row label="draw" value={`${t.drawMs.toFixed(2)} ms`} />
        <Row label="tasks" value={String(frameTaskCount())} />

        <Divider>Sequence</Divider>
        <Row label="frame" value={t.frame.toFixed(0)} />
        <Row label="exact" value={t.frameFloat.toFixed(2)} />
        <Row label="progress" value={t.storyProgress.toFixed(4)} />
        <Row label="queue" value={String(t.decodeQueue)} />

        <Divider>Bitmap cache</Divider>
        <Row label="frames" value={String(t.lruSize)} />
        <Row
          label="pinned"
          value={`${(t.lruBytes / 1024 / 1024).toFixed(1)} MB`}
          tone={t.lruBytes > 130 * 1024 * 1024 ? "warn" : "good"}
        />
        <Row
          label="heap"
          value={t.heapMB === null ? "n/a" : `${t.heapMB.toFixed(0)} MB`}
        />
        <Row label="canvas" value={`${t.canvasWidth}×${t.canvasHeight}`} />

        <Divider>Environment</Divider>
        <Row label="tier" value={env.tier} />
        <Row label="dpr" value={t.dpr.toFixed(2)} />
        <Row label="webgpu" value={env.hasWebGPU ? "yes" : "no"} />
        <Row label="reduced" value={env.reducedMotion ? "yes" : "no"} />

        <Divider>State</Divider>
        <Row label="phase" value={String(store.storyPhase)} />
        <Row label="finish" value={store.material} />
        <Row label="engine" value={store.aiEngine} />
        <Row label="audio" value={store.audioEnabled ? "on" : "off"} />
      </dl>
    </aside>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd
        data-numeric
        className={cn(
          tone === "good" && "text-live",
          tone === "warn" && "text-alert",
          !tone && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <p className="rule-label col-span-2 mt-2 border-t border-line pt-2">
      {children}
    </p>
  );
}

/**
 * Frame-time history.
 *
 * Bars rather than a line, and scaled against 60 fps with a marker at 30, so
 * the shape of a stutter is visible instead of being averaged into a smooth
 * curve that hides it.
 */
function Sparkline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const history = new Float32Array(FPS_WINDOW);

    const detach = onFrame(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== w * dpr) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const count = readHistory(history);
      if (count === 0) return;

      const scale = 90; // fps at the top of the box
      const barWidth = w / FPS_WINDOW;

      // 60 fps reference.
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      const y60 = h - (60 / scale) * h;
      ctx.beginPath();
      ctx.moveTo(0, y60);
      ctx.lineTo(w, y60);
      ctx.stroke();

      for (let i = 0; i < count; i++) {
        const fps = Math.min(history[i]!, scale);
        const barHeight = (fps / scale) * h;
        ctx.fillStyle =
          fps >= 55 ? "#c6ff3d" : fps >= 30 ? "#4fd1ff" : "#ff5c39";
        ctx.fillRect(
          i * barWidth,
          h - barHeight,
          Math.max(barWidth - 0.5, 0.5),
          barHeight,
        );
      }
    }, Priority.MEASURE);

    return () => {
      detach();
      resetWorstFrame();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="block h-10 w-full rounded bg-surface"
    />
  );
}
