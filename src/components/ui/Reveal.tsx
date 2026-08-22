"use client";

import { useEffect, useMemo, useRef, type ElementType } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { prefersReducedMotion } from "@/lib/motion";
import { useClientValue } from "@/lib/useClientValue";
import { clamp, cn, easeOutExpo } from "@/lib/utils";

/**
 * Word-by-word entrance for a line of copy, driven by the shared frame loop.
 *
 * Triggered by intersection and then run on time, rather than tied to scroll
 * position for its whole length. A reveal that is scroll-linked end to end
 * plays backwards when the visitor scrolls up a little, and reverses again on
 * the way down; text that flickers in and out while somebody is reading it
 * reads as a bug even when it is exactly what was asked for. The entrance
 * happens once, and once it has happened it stays.
 *
 * There is no GSAP here and no second rAF loop. `onFrame` is the page's one
 * loop, and the task removes itself the moment the last word lands — which is
 * why this is `onFrame` and not `onFrameWhileVisible`: the visibility gate
 * exists for animations with no natural end, and this one ends.
 *
 * Words carry a real space between them as a text node rather than being
 * padded with CSS, so the accessible text is character-for-character what was
 * passed in.
 *
 * The hidden starting state is only ever rendered when something exists that
 * will undo it. Markup shipped at `opacity: 0` waiting for script is invisible
 * copy for anyone whose script did not arrive, and invisible copy fails
 * silently — so the initial style comes from `useClientValue`, and the server,
 * a reduced-motion visitor and a browser with no script all get text that is
 * simply there.
 */

/** Per-word entrance, in seconds. */
const DURATION = 0.62;
/** Gap between consecutive words. Compressed so a long line still lands. */
const STAGGER = 0.028;
const MAX_TOTAL_STAGGER = 0.42;
/** How far each word rises, in em, so it scales with the type size. */
const RISE = 0.42;

export function Reveal({
  children,
  as: Tag = "span",
  className,
  id,
  delay = 0,
}: {
  /**
   * Plain text. Deliberately not `ReactNode`: splitting an arbitrary tree into
   * words means walking and rebuilding it, and every element that carries a
   * ref, an event handler or a nested component is a way for that to go
   * quietly wrong.
   */
  children: string;
  as?: ElementType;
  className?: string;
  /** Passed through so the heading can be an `aria-labelledby` target. */
  id?: string;
  /** Seconds to wait after the trigger, for staging several blocks. */
  delay?: number;
}) {
  const host = useRef<HTMLElement>(null);
  const willAnimate = useClientValue(() => !prefersReducedMotion(), false);
  // Capturing split, so the whitespace comes back as its own entry and can be
  // re-emitted verbatim.
  const parts = useMemo(() => children.split(/(\s+)/), [children]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const words = Array.from(
      el.querySelectorAll<HTMLElement>("[data-reveal-word]"),
    );
    if (words.length === 0) return;

    const settle = () => {
      for (const word of words) {
        word.style.opacity = "1";
        word.style.transform = "";
        word.style.willChange = "";
      }
    };

    if (prefersReducedMotion()) {
      settle();
      return;
    }

    const step = Math.min(STAGGER, MAX_TOTAL_STAGGER / words.length);
    const total = delay + step * (words.length - 1) + DURATION;

    let detach: (() => void) | null = null;
    let startedAt = -1;

    const run = () => {
      detach = onFrame((frame) => {
        if (startedAt < 0) startedAt = frame.time;
        const elapsed = frame.time - startedAt;

        for (let i = 0; i < words.length; i++) {
          const word = words[i]!;
          const t = easeOutExpo(
            clamp((elapsed - delay - step * i) / DURATION, 0, 1),
          );
          word.style.opacity = String(t);
          word.style.transform = `translate3d(0, ${((1 - t) * RISE).toFixed(3)}em, 0)`;
        }

        if (elapsed >= total) {
          // Cleared together, in one pass: `will-change` is a promise to keep a
          // compositor layer alive, and a paragraph left holding one per word
          // is the same mistake as the hero copy keeping its own.
          settle();
          detach?.();
          detach = null;
        }
      }, Priority.RENDER);
    };

    if (typeof IntersectionObserver === "undefined") {
      settle();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        run();
      },
      // Enough of the block has to be on screen for the entrance to be seen at
      // all; firing at the first pixel spends it below the fold.
      { rootMargin: "-8% 0px -12% 0px" },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
      detach?.();
    };
  }, [delay, parts]);

  return (
    <Tag ref={host} id={id} className={cn(className)}>
      {parts.map((part, i) =>
        /\s/.test(part) || part === "" ? (
          part
        ) : (
          <span
            key={i}
            data-reveal-word
            // `inline-block` so the transform applies at all — a transform on
            // an inline box is ignored — and the starting state is inline so
            // there is no flash of un-styled text before the effect runs.
            style={
              willAnimate
                ? {
                    display: "inline-block",
                    opacity: 0,
                    willChange: "opacity, transform",
                  }
                : undefined
            }
          >
            {part}
          </span>
        ),
      )}
    </Tag>
  );
}
