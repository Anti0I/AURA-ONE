"use client";

import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { telemetry } from "@/store/transient";
import { clamp, damp } from "@/lib/utils";
import { BitmapLRU } from "./BitmapLRU";
import { drawTinted } from "./tint";
import type { Material } from "@/data/materials";
import { frameUrl, type DecodeResponse, type SequenceVariant } from "@/types/sequence";

export interface PlayerOptions {
  /** How many decoded frames to retain. 24 ≈ 60–80 MB at typical sizes. */
  cacheSize?: number;
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
}

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

  /**
   * Bumped whenever the decode size changes. The worker drops anything from an
   * older generation, so a resize cannot poison the cache with wrong-sized
   * bitmaps.
   */
  private generation = 0;
  private decodeWidth = 0;

  /** Reused across frames — the draw loop allocates nothing. */
  private dest = { x: 0, y: 0, w: 0, h: 0 };
  /** Framing offsets as fractions of the canvas, plus a scale multiplier. */
  private framing = { x: 0, y: 0, scale: 1 };
  private tint: Material | null = null;
  private readonly wanted = new Set<number>();
  /** Reused guard set — rebuilt in place every frame rather than reallocated. */
  private readonly keep = new Set<number>();
  private pending = 0;
  private drawMs = 0;

  private preloadResolve: (() => void) | null = null;
  private preloadTotal = 0;
  /** Frames the boot is still waiting on. Membership, not a counter. */
  private readonly preloadNeeded = new Set<number>();
  private readonly failures = new Map<number, number>();
  private preloadTimeout = 0;
  private onPreloadProgress: ((ratio: number) => void) | null = null;

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
      lookAhead: options.lookAhead ?? 10,
      lookBehind: options.lookBehind ?? 4,
      damping: options.damping ?? 22,
      fill: options.fill ?? 0.86,
      reportTelemetry: options.reportTelemetry ?? false,
    };

    this.cache = new BitmapLRU(this.opts.cacheSize);
  }

  get frameCount() {
    return this.variant.frameCount;
  }

  start() {
    this.worker = new Worker(
      new URL("./decoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (e: MessageEvent<DecodeResponse>) =>
      this.onDecoded(e.data);
    this.worker.onerror = (e) => {
      console.error("[frame-decoder] worker failed:", e.message);
    };

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas);
    this.resize();

    this.detach = onFrame((f) => this.tick(f.delta), Priority.RENDER);
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
    this.preloadTotal = Math.min(count, this.variant.frameCount);
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

    this.layout();

    // Quantise the decode size to 160px steps. Without this, dragging a window
    // edge would invalidate the entire cache on every pixel of movement.
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
      Math.round(progress * (this.variant.frameCount - 1)),
      0,
      this.variant.frameCount - 1,
    );
  }

  private request(index: number, urgent: boolean) {
    if (index < 0 || index >= this.variant.frameCount) return;
    if (this.cache.has(index) || this.wanted.has(index)) return;

    this.wanted.add(index);
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
    if (message.generation !== this.generation) return;
    this.wanted.delete(message.index);
    this.pending = Math.max(0, this.pending - 1);

    if (message.type === "decoded") {
      this.cache.set(message.index, message.bitmap, message.bytes);
      if (message.index === this.lastDrawn) this.lastDrawn = -1;
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

    const index = this.frameIndex(this.current);
    this.prefetch(index);

    if (index !== this.lastDrawn) this.draw(index);

    if (this.opts.reportTelemetry) {
      telemetry.frame = index;
      telemetry.frameFloat = this.current * (this.variant.frameCount - 1);
      telemetry.storyProgress = this.target;
      telemetry.lruSize = this.cache.size;
      telemetry.lruBytes = this.cache.byteLength;
      telemetry.decodeQueue = this.pending;
      telemetry.drawMs = this.drawMs;
    }
  }

  private prefetch(index: number) {
    const ahead = this.direction > 0 ? this.opts.lookAhead : this.opts.lookBehind;
    const behind = this.direction > 0 ? this.opts.lookBehind : this.opts.lookAhead;

    this.request(index, true);
    for (let i = 1; i <= ahead; i++) this.request(index + this.direction * i, false);
    for (let i = 1; i <= behind; i++) this.request(index - this.direction * i, false);

    // Standing guard over the window we just asked for, so frames landing out
    // of order cannot evict each other before the playhead reaches them.
    this.keep.clear();
    for (let i = -behind; i <= ahead; i++) this.keep.add(index + this.direction * i);
    this.cache.protect(this.keep);
  }

  /**
   * Applies a finish to every drawn frame, or clears it with `null`.
   * See lib/canvas/tint.ts for why this is a draw-time composite.
   */
  setTint(material: Material | null) {
    this.tint = material;
    this.lastDrawn = -1;
  }

  private draw(index: number) {
    const start = performance.now();
    const bitmap = this.cache.get(index) ?? this.nearest(index);
    if (!bitmap) return;

    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.tint) {
      drawTinted(ctx, bitmap, this.dest, this.tint);
    } else {
      ctx.drawImage(bitmap, this.dest.x, this.dest.y, this.dest.w, this.dest.h);
    }

    this.lastDrawn = index;
    // Rolling average: a single slow frame should nudge the readout, not
    // spike it, or the HUD becomes unreadable noise.
    this.drawMs += (performance.now() - start - this.drawMs) * 0.1;
  }

  /**
   * Nearest cached frame either side of `index`.
   *
   * This is what keeps a fast scrub looking continuous rather than blinking:
   * showing a neighbouring frame for a few milliseconds is invisible, showing
   * an empty canvas is not.
   */
  private nearest(index: number): ImageBitmap | undefined {
    for (let offset = 1; offset <= 12; offset++) {
      const before = this.cache.peek(index - offset);
      if (before) return before;
      const after = this.cache.peek(index + offset);
      if (after) return after;
    }
    return undefined;
  }
}
