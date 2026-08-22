# AURA ONE

A product page for hardware that does not exist, built to demonstrate the parts
that do: scroll-driven canvas rendering, procedural asset generation, and
memory discipline.

**Every asset is generated from code.** No stock photography, no purchased 3D
model, no HDRI, no audio files, no paid API keys — for me or for anyone opening
the page. Clone it and `npm run assets:all` rebuilds the lot from primitives.

The reasoning behind the decisions below lives at [`/engineering`](src/app/engineering/page.tsx),
rendered from the same manifest the build writes, so it cannot quote a number
the build disagrees with.

---

## Running it

```bash
npm install
npm run dev
```

The encoded frame sequence is committed, so a clone builds and deploys without
a headless render. To regenerate it from the scene:

```bash
npm run assets:all
```

That runs four steps, which can also be run individually:

| Command | What it does | Time |
| --- | --- | --- |
| `npm run assets:noise` | 128² tileable noise, palette PNG, 4.1 KB | instant |
| `npm run assets:prerender` | Three.js scene through headless Chromium → 240 PNGs + X-Ray pair + hotspot anchors | ~115 s |
| `npm run assets:encode` | sharp → WebP/AVIF fallback variants + `public/seq/manifest.json` | ~25 s |
| `npm run assets:video` | ffmpeg → the VP9 streams the walkthrough actually plays | ~90 s |

`assets:video` needs **ffmpeg** on the PATH. Nothing else in the pipeline does.

## Verifying it

```bash
npm run verify
```

Typecheck, lint and 25 unit tests. The full pipeline, as CI runs it:

```bash
npm run build && npm run audit:budget && npm run test:e2e && npm run test:a11y && npm run test:perf
```

- **36 end-to-end tests** across desktop and mobile. The scrollytelling cannot
  be checked by asserting on the DOM — everything that matters happens inside a
  canvas React never re-renders — so those tests read pixels: coverage, frame
  fingerprints, and mean luminance for the finish tests.
- **12 accessibility tests**: an axe audit of the chrome, of every lazy section
  once mounted, and of the command palette while open, plus the skip link,
  keyboard reachability, and the reduced-motion path.
- **2 scrub-performance tests**, in their own config at one worker. A
  performance number that changes by a factor of four depending on what else is
  running is not a number: measured beside the rest of the suite this reported a
  largest frame gap of 169, and 21 to 48 on its own.
- **`audit:budget`** fails the build when the site outgrows what it agreed to.

There is no Lighthouse job. Its stable categories are already covered by the axe
audit and the budget gate, and a performance score from a shared CI runner flaps
enough that people learn to ignore it. Run it locally against a production build
if you want the number:

```bash
npm run build && npm run start
npx lighthouse http://localhost:3000 --view --preset=desktop
```

## Budgets

Enforced by `scripts/audit-budget.mjs`, deliberately close to reality — a budget
with slack in it is a budget nobody respects.

| Asset | Budget | Current |
| --- | --- | --- |
| First-load JS (gzip) | 180 KB | 164 KB |
| Desktop video | 3.70 MB | 3.34 MB · 240 frames |
| Mobile video | 1.50 MB | 1.36 MB · 240 frames |
| Desktop still fallback | 5.00 MB | 4.54 MB · 120 frames |
| Mobile still fallback | 1.70 MB | 1.51 MB · 60 frames |
| Peak frame, desktop | 100 KB | 91.2 KB |
| All JS chunks (gzip) | 420 KB | 360 KB |
| X-Ray pair @2400px | 240 KB | 189.3 KB |
| Noise tile | 6 KB | 4.1 KB |
| Audio files | 0 | 0 — everything is synthesised |

## How it is built

**240 frames scrubbed against scroll** on a 2D canvas, decoded in a worker so
the main thread never does. Frames decode to the size they will be *drawn*, not
the size they were encoded.

**A video, driven through WebCodecs.** `<video>` cannot be scrubbed —
`currentTime` is a *request* to seek that the element answers whenever it
likes — but that is a property of the element, not of video. `VideoDecoder`
takes chunks and returns frames in order, which buys inter-frame prediction:
3.34 MB against 9.09 MB for the same 240 pictures as WebP stills. The still
sequence stays as the fallback where WebCodecs is missing, and a test deletes
`VideoDecoder` to prove that path still draws.

**IVF, not MP4.** A container has to be parsed at runtime, and mp4box.js is
~60 KB gzipped to do it. IVF is a 32-byte file header and 12 bytes per frame —
thirty lines of `DataView` and no dependency.

**A matte packed beside the colour**, since video has no alpha channel,
recombined in a WebGL2 shader inside the worker with no readback. What comes out
is an ordinary `ImageBitmap`, so the cache and the draw path never learn any of
this happened.

**Whole frames only.** The draw briefly cross-faded between the two frames the
playhead sat between, to soften the step. Measured on the stream actually
shipped, the two are 5 degrees of rotation apart and the blend read as a double
exposure — and it bought no density: 58 distinct pictures across 60 wheel steps
without it against 59 with, because a 40px step already crosses ~2.8 frames.

**Sections dissolve into each other.** `SectionHandoff` drives opacity, scale
and a stepped blur from each section's own edges, so a boundary cross-fades
instead of one panel sliding out from under another. The blur radius is
quantised because `filter` re-rasterises the layer on every distinct value,
where opacity and transform are free.

**AVIF for the X-Ray stills, WebP for the fallback sequence.** AVIF is ~18%
smaller per frame, but AVIF-with-alpha decodes about 3× slower, and a scrub
decodes several frames per frame of animation. Bytes are a one-time cost;
decode is per-scrub.

**A scheduler that measures itself.** The player tracks two numbers about the
machine it is running on: how many frames a second the whole chain actually
delivers, and how long one round trip takes. It samples the timeline at a stride
that matches the first, and aims each request `speed x latency` frames ahead of
the playhead so the frame arrives *at* the scroll rather than behind it. Neither
can be a constant — the same build composites a frame in 0.1 ms on a discrete
GPU and 32 ms on a software rasteriser, and any figure picked for one is wrong
on the other. What it buys is that a slow machine draws fewer, wider-spaced
pictures and still follows the scroll from end to end, which is the thing
`tests/perf` asserts on.

**Byte-budgeted bitmap cache.** `ImageBitmap` memory lives outside the JS heap
and is released only by `close()`, so eviction is explicit and the unit tests
assert on `close()` calls. The cache is bounded by bytes as well as by frame
count: the same 24 frames are 39 MB decoded at 640² and 199 MB at 1440². The
prefetch window is sized from the byte budget rather than fixed, because a
window in frames and a ceiling in bytes only agree at one decode size.

**Nothing animates off screen.** Every loop with no natural end — the sweep, the
spin, the playhead — goes through one visibility gate. Parked at the footer with
every section mounted: 720 canvas clears and 720 layout reads in three seconds
before, none after.

**No GSAP, no ScrollTrigger.** The pinned section is `position: sticky` and
progress is one `getBoundingClientRect` per frame, read before anything has
written to the DOM. One animation loop with priority-ordered subscribers, so
scroll commits before anything draws with it.

**One scene, rendered two ways.** The configurator runs the procedural scene
live — the same one the walkthrough is baked from — because a pre-rendered
turntable spins about one axis and turning the product over is the point. three.js
is ~135 KB gzip and lands only in that section's chunk, so the first load is
unchanged; a separate budget watches every chunk so weight cannot hide in a lazy
one. It draws only while on screen, because an idle spin has no natural end.

**The composite it replaced is the no-WebGL fallback.** The grey frame sequence
recoloured at draw time with a brightness pass, a `color` blend, an `overlay`
pass and a `destination-in` clip.

**All audio is synthesised**, ambient bed included. No files, no licences,
nothing to preload, and a hover tick that can be pitched per element — which a
sample cannot do without shipping one per variant.

## Swapping in a Blender render

The pipeline's seam is the *output contract*, not the scene. To replace the
procedural render with a photoreal one, drop these into `assets-src/out/` and
run `npm run assets:encode`:

- `aura_0001.png` … `aura_0240.png` — exactly 240 frames, square, **PNG RGBA
  with a transparent background** (`Film → Transparent`).
- `xray-outer.png` and `xray-inner.png` — 16:9, from an **identical camera**;
  the scanner cross-fades between them and any drift shows immediately.

Two constraints carry over. Render the shell in **neutral grey** — the finishes
are canvas composites, so a baked colour means re-rendering per variant. And
keep the phase boundaries: frames 1–72 rotate, 73–168 explode, 169–216 push
into the core, 217–240 reassemble. Caption timing in `src/data/story.ts` is asserted
against them by a unit test.

Hotspot anchors are re-projected by `npm run assets:prerender`; if the X-Ray
camera moves, regenerate `src/data/hotspots.json` rather than editing it.

## Layout

```
assets-src/device/     procedural Three.js scene + texture generators
scripts/               prerender, encode, budget audit, screenshots
src/lib/canvas/        frame player, both source workers, IVF reader, matte shader, LRU
src/lib/scroll/        one rAF bus, Lenis integration, section progress
assets-src/device/     the scene, imported live by the configurator
src/lib/audio/         AudioContext bus, everything synthesised
src/components/        one directory per section
src/data/              product data, story timing, generated manifests
```

## Licence

Code MIT. `AURA ONE` is a fictional product invented for this project.
