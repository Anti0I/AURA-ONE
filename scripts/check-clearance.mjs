/**
 * Checks that no internal part passes through a shell wall, at every frame.
 *
 *   node scripts/check-clearance.mjs              all 360 frames
 *   node scripts/check-clearance.mjs --frames=720 a finer sweep
 *
 * The explode is choreography rather than physics, so nothing stops it from
 * walking a part straight through the enclosure — and nothing did: the N1
 * core left through the front of the top shell for about thirty frames before
 * anybody but a visitor noticed. The test itself is `stage.clearance(t)` in
 * `assets-src/device/scene.mjs`; this drives it across the timeline through
 * the same harness and static server the prerender uses, and exits non-zero
 * on any crossing.
 */

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const FRAMES = Number(args.get("frames") ?? 360);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const { server, port } = await serve();
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

/** Frame number (1-based, as the PNGs are named) -> crossings at that frame. */
const failures = new Map();

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("  page error:", e.message));
  await page.goto(`http://127.0.0.1:${port}/assets-src/device/index.html`, {
    waitUntil: "load",
  });
  await page.waitForFunction(() => window.__stageReady === true, {
    timeout: 60_000,
  });

  for (let i = 0; i < FRAMES; i++) {
    const t = FRAMES === 1 ? 0 : i / (FRAMES - 1);
    const crossings = await page.evaluate((tt) => window.__stage.clearance(tt), t);
    if (crossings.length > 0) failures.set(i + 1, crossings);
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.size === 0) {
  console.log(`Clearance: no part crosses a shell wall in ${FRAMES} frames.`);
} else {
  // Grouped into runs per part and shell, because "frames 141-172" is what
  // anybody fixing it needs, not thirty-two lines saying the same thing.
  const runs = new Map();
  for (const [frame, crossings] of failures) {
    for (const c of crossings) {
      const key = `${c.part} through ${c.shell}`;
      const list = runs.get(key) ?? [];
      const last = list.at(-1);
      // `>=`, not `===`: a part made of several meshes reports once per mesh.
      if (last && last[1] >= frame - 1) last[1] = Math.max(last[1], frame);
      else list.push([frame, frame]);
      runs.set(key, list);
    }
  }
  console.error(`Clearance: crossings in ${failures.size} of ${FRAMES} frames.`);
  for (const [key, list] of runs) {
    const spans = list.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
    console.error(`  ${key}: frames ${spans.join(", ")}`);
  }
  process.exitCode = 1;
}
