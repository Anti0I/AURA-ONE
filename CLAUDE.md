@AGENTS.md

# AURA ONE — working notes

A product page for hardware that does not exist, built as a portfolio piece
about scroll-driven canvas rendering, procedural asset generation and memory
discipline.

**`README.md` explains what the project is and how to run it. `/engineering`
(`src/app/engineering/page.tsx`) is the long-form reasoning for visitors. This
file is the part that is expensive to re-derive: the rules that break things
silently, the traps that already cost time, and where everything lives.**

**The founding constraint: every asset is generated from code.** No stock
photography, no purchased 3D model, no HDRI, no texture files, no audio files,
no paid API keys — for the author or for anyone opening the page. A change that
introduces a binary asset `npm run assets:all` cannot regenerate is a design
decision to stop and discuss, not a detail.

---

## Commands

```bash
npm run dev              # Next 16 dev server, Turbopack
npm run verify           # typecheck + lint + 32 unit tests — before every commit
npm run build            # production build
npm run audit:budget     # asset + JS budget gate; needs a build first
npm run test:e2e         # 52 Playwright tests, desktop + mobile (~7 min)
npm run test:a11y        # 10 axe / keyboard / reduced-motion tests
npm run test:perf        # scrub continuity, own config, one worker (~35 s)
npm run assets:all       # regenerate every asset (~6.5 min; needs ffmpeg)
node scripts/shoot.mjs   # screenshot the stage at five scroll positions
node scripts/check-clearance.mjs  # no part through a shell wall, every frame
```

`assets:*` is **not** part of the build. Neither `npm run build` nor CI touches
it — the encoded output is committed, so a clone deploys without a render. Run
it only after changing the 3D scene.

All three Playwright suites reuse a running server if there is one, and all need
`public/seq/` to exist. `test:perf` drives the page with `?debug=1`, the only
thing that puts the live telemetry object on `window`.

---

## Hard rules

These cause silent breakage rather than an error.

1. **Nothing that changes per frame goes through React state.** Per-frame values
   go straight to `style` on refs, or to the mutable `telemetry` object in
   `src/store/transient.ts`. A full scrub causes zero re-renders; keep it that
   way. Zustand is for discrete state only.

2. **There is exactly one animation loop**, `src/lib/scroll/rafBus.ts`. Never
   call `requestAnimationFrame` directly. Subscribers run in ascending priority:
   `INPUT` (0) may read layout, `RENDER` (100) may only write, `MEASURE` (200)
   observes the finished frame. Reading layout after a write in the same frame
   forces a synchronous reflow.

3. **`ImageBitmap` must be `close()`d.** Its memory lives outside the JS heap and
   GC will not reclaim it. `BitmapLRU` owns this; unit tests assert on `close()`
   calls rather than cache size, because skipping the call still *works* — it
   leaks until the tab dies.

4. **Frames decode to the size they will be drawn**, not the size they were
   encoded. A bitmap costs the same whether or not the detail is visible.

5. **The shell renders neutral grey in the baked frames.** A colour baked into
   the render means re-rendering all 360 per variant. `setFinish` overrides it
   live; the no-WebGL fallback composites it at draw time.

6. **The two frame sources must stay interchangeable.** `video.worker.ts` and
   `decoder.worker.ts` speak one protocol and both return `ImageBitmap`s at
   drawn size. Anything that makes the player branch on which is running has put
   the abstraction back where it started.

7. **Anything that animates on a loop is gated on visibility.** Use
   `onFrameWhileVisible` from `src/lib/scroll/onScreen.ts`, never `onFrame`, for
   anything with no natural end. This was the same bug four times — the scanner
   sweep, the configurator spin, the playhead, the meter. Measured parked at the
   footer with every section mounted: **720 `clearRect` and 720
   `getBoundingClientRect` in three seconds, against 0 after.**

8. **New below-the-fold sections are code-split.** Client wrapper +
   `next/dynamic({ ssr: false })` + `LazySection`, following
   `src/components/xray/XraySectionLazy.tsx`. Pass `LazySection` the section's
   `id` so the anchor exists before the section mounts.

9. **Numbers appear in one place.** `src/data/budgets.mjs` and the
   encoder-written manifests are what the page and `/engineering` read. Nothing
   on this site may quote a frame count or a file size the build disagrees with
   — a spec sheet contradicting the paragraph beside it is the worst failure
   this project can have.

---

## Traps

Every one of these cost real time, and all are still live.

### Canvas and rendering

**Canvas drawing is deferred, so the profile blames the wrong line.** A 2D
canvas queues paint calls and replays them on first use. If that first use is
`getImageData`, the whole bill — replay plus a synchronous GPU readback — lands
on the read. Timing `pcbTextures` put 4514 ms of a 4604 ms run inside the Sobel
pass and ~3 ms in all the drawing that fed it. So: any canvas that gets read
back needs `getContext("2d", { willReadFrequently: true })` (4604 ms → 58 ms,
one argument), and attributing cost inside a generator requires forcing a flush
at each mark. Of the three canvases per texture set, only the height map is read
into JS — the other two go to `texImage2D` — so the hint belongs on exactly one.

**Assigning to `canvas.width` resets the whole 2D context state.** Smoothing,
alpha, transform, composite mode — all of it, every time, including when you
assign the same value it already had. Anything set once in a constructor
survives until the first resize, and the first resize happens during boot.
`imageSmoothingQuality` is re-applied inside `resize()` for that reason.

**`globalCompositeOperation: "color"` cannot darken.** It takes hue and
saturation from the source and *luminosity from the backdrop*, so filling a
bright chrome render with near-black gives bright chrome and an invisible hue
shift. Lightness comes from `Material.exposure`, authored from the OKLab
lightness of the tint. See `src/lib/canvas/tint.ts`.

**WebGL compiles on first use, on the main thread.** Under ANGLE on Windows
the driver is the D3D compiler, and PMREM's 256-sample GGX filter is a loop it
unrolls: 704 ms in `fromScene`, then 716 ms more on the configurator's first
draw, both as long tasks mid-scroll. `stage.prepare()` compiles everything
through `compileAsync` first. Two traps inside that: a program key depends on
the bound render target (tone mapping and output colour space drop off-screen),
and on whether the geometry *has a position attribute* — three's own
`_compileMaterial` uses a bare `BufferGeometry` and so warms a program the
filter never uses. `fromScene` went 760 ms → 31 ms once both matched.

**The explode is choreography, and it can walk a part through a wall.** With
everything moving at once the N1 core and the board left through the front of
the top shell and the driver through the bottom one, ~30 frames each way. Parts
now move in windows of the explode (`OPENS_FIRST`): enclosure first, internals
once the rims have cleared them. `node scripts/check-clearance.mjs` tests every
frame analytically against the shell's own superellipse; run it after touching
any part's position, direction or distance.

**Emissive is not lighting.** An `emissiveMap` is self-lit: it ignores every
light, takes no shading across a form, throws no specular and carries no depth.
Every internal part used to be a flat base colour with its whole texture on
`emissiveMap`, which is exactly why they read as decals stuck to primitives. A
texture becomes a surface only once it feeds `map`, `roughnessMap`,
`metalnessMap` and `normalMap`. Emissive still has a job — the X-Ray pose and
the push-in lift it to keep internals legible through the shell — but as a
stylisation on top of a lit surface, at a twentieth of its former strength.

**`use` is a React hook even in a file with no React in it.** Naming a local
helper `use()` makes `react-hooks/rules-of-hooks` fire on every call site:
fifty-three errors from `assets-src/device/textures.mjs`, a plain ESM module.
The helper is called `paint()`.

### The frame player

**The decode size quantises with `ceil`, and both halves matter.** It keeps the
decode at or above the drawn size so the canvas only scales *down*, and it holds
the whole hero-to-story framing sweep inside one 160px step — at dpr 1 on a
1080p panel the drawn square runs 817 to 929 px, and `ceil` calls both 960 where
`round` would call them 800 and 960 and invalidate the cache mid-animation.

**A frame count is not a memory budget.** The same 24 frames are 39 MB decoded
at 640² and 199 MB at 1440². `BitmapLRU` takes both a count and a byte ceiling.

**A guarded cache window bigger than the byte ceiling makes the ceiling
decorative.** `BitmapLRU` used to stop evicting once everything left was
guarded, so at 1440² (7.91 MB a frame, 29 in the window) it sat at 189.8 MB
against a stated 160. The guard beats the count limit and no longer beats the
byte limit; the player sizes its window from what the budget affords.

**A `subarray` pins the buffer it was cut from.** `IvfReader` used to
concatenate each network chunk onto a growing accumulator and hand out views
into it, so every frame kept its whole accumulator alive — **181 MB retained and
359 MB copied for a 4.31 MB stream**, on the worker thread, during the hero. It
copies each frame into a buffer of its own size now. Its queue uses a head
pointer rather than `shift()`: shifting is O(n) in queue length and the queue is
longest exactly when the chunks are smallest.

**A `VideoFrame` pins a decoder buffer** the same way. `onFrame` closes in a
`finally` on every path including early returns — hold a handful and the decoder
stalls on its own pool, silently.

**A decoder's queue is latency, not buffer.** It is a FIFO: a frame requested
now emerges after everything already queued. Depth in frames hides this — 24
frames is 40 ms of latency where a composite costs 1.65 ms and 900 ms where it
costs 38, and both are real machines. Depth is derived from measured per-frame
cost (`TARGET_QUEUE_MS`), not chosen — and that cost is the *larger* of the
compose time and the interval between decoder outputs. Sized on compose alone
(~1 ms) the queue went 32 deep; with a decoder at ~110 frames a second that is
290 ms in which the playhead moves on and the window drops the result, and a
forward flick showed nothing new for 2.2 s. A desktop decoding VP9 at ~380
frames a second never shows it, and CPU throttling does not slow the decoder:
reproducing it took a temporary 9 ms spin in `onFrame`, standing in for a
laptop's decoder.

**Skipping forward to a keyframe needs no reset.** A keyframe replaces every
reference, so it can follow any chunk; only going *back* has to drop the queue.
The forward skip used to be priced as a reset and was rarely taken. It is free
now — but measured on its own it did not fix the freeze above. Keyframe-only
striding (every rung on a GOP boundary) was also tried and dropped: better on
its best runs, a 1.2 s freeze and one stalled picture on its worst.

**A request has to aim where the playhead is going.** A frame asked for at N
arrives `latency` later, by which point the scroll is at N + speed × latency —
sixty frames on a software rasteriser against a `nearest()` search range of
twelve, so the canvas froze. Round-trip is measured as a *time*, not a distance
in frames: a distance is only true at one scroll speed, so it has to be relearnt
exactly when it is needed and has not converged.

**`nearest()` is asymmetric about the direction of travel**, not about the
index. Against the travel it covers the measured lag; with the travel it must
not, because the player aims ahead deliberately. A symmetric search showed frame
220 while the playhead was at 162. Which side counts as "stale" flips when the
scroll reverses.

**Never rewind while the sweep still has work ahead.** The decode head is
deliberately ahead of the playhead, so the frame on screen is usually *behind*
the head, and chasing it means `reset()`, which drops everything in flight —
then the playhead moves and it happens again. Measured as half a second in which
the decoder ran flat out and delivered three frames. `pickTarget` takes anything
ahead first and only rewinds when the sweep has genuinely run out.

**Scrolling back up is the expensive direction.** A frame decodes only from the
keyframe at or before it, so a reverse scrub asks for a descending ladder with
every rung behind the head. Serving the nearest rung first costs a reset per
frame; `pickTarget` goes to the bottom of the ladder instead, turning it into
one rewind and one forward sweep. Largest gap: 128–144 down to 42–80.

**postMessage is FIFO, so a window sent after the requests it authorises loses
them.** The worker measured each request against the window it had a tick ago
and silently dropped ones just come into range; the player counted those as
outstanding and never re-asked. Measured as the playhead on frame 163, canvas
showing 149, 27 requests pending, permanently. `prefetch` announces first, then
asks.

**The video scheduler needs to know what is already in flight.** Without it,
"you asked for that and it is coming" is indistinguishable from "that is behind
the head, rewind", and it picks the second. The first version reset the decoder
on every network chunk and produced not one frame without ever erroring —
resetting a decoder is perfectly legal. `inFlight` in `video.worker.ts` is that
distinction.

### Layout, CSS and motion

**What breaks `position: sticky` is `overflow`, and only `overflow`.** Measured
in the target browser, because this entry once claimed `filter` was the culprit
and that is false:

    filter: blur()             STICKS      overflow: hidden    BROKEN
    will-change: transform     STICKS      overflow-x: hidden  BROKEN
    transform: translateZ(0)   STICKS      overflow: clip      STICKS
    contain: paint             STICKS

This entry was measured because the previous version of it was *wrong* — written
from general knowledge, and trusted for months. **A false entry in a traps file
is worse than a missing one, precisely because it is trusted.**

`transform`, `filter` and `will-change` create a containing block for *fixed*
descendants; sticky is not fixed and positions against the nearest scrollport.
`overflow: hidden` makes an ancestor into that scrollport; `overflow-x: hidden`
bites because it computes `overflow-y` to `auto`. `overflow: clip` does not
create a scroll container and is the safe way to clip around something pinned.
Both pinned sections put `overflow-hidden` on the sticky element *itself*, which
is fine — it is ancestors that matter.

**A translucent layer over a canvas costs by area, every frame.** An element
below opacity 1 is a group the compositor blends against what is behind it, and
behind these cards is a canvas repainting sixty times a second — so the bill
follows the card's *area*, which is exactly what an approach increases:

    translucent throughout   19.90 ms/frame, 24 long   (control 16.69, 1)
    opaque throughout        16.62 ms/frame,  0 long   (control 16.60, 0)

So dimming belongs to the parking spot, not the journey: the fade lifts to fully
opaque over the first eighth of an approach.

**A scale change re-rasterises a layer; rotation and translation do not.** True,
and why a parked card varies only its rotations while scale and depth stay
frozen. But it was *not* what made the approach expensive — stepping the scale
to cut rasterisations moved the figure from 19.90 ms to 19.90 ms, and the step
was removed rather than kept as machinery that earns nothing.

**A `next/dynamic` child renders nothing while its chunk loads.** `LazySection`
drops its reserved height on mount, so without a `loading` placeholder of the
same height the wrapper collapsed to zero, the next placeholder slid into range
and mounted, and all three lazy sections mounted in one 1051 ms task while the
hero was still scrubbing. Every lazy wrapper passes `loading`.

**Beware which measurement you take.** The two entries above were nearly
recorded the wrong way round. Frame times sampled with the scroll *parked* said
the section cost nothing, and could not have said anything else — blending and
re-rasterisation only happen while something changes. The number that mattered
came from scrolling at a fixed rate against a control at the same rate through a
part of the section where nothing moves, A/B interleaved in one session, because
the machine drifts by more than the effect between runs.

**Check what a number actually measured before letting it justify a feature.**
The frame cross-fade was kept for months on an "87 against 48" figure. That
figure had compared the *video* source against the *still fallback*, which
carries half the frames — it was a measurement of the frame count and never of
the blend at all. Measured properly, the blend was worth 59 pictures against 58.

**`opacity` and `transform-style: preserve-3d` cannot share an element.**
Opacity is a grouping property, and a grouping property computes
`transform-style` back to `flat` — silently collapsing a card's front and back
faces into one plane, so the flip shows both at once and neither
`backface-visibility` nor z-order helps. There is no warning; the card simply
stops being a card. The acoustics cards put the transform and the 3D context on
one element and the fade on the faces inside it.

**A blur radius has to be quantised.** `opacity` and `transform` are compositor
properties and cost nothing per frame; `filter: blur()` re-rasterises the layer
at layer size on every distinct radius. `SectionHandoff` steps the radius so a
whole transition costs four or five rasterisations. At the ends the filter is
*removed*, not set to `blur(0px)` — a zero radius still promotes the element and
still runs the pass.

**`background-position` is not a compositable property**, and neither is
anything else you might reach for to move a texture. Animating it repaints the
element every step; `will-change: background-position` only gives it a layer to
repaint in. `mix-blend-mode` is worse — it forces the compositor to read the
backdrop, and the grain sits directly over the stage canvas. Move an oversized
child by `transform` instead, and compensate the overhang in
`background-position` or the tile lands on different pixels.

**`will-change` is a promise, not a hint you can leave on.** It holds a
compositor layer for as long as it is set. The hero copy and the four captions
are full-viewport elements; clear it in the same write that sets
`visibility: hidden`.

**An entrance and an exit across one boundary must be complements.** For
adjacent sections the incoming top edge and the outgoing bottom edge are the
same edge, so thresholds measured from the viewport top make `enter + exit` sum
to exactly 1. Measuring each from the nearest viewport edge looks equivalent and
is not: the incoming section was fully arrived before the outgoing one had begun
to leave.

**Two beats of the same story must never share a *readable* window.** Beat N's
exit and beat N+1's entrance used to run over the same ~36svh, in which half of
one paragraph sat above half of the next. Reported as "the text goes weird".
`stations.ts` keeps the windows disjoint.

The word *readable* is doing the work: all three beats are on screen at once,
parked in the scene at a third size and 0.46 opacity with everything but number
and title at zero — that is scenery. What must never be true is two of them
carrying body copy anybody could try to read.

This is the **opposite** of the section hand-off rule above, and the difference
is what is dissolving. Two backgrounds crossing read as one place becoming
another; two paragraphs crossing read as a fault. The gap disjoint windows leave
must be given something to do — the starfield runs fastest there. If a gap like
that has nothing to do, the transition is wrong rather than the gap.

**A clipped focus ring is the only feedback a keyboard user has about where they
are.** No call site here since the wipe was removed, but worth keeping in mind
anywhere an `overflow: hidden` mask meets a control.

**`tailwind-merge` and the custom type scale.** It assumes any unrecognised
`text-*` class is a colour, so `text-display text-ink` reads as a conflict and
the font size is silently dropped — a headline at 16px with no error anywhere.
`cn()` in `src/lib/utils.ts` registers the scale. Any new `@theme` key sharing a
prefix with a built-in group needs the same treatment.

### Audio

**Nothing may construct the AudioContext except a request for sound.** Interface
voices used to call `ensureAudio()`, so scrolling past the scanner built an
audio graph and a device handle. Nothing was audible, which is exactly why it
survived: a whole audio system created for silence, on a page that promises it
stays off until asked. The only caller of `ensureAudio()` is `playDemo`, and the
only caller of that is a click on Play.

**A role-name regex is a substring match, not a name match.** `{ name: /Sound/ }`
matched the audio toggle until the acoustics section added "Play — Sound keeps
its address.", then failed as a strict-mode violation in two suites at once.
Anchor these patterns at both ends.

### Tests and tooling

**A Playwright test can fail on its own budget rather than on its claim.** Two
failures reported as page faults — "the walkthrough never drew a frame" and
`frame.evaluate: Test timeout` — were both the default **30 s test timeout**
expiring around a cold boot and an axe pass over the longest document on the
site. Raising the *poll* timeout on the first achieved nothing, which is the
tell. Use `test.setTimeout()`.

**Fixed `waitForTimeout` in canvas tests is a flake generator.** Sleeps tuned on
an idle machine fail under a parallel run. Poll for the actual state: `scrubTo`
in `tests/e2e/stage.spec.ts` waits for the frame to *change and then settle* —
waiting only for stability exits immediately, because right after a scroll the
canvas still holds the previous frame and is briefly perfectly stable.

**Lenis owns the scroll position, so tests must not jump.** A programmatic
`window.scrollTo` gets pulled back towards Lenis's own target, and a test that
jumps measures somewhere other than where it thinks it is — that produced a very
convincing screenshot of the wrong frame. Drive with `mouse.wheel`, and converge
rather than aiming once; the inertial tail overshoots a single impulse.

**The e2e suite runs two workers on purpose.** Each decodes a 2896×1440 VP9
stream or renders three.js through software WebGL while reading pixels back. One
worker per core starves them, and starvation looks exactly like the regressions
the tests exist to catch.

**A performance test must not share the machine.** `tests/perf` has its own
config at one worker: run beside the rest of the suite it reported a largest gap
of 169 where alone it reports 42–80. It asserts on the *fraction of the
playhead's journey the picture covered* — the one figure that does not simply
get worse on a slower machine — and merely logs granularity, which does.

**A threshold in frame indices retunes itself silently.** The perf stall
detector counted frame indices; when the render went 240 → 360 frames the same
physical sweep spanned 638 indices where it spanned 425, and every gap grew by
half without anything changing. Thresholds go as a share of the journey.
Likewise `ivf.test.ts` reads `sequence.json` rather than hard-coding a count.

**Headless Chromium composites in software, and it is ~300× slower.** WebGL in
the worker runs on SwiftShader: a packed-frame texture upload costs 32 ms there
against 0.1 ms on a discrete GPU. Profiling headless and optimising for what you
find is optimising for a machine nobody uses — check the renderer string before
believing a number. It cuts both ways: that gap is why CI budgets are looser
than the figures a real browser reports.

**`playwright.config.ts` needs `testMatch`.** `testDir: "tests"` otherwise picks
up `tests/unit` and fails on the first vitest import. It also has to leave
`perf/**` out, or the performance suite runs two-wide with everything else.

**Boot progress must be measured, not counted.** A resize bumps the decoder's
generation and the worker discards everything in flight, so counting replies
leaves the counter permanently short and the preloader never releases the page.
It only reproduces where layout settles late — every mobile test failed, desktop
never did. There is also a hard 12 s timeout, because an overlay that blocks
scrolling must always let go.

**Satori needs explicit `display: flex`** on any element with more than one
child, and JSX makes `{X}.` two children. `src/app/opengraph-image.tsx` uses
template literals to keep text nodes single.

**ESLint blocks `setState` inside effects.** For platform capabilities that never
change, use `useClientValue` (`src/lib/useClientValue.ts`), which wraps
`useSyncExternalStore`. Never write a ref during render either — construct
lazily inside a callback.

**Shell quoting has damaged files in this repo four times.** Twice a heredoc
broke on backticks while writing TypeScript. Once a `perl -0pi -e` replacement
ended with `$` immediately before a backtick — Perl read it as `$PREMATCH` and
pasted every preceding line of this file back into itself, duplicating the
document end to end. Once a `node -e` patch script carried literal `\n` escapes
outside any string. **Prose and code go through the editor, not a shell
one-liner.**

---

## Map of the code

```
assets-src/device/          procedural Three.js scene, imported live by the configurator
  scene.mjs                 geometry, materials, timeline, X-Ray poses, hotspot projection
  textures.mjs              albedo / roughness-metalness / normal sets per part
  index.html                render harness; importmap resolves into node_modules

scripts/
  prerender.mjs             headless Chromium → PNG frames + X-Ray pair + hotspots.json
  encode-sequence.mjs       sharp → WebP/AVIF fallback variants + manifests
  encode-video.mjs          ffmpeg → VP9 IVF streams, colour+matte packed (--crf, --gop)
  make-noise.mjs            128² tileable noise
  audit-budget.mjs          the budget gate; budgets live in src/data/budgets.mjs
  shoot.mjs                 screenshots at named scroll positions

src/lib/
  canvas/                   FrameSequencePlayer, BitmapLRU, tint, Particles, Starfield
                            decoder.worker (WebP stills) + video.worker (WebCodecs)
                            ivf.ts (container reader), matte.ts (WebGL2 recombine)
  scroll/                   rafBus (the one loop), scrollEngine (Lenis), useSectionProgress
                            onScreen (the visibility gate every loop goes through)
  audio/                    AudioBus (one context) + acoustics (the three demos)
  motion.ts                 cached environment probes; utils.ts: cn, damp, clamp, easings

src/components/             one directory per section, plus ui/
  configurator/             ConfiguratorLive (WebGL) + ConfiguratorFallback (stills)
  acoustics/                AcousticsPinned + AcousticsFlat + useAcousticsDemo (shared)
                            + stations.ts (beat windows, pure) + useStarfield
  ui/ProgressRail           phase rail, shared by both pinned sections
  ui/Reveal                 word-by-word text entrance, on the frame bus
  ui/SectionHandoff         scroll-driven cross-dissolve between sections

src/data/                   specs, materials, story timing, author, generated manifests
  budgets.mjs               every budget, read by the gate *and* by /engineering
src/store/                  useAppStore (Zustand, discrete) + transient (per-frame)

tests/  unit/ (vitest) · e2e/ a11y/ (two workers) · perf/ (own config, one worker)
```

`src/data/sequence.json` and `src/data/hotspots.json` are **generated**. Edit the
scene and re-run the pipeline; never hand-edit them.

---

## How the pieces work

**Stage.** Hero and scrollytelling share one canvas, so there is no seam between
"product at rest" and "product rotating". The pinned section is
`position: sticky` and progress is one `getBoundingClientRect` per frame during
INPUT. Camera framing is a per-tier table: desktop moves the product sideways to
make room for copy beside it, mobile moves it up because there is no beside.

**Two frame sources, one protocol.** `video.worker.ts` drives `VideoDecoder`
over a VP9 IVF stream; `decoder.worker.ts` fetches WebP stills. Both return
`ImageBitmap`s at drawn size, so the LRU, the byte budget and the draw path are
identical either way. The worker reports `unsupported` and the player swaps.
Which one won is on the canvas as `data-source`, because the fallback is
invisible when it works *and* when it breaks.

**Why a video, given the player exists because video cannot be scrubbed.** That
is true of the `<video>` *element*, not of video: `currentTime` is a request to
seek, `VideoDecoder` is not. Inter-frame prediction then costs 4.05 MB where the
same 360 pictures cost 14.23 MB as stills.

**Scheduling.** Everything the player does about a fast scrub comes from two
self-measurements: delivery rate in frames per second, and round-trip latency in
seconds. Below the delivery rate it asks for every frame. Above it, the timeline
is sampled at a stride matching what can arrive, and each request aims
`speed × latency` frames ahead so the frame lands *at* the scroll. Both are
properties of the machine, not constants — the same build composites a frame in
0.1 ms on a discrete GPU and 32 ms in software.

The visible consequence: a slow machine draws fewer, wider-spaced pictures and
still follows the scroll end to end. That following ratio is what `tests/perf`
asserts on. It was **0.10** before this work and is **1.00–1.08** now.

**Whole frames only.** The draw used to cross-fade the two frames the playhead
sat between. Removed: the walkthrough turns 5° a frame in its rotate phase (PSNR
20.7 dB between neighbours), so the blend read as a double exposure with the mic
holes and port ring visibly doubled — worse at rest than in motion, because
`damp()` settles on an arbitrary fraction and the ghost stays forever. It also
bought nothing: 58 distinct pictures across 60 wheel steps without it, 59 with.

**Frame count and format split.** 360 source frames, 120/60 stills, VP9 at
CRF 39, GOP 16. Each of those is load-bearing:

- More frames only help *slow* scrolling. A fast flick is decode-limited — the
  e2e scrub counts 48 distinct pictures across 60 steps at 240 frames and 48 at
  360. The gain is 13px per picture becoming 9px across the stage's 360svh.
- The still fallback held at 120/60 by taking a coarser stride (2→3, 4→6). For
  strides to stay whole numbers the master count must be a multiple of 120, so
  between 240 and 480 there is exactly one stop.
- CRF 39 rather than 36 saves 0.94 MB for **0.003 SSIM** against the render
  masters. The distance to the master is an order of magnitude larger at both
  settings, and is almost entirely 4:2:0 chroma subsampling.
- AVIF for the two X-Ray stills, WebP for the sequence: AVIF is ~18% smaller per
  frame but decodes ~3× slower with alpha, and a scrub decodes several frames
  per animation frame. Bytes are one-time; decode is per-scrub.

**Scanner.** Two renders from an identical camera, stacked, with a circular
window into the lower one. The lens is a fixed-size element that is
*translated*, and the copy of the artwork inside it is translated by exactly the
opposite amount — animating `mask-image` or `clip-path` position recomputes the
mask on the compositor's critical path every frame.

**Text entrance** is `Reveal`, on the shared frame bus. No GSAP, and not going
to be: ~40 KB gzip against 15 KB of first-load headroom, and it brings its own
ticker into a page whose ordering guarantees depend on there being exactly one.

**Acoustics.** The only claim on the site made in sound, shipping no audio bytes
— a sweep, brown noise with suppression engaging mid-clip, and a panned orbit,
all from oscillators and filters. The meter reads an `AnalyserNode` tapped off
the demos' own output stage rather than the master, so it reads the
demonstration and nothing else.

On a wide viewport the section is 520svh with a sticky frame; on a narrow one,
and under reduced motion, it is an ordinary stacked list. `AcousticsPinned` and
`AcousticsFlat` are separate components because they are genuinely different
documents — one keeps a single beat in the tab order, the other holds all three.
The rail matters more here than in the walkthrough: these beats contain their
own controls, so it is the only way to reach demos two and three without
scrolling.

**The acoustics stage is 3D and every beat is always in it.** Each card has a
parking spot — its own corner, depth and period — where it turns slowly behind a
`perspective: 1400px`. The scroll brings them forward one at a time to
`translate3d(0,0,0)`, dead centre, where perspective distortion is exactly zero
and the copy is as sharp as flat type. A parked card shows its number and title
over a schematic grid and nothing else; the grid is the inverse of the body
copy, so a card with its paragraph hidden reads as an object waiting rather than
a panel that failed to load.

The spin free-runs only while parked, and the angle it settles flat to is
latched at the same moment — if the spin kept accumulating on the way in, the
nearest whole turn would flip mid-approach and the card would snap through half
a rotation.

**One number carries it.** `presence` — 0 parked, 1 on the front — drives
position, depth, scale, how far the tumble may swing, brightness, whether body
copy exists, how fast the starfield runs, and how far the signal chain is out of
focus. There is no second timeline to keep in step, which is why the fastest
part of the flight is exactly the part with nothing to read. The chain's
defocus-and-resolve replaced the last hard cut in the section: driven from
scroll rather than a timer, it is reversible for free and cannot race the
gesture.

**Pacing.** Approach gets roughly twice the scroll the retreat does (`FADE_IN`
0.45 of a station against `FADE_OUT` 0.22 — about 54svh in, 26svh out). The
first version gave each a fifth of a station, ~15svh, and was reported as
happening instantly. But length alone would not have fixed it: the stage ran on
`easeInOutQuart`, which parks near 0 and 1 and crosses the middle at four times
the average rate, so a scroll-driven approach on it reads as *nothing, snap,
nothing* however much scroll it is given. `smoothstep` is nearly linear through
the middle. Before retuning: one approach is about six notches of a 100px wheel,
and six more costs 600px of document per beat.

**The read/write split is not optional here.** `onProgress` runs during INPUT
and writes only refs; a single RENDER task composes parking, approach and tumble
into one `transform` per card. It must be a separate task, because the tumble
runs whether or not anybody is scrolling and `useSectionProgress` deliberately
says nothing when progress has not changed — a stage driven from there alone
freezes the instant the page comes to rest.

**The starfield.** Fixed-pool discipline, like `Particles`. Stars are projected
from a depth `z` and drawn as the segment between where each is and where it was
a moment ago, so a stationary field is points and a scrolled one is streaks with
no switch between modes. Depth is quantised into four bands, each stroked as one
path, because brightness and line width are per-`stroke()` state — nine hundred
stars therefore cost eight calls.

**Audio** is entirely synthesised and there is exactly one way to hear any of
it: press Play on one of the three demonstrations.

---

## Asset pipeline

```bash
npm run assets:all   # noise → prerender (~210 s) → encode (~35 s) → video (~135 s)
```

The encoded output is committed; the ~348 MB of master PNGs in `assets-src/out/`
is gitignored. `assets:video` is the only step needing **ffmpeg**.

The four steps are not interchangeable and none is dead weight: `prerender`
produces the masters both other steps consume, `encode` produces the still
fallback **and the AVIF X-Ray pair the scanner section is built on**, `video`
produces the primary path, and `noise` produces the one 4 KB tile behind
`.noise-field`.

**Swapping in a Blender render** is covered in `README.md`. The constraint that
matters here: `src/data/story.ts` caption windows are asserted against the phase
boundaries by a unit test, so those boundaries are part of the contract.

---

## Testing

The scrollytelling cannot be checked by asserting on the DOM — everything that
matters happens inside a canvas React never re-renders — so those tests read
pixels: coverage, frame fingerprints, mean luminance.

- `tests/unit/` — LRU eviction, `close()` and the byte ceiling; the IVF reader
  across four chunkings; caption timing; station windows; damping.
- `tests/e2e/` — 52 tests, `desktop` and `mobile` projects. Includes deleting
  `VideoDecoder` to prove the still path still draws, and measuring *composed*
  opacity of every acoustics paragraph at fifteen scroll positions rather than
  trusting the fades follow the arithmetic.
- `tests/e2e/acoustics.spec.ts` also checks no `AudioContext` exists until one
  is asked for, counted by patching the constructor in an init script — because
  "the browser blocked us" and "we never tried" look identical from outside.
- `tests/perf/` — scrub continuity under a fast flick, own config, one worker.
- `tests/a11y/` — 10 tests: axe on the chrome, on every lazy section once
  mounted, on `/engineering`; plus skip link, keyboard reachability and the
  reduced-motion path.

Putting the station arithmetic in a pure module is what lets
`tests/unit/stations.test.ts` check the disjoint-window invariant at a thousand
scroll positions in a millisecond; forty browser positions at three seconds each
still only samples forty.

CI (`.github/workflows/ci.yml`) builds once and reuses it for all three
Playwright suites. There is no Lighthouse job: its stable categories are already
covered by axe and the budget gate, and a performance score from a shared runner
flaps enough that people learn to ignore it.

---

## Budgets

Declared in `src/data/budgets.mjs`, enforced by `scripts/audit-budget.mjs`,
quoted by `/engineering` and by `README.md`. One file because there are two
consumers that must not disagree — and they did once: the page advertised a
5.50 MB sequence ceiling against a gate set at 5.00.

Deliberately close to reality; a budget with slack is a budget nobody respects.
**The gate is the authority, not any table.** Run `npm run audit:budget` after a
build for current figures. The JS figure excludes Next's `noModule` core-js
bundle, which no targeted browser downloads.

---

## Conventions

- TypeScript strict, plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
  (use `import type`).
- Comments explain *why*, especially where the obvious implementation is wrong.
  Several traps above are documented at their call site; keep that.
- Design tokens live only in `src/app/globals.css`. No raw hex outside it,
  except where satori cannot read CSS (`opengraph-image.tsx`, commented).
- All numbers rendered to the user carry `data-numeric` for tabular figures.
- Conventional Commits; messages state what was found and fixed, not just what
  changed.
- **Commits are authored solely by the user** — no `Co-Authored-By` trailer and
  no mention of Claude Code in messages or PR bodies.

## Known items

- `assets-src/device/scene.mjs` is imported by the app through the `@device/*`
  alias and typed by a hand-written `scene.d.mts`. It stays plain ESM because
  the prerender harness serves it straight to headless Chromium through an
  import map; converting it would put a bundler back in the render path.
- Generating the six texture sets costs **195 ms** on a discrete GPU (board 51,
  die 40, brushed 32, cell 27, driver 26, grille 20) — one blocking chunk on the
  visitor's main thread, paid once when the configurator mounts. Sobel passes
  stay at 512² for that reason: a normal map is low-frequency, and matching the
  1024² albedo would quadruple the only pure main-thread JS here.
- The dev-only `window.__player` handle in `Stage.tsx` exists for
  `scripts/shoot.mjs` and devtools poking. It is stripped in production, which
  is why `?debug=1` exists separately: it publishes the live `telemetry` object
  as `window.__telemetry` in any build, and is what `tests/perf` measures
  through.
- `make-noise.mjs` asks the PNG palette for 8 greys and gets 4 — the quantiser
  merges what it judges indistinguishable at 3% opacity. `LEVELS` is a ceiling,
  not a result, and the script logs what it wrote rather than what it asked for.
- `public/seq/manifest.json` is read only by `scripts/audit-budget.mjs`. The app
  imports the bundled `src/data/sequence.json` instead, so the player needs no
  round-trip before its first frame.

---

## What was removed, and why

Deletions are decisions too, and these would otherwise look like something went
missing.

**A power model.** Battery capacity, per-mode draw figures and a runtime
integrator feeding an interactive tile and a generated PDF. Internally
consistent, and still invented — and an invented number presented as a
measurement is the one thing a portfolio piece cannot afford.

**An ambient pad and a sound switch.** A drone that plays until you turn it off
is not atmosphere, it is a chore. Losing it took the interface voices with it:
with no switch, the only consent to audio is pressing Play, so a tick fired by
scrolling would be either inaudible or unasked for.

**A dev inspector and a command palette.** Two switches in the footer that made
the page a toy for the person who built it. What the inspector measured is still
measured — `?debug=1` publishes the same object.

**Coordinates beside the cursor, and the crosshair.** A number that changes as
fast as your hand moves and means nothing to anybody reading it. Set dressing
pretending to be telemetry, on a site with real telemetry elsewhere.

**An electric cyan accent.** The colour every hardware concept page reaches for,
and most of the reason they all look alike. The accent is warm bone now, and the
change went all the way down: the PCB traces, the die floorplan and the core's
emissive material were regenerated, because a bone interface over a cyan product
reads as a mistake rather than a choice.
