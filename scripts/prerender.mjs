/**
 * Renders the master frame sequence and the matched X-Ray pair.
 *
 * Runs the same Three.js scene the browser would, inside headless Chromium,
 * and reads pixels straight off the WebGL canvas via `toDataURL`. Reading the
 * canvas rather than screenshotting the page is what guarantees the alpha
 * channel survives and that no page chrome, scrollbar or device-pixel-ratio
 * rounding creeps into the output.
 *
 * Output contract (this is the seam a Blender render has to match):
 *   assets-src/out/aura_0001.png … aura_0120.png   square, RGBA, transparent
 *   assets-src/out/xray-outer.png                  16:9, shell visible
 *   assets-src/out/xray-inner.png                  16:9, identical camera
 *   src/data/hotspots.json                         normalised label anchors
 *
 * Usage:
 *   node scripts/prerender.mjs                 full render
 *   node scripts/prerender.mjs --frames=12     quick look
 *   node scripts/prerender.mjs --size=720      half-resolution pass
 */

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = path.join(ROOT, "assets-src", "out");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const FRAMES = Number(args.get("frames") ?? 120);
const SIZE = Number(args.get("size") ?? 1440);
const XRAY_W = Number(args.get("xrayWidth") ?? 2400);
const XRAY_H = Math.round((XRAY_W * 9) / 16);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Minimal static server over the repo, so the import map can reach node_modules. */
function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const filePath = path.join(ROOT, urlPath);

    // Path traversal guard — trivial here, but this server binds a port.
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

async function writeDataUrl(dataUrl, file) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  await fsp.writeFile(file, Buffer.from(base64, "base64"));
}

function bar(done, total, width = 28) {
  const filled = Math.round((done / total) * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

const { server, port } = await serve();
await fsp.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    // Headless Chromium has no GPU here, so WebGL runs on SwiftShader. It is
    // slow but bit-exact across machines, which is what we want for a
    // reproducible render.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-lcd-text",
    "--force-color-profile=srgb",
  ],
});

const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on("pageerror", (e) => console.error("  page error:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("  console:", m.text());
});

const started = Date.now();

try {
  await page.goto(`http://127.0.0.1:${port}/assets-src/device/index.html`, {
    waitUntil: "load",
  });
  await page.waitForFunction(() => window.__stageReady === true, {
    timeout: 60_000,
  });

  const info = await page.evaluate(() => window.__stage.info());
  console.log(`WebGL: ${info.renderer}`);
  console.log(`Sequence: ${FRAMES} frames @ ${SIZE}x${SIZE}`);

  await page.evaluate((s) => window.__stage.setSize(s, s), SIZE);

  for (let i = 0; i < FRAMES; i++) {
    const t = FRAMES === 1 ? 0 : i / (FRAMES - 1);
    const dataUrl = await page.evaluate((tt) => window.__stage.frame(tt), t);
    const name = `aura_${String(i + 1).padStart(4, "0")}.png`;
    await writeDataUrl(dataUrl, path.join(OUT, name));
    process.stdout.write(
      `\r  ${bar(i + 1, FRAMES)} ${i + 1}/${FRAMES}  t=${t.toFixed(3)}   `,
    );
  }
  process.stdout.write("\n");

  console.log(`X-Ray pair: ${XRAY_W}x${XRAY_H}`);
  await page.evaluate(
    ([w, h]) => window.__stage.setSize(w, h),
    [XRAY_W, XRAY_H],
  );

  for (const mode of ["outer", "inner"]) {
    const dataUrl = await page.evaluate((m) => window.__stage.xray(m), mode);
    await writeDataUrl(dataUrl, path.join(OUT, `xray-${mode}.png`));
    console.log(`  xray-${mode}.png`);
  }

  const hotspots = await page.evaluate(() => window.__stage.hotspots());
  const hotspotFile = path.join(ROOT, "src", "data", "hotspots.json");
  await fsp.writeFile(hotspotFile, JSON.stringify(hotspots, null, 2) + "\n");
  console.log(`  hotspots.json (${hotspots.length} anchors)`);
} finally {
  await browser.close();
  server.close();
}

console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${OUT}`);
console.log("Next: npm run assets:encode");
