import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
