"use client";

import type { Ref } from "react";
import { scrollTo } from "@/lib/scroll/scrollEngine";

/**
 * Phase rail along the bottom of a pinned section.
 *
 * Serves two jobs. It tells you how much of a very tall section is left — a
 * pinned section with no visible extent is the fastest way to make somebody
 * think the page is broken. And it is a control: each phase is a button, so a
 * pinned section can be navigated rather than only scrubbed. That also gives
 * keyboard users a way through something that is otherwise pure scroll, which
 * is not a nicety when the phases contain their own controls.
 *
 * The fill is driven by a CSS custom property written from the frame loop, so
 * moving it costs one `setProperty` and no React work.
 *
 * Parameterised rather than duplicated. There are two pinned sections now — the
 * walkthrough and the acoustics demos — and a second copy of this would have
 * been the kind of duplicate that stays identical exactly until the first fix
 * lands in one of them.
 */

export interface RailStep {
  id: string;
  /** "01 // Driver". Split on the separator so a narrow viewport can drop the
   *  second half rather than wrapping the rail onto two lines. */
  eyebrow: string;
}

export function ProgressRail({
  ref,
  steps,
  active,
  sectionId,
  targets,
  label,
}: {
  ref: Ref<HTMLDivElement>;
  steps: readonly RailStep[];
  /** Index of the step on screen, for `aria-current`. */
  active: number;
  /** Element the buttons scroll within. */
  sectionId: string;
  /** Where to land for each step, as a fraction of the section's scroll span. */
  targets: readonly number[];
  /** Accessible name for the list. Must be unique on the page. */
  label: string;
}) {
  return (
    <div
      ref={ref}
      style={{ ["--rail-progress" as string]: "0" }}
      className="absolute inset-x-gutter bottom-6 z-10 flex items-center gap-4"
    >
      <ol className="flex flex-1 gap-2" aria-label={label}>
        {steps.map((step, i) => (
          <li key={step.id} className="flex-1">
            <button
              type="button"
              aria-current={active === i ? "step" : undefined}
              onClick={() => {
                const el = document.getElementById(sectionId);
                if (!el) return;
                const span = el.offsetHeight - window.innerHeight;
                scrollTo(el.offsetTop + span * (targets[i] ?? 0));
              }}
              className="group block w-full text-left"
            >
              <span className="relative block h-px w-full bg-line-strong">
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-signal transition-none"
                  style={{
                    // Each segment fills across its own share of the timeline.
                    width: `clamp(0%, calc((var(--rail-progress) - ${
                      i / steps.length
                    }) * ${steps.length * 100}%), 100%)`,
                  }}
                />
              </span>
              <span
                className={
                  "rule-label mt-2 block whitespace-nowrap transition-colors duration-300 " +
                  (active === i
                    ? "text-ink"
                    : "text-ink-faint group-hover:text-ink-dim")
                }
              >
                {/* On a narrow viewport only the ordinal fits. Letting the
                    label wrap pushes the rail into two lines and over the copy
                    above it, which is worse than showing less. */}
                {step.eyebrow.split(" // ")[0]}
                <span className="hidden sm:inline">
                  {" // "}
                  {step.eyebrow.split(" // ")[1]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
