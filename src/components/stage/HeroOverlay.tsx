"use client";

import type { Ref } from "react";
import { PRODUCT } from "@/data/specs";
import { cn } from "@/lib/utils";

/**
 * The first five seconds.
 *
 * Deliberately only three things: the name, the claim, and an invitation to
 * scroll. The device is already on screen behind this — anything more competes
 * with it.
 */
export function HeroOverlay({
  ref,
  ready,
}: {
  ref: Ref<HTMLDivElement>;
  ready: boolean;
}) {
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-end px-gutter pb-28 will-change-[opacity,transform]"
    >
      <h1
        className={cn(
          "max-w-[13ch] text-display font-medium text-ink transition-[opacity,transform,filter] duration-[900ms] ease-[var(--ease-out-expo)]",
          ready ? "opacity-100 blur-0" : "translate-y-4 opacity-0 blur-[6px]",
        )}
      >
        {PRODUCT.name}.
        <br />
        <span className="text-ink-faint">{PRODUCT.tagline}</span>
      </h1>

      <div className="mt-8 flex items-end justify-between gap-8">
        <p
          className={cn(
            "max-w-[42ch] text-lead text-ink-dim transition-opacity delay-200 duration-700",
            ready ? "opacity-100" : "opacity-0",
          )}
        >
          A neural audio wearable that thinks on-device. No cloud round-trip, no
          account, no latency you can hear.
        </p>

        <div
          className={cn(
            "hidden shrink-0 items-center gap-3 transition-opacity delay-500 duration-700 sm:flex",
            ready ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="rule-label">Scroll</span>
          {/* A track with a mark travelling down it, rather than a bouncing
              chevron: it says "this section is long" as well as "scroll". */}
          <span
            aria-hidden
            className="relative block h-10 w-px overflow-hidden bg-line-strong"
          >
            <span className="absolute inset-x-0 top-0 h-3 animate-[scroll-hint_2.4s_var(--ease-in-out-quart)_infinite] bg-signal" />
          </span>
        </div>
      </div>
    </div>
  );
}
