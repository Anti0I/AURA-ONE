"use client";

import { useEffect, useRef } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { readEnvironment } from "@/lib/motion";
import { telemetry } from "@/store/transient";
import { damp } from "@/lib/utils";

/**
 * Custom cursor: a crosshair with live coordinates.
 *
 * Only mounted on fine pointers. Replacing the cursor on a touch device is
 * worse than pointless — there is nothing to replace, and the element ends up
 * stranded wherever the last tap landed.
 *
 * The reticle is damped rather than pinned to the pointer. A cursor that
 * tracks exactly is just the system cursor with extra steps; a few frames of
 * lag is what gives it mass, and it is also what makes the X-Ray lens feel
 * like an instrument being moved rather than a CSS effect being applied.
 */
export function Reticle() {
  const rootRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const env = readEnvironment();
    if (env.coarsePointer) return;

    const root = rootRef.current;
    const readout = readoutRef.current;
    if (!root) return;

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let x = targetX;
    let y = targetY;
    let visible = false;
    let lastLabel = "";

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      telemetry.pointerX = e.clientX;
      telemetry.pointerY = e.clientY;

      // Only over surfaces that have hidden the native cursor. A crosshair
      // floating over body copy is decoration; over the scanner it is the
      // instrument you are actually aiming, and showing it alongside the
      // system arrow everywhere else would just be two cursors.
      const over =
        e.target instanceof Element &&
        e.target.closest('[data-cursor="hidden"]') !== null;

      if (over === visible) return;
      visible = over;
      if (over) {
        // Snap on first appearance; damping in from the last known position
        // looks like a bug rather than like easing.
        x = targetX;
        y = targetY;
      }
      root.style.opacity = over ? "1" : "0";
    };

    const onLeave = () => {
      visible = false;
      root.style.opacity = "0";
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);

    const detach = onFrame((f) => {
      x = damp(x, targetX, 26, f.delta);
      y = damp(y, targetY, 26, f.delta);
      root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;

      if (!readout) return;
      // Rounded to 10s: the exact pixel is noise, and repainting a changing
      // three-digit number every frame is a real cost for no information.
      const label = `${Math.round(targetX / 10) * 10} ${Math.round(targetY / 10) * 10}`;
      if (label !== lastLabel) {
        lastLabel = label;
        readout.textContent = label;
      }
    }, Priority.RENDER);

    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      detach();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden
      style={{ opacity: 0 }}
      className="pointer-events-none fixed left-0 top-0 z-[80] hidden opacity-0 transition-opacity duration-200 [@media(pointer:fine)]:block"
    >
      <div className="relative -translate-x-1/2 -translate-y-1/2">
        <svg
          width="46"
          height="46"
          viewBox="0 0 46 46"
          fill="none"
          className="text-signal opacity-80"
        >
          <circle cx="23" cy="23" r="12.5" stroke="currentColor" strokeWidth="1" opacity="0.45" />
          <path d="M23 0v9M23 37v9M0 23h9M37 23h9" stroke="currentColor" strokeWidth="1" />
          <circle cx="23" cy="23" r="1.5" fill="currentColor" />
        </svg>
        <span
          ref={readoutRef}
          data-numeric
          className="absolute left-[30px] top-[26px] whitespace-nowrap text-[10px] tracking-widest text-signal/70"
        />
      </div>
    </div>
  );
}
