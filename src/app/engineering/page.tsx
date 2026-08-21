import type { Metadata } from "next";
import Link from "next/link";
import manifest from "@/data/sequence.json";
import { PRODUCT } from "@/data/specs";
import { AUTHOR } from "@/data/author";
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
          Which is what the first version got wrong, at a cost of 9.09 MB.
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
          frames cost a third as much, which is what paid for doubling the frame
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
              "9.09 MB — 2.7× the video, for identical pictures",
            ],
            [
              "Still fallback",
              `${desktop.frameCount} / ${mobile.frameCount} frames · ${mb(desktop.totalBytes)} / ${mb(mobile.totalBytes)}`,
            ],
            ["Render time", "115 s, software WebGL"],
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
          So the playhead keeps its fractional position and the draw weights the
          two frames it sits between. One extra{" "}
          <Code>drawImage</Code>, no extra bytes, and the step becomes a short
          dissolve. It is not motion blur and only works because the movement
          between neighbours is small: at ten degrees of rotation apart it would
          read as a double image rather than as travel, which is half the reason
          the frame count went up as well.
        </P>
        <P>
          Measured by walking the section in 40px wheel steps and counting
          distinct pictures: 87 across 88 steps, against 48 for the still
          sequence over the same walk. That is what{" "}
          <Code>tests/e2e/sequence.spec.ts</Code> asserts, because
          &ldquo;smoother&rdquo; is not something the DOM can be asked about.
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
          The dev inspector on the main page found this within a minute of
          existing: the cache was pinning 190 MB on an ordinary laptop viewport.
          Twenty-four frames is 39 MB decoded at 640² and 199 MB at 1440², so a
          cache sized by count alone is either wasteful on a small screen or
          dangerous on a large one — and it is the second one you hear about,
          from somebody else&rsquo;s machine. The cache now takes a byte budget
          alongside the count.
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
            ["First-load JS", "≤ 180 KB gzip"],
            ["Desktop sequence", `≤ 5.50 MB (now ${mb(desktop.totalBytes)})`],
            ["Mobile sequence", `≤ 1.80 MB (now ${mb(mobile.totalBytes)})`],
            ["X-Ray pair", "≤ 240 KB"],
            ["Noise tile", "≤ 6 KB"],
            ["Audio", "0 bytes — synthesised"],
          ]}
        />
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
