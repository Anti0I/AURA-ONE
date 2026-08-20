"use client";

/**
 * The page's single AudioContext.
 *
 * Browsers will not let a context start without a user gesture, and creating
 * one per sound leaks contexts until the tab is throttled — most browsers cap
 * you at a few dozen. So: one context, created lazily on the first gesture,
 * everything downstream routed through one master gain.
 *
 * Every sound on this site is synthesised. There is no audio file to load, no
 * licence to check and nothing to preload — which also means the ambient bed
 * starts the instant it is switched on rather than after a download.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let bus: GainNode | null = null;
let ambient: { stop: () => void } | null = null;

/** Quiet by design: this is texture, not content. */
const MASTER_LEVEL = 0.32;

/**
 * Creates the context if a gesture allows it. Returns null when audio is
 * unavailable — callers must treat sound as optional, never as a dependency.
 */
export function ensureAudio(): AudioContext | null {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }
  if (typeof window === "undefined") return null;

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;

  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  // A gentle limiter so a burst of overlapping ticks cannot clip.
  const shaper = ctx.createDynamicsCompressor();
  shaper.threshold.value = -18;
  shaper.ratio.value = 6;
  shaper.attack.value = 0.003;
  shaper.release.value = 0.14;
  shaper.connect(master);

  bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(shaper);

  return ctx;
}

/** Where every voice connects. Null until `ensureAudio` has succeeded. */
export function audioBus(): GainNode | null {
  return bus;
}

export function audioContext(): AudioContext | null {
  return ctx;
}

/**
 * Fades the master in or out over 400 ms. Toggling a gain to zero instantly
 * produces an audible click — the discontinuity is a step function, and a step
 * function is broadband noise.
 */
export function setAudioEnabled(enabled: boolean) {
  const context = enabled ? ensureAudio() : ctx;
  if (!context || !master) return;

  const now = context.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(enabled ? MASTER_LEVEL : 0, now + 0.4);

  if (!enabled) {
    // Let the fade finish before tearing the oscillators down.
    window.setTimeout(() => {
      ambient?.stop();
      ambient = null;
      void ctx?.suspend();
    }, 450);
  }
}

export function registerAmbient(handle: { stop: () => void } | null) {
  ambient?.stop();
  ambient = handle;
}

export function hasAmbient() {
  return ambient !== null;
}

/** Releases everything. Called on unmount. */
export function disposeAudio() {
  ambient?.stop();
  ambient = null;
  void ctx?.close();
  ctx = null;
  master = null;
  bus = null;
}
