import { test, expect, type Page } from "@playwright/test";
import { ACOUSTICS } from "../../src/data/specs";
import { settledAt } from "../../src/components/acoustics/stations";

/**
 * The acoustics section, the only part of this site whose claim is made in
 * sound, and the second pinned section on the page.
 *
 * Four things are worth pinning down and none is visible in the DOM. That
 * pressing play actually builds and runs an audio graph — the section's whole
 * argument is that the demonstrations are synthesised rather than loaded, and a
 * silent button would make the page a liar. That nothing starts on its own,
 * which is a promise to the visitor and not merely a browser policy being
 * enforced on us. That the starfield behind the beats is genuinely running.
 * And that the pin lets go: a section holding 380svh of scroll that never
 * releases it has taken the page hostage, which is the one failure here that
 * would be worse than the feature is good.
 *
 * The overlap bug this section was rebuilt around — two beats readable at once —
 * is *not* tested here. It is a property of the window arithmetic that holds or
 * fails at every scroll position, and forty browser positions at three seconds
 * each still only samples forty of them. `tests/unit/stations.test.ts` checks a
 * thousand exhaustively in a millisecond. What is worth checking in a real
 * browser is the consequence: that mid-flight the frame is deliberately empty
 * of beats and has not simply broken.
 *
 * Headless Chromium has no audio hardware and renders to a null sink, so "did
 * it make a noise" cannot be asked directly. It can be asked one node earlier:
 * the meter is drawn from an `AnalyserNode` tapped off the demo bus, so tall
 * bars are proof that a signal reached it. Reading the canvas rather than
 * adding a test-only probe also keeps this honest — it measures the thing a
 * visitor actually sees, and puts nothing extra in the production bundle.
 */

const BEATS = ACOUSTICS.map((row) => row.title);

/** Middle of the flight between beat 0 and beat 1. Nothing should be on screen. */
const MID_FLIGHT = 0.355;

/**
 * Tallest bar in the meter, as a fraction of the canvas height.
 *
 * Discriminated by *height*, not width. The reference grid behind the bars is
 * drawn in the same dim colour and spans the full width, so a filter on run
 * length reads the topmost grid line as a permanent 75% signal — which is
 * exactly what the first version of this did.
 *
 * Two consecutive rows, not three. Three was never a property of the meter,
 * only of how tall it happened to be: the resting bar floor is
 * `max(2 * dpr, height * 0.03)`, which at dpr 1 is two device pixels for any
 * meter shorter than 67 CSS pixels. The old 160px panel cleared three by
 * accident and the strip in the pinned frame does not. A grid line is drawn
 * with `fillRect(…, 1)` on an integer row, so it is exactly one pixel and two
 * still tells them apart.
 *
 * `[data-meter]` is not decoration either: the section now has two canvases and
 * the starfield is the first one in document order.
 */
function meterPeak(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "#acoustics canvas[data-meter]",
    );
    if (!canvas?.width) return 0;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);
    const ink = (x: number, y: number) => data[(y * width + x) * 4 + 3]! > 8;

    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        if (ink(x, y) && ink(x, y + 1)) {
          return (height - y) / height;
        }
      }
    }
    return 0;
  });
}

/** Cheap fingerprint of the starfield canvas, for "is it moving" questions. */
function fieldPrint(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "#acoustics canvas:not([data-meter])",
    );
    if (!canvas?.width) return "absent";
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "absent";
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Sampled on a prime stride: a fixed power-of-two stride lands on the same
    // channel of the same pixel column every time and can miss a whole moving
    // field between two samples.
    let hash = 0;
    let ink = 0;
    for (let i = 3; i < data.length; i += 997) {
      hash = (hash * 31 + data[i]!) | 0;
      if (data[i]! > 8) ink++;
    }
    return `${hash}:${ink > 0}`;
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
  // this page is over a thousand viewport heights tall, most of it two pinned
  // sections, with the target mounting lazily somewhere near the end.
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

/**
 * Titles of the beats being presented, in document order.
 *
 * Read off `data-front`, not off `visibility`. Every beat is now in the scene
 * the whole time — parked at its own depth, turning — so "visible" is true of
 * all three at every scroll position and answers a question nobody is asking.
 * What matters is which one has been brought to the front.
 */
function frontBeats(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#acoustics article[data-front="1"]')].map(
      (el) => el.querySelector("h3")?.textContent?.trim() ?? "",
    ),
  );
}

/**
 * How many beats have readable body copy, and how bright the brightest is.
 *
 * The guard on the whole design. Keeping three cards on screen at once is one
 * step away from reinstating the bug this section was rebuilt to remove — two
 * paragraphs competing for the same attention — and the only thing standing
 * between the two is that a parked card fades everything except its number and
 * its title. So that is measured rather than assumed, from the composed opacity
 * a browser actually arrived at.
 */
function readableBodies(page: Page) {
  return page.evaluate(() => {
    const levels = [...document.querySelectorAll("#acoustics article")].map(
      (article) => {
        const body = article.querySelector("p.text-lead");
        if (!body) return 0;
        // Composed, not the element's own: the body sits inside a face that is
        // itself faded, and it is the product that reaches the eye.
        let opacity = 1;
        let node: Element | null = body;
        while (node && node !== document.body) {
          opacity *= Number(getComputedStyle(node).opacity);
          node = node.parentElement;
        }
        return opacity;
      },
    );
    return {
      readable: levels.filter((o) => o > 0.1).length,
      peak: Math.max(...levels),
    };
  });
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
    if (box.pinned) {
      await scrollWithin(
        page,
        box.top,
        box.span,
        settledAt(i, BEATS.length),
      );
    }

    await page.getByRole("button", { name: `Play — ${name}` }).click();
    await expect(page.getByText(`Playing: ${name}`)).toBeVisible();

    // The meter has to be on screen to be drawn at all — it runs through
    // `onFrameWhileVisible`, and in the flat layout it sits below the three
    // cards. In the pinned frame it is always in view and this is a no-op.
    await page.locator("#acoustics canvas[data-meter]").scrollIntoViewIfNeeded();

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

  for (let i = 0; i < BEATS.length; i++) {
    await scrollWithin(page, box.top, box.span, settledAt(i, BEATS.length));
    expect(await frontBeats(page), `at beat ${i + 1}`).toEqual([BEATS[i]]);
  }

  // Walking back up has to work too. A transition driven from scroll position
  // rather than from events is reversible for free — which is the argument for
  // driving it that way, so it is worth checking that it actually is.
  for (let i = BEATS.length - 2; i >= 0; i--) {
    await scrollWithin(page, box.top, box.span, settledAt(i, BEATS.length));
    expect(await frontBeats(page), `back at beat ${i + 1}`).toEqual([BEATS[i]]);
  }
});

test("no beat is on the front mid-flight, and the frame is still furnished", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const box = await reachAcoustics(page);
  test.skip(!box.pinned, "flat layout — nothing travels");

  await scrollWithin(page, box.top, box.span, MID_FLIGHT);

  // Not "the stage is empty" — the three cards are parked in it, turning, and
  // that is the design. Nothing is being *presented*.
  expect(
    await frontBeats(page),
    "a beat was still on the front mid-flight",
  ).toEqual([]);

  // And the difference between "travelling" and "broken": the section keeps
  // its header, its meter and its rail the whole way across.
  await expect(page.locator("#acoustics-heading")).toBeVisible();
  await expect(page.getByText("Nothing playing.")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Acoustics demonstrations" }),
  ).toBeVisible();
});

test("only one beat is ever readable, however slowly you scroll", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/");
  const box = await reachAcoustics(page);
  test.skip(!box.pinned, "flat layout — every beat is on screen by design");

  // The invariant that survived the rebuild into a 3D scene. Sampled across
  // the whole section rather than at the settled points, because the failure
  // this guards against lives between them: it is what "the text goes weird"
  // meant, and it was two paragraphs at once.
  //
  // Coarser than the unit test on purpose. `stations.ts` proves the window
  // arithmetic exhaustively in a millisecond; what a browser adds is whether
  // the *fades* actually follow it, and that needs far fewer samples.
  for (let step = 0; step <= 14; step++) {
    const at = step / 14;
    await scrollWithin(page, box.top, box.span, at);
    const { readable, peak } = await readableBodies(page);
    expect(
      readable,
      `${readable} beats were readable at p=${at.toFixed(2)}`,
    ).toBeLessThanOrEqual(1);
    // And a parked card is genuinely faded, not merely losing on z-order.
    if (readable === 0) expect(peak).toBeLessThan(0.1);
  }
});

test("the starfield is running, and stops for reduced motion", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const box = await reachAcoustics(page);
  // The flat layout gets the field as a still image by design, so "is it
  // moving" is the wrong question there. It has its own test below.
  test.skip(!box.pinned, "flat layout — the field is deliberately still");
  await scrollWithin(page, box.top, box.span, MID_FLIGHT);

  const first = await fieldPrint(page);
  expect(first, "there is no starfield canvas").not.toBe("absent");
  expect(first.endsWith("true"), "the starfield drew nothing at all").toBe(true);

  // Sampled with the page parked. The field cruises whether or not anyone is
  // scrolling — a background that only exists during a gesture reads as a
  // glitch — so this needs no wheel input to be a fair question.
  await page.waitForTimeout(300);
  expect(await fieldPrint(page), "the starfield is frozen").not.toBe(first);
});

test("reduced motion gets a still starfield", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  await reachAcoustics(page);
  await page.locator("#acoustics canvas:not([data-meter])").scrollIntoViewIfNeeded();

  const first = await fieldPrint(page);
  expect(first).not.toBe("absent");
  await page.waitForTimeout(400);
  expect(
    await fieldPrint(page),
    "the starfield animated for somebody who asked it not to",
  ).toBe(first);

  await context.close();
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
