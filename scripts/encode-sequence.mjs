/**
 * Encodes the master PNG render into the two variants the site actually ships,
 * and writes the manifest the frame player reads at runtime.
 *
 * Format choice, because it is the least obvious decision here:
 *
 *   sequence -> WebP (lossy, alpha)
 *   stills   -> AVIF
 *
 * AVIF is 15-20% smaller per frame at matched quality, and for the two big
 * X-Ray stills that is free money — they are decoded once. For the sequence it
 * is the wrong trade: AVIF-with-alpha decode is roughly 2.5-3x slower than
 * WebP, and during a fast scrub the player decodes several frames per frame of
 * animation. Paying 3x decode to save 15% of transfer is how you turn a smooth
 * scrub into a stuttering one. Bytes are a one-time cost; decode is per-scrub.
 *
 * This script is the seam for a Blender render: drop `aura_0001.png` …
 * `aura_0120.png` into assets-src/out/ and re-run it. Nothing downstream cares
 * where the pixels came from.
 */

import sharp from "sharp";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = path.join(ROOT, "assets-src", "out");
const PUBLIC = path.join(ROOT, "public");

/** Concurrency: sharp releases the event loop, so this is real parallelism. */
const POOL = Math.max(2, Math.min(8, (await import("node:os")).cpus().length));

const VARIANTS = [
  {
    id: "desktop",
    width: 1440,
    stride: 1,
    // Tuned by eye against the brushed-metal highlights, which are the first
    // thing to band. alphaQuality stays high: a soft silhouette edge against
    // #09090b is very visible.
    webp: { quality: 72, alphaQuality: 92, effort: 6, smartSubsample: true },
  },
  {
    id: "mobile",
    width: 720,
    // Every second frame. A phone scrubs the pinned section across roughly a
    // third of the pixels a desktop does, so 60 frames land at a similar
    // frames-per-scrolled-pixel density — while halving both the transfer and,
    // more importantly, the decode work on the weakest hardware.
    stride: 2,
    webp: { quality: 68, alphaQuality: 90, effort: 6, smartSubsample: true },
  },
];

const XRAY = [
  { id: "outer", widths: [2400, 1200] },
  { id: "inner", widths: [2400, 1200] },
];

const kb = (n) => (n / 1024).toFixed(1);
const mb = (n) => (n / 1024 / 1024).toFixed(2);

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}

if (!fs.existsSync(SRC)) {
  console.error(`No render found at ${SRC}\nRun: npm run assets:prerender`);
  process.exit(1);
}

const frames = (await fsp.readdir(SRC))
  .filter((f) => /^aura_\d{4}\.png$/.test(f))
  .sort();

if (frames.length === 0) {
  console.error(`No aura_NNNN.png frames in ${SRC}`);
  process.exit(1);
}

console.log(`Encoding ${frames.length} frames from ${SRC}`);

const meta = await sharp(path.join(SRC, frames[0])).metadata();
const manifest = {
  generatedAt: new Date().toISOString(),
  sourceFrameCount: frames.length,
  source: { width: meta.width, height: meta.height },
  variants: {},
  xray: {},
};

for (const variant of VARIANTS) {
  const outDir = path.join(PUBLIC, "seq", variant.id);
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  // Output indices are always sequential, whatever the stride: the player then
  // only needs `frameCount` to map scroll progress onto a file name, and never
  // has to know that a variant skipped source frames.
  const selected = frames.filter((_, i) => i % variant.stride === 0);

  const sizes = await mapPool(selected, POOL, async (file, i) => {
    const name = `aura_${String(i + 1).padStart(4, "0")}.webp`;
    const info = await sharp(path.join(SRC, file))
      .resize(variant.width, variant.width, { fit: "inside" })
      .webp(variant.webp)
      .toFile(path.join(outDir, name));
    return info.size;
  });

  const total = sizes.reduce((a, b) => a + b, 0);
  const max = Math.max(...sizes);

  manifest.variants[variant.id] = {
    width: variant.width,
    height: variant.width,
    basePath: `/seq/${variant.id}`,
    ext: "webp",
    frameCount: selected.length,
    stride: variant.stride,
    totalBytes: total,
    maxFrameBytes: max,
    avgFrameBytes: Math.round(total / sizes.length),
  };

  console.log(
    `  ${variant.id.padEnd(8)} ${variant.width}px  ${String(selected.length).padStart(3)} frames  ` +
      `total ${mb(total)} MB  avg ${kb(total / sizes.length)} KB  peak ${kb(max)} KB`,
  );
}

// ---- X-Ray stills ---------------------------------------------------------
const imgDir = path.join(PUBLIC, "img");
await fsp.mkdir(imgDir, { recursive: true });

for (const still of XRAY) {
  const src = path.join(SRC, `xray-${still.id}.png`);
  if (!fs.existsSync(src)) {
    console.warn(`  ! missing ${path.basename(src)} — skipping`);
    continue;
  }
  const entries = [];
  for (const w of still.widths) {
    const name = `xray-${still.id}${w === still.widths[0] ? "" : `-${w}`}.avif`;
    const info = await sharp(src)
      .resize(w, null, { fit: "inside" })
      .avif({ quality: 52, effort: 6, chromaSubsampling: "4:2:0" })
      .toFile(path.join(imgDir, name));
    entries.push({ width: w, url: `/img/${name}`, bytes: info.size });
    console.log(`  xray-${still.id} ${w}px  ${kb(info.size)} KB`);
  }
  manifest.xray[still.id] = entries;
}

await fsp.writeFile(
  path.join(PUBLIC, "seq", "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`\nmanifest -> public/seq/manifest.json`);
console.log("Next: npm run audit:budget");
