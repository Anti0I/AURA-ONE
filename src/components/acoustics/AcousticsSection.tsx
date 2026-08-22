"use client";

import { readEnvironment } from "@/lib/motion";
import { useClientValue } from "@/lib/useClientValue";
import { AcousticsFlat } from "./AcousticsFlat";
import { AcousticsPinned } from "./AcousticsPinned";

/**
 * What the product is actually for.
 *
 * The rest of the page is about how the thing is made: the shell, the assembly,
 * the silicon. None of it says what it sounds like, which for a listening
 * device is the only claim that matters — so this section makes the claim in
 * the one medium that can carry it, and does it without shipping a single byte
 * of audio. Everything you hear is generated in `lib/audio/acoustics.ts` from
 * oscillators, filters and a noise buffer.
 *
 * Two layouts, chosen once. On a wide viewport it is a pinned scrollytelling
 * frame that pages through three demonstrations; on a narrow one, and for
 * anyone who has asked for reduced motion, it is an ordinary stacked list.
 * Separate components rather than one with breakpoints, because they are
 * genuinely different documents — one pages through absolutely positioned beats
 * and keeps a single beat in the tab order, the other is a list with all three
 * in it. Everything that is not layout lives in `useAcousticsDemo`.
 */
export function AcousticsSection() {
  const pinned = useClientValue(() => {
    const { reducedMotion, tier } = readEnvironment();
    return !reducedMotion && tier === "desktop";
  }, false);

  return pinned ? <AcousticsPinned /> : <AcousticsFlat />;
}
