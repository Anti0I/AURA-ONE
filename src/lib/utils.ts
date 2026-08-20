import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has no idea what is in our `@theme`, and its fallback for an
 * unrecognised `text-*` class is to assume it is a colour. That makes
 * `text-display text-ink` a conflict, and it silently drops the font size —
 * a headline rendering at 16px with no error anywhere.
 *
 * Registering our custom type scale is the fix. Worth knowing about: every
 * Tailwind v4 theme key that shares a prefix with a built-in group needs this.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "lead", "label"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Frame-rate independent damping. Plain `lerp(current, target, 0.1)` per frame
 * moves at a different speed on a 60 Hz and a 144 Hz display; this does not.
 */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

export const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;

/** Maps `v` from [inMin, inMax] to [outMin, outMax], clamped. */
export const mapRange = (
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
) => {
  if (inMax === inMin) return outMin;
  return clamp(
    outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin),
    Math.min(outMin, outMax),
    Math.max(outMin, outMax),
  );
};

export const easeOutExpo = (t: number) =>
  t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);

export const easeInOutQuart = (t: number) =>
  t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
