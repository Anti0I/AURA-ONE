import { test, expect, type Page } from "@playwright/test";

/**
 * Frame continuity under a fast scrub.
 *
 * The complement to `sequence.spec.ts`, which counts distinct pictures per unit
 * of scroll while reading slowly. This asks the opposite question: when somebody
 * flicks the wheel and the playhead crosses the whole walkthrough in under a
 * second, does the picture follow, or does it stall and then jump?
 *
 * "It skips about twenty frames" is not a claim the DOM can answer, so the
 * player counts it — see `src/store/transient.ts`. The numbers are published on
 * `window.__telemetry` under `?debug=1`, because production strips
 * `window.__player` and CI builds production.
 *
 * The measurement that matters is `frameGapSum / playheadTravel`: of the
 * distance the scroll dragged the playhead, how much did the picture actually
 * cover. It is the only one of these that does not simply get worse on a slower
 * machine — the player samples the timeline against its own measured delivery
 * rate, so a slow machine draws fewer, wider-spaced pictures and still follows
 * the scroll from end to end. On the code this replaced it was 0.10: the canvas
 * moved twenty-four frames while the scroll crossed two hundred and thirty-nine.
 */

interface Stats {
  frameGapMax: number;
  frameGapSum: number;
  playheadTravel: number;
  framesDrawn: number;
  framesDecoded: number;
  decodeWaste: number;
  frame: number;
  source: string;
}

function read(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    const t = (window as unknown as { __telemetry?: Record<string, number> })
      .__telemetry;
    const canvas = document.querySelector("canvas");
    return {
      frameGapMax: t?.frameGapMax ?? -1,
      frameGapSum: t?.frameGapSum ?? -1,
      playheadTravel: t?.playheadTravel ?? -1,
      framesDrawn: t?.framesDrawn ?? -1,
      framesDecoded: t?.framesDecoded ?? -1,
      decodeWaste: t?.decodeWaste ?? -1,
      frame: t?.frame ?? -1,
      source: canvas?.dataset.source ?? "none",
    };
  });
}

/**
 * Waits until both the playhead and the picture have stopped moving.
 *
 * Waiting on the playhead alone is not enough, and the difference is exactly
 * what this test measures: the scroll settles first and the canvas is still
 * catching up behind it. Reading the counters at that moment scores the picture
 * as having covered less of the journey than it eventually does — which under a
 * parallel run is indistinguishable from the regression being tested for.
 */
async function settle(page: Page) {
  let lastFrame = -1;
  let lastDrawn = -1;
  for (let poll = 0; poll < 30; poll++) {
    await page.waitForTimeout(120);
    const { frame, framesDrawn } = await read(page);
    if (frame === lastFrame && framesDrawn === lastDrawn) return;
    lastFrame = frame;
    lastDrawn = framesDrawn;
  }
}

test("a fast flick through the stage keeps the picture with the scroll", async ({
  page,
}) => {
  test.setTimeout(150_000);

  await page.goto("/?debug=1");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    (
      window as unknown as { __resetFrameStats?: () => void }
    ).__resetFrameStats?.();
  });

  // Three flicks with a settle between them. Impulses go in back to back with
  // no wait — that is what a wheel flick is, and a `waitForTimeout` between
  // notches quietly turns this into a slow scroll, measuring the case that
  // already worked.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 260);
    await settle(page);
  }

  const stats = await read(page);
  const followed = stats.frameGapSum / Math.max(1, stats.playheadTravel);
  console.log(
    `[perf] source=${stats.source} followed=${followed.toFixed(2)} ` +
      `travel=${stats.playheadTravel} drawn=${stats.framesDrawn} ` +
      `mean=${(stats.frameGapSum / Math.max(1, stats.framesDrawn)).toFixed(2)} ` +
      `gapMax=${stats.frameGapMax} decoded=${stats.framesDecoded} ` +
      `waste=${stats.decodeWaste}`,
  );

  expect(stats.playheadTravel, "the scroll moved the playhead").toBeGreaterThan(
    100,
  );

  // The claim. Measured at 1.00 on a discrete GPU and on a software
  // rasteriser alike, against 0.10 before — the case this test exists for is a
  // picture that stops following the scroll, and it does not care how fast the
  // machine is.
  expect(
    followed,
    "fraction of the playhead's journey the picture actually covered",
  ).toBeGreaterThan(0.85);

  // Granularity — how finely that journey was drawn — is deliberately logged
  // and not asserted. It is a measurement of how fast the machine is (0.22 on
  // a discrete GPU, 0.12 compositing in software, 0.05 on a runner with five
  // other canvas tests beside it) rather than of whether the player is doing
  // its job, and this repo has already learnt once that starvation is
  // indistinguishable from the regressions these tests exist to catch.

  // Stall detector. A single long gap does not mean the scrub is coarse, it
  // means it stopped: the failure being fixed here produced 128 to 148
  // consistently, and the residual maximum is main-thread jank during the
  // first burst of the flick rather than anything in the decoder.
  expect(
    stats.frameGapMax,
    "largest jump between two consecutively displayed pictures",
  ).toBeLessThanOrEqual(96);

  // Some waste is unavoidable: a frame in flight when the playhead moves on is
  // already paid for. A scheduler working *against* the scroll is different in
  // kind, and shows up as waste outrunning what was actually shown.
  expect(
    stats.decodeWaste,
    "frames decoded after the playhead had already left them",
  ).toBeLessThan(Math.max(24, stats.framesDrawn));
});
