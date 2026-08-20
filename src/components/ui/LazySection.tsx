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
  minHeight = "100svh",
  rootMargin = "500px",
}: {
  children: ReactNode;
  minHeight?: string;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || mounted) return;

    // No IntersectionObserver means an old browser we are not optimising for;
    // render everything rather than render nothing.
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
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
    <div ref={ref} style={mounted ? undefined : { minHeight }}>
      {mounted ? children : null}
    </div>
  );
}
