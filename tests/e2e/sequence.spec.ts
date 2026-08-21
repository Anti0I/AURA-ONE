import { test, expect, type Page } from "@playwright/test";

/**
 * The walkthrough has two frame sources behind one player: a VP9 stream driven
 * through `VideoDecoder`, and the WebP still sequence for browsers without
 * WebCodecs. Both end up as `ImageBitmap`s in the same cache, so nothing
 * downstream can tell them apart — which is the point, and also why the
 * fallback is exactly the kind of path that rots unnoticed.
 *
 * These tests pin down the two claims that matter: the right source is chosen,
 * and the scrub is actually dense. "Smoother" is not a thing you can assert by
 * looking at the DOM, so it is measured as distinct pictures per unit of
 * scroll.
 */

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 40_000 });
  await page.waitForTimeout(800);
}

/** Cheap perceptual hash of the stage canvas. */
function fingerprint(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas?.width) return "";
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "";
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      hash = (hash * 31 + data[i]! + data[i + 3]!) | 0;
    }
    return String(hash);
  });
}

/**
 * Walks down the stage the way a person reading slowly does — small wheel
 * increments — and counts how many genuinely different pictures appear.
 *
 * Deliberately not `window.scrollTo`. Lenis owns the scroll position and pulls
 * a programmatic jump back towards its own target, so a test that jumps is
 * measuring somewhere other than where it thinks it is. That mistake produced
 * a very convincing screenshot of the wrong frame.
 */
async function distinctFrames(page: Page, steps: number, delta: number) {
  const seen = new Set<string>();
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);

    // Poll until the canvas stops changing rather than sleeping a fixed
    // duration. The claim under test is how densely frames are *spaced*, and a
    // fixed sleep quietly turns it into a measure of how fast this particular
    // machine can decode — which under a parallel run reports the same page as
    // much coarser than it is.
    let previous = "";
    for (let poll = 0; poll < 12; poll++) {
      await page.waitForTimeout(70);
      const current = await fingerprint(page);
      if (current === previous) break;
      previous = current;
    }

    seen.add(previous);
    const past = await page.evaluate(() => {
      const stage = document.getElementById("stage")!;
      return (
        window.scrollY > stage.offsetTop + stage.offsetHeight - window.innerHeight
      );
    });
    if (past) break;
  }
  return seen.size;
}

test("the video source is used where WebCodecs exists", async ({ page }) => {
  await boot(page);

  const hasDecoder = await page.evaluate(() => "VideoDecoder" in window);

  // Read off the canvas, not off the dev-only `window.__player` handle, which
  // production builds strip — and CI runs a production build.
  await expect(page.locator("#stage canvas")).toHaveAttribute(
    "data-source",
    hasDecoder ? "video" : "stills",
  );
});

test("scrubbing produces a distinct picture almost every step", async ({
  page,
}) => {
  // Sixty wheel gestures with a settle after each one; the default budget is
  // for tests that assert, not for tests that walk.
  test.setTimeout(120_000);
  await boot(page);

  // A bounded window rather than the whole section: enough scroll to
  // characterise the density, few enough steps that the test does not become
  // the slowest thing in the suite.
  const count = await distinctFrames(page, 60, 40);

  // Measured at 1512x945: 87 distinct pictures across 88 steps of 40px — very
  // nearly one per step, against 48 for the still fallback over the same walk.
  // The floor sits well below that because decode throughput varies with the
  // machine; the regression this guards is the scrub going coarse, not a few
  // frames lost to a busy CI runner.
  expect(count, "the scrub has gone coarse").toBeGreaterThan(40);
});

test("removing VideoDecoder falls back to the still sequence", async ({
  page,
}) => {
  // The fallback is invisible when it works and invisible when it breaks, so
  // it only stays correct if something exercises it on purpose.
  await page.addInitScript(() => {
    // @ts-expect-error deliberately removing a platform API
    delete window.VideoDecoder;
  });
  await boot(page);

  await expect(page.locator("#stage canvas")).toHaveAttribute(
    "data-source",
    "stills",
  );

  // And it still draws: a fallback that selects itself and then shows nothing
  // is worse than no fallback at all.
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(600);

  const coverage = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas?.width) return 0;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let drawn = 0;
    let sampled = 0;
    for (let i = 3; i < data.length; i += 4 * 211) {
      sampled++;
      if (data[i]! > 8) drawn++;
    }
    return sampled ? drawn / sampled : 0;
  });

  expect(coverage).toBeGreaterThan(0.02);
});
