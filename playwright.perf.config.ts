import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * The scrub measurement, run on its own.
 *
 * Everything here is inherited except the two things that decide whether a
 * performance number means anything: what runs, and how much else runs beside
 * it. One worker, because this measures how promptly frames reach a canvas and
 * a second browser decoding VP9 on the same cores changes that answer by a
 * factor of four — measured at a largest-gap of 169 sharing the machine against
 * 24 to 48 alone. A number that moves that much with the neighbours is not a
 * number, and treating it as one is how a suite ends up with a test everybody
 * re-runs until it goes green.
 */
export default defineConfig({
  ...base,
  testMatch: ["perf/**/*.spec.ts"],
  workers: 1,
  fullyParallel: false,
});
