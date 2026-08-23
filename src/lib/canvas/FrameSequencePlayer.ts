"use client";

import { Priority } from "@/lib/scroll/rafBus";
import { onFrameWhileVisible } from "@/lib/scroll/onScreen";
import { telemetry } from "@/store/transient";
import { clamp, damp } from "@/lib/utils";
import { BitmapLRU } from "./BitmapLRU";
import { drawTinted } from "./tint";
import type { Material } from "@/data/materials";
import {
  frameUrl,
  type DecodeResponse,
  type SequenceVariant,
  type VideoVariant,
} from "@/types/sequence";

export interface PlayerOptions {
  /** Maximum decoded frames retained. */
  cacheSize?: number;
  /**
   * Maximum decoded pixels retained, in bytes.
   *
   * The binding constraint on a large display, and the reason a frame count on
   * its own is not a memory budget: the same 24 frames are 39 MB decoded at
   * 640² and 199 MB at 1440². Sized by count alone the cache is either
   * wasteful on a laptop or dangerous on a 4K panel — and it is the second one
   * you hear about, from somebody else's machine.
   */
  maxCacheBytes?: number;
  /** Frames to request ahead of the playhead, in the direction of travel. */
  lookAhead?: number;
  /** Frames to keep behind it, for scroll reversals. */
  lookBehind?: number;
  /**
   * Damping rate for the playhead. High enough to feel direct, low enough to
   * absorb the sub-pixel jitter a trackpad produces. Set to 0 to disable.
   */
  damping?: number;
  /** Fraction of the canvas the artwork fills. */
  fill?: number;
  /** Reports telemetry into the transient store. Off for secondary canvases. */
  reportTelemetry?: boolean;
  /**
   * VP9 stream to prefer over the still sequence.
   *
   * Omit it — as the configurator does — to force the stills. Otherwise the
   * player opens the video and silently falls back if the browser turns out
   * not to decode it.
   */
  video?: VideoVariant | null;
}

/**
 * Starting guess for end-to-end delivery, in frames per second.
 *
 * Only a starting guess: the real figure is measured from arrivals, because it
 * is not a property of the code. The same build delivers frames at wildly
 * different rates depending on whether the composite lands on a GPU or on a
 * software rasteriser — measured here at 0.1 ms per frame on a discrete GPU
 * against 32 ms on SwiftShader, a factor of three hundred. Hard-coding either
 * one would tune the site for a machine somebody else is not using.
 */
const INITIAL_DELIVERY_RATE = 60;

/** Bounds on the measured rate, so one strange interval cannot capture it. */
const MIN_DELIVERY_RATE = 10;
const MAX_DELIVERY_RATE = 400;

/**
 * Furthest the playhead may be led, in frames.
 *
 * The lead is derived from measurement, not chosen, so this only exists to stop
 * a pathological reading from aiming at the far end of the film.
 */
const MAX_LEAD = 60;

/** Starting guess for round-trip latency, in seconds. Replaced by measurement. */
const INITIAL_LATENCY = 0.05;

/** Bounds on it, for the same reason as the delivery rate's. */
const MIN_LATENCY = 0.004;
const MAX_LATENCY = 0.4;

/**
 * Coarsest sampling of the timeline.
 *
 * Sized against the worst gesture the page allows rather than a round number.
 * At 460svh the walkthrough is about 9 px of scroll per frame on a short
 * viewport, so one hard wheel flick can cross the entire 240-frame timeline
 * inside Lenis's glide. A stride of 6 cannot cover that on a machine
 * compositing in software, and what "cannot cover" looks like is the picture
 * freezing for a hundred and thirty frames and then jumping — which is the
 * reported bug, arrived at from the other direction.
 *
 * `nearest()` scales its search to match, so the substitute is never more than
 * half a stride from the frame actually wanted.
 */
const MAX_STRIDE = 24;

/**
 * The strides that may be chosen, coarsest last.
 *
 * Quantised rather than continuous, because the stride sets the *phase* of the
 * requested ladder as well as its spacing: a stride drifting 15, 16, 18, 20
 * asks for a different set of frames every tick, none of which supersedes the
 * last, and the worker's queue grows without bound with nothing ever leaving
 * it. Snapping to a short list means consecutive ticks mostly re-ask for frames
 * already in flight, which is free.
 */
const STRIDES = [1, 2, 3, 4, 6, 8, 12, 16, 24];

/**
 * Draws a scroll-driven frame sequence onto a 2D canvas.
 *
 * Deliberately not a React component and deliberately not driven by state:
 * `setProgress` is a plain method, the draw runs on the shared rAF bus, and
 * nothing in here ever causes a render. React's job is to mount the canvas and
 * get out of the way.
 */
export class FrameSequencePlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cache: BitmapLRU;
  private worker: Worker | null = null;
  private detach: (() => void) | null = null;
  private observer: ResizeObserver | null = null;

  private readonly opts: Required<PlayerOptions>;

  /** Where the scroll says we are, 0..1. */
  private target = 0;
  /** Where the playhead actually is after damping. */
  private current = 0;
  private lastDrawn = -1;
  private direction = 1;
  /** Previous tick's target, for measuring how fast the scroll is moving. */
  private lastTarget = 0;
  /** Playhead speed in frames per second, smoothed. See `stride`. */
  private speed = 0;
  /** Measured end-to-end delivery, in frames per second. See `stride`. */
  private delivery = INITIAL_DELIVERY_RATE;
  /** Timestamp of the previous arrival, for measuring the interval. */
  private lastArrival = 0;
  /** Previous tick's frame index, for measuring how far the playhead went. */
  private lastIndex = -1;
  /** Bytes one decoded frame costs at the current size, once one has landed. */
  private frameBytes = 0;
  /**
   * Round-trip time from asking for a frame to holding it, in seconds.
   *
   * The quantity that decides whether a fast scrub looks continuous, and the
   * one this player originally had no idea about. A frame asked for at index N
   * arrives `latency` later, by which point the playhead is at
   * `N + speed * latency` — and if that distance exceeds the range
   * `nearest()` will substitute across, the canvas has nothing to show and
   * holds its last picture until the scroll slows. Measured at 120 ms on a
   * software rasteriser, which at 400 frames a second is a lag of forty-eight
   * against a search range of twelve. That is the reported "it skips about
   * twenty frames", from the inside.
   *
   * Deliberately kept as a *time* rather than as a distance in frames. A
   * distance is only true at one scroll speed, so it has to be relearnt every
   * time the speed changes — which is exactly when it is needed and exactly
   * when it has not converged yet. A time is a property of the machine: it is
   * learnt during ordinary scrolling and is already right when a flick starts.
   *
   * It also cannot be derived from the delivery rate. Delivery is a throughput
   * and this is a latency: a pipeline handing back a frame every 30 ms can
   * still be handing back frames that were asked for 300 ms ago.
   */
  private latency = INITIAL_LATENCY;
  /** When each outstanding request was posted, for measuring `latency`. */
  private readonly requestedAt = new Map<number, number>();
  /** Inclusive bounds of the last window announced to the worker. */
  private lo = -1;
  private hi = -1;

  /**
   * Bumped whenever the decode size changes. The worker drops anything from an
   * older generation, so a resize cannot poison the cache with wrong-sized
   * bitmaps.
   */
  private generation = 0;
  private decodeWidth = 0;

  /** Reused across frames — the draw loop allocates nothing. */
  private dest = { x: 0, y: 0, w: 0, h: 0 };
  /** What the previous draw actually touched, so the next one can undo it. */
  private painted = { x: 0, y: 0, w: 0, h: 0 };
  /** Framing offsets as fractions of the canvas, plus a scale multiplier. */
  private framing = { x: 0, y: 0, scale: 1 };
  private tint: Material | null = null;
  private readonly wanted = new Set<number>();
  /** Reused guard set — rebuilt in place every frame rather than reallocated. */
  private readonly keep = new Set<number>();
  private pending = 0;
  private drawMs = 0;

  /**
   * Index of the picture currently on the canvas, or -1 for none.
   *
   * Distinct from `lastDrawn`, which is the frame the playhead *asked* for.
   * This is the one that reached the canvas, and the two differ whenever
   * `nearest()` substitutes — which is exactly when the scrub quality figures
   * below are worth anything.
   */
  private displayed = -1;

  private preloadResolve: (() => void) | null = null;
  private preloadTotal = 0;
  /** Frames the boot is still waiting on. Membership, not a counter. */
  private readonly preloadNeeded = new Set<number>();
  private readonly failures = new Map<number, number>();
  private preloadTimeout = 0;
  private onPreloadProgress: ((ratio: number) => void) | null = null;

  /** Frames in the source currently running. */
  private frames: number;
  private usingVideo = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly variant: SequenceVariant,
    options: PlayerOptions = {},
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.opts = {
      cacheSize: options.cacheSize ?? 24,
      maxCacheBytes: options.maxCacheBytes ?? 120 * 1024 * 1024,
      lookAhead: options.lookAhead ?? 10,
      lookBehind: options.lookBehind ?? 4,
      damping: options.damping ?? 22,
      fill: options.fill ?? 0.86,
      reportTelemetry: options.reportTelemetry ?? false,
      video: options.video ?? null,
    };

    this.cache = new BitmapLRU(this.opts.cacheSize, this.opts.maxCacheBytes);
    // The two sources do not necessarily carry the same number of frames —
    // mobile ships every third still but the full video — so the scroll-to-
    // index mapping has to follow whichever one is actually running.
    this.frames = this.opts.video?.frameCount ?? variant.frameCount;
  }

  get frameCount() {
    return this.frames;
  }

  /** Which source is running, for the inspector. */
  get source(): "video" | "stills" {
    return this.usingVideo ? "video" : "stills";
  }

  start() {
    // `VideoDecoder` in the worker is what actually matters, but probing here
    // avoids spawning a worker at all on a browser that has no chance.
    this.usingVideo =
      this.opts.video !== null && typeof VideoDecoder !== "undefined";
    this.spawn();

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas);
    this.resize();

    // Gated on the canvas being near the viewport. The playhead is damped and
    // the prefetch window is rebuilt every tick, so a settled player still does
    // real work — a set cleared and refilled, a cache guard reapplied — for as
    // long as the tab is open, on a section the visitor scrolled past minutes
    // ago.
    this.detach = onFrameWhileVisible(
      this.canvas,
      (f) => this.tick(f.delta),
      Priority.RENDER,
    );
  }

  /**
   * Starts the worker for the current source.
   *
   * Both workers speak the same protocol, so this is the only place that knows
   * there are two of them. `new URL(...)` has to be a literal on each branch:
   * the bundler resolves worker entry points statically, and a computed
   * specifier produces no chunk at all.
   */
  private spawn() {
    const worker = this.usingVideo
      ? new Worker(new URL("./video.worker.ts", import.meta.url), {
          type: "module",
        })
      : new Worker(new URL("./decoder.worker.ts", import.meta.url), {
          type: "module",
        });

    worker.onmessage = (e: MessageEvent<DecodeResponse>) =>
      this.onDecoded(e.data);
    worker.onerror = (e) => {
      console.error("[frames] worker failed:", e.message);
    };

    this.worker = worker;
    // Which source won, on the element itself. The dev-only `window.__player`
    // handle is stripped from production builds, and this is the one fact worth
    // being able to check in a production build — the still fallback is
    // invisible when it works and invisible when it breaks.
    this.canvas.dataset.source = this.usingVideo ? "video" : "stills";

    if (this.usingVideo && this.opts.video) {
      worker.postMessage({ type: "open", video: this.opts.video });
    }
  }

  /**
   * Swaps the video source for the still sequence.
   *
   * The worker reports this rather than the main thread probing for it, because
   * `VideoDecoder.isConfigSupported` is async and the answer is only ever
   * needed inside the worker. It resolves in a millisecond or two, well before
   * anything has been drawn, so the swap is invisible.
   */
  private fallBackToStills(reason: string) {
    if (!this.usingVideo) return;
    console.warn(`[frames] video source unavailable (${reason}); using stills`);

    this.usingVideo = false;
    this.worker?.terminate();
    this.worker = null;

    // Frame indices mean something different in the still sequence, so nothing
    // already decoded can be reused.
    this.cache.clear();
    this.wanted.clear();
    this.pending = 0;
    this.failures.clear();
    this.frames = this.variant.frameCount;
    this.lastDrawn = -1;
    this.lo = this.hi = -1;

    this.spawn();

    // Re-ask for whatever the boot was waiting on, remapped onto the new count.
    if (this.preloadResolve) {
      const total = Math.min(this.preloadTotal, this.frames);
      this.preloadTotal = total;
      this.preloadNeeded.clear();
      for (let i = 0; i < total; i++) {
        this.preloadNeeded.add(i);
        this.request(i, i === 0);
      }
    }
  }


  destroy() {
    window.clearTimeout(this.preloadTimeout);
    this.detach?.();
    this.observer?.disconnect();
    this.worker?.terminate();
    this.cache.clear();
    this.detach = null;
    this.observer = null;
    this.worker = null;
  }

  /** Scroll progress, 0..1. Safe to call many times per frame. */
  setProgress(p: number) {
    const next = clamp(p, 0, 1);
    if (next !== this.target) this.direction = next > this.target ? 1 : -1;
    this.target = next;
  }

  /** Jumps the playhead without damping — used on mount and on phase skips. */
  jumpTo(p: number) {
    this.target = this.current = clamp(p, 0, 1);
    // A deliberate jump is not a dropped frame, and it is not travel either.
    // Forgetting both stops it being reported as one.
    this.displayed = -1;
    this.lastIndex = -1;
  }

  /**
   * Repositions the artwork inside the canvas.
   *
   * Offsets are fractions of the canvas so they survive any viewport. This is
   * the camera-framing move a print designer would make: in the hero the
   * product sits off to one side to leave the headline clean air, and it
   * settles to centre as the walkthrough takes over. Cheaper and far more
   * controllable than re-rendering the sequence with a different framing.
   */
  setFraming(x: number, y: number, scale = 1) {
    if (
      x === this.framing.x &&
      y === this.framing.y &&
      scale === this.framing.scale
    ) {
      return;
    }
    this.framing.x = x;
    this.framing.y = y;
    this.framing.scale = scale;
    this.layout();
  }

  /**
   * Requests the opening frames and resolves once they are decoded. The
   * preloader shows real progress against this, not a fake timer: the number
   * on screen is the number of frames actually in memory.
   */
  preload(count: number, onProgress?: (ratio: number) => void): Promise<void> {
    this.preloadTotal = Math.min(count, this.frames);
    this.preloadNeeded.clear();
    this.failures.clear();
    this.onPreloadProgress = onProgress ?? null;

    for (let i = 0; i < this.preloadTotal; i++) {
      this.preloadNeeded.add(i);
      this.request(i, i === 0);
    }

    return new Promise((resolve) => {
      this.preloadResolve = resolve;

      // Hard escape hatch. The preloader blocks scrolling, so it must not be
      // able to trap the page — a flaky connection or an exhausted retry
      // budget has to end with the site usable, not with a stuck counter.
      this.preloadTimeout = window.setTimeout(() => {
        if (this.preloadResolve) {
          console.warn(
            `[frame-player] boot released with ${this.preloadNeeded.size} frame(s) outstanding`,
          );
          this.finishPreload();
        }
      }, 12_000);

      this.checkPreload();
    });
  }

  // ---- Internals ---------------------------------------------------------

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // Re-applied here, not set once in the constructor, because assigning to
    // `canvas.width` resets the whole 2D context state — smoothing, alpha,
    // transform, the lot. Set at construction it would survive exactly until
    // the first resize, and the first resize happens during boot.
    //
    // It earns its keep on a high-DPI display. The master is 1440 square and
    // the artwork is drawn at 1858 device pixels on a 1080p panel at dpr 2,
    // and 2477 on a 1440p one — the source cannot cover that, so the only
    // question is which upsampling filter runs. The default is "low", which is
    // bilinear.
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";

    this.layout();

    // Quantise the decode size to 160px steps. Without this, dragging a window
    // edge would invalidate the entire cache on every pixel of movement.
    //
    // `ceil` rather than `round`, and both halves of that matter. It keeps the
    // decode at or above the drawn size, so the 2D canvas only ever scales
    // *down* — the direction that loses nothing. And it holds the whole
    // hero-to-story framing sweep inside one step: at dpr 1 on a 1080p panel
    // the drawn square runs 817 to 929 px, and `ceil` calls both 960 where
    // `round` would call them 800 and 960 and invalidate the cache halfway
    // through the opening animation.
    const wantWidth = Math.min(
      this.variant.width,
      Math.max(320, Math.ceil(this.dest.w / 160) * 160),
    );

    if (wantWidth !== this.decodeWidth) {
      this.decodeWidth = wantWidth;
      this.generation++;
      this.wanted.clear();
      this.pending = 0;
      this.worker?.postMessage({ type: "drop", generation: this.generation });
      // Existing bitmaps are the wrong size but still better than a blank
      // canvas, so they stay until their replacements arrive.
      this.request(this.frameIndex(this.current), true);
      // Anything the boot is still waiting on was just discarded in flight.
      for (const index of this.preloadNeeded) this.request(index, false);
    }

    if (this.opts.reportTelemetry) {
      telemetry.canvasWidth = w;
      telemetry.canvasHeight = h;
      telemetry.dpr = dpr;
    }

    this.lastDrawn = -1; // force a redraw at the new size
  }

  /** Recomputes the destination rect. Writes into `dest` — no allocation. */
  private layout() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;

    // The artwork is square and letterboxed into the canvas.
    const side = Math.round(Math.min(w, h) * this.opts.fill * this.framing.scale);
    this.dest.w = side;
    this.dest.h = side;
    this.dest.x = Math.round((w - side) / 2 + w * this.framing.x);
    this.dest.y = Math.round((h - side) / 2 + h * this.framing.y);
    this.lastDrawn = -1;
  }

  private frameIndex(progress: number) {
    return clamp(
      Math.round(progress * (this.frames - 1)),
      0,
      this.frames - 1,
    );
  }

  private request(index: number, urgent: boolean) {
    if (index < 0 || index >= this.frames) return;
    if (this.cache.has(index) || this.wanted.has(index)) return;

    this.wanted.add(index);
    this.requestedAt.set(index, performance.now());
    this.pending++;
    this.worker?.postMessage({
      type: "decode",
      index,
      url: frameUrl(this.variant, index),
      decodeWidth: this.decodeWidth,
      generation: this.generation,
      urgent,
    });
  }

  private onDecoded(message: DecodeResponse) {
    if (message.type === "unsupported") {
      this.fallBackToStills(message.reason);
      return;
    }
    if (message.generation !== this.generation) return;
    this.wanted.delete(message.index);
    this.pending = Math.max(0, this.pending - 1);

    if (message.type === "decoded") {
      telemetry.framesDecoded++;
      this.frameBytes = message.bytes;
      this.measureDelivery();
      this.measureLatency(message.index);
      // Arrived after the playhead had already left it behind: decoded,
      // composited and transferred for nothing, and about to evict something
      // still wanted. Counted rather than dropped — dropping it here would
      // waste the work twice.
      if (this.keep.size > 0 && !this.keep.has(message.index)) {
        telemetry.decodeWaste++;
      }
      this.cache.set(message.index, message.bitmap, message.bytes);
      // Redraw if what just landed is the frame being shown, or its neighbour —
      // `nearest()` may have substituted, and the real one is better.
      if (Math.abs(message.index - this.lastDrawn) <= 1) this.lastDrawn = -1;
    } else {
      // Two goes, then stop waiting on it. A frame that 404s must not hold the
      // boot open, and one that failed transiently deserves a second chance.
      const attempts = (this.failures.get(message.index) ?? 0) + 1;
      this.failures.set(message.index, attempts);
      if (attempts < 2) this.request(message.index, false);
      else this.preloadNeeded.delete(message.index);
    }

    this.checkPreload();
  }

  /**
   * Progress is measured by what is actually in the cache, not by counting
   * replies.
   *
   * A counter looks equivalent and is not: a resize bumps the generation and
   * the worker discards everything in flight, so those replies never arrive
   * and the counter stops short of its target forever. That is a preloader
   * that never lets go of the page — and it only reproduces when the layout
   * settles late, which is to say on phones and on slow font loads, and never
   * on the machine it was written on.
   */
  private checkPreload() {
    if (!this.preloadResolve) return;

    for (const index of this.preloadNeeded) {
      if (this.cache.has(index)) this.preloadNeeded.delete(index);
    }

    const done = this.preloadTotal - this.preloadNeeded.size;
    this.onPreloadProgress?.(
      this.preloadTotal === 0 ? 1 : Math.min(1, done / this.preloadTotal),
    );

    if (this.preloadNeeded.size === 0) this.finishPreload();
  }

  private finishPreload() {
    window.clearTimeout(this.preloadTimeout);
    this.onPreloadProgress?.(1);
    this.preloadResolve?.();
    this.preloadResolve = null;
    this.onPreloadProgress = null;
    this.preloadNeeded.clear();
  }

  private tick(delta: number) {
    this.current =
      this.opts.damping > 0
        ? damp(this.current, this.target, this.opts.damping, delta)
        : this.target;

    // How fast the scroll is dragging the playhead, in frames per second.
    // Measured on `target` rather than on `current`: the damped playhead is
    // what we are trying to keep fed, so the question is where the scroll is
    // going, not where the draw has got to.
    if (delta > 0) {
      const travelled =
        Math.abs(this.target - this.lastTarget) * (this.frames - 1);
      const instant = travelled / delta;
      // Rises instantly, decays slowly. Reacting late to a flick is the
      // failure this exists to prevent; returning to full detail a few frames
      // after the wheel stops costs nothing, because the eye has not settled
      // either.
      this.speed =
        instant > this.speed ? instant : damp(this.speed, instant, 5, delta);
    }
    this.lastTarget = this.target;

    const index = this.frameIndex(this.current);
    if (this.opts.reportTelemetry && this.lastIndex >= 0) {
      telemetry.playheadTravel += Math.abs(index - this.lastIndex);
    }
    this.lastIndex = index;
    this.prefetch(index);
    if (this.opts.reportTelemetry) telemetry.lag = this.lead();

    if (index !== this.lastDrawn) this.draw(index);

    if (this.opts.reportTelemetry) {
      telemetry.frame = index;
      telemetry.frameFloat = this.current * (this.frames - 1);
      telemetry.storyProgress = this.target;
      telemetry.lruSize = this.cache.size;
      telemetry.lruBytes = this.cache.byteLength;
      telemetry.decodeQueue = this.pending;
      telemetry.drawMs = this.drawMs;
    }
  }

  /**
   * How thinly to sample the timeline right now, in frames.
   *
   * At 14 px of scroll per frame a wheel flick crosses well over a hundred
   * frames inside Lenis's glide. Nothing decodes, composites and transfers a
   * hundred and fifty 2896x1440 frames a second, so the honest question at that
   * speed is not whether frames get dropped but *which* ones.
   *
   * A fixed dense window answers it badly. It asks for the twenty frames just
   * ahead of a playhead that is about to be eighty frames further on, so almost
   * everything it decodes is stale on arrival: the picture stalls, then jumps.
   * Spreading the same budget across the whole distance instead buys a coarser
   * but continuous move, which is what the eye actually reads at speed — and
   * the stride collapses back to 1 the moment the scroll slows, which is the
   * only time anyone can see individual frames anyway.
   */
  private stride(): number {
    if (this.speed <= this.delivery) return 1;
    const want = Math.min(MAX_STRIDE, this.speed / this.delivery);
    for (const step of STRIDES) if (step >= want) return step;
    return MAX_STRIDE;
  }

  /**
   * Updates the measured delivery rate from the interval between arrivals.
   *
   * Intervals longer than half a second are idle time, not slow frames — the
   * playhead has stopped and nothing is being asked for. Counting those would
   * drive the estimate towards zero while the page sits still, and then the
   * first flick after a pause would be sampled as coarsely as the machine is
   * slow, which it is not.
   */
  /** Updates the measured round-trip time from a frame that has just landed. */
  private measureLatency(index: number) {
    const posted = this.requestedAt.get(index);
    if (posted === undefined) return;
    this.requestedAt.delete(index);
    const took = (performance.now() - posted) / 1000;
    this.latency = clamp(
      this.latency + (took - this.latency) * 0.2,
      MIN_LATENCY,
      MAX_LATENCY,
    );
  }

  /**
   * How far ahead of the playhead to aim, in frames.
   *
   * Speed times latency, which is the distance the playhead covers while the
   * pipeline is fetching. Aiming this far ahead is what makes a frame arrive
   * *at* the playhead rather than behind it, and it needs no learning period:
   * both terms are already known when the flick begins.
   */
  private lead(): number {
    return Math.min(MAX_LEAD, Math.round(this.speed * this.latency));
  }

  private measureDelivery() {
    const now = performance.now();
    const gap = (now - this.lastArrival) / 1000;
    this.lastArrival = now;
    if (gap <= 0 || gap > 0.5) return;
    this.delivery = clamp(
      this.delivery + (1 / gap - this.delivery) * 0.08,
      MIN_DELIVERY_RATE,
      MAX_DELIVERY_RATE,
    );
  }

  /**
   * How many frames the byte budget can actually hold.
   *
   * The prefetch window is expressed in frames and the memory ceiling in bytes,
   * and the two only agree at one decode size. At 1440² a frame is 7.91 MB, so
   * the configured 20-ahead/8-behind window is 229 MB against a stated ceiling
   * of 160 — and because the cache refuses to evict inside its own window, the
   * ceiling could never take effect. The window is what has to give: a budget
   * that yields is not a budget, and this one is a promise about somebody
   * else's laptop.
   */
  private affordable(): number {
    if (this.frameBytes <= 0) return this.opts.cacheSize;
    return Math.max(
      6,
      Math.min(
        this.opts.cacheSize,
        Math.floor(this.opts.maxCacheBytes / this.frameBytes) - 1,
      ),
    );
  }

  private prefetch(index: number) {
    const step = this.stride();
    // Scaled to what memory allows, keeping the look-ahead/look-behind ratio.
    const room = this.affordable() - 1;
    const configured = this.opts.lookAhead + this.opts.lookBehind;
    const scale = configured > room ? room / configured : 1;
    const lookAhead = Math.max(2, Math.round(this.opts.lookAhead * scale));
    const lookBehind = Math.max(1, Math.round(this.opts.lookBehind * scale));

    const ahead = this.direction > 0 ? lookAhead : lookBehind;
    // Look-behind deliberately does *not* scale with the stride. It exists for
    // a scroll reversal, which is a slow-scroll behaviour — nobody flicks the
    // wheel hard and then immediately goes back. Scaled, it reached fifty
    // frames behind a playhead moving forwards at speed, and every one of those
    // is a request the decoder can only reach by rewinding.
    const behind = step > 1 ? 1 : this.direction > 0 ? lookBehind : lookAhead;

    // Snapped to a grid. Without it the ladder slides by one frame every tick,
    // so consecutive ticks ask for two interleaved sets and the decoder spends
    // its time being sent back for a frame it passed a millisecond ago.
    // Aimed at where the playhead will be by the time the frame arrives, not
    // where it is now. `lag` is measured from urgent frames that have already
    // landed, so this is a closed loop: aim further ahead, arrive less late,
    // and the lead shrinks back to nothing as the scroll slows.
    const aim = clamp(
      index + this.direction * this.lead(),
      0,
      this.frames - 1,
    );
    const anchor = step === 1 ? aim : Math.round(aim / step) * step;

    // Announced *before* the requests it authorises, and that order is the
    // whole point. postMessage is FIFO, so a window sent afterwards arrives
    // after them, and the worker measures each request against the window it
    // had a tick ago — silently dropping exactly the frames that have just come
    // into range. The player counts those as outstanding and never asks again,
    // so the picture stops dead while the playhead carries on: measured at a
    // playhead on frame 163 with the canvas showing 149, twenty-seven requests
    // pending, and no way out of it.
    this.announce(
      anchor - behind * step * this.direction,
      anchor + ahead * step * this.direction,
    );

    // Standing guard over the window we just asked for, so frames landing out
    // of order cannot evict each other before the playhead reaches them.
    this.keep.clear();

    this.request(anchor, true);
    this.keep.add(anchor);
    for (let i = 1; i <= ahead; i++) {
      const at = anchor + this.direction * i * step;
      this.request(at, false);
      this.keep.add(at);
    }
    for (let i = 1; i <= behind; i++) {
      const at = anchor - this.direction * i * step;
      this.request(at, false);
      this.keep.add(at);
    }

    this.cache.protect(this.keep);
  }

  /**
   * Tells the worker which frames still matter, and forgets the rest here too.
   *
   * A request used to leave the queue only by being satisfied, so during a fast
   * scrub the worker kept decoding frames the playhead had left behind — paid
   * for twice, because the result then evicts something still wanted. The
   * window is contiguous by construction, so two numbers say it.
   */
  private announce(a: number, b: number) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo === this.lo && hi === this.hi) return;
    this.lo = lo;
    this.hi = hi;

    // Boot owns the queue until it lets go. Its frames sit outside this window
    // by the end of the preload run, and cancelling them leaves the overlay
    // waiting on frames nobody is ever going to send.
    if (this.preloadResolve) return;

    for (const index of this.wanted) {
      if (index < lo || index > hi) {
        this.wanted.delete(index);
        this.requestedAt.delete(index);
        this.pending = Math.max(0, this.pending - 1);
      }
    }
    this.worker?.postMessage({ type: "window", lo, hi });
  }

  /**
   * Applies a finish to every drawn frame, or clears it with `null`.
   * See lib/canvas/tint.ts for why this is a draw-time composite.
   */
  setTint(material: Material | null) {
    this.tint = material;
    this.lastDrawn = -1;
  }

  /**
   * Draws one whole frame. Never a blend of two.
   *
   * This used to keep the playhead's fractional position and cross-fade the
   * two frames it sat between, on the stated grounds that "the movement
   * between adjacent frames is small". Measured on the stream we actually
   * ship, it is not: the walkthrough turns a full 360 degrees across the 72
   * frames of its rotate phase, which is **5 degrees per frame**, and the PSNR
   * between neighbours is 20.7 dB where the encoder targets 47 dB against the
   * master. Blending two pictures that far apart does not read as travel, it
   * reads as a double exposure — the mic holes, the indicator and the port
   * ring all visibly doubled.
   *
   * Worse at rest than in motion, which is the opposite of what a motion
   * effect should do. `damp()` converges on the scroll target, and the target
   * is an arbitrary fraction, so a stopped playhead settles at something like
   * 137.43 and the canvas holds frame 137 plus 43% of frame 138 *permanently*.
   * The threshold was `mix > 0.02`, so 98% of resting positions kept a ghost.
   *
   * Drawing whole frames also means `lastDrawn` is an index rather than a
   * position quantised to 1/32 of a frame: near a frame boundary the old
   * scheme could repaint the canvas 32 times for one change of picture.
   */
  private draw(index: number) {
    const start = performance.now();

    let shown = index;
    let bitmap = this.cache.get(index);
    if (!bitmap) {
      shown = this.nearest(index);
      if (shown < 0) return;
      bitmap = this.cache.peek(shown);
      if (!bitmap) return;
    }

    const { ctx } = this;
    // Only what was painted last time, not the whole canvas. At a 2x device
    // ratio the canvas is 8.3 Mpx and the artwork is a 1858² square inside it,
    // so clearing everything is three quarters of the fill wasted on pixels
    // that were already transparent — every frame, for the whole scrub.
    // The rect is inflated by one pixel because the destination is rounded and
    // a filtered edge can bleed half of one.
    const gone = this.painted;
    if (gone.w > 0) {
      ctx.clearRect(gone.x - 1, gone.y - 1, gone.w + 2, gone.h + 2);
    }

    if (this.tint) {
      drawTinted(ctx, bitmap, this.dest, this.tint);
    } else {
      ctx.drawImage(bitmap, this.dest.x, this.dest.y, this.dest.w, this.dest.h);
    }

    this.painted.x = this.dest.x;
    this.painted.y = this.dest.y;
    this.painted.w = this.dest.w;
    this.painted.h = this.dest.h;

    this.lastDrawn = index;

    // Scrub quality, measured on what the visitor actually saw. A continuous
    // scrub steps one picture at a time; one that falls behind the scroll and
    // then catches up reports the size of the lump it jumped.
    if (shown !== this.displayed) {
      if (this.displayed >= 0) {
        const gap = Math.abs(shown - this.displayed);
        if (gap > telemetry.frameGapMax) telemetry.frameGapMax = gap;
        telemetry.frameGapSum += gap;
        telemetry.framesDrawn++;
      }
      this.displayed = shown;
    }
    if (this.opts.reportTelemetry) telemetry.displayed = shown;

    // Rolling average: a single slow frame should nudge the readout, not
    // spike it, or the reading becomes unreadable noise.
    this.drawMs += (performance.now() - start - this.drawMs) * 0.1;
  }

  /**
   * Index of the nearest cached frame either side of `index`, or -1.
   *
   * This is what keeps a fast scrub looking continuous rather than blinking:
   * showing a neighbouring frame for a few milliseconds is invisible, showing
   * an empty canvas is not.
   *
   * Returns the index rather than the bitmap because the caller has to report
   * which picture reached the canvas, and a substitute is still a picture the
   * visitor saw.
   */
  private nearest(index: number): number {
    // Half a stride is the furthest the wanted frame can be from one that was
    // actually asked for, so the search only has to reach that far — and it
    // has to reach *at least* that far, or a coarse scrub shows a blank canvas
    // instead of a coarse one.
    // Asymmetric, and asymmetric *about the direction of travel*.
    //
    // Against the travel the search has to cover how far behind the pipeline
    // is, or the playhead is never near anything that has arrived and the
    // canvas holds its last picture. With the travel it must not: the player
    // aims ahead on purpose, so frames arriving early are frames the scroll has
    // not reached, and showing one is showing the future. Measured with a
    // symmetric search: the playhead at 162 and the canvas showing 220 — a jump
    // of 148 forwards, then the picture sitting still while the scroll caught
    // up with it. A slightly stale picture reads as weight; a premature one
    // reads as a glitch.
    //
    // Which side is "stale" flips when the scroll reverses, and getting that
    // wrong is not symmetric either: scrolling back up is the expensive
    // direction — a frame decodes only from the keyframe at or before it — so
    // it is the direction with the most catching up to do and the least margin
    // for looking the wrong way.
    const stale = -Math.sign(this.direction || 1);
    const far = Math.max(12, this.stride() + this.lead());
    const near = Math.max(2, this.stride());
    for (let offset = 1; offset <= far; offset++) {
      const behind = index + stale * offset;
      if (this.cache.peek(behind)) return behind;
      const forward = index - stale * offset;
      if (offset <= near && this.cache.peek(forward)) return forward;
    }
    return -1;
  }
}
