"use client";

import { AUTHOR } from "@/data/author";
import { PRODUCT } from "@/data/specs";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";

/**
 * Footer, and the place the page admits what it is.
 *
 * A fictional product page in a portfolio has to say so somewhere, plainly and
 * without irony, or it is just a lie with good typography. This is that
 * sentence, next to the two switches — the inspector and the palette — that
 * turn the page from a demo into something a technical reader can take apart.
 */
export function SiteFooter() {
  const devInspector = useAppStore((s) => s.devInspector);
  const toggleInspector = useAppStore((s) => s.toggleDevInspector);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  return (
    <footer className="relative border-t border-line px-gutter py-16">
      <div aria-hidden className="noise-field" />

      <div className="relative flex flex-wrap items-start justify-between gap-10">
        <div className="max-w-[46ch]">
          <p className="rule-label">{PRODUCT.name}</p>
          <p className="mt-4 text-lead leading-relaxed text-ink-dim">
            A concept product, built as a portfolio piece by{" "}
            <span className="text-ink">{AUTHOR.name}</span>. The hardware is
            fictional; the engineering is not — every frame, texture and sound
            on this page is generated from code, and there are no paid services
            behind any of it.
          </p>

          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
            <FooterLink href={`mailto:${AUTHOR.email}`}>Email</FooterLink>
            <FooterLink href={AUTHOR.github}>GitHub</FooterLink>
            <FooterLink href={AUTHOR.linkedin}>LinkedIn</FooterLink>
            <FooterLink href="/engineering">Engineering notes</FooterLink>
            {AUTHOR.cvUrl ? (
              <FooterLink href={AUTHOR.cvUrl}>CV</FooterLink>
            ) : null}
          </ul>
        </div>

        <div className="flex flex-col items-start gap-3">
          <button
            type="button"
            onClick={toggleInspector}
            aria-pressed={devInspector}
            className={cn(
              "rule-label rounded-full border px-4 py-2.5 transition-colors",
              devInspector
                ? "border-live text-live"
                : "border-line text-ink-dim hover:border-line-strong hover:text-ink",
            )}
          >
            [ Dev inspector: {devInspector ? "ON" : "OFF"} ]
          </button>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="rule-label rounded-full border border-line px-4 py-2.5 text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
          >
            Command palette · ⌘K
          </button>

          <p className="rule-label mt-2 max-w-[24ch] leading-relaxed">
            Frames, textures, PCB traces and every sound are generated at build
            time or synthesised in the browser.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const external = href.startsWith("http");
  return (
    <li>
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
        className="text-ink-dim underline decoration-line-strong underline-offset-4 transition-colors hover:text-signal hover:decoration-signal"
      >
        {children}
      </a>
    </li>
  );
}
