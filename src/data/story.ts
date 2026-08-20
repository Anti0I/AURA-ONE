/**
 * The scrollytelling script.
 *
 * Caption windows are expressed in *sequence* time (0..1 across the 120
 * frames), not in scroll offsets, so re-timing the render does not silently
 * desynchronise the words from the picture. `PHASES` mirrors the boundaries
 * baked into assets-src/device/scene.mjs — if one moves, both move.
 */

export const PHASES = {
  ROTATE_END: 0.3,
  EXPLODE_END: 0.62,
  HOLD_END: 0.7,
  PUSH_END: 0.9,
} as const;

/** Fraction of the section spent holding on the hero before the scrub starts. */
export const HERO_HOLD = 0.13;

export interface StoryBeat {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  /** Sequence time window, inclusive of the fade. */
  from: number;
  to: number;
}

export const STORY: readonly StoryBeat[] = [
  {
    id: "form",
    eyebrow: "01 // Exterior",
    title: "Form follows thought.",
    body: "One piece of 6000-series aluminium, bead-blasted and anodised. No screws on the outside, no seams you can catch a fingernail on — just the parting band where the two halves meet.",
    from: 0.03,
    to: 0.3,
  },
  {
    id: "assembly",
    eyebrow: "02 // Assembly",
    title: "Eleven parts. Twelve grams.",
    body: "A planar driver, a silicon-anode cell, a six-layer rigid-flex board and the quad-mic array, packed into 26 by 18 millimetres with no air left over.",
    from: 0.36,
    to: 0.64,
  },
  {
    id: "core",
    eyebrow: "03 // Silicon",
    title: "The whole model runs here.",
    body: "AURA N1 keeps the entire acoustic model resident in 48 MB of on-die SRAM. Nothing leaves the device, and nothing waits on a network.",
    from: 0.73,
    to: 0.97,
  },
] as const;

/**
 * Opacity for a beat at sequence time `t`.
 *
 * Asymmetric on purpose: text fades in over a longer ramp than it fades out.
 * Matched ramps make captions feel like they are dissolving into each other;
 * a quick exit and a slow entrance reads as one thought replacing another.
 */
export function beatOpacity(t: number, beat: StoryBeat): number {
  const IN = 0.055;
  const OUT = 0.035;
  if (t <= beat.from || t >= beat.to) return 0;
  const rise = Math.min(1, (t - beat.from) / IN);
  const fall = Math.min(1, (beat.to - t) / OUT);
  return Math.min(rise, fall);
}

/** Which beat is closest to centre stage, for the progress rail. */
export function activeBeat(t: number): 0 | 1 | 2 {
  if (t < PHASES.ROTATE_END) return 0;
  if (t < PHASES.HOLD_END) return 1;
  return 2;
}
