import { test, expect, type Page } from "@playwright/test";

/**
 * The scanner's contract: aiming it at a component reveals that component's
 * callout and only that one. The lens itself is verified by its transform,
 * because a lens that is drawn but not moving looks identical in a screenshot.
 */

async function openScanner(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });
  // The scanner is code-split behind an IntersectionObserver, so it does not
  // exist until the page has been scrolled near it. Scroll first, then wait for
  // the real section to replace its placeholder.
  await page.evaluate(() =>
    window.scrollTo({
      top: document.body.scrollHeight * 0.8,
      behavior: "instant",
    }),
  );
  await page.waitForSelector("#scanner [data-lens]", { timeout: 20_000 });
  await page.evaluate(() =>
    document
      .getElementById("scanner")
      ?.scrollIntoView({ behavior: "instant", block: "center" }),
  );
  await page.waitForTimeout(900);
}

/** Aims at a normalised point inside the scanner frame and lets it settle. */
async function aimAt(page: Page, x: number, y: number) {
  const frame = page.locator("#scanner [data-cursor='hidden']");
  const box = await frame.boundingBox();
  if (!box) throw new Error("scanner frame has no box");
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y, {
    steps: 20,
  });
  await page.waitForTimeout(1200);
}

test("the lens follows the pointer", async ({ page }) => {
  await openScanner(page);

  const lens = page.locator("#scanner [data-lens]");
  await aimAt(page, 0.3, 0.4);
  const left = await lens.evaluate((el) => getComputedStyle(el).transform);

  await aimAt(page, 0.7, 0.6);
  const right = await lens.evaluate((el) => getComputedStyle(el).transform);

  expect(left).not.toBe(right);
  expect(left).toMatch(/matrix/);
});

test("locking on a component shows exactly one callout", async ({ page }) => {
  await openScanner(page);

  // Anchors come from src/data/hotspots.json, projected at render time.
  await aimAt(page, 0.563, 0.375);
  await expect(page.locator("[data-hotspot='chip'][data-active='true']")).toHaveCount(1);

  const active = await page.locator("[data-hotspot][data-active='true']").count();
  expect(active, "two callouts visible at once").toBe(1);

  await aimAt(page, 0.428, 0.588);
  await expect(page.locator("[data-hotspot='battery'][data-active='true']")).toHaveCount(1);
  await expect(page.locator("[data-hotspot='chip'][data-active='true']")).toHaveCount(0);
});

test("the component list is reachable without the scanner", async ({ page }) => {
  // The scanner is a pointer-driven affordance. Everything it can tell you has
  // to be available without one.
  await openScanner(page);
  await page.getByRole("button", { name: "List components" }).click();

  await expect(page.getByRole("term").filter({ hasText: "AURA N1 Neural Core" })).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "MEMS Quad-Mic Array" })).toBeVisible();
});

test("sound stays off until it is asked for", async ({ page }) => {
  await openScanner(page);
  const toggle = page.getByRole("button", { name: /Sound/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toContainText("Sound on");
});

test("the scanner sweeps on its own without a pointer", async ({ page }) => {
  // On touch there is no hover, so an inert scanner would leave the section
  // looking broken. It sweeps until someone takes over.
  await openScanner(page);

  const lens = page.locator("#scanner [data-lens]");
  const first = await lens.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(1500);
  const second = await lens.evaluate((el) => getComputedStyle(el).transform);

  expect(first).not.toBe(second);
});
