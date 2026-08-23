/**
 * Where each beat of the acoustics section lives along the pinned scroll.
 *
 * Pure arithmetic, no DOM and no `"use client"`, so the component, vitest and
 * Playwright's Node side can all import it. That last one is the point: the e2e
 * suite used to carry its own copy of these constants written out by hand, and
 * a copy silently measures the wrong beat the moment the original moves.
 *
 * It also imports nothing — not even `clamp` from utils, which would drag
 * `clsx` and `tailwind-merge` through the path alias into a Playwright config
 * that has no reason to resolve either.
 *
 * ---
 *
 * The one property everything else here exists to guarantee: **no two beats are
 * ever on screen at the same time.** The previous version ran beat N's exit and
 * beat N+1's entrance over the identical window, so roughly 36svh of every
 * transition showed half of one paragraph above half of the next — legible as
 * neither. Scrolling slowly landed in it every time, which is exactly how it
 * was reported.
 *
 * So the windows are disjoint by construction, and the space left between them
 * is not a gap to be minimised. It is a beat of pure travel: the starfield
 * behind runs at its fastest with nothing in front of it, which is what turns
 * three paragraphs into three stations with a flight between them.
 */

const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;

/** Pinned, but the first beat has not arrived yet. */
const RUN_IN = 0.05;

/** Pure travel between two stations. No text, field at full stretch. */
const GAP = 0.07;

/** Share of a station spent arriving, and the same again departing. */
const FADE = 0.2;

/** Below this a beat counts as absent — no tab stop, no compositor layer. */
export const PRESENT = 0.001;

export interface StationPhase {
  /** 0 before the beat arrives, 1 once it has. Linear; ease at the call site. */
  enter: number;
  /** 0 while it holds, 1 once it has gone. Always 0 for the last beat. */
  exit: number;
  /** How much of this beat is on screen: 1 while it holds, 0 outside. */
  presence: number;
  /** Nothing to draw. Distinct from `presence === 0` only in intent. */
  gone: boolean;
}

/** Fraction of the section one beat owns, arrival and departure included. */
export function stationSpan(count: number) {
  return (1 - RUN_IN - GAP * (count - 1)) / count;
}

/** Section progress at which beat `i` starts arriving. */
export function stationStart(i: number, count: number) {
  return RUN_IN + i * (stationSpan(count) + GAP);
}

export function stationPhase(
  p: number,
  i: number,
  count: number,
): StationPhase {
  const span = stationSpan(count);
  // 0 at the moment this beat starts arriving, 1 when it has finished leaving.
  const local = (p - stationStart(i, count)) / span;

  const enter = clamp(local / FADE, 0, 1);
  // The last beat never leaves. The scroll carries it off when the section
  // releases, which is the unlock and needs no animation to announce it —
  // wiping it out first would leave the frame empty for the run-out.
  const exit =
    i === count - 1 ? 0 : clamp((local - (1 - FADE)) / FADE, 0, 1);

  const presence = enter * (1 - exit);
  return { enter, exit, presence, gone: presence <= PRESENT };
}

/**
 * The middle of beat `i`'s readable window.
 *
 * Where the rail's targets point and where the tests park. Not the middle of
 * the *station* — for the last beat the hold runs to the end of the section, so
 * the two differ by half a fade.
 */
export function settledAt(i: number, count: number) {
  const span = stationSpan(count);
  const start = stationStart(i, count);
  const holdFrom = start + span * FADE;
  const holdTo = i === count - 1 ? 1 : start + span * (1 - FADE);
  return (holdFrom + holdTo) / 2;
}

export function railTargets(count: number) {
  return Array.from({ length: count }, (_, i) => settledAt(i, count));
}

/**
 * Which beat the rail should mark as current.
 *
 * Switches at the middle of the flight rather than at a window edge, so the
 * marker moves while you are travelling instead of after you have landed.
 */
export function activeStation(p: number, count: number) {
  const span = stationSpan(count);
  let active = 0;
  for (let i = 0; i < count - 1; i++) {
    if (p >= stationStart(i, count) + span + GAP / 2) active = i + 1;
  }
  return active;
}
