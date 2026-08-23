"use client";

import { useEffect, useRef } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { readEnvironment } from "@/lib/motion";
import { damp } from "@/lib/utils";

/**
 * Custom cursor: a dot.
 *
 * It was a crosshair with a live pixel readout beside it, and both went. The
 * coordinates were the giveaway — a number that changes as fast as your hand
 * moves and means nothing to anybody reading it, printed next to the pointer
 * because it looks like instrumentation. That is set dressing pretending to be
 * telemetry, and this site has real telemetry elsewhere. The crosshair went
 * with it: aiming arms and a ranging circle imply a precision the scanner does
 * not have and does not need, and a plain dot says "you are aiming this"
 * without saying anything untrue.
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

  useEffect(() => {
    const env = readEnvironment();
    if (env.coarsePointer) return;

    const root = rootRef.current;
    if (!root) return;

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let x = targetX;
    let y = targetY;
    let visible = false;

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;

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
      // Nothing to move while it is hidden, and nothing to move once it has
      // caught up. Without both tests this writes a transform to a
      // `opacity: 0` element sixty times a second for the entire visit — the
      // reticle is only ever shown over two of the page's sections.
      if (!visible && Math.abs(x - targetX) + Math.abs(y - targetY) < 0.05) {
        return;
      }
      x = damp(x, targetX, 26, f.delta);
      y = damp(y, targetY, 26, f.delta);
      root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
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
      {/* A 7px dot, centred on the pointer. Big enough to find against the
          artwork, small enough that it never covers what it is aiming at. */}
      <div className="h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal" />
    </div>
  );
}
