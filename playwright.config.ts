import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // tests/unit belongs to vitest. Without this, a bare `playwright test` picks
  // those files up and fails on the first `vitest` import.
  testMatch: ["e2e/**/*.spec.ts", "a11y/**/*.spec.ts"],
  fullyParallel: true,
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
