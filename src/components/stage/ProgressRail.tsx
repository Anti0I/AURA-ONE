"use client";

import type { Ref } from "react";
import { STORY } from "@/data/story";
import { useAppStore } from "@/store/useAppStore";
import { scrollTo } from "@/lib/scroll/scrollEngine";

/**
 * Phase rail along the bottom of the pinned stage.
 *
 * Serves two jobs. It tells you how much of a 460vh section is left — a pinned
 * section with no visible extent is the fastest way to make somebody think the
 * page is broken. And it is a control: each phase is a button, so the walkthrough
 * can be navigated rather than only scrubbed. That also gives keyboard users a
 * way through a section that is otherwise pure scroll.
 *
 * The fill is driven by a CSS custom property written from the frame loop, so
 * moving it costs one `setProperty` and no React work.
 */
export function ProgressRail({ ref }: { ref: Ref<HTMLDivElement> }) {
  const phase = useAppStore((s) => s.storyPhase);

  return (
    <div
      ref={ref}
      style={{ ["--rail-progress" as string]: "0" }}
      className="absolute inset-x-gutter bottom-6 z-10 flex items-center gap-4"
    >
      <ol className="flex flex-1 gap-2" aria-label="Walkthrough phases">
        {STORY.map((beat, i) => (
          <li key={beat.id} className="flex-1">
            <button
              type="button"
              aria-current={phase === i ? "step" : undefined}
              onClick={() => {
                // Section is 460svh with a 13% hero hold; land the playhead a
                // little inside each phase so its caption is already up.
                const targets = [0.22, 0.5, 0.84];
                const el = document.getElementById("stage");
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
                    // Each segment fills across its own third of the timeline.
                    width: `clamp(0%, calc((var(--rail-progress) - ${i / 3}) * 300%), 100%)`,
                  }}
                />
              </span>
              <span
                className={
                  "rule-label mt-2 block whitespace-nowrap transition-colors duration-300 " +
                  (phase === i
                    ? "text-ink"
                    : "text-ink-faint group-hover:text-ink-dim")
                }
              >
                {/* On a narrow viewport only the ordinal fits. Letting the
                    label wrap pushes the rail into two lines and over the copy
                    above it, which is worse than showing less. */}
                {beat.eyebrow.split(" // ")[0]}
                <span className="hidden sm:inline">
                  {" // "}
                  {beat.eyebrow.split(" // ")[1]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
