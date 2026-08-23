import { AUTHOR } from "@/data/author";
import { PRODUCT } from "@/data/specs";

/**
 * Footer, and the place the page admits what it is.
 *
 * A fictional product page in a portfolio has to say so somewhere, plainly and
 * without irony, or it is just a lie with good typography. This is that
 * sentence, and next to it the only thing a reader might actually want from
 * the bottom of the page: who made it and how to reach them.
 *
 * No longer a client component. It used to hold the dev-inspector and command
 * palette switches, which meant it subscribed to the store; with those gone it
 * reads two constants and renders links, so it can be a server component and
 * ship no JavaScript at all.
 */
export function SiteFooter() {
  return (
    <footer className="relative border-t border-line px-gutter py-16">
      <div aria-hidden className="noise-field" />

      <div className="relative flex flex-wrap items-start justify-between gap-x-16 gap-y-10">
        <div className="max-w-[46ch]">
          <p className="rule-label">{PRODUCT.name}</p>
          <p className="mt-4 text-lead leading-relaxed text-ink-dim">
            A concept product, built as a portfolio piece by{" "}
            <span className="text-ink">{AUTHOR.name}</span>. The hardware is
            fictional; the engineering is not — every frame, texture and sound
            on this page is generated from code, and there are no paid services
            behind any of it.
          </p>
        </div>

        <div>
          <p className="rule-label">{AUTHOR.role}</p>
          <ul className="mt-4 grid gap-2">
            <FooterLink href={`mailto:${AUTHOR.email}`}>
              {AUTHOR.email}
            </FooterLink>
            <FooterLink href={AUTHOR.github}>GitHub</FooterLink>
            <FooterLink href={AUTHOR.linkedin}>LinkedIn</FooterLink>
            <FooterLink href="/engineering">
              Engineering notes — how this was built
            </FooterLink>
            {AUTHOR.cvUrl ? (
              <FooterLink href={AUTHOR.cvUrl}>CV</FooterLink>
            ) : null}
          </ul>
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
