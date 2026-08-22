import { test, expect, type Page } from "@playwright/test";

/**
 * The acoustics section, the only part of this site whose claim is made in
 * sound, and the second pinned section on the page.
 *
 * Three things are worth pinning down and none is visible in the DOM. That
 * pressing play actually builds and runs an audio graph — the section's whole
 * argument is that the demonstrations are synthesised rather than loaded, and a
 * silent button would make the page a liar. That nothing starts on its own,
 * which is a promise to the visitor and not merely a browser policy being
 * enforced on us. And that the pin lets go: a section holding 380svh of scroll
 * that never releases it has taken the page hostage, which is the one failure
 * here that would be worse than the feature is good.
 *
 * Headless Chromium has no audio hardware and renders to a null sink, so "did
 * it make a noise" cannot be asked directly. It can be asked one node earlier:
 * the meter is drawn from an `AnalyserNode` tapped off the demo bus, so tall
 * bars are proof that a signal reached it. Reading the canvas rather than
 * adding a test-only probe also keeps this honest — it measures the thing a
 * visitor actually sees, and puts nothing extra in the production bundle.
 */

const BEATS = [
  "One moving surface.",
  "The room, subtracted.",
  "Sound keeps its address.",
] as const;

/** The middle of beat `i`'s own window, as a fraction of the section's span. */
const settledAt = (i: number) => 0.14 + i * 0.28;

/**
 * Tallest bar in the meter, as a fraction of the canvas height.
 *
 * Discriminated by *height*, not width. The reference grid behind the bars is
 * drawn in the same dim colour and spans the full width, so a filter on run
 * length reads the topmost grid line as a permanent 75% signal — which is
 * exactly what the first version of this did. A bar is at least three pixels
 * tall; a grid line is one.
 */
function meterPeak(page: Page) {
  return page.evaluate(() => {
    const canvas =
      document.querySelector<HTMLCanvasElement>("#acoustics canvas");
    if (!canvas?.width) return 0;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);
    const ink = (x: number, y: number) => data[(y * width + x) * 4 + 3]! > 8;

    for (let y = 0; y < height - 2; y++) {
      for (let x = 0; x < width; x++) {
        if (ink(x, y) && ink(x, y + 1) && ink(x, y + 2)) {
          return (height - y) / height;
        }
      }
    }
    return 0;
  });
}

/** Scrolls until the section exists, then reports its box and which layout won. */
async function reachAcoustics(page: Page) {
  await expect(page.getByRole("status").first()).toBeHidden({
    timeout: 40_000,
  });

  // Driven by the wheel and polled, not by `scrollBy` for a fixed count.
  // Lenis owns the scroll position and pulls a programmatic jump back towards
  // its own target, so a loop of jumps covers an unpredictable distance — and
  // this page is now over a thousand viewport heights tall, most of it two
  // pinned sections, with the target mounting lazily somewhere near the end.
  // Under a parallel run that combination timed out.
  for (let i = 0; i < 120; i++) {
    if (await page.locator("#acoustics-heading").count()) break;
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(90);
  }
  await page.waitForSelector("#acoustics-heading", { timeout: 30_000 });

  return page.evaluate(() => {
    const el = document.getElementById("acoustics")!;
    return {
      top: el.getBoundingClientRect().top + window.scrollY,
      span: el.offsetHeight - window.innerHeight,
      // By the rail, which only the pinned layout renders. Section height
      // looked like the obvious test and is not: the flat layout stacks its
      // three cards and its sidebar into a column that clears two viewport
      // heights on a phone, so it reported itself as pinned.
      pinned:
        el.querySelector('[aria-label="Acoustics demonstrations"]') !== null,
    };
  });
}

/**
 * Parks the scroll a fraction of the way through the section.
 *
 * Converges rather than aiming once. Lenis has a long flat tail, so a single
 * impulse overshoots — and an overshoot here silently measures the wrong beat.
 */
async function scrollWithin(page: Page, top: number, span: number, at: number) {
  const target = Math.round(top + span * at);
  for (let pass = 0; pass < 18; pass++) {
    const distance = await page.evaluate((t) => t - window.scrollY, target);
    if (Math.abs(distance) < 10) break;
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, distance * 0.7)));
    await page.waitForTimeout(170);
  }
  await page.waitForTimeout(450);
}

/** Titles of the beats currently rendered, in document order. */
function visibleBeats(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("#acoustics article")]
      .filter((el) => getComputedStyle(el).visibility === "visible")
      .map((el) => el.querySelector("h3")?.textContent?.trim() ?? ""),
  );
}

test("nothing plays, and no audio graph exists, until it is asked for", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Counted from before any of the page's own script runs. "The browser blocked
  // us" and "we never tried" look identical from the outside, and only the
  // second one is the promise this site makes.
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

  await expect(page.getByText("Nothing playing.")).toBeVisible();

  const created = await page.evaluate(
    () => (window as unknown as { __contexts: number }).__contexts,
  );
  expect(created, "an AudioContext existed before anyone asked for sound").toBe(
    0,
  );

  // The resting meter is a row of floor-height bars over a reference grid, not
  // an empty rectangle and not a live signal.
  const peak = await meterPeak(page);
  expect(peak).toBeGreaterThan(0);
  expect(peak, "the meter is showing signal with nothing playing").toBeLessThan(
    0.2,
  );
});

test("each demonstration builds a running audio graph", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const box = await reachAcoustics(page);

  for (let i = 0; i < BEATS.length; i++) {
    const name = BEATS[i]!;

    // In the pinned layout only the beat on screen carries a button, so each
    // demo has to be scrolled to before it can be played. In the flat layout
    // all three are present at once and this simply lands on the right one.
    if (box.pinned) await scrollWithin(page, box.top, box.span, settledAt(i));

    await page.getByRole("button", { name: `Play — ${name}` }).click();
    await expect(page.getByText(`Playing: ${name}`)).toBeVisible();

    // The meter has to be on screen to be drawn at all — it runs through
    // `onFrameWhileVisible`, and in the flat layout it sits below the three
    // cards. In the pinned frame it is always in view and this is a no-op.
    await page.locator("#acoustics canvas").scrollIntoViewIfNeeded();

    // Polled rather than slept on: the envelopes ramp in over a few hundred
    // milliseconds and the analyser smooths on top of that, so the first sample
    // after the click is legitimately silent.
    let peak = 0;
    for (let attempt = 0; attempt < 45; attempt++) {
      await page.waitForTimeout(100);
      peak = Math.max(peak, await meterPeak(page));
      if (peak > 0.3) break;
    }
    expect(peak, `${name} reached the analyser with no signal`).toBeGreaterThan(
      0.3,
    );

    // The same control, which is now labelled Stop. There is exactly one
    // button per demonstration in both layouts.
    await page.getByRole("button", { name: `Stop — ${name}` }).click();
    await expect(page.getByText("Nothing playing.")).toBeVisible();
  }
});

test("the pinned section pages through one beat at a time", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const box = await reachAcoustics(page);
  test.skip(!box.pinned, "flat layout — every beat is on screen at once");

  // The middle of each beat's own window, where exactly one has settled. The
  // boundaries between them are deliberately not sampled: two beats crossing is
  // the transition working, not a fault.
  for (let i = 0; i < BEATS.length; i++) {
    await scrollWithin(page, box.top, box.span, settledAt(i));
    expect(await visibleBeats(page), `at beat ${i + 1}`).toEqual([BEATS[i]]);
  }

  // Walking back up has to work too. A wipe driven from scroll position rather
  // than from events is reversible for free — which is the argument for driving
  // it that way, so it is worth checking that it actually is.
  for (let i = BEATS.length - 2; i >= 0; i--) {
    await scrollWithin(page, box.top, box.span, settledAt(i));
    expect(await visibleBeats(page), `back at beat ${i + 1}`).toEqual([
      BEATS[i],
    ]);
  }
});

test("the section lets go of the scroll at the end", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const box = await reachAcoustics(page);
  test.skip(!box.pinned, "flat layout — nothing is pinned");

  await scrollWithin(page, box.top, box.span, 0.1);
  await expect(page.getByRole("contentinfo")).not.toBeInViewport();

  // Driven by the wheel, in notches, because that is the gesture that found the
  // last scroll bug on this page. A pinned section that never releases looks
  // exactly like a page that has stopped scrolling.
  let reached = false;
  for (let i = 0; i < 240; i++) {
    await page.mouse.wheel(0, 180);
    await page.waitForTimeout(45);
    const done = await page.evaluate(
      () =>
        window.scrollY >=
        document.documentElement.scrollHeight - window.innerHeight - 4,
    );
    if (done) {
      reached = true;
      break;
    }
  }

  expect(reached, "the wheel never got past the pinned section").toBe(true);
  await expect(page.getByRole("contentinfo")).toBeInViewport();
});
