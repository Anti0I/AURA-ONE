"use client";

import type { Ref } from "react";
import type { SpecRow } from "@/data/specs";

/**
 * The numbers that land while the camera is inside the silicon.
 *
 * Right-aligned and monospaced so the figures stack into a column the eye can
 * scan in one movement — the same reason a spec sheet is a table and not a
 * paragraph. Visibility is driven from the frame loop; this component never
 * re-renders after mount.
 */
export function SpecFlash({
  ref,
  specs,
}: {
  ref: Ref<HTMLDivElement>;
  specs: readonly SpecRow[];
}) {
  return (
    <div
      ref={ref}
      style={{ opacity: 0, visibility: "hidden" }}
      aria-hidden
      className="pointer-events-none absolute right-gutter top-1/2 z-10 -translate-y-1/2 will-change-[opacity]"
    >
      <dl className="flex flex-col items-end gap-3 border-r border-line-strong pr-5">
        {specs.map((row) => (
          <div key={row.label} className="text-right">
            <dt className="rule-label">{row.label}</dt>
            <dd
              data-numeric
              className="text-2xl leading-tight text-ink sm:text-3xl"
            >
              {row.value}
              {row.unit ? (
                <span className="ml-1 text-base text-ink-faint">
                  {row.unit}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
