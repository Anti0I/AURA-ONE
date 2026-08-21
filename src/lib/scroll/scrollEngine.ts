"use client";

import Lenis from "lenis";
import { onFrame, Priority } from "./rafBus";
import { prefersReducedMotion } from "@/lib/motion";

let lenis: Lenis | null = null;
let detach: (() => void) | null = null;
let heightObserver: ResizeObserver | null = null;
let initialised = false;

/**
 * Smooth scrolling, integrated on the shared frame loop.
 *
 * Lenis' own README drives it from a private `requestAnimationFrame`. That
 * works, but it puts scroll integration and canvas drawing in different
 * callbacks with no guaranteed order, so the canvas ends up rendering last
 * frame's scroll position — the pinned text and the artwork drift apart by
 * exactly one frame. Running it as the first INPUT task on the shared bus
 * removes the whole class of problem.
 *
 * There is no ScrollTrigger here and no GSAP. The pinned section is
 * `position: sticky`, which the browser composites for free; progress is read
 * off one `getBoundingClientRect` per frame during the INPUT phase, before
 * anything has written to the DOM. That is ~30 KB of plugin, a pin-spacer and
 * a class of refresh bugs avoided, for about forty lines of code.
 */
export function initScrollEngine(): Lenis | null {
  if (initialised) return lenis;
  initialised = true;

  if (prefersReducedMotion()) {
    // Native scrolling only. Section progress still works — it is measured
    // from layout, not from Lenis.
    return null;
  }

  lenis = new Lenis({
    duration: 1.05,
    // Long, flat tail: the page keeps gliding after the wheel stops, which is
    // what gives the pinned canvas its sense of weight.
    easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    // Touch devices already have native inertia; smoothing it again feels
    // laggy and breaks the browser's own overscroll behaviour.
    syncTouch: false,
  });

  detach = onFrame((f) => lenis?.raf(f.now), Priority.INPUT);

  // Lenis caches `limit = scrollHeight - innerHeight` and hard-clamps every
  // wheel gesture to it. Its own auto-resize watches `document.documentElement`
  // — which is also the element the preloader parks `overflow: hidden` on
  // while it holds the page, and which stops being a reliable proxy for content
  // height while that is set. The failure is silent and specific: the wheel
  // stops at the stale limit while dragging the native scrollbar still reaches
  // the true bottom, because the scrollbar bypasses Lenis entirely.
  //
  // This page grows a lot after Lenis is constructed — three lazy sections
  // mount from placeholders that are shorter than the real thing — so the
  // measurement has to be driven from something that actually tracks content.
  // `document.body` does.
  if (typeof ResizeObserver !== "undefined") {
    heightObserver = new ResizeObserver(() => lenis?.resize());
    heightObserver.observe(document.body);
  }

  return lenis;
}

export function destroyScrollEngine() {
  detach?.();
  heightObserver?.disconnect();
  lenis?.destroy();
  detach = null;
  heightObserver = null;
  lenis = null;
  initialised = false;
}

/**
 * Re-measures the document.
 *
 * The observer above catches everything that changes `body`'s box, but a couple
 * of moments are worth being explicit about rather than waiting a frame for:
 * unlocking the page after boot, and swapping a lazy placeholder for the real
 * section. Cheap, idempotent, and it makes the dependency legible at the call
 * site instead of hiding it in a global.
 */
export function refreshScroll() {
  lenis?.resize();
}

export function getLenis() {
  return lenis;
}

/** Scrolls to a selector or absolute offset, through Lenis when it is active. */
export function scrollTo(target: string | number, offset = 0) {
  if (lenis) {
    lenis.scrollTo(target, { offset, duration: 1.2 });
    return;
  }
  if (typeof target === "number") {
    window.scrollTo({ top: target + offset, behavior: "smooth" });
    return;
  }
  document.querySelector(target)?.scrollIntoView({ behavior: "smooth" });
}
