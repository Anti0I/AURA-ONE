"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";
import { SectionHandoff } from "@/components/ui/SectionHandoff";

/** Code-split wrapper: the configurator paints nothing above the fold. */
const ConfiguratorSection = dynamic(
  () => import("./ConfiguratorSection").then((m) => m.ConfiguratorSection),
  { ssr: false },
);

export function ConfiguratorSectionLazy() {
  return (
    <LazySection id="configurator" minHeight="110svh">
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
