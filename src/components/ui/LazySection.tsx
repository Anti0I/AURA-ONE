"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mounts its children when the section is close to the viewport.
 *
 * The point is the code split, not the render. Sections below the fold pull in
 * their own JavaScript — the scanner alone is a particle system, an audio
 * synth and a hotspot layout — and none of it is needed to paint the hero. Left
 * in the first-load bundle it is time the browser spends parsing script instead
 * of drawing the product.
 *
 * `minHeight` reserves the space up front so the placeholder swapping for the
 * real thing cannot shift anything below it. A lazy section that causes layout
 * shift has traded one bad metric for a worse one.
 */
export function LazySection({
  children,
  id,
  minHeight = "100svh",
  rootMargin = "500px",
}: {
  children: ReactNode;
  /**
   * Anchor id, carried by the placeholder as well as the mounted section.
   * Without it a deep link to a lazy section points at an element that does
   * not exist yet, and the jump silently does nothing.
   */
  id?: string;
  minHeight?: string;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || mounted) return;

    // No IntersectionObserver means an old browser we are not optimising for;
    // render everything rather than render nothing. Deferred to a microtask so
    // it does not set state synchronously inside the effect and cascade a
    // second render.
    if (typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setMounted(true));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, rootMargin]);

  return (
    <div
      ref={ref}
      id={mounted ? undefined : id}
      style={mounted ? undefined : { minHeight }}
    >
      {mounted ? children : null}
    </div>
  );
}
