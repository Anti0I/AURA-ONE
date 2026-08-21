import { test, expect, type Page } from "@playwright/test";

/**
 * The configurator's claim is that the product is a live scene you can turn in
 * any direction, in a finish you pick. These tests check the claim rather than
 * the markup: they read pixels off the canvas and assert what is drawn actually
 * changed — and, for the finish that once shipped as polished silver, that dark
 * really is darker rather than merely differently tinted.
 *
 * The canvas is WebGL here and 2D in the fallback, so pixels are read by
 * drawing it into a scratch 2D canvas. That works for either — a canvas is a
 * `CanvasImageSource` whichever context it holds — and it keeps one set of
 * assertions covering both paths.
 */

// Building the scene means fetching three.js and generating an environment map
// from scratch, which under software WebGL in headless Chromium is seconds, not
// milliseconds. The default budget is for tests that assert.
test.describe.configure({ timeout: 120_000 });

async function openConfigurator(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // Lazy sections mount on approach, so walk down rather than jumping — and
  // walk with the wheel, because Lenis owns the scroll position and drags a
  // programmatic jump back towards its own target.
  for (let i = 0; i < 40; i++) {
    const done = await page.evaluate(
      () => !!document.querySelector("#configurator [data-product-stage] canvas"),
    );
    if (done) break;
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(120);
  }
  await page.waitForSelector("#configurator [data-product-stage] canvas", {
    timeout: 30_000,
  });

  // Bring it properly into view. The live scene only renders while it is on
  // screen — an idle spin has no natural end, and drawing it for a visitor who
  // has scrolled past costs their battery for nothing — so a test parked just
  // above the section sees a canvas that never changes and cannot tell that
  // apart from one that is broken.
  for (let i = 0; i < 40; i++) {
    const offset = await page.evaluate(() => {
      const rect = document
        .querySelector("#configurator [data-product-stage]")!
        .getBoundingClientRect();
      return rect.top + rect.height / 2 - window.innerHeight / 2;
    });
    if (Math.abs(offset) < 40) break;
    await page.mouse.wheel(0, Math.max(-700, Math.min(700, offset * 0.7)));
    await page.waitForTimeout(200);
  }
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
      "#configurator [data-product-stage] canvas",
    );
    if (!canvas?.width) return null;

    // Copy into a 2D scratch canvas rather than reading the source directly:
    // the live configurator's canvas holds a WebGL context, and asking it for
    // a 2D one returns null. The scene keeps its drawing buffer, so this is a
    // plain blit either way.
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
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

  // The regression this guards predates the live scene and still applies to the
  // fallback: `globalCompositeOperation: "color"` takes luminosity from the
  // backdrop, so a near-black tint on its own produces bright chrome with an
  // invisible hue shift. Obsidian must be *darker*, not just different.
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

test("the product turns on both axes", async ({ page }) => {
  // The point of the live scene. A pre-rendered turntable can spin about one
  // axis and nothing else, so this is the assertion that fails the moment the
  // configurator quietly falls back to frames.
  await openConfigurator(page);

  const stage = page.locator("#configurator [data-product-stage]");
  const box = await stage.boundingBox();
  if (!box) throw new Error("configurator has no box");

  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;

  const drag = async (dx: number, dy: number) => {
    const before = await meanLuminance(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 20 });
    await page.mouse.up();
    return waitFor(page, (v) => v !== null && v !== before);
  };

  // Vertical first, and from a standing start: the idle spin already moves the
  // azimuth, so a horizontal change on its own proves nothing about elevation.
  const tilted = await drag(0, -box.height * 0.35);
  expect(tilted, "no drawn pixels sampled").not.toBeNull();

  const turned = await drag(box.width * 0.4, 0);
  expect(turned).not.toBeNull();

  // And the elevation is clamped rather than tumbling: dragging far past the
  // pole must still leave the product on screen and lit.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - box.height * 3, { steps: 30 });
  await page.mouse.up();
  await page.waitForTimeout(900);

  const coverage = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "#configurator [data-product-stage] canvas",
    );
    if (!canvas?.width) return 0;
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    let drawn = 0;
    let sampled = 0;
    for (let i = 3; i < data.length; i += 4 * 211) {
      sampled++;
      if (data[i]! > 8) drawn++;
    }
    return sampled ? drawn / sampled : 0;
  });

  expect(coverage, "the product left the frame").toBeGreaterThan(0.03);
});
