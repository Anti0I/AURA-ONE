import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WCAG 2.1 AA audit.
 *
 * A dark, canvas-heavy, pointer-driven page is exactly the shape of site that
 * fails this, so it runs in CI rather than as a one-off before launch. Two
 * things it is specifically here to catch: contrast drifting when a token is
 * nudged, and an interactive surface that only exists for a mouse.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function analyse(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  if (include) builder.include(include);
  return builder.analyze();
}

/** Renders violations as something readable in a CI log. */
function describe(results: Awaited<ReturnType<typeof analyse>>) {
  return results.violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join("\n  ")}`,
    )
    .join("\n\n");
}

test("the hero and chrome pass an axe audit", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  const results = await analyse(page);
  expect(describe(results)).toBe("");
});

test("the lazy sections pass once mounted", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // Every section below the fold is code-split, so an audit of the initial
  // document would check almost nothing. Walk down and mount them all first.
  // Far enough for a document that is now over a thousand viewport heights
  // tall, most of it the two pinned sections.
  for (let i = 0; i < 16; i++) {
    await page.evaluate(() =>
      window.scrollBy({ top: window.innerHeight * 2, behavior: "instant" }),
    );
    await page.waitForTimeout(250);
  }
  // Waited on by *content*, not by id. Every `LazySection` carries its anchor
  // id on the placeholder as well as on the mounted section — deliberately, so
  // a deep link works before the section exists — which means waiting for
  // "#acoustics" resolves instantly and audits an empty div.
  await page.waitForSelector("#configurator canvas", { timeout: 30_000 });
  await page.waitForSelector("#acoustics-heading", { timeout: 30_000 });
  await page.waitForTimeout(1200);

  const results = await analyse(page);
  expect(describe(results)).toBe("");

  // The acoustics section pins and shows one beat at a time, so on a wide
  // viewport only one of its three Play buttons is in the tab order. Its rail
  // is the way through, exactly as the walkthrough's is — without it the second
  // and third demonstrations are reachable by scrolling and by nothing else.
  const rail = page.getByRole("list", { name: "Acoustics demonstrations" });
  if (await rail.count()) {
    await expect(rail.getByRole("button")).toHaveCount(3);
  } else {
    // Flat layout: no rail, and none needed, because all three are present.
    await expect(page.getByRole("button", { name: /^Play — / })).toHaveCount(3);
  }
});

test("the command palette passes while open", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();

  const results = await analyse(page, '[role="dialog"]');
  expect(describe(results)).toBe("");
});

test("everything interactive is reachable by keyboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // The skip link has to be first, and it has to become visible on focus —
  // a skip link that stays clipped is worse than none, because it silently
  // moves focus somewhere the user cannot see.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  // And the walkthrough is navigable without scrolling: the phase rail is a
  // set of buttons, not decoration.
  const rail = page.getByRole("list", { name: "Walkthrough phases" });
  await expect(rail.getByRole("button")).toHaveCount(3);
});

test("reduced motion is honoured", async ({ browser }) => {
  // This one boots the page from scratch in its own context and then waits for
  // a real frame on the canvas, so it carries the whole cost of a cold start —
  // the preloader alone is allowed 30 s. On the default budget the *test* ran
  // out before its own poll did, which is why raising the poll achieved
  // nothing and the failure kept reporting as "never drew a frame".
  test.setTimeout(120_000);

  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();

  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // Lenis must not take over the scroll, and the ambient bed must stay off.
  const smooth = await page.evaluate(() =>
    document.documentElement.classList.contains("lenis"),
  );
  expect(smooth).toBe(false);

  // Anchored: /Sound/ is a substring, not a name, and the acoustics section
  // has a "Play — Sound keeps its address." control of its own.
  await expect(
    page.getByRole("button", { name: /^Sound (on|off)$/ }),
  ).toHaveAttribute("aria-pressed", "false");

  // The walkthrough still works — it is measured from layout, not from Lenis.
  //
  // Polled, not sampled once. The preloader releasing the page and the first
  // frame reaching the canvas are two different moments, and under a parallel
  // run they can be several hundred milliseconds apart; asking once right
  // after the overlay hides is a coin toss that lands the right way up on an
  // idle machine.
  //
  // The window is generous because this shares two workers with browsers
  // decoding VP9 and running three.js on SwiftShader, and the document is
  // twelve screens tall. It passed every time it ran alone and failed two full
  // runs in three, which is a statement about the machine rather than about the
  // page. The claim is unchanged — only how long it waits for it.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const canvas = document.querySelector("canvas");
          if (!canvas?.width) return false;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return false;
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 3; i < data.length; i += 4 * 997) {
            if (data[i]! > 8) return true;
          }
          return false;
        }),
      { timeout: 35_000, message: "the walkthrough never drew a frame" },
    )
    .toBe(true);

  await context.close();
});

test("the engineering notes pass an axe audit", async ({ page }) => {
  // Axe walks the whole document, and this document is the longest on the site
  // and keeps getting longer. Under the two-worker run it went past the default
  // 30 s budget and reported as `frame.evaluate: Test timeout exceeded` — which
  // reads like a page fault and is nothing of the kind. The assertion below is
  // unchanged; only the time it is given to reach it.
  test.setTimeout(120_000);

  await page.goto("/engineering");
  await expect(
    page.getByRole("heading", { name: /What is actually going on/ }),
  ).toBeVisible();

  // A long-form document is where contrast regressions surface first: it has
  // more type at more sizes than anything else on the site.
  const results = await analyse(page);
  expect(describe(results)).toBe("");
});
