import { test, expect, type Page } from "@playwright/test";

/**
 * The scrollytelling stage is the one part of this site that cannot be checked
 * by asserting on the DOM: everything that matters happens inside a canvas that
 * React never re-renders. These tests read pixels instead.
 */

/** Fraction of sampled pixels that carry any alpha — i.e. "is anything drawn". */
async function coverage(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas || !canvas.width) return 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let drawn = 0;
    let sampled = 0;
    for (let i = 3; i < data.length; i += 4 * 211) {
      sampled++;
      if (data[i]! > 8) drawn++;
    }
    return drawn / sampled;
  });
}

/** Cheap perceptual hash of the canvas, to prove the frame actually changed. */
async function fingerprint(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas || !canvas.width) return "";
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      hash = (hash * 31 + data[i]! + data[i + 3]!) | 0;
    }
    return String(hash);
  });
}

/** Scrolls to a fraction of the stage section and lets the playhead settle. */
async function scrubTo(page: Page, fraction: number) {
  await page.evaluate((f) => {
    const stage = document.getElementById("stage")!;
    const span = stage.offsetHeight - window.innerHeight;
    window.scrollTo({ top: stage.offsetTop + span * f, behavior: "instant" });
  }, fraction);
  // Lenis is inertial and the playhead is damped; give both time to arrive.
  await page.waitForTimeout(1400);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The preloader holds the page until the opening frames are decoded.
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });
});

test("preloader reports real progress and then releases the page", async ({
  page,
}) => {
  const overflow = await page.evaluate(
    () => document.documentElement.style.overflow,
  );
  expect(overflow).toBe("");

  const { scrollHeight, viewport } = await page.evaluate(() => ({
    scrollHeight: document.body.scrollHeight,
    viewport: window.innerHeight,
  }));
  // The stage alone is 460svh; anything close to one viewport means the
  // sticky section collapsed and there is nothing to scrub.
  expect(scrollHeight).toBeGreaterThan(viewport * 3);
});

test("hero draws the opening frame", async ({ page }) => {
  // The device occupies a meaningful part of the canvas; a blank or
  // nearly-blank canvas is the failure this guards against.
  expect(await coverage(page)).toBeGreaterThan(0.05);
});

test("scrubbing advances the sequence", async ({ page }) => {
  const atHero = await fingerprint(page);

  await scrubTo(page, 0.4);
  const midway = await fingerprint(page);
  expect(midway).not.toBe(atHero);
  expect(await coverage(page)).toBeGreaterThan(0.02);

  await scrubTo(page, 0.85);
  expect(await fingerprint(page)).not.toBe(midway);

  // And back: reversing must not leave the canvas empty, which is what happens
  // when the prefetch window only ever looks forward.
  await scrubTo(page, 0.2);
  expect(await coverage(page)).toBeGreaterThan(0.02);
});

test("captions follow the sequence", async ({ page }) => {
  await scrubTo(page, 0.2);
  await expect(
    page.locator("#stage").getByRole("heading", { name: /Form follows thought/ }),
  ).toBeVisible();

  await scrubTo(page, 0.55);
  await expect(
    page.getByRole("heading", { name: /Eleven parts/ }),
  ).toBeVisible();

  await scrubTo(page, 0.9);
  await expect(
    page.getByRole("heading", { name: /whole model runs here/ }),
  ).toBeVisible();
});

