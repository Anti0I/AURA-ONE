"use client";

import { useEffect } from "react";
import { initScrollEngine, destroyScrollEngine } from "@/lib/scroll/scrollEngine";
import { readEnvironment } from "@/lib/motion";
import { exposeTelemetry } from "@/store/transient";

/**
 * One-time client setup.
 *
 * Renders nothing. It exists so the root layout can stay a server component
 * while still owning the lifetime of the scroll engine — pushing this into a
 * page would tie smooth scrolling to a route.
 */
export function AppBoot() {
  useEffect(() => {
    initScrollEngine();
    exposeTelemetry();

    const env = readEnvironment();
    // Marks the document for CSS and for tests that need to know which tier won.
    document.documentElement.dataset.tier = env.tier;
    document.documentElement.dataset.pointer = env.coarsePointer
      ? "coarse"
      : "fine";

    return () => destroyScrollEngine();
  }, []);

  return null;
}
