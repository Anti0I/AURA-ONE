"use client";

import { ensureAudio, audioBus } from "./AudioBus";

/**
 * The three demonstrations in the acoustics section, synthesised.
 *
 * These are the only sounds the site makes. There were once interface voices
 * too — a hover tick, a lock, a sweep — in a `synth.ts` beside this; they went
 * with the sound switch, because without a switch the only consent to audio is
 * pressing Play, and a tick fired by scrolling is either inaudible or unasked
 * for.
 *
 * A demonstration has a lifetime a button noise does not: exactly one runs at a
 * time, it can be stopped, and it reports when it has finished so the control
 * can go back to offering it.
 *
 * Everything here is oscillators, filters and a generated noise buffer. The
 * founding constraint of this project is that no asset arrives as a file, and
 * an audio demonstration is where that is most tempting to break — five seconds
 * of street noise would be about 80 KB and half an hour of work. It would also
 * be a recording of somebody else's street, and the subject of the section is
 * the model, not the noise.
 */

export type DemoId = "sweep" | "cancel" | "space";

export interface DemoHandle {
  stop(): void;
}

/** Seconds each demonstration runs for. */
export const DEMO_SECONDS: Record<DemoId, number> = {
  sweep: 4.2,
  cancel: 6,
  space: 5.4,
};

let analyser: AnalyserNode | null = null;
let demoBus: GainNode | null = null;

/**
 * The demos' own output stage, tapped for the visualiser.
 *
 * Separate from the master so the meter reads the demonstration and nothing
 * else. A meter that moves when nothing was asked to play looks broken, and
 * this stage is also what makes "is it actually making a noise" answerable in
 * a headless browser with no audio hardware.
 */
function stage(ctx: AudioContext): GainNode | null {
  const bus = audioBus();
  if (!bus) return null;
  if (demoBus && analyser) return demoBus;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  // Long enough that the bars do not jitter, short enough that the sweep still
  // reads as a moving peak rather than a smear.
  analyser.smoothingTimeConstant = 0.72;

  demoBus = ctx.createGain();
  demoBus.gain.value = 1;
  demoBus.connect(analyser);
  analyser.connect(bus);
  return demoBus;
}

/** The tap the visualiser reads. Null until a demo has been started once. */
export function acousticsAnalyser(): AnalyserNode | null {
  return analyser;
}

/**
 * A logarithmic sweep across the driver's stated range.
 *
 * Logarithmic rather than linear because hearing is: a linear sweep spends most
 * of its time in the top octave, where there is least to hear, and crosses the
 * whole of the bass in the first fraction of a second.
 */
function sweep(ctx: AudioContext, out: GainNode): DemoHandle {
  const now = ctx.currentTime;
  const seconds = DEMO_SECONDS.sweep;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(38, now);
  osc.frequency.exponentialRampToValueAtTime(16_000, now + seconds);

  // Rough equal-loudness compensation. Without it the sweep is inaudible at the
  // bottom and painful at the top, which demonstrates the listener rather than
  // the driver.
  const shelf = ctx.createBiquadFilter();
  shelf.type = "highshelf";
  shelf.frequency.value = 3200;
  shelf.gain.value = -9;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.12);
  gain.gain.setValueAtTime(0.22, now + seconds - 0.25);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  osc.connect(shelf).connect(gain).connect(out);
  osc.start(now);
  osc.stop(now + seconds + 0.05);

  return {
    stop() {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      osc.stop(t + 0.1);
    },
  };
}

/**
 * Broadband rumble, then the same rumble with the model engaged.
 *
 * The suppression is a low-pass collapsing to 190 Hz with a matched drop in
 * level, which is what cancellation sounds like from the inside: the rumble
 * does not disappear, it loses its top and its presence. Modelling it as a mute
 * would be a more dramatic demonstration and a dishonest one.
 */
function cancel(ctx: AudioContext, out: GainNode): DemoHandle {
  const now = ctx.currentTime;
  const seconds = DEMO_SECONDS.cancel;
  const engageAt = now + seconds * 0.45;

  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Brown-ish noise: white noise integrated, which puts the energy low down
  // where cabin and traffic rumble actually lives.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.2;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.setValueAtTime(7200, now);
  tone.frequency.setValueAtTime(7200, engageAt);
  tone.frequency.exponentialRampToValueAtTime(190, engageAt + 0.55);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.5, now + 0.35);
  gain.gain.setValueAtTime(0.5, engageAt);
  gain.gain.exponentialRampToValueAtTime(0.075, engageAt + 0.55);
  gain.gain.setValueAtTime(0.075, now + seconds - 0.3);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  source.connect(tone).connect(gain).connect(out);
  source.start(now);
  source.stop(now + seconds + 0.05);

  return {
    stop() {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      source.stop(t + 0.12);
    },
  };
}

/**
 * A single source carried around the head.
 *
 * `StereoPannerNode` rather than `PannerNode` with HRTF: the panner's spatial
 * model needs a listener orientation and positions in metres before it means
 * anything, and over speakers it mostly produces phase artefacts. The claim
 * being illustrated is that the array knows where a sound came from, and a
 * clean orbit says that on any pair of outputs.
 */
function space(ctx: AudioContext, out: GainNode): DemoHandle {
  const now = ctx.currentTime;
  const seconds = DEMO_SECONDS.space;

  const carrier = ctx.createOscillator();
  carrier.type = "triangle";
  carrier.frequency.value = 320;

  const shimmer = ctx.createOscillator();
  shimmer.type = "sine";
  shimmer.frequency.value = 963;

  const shimmerGain = ctx.createGain();
  shimmerGain.gain.value = 0.18;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.3);
  gain.gain.setValueAtTime(0.16, now + seconds - 0.4);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  const panner = ctx.createStereoPanner();
  // The orbit is an LFO rather than scheduled from the main thread. A timer
  // writing pan values stutters under exactly the load this page puts on that
  // thread, and a stuttering orbit reads as a broken effect rather than a busy
  // page.
  const orbit = ctx.createOscillator();
  orbit.type = "sine";
  orbit.frequency.value = 1 / 2.7;
  const orbitDepth = ctx.createGain();
  orbitDepth.gain.value = 0.92;
  orbit.connect(orbitDepth).connect(panner.pan);

  // Distance cue: the far side of the orbit is duller, or it reads as a sound
  // sliding along a wall rather than going round.
  const colour = ctx.createBiquadFilter();
  colour.type = "lowpass";
  colour.frequency.value = 5200;
  const colourDepth = ctx.createGain();
  colourDepth.gain.value = 2600;
  orbit.connect(colourDepth).connect(colour.frequency);

  carrier.connect(gain);
  shimmer.connect(shimmerGain).connect(gain);
  gain.connect(colour).connect(panner).connect(out);

  for (const node of [carrier, shimmer, orbit]) {
    node.start(now);
    node.stop(now + seconds + 0.05);
  }

  return {
    stop() {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      for (const node of [carrier, shimmer, orbit]) node.stop(t + 0.12);
    },
  };
}

const VOICES = { sweep, cancel, space } as const;

/**
 * Starts one demonstration. Returns null when audio is unavailable, which
 * callers must treat as "no sound", never as an error.
 */
export function playDemo(id: DemoId): DemoHandle | null {
  const ctx = ensureAudio();
  if (!ctx) return null;
  const out = stage(ctx);
  if (!out) return null;
  return VOICES[id](ctx, out);
}

/** Releases the demo stage. The context itself belongs to `AudioBus`. */
export function disposeAcoustics() {
  analyser?.disconnect();
  demoBus?.disconnect();
  analyser = null;
  demoBus = null;
}
