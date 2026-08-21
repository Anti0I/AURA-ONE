/**
 * Scripts for the on-page engine.
 *
 * Declarative rather than a pile of generator functions, so a scenario is data
 * the interpreter walks. That is what makes adding one a matter of writing a
 * paragraph and a few rows of numbers, and it keeps the timing model — pauses,
 * token jitter, tool latency — in exactly one place instead of copy-pasted
 * across every response.
 */

export type Step =
  | { kind: "think"; ms: number }
  | { kind: "say"; text: string }
  | {
      kind: "tool";
      name: string;
      args: Record<string, string | number>;
      ms: number;
      result: string;
    }
  | {
      kind: "waveform";
      label: string;
      /** `mic` uses the captured buffer when there is one. */
      source: "mic" | "ambient" | "speech";
      focus?: { from: number; to: number; label: string };
    }
  | {
      kind: "telemetry";
      rows: {
        label: string;
        value: number;
        unit?: string;
        ratio?: number;
        tone?: "neutral" | "good" | "warn";
      }[];
    }
  | { kind: "spectrum"; label: string; reductionDb: number }
  | {
      kind: "transcript";
      lines: { at: string; speaker: string; text: string; confidence: number }[];
    };

export interface Scenario {
  id: string;
  /** Shown as a preset button. */
  title: string;
  /** Matched against the prompt, lower-cased. */
  keywords: string[];
  steps: Step[];
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "ambient",
    title: "Analyse ambient sound",
    keywords: [
      "ambient",
      "noise",
      "around",
      "environment",
      "room",
      "listen",
      "sound",
      "hear",
      "loud",
    ],
    steps: [
      { kind: "think", ms: 320 },
      {
        kind: "say",
        text: "Sampling 2.4 seconds from the quad-mic array and classifying the field.",
      },
      {
        kind: "tool",
        name: "beamform_scan",
        args: { window_ms: 2400, mics: 4, mode: "adaptive" },
        ms: 620,
        result: "3 sources separated",
      },
      {
        kind: "waveform",
        label: "Captured field // 2.4 s",
        source: "mic",
        focus: { from: 0.42, to: 0.61, label: "speech, 1.9 m, 41° left" },
      },
      {
        kind: "say",
        text: "Three sources resolved. The dominant one is broadband and stationary — mechanical, most likely ventilation. A second is speech at roughly two metres, off to your left. The third is intermittent and high-frequency.",
      },
      {
        kind: "telemetry",
        rows: [
          { label: "Ventilation", value: 52, unit: "dBA", ratio: 0.62, tone: "warn" },
          { label: "Speech", value: 44, unit: "dBA", ratio: 0.48 },
          { label: "Transient", value: 31, unit: "dBA", ratio: 0.24, tone: "good" },
          { label: "Field SNR", value: 18.4, unit: "dB", ratio: 0.71, tone: "good" },
        ],
      },
      {
        kind: "say",
        text: "Adaptive ANC would take the ventilation down without touching the speech band. Want me to apply it?",
      },
    ],
  },

  {
    id: "noise",
    title: "Simulate noise reduction",
    keywords: [
      "anc",
      "cancel",
      "cancellation",
      "reduce",
      "reduction",
      "quiet",
      "filter",
      "suppress",
    ],
    steps: [
      { kind: "think", ms: 260 },
      {
        kind: "say",
        text: "Fitting a suppression curve to the current field. Speech-band content is preserved by constraint, not by accident.",
      },
      {
        kind: "tool",
        name: "fit_anc_curve",
        args: { preserve: "300-3400 Hz", target_db: -26, latency_ms: 4.2 },
        ms: 780,
        result: "converged in 11 iterations",
      },
      {
        kind: "spectrum",
        label: "Third-octave bands // before vs after",
        reductionDb: 26,
      },
      {
        kind: "say",
        text: "26 dB below 300 Hz, tapering to nothing across the speech band and back to 14 dB above 4 kHz. End-to-end latency is 4.2 ms, which is below the threshold where you would perceive it as an echo of the room.",
      },
      {
        kind: "telemetry",
        rows: [
          { label: "Low band", value: -26, unit: "dB", ratio: 0.92, tone: "good" },
          { label: "Speech band", value: -1.2, unit: "dB", ratio: 0.05, tone: "good" },
          { label: "High band", value: -14, unit: "dB", ratio: 0.55 },
          { label: "Added latency", value: 4.2, unit: "ms", ratio: 0.14, tone: "good" },
        ],
      },
    ],
  },

  {
    id: "translate",
    title: "Translate live audio",
    keywords: [
      "translate",
      "translation",
      "language",
      "polish",
      "spanish",
      "french",
      "german",
      "japanese",
      "speak",
    ],
    steps: [
      { kind: "think", ms: 300 },
      {
        kind: "say",
        text: "Running speech detection, then translating on-device. Nothing leaves the earpiece.",
      },
      {
        kind: "tool",
        name: "detect_language",
        args: { window_ms: 1600, candidates: 42 },
        ms: 520,
        result: "pl-PL, p=0.94",
      },
      {
        kind: "waveform",
        label: "Speech segment // 1.6 s",
        source: "speech",
        focus: { from: 0.18, to: 0.86, label: "voiced" },
      },
      {
        kind: "tool",
        name: "translate_stream",
        args: { from: "pl-PL", to: "en-GB", latency_ms: 210 },
        ms: 640,
        result: "streaming",
      },
      {
        kind: "transcript",
        lines: [
          {
            at: "00:00.4",
            speaker: "pl",
            text: "Czy ten model działa całkowicie offline?",
            confidence: 0.96,
          },
          {
            at: "00:00.6",
            speaker: "en",
            text: "Does this model run completely offline?",
            confidence: 0.93,
          },
          {
            at: "00:02.1",
            speaker: "pl",
            text: "Tak, wszystko liczy się lokalnie.",
            confidence: 0.94,
          },
          {
            at: "00:02.3",
            speaker: "en",
            text: "Yes, everything is computed locally.",
            confidence: 0.91,
          },
        ],
      },
      {
        kind: "say",
        text: "210 ms from utterance to translated audio. The gap is dominated by waiting for a phrase boundary, not by the model.",
      },
    ],
  },

  {
    id: "power",
    title: "Model battery under load",
    keywords: [
      "battery",
      "power",
      "charge",
      "runtime",
      "hours",
      "energy",
      "consumption",
      "drain",
    ],
    steps: [
      { kind: "think", ms: 240 },
      {
        kind: "say",
        text: "Integrating the power model against a 78 mAh silicon-anode cell at 3.85 V nominal.",
      },
      {
        kind: "tool",
        name: "simulate_duty_cycle",
        args: { playback_pct: 60, anc_pct: 30, inference_pct: 10 },
        ms: 540,
        result: "8.9 h projected",
      },
      {
        kind: "telemetry",
        rows: [
    { label: "Playback only", value: 11.1, unit: "h", ratio: 1, tone: "good" },
          { label: "With adaptive ANC", value: 8.1, unit: "h", ratio: 0.73 },
          { label: "Continuous inference", value: 4.6, unit: "h", ratio: 0.42, tone: "warn" },
          { label: "Mixed duty cycle", value: 8.9, unit: "h", ratio: 0.8, tone: "good" },
        ],
      },
      {
        kind: "say",
        text: "Inference is the expensive mode at 65 mW, but it only runs while something is being asked of it. On a realistic duty cycle you land at 8.9 hours.",
      },
    ],
  },

  {
    id: "summarise",
    title: "Summarise my day",
    keywords: [
      "summarise",
      "summarize",
      "summary",
      "day",
      "meeting",
      "recap",
      "notes",
      "today",
    ],
    steps: [
      { kind: "think", ms: 380 },
      {
        kind: "say",
        text: "Six hours of ambient capture, of which 41 minutes contained speech. Only the speech segments were ever transcribed, and the transcript never left the device.",
      },
      {
        kind: "tool",
        name: "segment_speech",
        args: { hours: 6.2, vad_threshold: 0.62 },
        ms: 700,
        result: "41 min across 9 segments",
      },
      {
        kind: "transcript",
        lines: [
          {
            at: "09:14",
            speaker: "note",
            text: "Design review — the frame budget is the constraint, not the asset size.",
            confidence: 0.89,
          },
          {
            at: "11:02",
            speaker: "note",
            text: "Agreed to cut the third camera move rather than shorten the pin.",
            confidence: 0.92,
          },
          {
            at: "15:48",
            speaker: "note",
            text: "Open question: does the scanner need a keyboard path? Yes.",
            confidence: 0.87,
          },
        ],
      },
      {
        kind: "telemetry",
        rows: [
          { label: "Captured", value: 6.2, unit: "h", ratio: 1 },
          { label: "Speech", value: 41, unit: "min", ratio: 0.11 },
          { label: "Segments", value: 9, ratio: 0.3 },
          { label: "Left the device", value: 0, unit: "bytes", ratio: 0, tone: "good" },
        ],
      },
    ],
  },
];

/**
 * The reply when nothing matches.
 *
 * It says what it is rather than improvising. A scripted engine that pretends
 * to understand an arbitrary question is a worse demo than one that is honest
 * about being scripted and points at the real model sitting next to it.
 */
export const FALLBACK: Step[] = [
  { kind: "think", ms: 280 },
  {
    kind: "say",
    text: "That one is outside the scripted set. This engine is a deterministic simulator — it routes your prompt to one of five prepared analyses, streams the response with realistic token timing, and renders whatever widgets the answer calls for.",
  },
  {
    kind: "telemetry",
    rows: [
      { label: "Engine size", value: 0, unit: "KB downloaded", ratio: 0, tone: "good" },
      { label: "Time to first token", value: 280, unit: "ms", ratio: 0.2, tone: "good" },
      { label: "Scenarios", value: 5, ratio: 0.5 },
    ],
  },
  {
    kind: "say",
    text: "For an answer to an arbitrary question, switch to the on-device model above — that one is a real language model running on your GPU.",
  },
];
