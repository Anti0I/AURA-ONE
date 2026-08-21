import { test, expect, type Page } from "@playwright/test";

/**
 * The configurator's claim is that four finishes come out of one grey render.
 * These tests check the claim rather than the markup: they read pixels off the
 * canvas and assert the finish actually changed — and, for the finish that
 * exposed the bug, that it is genuinely darker rather than merely differently
 * tinted.
 */

async function openConfigurator(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // Lazy sections mount on approach; walk down rather than jumping.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() =>
      window.scrollBy({ top: window.innerHeight * 2, behavior: "instant" }),
    );
    await page.waitForTimeout(250);
  }
  await page.waitForSelector("#configurator [data-product-stage]", {
    timeout: 30_000,
  });
  // Wait for the first frame to actually decode and draw, rather than for a
  // fixed number of milliseconds. Under a parallel test run the decode can take
  // several times longer than it does on an idle machine, and a sleep tuned to
  // the idle case is a test that passes alone and fails in CI.
  await waitFor(page, (v) => v !== null);
}

/** Polls `meanLuminance` until `predicate` holds, or gives up. */
async function waitFor(
  page: Page,
  predicate: (value: number | null) => boolean,
  attempts = 60,
) {
  for (let i = 0; i < attempts; i++) {
    const value = await meanLuminance(page);
    if (predicate(value)) return value;
    await page.waitForTimeout(120);
  }
  return meanLuminance(page);
}

/** Mean luminance of the drawn pixels, ignoring the transparent background. */
async function meanLuminance(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "#configurator [data-product-stage]",
    );
    if (!canvas?.width) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      if (data[i + 3]! < 200) continue;
      sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      count++;
    }
    return count > 40 ? sum / count : null;
  });
}

test("the finish changes what is drawn", async ({ page }) => {
  await openConfigurator(page);

  const before = await meanLuminance(page);

  await page.getByRole("button", { name: /Signal White/ }).click();
  const pale = await waitFor(page, (v) => v !== null && v !== before);

  await page.getByRole("button", { name: /Matte Obsidian/ }).click();
  const dark = await waitFor(page, (v) => v !== null && v !== pale);

  expect(pale, "no drawn pixels sampled").not.toBeNull();
  expect(dark).not.toBeNull();

  // The regression this guards: `globalCompositeOperation: "color"` takes
  // luminosity from the backdrop, so a near-black tint on its own produces
  // bright chrome with an invisible hue shift. Obsidian must be *darker*, not
  // just different.
  expect(dark!).toBeLessThan(pale! * 0.72);
});

test("the spin can be dragged", async ({ page }) => {
  await openConfigurator(page);

  const frame = page.locator("#configurator [data-product-stage]");
  const box = await frame.boundingBox();
  if (!box) throw new Error("configurator has no box");

  const before = await meanLuminance(page);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, {
    steps: 20,
  });
  await page.mouse.up();

  expect(await waitFor(page, (v) => v !== null && v !== before)).not.toBe(
    before,
  );
});

test("the data sheet is generated in the browser", async ({ page }) => {
  await openConfigurator(page);

  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: /Download .* PDF/ }).click();
  const file = await download;

  // Named after the selected finish, so two downloads are distinguishable.
  expect(file.suggestedFilename()).toMatch(/^aura-one-ao-0\d\.pdf$/);
});

test("the battery tile recomputes from the power model", async ({ page }) => {
  await openConfigurator(page);

  const tile = page.locator("section", { hasText: "Inference share" }).last();
  const slider = tile.getByRole("slider");

  const before = await tile.textContent();
  await slider.fill("90");
  await page.waitForTimeout(300);
  const after = await tile.textContent();

  expect(after).not.toBe(before);
  // More inference means less runtime, always.
  const hours = (text: string | null) =>
    Number(text?.match(/([\d.]+)\s*hours/)?.[1] ?? NaN);
  expect(hours(after)).toBeLessThan(hours(before));
});
