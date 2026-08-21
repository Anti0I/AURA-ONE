/**
 * Product specification. Fictional hardware, plausible numbers.
 *
 * Only the rows something actually renders live here. There used to be a power
 * model underneath this — a battery capacity, per-mode draw figures and a
 * runtime integrator — feeding an interactive tile, a generated PDF and a
 * scripted AI answer. It was internally consistent and it was still invented,
 * and an invented number presented as a measurement is the one thing a
 * portfolio piece cannot afford. What survives is what the walkthrough puts on
 * screen, and nothing else.
 */

export const PRODUCT = {
  name: "AURA ONE",
  tagline: "Zero Latency Intelligence.",
  generation: "Gen 1",
  weightGrams: 12,
} as const;

export interface SpecRow {
  label: string;
  value: string;
  unit?: string;
}

/** Flashed up at the bottom of the dive into the silicon. */
export const SPECS: readonly SpecRow[] = [
  { label: "Neural core", value: "AURA N1" },
  { label: "Clock", value: "2.4", unit: "GHz" },
  { label: "Inference", value: "18", unit: "TOPS" },
  { label: "Round-trip latency", value: "4.2", unit: "ms" },
  { label: "Mass", value: "12", unit: "g" },
] as const;
