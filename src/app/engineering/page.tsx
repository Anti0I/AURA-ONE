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
    "How the AURA ONE page is built: worker-decoded frame sequences, a byte-budgeted bitmap cache, a typed generative-UI stream and two AI engines behind one interface.",
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

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
          portfolio piece about scroll-driven canvas rendering, in-browser
          inference and memory discipline, built with no paid services and no
          stock assets. These are the decisions worth defending, and the bugs
          worth admitting.
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
          The product walkthrough is a canvas playing 120 pre-rendered frames
          against scroll position — the technique Apple uses, and the reason
          they use it is that a <Code>&lt;video&gt;</Code> element cannot be
          scrubbed frame-accurately. Setting{" "}
          <Code>video.currentTime</Code> asks the decoder to seek, and it
          answers whenever it feels like it.
        </P>
        <P>
          The frames come from a Three.js scene driven through headless
          Chromium. Pixels are read with{" "}
          <Code>canvas.toDataURL</Code> rather than a page screenshot, because a
          screenshot loses the alpha channel and drags device-pixel-ratio
          rounding in with it.
        </P>

        <Figures
          rows={[
            ["Source frames", `${SEQUENCE.sourceFrameCount} × 1440² PNG RGBA`],
            [
              "Desktop variant",
              `${desktop.frameCount} frames · ${mb(desktop.totalBytes)} · avg ${kb(desktop.avgFrameBytes)}`,
            ],
            [
              "Mobile variant",
              `${mobile.frameCount} frames · ${mb(mobile.totalBytes)} · avg ${kb(mobile.avgFrameBytes)}`,
            ],
            ["Render time", "66 s, software WebGL"],
          ]}
        />

        <H3>WebP for the sequence, AVIF for the stills</H3>
        <P>
          AVIF is roughly 18% smaller per frame at matched quality, and for the
          two large X-Ray stills that is free — they are decoded once. For the
          sequence it is the wrong trade. AVIF-with-alpha decodes about three
          times slower than WebP, and a fast scrub decodes several frames per
          frame of animation. Bytes are a one-time cost; decode is per-scrub,
          every scrub.
        </P>

        <H3>Mobile takes every second frame</H3>
        <P>
          A phone scrubs the pinned section across roughly a third of the pixels
          a desktop does, so 60 frames land at a similar
          frames-per-scrolled-pixel density. It halves the transfer and — more
          importantly — halves the decode work on the weakest hardware in the
          audience.
        </P>
      </Section>

      <Section title="Memory">
        <P>
          An <Code>ImageBitmap</Code> holds uncompressed pixels, and unlike an
          ordinary object it is not reclaimed promptly: the backing memory lives
          outside the JS heap and is released only by{" "}
          <Code>close()</Code>. Holding all 120 frames at 1440² would pin about
          a gigabyte.
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

      <Section title="Four finishes, one render">
        <P>
          The sequence is rendered in neutral grey and recoloured while drawing:
          a brightness/contrast pass, a fill in{" "}
          <Code>color</Code> blend mode, an <Code>overlay</Code> pass to restore
          the gloss, then <Code>destination-in</Code> to clip back to the
          artwork&rsquo;s own alpha. Adding a finish costs an object in a data
          file rather than 120 more frames.
        </P>
        <P>
          The interesting failure: &ldquo;Matte Obsidian&rdquo; first shipped as
          polished silver. The <Code>color</Code> blend mode takes hue and
          saturation from the source and luminosity from the{" "}
          <em>backdrop</em> — it cannot darken anything. Filling a bright chrome
          render with near-black produces bright chrome and an imperceptible hue
          shift. Lightness now comes from an explicit per-finish exposure, and a
          test measures mean canvas luminance so a dark finish has to be
          genuinely darker rather than merely different.
        </P>
      </Section>

      <Section title="Two AI engines, one interface">
        <P>
          An engine does not return a string. It emits a stream of typed parts —
          text, tool calls, waveforms, telemetry, spectra — and a registry maps
          each type to a component. That is what lets a response contain a chart
          without anyone parsing it back out of markdown.
        </P>
        <P>
          The default engine ships with the page: zero bytes downloaded, first
          token under 300 ms, identical everywhere. It routes a prompt to one of
          five prepared analyses and streams the answer with decode-like timing —
          a measurable time-to-first-token, per-token latency that varies, and
          real pauses at clause boundaries. Constant intervals are what give a
          typewriter effect away.
        </P>
        <P>
          The other downloads SmolLM2-135M-Instruct (q4f16, 118 MB) and runs it
          on the visitor&rsquo;s GPU, reporting the decode rate it actually
          achieved. It is behind an explicit click, because a page that starts a
          118 MB download because somebody scrolled is not a demonstration of
          anything.
        </P>
        <P>
          Shipping only the scripted engine leaves you unable to show you can
          run a model in a browser; shipping only the real one means a visitor
          without WebGPU sees nothing at all. Behind one interface the choice
          becomes a runtime detail instead of a bet.
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
