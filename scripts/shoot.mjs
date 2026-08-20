/**
 * Screenshots the running site at a set of scroll positions.
 *
 * Exists because the interesting states of this page are unreachable by
 * navigation: you cannot link to "40% through the pinned section". Used for
 * design review and for the stills in the README.
 *
 * Usage:
 *   npm run dev            (in another terminal)
 *   node scripts/shoot.mjs [--mobile] [--out=dir]
 */

import { chromium } from "playwright";
import path from "node:path";
import fsp from "node:fs/promises";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const MOBILE = args.has("mobile");
const OUT = path.resolve(args.get("out") ?? "shots");
const BASE = args.get("url") ?? "http://localhost:3000";

/** Named positions: fraction of the way through #stage, or a selector. */
const SHOTS = [
  { name: "01-hero", stage: 0 },
  { name: "02-rotate", stage: 0.22 },
  { name: "03-explode", stage: 0.5 },
  { name: "04-core", stage: 0.78 },
  { name: "05-reassemble", stage: 0.96 },
];

await fsp.mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: MOBILE ? { width: 390, height: 844 } : { width: 1600, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: MOBILE,
  isMobile: MOBILE,
});

page.on("pageerror", (e) => console.error("  page error:", e.message));

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector('[role="status"]', { state: "hidden", timeout: 60_000 });

for (const shot of SHOTS) {
  await page.evaluate((f) => {
    const stage = document.getElementById("stage");
    if (!stage) return;
    const span = stage.offsetHeight - window.innerHeight;
    window.scrollTo({ top: stage.offsetTop + span * f, behavior: "instant" });
  }, shot.stage);

  // Lenis is inertial and the playhead is damped; both need to arrive before
  // the shutter, or every screenshot catches a frame mid-transition.
  await page.waitForTimeout(1500);

  const suffix = MOBILE ? "-mobile" : "";
  const file = path.join(OUT, `${shot.name}${suffix}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${path.relative(process.cwd(), file)}`);
}

await browser.close();
