"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";
import { readEnvironment } from "@/lib/motion";
import { useClientValue } from "@/lib/useClientValue";

/**
 * Client wrapper so the acoustics section can be code-split.
 *
 * `ssr: false` is only legal inside a Client Component, so the dynamic import
 * cannot live in the page. Worth the split twice over here: the section pulls
 * in the demo voices, an analyser-driven meter and a pinned scrollytelling
 * frame, and none of it is needed to paint the hero — nor by a visitor who
 * never scrolls this far, which on a page this tall is most of them.
 *
 * The placeholder height is computed here rather than imported from the section
 * for the same reason: a static import of anything in that module would pull it
 * back into the eager chunk and undo the split. It also cannot be a single
 * literal, because the section is 380svh pinned and 100svh flat, and a
 * placeholder that disagrees with what replaces it is the layout shift
 * `LazySection` exists to prevent.
 *
 * There is deliberately no `SectionHandoff` here any more. It made sense while
 * this was an ordinary section arriving in flow; now the pin *is* the entrance,
 * and blurring a frame whose whole job is to hold still would be the effect
 * fighting itself. The configurator above still dissolves out on the way past,
 * so the boundary keeps its hand-off.
 */
const AcousticsSection = dynamic(
  () => import("./AcousticsSection").then((m) => m.AcousticsSection),
  { ssr: false },
);

export function AcousticsSectionLazy() {
  const minHeight = useClientValue(() => {
    const { reducedMotion, tier } = readEnvironment();
    return !reducedMotion && tier === "desktop" ? "520svh" : "100svh";
  }, "100svh");

  return (
    <LazySection id="acoustics" minHeight={minHeight}>
      <AcousticsSection />
    </LazySection>
  );
}
