"use client";

/**
 * Per-frame telemetry, deliberately outside React.
 *
 * Producers mutate these fields directly — a property write, no allocation, no
 * notification, no re-render. Nothing on the page reads them: the only consumer
 * is `tests/perf`, through `window.__telemetry` under `?debug=1`.
 *
 * There used to be an on-page inspector that rendered them at 10 Hz through a
 * `useSyncExternalStore` subscription, and half of these fields existed for it
 * — frame rate, pointer position, heap size. The panel is gone, and rather than
 * leave numbers nobody computes for a reader nobody has, those fields went with
 * it. What is left is what measures the scrub, which is the one thing on this
 * site whose quality is not obvious by looking.
 */
export interface Telemetry {
  /** Nearest frame index the scroll is asking for. */
  frame: number;
  /**
   * Frame index actually on the canvas, which is not always the one asked for.
   *
   * The two separate during a fast scrub and have to come back together when
   * it stops: a walkthrough that settles on the wrong frame is a walkthrough
   * whose captions describe a different picture.
   */
  displayed: number;
  /** Un-rounded scroll->frame position, useful for spotting easing bugs. */
  frameFloat: number;
  /** 0..1 through the pinned scrollytelling section. */
  storyProgress: number;
  /** Milliseconds spent inside the canvas draw call, rolling average. */
  drawMs: number;
  /** Decoded bitmaps currently retained. */
  lruSize: number;
  lruBytes: number;
  /** Frames requested from the worker but not yet decoded. */
  decodeQueue: number;
  /** How far behind the playhead a requested frame lands, in frames. */
  lag: number;
  /**
   * Largest jump, in frames, between two consecutively *displayed* pictures.
   *
   * This is the number behind "it skips". A scrub that stays continuous holds
   * this at 1; one that falls behind the scroll and then catches up in a lump
   * reports the size of the lump. Measured on what actually reached the canvas,
   * substitutes from `nearest()` included — the substitute is what the visitor
   * sees, so it is what has to be counted.
   */
  frameGapMax: number;
  /** Total distance travelled in drawn frames, for a mean alongside the max. */
  frameGapSum: number;
  /**
   * Distance the playhead itself covered, in frames.
   *
   * The denominator that makes the rest of these mean something.
   * `framesDrawn / playheadTravel` is the fraction of the frames the scroll
   * crossed that actually reached the screen — 1.0 is every one of them, and
   * the reported symptom measured 0.01. Unlike a raw gap it does not simply
   * get worse on a slower machine: the player samples the timeline against its
   * own measured delivery rate, so a slow machine draws fewer, wider-spaced
   * pictures and still follows the scroll.
   */
  playheadTravel: number;
  /** Number of times a different picture reached the canvas. */
  framesDrawn: number;
  /**
   * Frames delivered by the worker, however they were used.
   *
   * The throughput of the whole chain — decode, composite, transfer, cache —
   * as opposed to the decode rate on its own. The gap between the two is where
   * a scrub is actually lost: VP9 decodes a packed frame here in 1.65 ms, so
   * anything well under 600/s is being spent somewhere after the decoder.
   */
  framesDecoded: number;
  /**
   * Frames that arrived after the playhead had already left them behind.
   *
   * Decoded, composited, transferred and cached for nothing — and worse, they
   * evict frames the playhead is about to reach. A healthy scrub keeps this
   * near zero; a scheduler working against the scroll makes it climb.
   */
  decodeWaste: number;
  canvasWidth: number;
  canvasHeight: number;
  dpr: number;
}

export const telemetry: Telemetry = {
  frame: 0,
  displayed: -1,
  frameFloat: 0,
  storyProgress: 0,
  drawMs: 0,
  lruSize: 0,
  lruBytes: 0,
  decodeQueue: 0,
  lag: 0,
  frameGapMax: 0,
  frameGapSum: 0,
  playheadTravel: 0,
  framesDrawn: 0,
  framesDecoded: 0,
  decodeWaste: 0,
  canvasWidth: 0,
  canvasHeight: 0,
  dpr: 1,
};

/**
 * Clears the scrub-quality watermarks.
 *
 * They are watermarks rather than rates, so a measurement has to say when it
 * started. Without this every reading carries the boot, where a gap of thirty
 * is normal and meaningless because the sequence has not arrived yet.
 */
export function resetFrameStats() {
  telemetry.frameGapMax = 0;
  telemetry.frameGapSum = 0;
  telemetry.playheadTravel = 0;
  telemetry.framesDrawn = 0;
  telemetry.framesDecoded = 0;
  telemetry.decodeWaste = 0;
}

/**
 * Publishes the live telemetry object on `window`, but only for `?debug=1`.
 *
 * Nothing on the page needs this. A test does: `window.__player` is stripped
 * from production builds
 * and CI builds production, which left the suite with no way to assert on
 * anything happening inside the canvas — and "it skips frames" is not a claim
 * the DOM can answer. Gating on a search parameter keeps a normal visit exactly
 * as it was, at the cost of one string comparison at boot.
 */
export function exposeTelemetry() {
  if (typeof window === "undefined") return;
  if (!new URLSearchParams(window.location.search).has("debug")) return;
  const w = window as unknown as Record<string, unknown>;
  w.__telemetry = telemetry;
  w.__resetFrameStats = resetFrameStats;
}

