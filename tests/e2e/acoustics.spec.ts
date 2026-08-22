import { test, expect, type Page } from "@playwright/test";

/**
 * The acoustics section, the only part of this site whose claim is made in
 * sound.
 *
 * Two things are worth pinning down and neither is visible in the DOM. The
 * first is that pressing play actually builds and runs an audio graph — the
 * section's whole argument is that the demonstrations are synthesised rather
 * than loaded, and a silent button would make the page a liar. The second is
 * that nothing starts on its own, which is a promise to the visitor and not
 * merely a browser policy being enforced on us.
 *
 * Headless Chromium has no audio hardware and renders to a null sink, so "did
 * it make a noise" cannot be asked directly. It can be asked one node earlier:
 * the meter is drawn from an `AnalyserNode` tapped off the demo bus, so tall
 * bars are proof that a signal reached it. Reading the canvas rather than
 * adding a test-only probe also keeps this honest — it measures the thing a
 * visitor actually sees, and it puts nothing extra in the production bundle.
 */

/** Tallest bar in the meter, as a fraction of the canvas height. */
function meterPeak(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#acoustics canvas");
    if (!canvas?.width) return 0;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Topmost row carrying any ink, scanned down from the top.
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3]! > 8) {
          return (canvas.height - y) / canvas.height;
        }
      }
    }
    return 0;
  });
}

async function reachAcoustics(page: Page) {
  await expect(page.getByRole("status").first()).toBeHidden({
    timeout: 40_000,
  });

  // Below three code-split sections, so it does not exist until scrolled to.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() =>
      window.scrollBy({ top: window.innerHeight * 2, behavior: "instant" }),
    );
    await page.waitForTimeout(220);
  }
  await page.waitForSelector("#acoustics-heading", { timeout: 30_000 });

  // The meter specifically, not the section. It is drawn through
  // `onFrameWhileVisible`, so a meter below the fold is correctly not drawn at
  // all — and on the mobile project the layout stacks, which puts it a screen
  // and a half below the section's top edge.
  await page.locator("#acoustics canvas").scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
}

test("nothing plays, and no audio graph exists, until it is asked for", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Counted from before any of the page's own script runs. "The browser
  // blocked us" and "we never tried" look identical from the outside, and only
  // the second one is the promise this site makes.
  await page.addInitScript(() => {
    const w = window as unknown as {
      AudioContext: typeof AudioContext;
      __contexts: number;
    };
    w.__contexts = 0;
    const Real = w.AudioContext;
    w.AudioContext = class extends Real {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        w.__contexts++;
      }
    } as typeof AudioContext;
  });

  await page.goto("/");
  await reachAcoustics(page);

  // The section states its own condition in text, which is also what a screen
  // reader gets — the meter beside it is decoration and marked as such.
  await expect(page.getByText("Nothing playing.")).toBeVisible();

  const created = await page.evaluate(
    () => (window as unknown as { __contexts: number }).__contexts,
  );
  expect(created, "an AudioContext existed before anyone asked for sound").toBe(
    0,
  );

  // The resting meter is a row of floor-height bars, not an empty rectangle
  // and not a live signal.
  const peak = await meterPeak(page);
  expect(peak).toBeGreaterThan(0);
  expect(peak, "the meter is showing signal with nothing playing").toBeLessThan(
    0.2,
  );
});

test("each demonstration builds a running audio graph", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await reachAcoustics(page);

  for (const name of [
    "One moving surface.",
    "The room, subtracted.",
    "Sound keeps its address.",
  ]) {
    await page.getByRole("button", { name: `Play — ${name}` }).click();
    await expect(page.getByText(`Playing: ${name}`)).toBeVisible();

    // Clicking scrolls the button into view, which on the mobile layout pushes
    // the meter back off the bottom of the screen — and a meter off screen is
    // correctly not drawn. Bring it back before reading it.
    await page.locator("#acoustics canvas").scrollIntoViewIfNeeded();

    // Polled rather than slept on: the envelopes ramp in over a few hundred
    // milliseconds and the analyser smooths on top of that, so the first
    // sample after the click is legitimately silent.
    let peak = 0;
    for (let attempt = 0; attempt < 45; attempt++) {
      await page.waitForTimeout(100);
      peak = Math.max(peak, await meterPeak(page));
      if (peak > 0.3) break;
    }
    expect(peak, `${name} reached the analyser with no signal`).toBeGreaterThan(
      0.3,
    );

    await page.getByRole("button", { name: "Stop playback" }).click();
    await expect(page.getByText("Nothing playing.")).toBeVisible();
  }
});
