/**
 * Configurator finishes.
 *
 * The frame sequence is rendered once, in neutral grey. Each finish is applied
 * at draw time as a two-pass canvas composite (see lib/canvas/tint.ts), so
 * adding a colour costs one object here — not 120 more renders.
 */
export const MATERIALS = [
  {
    id: "obsidian",
    name: "Matte Obsidian",
    code: "AO-01",
    /** Target hue applied with `globalCompositeOperation: "color"`. */
    tint: "#16161a",
    /** How much of the original specular detail survives the tint, 0..1. */
    sheen: 0.34,
    /** Exposure nudge so dark finishes do not crush the highlights. */
    exposure: 1.18,
    blurb: "Anodised aluminium, bead-blasted. Absorbs 94% of incident light.",
  },
  {
    id: "titanium",
    name: "Titanium Frost",
    code: "AO-02",
    tint: "#b8bcc4",
    sheen: 0.72,
    exposure: 0.94,
    blurb: "Grade 5 titanium, brushed along the long axis. 11% lighter.",
  },
  {
    id: "amber",
    name: "Cosmic Amber",
    code: "AO-03",
    tint: "#c88a3e",
    sheen: 0.58,
    exposure: 1.02,
    blurb: "PVD-coated, translucent at the sensor window. Limited run.",
  },
  {
    id: "signalwhite",
    name: "Signal White",
    code: "AO-04",
    tint: "#e8e8ec",
    sheen: 0.66,
    exposure: 0.88,
    blurb: "Ceramic composite. Runs 4 °C cooler under sustained inference.",
  },
] as const;

export type Material = (typeof MATERIALS)[number];
export type MaterialId = Material["id"];

const BY_ID = new Map<MaterialId, Material>(MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: MaterialId): Material {
  // MATERIALS is a const tuple keyed by MaterialId, so this cannot miss.
  return BY_ID.get(id) ?? MATERIALS[0];
}
