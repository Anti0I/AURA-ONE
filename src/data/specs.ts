/**
 * Product specification. Fictional hardware, plausible numbers — every figure
 * is internally consistent with the others (the battery curve in the bento
 * grid is integrated from `power`, not made up separately).
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
  /** Shown in the scrollytelling close-up on the silicon. */
  featured?: boolean;
}

export const SPECS: readonly SpecRow[] = [
  { label: "Neural core", value: "AURA N1", featured: true },
  { label: "Clock", value: "2.4", unit: "GHz", featured: true },
  { label: "Inference", value: "18", unit: "TOPS", featured: true },
  { label: "On-die memory", value: "48", unit: "MB SRAM" },
  { label: "Round-trip latency", value: "4.2", unit: "ms", featured: true },
  { label: "Radio", value: "BLE 5.4 + UWB" },
  { label: "Transfer", value: "2.1", unit: "Mbps" },
  { label: "Microphones", value: "4", unit: "× MEMS" },
  { label: "Driver", value: "10", unit: "mm planar" },
  { label: "Frequency response", value: "5 Hz – 40 kHz" },
  { label: "Battery", value: "78", unit: "mAh Li-Si" },
  { label: "Mass", value: "12", unit: "g", featured: true },
  { label: "Ingress rating", value: "IP57" },
] as const;

/**
 * Power draw per operating mode, in milliwatts. The battery tile integrates
 * these against `batteryMilliampHours` to produce its curve.
 */
export const POWER_MODES = [
  { id: "idle", label: "Standby", mw: 8 },
  { id: "playback", label: "Playback", mw: 42 },
  { id: "anc", label: "Adaptive ANC", mw: 71 },
  { id: "inference", label: "On-device inference", mw: 128 },
] as const;

export type PowerModeId = (typeof POWER_MODES)[number]["id"];

export const BATTERY = {
  milliampHours: 78,
  nominalVolts: 3.85,
  get milliwattHours() {
    return this.milliampHours * this.nominalVolts;
  },
} as const;
