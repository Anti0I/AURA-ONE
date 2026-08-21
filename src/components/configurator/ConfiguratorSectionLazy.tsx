"use client";

import dynamic from "next/dynamic";
import { LazySection } from "@/components/ui/LazySection";

/** Code-split wrapper; pdf-lib in particular has no business in the first load. */
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
