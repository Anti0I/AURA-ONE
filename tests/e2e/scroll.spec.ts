import { test, expect, type Page } from "@playwright/test";

/**
 * The page has to reach its own footer.
 *
 * That sounds too obvious to test, and it is exactly the thing that broke here.
 * Lenis caches `limit = scrollHeight - innerHeight` and hard-clamps every wheel
 * gesture to it; three sections mount lazily from placeholders shorter than the
 * real thing, so the document grows *after* that measurement is taken. The
 * result was a page that stopped dead partway down under the wheel while the
 * native scrollbar still reached the bottom — because dragging the scrollbar
 * bypasses Lenis entirely.
 *
 * Which is why this drives the page the way a person does. `window.scrollTo`
 * passes against the bug and proves nothing.
 */

/** Waits for the boot overlay to release the page. */
async function boot(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });
}


test("the wheel alone reaches the bottom of the document", async ({ page }) => {
  // This one walks the entire document in 180px notches, which is four hundred
  // round trips to the browser. It takes 24 s on an idle machine against a 30 s
  // default, so under a parallel run it fails on the clock rather than on the
  // claim — and a timeout here reads exactly like the scroll bug it exists to
  // catch.
  test.setTimeout(120_000);
  await boot(page);
  await expect(page.getByRole("contentinfo")).not.toBeInViewport();

  // 180px notches rather than one huge shove. The stale limit is only ~7% of
  // the document, so a coarse gesture can overshoot straight past the evidence
  // — the bug reproduces at a realistic scroll granularity and hides at a
  // synthetic one.
  //
  // The budget is far more notches than the page needs (it takes about 50 when
  // this works). The claim under test is that it never stops short, not that it
  // arrives in some particular number of gestures.
  let last = { y: 0, max: 1 };
  for (let i = 0; i < 400; i++) {
    await page.mouse.wheel(0, 180);
    await page.waitForTimeout(45);
    last = await page.evaluate(() => ({
      y: Math.round(window.scrollY),
      max: Math.round(
        document.documentElement.scrollHeight - window.innerHeight,
      ),
    }));
    if (last.y >= last.max - 4) break;
  }

  expect(
    last.y,
    `wheel scrolling stopped ${last.max - last.y}px short of the bottom ` +
      `(${((last.y / last.max) * 100).toFixed(1)}% of the document)`,
  ).toBeGreaterThanOrEqual(last.max - 4);

  await expect(page.getByRole("contentinfo")).toBeInViewport();
});

/**
 * The second half of the same bug, and the one that only shows on a phone.
 *
 * Both interactive frames used to declare `touch-action: none` so their own
 * pointer gestures would not fight the browser. Between them they cover most of
 * two viewports, so a vertical swipe aimed at scrolling past them landed inside
 * one far more often than not — and did nothing whatsoever.
 *
 * A synthetic `TouchEvent` cannot prove the fix: dispatched touches do not
 * drive the compositor, so the page would not scroll either way. The honest
 * assertion is the declaration itself, which is what the compositor reads.
 */
test.describe("touch gestures are not swallowed", () => {
  const FRAMES = [
    { name: "scanner", anchor: "#scanner", frame: '#scanner [data-cursor="hidden"]' },
    {
      name: "configurator",
      anchor: "#configurator",
      frame: "#configurator [data-product-stage]",
    },
  ] as const;

  for (const { name, anchor, frame } of FRAMES) {
    test(`the ${name} frame leaves vertical panning to the page`, async ({
      page,
    }) => {
      await boot(page);

      // Lazy sections mount on approach, so walk down rather than jumping.
      for (let i = 0; i < 10; i++) {
        if (await page.locator(frame).count()) break;
        await page.evaluate(() =>
          window.scrollBy({ top: window.innerHeight * 2, behavior: "instant" }),
        );
        await page.waitForTimeout(200);
      }
      await page.waitForSelector(frame, { timeout: 30_000 });

      const el = page.locator(frame).first();
      // The declaration lives on the frame; the configurator's canvas is a
      // child of it, so walk up to whichever ancestor sets it.
      const touchAction = await el.evaluate((node, id) => {
        const root = document.querySelector(id)!;
        for (let n: Element | null = node; n && n !== root; n = n.parentElement) {
          const value = getComputedStyle(n).touchAction;
          if (value !== "auto") return value;
        }
        return "auto";
      }, anchor);

      expect(touchAction, `${name} must not claim every gesture`).not.toBe(
        "none",
      );
      expect(touchAction).toContain("pan-y");
    });
  }
});
