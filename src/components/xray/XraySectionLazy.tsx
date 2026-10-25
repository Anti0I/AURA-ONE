"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";

/**
 * Client wrapper so the scanner can be code-split.
 *
 * `ssr: false` is only legal inside a Client Component, so the dynamic import
 * cannot live in the page itself. The wrapper is the price of the split, and
 * the split is worth it: the scanner drags in a particle system, the hotspot
 * layout and the audio synth, none of which the hero needs in order to paint.
 */
const MIN_HEIGHT = "90svh";

const XraySection = dynamic(
  () => import("./XraySection").then((m) => m.XraySection),
  // Holds the reservation while the chunk is in flight; see `LazySection`.
  { ssr: false, loading: () => <div style={{ minHeight: MIN_HEIGHT }} /> },
);

export function XraySectionLazy() {
  return (
    <LazySection id="scanner" minHeight={MIN_HEIGHT}>
      <XraySection />
    </LazySection>
  );
}
