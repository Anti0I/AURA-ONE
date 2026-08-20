"use client";

import { ensureAudio, audioBus, audioContext, registerAmbient } from "./AudioBus";

/**
 * Every sound on the page, generated from oscillators and noise.
 *
 * Shipping the interface sounds as files would be four more HTTP requests and
 * about 60 KB for clicks nobody would notice loading — but the real argument is
 * control. A synthesised tick can be pitched by *how far through the section
 * you are*, or detuned per hotspot, which a sample cannot do without shipping
 * a variant for each case.
 *
 * All voices are one-shot: created, scheduled, and left to be collected once
 * they stop. Web Audio nodes disconnect themselves when their source ends.
 */

/** Shared noise, generated once. A fresh buffer per tick is pure waste. */
let noiseBuffer: AudioBuffer | null = null;

function getNoise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  const length = Math.floor(ctx.sampleRate * 0.5);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

/**
 * The hover tick.
 *
 * A sine at `pitch` with a 12 ms attack-free envelope, plus a bandpassed noise
 * transient underneath. The noise is what makes it read as a mechanical click
 * rather than a beep — a pure tone always sounds like an error message.
 */
export function tick(pitch = 1180, level = 0.16) {
  const ctx = ensureAudio();
  const bus = audioBus();
  if (!ctx || !bus) return;

  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(pitch, now);
  osc.frequency.exponentialRampToValueAtTime(pitch * 0.72, now + 0.06);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

  osc.connect(gain).connect(bus);
  osc.start(now);
  osc.stop(now + 0.09);

  const transient = ctx.createBufferSource();
  transient.buffer = getNoise(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = pitch * 1.6;
  band.Q.value = 1.4;
  const tGain = ctx.createGain();
  tGain.gain.setValueAtTime(level * 0.55, now);
  tGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

  transient.connect(band).connect(tGain).connect(bus);
  transient.start(now);
  transient.stop(now + 0.04);
}

/**
 * Fired when the scanner locks onto a component. Two pitches a fifth apart,
 * the second delayed by 55 ms — the interval is what makes it read as
 * "confirmed" rather than as another hover.
 */
export function lock() {
  tick(880, 0.13);
  window.setTimeout(() => tick(1320, 0.1), 55);
}

/** A short downward sweep, for closing or dismissing. */
export function sweepDown() {
  const ctx = ensureAudio();
  const bus = audioBus();
  if (!ctx || !bus) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(760, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + 0.16);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.09, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  osc.connect(gain).connect(bus);
  osc.start(now);
  osc.stop(now + 0.2);
}

/**
 * The ambient bed.
 *
 * Three detuned oscillators an octave apart through a low-pass whose cutoff
 * drifts on a slow LFO, plus filtered noise for air. The detuning is the whole
 * trick: exact intervals sound synthetic, a few cents apart they beat against
 * each other and the pad breathes on its own without any automation.
 */
export function startAmbient() {
  const ctx = ensureAudio();
  const bus = audioBus();
  if (!ctx || !bus) return;

  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(0.13, now + 3.5);
  out.connect(bus);

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 420;
  lowpass.Q.value = 0.7;
  lowpass.connect(out);

  const voices: OscillatorNode[] = [];
  // A minor triad in the bass, spread over two octaves.
  for (const [freq, detune, level] of [
    [55, -7, 0.5],
    [82.41, 4, 0.34],
    [110, -3, 0.26],
    [164.81, 9, 0.12],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(lowpass);
    osc.start(now);
    voices.push(osc);
  }

  // Air: very quiet high-passed noise, so the pad is not purely tonal.
  const air = ctx.createBufferSource();
  air.buffer = getNoise(ctx);
  air.loop = true;
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = "highpass";
  airFilter.frequency.value = 2400;
  const airGain = ctx.createGain();
  airGain.gain.value = 0.012;
  air.connect(airFilter).connect(airGain).connect(out);
  air.start(now);

  // Cutoff drift — one cycle every ~24 s, well below anything that reads as
  // rhythm.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1 / 24;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 180;
  lfo.connect(lfoDepth).connect(lowpass.frequency);
  lfo.start(now);

  const handle = {
    stop() {
      const context = audioContext();
      if (!context) return;
      const t = context.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, 0.0001), t);
      out.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      for (const v of [...voices, lfo]) v.stop(t + 0.9);
      air.stop(t + 0.9);
    },
  };

  registerAmbient(handle);
  return handle;
}
