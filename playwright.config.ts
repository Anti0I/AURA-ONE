import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // tests/unit belongs to vitest. Without this, a bare `playwright test` picks
  // those files up and fails on the first `vitest` import.
  // `tests/perf` is deliberately absent: it has its own config, because a
  // performance measurement must not share the machine. Run alongside the rest
  // of the suite it reported a largest-gap of 169 where it reports 24 to 48 on
  // its own — which is not a regression, it is another browser decoding video
  // on the same cores, and it looks exactly like one.
  testMatch: ["e2e/**/*.spec.ts", "a11y/**/*.spec.ts"],
  fullyParallel: true,
  // Two, deliberately. Each of these runs a browser decoding a 2896x1440 VP9
  // stream, or rendering a three.js scene through software WebGL, while reading
  // pixels back off a canvas. One worker per core starves all of them, and the
  // symptom is not a clean failure — it is a scrub that looks coarse because
  // frames did not arrive in time, which is indistinguishable from the
  // regression these tests exist to catch.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // CI builds once as its own step, so re-running the build here would
    // double the slowest part of the pipeline for no benefit. Locally, a
    // running `npm run dev` is reused and otherwise a build happens on demand.
    command: process.env.CI ? "npm run start" : "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
