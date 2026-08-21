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
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() =>
      window.scrollBy({ top: window.innerHeight * 2, behavior: "instant" }),
    );
    await page.waitForTimeout(250);
  }
  await page.waitForSelector("#configurator", { timeout: 30_000 });
  await page.waitForTimeout(1200);

  const results = await analyse(page);
  expect(describe(results)).toBe("");
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
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();

  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // Lenis must not take over the scroll, and the ambient bed must stay off.
  const smooth = await page.evaluate(() =>
    document.documentElement.classList.contains("lenis"),
  );
  expect(smooth).toBe(false);

  await expect(page.getByRole("button", { name: /Sound/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The walkthrough still works — it is measured from layout, not from Lenis.
  const canvasDrawn = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas?.width) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4 * 997) if (data[i]! > 8) return true;
    return false;
  });
  expect(canvasDrawn).toBe(true);

  await context.close();
});
