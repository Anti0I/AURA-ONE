import type { Metadata } from "next";
import Link from "next/link";
import manifest from "@/data/sequence.json";
import { PRODUCT } from "@/data/specs";
import { AUTHOR } from "@/data/author";
import { BUDGETS, asKB, asMB } from "@/data/budgets.mjs";
import type { SequenceManifest } from "@/types/sequence";

const SEQUENCE = manifest as SequenceManifest;

export const metadata: Metadata = {
  title: "Engineering notes",
  description:
    "How the AURA ONE page is built: worker-decoded frame sequences, a byte-budgeted bitmap cache, and a procedural render pipeline with no asset files behind it.",
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * The case study.
 *
 * Every figure below is read from `src/data/sequence.json`, which the encoder
 * writes — so this page cannot quote a frame count or a file size the build
 * disagrees with. That is the same rule the rest of the site follows, and it is
 * the reason to bother: a numbers page that drifts is worse than no numbers.
 */
export default function EngineeringPage() {
  const desktop = SEQUENCE.variants.desktop;
  const mobile = SEQUENCE.variants.mobile;
  const video = SEQUENCE.video;

  return (
    <main id="main" className="relative mx-auto max-w-3xl px-gutter py-24">
      <div aria-hidden className="noise-field" />

      <nav className="relative mb-16">
        <Link
          href="/"
          className="rule-label text-ink-dim transition-colors hover:text-signal"
        >
          ← {PRODUCT.name}
        </Link>
      </nav>

      <header className="relative">
        <p className="rule-label text-signal">Engineering notes</p>
        <h1 className="mt-5 text-title font-medium text-ink">
          What is actually going on here.
        </h1>
        <p className="mt-6 text-lead leading-relaxed text-ink-dim">
          {PRODUCT.name} is a fictional product. The page is not: it is a
          portfolio piece about scroll-driven canvas rendering, procedural
          asset generation and memory discipline, built with no paid services
          and no stock assets. These are the decisions worth defending, and the
          bugs worth admitting.
        </p>
      </header>

      <Section title="Constraints">
        <P>
          Three, fixed before anything was written. No paid API keys, for me or
          for anyone opening the page. Nothing may be downloaded that the
          visitor has not asked for. And every asset has to be generated from
          code, so the repository can be cloned and rebuilt from nothing.
        </P>
        <P>
          The third one turned out to be the most useful. A page with no stock
          photography and no bought 3D model has to earn its visuals, and the
          pipeline that produces them ends up being the interesting part.
        </P>
      </Section>

      <Section title="The frame sequence">
        <P>
          The product walkthrough is a canvas drawing pre-rendered frames
          against scroll position — the technique Apple uses, and the reason
          they use it is that a <Code>&lt;video&gt;</Code> element cannot be
          scrubbed frame-accurately. Setting{" "}
          <Code>video.currentTime</Code> asks the decoder to seek, and it
          answers whenever it feels like it, coalescing and dropping seeks
          under a fast scrub.
        </P>
        <P>
          The frames come from a Three.js scene driven through headless
          Chromium. Pixels are read with{" "}
          <Code>canvas.toDataURL</Code> rather than a page screenshot, because a
          screenshot loses the alpha channel and drags device-pixel-ratio
          rounding in with it.
        </P>

        <H3>The premise was never about the codec</H3>
        <P>
          Which is what the first version got wrong, at a cost of 9.95 MB.
          Everything above is true of the{" "}
          <Code>&lt;video&gt;</Code> <em>element</em>, not of video. WebCodecs
          hands you the decoder directly: <Code>VideoDecoder</Code> takes
          encoded chunks and returns frames, in order, with no seeking
          heuristics anywhere in the path. There is nothing left to be
          imprecise about.
        </P>
        <P>
          So the walkthrough plays a VP9 stream and keeps the stills as the
          fallback. What that buys is inter-frame prediction, and a slowly
          rotating object is about as predictable as content gets. The same 240
          frames cost under two fifths as much, which is what paid for doubling the frame
          count in the first place.
        </P>

        <Figures
          rows={[
            ["Source frames", `${SEQUENCE.sourceFrameCount} × 1440² PNG RGBA`],
            [
              "Desktop video",
              `${video.desktop.frameCount} frames · ${mb(video.desktop.bytes)} · ${video.desktop.codec}`,
            ],
            [
              "Mobile video",
              `${video.mobile.frameCount} frames · ${mb(video.mobile.bytes)}`,
            ],
            [
              "Same frames as WebP stills",
              "9.95 MB — 2.6× the video, for identical pictures",
            ],
            [
              "Still fallback",
              `${desktop.frameCount} / ${mobile.frameCount} frames · ${mb(desktop.totalBytes)} / ${mb(mobile.totalBytes)}`,
            ],
            ["Render time", "145 s, software WebGL"],
          ]}
        />

        <H3>No container</H3>
        <P>
          The chunks have to be got at somehow, and MP4 means shipping a
          demuxer — mp4box.js is around 60 KB gzipped. IVF is a 32-byte file
          header and twelve bytes before each frame, which is thirty lines of{" "}
          <Code>DataView</Code> and no dependency. Keyframe flags are read out
          of VP9&rsquo;s own uncompressed header rather than recorded at build
          time, so the file describes itself and there is nothing to keep in
          sync.
        </P>

        <H3>Alpha, which video does not have</H3>
        <P>
          Colour and matte are packed side by side in one frame with a black
          gutter between them, because 4:2:0 chroma is shared across two pixels
          and without the gutter the seam bleeds colour into the first column of
          matte. Recombining them needs luminance to become alpha, and a 2D
          canvas cannot do that — <Code>globalCompositeOperation</Code> only
          reads the source&rsquo;s alpha, which in the matte is opaque
          everywhere.
        </P>
        <P>
          So the decoded frame goes straight into a WebGL2 texture and both
          halves are sampled in one pass, in a worker, with no readback. What
          comes out is an ordinary <Code>ImageBitmap</Code> at exactly the size
          it will be drawn — which means the cache, the byte budget and the draw
          path never learn that any of this happened. The video is a new
          <em> source</em> of frames, not a new renderer.
        </P>

        <H3>WebP for the fallback, AVIF for the stills</H3>
        <P>
          AVIF is roughly 18% smaller per frame at matched quality, and for the
          two large X-Ray stills that is free — they are decoded once. For a
          scrubbed sequence it is the wrong trade: AVIF-with-alpha decodes about
          three times slower than WebP, and a fast scrub decodes several frames
          per frame of animation. Bytes are a one-time cost; decode is
          per-scrub, every scrub.
        </P>
      </Section>

      <Section title="Frames are discrete; scroll is not">
        <P>
          240 frames across a 460svh section is a new frame roughly every 12px
          of scroll. That reads as motion at speed and still visibly steps when
          somebody scrolls a line at a time — which is exactly when they are
          looking hardest.
        </P>
        <P>
          So the playhead kept its fractional position and the draw weighted the
          two frames it sat between. One extra <Code>drawImage</Code>, no extra
          bytes, and the step became a short dissolve. The defence written
          beside it was that this is not motion blur and only works because the
          movement between neighbours is small.
        </P>
        <P>
          That defence was never checked against the stream this page actually
          ships, and it is false. The walkthrough turns a full circle across the
          72 frames of its rotate phase, which is five degrees per frame, and
          the PSNR between neighbours is 20.7 dB where the encoder targets 47 dB
          against the master. Blending two pictures that far apart does not read
          as travel. It reads as a double exposure, and on the shipped frames
          the mic holes, the indicator and the port ring were all visibly
          doubled.
        </P>
        <P>
          It was worse standing still than moving, which is the opposite of what
          a motion effect should do. The playhead is damped towards the scroll
          position, and that position is an arbitrary fraction — so a stopped
          playhead settles at something like 137.43 and the canvas holds frame
          137 plus 43% of frame 138 <em>permanently</em>. The threshold was two
          percent, so almost every resting position kept a ghost. The report
          that started this was somebody scrolling slowly to look at one frame
          at a time, which is exactly the worst case.
        </P>
        <P>
          The part worth keeping is what the removal cost, because it is
          nothing. Walking the section in 40px wheel steps and counting distinct
          pictures gives 58 across 60 steps without the blend and 59 with it: a
          40px step already crosses about 2.8 frames of a 240-frame stream, so
          nearly every step lands on a different frame on its own. The
          87-against-48 figure this feature was justified by had compared the
          video source against the still fallback, which carries half the
          frames. It was a measurement of the frame count, not of the blend.
        </P>
        <P>
          Which leaves the step, and the honest answer is that the step is what
          a frame sequence is. At 240 frames it is small, it only appears when
          somebody is deliberately creeping down the page, and it is a
          truthful picture of one moment. The blend was a smaller step and a
          picture of no moment at all. The way to actually remove the step is
          to spend more frames on the part that moves fastest, which costs a
          re-render rather than a <Code>drawImage</Code> — a real decision,
          taken on its own terms, and not one to be smuggled in as a filter.
        </P>
      </Section>

      <Section title="The same pin, used twice">
        <P>
          The walkthrough is a 460svh section with one{" "}
          <Code>position: sticky</Code> child, and its progress is a single{" "}
          <Code>getBoundingClientRect</Code> per frame, read during the phase of
          the frame loop where layout reads are still free. That is the whole
          mechanism. There is no ScrollTrigger, no pin-spacer element and no
          plugin — about 30 KB of JavaScript and a class of refresh bugs
          avoided, for roughly forty lines.
        </P>
        <P>
          The acoustics section is the argument for having done it that way. It
          needed exactly the same behaviour — lock the frame, page three panels
          through it, let go at the end — and it cost a second call to the same
          hook.
        </P>
        <P>
          The first version of that paging cross-wiped one beat into the next,
          and it was wrong in a way that only shows up at reading speed. The exit
          of one beat and the entrance of the next ran over the same stretch of
          scroll — about 36svh, a dozen wheel notches — so anybody scrolling
          slowly stopped somewhere with half of one paragraph above half of
          another. Both were on screen. Neither could be read.
        </P>
        <P>
          The fix is not a shorter transition, it is a gap. Each beat now owns a
          window with empty scroll either side, so two of them cannot be present
          at once no matter where you stop. That leaves a stretch of the section
          with nothing on it, which in the old design would have read as a page
          that had broken — and is the reason the section is now a flight
          between three stations rather than a stack of three panels. The
          starfield behind runs at its fastest exactly where the copy is absent.
        </P>
        <P>
          One number does all of it. <Code>presence</Code> — how much beat text
          is on screen — scales the card, dims the field under anything being
          read, and gives the field its speed back the moment the reading is
          over. There is no second timeline to keep in step with the first,
          which is why the fastest part of the flight is reliably the part with
          nothing to look at but the flight.
        </P>
        <P>
          The stage is a scene rather than a slot. All three cards are in it the
          whole time, each parked in its own corner at its own depth, turning
          slowly on three axes behind a{" "}
          <Code>perspective: 1400px</Code>. The scroll brings them forward one
          at a time to dead centre, where the perspective distortion is exactly
          zero and the type is as sharp as if none of this were happening. A
          parked card shows its number and its title over a schematic grid and
          nothing else — the grid fades in as the paragraph fades out, so a card
          waiting its turn reads as an object rather than as a panel that failed
          to load.
        </P>
        <P>
          Coming towards you gets about twice the scroll that going away does,
          and the curve matters more than the distance did. The first version
          gave the approach a fifth of a station — a wheel notch and a half from
          parked to arrived — on <Code>easeInOutQuart</Code>, which sits near 0
          and near 1 and crosses the middle at four times the average rate. On
          that curve a scroll-driven approach reads as <em>nothing, snap,
          nothing</em> however much scroll it is handed. It now runs on a
          smoothstep, which is very nearly linear through the middle, so a notch
          of wheel buys a proportional step closer.
        </P>
        <P>
          The expensive part was not the part I suspected, and the measurement
          that said otherwise could not have found it. Frame times sampled with
          the scroll <em>parked</em> reported this section as free — and had to,
          because blending and rasterisation only happen while something is
          changing. Sampling while scrolling at a fixed rate, against a control
          scrolling at the same rate through a stretch where no card is moving,
          says something different.
        </P>
        <P>
          The suspicion was rasterisation: a compositor moves and turns a layer
          it has already rasterised for nothing, but a change of <em>scale</em>
          forces it to raster again to keep the text sharp. That is true, and it
          is why a parked card varies only its rotations. It was also not the
          problem — stepping the scale to cut those rasterisations moved the
          figure from 19.90 ms a frame to 19.90 ms a frame, so the step came
          back out again.
        </P>
        <P>
          What cost was blending. Any layer below full opacity has to be
          composited against whatever is behind it on every frame, and behind
          these cards is a canvas repainting sixty times a second — so the bill
          follows the card&rsquo;s <em>area</em>, which is precisely what coming
          forward increases. Translucent throughout, an approach ran at 19.90 ms
          with 24 long frames against a control at 16.69 ms with one. Opaque
          throughout: 16.62 ms and none. So the dimming now belongs to the
          parking spot rather than to the journey — a card lights up as it
          leaves its spot and travels solid. It is the better picture as well.
          The field showing through a card is depth when the card is small and
          clutter under a paragraph you are trying to read.
        </P>
        <P>
          The field costs nothing measurable beside it. 900 stars stroke as
          eight paths, because depth is quantised into four bands and brightness
          and line width are per-stroke state, so drawing them honestly would
          have meant one call per star.
        </P>
        <P>
          It is not pinned on a phone, and not for anyone who has asked for
          reduced motion. A section that demands three screens of scroll gesture
          to deliver three paragraphs is tiring on a small screen and hostile to
          somebody who turned motion down on purpose, so that case gets a flat
          list with every demonstration present at once — which is also the only
          version where all three controls are in the tab order together. On the
          pinned one, that job belongs to the rail.
        </P>
      </Section>

      <Section title="The scrub that could not keep up">
        <P>
          The report was specific: scroll the first section fast and the
          animation freezes, then jumps about twenty frames. The first thing
          worth doing with a claim like that is turning it into a number, so the
          player now counts what it draws — how far the scroll dragged the
          playhead, and how much of that distance the picture actually covered.
          On the code as it stood: <Numeric>0.10</Numeric>. The canvas moved
          twenty-four frames while the scroll crossed two hundred and
          thirty-nine.
        </P>

        <H3>The decoder was never the problem</H3>
        <P>
          The obvious suspect is the codec, so it went first: decoding all 240
          packed frames takes <Numeric>1.50 s</Numeric> single-threaded and{" "}
          <Numeric>0.40 s</Numeric> across cores — 160 and 604 frames per
          second against the 100 to 150 a hard wheel flick needs. Four times
          more than enough. Whatever was wrong was around the decoder, not
          inside it, and every hour that would have gone into the encoder was
          saved by twenty seconds of measurement.
        </P>

        <H3>Five faults, none of which errored</H3>
        <P>
          The container reader concatenated every network chunk onto a growing
          buffer and handed out views into it, so each frame kept its whole
          accumulator alive: <Numeric>181 MB</Numeric> retained and{" "}
          <Numeric>359 MB</Numeric> copied for a 3.87 MB stream, on the worker
          thread, during the hero.
        </P>
        <P>
          A decoder&rsquo;s queue is not a buffer, it is latency — a frame
          requested now comes out after everything already queued. Depth
          measured in frames hides that: twenty-four frames is 40 ms where a
          composite costs 1.65 ms and 900 ms where it costs 38, and both of
          those are real machines.
        </P>
        <P>
          The decode head runs ahead of the playhead on purpose, which means the
          frame on screen is usually <em>behind</em> it — and chasing that frame
          means resetting the decoder, which drops everything in flight. Then
          the scroll moves and it happens again. Measured as half a second in
          which the decoder ran flat out and delivered three frames.
        </P>
        <P>
          Requests were also aimed where the playhead had been rather than where
          it was going. A frame asked for at N arrives some time later, by which
          point the scroll is sixty frames further on — well outside the range
          the draw will substitute across, so the canvas had nothing to show and
          held its last picture.
        </P>
        <P>
          And the window telling the worker what was still wanted was posted{" "}
          <em>after</em> the requests it authorised. Messages are delivered in
          order, so the worker measured each request against the window it had a
          tick earlier and silently dropped exactly the frames that had just
          come into range. The player counted them as outstanding and never
          asked again: the playhead sat on frame 163 with the canvas showing
          149 and twenty-seven requests pending, permanently.
        </P>

        <H3>Two numbers, both measured at runtime</H3>
        <P>
          What replaced all of it is small. The player tracks how many frames a
          second the whole chain delivers and how long one round trip takes.
          Below the delivery rate it asks for every frame and nothing changes.
          Above it, the timeline is sampled to match, and each request aims
          ahead of the playhead by speed times latency, so the frame lands{" "}
          <em>at</em> the scroll instead of behind it.
        </P>
        <P>
          Neither can be a constant. The same build composites a frame in{" "}
          <Numeric>0.1 ms</Numeric> on a discrete GPU and{" "}
          <Numeric>32 ms</Numeric> on a software rasteriser — a factor of three
          hundred — and a figure chosen for either is wrong on the other. Keeping
          latency as a <em>time</em> rather than as a distance in frames matters
          for the same reason: a distance is only true at one scroll speed, so
          it has to be relearnt exactly when it is needed and has not converged
          yet. A time is a property of the machine, learnt during ordinary
          scrolling and already right when a flick begins.
        </P>
        <P>
          The fraction of the journey the picture covers went from{" "}
          <Numeric>0.10</Numeric> to <Numeric>1.00</Numeric>, on a GPU and on a
          software rasteriser alike, and the largest freeze from 148 frames to
          under 48. A slow machine now draws fewer, wider-spaced pictures and
          still follows the scroll end to end, which is the honest answer at a
          speed where nothing could draw all of them.
        </P>
      </Section>

      <Section title="Nothing animates off screen">
        <P>
          Three sections here animate on a loop with no natural end: the scanner
          sweeps, the configurator spins, the walkthrough holds a damped
          playhead. Written the obvious way, every one of them keeps drawing at
          the display&rsquo;s refresh rate for the rest of the session — several
          screens above the visitor, and in a background tab.
        </P>
        <P>
          It is invisible in every way except the one that matters, so it is
          worth measuring rather than reasoning about. Parked at the footer with
          every section mounted and none of them on screen, for three seconds:{" "}
          <Numeric>720</Numeric> full-bleed canvas clears and{" "}
          <Numeric>720</Numeric> layout reads, against none afterwards.{" "}
          <Code>content-visibility: auto</Code> does not help — it skips
          rendering the section, not the frame loop.
        </P>
        <P>
          Having written that bug three times, the gate now lives in one place
          and every loop goes through it.
        </P>
      </Section>

      <Section title="Memory">
        <P>
          An <Code>ImageBitmap</Code> holds uncompressed pixels, and unlike an
          ordinary object it is not reclaimed promptly: the backing memory lives
          outside the JS heap and is released only by{" "}
          <Code>close()</Code>. Holding all 240 frames at 1440² would pin about
          two gigabytes.
        </P>
        <P>
          So there is a windowed LRU with explicit eviction, and the unit tests
          assert on <Code>close()</Code> calls rather than on cache size — skip
          the call and everything still works, it just leaks until the tab dies.
        </P>

        <H3>A frame count is not a memory budget</H3>
        <P>
          A telemetry readout found this within a minute of existing: the cache
          was pinning 190 MB on an ordinary laptop viewport.
          Twenty-four frames is 39 MB decoded at 640² and 199 MB at 1440², so a
          cache sized by count alone is either wasteful on a small screen or
          dangerous on a large one — and it is the second one you hear about,
          from somebody else&rsquo;s machine. The cache now takes a byte budget
          alongside the count.
        </P>
        <P>
          Taking one was not the same as honouring one. The cache refused to
          evict anything inside the prefetch window — reasonably, since
          undershooting it guarantees a blank frame mid-scrub — which meant that
          whenever the window was larger than the budget could hold, the budget
          simply never applied. At 1440² that is 7.91 MB a frame and
          twenty-nine frames in the window: measured at{" "}
          <Numeric>189.8 MB</Numeric> against a stated ceiling of 160. A window
          expressed in frames and a ceiling expressed in bytes agree at exactly
          one decode size, and it is not the one on your own screen. The window
          is now sized from what the budget affords, and the budget wins if it
          ever comes to it.
        </P>
        <P>
          Frames are also decoded to the size they will be <em>drawn</em>, not
          the size they were encoded, using{" "}
          <Code>createImageBitmap</Code>&rsquo;s resize options. A bitmap costs
          the same whether or not anyone can see the detail.
        </P>
      </Section>

      <Section title="No ScrollTrigger">
        <P>
          The pinned section is <Code>position: sticky</Code>, which the browser
          composites for free, and progress is one{" "}
          <Code>getBoundingClientRect</Code> per frame read during the input
          phase before anything has written to the DOM. That is about forty
          lines, against roughly 30 KB of plugin, a pin-spacer element and a
          class of refresh bugs.
        </P>
        <P>
          The whole page runs on one animation loop with priority-ordered
          subscribers, so scroll position is integrated and read before anything
          draws with it. Independent{" "}
          <Code>requestAnimationFrame</Code> callbacks give you a one-frame lag
          between the canvas and the text pinned beside it — a small error that
          reads unmistakably as cheap.
        </P>
      </Section>

      <Section title="One scene, rendered two ways">
        <P>
          The configurator runs the scene live, because a pre-rendered
          turntable spins about one axis and cannot do anything else. Covering
          both axes as frames means an azimuth-by-elevation matrix — roughly
          6.5 MB for five discrete camera heights, which still is not the same
          thing as being able to look from anywhere.
        </P>
        <P>
          So the geometry has one definition and two renderers: baked offline
          for the walkthrough, where deterministic frames and a decode cost you
          can budget are what matter, and live here, where free interaction is.
          Change the shell and both change. three.js is ~135 KB gzipped and
          lands only in this section&rsquo;s chunk, so the first load is
          unchanged — but weight hiding in a lazy chunk is still weight, and the
          budget gate now has a ceiling on every chunk the build emits, not just
          the ones the document references.
        </P>
        <P>
          It draws only while on screen. An idle spin has no natural end, so
          without that it would keep rendering at the display&rsquo;s refresh
          rate several sections further down the page and in a background tab —
          spending someone&rsquo;s battery to animate what nobody is looking at.
        </P>

        <H3>Emissive is not lighting</H3>
        <P>
          Every part inside the shell was, for a long time, a flat base colour
          with its entire texture on <Code>emissiveMap</Code> — and it showed.
          An emissive pixel is self-lit: it ignores every light in the scene,
          takes no shading across a curve, throws no highlight and carries no
          depth. Three good drawings of a board, a die and a grille, stuck to
          three primitives, which is exactly how they read.
        </P>
        <P>
          Each generator now paints three canvases from one set of drawing
          calls — colour, packed roughness and metalness, and a height map that
          becomes a normal map through a Sobel pass — so the internals are lit
          by the same three lights as the shell. Roughness turns out to matter
          more than colour: bare gold at <Numeric>0.18</Numeric> against solder
          mask at <Numeric>0.78</Numeric> is what separates a pad from a board
          at a glance, and no amount of drawing does that while everything on
          the surface has the same gloss.
        </P>
        <P>
          It is not free. The frame at the end of the push-in went from{" "}
          <Numeric>78.5 KB</Numeric> to <Numeric>147.9 KB</Numeric>, and the
          video stream from <Numeric>3.30</Numeric> to{" "}
          <Numeric>3.87 MB</Numeric>. Both were checked for something cheap to
          give back before the budgets were moved: cutting the die&rsquo;s
          finest detail bought 5%, dropping WebP quality from 64 to 48 bought
          16% and cost visibly more than that, and splitting the frame in half
          priced the two halves in proportion to their area — the signature of
          a picture that is uniformly denser, not one with a hot spot. The
          frame costs more because it contains more.
        </P>

        <H3>The composite it replaced, which is still the fallback</H3>
        <P>
          Without WebGL the section falls back to the still sequence, recoloured
          while drawing: a brightness/contrast pass, a fill in{" "}
          <Code>color</Code> blend mode, an <Code>overlay</Code> pass to restore
          the gloss, then <Code>destination-in</Code> to clip back to the
          artwork&rsquo;s own alpha.
        </P>
        <P>
          That path is where the most useful thing this project learned about
          canvas lives. &ldquo;Matte Obsidian&rdquo; first shipped as polished
          silver, because <Code>color</Code> takes hue and saturation from the
          source and luminosity from the <em>backdrop</em> — it cannot darken
          anything. Filling a bright chrome render with near-black produces
          bright chrome and an imperceptible hue shift. Lightness comes from an
          explicit per-finish exposure instead, and a test measures mean canvas
          luminance so a dark finish has to be genuinely darker rather than
          merely different.
        </P>
        <P>
          Which is also why the fallback is detected by constructing a context
          rather than by asking whether the API exists, and why the live view
          reports its own failure: the machines that matter are the ones that
          claim WebGL and then decline to hand one over.
        </P>
      </Section>

      <Section title="The page that would not reach its own footer">
        <P>
          Smooth scrolling means intercepting the wheel and animating the
          scroll position yourself, which means owning a number the browser
          used to own: the maximum. Lenis caches{" "}
          <Code>scrollHeight - innerHeight</Code> and clamps every gesture to
          it. Dragging the native scrollbar does not go through any of that.
        </P>
        <P>
          This page grows a great deal after that measurement is taken. Three
          sections mount lazily from placeholders shorter than the real thing,
          the scanner carries <Code>content-visibility: auto</Code> so its
          height materialises on approach, and the preloader parks{" "}
          <Code>overflow: hidden</Code> on the root element — the element the
          library watches — for the whole of boot.
        </P>
        <P>
          The result was precise and easy to disbelieve: 400 wheel notches
          plateaued at 92.2% of the document, while the scrollbar still reached
          100%. Re-measuring from <Code>document.body</Code>, whose box actually
          tracks content, takes it to the bottom in 48. The fix is four lines;
          finding it meant reproducing it at a realistic scroll granularity,
          because a single coarse shove overshoots straight past the evidence.
        </P>
      </Section>

      <Section title="What the tests caught">
        <Numbered
          items={[
            <>
              <strong className="text-ink">
                The preloader could trap the page.
              </strong>{" "}
              Boot progress counted replies instead of checking the cache, so a
              resize — which makes the decoder discard everything in flight —
              left the counter permanently short and the overlay never released
              the scroll. Every mobile test failed; desktop never did, because
              the layout settled before the first measurement. Progress is now
              measured by what is resident, and there is a hard timeout, because
              an overlay that blocks scrolling must always let go.
            </>,
            <>
              <strong className="text-ink">
                The cache could evict its own prefetch.
              </strong>{" "}
              Frames land in whatever order the network returns them, and later
              arrivals were evicting earlier ones from the very window the
              playhead was heading into. Found by a unit test, fixed with a
              standing guard rather than by relaxing the test.
            </>,
            <>
              <strong className="text-ink">
                tailwind-merge silently dropped the hero&rsquo;s font size.
              </strong>{" "}
              It assumes any unrecognised <Code>text-*</Code> class is a colour,
              so <Code>text-display text-ink</Code> read as a conflict and the
              headline rendered at 16px with no error anywhere.
            </>,
            <>
              <strong className="text-ink">
                The eyebrow text failed contrast.
              </strong>{" "}
              A comment in the stylesheet said the token was for decoration
              only, and then it was used for the label on every section. The axe
              run settled it at 5.3:1.
            </>,
          ]}
        />
      </Section>

      <Section title="Budgets">
        <P>
          Enforced in CI. Deliberately close to reality — a budget with slack in
          it is a budget nobody respects.
        </P>
        <Figures
          rows={[
            ["First-load JS", `≤ ${asKB(BUDGETS.firstLoadJs)} gzip`],
            ["All JS chunks", `≤ ${asKB(BUDGETS.totalJs)} gzip`],
            [
              "Desktop video",
              `≤ ${asMB(BUDGETS.desktopVideo)} (now ${mb(SEQUENCE.video.desktop.bytes)})`,
            ],
            [
              "Mobile video",
              `≤ ${asMB(BUDGETS.mobileVideo)} (now ${mb(SEQUENCE.video.mobile.bytes)})`,
            ],
            [
              "Desktop still fallback",
              `≤ ${asMB(BUDGETS.desktopSequence)} (now ${mb(desktop.totalBytes)})`,
            ],
            [
              "Mobile still fallback",
              `≤ ${asMB(BUDGETS.mobileSequence)} (now ${mb(mobile.totalBytes)})`,
            ],
            ["X-Ray pair", `≤ ${asKB(BUDGETS.xrayPair)}`],
            ["Noise tile", `≤ ${asKB(BUDGETS.noise)}`],
            ["Audio", "0 bytes — synthesised"],
          ]}
        />
        <P>
          Every figure above is read from{" "}
          <Code>src/data/budgets.mjs</Code>, which is also the file the CI gate
          reads. This table used to be written out by hand, and it had drifted:
          it advertised a 5.50 MB sequence ceiling against a gate set at 5.00. A
          page contradicting its own build is the worst failure this project can
          have, and the fix for it is not proofreading.
        </P>
      </Section>

      <footer className="relative mt-20 border-t border-line pt-8">
        <p className="text-ink-dim">
          Built by{" "}
          <a
            href={AUTHOR.github}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:text-signal"
          >
            {AUTHOR.name}
          </a>
          .{" "}
          <Link
            href="/"
            className="underline decoration-line-strong underline-offset-4 transition-colors hover:text-signal"
          >
            Back to the product
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}

/* --------------------------------------------------------------- primitives */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="relative mt-16 border-t border-line pt-8">
      <h2 className="text-xl font-medium text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-8 text-base font-medium text-ink">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 max-w-[68ch] leading-relaxed text-ink-dim">{children}</p>
  );
}

/** An inline figure. Tabular numerals, so a paragraph of them stays even. */
function Numeric({ children }: { children: React.ReactNode }) {
  return (
    <span data-numeric className="text-ink">
      {children}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-ink">
      {children}
    </code>
  );
}

function Figures({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-6 divide-y divide-line overflow-hidden rounded-tile border border-line">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3"
        >
          <dt className="rule-label">{label}</dt>
          <dd data-numeric className="text-sm text-ink">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Numbered({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="mt-4 space-y-5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-4">
          <span data-numeric className="rule-label mt-1 shrink-0 text-signal">
            {String(i + 1).padStart(2, "0")}
          </span>
          <p className="max-w-[64ch] leading-relaxed text-ink-dim">{item}</p>
        </li>
      ))}
    </ol>
  );
}
