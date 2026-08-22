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

/**
 * The acoustics section, and only what it renders.
 *
 * Same discipline as `SPECS` above: these exist because something puts them on
 * screen. Two of the three are descriptions of what the synthesised demo
 * actually does rather than claims about hardware — the sweep really does run
 * 38 Hz to 16 kHz, and the suppression really is a low-pass collapsing to
 * 190 Hz — which is the only kind of number on this page that can be checked
 * by listening to it.
 */
export interface AcousticRow {
  id: "sweep" | "cancel" | "space";
  eyebrow: string;
  title: string;
  body: string;
  /** What the demonstration measurably does, shown beside the control. */
  detail: string;
  /**
   * The Web Audio graph the demo actually builds, node by node.
   *
   * On screen because it is the honest version of the claim: the section says
   * the sound is synthesised, and this is the synthesis. It is also the one
   * spec on this page a reader can check against the source without taking
   * anyone's word for it — `lib/audio/acoustics.ts` builds exactly this.
   */
  chain: readonly string[];
}

export const ACOUSTICS: readonly AcousticRow[] = [
  {
    id: "sweep",
    eyebrow: "01 // Driver",
    title: "One moving surface.",
    body: "A planar magnetic diaphragm 9.2 mm across, driven over its whole area instead of pushed from the middle. A dome cone breaks up at the edges as it goes; a flat sheet under even force does not.",
    detail: "Logarithmic sweep, 38 Hz to 16 kHz",
    chain: ["sine osc", "highshelf −9 dB @ 3.2 kHz", "gain envelope"],
  },
  {
    id: "cancel",
    eyebrow: "02 // Suppression",
    title: "The room, subtracted.",
    body: "Four MEMS microphones sample the outside world and the N1 predicts the next few milliseconds of it. What you hear is not silence — cancellation takes the top and the presence off a rumble and leaves the weight behind.",
    detail: "Low-pass collapsing to 190 Hz, engaged mid-clip",
    chain: ["brown noise buffer", "lowpass 7.2 kHz → 190 Hz", "gain envelope"],
  },
  {
    id: "space",
    eyebrow: "03 // Placement",
    title: "Sound keeps its address.",
    body: "The same four microphones give the model a direction as well as a signal, so a voice from your left stays on your left once the processing has finished with it.",
    detail: "Continuous orbit, 2.7 s per revolution",
    chain: [
      "triangle 320 Hz + sine 963 Hz",
      "lowpass, LFO-modulated",
      "stereo panner, LFO 0.37 Hz",
    ],
  },
] as const;
