"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onFrame, Priority } from "@/lib/scroll/rafBus";
import { useClientValue } from "@/lib/useClientValue";

const CAPTURE_SECONDS = 2.4;
/** Length of the buffer handed to the engine. Matches the waveform widget. */
const BUFFER = 4096;

export interface MicState {
  supported: boolean;
  recording: boolean;
  /** 0..1 RMS, for a live level meter. */
  level: number;
  error: string | null;
}

const micSupported = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * Microphone capture for the playground.
 *
 * Uses `AnalyserNode` sampled on the shared frame loop rather than
 * `MediaRecorder`. The engine wants raw PCM to draw and analyse, not an encoded
 * blob it would have to decode back — and reading time-domain data per frame
 * gives a live level meter for free, which is the difference between a button
 * that might be recording and one you can see is.
 *
 * Capture stops itself after 2.4 seconds. An open microphone with no visible
 * end is a thing to be careful with, and the analysis only ever uses a window
 * this long anyway.
 */
export function useMicrophone() {
  // A capability, not state: it is read from the platform and never changes.
  const supported = useClientValue(micSupported, false);

  const [state, setState] = useState<Omit<MicState, "supported">>({
    recording: false,
    level: 0,
    error: null,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const resolveRef = useRef<((samples: Float32Array) => void) | null>(null);

  const teardown = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Resolves with the captured buffer, or null if it could not start. */
  const record = useCallback(async (): Promise<Float32Array | null> => {
    if (state.recording) return null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const frame = new Float32Array(analyser.fftSize);
      const captured = new Float32Array(BUFFER);
      // Decimate as we go: 2.4 s at 48 kHz is ~115k samples, and the buffer
      // holds 4096. Writing every nth keeps the envelope without the memory.
      let written = 0;
      let elapsed = 0;

      setState((s) => ({ ...s, recording: true, error: null }));

      return await new Promise<Float32Array>((resolve) => {
        resolveRef.current = resolve;

        detachRef.current = onFrame((f) => {
          elapsed += f.delta;
          analyser.getFloatTimeDomainData(frame);

          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
          const rms = Math.sqrt(sum / frame.length);

          // How much of the output buffer this frame is entitled to.
          const share = Math.floor((f.delta / CAPTURE_SECONDS) * BUFFER);
          const step = Math.max(1, Math.floor(frame.length / Math.max(share, 1)));
          for (let i = 0; i < frame.length && written < BUFFER; i += step) {
            captured[written++] = frame[i]!;
          }

          setState((s) =>
            Math.abs(s.level - rms) > 0.01 ? { ...s, level: rms } : s,
          );

          if (elapsed >= CAPTURE_SECONDS || written >= BUFFER) {
            teardown();
            setState((s) => ({ ...s, recording: false, level: 0 }));
            resolveRef.current = null;
            resolve(captured);
          }
        }, Priority.INPUT);
      });
    } catch (error) {
      const detail =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission denied"
          : error instanceof Error
            ? error.message
            : String(error);
      teardown();
      setState((s) => ({ ...s, recording: false, error: detail }));
      return null;
    }
  }, [state.recording, teardown]);

  const cancel = useCallback(() => {
    teardown();
    resolveRef.current?.(new Float32Array(BUFFER));
    resolveRef.current = null;
    setState((s) => ({ ...s, recording: false, level: 0 }));
  }, [teardown]);

  return { ...state, supported, record, cancel };
}
