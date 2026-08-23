"use client";

import { PRODUCT } from "@/data/specs";

/**
 * Fixed chrome. Deliberately thin: a wordmark, and nothing else competing with
 * a full-bleed product render.
 *
 * `mix-blend-difference` keeps it legible whether the frame behind it is the
 * near-black page or a blown-out highlight on the shell — the alternative is a
 * scrim, and a scrim over a product photograph is a small act of vandalism.
 */
export function SiteHeader() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex items-center justify-between px-gutter py-5 mix-blend-difference">
      <a
        href="#main"
        className="rule-label pointer-events-auto text-ink transition-colors hover:text-signal"
      >
        {PRODUCT.name}
        <span className="ml-2 text-ink-faint">{PRODUCT.generation}</span>
      </a>
    </header>
  );
}
