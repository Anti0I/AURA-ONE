import { SectionLabel } from "@/components/ui/SectionLabel";
import { PRODUCT } from "@/data/specs";

export default function Home() {
  return (
    <main id="main" className="relative min-h-dvh overflow-hidden">
      <div aria-hidden className="noise-field" />
      <section className="flex min-h-dvh flex-col justify-center px-gutter">
        <SectionLabel index={1}>Design system online</SectionLabel>
        <h1 className="mt-8 max-w-[16ch] text-display font-medium text-ink">
          {PRODUCT.name}.{" "}
          <span className="text-ink-faint">{PRODUCT.tagline}</span>
        </h1>
        <p className="mt-8 max-w-[46ch] text-lead text-ink-dim">
          Scaffold in place. Frame pipeline, scanner, playground and inspector
          land in the phases that follow.
        </p>
      </section>
    </main>
  );
}
