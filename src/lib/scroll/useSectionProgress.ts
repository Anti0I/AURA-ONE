"use client";

import { useEffect, type RefObject } from "react";
import { onFrame, Priority } from "./rafBus";
import { clamp } from "@/lib/utils";

/**
 * Reports how far a tall section has scrolled past a sticky viewport, 0..1.
 *
 * Progress is 0 when the section's top reaches the top of the viewport and 1
 * when its bottom does — i.e. exactly the span over which a `sticky top-0`
 * child stays put. That is the same contract as a GSAP pin, without the
 * pin-spacer element, the layout shift on refresh, or the plugin.
 *
 * The callback is invoked on the frame loop rather than on `scroll` events:
 * scroll events fire at wildly different rates across browsers and input
 * devices, and coalescing them into the frame we are about to draw is the only
 * way to guarantee the canvas and the DOM agree about where the page is.
 *
 * `onProgress` must not cause a React render. It is called up to 120 times a
 * second; write to a ref or straight to the canvas.
 */
export function useSectionProgress(
  ref: RefObject<HTMLElement | null>,
  onProgress: (progress: number) => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let lastReported = -1;

    return onFrame(() => {
      // Layout read, and this is the INPUT phase — nothing has written to the
      // DOM yet this frame, so it cannot force a reflow.
      const rect = el.getBoundingClientRect();
      const distance = rect.height - window.innerHeight;
      if (distance <= 0) return;

      const progress = clamp(-rect.top / distance, 0, 1);
      // A 1/10000 threshold: fine enough that nothing visible is skipped,
      // coarse enough that a settled page stops doing work entirely.
      if (Math.abs(progress - lastReported) < 0.0001) return;
      lastReported = progress;
      onProgress(progress);
    }, Priority.INPUT);
  }, [ref, onProgress]);
}
