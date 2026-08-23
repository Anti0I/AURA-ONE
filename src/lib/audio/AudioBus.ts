"use client";

/**
 * The page's single AudioContext.
 *
 * Browsers will not let a context start without a user gesture, and creating
 * one per sound leaks contexts until the tab is throttled — most browsers cap
 * you at a few dozen. So: one context, created lazily on the first gesture,
 * everything downstream routed through one master gain.
 *
 * ---
 *
 * There is exactly one way for this page to make a noise, and that is pressing
 * Play on one of the three acoustics demonstrations. There used to be more: an
 * ambient pad behind the whole site and a sound switch in the header to bring
 * it up. It went, and the reason is worth keeping written down — a drone that
 * runs for as long as the tab is open is not atmosphere, it is a thing the
 * visitor has to go and turn off, and a switch whose honest label would be
 * "start a drone" is not a feature.
 *
 * Losing the switch took the interface sounds with it, and that was not
 * collateral. Without a switch the only consent to audio is pressing Play, so
 * a tick fired by scrolling past the configurator would be either inaudible
 * (because nobody had pressed Play yet) or sound nobody asked for. Both are
 * arguments for deleting it, and the code for the pad and the ticks is gone
 * rather than left behind a flag.
 *
 * Everything that remains is synthesised. There is no audio file on this site
 * to load and no licence to check.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let bus: GainNode | null = null;

/** Quiet by design: this is a demonstration, not a soundtrack. */
const MASTER_LEVEL = 0.32;

/**
 * Creates the context if a gesture allows it. Returns null when audio is
 * unavailable — callers must treat sound as optional, never as a dependency.
 *
 * The master fades in rather than starting at level: a gain that jumps is a
 * step function, and a step function is broadband noise — an audible click.
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
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(MASTER_LEVEL, ctx.currentTime + 0.25);
  master.connect(ctx.destination);

  // A gentle limiter so overlapping voices cannot clip.
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

/** Releases everything. Called when the acoustics section unmounts. */
export function disposeAudio() {
  void ctx?.close();
  ctx = null;
  master = null;
  bus = null;
}
