"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { readEnvironment } from "@/lib/motion";
import { clamp, easeInOutQuart } from "@/lib/utils";

/**
 * Dissolves a section in as it arrives and out as it leaves.
 *
 * Sections used to simply scroll past one another: the one above slid off the
 * top edge with a hard border and the next one slid up under it. This makes the
 * boundary a hand-off instead — the outgoing section softens and recedes while
 * the incoming one settles and sharpens, so the two overlap for the length of
 * the transition rather than abutting.
 *
 * Three properties, and the difference between them is the whole design:
 *
 *  - `opacity` and `transform` are compositor properties. They cost nothing per
 *    frame and they carry the movement, so they run continuously.
 *  - `filter: blur()` does not. Every distinct radius re-rasterises the layer,
 *    at layer size, and this layer is a full viewport. So the radius is
 *    **quantised** — it takes one of a handful of values across the whole
 *    transition, which is four or five rasterisations instead of one per frame.
 *    The banding that would normally give away is invisible because opacity and
 *    scale are moving smoothly underneath it. `.noise-field` solves its own
 *    version of this the same way, with `steps(8)`.
 *  - At the ends the filter is *removed*, not set to `blur(0px)`. A zero-radius
 *    filter still promotes the element and still runs a filter pass over it,
 *    for a blur nobody can see.
 *
 * The blur is dropped entirely on mobile and under reduced motion; opacity and
 * scale carry the effect there on their own, and they read almost the same.
 *
 * **This element must never be an ancestor of `position: sticky` content.**
 * A `filter` creates a containing block and a new stacking context, so sticky
 * inside one pins to the filtered element instead of the viewport and simply
 * stops working. The stage is sticky; it is not wrapped in this.
 */

/** Blur at full transition, in px, before quantisation. */
const MAX_BLUR = 14;
/** Radius step. Bigger means fewer rasterisations and coarser banding. */
const BLUR_STEP = 3.5;
/** How far the outgoing section recedes and the incoming one arrives from. */
const EXIT_SCALE = 0.955;
const ENTER_SCALE = 1.035;

/**
 * Where in the viewport each half of the hand-off starts and finishes, as a
 * fraction of viewport height measured down from the top edge.
 *
 * The entrance watches the section's top edge and the exit watches its bottom
 * edge, and the two share a value on purpose: for adjacent sections those are
 * the *same* edge, so the arithmetic makes the two curves exact complements —
 * `enter + exit === 1` at every scroll position, which is what makes the
 * boundary a cross-dissolve rather than a fade-out followed by a fade-in.
 *
 * The first attempt used one span from the viewport edge and produced exactly
 * that mistake: measured across the boundary, the incoming section was fully
 * arrived while the outgoing one had not started to leave.
 *
 * Measured from the element's own edges rather than from a scroll offset, so
 * this behaves the same wherever the section sits and needs no retuning when
 * one is inserted above it.
 */
const FROM = 0.85;
const TO = 0.15;

export function SectionHandoff({
  children,
  enter = true,
  exit = false,
}: {
  children: ReactNode;
  /** Dissolve in as the top edge rises into view. */
  enter?: boolean;
  /** Dissolve out as the bottom edge leaves through the top. */
  exit?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { reducedMotion, tier } = readEnvironment();
    const useBlur = !reducedMotion && tier !== "mobile";

    // Written only when they change. A section sitting fully settled in the
    // viewport is the common case and it should cost one comparison, not three
    // style writes, on every frame for as long as it is on screen.
    let lastOpacity = -1;
    let lastScale = -1;
    let lastBlur = -1;

    return onFrameWhileVisible(
      el,
      () => {
        // INPUT phase: layout reads are legal here and nowhere later.
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const span = vh * (FROM - TO);

        // 0 while fully out of the way, 1 when the section owns the viewport.
        let progress = 1;

        if (enter) {
          // Top edge travelling up the viewport.
          progress = Math.min(progress, (FROM * vh - rect.top) / span);
        }
        if (exit) {
          // Bottom edge travelling out through the top.
          progress = Math.min(progress, (rect.bottom - TO * vh) / span);
        }
        progress = clamp(progress, 0, 1);

        const eased = easeInOutQuart(progress);
        const opacity = Math.round(eased * 100) / 100;
        const from = exit && rect.bottom < vh ? EXIT_SCALE : ENTER_SCALE;
        const scale = Math.round((from + (1 - from) * eased) * 1000) / 1000;
        const blur = useBlur
          ? Math.round(((1 - eased) * MAX_BLUR) / BLUR_STEP) * BLUR_STEP
          : 0;

        if (opacity !== lastOpacity) {
          lastOpacity = opacity;
          el.style.opacity = String(opacity);
        }
        if (scale !== lastScale) {
          lastScale = scale;
          el.style.transform = `scale3d(${scale}, ${scale}, 1)`;
        }
        if (blur !== lastBlur) {
          lastBlur = blur;
          el.style.filter = blur > 0 ? `blur(${blur}px)` : "";
        }

        // Held only while the hand-off is actually mid-flight. `will-change` is
        // a promise to keep a full-viewport compositor layer alive, and a page
        // with several of these would otherwise keep one per section for the
        // rest of the visit.
        const moving = progress > 0.001 && progress < 0.999;
        el.style.willChange = moving ? "opacity, transform, filter" : "";
      },
      Priority.INPUT,
    );
  }, [enter, exit]);

  return (
    <div ref={ref} style={{ willChange: "" }}>
      {children}
    </div>
  );
}
