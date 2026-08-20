"use client";

import { HOTSPOTS, type LabelPlacement } from "@/data/hotspotLayout";

/**
 * Technical callouts for the scanner.
 *
 * The connector is SVG in a 16:9 viewBox that matches the frame exactly, so the
 * scale stays uniform and stroke widths are not distorted — the usual failure
 * when people reach for `preserveAspectRatio="none"` to make coordinates line
 * up. The labels themselves are HTML positioned in percentages, because SVG
 * text does not wrap and these are real sentences.
 *
 * Active state is a `data-active` attribute written from the frame loop.
 * Everything visual hangs off `[data-active]` selectors in CSS, so locking onto
 * a component costs one attribute write and no React work at all.
 */
export function LeaderLines({
  register,
  layout,
}: {
  register: (id: string, el: HTMLElement | null) => void;
  layout: Record<string, LabelPlacement>;
}) {
  const VB_W = 1600;
  const VB_H = 900;

  return (
    <>
      <svg
        aria-hidden
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {HOTSPOTS.map((spot) => {
          const place = layout[spot.id];
          if (!place) return null;
          const dir = place.side === "left" ? -1 : 1;

          const ax = spot.x * VB_W;
          const ay = spot.y * VB_H;
          // Elbow first, then a horizontal run out to the label. A single
          // diagonal reads as a scribble; the elbow reads as draughting.
          const ex = ax + dir * 0.055 * VB_W;
          const ey = (spot.y + place.dy) * VB_H;
          // Labels stay inside the frame: it clips, and a callout that runs off
          // the edge of the artwork reads as a layout bug rather than a diagram.
          const tx = place.side === "left" ? 0.225 * VB_W : 0.775 * VB_W;

          return (
            <g
              key={spot.id}
              data-leader={spot.id}
              className="opacity-0 transition-opacity duration-[var(--duration-base)]"
            >
              <path
                d={`M ${ax} ${ay} L ${ex} ${ey} L ${tx} ${ey}`}
                fill="none"
                stroke="var(--color-signal)"
                strokeWidth="1.25"
                strokeOpacity="0.75"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={ax} cy={ay} r="4" fill="var(--color-signal)" />
              <circle
                cx={ax}
                cy={ay}
                r="11"
                fill="none"
                stroke="var(--color-signal)"
                strokeOpacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>

      {HOTSPOTS.map((spot) => {
        const place = layout[spot.id];
        if (!place) return null;
        return (
          <div
            key={spot.id}
            ref={(el) => register(spot.id, el)}
            data-active="false"
            data-hotspot={spot.id}
            className={
              "pointer-events-none absolute w-[min(24ch,21%)] " +
              "opacity-0 transition-[opacity,translate] duration-[var(--duration-base)] " +
              "ease-[var(--ease-out-expo)] data-[active=true]:opacity-100 " +
              "data-[active=true]:translate-x-0 " +
              (place.side === "left"
                ? "right-[78%] translate-x-3 pr-3 text-right"
                : "left-[78%] -translate-x-3 pl-3 text-left")
            }
            style={{
              top: `${(spot.y + place.dy) * 100}%`,
              transform: "translateY(-50%)",
            }}
          >
            <p className="text-sm font-medium leading-tight text-ink">
              {spot.title}
            </p>
            <p className="rule-label mt-1 leading-relaxed text-signal">
              {spot.detail}
            </p>
          </div>
        );
      })}
    </>
  );
}
