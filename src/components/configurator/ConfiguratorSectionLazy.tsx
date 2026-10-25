"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";
import { SectionHandoff } from "@/components/ui/SectionHandoff";

const MIN_HEIGHT = "110svh";

/** Code-split wrapper: the configurator paints nothing above the fold. */
const ConfiguratorSection = dynamic(
  () => import("./ConfiguratorSection").then((m) => m.ConfiguratorSection),
  // Holds the reservation while the chunk is in flight; see `LazySection`.
  { ssr: false, loading: () => <div style={{ minHeight: MIN_HEIGHT }} /> },
);

export function ConfiguratorSectionLazy() {
  return (
    <LazySection id="configurator" minHeight={MIN_HEIGHT}>
      {/* Exit only. The configurator softens and recedes as its lower edge
          leaves through the top of the viewport, and the acoustics section
          arrives into the same span — so the boundary is a hand-off rather
          than one panel sliding out from under another. */}
      <SectionHandoff enter={false} exit>
        <ConfiguratorSection />
      </SectionHandoff>
    </LazySection>
  );
}
