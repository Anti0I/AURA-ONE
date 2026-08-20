/**
 * Generates the single tileable noise tile used by the `.noise-field` utility.
 *
 * Two decisions worth keeping:
 *  - Deterministic seed, so the tile is byte-identical on every machine and
 *    never shows up as a spurious diff.
 *  - Quantised to 8 grey levels and written as a palette PNG. Random noise is
 *    incompressible, so entropy per pixel *is* the file size: 8 levels is
 *    3 bits/px -> ~4 KB, while ungated 8-bit grain costs ~25 KB for a tile
 *    that renders at 3% opacity where nobody can tell the difference.
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const SIZE = 128;
const LEVELS = 8;
const SEED = 0x9e3779b9;

/** mulberry32 — small, fast, good enough distribution for visual grain. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const step = 255 / (LEVELS - 1);
const pixels = Buffer.alloc(SIZE * SIZE * 2); // grey + alpha

for (let i = 0; i < SIZE * SIZE; i++) {
  // Centred on mid-grey so `mix-blend-mode: overlay` darkens and lightens
  // symmetrically instead of just washing the page out.
  const raw = 128 + (rand() - 0.5) * 255;
  const v = Math.round(Math.round(raw / step) * step);
  pixels[i * 2] = Math.max(0, Math.min(255, v));
  pixels[i * 2 + 1] = 255;
}

const out = path.resolve("public/noise.png");
await mkdir(path.dirname(out), { recursive: true });

const info = await sharp(pixels, {
  raw: { width: SIZE, height: SIZE, channels: 2 },
})
  .png({ compressionLevel: 9, palette: true, colours: LEVELS })
  .toFile(out);

console.log(
  `noise.png  ${SIZE}x${SIZE}  ${LEVELS} levels  ${(info.size / 1024).toFixed(2)} KB`,
);
