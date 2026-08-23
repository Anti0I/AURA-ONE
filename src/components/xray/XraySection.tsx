"use client";

import { useEffect, useRef, useState } from "react";
import manifest from "@/data/sequence.json";
import { HOTSPOTS, LABEL_LAYOUT, LOCK_RADIUS } from "@/data/hotspotLayout";
import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { Particles } from "@/lib/canvas/Particles";
import { readEnvironment } from "@/lib/motion";
import { clamp, damp } from "@/lib/utils";
import type { SequenceManifest } from "@/types/sequence";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { LeaderLines } from "./LeaderLines";

const SEQUENCE = manifest as SequenceManifest;

const pick = (id: "outer" | "inner", width: number) =>
  SEQUENCE.xray[id].find((s) => s.width === width)?.url ??
  SEQUENCE.xray[id][0]!.url;

/**
 * The neural scanner.
 *
 * Two renders from an identical camera stacked on top of each other, with a
 * circular window into the lower one. Everything about how it moves is chosen
 * so the browser never repaints:
 *
 * The obvious implementation animates `mask-image: radial-gradient(... at X Y)`
 * or `clip-path: circle(R at X Y)`. Both recompute the mask on the compositor's
 * critical path every frame — at a full-bleed 16:9 that is 6–10 ms on a mid
 * laptop, and the lens visibly lags the cursor.
 *
 * Instead the lens is a fixed-size element that is *translated*, and the copy
 * of the artwork inside it is translated by exactly the opposite amount so it
 * stays registered with the layer underneath. Two transforms, both composited,
 * zero repaint — the lens keeps up at 120 Hz.
 */
export function XraySection() {
  const frameRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLDivElement>(null);
  const lensInnerRef = useRef<HTMLDivElement>(null);
  const particleRef = useRef<HTMLCanvasElement>(null);
  const hotspotRefs = useRef<Record<string, HTMLElement | null>>({});

  const [revealed, setRevealed] = useState(false);
  const [autoSweep, setAutoSweep] = useState(true);

  useEffect(() => {
    const frame = frameRef.current;
    const lens = lensRef.current;
    const lensInner = lensInnerRef.current;
    const particleCanvas = particleRef.current;
    if (!frame || !lens || !lensInner || !particleCanvas) return;

    const env = readEnvironment();
    const particles = new Particles(140);
    const pctx = particleCanvas.getContext("2d");
    // Read from the theme rather than written in as a hex. A canvas cannot
    // inherit a colour, but it can be told one, and a literal here is a token
    // nobody finds when the palette moves — which it just did.
    const particleColor =
      getComputedStyle(particleCanvas).getPropertyValue("--color-signal").trim() ||
      "#e4d9c8";

    let width = 0;
    let height = 0;
    let radius = 0;

    // Normalised 0..1 within the frame.
    let targetX = 0.5;
    let targetY = 0.45;
    let x = targetX;
    let y = targetY;
    let pointerDriven = false;
    let activeId: string | null = null;

    const measure = () => {
      const rect = frame.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      radius = lens.offsetWidth / 2;
      // The inner copy has to be exactly frame-sized for the two layers to
      // stay registered; it lives inside a circle, so it cannot inherit it.
      lensInner.style.width = `${width}px`;
      lensInner.style.height = `${height}px`;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      particleCanvas.width = Math.round(width * dpr);
      particleCanvas.height = Math.round(height * dpr);
      if (pctx) pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    measure();

    // The label and its connector live in two different trees (HTML for the
    // wrapping text, SVG for the line), so they cannot share a CSS state
    // selector. Cached once here rather than queried on every lock.
    const leaders = new Map<string, SVGGElement>();
    for (const g of frame.querySelectorAll<SVGGElement>("[data-leader]")) {
      const id = g.dataset.leader;
      if (id) leaders.set(id, g);
    }

    const setActive = (id: string | null, on: boolean) => {
      if (!id) return;
      const label = hotspotRefs.current[id];
      if (label) label.dataset.active = String(on);
      const leader = leaders.get(id);
      if (leader) leader.style.opacity = on ? "1" : "0";
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = frame.getBoundingClientRect();
      targetX = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      targetY = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      pointerDriven = true;
      setAutoSweep(false);
    };

    const onPointerLeave = () => {
      pointerDriven = false;
      setAutoSweep(true);
    };

    frame.addEventListener("pointermove", onPointerMove, { passive: true });
    frame.addEventListener("pointerleave", onPointerLeave);
    // Touch drags the scanner directly; without this the section is inert on a
    // phone, which is where a good half of a recruiter's first look happens.
    frame.addEventListener("pointerdown", onPointerMove, { passive: true });

    // Gated on visibility. The sweep is a loop with no end, so without this it
    // keeps running — Lissajous, damping, a distance test against every
    // hotspot, two transform writes and a full-bleed `clearRect` — for the
    // rest of the session, including while the visitor is back up at the hero.
    // `content-visibility: auto` skips *rendering* the section; it does
    // nothing about the frame loop, and the `clearRect` still dirties the
    // canvas layer for the compositor every frame.
    const detach = onFrameWhileVisible(frame, (f) => {
      if (!pointerDriven) {
        // Lissajous sweep. Two incommensurable frequencies means the path never
        // repeats exactly, so an idle section does not look like a GIF — and it
        // passes over every component eventually.
        const t = f.time * 0.34;
        targetX = 0.5 + Math.sin(t) * 0.19;
        targetY = 0.46 + Math.sin(t * 1.618 + 1.2) * 0.16;
      }

      // Damped, not pinned. The lag is what gives the instrument mass.
      x = damp(x, targetX, env.coarsePointer ? 14 : 19, f.delta);
      y = damp(y, targetY, env.coarsePointer ? 14 : 19, f.delta);

      const px = x * width;
      const py = y * height;
      lens.style.transform = `translate3d(${(px - radius).toFixed(2)}px, ${(py - radius).toFixed(2)}px, 0)`;
      lensInner.style.transform = `translate3d(${(radius - px).toFixed(2)}px, ${(radius - py).toFixed(2)}px, 0)`;

      // Nearest component inside the lock radius — only ever one. Showing every
      // label the lens overlaps turns a cluster of parts into unreadable soup.
      let nearest: string | null = null;
      let best = LOCK_RADIUS;
      for (const spot of HOTSPOTS) {
        const dx = spot.x - x;
        const dy = spot.y - y;
        const distance = Math.hypot(dx, dy);
        if (distance < best) {
          best = distance;
          nearest = spot.id;
        }
      }

      if (nearest !== activeId) {
        setActive(activeId, false);
        setActive(nearest, true);
        if (nearest) {
          const spot = HOTSPOTS.find((h) => h.id === nearest)!;
          particles.emit(spot.x * width, spot.y * height, 26, 105);
        }
        activeId = nearest;
      }

      if (pctx) {
        pctx.clearRect(0, 0, width, height);
        particles.step(pctx, f.delta, particleColor);
      }
    }, Priority.RENDER);

    return () => {
      observer.disconnect();
      frame.removeEventListener("pointermove", onPointerMove);
      frame.removeEventListener("pointerleave", onPointerLeave);
      frame.removeEventListener("pointerdown", onPointerMove);
      detach();
    };
  }, []);

  return (
    <section
      id="scanner"
      className="relative border-t border-line px-gutter py-24"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 100vh" }}
    >
      <div aria-hidden className="noise-field" />

      <header className="relative mb-12 flex flex-wrap items-end justify-between gap-6">
        <div>
          <SectionLabel index={2}>Neural scanner</SectionLabel>
          <h2 className="mt-5 max-w-[18ch] text-title font-medium text-ink">
            Look straight through it.
          </h2>
        </div>
        <p className="max-w-[40ch] text-ink-dim">
          {autoSweep
            ? "The scanner is sweeping on its own. Move your pointer over the device to take control."
            : "Hold the scanner over a component to read its specification."}
        </p>
      </header>

      <div
        ref={frameRef}
        data-cursor="hidden"
        // Capped by height as well as width, so the frame never eats the whole
        // viewport — the heading and the callouts have to stay on screen
        // together for the section to read as a diagram rather than a poster.
        className={
          "relative mx-auto aspect-video w-full max-w-[min(100%,calc(68svh*16/9))] " +
          // `pan-y`, not `none`. This frame is up to 68svh tall, so on a phone a
          // vertical swipe lands inside it far more often than not — and with
          // touch-action disabled entirely that swipe did nothing at all and the
          // page simply refused to move. Horizontal drags still aim the scanner.
          "touch-pan-y select-none overflow-hidden rounded-tile border border-line bg-surface"
        }
      >
        {/* Base layer: the sealed product. */}
        <picture>
          <source media="(max-width: 900px)" srcSet={pick("outer", 1200)} />
          <img
            src={pick("outer", 2400)}
            alt="AURA ONE with the case closed"
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
        </picture>

        {/* The lens. Moves by transform only; the mask itself never changes. */}
        <div
          ref={lensRef}
          data-lens
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 h-[clamp(160px,26vw,340px)] w-[clamp(160px,26vw,340px)] will-change-transform"
        >
          <div
            className="relative h-full w-full overflow-hidden rounded-full"
            style={{
              // Static gradient: soft edge without recomputing per frame.
              maskImage:
                "radial-gradient(circle, #000 58%, rgba(0,0,0,0.55) 82%, transparent 100%)",
              WebkitMaskImage:
                "radial-gradient(circle, #000 58%, rgba(0,0,0,0.55) 82%, transparent 100%)",
            }}
          >
            <div ref={lensInnerRef} className="absolute left-0 top-0 will-change-transform">
              <picture>
                <source media="(max-width: 900px)" srcSet={pick("inner", 1200)} />
                <img
                  src={pick("inner", 2400)}
                  alt=""
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              </picture>
            </div>
          </div>

          <span className="absolute inset-0 rounded-full border border-signal/45" />
          <span className="absolute inset-[14%] rounded-full border border-signal/15" />
        </div>

        <canvas
          ref={particleRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        <LeaderLines
          register={(id, el) => {
            hotspotRefs.current[id] = el;
          }}
          layout={LABEL_LAYOUT}
        />
      </div>

      {/* Keyboard and reduced-motion path: the same information, no scanner. */}
      <div className="relative mt-6 flex flex-wrap items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-pressed={revealed}
          className="rule-label rounded-full border border-line px-4 py-2 text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
        >
          {revealed ? "Hide component list" : "List components"}
        </button>
        <p className="rule-label">
          {HOTSPOTS.length} components // anchors projected from the render camera
        </p>
      </div>

      {revealed ? (
        <dl className="relative mt-6 grid gap-x-10 gap-y-5 border-t border-line pt-6 sm:grid-cols-2 lg:grid-cols-3">
          {HOTSPOTS.map((spot) => (
            <div key={spot.id}>
              <dt className="text-ink">{spot.title}</dt>
              <dd className="rule-label mt-1">{spot.detail}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
