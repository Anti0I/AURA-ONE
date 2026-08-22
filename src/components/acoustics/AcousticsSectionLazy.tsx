"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";
import { SectionHandoff } from "@/components/ui/SectionHandoff";

/**
 * Client wrapper so the acoustics section can be code-split.
 *
 * `ssr: false` is only legal inside a Client Component, so the dynamic import
 * cannot live in the page. Worth the split twice over here: the section pulls
 * in the demo voices and an analyser-driven meter, and none of it is needed to
 * paint the hero — nor is any of it needed by a visitor who never scrolls this
 * far, which on a page this tall is most of them.
 */
const AcousticsSection = dynamic(
  () => import("./AcousticsSection").then((m) => m.AcousticsSection),
  { ssr: false },
);

export function AcousticsSectionLazy() {
  return (
    <LazySection id="acoustics" minHeight="100svh">
      <SectionHandoff enter>
        <AcousticsSection />
      </SectionHandoff>
    </LazySection>
  );
}
