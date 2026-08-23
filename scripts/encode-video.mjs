/**
 * Encodes the master PNG render into the video the scrollytelling actually
 * plays, and folds its description into the sequence manifest.
 *
 * Why a video at all, given that the whole point of a frame sequence is that
 * `video.currentTime` cannot be scrubbed frame-accurately: because none of that
 * applies when you drive the decoder yourself. WebCodecs' `VideoDecoder` takes
 * encoded chunks and hands back frames, in order, with no seeking heuristics in
 * between. What we get in exchange is inter-frame prediction — and a slowly
 * rotating object is about as predictable as content gets.
 *
 *   360 frames as WebP stills  14.94 MB
 *   360 frames as VP9           4.31 MB   (SSIM 0.98 against the masters)
 *
 * Two decisions worth defending:
 *
 * **IVF, not MP4 or WebM.** A container has to be parsed at runtime to get at
 * the chunks. MP4 needs a demuxer (mp4box.js is ~60 KB gzip); Matroska is worse.
 * IVF is a 32-byte file header and a 12-byte header per frame — thirty lines of
 * `DataView` and no dependency, which matters more here than the handful of
 * bytes the container costs.
 *
 * **A separate matte, packed beside the colour.** Video has no alpha channel.
 * The standard answer is to encode the colour and its matte side by side and
 * recombine them at draw time, which is what `matte.ts` does in a shader. The
 * gutter between the halves exists because 4:2:0 chroma is shared across two
 * pixels, so without it the seam bleeds colour into the first column of matte.
 *
 * Usage:
 *   node scripts/encode-video.mjs
 *   node scripts/encode-video.mjs --crf=33     higher quality, larger file
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = path.join(ROOT, "assets-src", "out");
const PUBLIC = path.join(ROOT, "public");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

/**
 * Quality, and the number that paid for the frame count.
 *
 * This was 36 at 240 frames. Going to 360 frames at 36 took the desktop stream
 * from 3.87 MB to 5.25 MB, which is a lot to ask of the one file every visitor
 * downloads. At 39 the same 360 frames are 4.31 MB — 50% more pictures for 11%
 * more bytes.
 *
 * Measured rather than assumed, because "three steps of CRF" means nothing on
 * its own. SSIM of each stream against the render masters, on four frames
 * spanning the timeline:
 *
 *            frame 60   frame 150   frame 240   frame 324
 *   crf 36    0.9851     0.9838      0.9902      0.9600
 *   crf 39    0.9823     0.9814      0.9883      0.9569
 *
 * Three thousandths, everywhere. The distance to the master is an order of
 * magnitude larger than the distance between the two settings, and it is
 * almost entirely 4:2:0 chroma subsampling — which this stream has always had
 * and which neither setting changes.
 */
const CRF = Number(args.get("crf") ?? 39);

/**
 * Distance between keyframes.
 *
 * This is the seek cost: to show frame N the decoder has to start at the last
 * keyframe at or before it, so a backwards scrub pays up to this many decodes.
 * Shorter is faster to seek and larger on disk — except that here it very
 * nearly is not. Going from 24 down to 16 cost 20 KB out of 3.4 MB, because
 * the content between keyframes barely changes.
 */
const GOP = Number(args.get("gop") ?? 16);

/** Black columns between the colour half and the matte, so 4:2:0 cannot bleed. */
const GUTTER = 16;

const VARIANTS = [
  { id: "desktop", width: 1440 },
  // A phone draws the product across roughly a third of the pixels, and decode
  // cost scales with them. Same frame count as desktop, though: with video the
  // frames are nearly free, so there is no longer any reason to thin them out.
  { id: "mobile", width: 720 },
];

/**
 * VP9 level for a given resolution, per the spec's table.
 *
 * `VideoDecoder` will refuse a codec string whose level is below what the
 * stream needs, and browsers differ on how forgiving they are, so this is
 * derived rather than hard-coded.
 */
const LEVELS = [
  { id: "10", pixels: 36864, rate: 829440 },
  { id: "11", pixels: 73728, rate: 2764800 },
  { id: "20", pixels: 122880, rate: 4608000 },
  { id: "21", pixels: 245760, rate: 9216000 },
  { id: "30", pixels: 552960, rate: 20736000 },
  { id: "31", pixels: 983040, rate: 36864000 },
  { id: "40", pixels: 2228224, rate: 83558400 },
  { id: "41", pixels: 2228224, rate: 160432128 },
  { id: "50", pixels: 8912896, rate: 311951360 },
  { id: "51", pixels: 8912896, rate: 588251136 },
  { id: "60", pixels: 35651584, rate: 1176502272 },
];

function vp9Level(width, height, fps) {
  const pixels = width * height;
  const rate = pixels * fps;
  const level = LEVELS.find((l) => pixels <= l.pixels && rate <= l.rate);
  if (!level) throw new Error(`no VP9 level covers ${width}x${height}@${fps}`);
  return level.id;
}

const mb = (n) => (n / 1024 / 1024).toFixed(2);

// ---------------------------------------------------------------------------

if (!fs.existsSync(SRC)) {
  console.error(`No render found at ${SRC}\nRun: npm run assets:prerender`);
  process.exit(1);
}

const frames = (await fsp.readdir(SRC)).filter((f) =>
  /^aura_\d{4}\.png$/.test(f),
);
if (frames.length === 0) {
  console.error(`No aura_NNNN.png frames in ${SRC}`);
  process.exit(1);
}

const outDir = path.join(PUBLIC, "seq");
await fsp.mkdir(outDir, { recursive: true });

console.log(`Encoding ${frames.length} frames as VP9 (crf ${CRF}, gop ${GOP})`);

const video = {};

for (const variant of VARIANTS) {
  const packedWidth = variant.width * 2 + GUTTER;
  const file = `${variant.id}.ivf`;
  const dest = path.join(outDir, file);

  // premultiply, because the colour under a transparent pixel is undefined in
  // the render and encoding undefined values wastes bits on noise nobody sees.
  // The shader expects premultiplied and the canvas is told so.
  const filter = [
    `[0:v]scale=${variant.width}:${variant.width}:flags=lanczos,format=rgba,split=2[c0][a0]`,
    `[c0]premultiply=inplace=1,format=rgb24,pad=iw+${GUTTER}:ih:0:0:black[col]`,
    `[a0]alphaextract,format=rgb24[mat]`,
    `[col][mat]hstack=inputs=2,format=yuv420p[v]`,
  ].join(";");

  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-framerate", "30",
    "-i", path.join(SRC, "aura_%04d.png"),
    "-filter_complex", filter,
    "-map", "[v]",
    "-c:v", "libvpx-vp9",
    "-b:v", "0",
    "-crf", String(CRF),
    "-g", String(GOP),
    // Every frame is displayed exactly once and nothing is ever dropped, so
    // libvpx's alt-ref frames — which are encoded but never shown — would put
    // invisible frames into a stream whose indices have to line up with the
    // scroll timeline.
    "-auto-alt-ref", "0",
    "-lag-in-frames", "0",
    "-deadline", "good",
    "-cpu-used", "2",
    "-row-mt", "1",
    "-f", "ivf",
    dest,
  ]);

  const bytes = (await fsp.stat(dest)).size;

  video[variant.id] = {
    url: `/seq/${file}`,
    codec: `vp09.00.${vp9Level(packedWidth, variant.width, 30)}.08`,
    frameCount: frames.length,
    gop: GOP,
    /** The drawable half. */
    width: variant.width,
    height: variant.width,
    /** Left edge of the matte inside the packed frame. */
    matteX: variant.width + GUTTER,
    packedWidth,
    packedHeight: variant.width,
    bytes,
  };

  console.log(
    `  ${variant.id.padEnd(8)} ${packedWidth}x${variant.width}  ` +
      `${frames.length} frames  ${mb(bytes)} MB  ${video[variant.id].codec}`,
  );
}

// ---- Fold into the manifest ------------------------------------------------
// The still sequence stays exactly as it is. It is the fallback for browsers
// without WebCodecs, and keeping both described by one manifest is what lets
// the player pick a source at runtime instead of at build time.
const manifestPath = path.join(outDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("\nNo manifest yet — run npm run assets:encode first.");
  process.exit(1);
}

const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
manifest.video = video;

for (const target of [manifestPath, path.join(ROOT, "src", "data", "sequence.json")]) {
  await fsp.writeFile(target, JSON.stringify(manifest, null, 2) + "\n");
}

console.log("\nmanifest updated with video sources");
console.log("Next: npm run audit:budget");
