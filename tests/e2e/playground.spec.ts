import { test, expect, type Page } from "@playwright/test";

/**
 * The playground's contract is the part protocol: a prompt produces streamed
 * text *and* the widgets the answer calls for. These tests assert on the
 * widgets, because a response that renders only prose means the generative-UI
 * path silently fell back to text.
 */

async function openPlayground(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
  );
  await page.waitForSelector("#playground textarea", { timeout: 20_000 });
  await page
    .locator("#playground")
    .scrollIntoViewIfNeeded()
    .catch(() => {});
}

test("a preset streams text and renders its widgets", async ({ page }) => {
  await openPlayground(page);

  await page.getByRole("button", { name: "Analyse ambient sound" }).click();

  const log = page.getByRole("log");
  await expect(log).toContainText("Sampling", { timeout: 20_000 });

  // A tool call, a waveform and a telemetry grid — this scenario emits all
  // three, and any of them missing means the renderer dropped a part type.
  await expect(log.getByText("beamform_scan")).toBeVisible({ timeout: 20_000 });
  await expect(log.locator("canvas")).toHaveCount(1, { timeout: 20_000 });
  await expect(log.getByText("Field SNR")).toBeVisible({ timeout: 30_000 });

  // Usage is reported from real measurements taken during the stream.
  await expect(log).toContainText("ms to first token", { timeout: 30_000 });
});

test("routing picks the scenario the prompt is about", async ({ page }) => {
  await openPlayground(page);

  await page.locator("#playground textarea").fill("how long does the battery last");
  await page.getByRole("button", { name: "Send" }).click();

  const log = page.getByRole("log");
  await expect(log.getByText("simulate_duty_cycle")).toBeVisible({
    timeout: 20_000,
  });
  await expect(log.getByText("Mixed duty cycle")).toBeVisible({
    timeout: 30_000,
  });
});

test("an unmatched prompt says so rather than improvising", async ({ page }) => {
  await openPlayground(page);

  await page.locator("#playground textarea").fill("what is the capital of France");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("log")).toContainText("outside the scripted set", {
    timeout: 20_000,
  });
});

test("a stream can be stopped mid-flight", async ({ page }) => {
  await openPlayground(page);

  await page.getByRole("button", { name: "Summarise my day" }).click();

  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await stop.click();

  await expect(page.getByRole("log")).toContainText("stopped", {
    timeout: 15_000,
  });
  // And the composer comes back, rather than being left disabled.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("the engine switch reports WebGPU availability honestly", async ({
  page,
}) => {
  await openPlayground(page);

  const engine = page.getByRole("button", { name: /On-device model/ });
  await expect(engine).toBeVisible();

  const supported = await page.evaluate(() => "gpu" in navigator);
  if (supported) {
    await expect(engine).toContainText(/118 MB|resident|downloading|MB/);
  } else {
    await expect(engine).toContainText("WebGPU unavailable here");
    await expect(engine).toBeDisabled();
  }
});
