import { test, expect, type Page } from "@playwright/test";

/**
 * Frame continuity under a fast scrub.
 *
 * The complement to `sequence.spec.ts`, which counts distinct pictures per unit
 * of scroll while reading slowly. This one asks the opposite question: when
 * somebody flicks the wheel and the playhead crosses a hundred frames in a
 * second, does the picture keep up, or does it stall and then jump?
 *
 * "It skips about twenty frames" is not something the DOM can answer, so the
 * player counts it: `frameGapMax` is the largest jump between two
 * consecutively displayed pictures, and `decodeWaste` is how many frames
 * arrived after the playhead had already passed them. Both are published on
 * `window.__telemetry` under `?debug=1` — production strips `window.__player`,
 * and CI builds production.
 */

interface Stats {
  frameGapMax: number;
  frameGapSum: number;
  framesDrawn: number;
  decodeWaste: number;
  frame: number;
  source: string;
}

async function boot(page: Page) {
  await page.goto("/?debug=1");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 40_000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    (window as unknown as { __resetFrameStats?: () => void }).__resetFrameStats?.();
  });
}

function read(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    const t = (window as unknown as { __telemetry?: Record<string, number> })
      .__telemetry;
    const canvas = document.querySelector("canvas");
    return {
      frameGapMax: t?.frameGapMax ?? -1,
      frameGapSum: t?.frameGapSum ?? -1,
      framesDrawn: t?.framesDrawn ?? -1,
      decodeWaste: t?.decodeWaste ?? -1,
      frame: t?.frame ?? -1,
      source: canvas?.dataset.source ?? "none",
    };
  });
}

/**
 * A flick, not a walk.
 *
 * Impulses go in back to back with no wait between them, which is what a real
 * wheel flick looks like and what a `waitForTimeout` between notches quietly
 * turns into a slow scroll — measuring the case that already worked.
 */
async function flick(page: Page, notches: number, delta: number) {
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, delta);
}

/** Waits until the canvas stops changing rather than sleeping a fixed time. */
async function settle(page: Page) {
  let previous = -1;
  for (let poll = 0; poll < 25; poll++) {
    await page.waitForTimeout(120);
    const { frame } = await read(page);
    if (frame === previous) return;
    previous = frame;
  }
}

test.describe("scrub continuity", () => {
  test.setTimeout(120_000);

  test("a fast flick through the stage does not drop the picture in lumps", async ({
    page,
  }) => {
    await boot(page);

    // Three flicks with a settle between them, so the measurement covers the
    // whole timeline rather than one burst. Each one crosses well over a
    // hundred frames at 14 px per frame.
    for (let pass = 0; pass < 3; pass++) {
      await flick(page, 8, 260);
      await settle(page);
    }

    const stats = await read(page);
    console.log(
      `[perf] source=${stats.source} gapMax=${stats.frameGapMax} ` +
        `mean=${(stats.frameGapSum / Math.max(1, stats.framesDrawn)).toFixed(2)} ` +
        `drawn=${stats.framesDrawn} waste=${stats.decodeWaste}`,
    );

    expect(stats.framesDrawn, "the stage drew something").toBeGreaterThan(20);

    // The budget. At 240 frames a gap of 8 is a third of a second of rotation
    // arriving at once, which is the point at which it stops reading as motion
    // and starts reading as a stutter.
    expect(
      stats.frameGapMax,
      "largest jump between two consecutively displayed pictures",
    ).toBeLessThanOrEqual(8);
  });

  test("the decoder does not spend its time on frames the playhead has passed", async ({
    page,
  }) => {
    await boot(page);

    for (let pass = 0; pass < 3; pass++) {
      await flick(page, 8, 260);
      await settle(page);
    }

    const stats = await read(page);
    console.log(
      `[perf] waste=${stats.decodeWaste} of ${stats.framesDrawn} drawn`,
    );

    // Some waste is unavoidable: a frame in flight when the playhead moves on
    // is already paid for. A scheduler working against the scroll is different
    // in kind, and shows up as waste outrunning what was actually shown.
    expect(
      stats.decodeWaste,
      "frames decoded after the playhead had already left them",
    ).toBeLessThan(Math.max(24, stats.framesDrawn));
  });
});
