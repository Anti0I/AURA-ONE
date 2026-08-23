# AURA ONE

<p align="left">
  <img src="https://img.shields.io/badge/Next.js_16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=threedotjs&logoColor=white" alt="Three.js" />
  <img src="https://img.shields.io/badge/WebGL2-990000?style=for-the-badge&logo=webgl&logoColor=white" alt="WebGL2" />
  <img src="https://img.shields.io/badge/WebCodecs-FF5722?style=for-the-badge&logo=w3c&logoColor=white" alt="WebCodecs" />
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="License" />
</p>

> **A high-performance product page for hardware that does not exist, built to demonstrate what does:** scroll-driven canvas rendering, procedural asset generation, and strict memory discipline.

Every single visual and audio asset is generated entirely from code. No stock photography, no purchased 3D models, no external HDRI maps, no audio sample files, and no paid API keys. Clone the repository and `npm run assets:all` rebuilds the entire suite from primitives.

The long-form architectural reasoning lives at `/engineering` (`src/app/engineering/page.tsx`), rendered directly from the build manifest to ensure documentation never drifts from code.

---

## Running Locally

    # Install dependencies
    npm install

    # Start local dev server (Turbopack)
    npm run dev

The encoded frame sequence is committed to the repository, so a fresh clone builds and deploys without requiring a headless render pass.

### Regenerating Assets from Source
To rebuild all assets directly from code primitives:

    npm run assets:all

| Command | What it does | Time |
| :--- | :--- | :--- |
| `npm run assets:noise` | 128² tileable noise → one palette-encoded PNG, 4.1 KB | Instant |
| `npm run assets:prerender` | Three.js scene via headless Chromium → 360 PNGs + X-Ray pair + hotspots | ~210 s |
| `npm run assets:encode` | Sharp → WebP/AVIF fallback variants + `public/seq/manifest.json` | ~35 s |
| `npm run assets:video` | FFmpeg → VP9 IVF streams with packed alpha channels | ~135 s |

> **Note:** `npm run assets:video` requires **FFmpeg** on your system PATH. Nothing else in the pipeline depends on external binaries.

---

## Verification & Testing

    # Fast-path verification: Typecheck, lint and 32 unit tests
    npm run verify

    # Full CI pipeline
    npm run build && npm run audit:budget && npm run test:e2e && npm run test:a11y && npm run test:perf

* **52 End-to-End Tests (Playwright):** Testing across desktop and mobile viewports. Canvas scrollytelling doesn't mutate the DOM (0 React re-renders), so tests assert on raw pixels: viewport coverage, frame fingerprints, and mean luminance.
* **10 Accessibility Tests:** Automated `axe-core` audit across layout chrome, lazy-mounted sections, engineering notes, skip links, keyboard navigation order, and `prefers-reduced-motion` paths.
* **2 Scrub-Performance Suites:** Dedicated isolated runner (1 worker) measuring playback continuity. Asserts on following ratios without CI machine noise.
* **`audit:budget` Gate:** Hard CI failure if JS bundles or binary streams exceed their committed ceilings.

---

## Performance Budgets

Enforced strictly in CI by `scripts/audit-budget.mjs` — a budget with slack is a budget nobody respects.

| Asset / Chunk | Budget Ceiling | Production Output |
| :--- | :--- | :--- |
| **First-load JS (gzip)** | 180 KB | 158.9 KB |
| **All JS chunks (gzip)** | 420 KB | 366.4 KB |
| **Desktop Video (VP9)** | 4.65 MB | 4.31 MB (360 frames) |
| **Mobile Video (VP9)** | 1.65 MB | 1.51 MB (360 frames) |
| **Desktop Still Fallback** | 5.40 MB | 4.97 MB (120 frames) |
| **Mobile Still Fallback** | 1.70 MB | 1.51 MB (60 frames) |
| **Peak Single Frame (Desktop)** | 160 KB | 148.0 KB |
| **X-Ray Pair (@2400px)** | 240 KB | 192.5 KB |
| **Noise Tile** | 6 KB | 4.1 KB |
| **Audio Files** | 0 KB | 0 KB (100% synthesized in Web Audio API) |

---

## Architectural Highlights

* **360-Frame Scrubbing via WebCodecs:** Native `<video>` elements cannot be cleanly scrubbed due to non-deterministic seek delays. Using `VideoDecoder` directly inside a Web Worker unlocks inter-frame prediction: **4.31 MB** for 360 frames vs **14.94 MB** as WebP stills.
* **Lightweight IVF Container Parser:** Parsing MP4 containers requires heavy client libraries (~60 KB gzipped for `mp4box.js`). IVF uses a 32-byte header and 12 bytes per frame — implemented in **30 lines of `DataView` with 0 dependencies**.
* **Zero-Readback Packed Alpha Channel:** Video codecs lack native alpha channels. Colour and matte are packed side-by-side with a black safety gutter, then recombined inside a WebGL2 worker shader into `ImageBitmap` primitives with zero GPU readback overhead.
* **Deterministic Scroll Bus (No GSAP / ScrollTrigger):** Pinned sections rely on native `position: sticky`. Progress is driven by a single `getBoundingClientRect` call per frame through a prioritized animation loop (`INPUT` → `RENDER` → `MEASURE`), completely eliminating layout thrashing and React re-renders.
* **Byte-Budgeted Bitmap Cache:** `ImageBitmap` memory lives outside the JS heap and is only released via explicit `.close()` calls. `BitmapLRU` bounds cache allocations by total decoded byte weight rather than frame counts (since 24 frames take 39 MB at 640² and 199 MB at 1440²).
* **Fully Procedural Lit PBR Internals:** Device components paint albedo, packed roughness/metalness, and height maps simultaneously in Canvas 2D (`willReadFrequently`). Height maps convert to normal maps via a custom Sobel pass, allowing internal chips and solder masks to react dynamically to scene lighting.
* **100% Synthesized Audio:** Sound is generated entirely via Web Audio API oscillators, biquad filters, and generated brown noise. An `AudioContext` is strictly created upon user interaction (clicking Play) and remains non-existent otherwise.

---

## Swapping in External 3D Renders (Blender)

The pipeline isolates content generation via an **output contract**. To replace procedural Three.js assets with photorealistic Blender renders, place files into `assets-src/out/` and run `npm run assets:encode`:

* `aura_0001.png` … `aura_0360.png` — exactly 360 square PNG RGBA frames with transparent backgrounds (`Film → Transparent`).
* `xray-outer.png` and `xray-inner.png` — 16:9 ratio, rendered from an **identical camera position**.

> **Key Constraints:** Shell must be rendered in neutral grey (finishes are applied at runtime via Canvas composite passes). Story phase boundaries must match frame indices: **1–108** (Rotate), **109–252** (Explode), **253–324** (Push into core), **325–360** (Reassemble).

---

## Repository Layout

    assets-src/device/     Procedural Three.js scene, geometry & texture generators
    scripts/               Prerender harness, VP9 video encoder, CI budget audit
    src/lib/canvas/        FrameSequencePlayer, BitmapLRU, IVF reader, WebGL2 matte shader
    src/lib/scroll/        Unified rAF bus, Lenis integration, visibility gates
    src/lib/audio/         AudioContext bus & real-time synthesis nodes
    src/components/        Code-split UI sections, X-Ray scanner, 3D live configurator
    src/data/              Hardware specs, story timeline & generated build manifests

---

## License

Code is licensed under the [MIT License](LICENSE).  
*AURA ONE is a concept device created by Antoni Kmuk as an engineering case study.*
