"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { PRODUCT } from "@/data/specs";
import { refreshScroll } from "@/lib/scroll/scrollEngine";
import { cn } from "@/lib/utils";

/**
 * Boot overlay.
 *
 * The counter is real: it tracks frames decoded and resident in the player's
 * cache. A fake progress bar is the single most common tell that a site is a
 * template, and it is also a lie that costs the user time — this one is gone
 * the moment the frames are actually there.
 *
 * The overlay unmounts rather than sitting at `opacity: 0`. A full-viewport
 * fixed layer left in the tree keeps its compositing layer alive for the rest
 * of the session.
 */
export function Preloader() {
  const booted = useAppStore((s) => s.booted);
  const progress = useAppStore((s) => s.bootProgress);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!booted) return;
    const id = window.setTimeout(() => setGone(true), 900);
    return () => window.clearTimeout(id);
  }, [booted]);

  // Boot locks the page. Scrolling a stage whose frames have not arrived shows
  // an empty canvas, which looks like a bug rather than like loading.
  useEffect(() => {
    document.documentElement.style.overflow = booted ? "" : "hidden";
    // The scroll engine measured the document while it was locked. Re-measure
    // on the way out, or its first wheel gesture is clamped against whatever
    // the page looked like behind the overlay.
    if (booted) refreshScroll();
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [booted]);

  if (gone) return null;

  const percent = Math.round(progress * 100);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Loading ${PRODUCT.name}, ${percent} percent`}
      className={cn(
        "fixed inset-0 z-[100] flex flex-col justify-between bg-void px-gutter py-8",
        "transition-opacity duration-[800ms] ease-[var(--ease-out-expo)]",
        booted ? "pointer-events-none opacity-0" : "opacity-100",
      )}
    >
      <div aria-hidden className="noise-field" />

      <p className="rule-label relative">{PRODUCT.name}</p>

      <div className="relative flex items-end justify-between gap-6">
        <p
          data-numeric
          className="text-[clamp(3rem,12vw,9rem)] leading-none tracking-tight text-ink"
        >
          {String(percent).padStart(3, "0")}
          <span className="text-ink-faint">%</span>
        </p>
        <p className="rule-label mb-3 hidden sm:block">
          Caching frame sequence
        </p>
      </div>

      <div className="relative h-px w-full bg-line">
        <div
          className="h-px bg-signal transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
