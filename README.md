# AURA ONE

A product page for hardware that does not exist, built to demonstrate the parts
that do: scroll-driven canvas rendering, in-browser inference, and memory
discipline.

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

That runs three steps, which can also be run individually:

| Command | What it does | Time |
| --- | --- | --- |
| `npm run assets:noise` | 128² noise tile, 8 grey levels, ~4 KB | instant |
| `npm run assets:prerender` | Three.js scene through headless Chromium → 120 PNGs + X-Ray pair + hotspot anchors | ~66 s |
| `npm run assets:encode` | sharp → WebP/AVIF variants + `public/seq/manifest.json` | ~20 s |

## Verifying it

```bash
npm run verify
```

Typecheck, lint and 26 unit tests. The full pipeline, as CI runs it:

```bash
npm run build && npm run audit:budget && npm run test:e2e && npm run test:a11y
```

- **36 end-to-end tests** across desktop and mobile. The scrollytelling cannot
  be checked by asserting on the DOM — everything that matters happens inside a
  canvas React never re-renders — so those tests read pixels: coverage, frame
  fingerprints, and mean luminance for the finish tests.
- **5 accessibility tests**: an axe audit of the chrome, of every lazy section
  once mounted, and of the command palette while open, plus the skip link,
  keyboard reachability, and the reduced-motion path.
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
| First-load JS (gzip) | 180 KB | 161 KB |
| Desktop sequence | 5.50 MB | 4.88 MB · 120 frames |
| Mobile sequence | 1.80 MB | 1.50 MB · 60 frames |
| Peak frame, desktop | 110 KB | 98.6 KB |
| X-Ray pair @2400px | 240 KB | 189 KB |
| Noise tile | 6 KB | 4.1 KB |
| Audio | 300 KB | 0 — synthesised |

## How it is built

**Frame sequence.** 120 frames scrubbed against scroll on a 2D canvas, decoded
in a worker so the main thread never does — a 1440² WebP with alpha costs 4–9 ms
to decode, which is a dropped frame every time the scrub outruns the cache.
Frames decode to the size they will be *drawn*, not the size they were encoded.

**WebP for the sequence, AVIF for the stills.** AVIF is ~18% smaller per frame,
but AVIF-with-alpha decodes about 3× slower, and a fast scrub decodes several
frames per frame of animation. Bytes are a one-time cost; decode is per-scrub.

**Byte-budgeted bitmap cache.** `ImageBitmap` memory lives outside the JS heap
and is released only by `close()`, so eviction is explicit and the unit tests
assert on `close()` calls. The cache is bounded by bytes as well as by frame
count: the same 24 frames are 39 MB decoded at 640² and 199 MB at 1440².

**No GSAP, no ScrollTrigger.** The pinned section is `position: sticky` and
progress is one `getBoundingClientRect` per frame, read before anything has
written to the DOM. One animation loop with priority-ordered subscribers, so
scroll commits before anything draws with it.

**Four finishes from one grey render.** Recoloured at draw time with a
brightness pass, a `color` blend, an `overlay` pass and a `destination-in` clip.
Adding a finish costs an object in a data file.

**Two AI engines behind one interface.** Both emit the same stream of typed
parts — text, tool calls, waveforms, telemetry, spectra — and a registry maps
each type to a component. The default engine ships with the page and answers in
under 300 ms; the other downloads SmolLM2-135M-Instruct and runs it on your GPU,
behind an explicit click.

**All audio is synthesised**, ambient bed included. No files, no licences,
nothing to preload, and a hover tick that can be pitched per element — which a
sample cannot do without shipping one per variant.

## Swapping in a Blender render

The pipeline's seam is the *output contract*, not the scene. To replace the
procedural render with a photoreal one, drop these into `assets-src/out/` and
run `npm run assets:encode`:

- `aura_0001.png` … `aura_0120.png` — exactly 120 frames, square, **PNG RGBA
  with a transparent background** (`Film → Transparent`).
- `xray-outer.png` and `xray-inner.png` — 16:9, from an **identical camera**;
  the scanner cross-fades between them and any drift shows immediately.

Two constraints carry over. Render the shell in **neutral grey** — the finishes
are canvas composites, so a baked colour means re-rendering per variant. And
keep the phase boundaries: frames 1–36 rotate, 37–84 explode, 85–108 push into
the core, 109–120 reassemble. Caption timing in `src/data/story.ts` is asserted
against them by a unit test.

Hotspot anchors are re-projected by `npm run assets:prerender`; if the X-Ray
camera moves, regenerate `src/data/hotspots.json` rather than editing it.

## Layout

```
assets-src/device/     procedural Three.js scene + texture generators
scripts/               prerender, encode, budget audit, screenshots
src/lib/canvas/        frame player, worker decoder, LRU, tinting, particles
src/lib/scroll/        one rAF bus, Lenis integration, section progress
src/lib/ai/            part protocol, engine interface, both implementations
src/lib/audio/         AudioContext bus, synthesis, microphone capture
src/components/        one directory per section
src/data/              product data, story timing, generated manifests
```

## Notes

`npm audit` reports advisories in `onnxruntime-node` and its bundled `sharp`.
Both are Node-side transitive dependencies of `@huggingface/transformers`; only
the web build is ever imported, and only from the browser, so neither package is
loaded at runtime or at build time.

## Licence

Code MIT. `AURA ONE` is a fictional product invented for this project.
