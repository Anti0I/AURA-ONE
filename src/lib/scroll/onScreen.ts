"use client";

/**
 * Runs a per-frame task only while an element is on screen.
 *
 * Three sections of this site animate on a loop that has no natural end — the
 * scanner sweeps, the configurator spins, the walkthrough holds a playhead —
 * and every one of them, written the obvious way, keeps drawing at the
 * display's refresh rate for the rest of the session. Several sections up the
 * page, and in a background tab. It costs the visitor's battery to animate
 * something nobody is looking at, and it is invisible in every way except the
 * one that matters.
 *
 * That bug has now been written three times in this repository, so the gate
 * lives here rather than being remembered at each call site.
 *
 * `rootMargin` is generous on purpose: a section should be running by the time
 * it scrolls into view, not start when it arrives.
 */
import { onFrame, type FrameTask } from "./rafBus";

export function onFrameWhileVisible(
  element: Element,
  task: FrameTask,
  priority?: number,
  rootMargin = "200px",
): () => void {
  let visible = true;
  let observer: IntersectionObserver | null = null;

  if (typeof IntersectionObserver !== "undefined") {
    visible = false;
    observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(element);
  }

  const detach = onFrame((frame) => {
    // `visibilityState` as well as the observer: a background tab throttles rAF
    // rather than stopping it, and a throttled loop is still a loop.
    if (!visible || document.visibilityState === "hidden") return;
    task(frame);
  }, priority);

  return () => {
    detach();
    observer?.disconnect();
  };
}
