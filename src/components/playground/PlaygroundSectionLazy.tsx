"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";

/**
 * Code-split wrapper. The playground carries both engines' plumbing, the part
 * renderers and the microphone hook — none of which belongs in the bytes that
 * decide how fast the hero paints.
 */
const PlaygroundSection = dynamic(
  () => import("./PlaygroundSection").then((m) => m.PlaygroundSection),
  { ssr: false },
);

export function PlaygroundSectionLazy() {
  return (
    <LazySection id="playground" minHeight="90svh">
      <PlaygroundSection />
    </LazySection>
  );
}
