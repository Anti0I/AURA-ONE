"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";

/** Code-split wrapper: the configurator paints nothing above the fold. */
const ConfiguratorSection = dynamic(
  () => import("./ConfiguratorSection").then((m) => m.ConfiguratorSection),
  { ssr: false },
);

export function ConfiguratorSectionLazy() {
  return (
    <LazySection id="configurator" minHeight="110svh">
      <ConfiguratorSection />
    </LazySection>
  );
}
