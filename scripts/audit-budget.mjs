/**
 * Performance budget gate.
 *
 * Exits non-zero when the site would ship more than it has agreed to. Runs in
 * CI after the build, so a regression is a failed check rather than something
 * somebody notices on a slow connection three weeks later.
 *
 * Budgets are deliberately close to current reality — a budget with slack in
 * it is a budget nobody respects.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = path.join(ROOT, "public");

const KB = 1024;
const MB = 1024 * 1024;

const BUDGETS = {
  // The VP9 streams the scrollytelling actually plays. 240 frames each; the
  // same frames as WebP stills would be 9.09 MB and 2.00 MB.
  desktopVideo: 3.7 * MB,
  mobileVideo: 1.5 * MB,
  // The still sequences are the fallback for browsers without WebCodecs, at a
  // coarser stride than the video. Peak frames are the exploded-view ones:
  // most silhouette, most detail.
  desktopFrame: 100 * KB,
  desktopSequence: 5.0 * MB,
  mobileFrame: 64 * KB,
  mobileSequence: 1.7 * MB,
  // Only the pair the viewport actually loads. The inner still is the
  // expensive one: a thin high-contrast wireframe is the worst case for AVIF.
  xrayPair: 240 * KB,
  noise: 6 * KB,
  /** First-load JS for "/", gzipped, excluding the frame sequence. */
  firstLoadJs: 180 * KB,
  /**
   * Every JS chunk the build produces, gzipped.
   *
   * First-load alone stopped being the whole story once the configurator
   * started pulling in three.js: ~135 KB gzip that correctly does not count
   * against first load, because it is fetched when that section mounts. Real
   * weight hiding in a lazy chunk is still real weight, and a budget that only
   * watches the first load is an invitation to move things out of it.
   */
  totalJs: 420 * KB,
};

const results = [];
let failed = 0;

function check(name, actual, budget, unit = "KB") {
  const ok = actual <= budget;
  if (!ok) failed++;
  const fmt = (v) =>
    unit === "MB"
      ? `${(v / MB).toFixed(2)} MB`
      : unit === "count"
        ? String(v)
        : `${(v / KB).toFixed(1)} KB`;
  results.push({
    ok,
    name,
    line: `${ok ? "PASS" : "FAIL"}  ${name.padEnd(28)} ${fmt(actual).padStart(10)} / ${fmt(budget)}`,
  });
}

function skip(name, why) {
  results.push({ ok: true, name, line: `SKIP  ${name.padEnd(28)} ${why}` });
}

// ---- Frame sequence -------------------------------------------------------
const manifestPath = path.join(PUBLIC, "seq", "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const d = manifest.variants.desktop;
  const m = manifest.variants.mobile;
  if (d) {
    check("sequence/desktop total", d.totalBytes, BUDGETS.desktopSequence, "MB");
    check("sequence/desktop peak frame", d.maxFrameBytes, BUDGETS.desktopFrame);
  }
  if (m) {
    check("sequence/mobile total", m.totalBytes, BUDGETS.mobileSequence, "MB");
    check("sequence/mobile peak frame", m.maxFrameBytes, BUDGETS.mobileFrame);
  }

  const video = manifest.video ?? {};
  if (video.desktop) {
    check("video/desktop", video.desktop.bytes, BUDGETS.desktopVideo, "MB");
  }
  if (video.mobile) {
    check("video/mobile", video.mobile.bytes, BUDGETS.mobileVideo, "MB");
  }
} else {
  skip("frame sequence", "no manifest — run npm run assets:encode");
}

// ---- X-Ray stills ---------------------------------------------------------
// Only the widest pair counts: a viewport loads one width, never all of them.
// Summing every responsive variant would budget for bytes nobody downloads.
if (fs.existsSync(manifestPath)) {
  const { xray } = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const widest = Object.values(xray ?? {}).map((entries) =>
    entries.reduce((a, b) => (b.width > a.width ? b : a)),
  );
  if (widest.length) {
    const total = widest.reduce((sum, e) => sum + e.bytes, 0);
    check(`xray pair @${widest[0].width}px`, total, BUDGETS.xrayPair);
  }
}

// ---- Audio ----------------------------------------------------------------
// Every sound on this site is synthesised in WebAudio, ambient bed included.
// This used to be a size budget against an ambient file that was never shipped,
// which made it a permanent SKIP — a guard that can never fire is decoration.
// It now enforces the actual rule: zero audio bytes.
const audioDir = path.join(PUBLIC, "audio");
const audioFiles = fs.existsSync(audioDir) ? await fsp.readdir(audioDir) : [];
check("audio files (all synthesised)", audioFiles.length, 0, "count");

// ---- Noise tile -----------------------------------------------------------
const noisePath = path.join(PUBLIC, "noise.png");
if (fs.existsSync(noisePath)) {
  check("noise tile", (await fsp.stat(noisePath)).size, BUDGETS.noise);
} else {
  skip("noise tile", "run npm run assets:noise");
}

// ---- First-load JS --------------------------------------------------------
// Read off the prerendered HTML rather than out of a Next internal manifest:
// the chunks the document actually references are, by definition, what the
// browser downloads before the page is interactive. It also means lazily
// imported work (the lazy sections below the fold) correctly does *not* count —
// which is the whole reason those are dynamic imports.
const htmlPath = path.join(ROOT, ".next", "server", "app", "index.html");
if (fs.existsSync(htmlPath)) {
  const html = await fsp.readFile(htmlPath, "utf8");

  // Skip `noModule` scripts. Next emits a core-js polyfill bundle for browsers
  // that predate ES modules; every browser this site targets ignores it
  // entirely, so counting its 39 KB against the budget would be measuring
  // bytes nobody downloads and would push real work out to make room for it.
  const legacy = new Set(
    [...html.matchAll(/<script[^>]*noModule[^>]*>/g)].flatMap(
      (m) => m[0].match(/\/_next\/static\/[\w./-]+\.js/g) ?? [],
    ),
  );

  const refs = new Set(
    (html.match(/\/_next\/static\/[\w./-]+\.js/g) ?? []).filter(
      (r) => !legacy.has(r),
    ),
  );

  let gz = 0;
  let missing = 0;
  for (const ref of refs) {
    const file = path.join(ROOT, ".next", ref.replace("/_next/", ""));
    if (!fs.existsSync(file)) {
      missing++;
      continue;
    }
    gz += gzipSync(await fsp.readFile(file)).length;
  }
  check(`first-load JS (${refs.size - missing} chunks)`, gz, BUDGETS.firstLoadJs);

  // Everything the build emits, lazy chunks included.
  const chunkDir = path.join(ROOT, ".next", "static", "chunks");
  if (fs.existsSync(chunkDir)) {
    let total = 0;
    let count = 0;
    const walk = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".js")) {
          total += gzipSync(await fsp.readFile(full)).length;
          count++;
        }
      }
    };
    await walk(chunkDir);
    check(`all JS chunks (${count})`, total, BUDGETS.totalJs);
  }
} else {
  skip("first-load JS", "no .next build — run npm run build first");
}

// ---- Report ---------------------------------------------------------------
console.log("\nAsset budget\n" + "-".repeat(58));
for (const r of results) console.log(r.line);
console.log("-".repeat(58));

if (failed > 0) {
  console.error(`\n${failed} budget${failed === 1 ? "" : "s"} exceeded.`);
  process.exit(1);
}
console.log("All budgets met.\n");
