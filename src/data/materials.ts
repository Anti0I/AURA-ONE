/**
 * Configurator finishes.
 *
 * The frame sequence is rendered once, in neutral grey. Each finish is applied
 * at draw time as a two-pass canvas composite (see lib/canvas/tint.ts), so
 * adding a colour costs one object here — not 120 more renders.
 */
export const MATERIAL_IDS = [
  "obsidian",
  "titanium",
  "amber",
  "signalwhite",
] as const;

export type MaterialId = (typeof MATERIAL_IDS)[number];

export interface Material {
  id: MaterialId;
  name: string;
  code: string;
  /** Target hue and saturation, applied with `globalCompositeOperation: "color"`. */
  tint: string;
  /** How much specular detail the overlay pass puts back, 0..1. */
  sheen: number;
  /**
   * Brightness multiplier applied *before* the tint.
   *
   * This is load-bearing, and the reason is easy to get wrong: the `color`
   * blend mode takes hue and saturation from the source and **luminosity from
   * the backdrop**. It cannot darken anything. Fill a bright chrome render
   * with near-black and you get bright chrome with an imperceptible hue shift
   * — which is exactly how "Matte Obsidian" first shipped as polished silver.
   *
   * So lightness has to come from somewhere else, and this is it. Values are
   * the OKLab lightness of the tint over the neutral shell's (L = 0.705),
   * pulled a little toward 1 so the speculars survive.
   */
  exposure: number;
  /** Compensates the contrast a large exposure change costs. */
  contrast: number;
  blurb: string;
}

export const MATERIALS: readonly Material[] = [
  {
    id: "obsidian",
    name: "Matte Obsidian",
    code: "AO-01",
    tint: "#16161a",
    sheen: 0.28,
    exposure: 0.42,
    contrast: 1.32,
    blurb: "Anodised aluminium, bead-blasted. Absorbs 94% of incident light.",
  },
  {
    id: "titanium",
    name: "Titanium Frost",
    code: "AO-02",
    tint: "#b8bcc4",
    sheen: 0.74,
    exposure: 1.06,
    contrast: 1.02,
    blurb: "Grade 5 titanium, brushed along the long axis. 11% lighter.",
  },
  {
    id: "amber",
    name: "Cosmic Amber",
    code: "AO-03",
    tint: "#c88a3e",
    sheen: 0.52,
    exposure: 0.86,
    contrast: 1.1,
    blurb: "PVD-coated, translucent at the sensor window. Limited run.",
  },
  {
    id: "signalwhite",
    name: "Signal White",
    code: "AO-04",
    tint: "#e8e8ec",
    sheen: 0.6,
    exposure: 1.2,
    contrast: 0.94,
    blurb: "Ceramic composite. Runs 4 °C cooler under sustained inference.",
  },
];

const BY_ID = new Map<MaterialId, Material>(MATERIALS.map((m) => [m.id, m]));

/** Falls back to the first finish; the list is never empty. */
export const DEFAULT_MATERIAL: Material = MATERIALS[0]!;

export function getMaterial(id: MaterialId): Material {
  return BY_ID.get(id) ?? DEFAULT_MATERIAL;
}
