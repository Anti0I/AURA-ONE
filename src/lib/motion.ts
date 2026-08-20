/**
 * Environment capability probes.
 *
 * Every one of these is read once at mount and then cached on a module-level
 * object. They are deliberately *not* React state: nothing here changes often
 * enough to justify a re-render, and several are read from inside the render
 * loop where a hook subscription would be a per-frame cost.
 */

export type DeviceTier = "desktop" | "mobile";

export interface Environment {
  reducedMotion: boolean;
  coarsePointer: boolean;
  tier: DeviceTier;
  /** Capped at 2 — beyond that the extra pixels cost more than they show. */
  dpr: number;
  hasWebGPU: boolean;
  hasOffscreenCanvas: boolean;
  /** Rough proxy for "can this machine afford the full frame window". */
  memoryGB: number;
}

const SERVER_DEFAULT: Environment = {
  reducedMotion: false,
  coarsePointer: false,
  tier: "desktop",
  dpr: 1,
  hasWebGPU: false,
  hasOffscreenCanvas: false,
  memoryGB: 8,
};

let cached: Environment | null = null;

export function readEnvironment(): Environment {
  if (typeof window === "undefined") return SERVER_DEFAULT;
  if (cached) return cached;

  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const narrow = window.matchMedia("(max-width: 767px)").matches;

  cached = {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches,
    coarsePointer,
    // Tier follows viewport *and* pointer: a touch laptop is still desktop,
    // a landscape phone is still mobile.
    tier: narrow || (coarsePointer && window.innerWidth < 1024)
      ? "mobile"
      : "desktop",
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    hasWebGPU: "gpu" in navigator,
    hasOffscreenCanvas: typeof OffscreenCanvas !== "undefined",
    memoryGB:
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8,
  };

  return cached;
}

/** Invalidate the cache — only used by tests and by the orientation listener. */
export function resetEnvironment() {
  cached = null;
}

export function prefersReducedMotion(): boolean {
  return readEnvironment().reducedMotion;
}
