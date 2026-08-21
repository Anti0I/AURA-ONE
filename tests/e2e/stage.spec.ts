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

/**
 * Scrolls to a fraction of the stage and waits for the canvas to settle.
 *
 * Driven by the wheel, not by `window.scrollTo`. Lenis owns the scroll position
 * and pulls a programmatic jump back towards its own target, so a test that
 * jumps ends up measuring somewhere other than where it believes it is — which
 * shows up as two different fractions returning the identical frame, and is
 * indistinguishable from a scrub that has stopped working.
 *
 * Then the wait. Lenis is inertial and the playhead is damped, so the frame
 * keeps changing after the scroll lands. A fixed sleep is the obvious thing and
 * it is flaky: long enough on an idle machine, too short when the suite runs
 * six workers wide. Polling until two consecutive fingerprints match waits
 * exactly as long as it needs to.
 */
async function scrubTo(page: Page, fraction: number) {
  const target = await page.evaluate((f) => {
    const stage = document.getElementById("stage")!;
    const span = stage.offsetHeight - window.innerHeight;
    return stage.offsetTop + span * f;
  }, fraction);

  // Converge rather than aim. Lenis has a long flat tail, so the last wheel
  // impulse keeps carrying after it lands — aiming once overshoots, and the
  // overshoot is silent: the canvas settles on a frame from somewhere else on
  // the timeline and the assertion fails for a reason that looks nothing like
  // the cause. So: push, let the glide finish, measure again, repeat.
  for (let pass = 0; pass < 12; pass++) {
    const distance = await page.evaluate((t) => t - window.scrollY, target);
    if (Math.abs(distance) < 24) break;
    // Undershoot deliberately; the inertia makes up the rest.
    await page.mouse.wheel(0, Math.max(-600, Math.min(600, distance * 0.7)));
    await page.waitForTimeout(260);
  }

  // Two conditions, and the second one matters more than it looks. Waiting only
  // for stability exits immediately: right after the scroll the canvas still
  // holds the previous frame and is, for one poll interval, perfectly stable.
  // So the frame has to change first, and only then settle.
  const before = await fingerprint(page);
  let previous = "";
  let moved = false;

  // Twelve seconds, not five. Under a parallel run the decoder can take that
  // long to deliver the frame the playhead moved to, and giving up early does
  // not fail — it silently reports the frame that was already on screen.
  for (let attempt = 0; attempt < 120; attempt++) {
    await page.waitForTimeout(100);
    const current = await fingerprint(page);
    if (current === "") continue;
    if (current !== before) moved = true;
    if (moved && current === previous) return;
    previous = current;
  }
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
  // Four scrubs, each a wheel journey plus a settle. The default budget is for
  // tests that assert, not for tests that travel.
  test.setTimeout(120_000);

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
  test.setTimeout(120_000);

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

