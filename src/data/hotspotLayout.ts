import hotspots from "./hotspots.json";

export interface Hotspot {
  id: string;
  /** Normalised 0..1 anchor, projected from the render camera. */
  x: number;
  y: number;
  title: string;
  detail: string;
}

export const HOTSPOTS = hotspots as Hotspot[];

/**
 * Where each label sits relative to its anchor.
 *
 * The anchors themselves are generated — they come out of the same camera that
 * renders the artwork, so they cannot drift. Label *placement* is hand-set,
 * because two of the components (the board and the die sitting on it) are 27
 * normalised units apart, and no automatic layout resolves that into something
 * a person would draw. Six entries by hand beats a layout solver that is wrong
 * in a way nobody notices.
 */
export interface LabelPlacement {
  side: "left" | "right";
  /** Vertical offset from the anchor, in normalised units. */
  dy: number;
}

export const LABEL_LAYOUT: Record<string, LabelPlacement> = {
  mics: { side: "right", dy: -0.19 },
  chip: { side: "right", dy: -0.03 },
  sensor: { side: "right", dy: 0.15 },
  pcb: { side: "left", dy: -0.2 },
  driver: { side: "left", dy: 0.0 },
  battery: { side: "left", dy: 0.19 },
};

/** How close the scanner has to be, in normalised units, to lock on. */
export const LOCK_RADIUS = 0.085;
