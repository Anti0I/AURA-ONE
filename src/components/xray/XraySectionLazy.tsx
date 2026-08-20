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
const XraySection = dynamic(
  () => import("./XraySection").then((m) => m.XraySection),
  { ssr: false },
);

export function XraySectionLazy() {
  return (
    <LazySection minHeight="90svh">
      <XraySection />
    </LazySection>
  );
}
