/**
 * The wire format between an engine and the UI.
 *
 * Modelled on the way a generative-UI SDK streams: the engine does not return
 * a string, it emits a sequence of typed *parts*, and the renderer maps each
 * part type to a component. That indirection is the whole point — it means a
 * response can contain a waveform, a table of telemetry and a tool call
 * alongside its prose, and none of it has to be parsed back out of markdown.
 *
 * Parts are addressed by id and mutated by later events, so a widget can be
 * opened empty and filled in as results arrive, exactly like a real tool call
 * resolving.
 */

export type FinishReason = "stop" | "abort" | "error";

export interface TextPart {
  type: "text";
  id: string;
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  args: Record<string, string | number>;
  status: "running" | "done" | "error";
  /** Short result summary, shown once the call resolves. */
  result?: string;
  durationMs?: number;
}

export interface WaveformPart {
  type: "waveform";
  id: string;
  label: string;
  /** Normalised −1..1. Live capture when the microphone was used. */
  samples: Float32Array;
  /** Highlighted region, as a 0..1 fraction of the buffer. */
  focus?: { from: number; to: number; label: string };
}

export interface TelemetryPart {
  type: "telemetry";
  id: string;
  rows: {
    label: string;
    value: number;
    unit?: string;
    /** Renders as a bar; 0..1. */
    ratio?: number;
    tone?: "neutral" | "good" | "warn";
  }[];
}

export interface SpectrumPart {
  type: "spectrum";
  id: string;
  label: string;
  /** dB magnitude per band, before and after processing. */
  before: number[];
  after: number[];
  reductionDb: number;
}

export interface TranscriptPart {
  type: "transcript";
  id: string;
  lines: { at: string; speaker: string; text: string; confidence: number }[];
}

export type UIPart =
  | TextPart
  | ToolCallPart
  | WaveformPart
  | TelemetryPart
  | SpectrumPart
  | TranscriptPart;

export type PartType = UIPart["type"];

/**
 * Stream events.
 *
 * `text-delta` exists separately from `part-update` because appending is not a
 * patch: a partial text update has to concatenate, and expressing that as a
 * generic patch would either send the whole string every token or need the
 * renderer to guess.
 */
export type StreamEvent =
  | { type: "part"; part: UIPart }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "patch"; id: string; patch: Partial<UIPart> }
  | { type: "finish"; reason: FinishReason; usage?: TokenUsage };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Milliseconds to the first emitted token. */
  ttftMs: number;
  totalMs: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  parts: UIPart[];
  /** Present on assistant messages once the stream finishes. */
  usage?: TokenUsage;
  status: "streaming" | "done" | "aborted" | "error";
}

/**
 * Folds one event into a message.
 *
 * Returns a new array when something changed and the *same* array when nothing
 * did, so React can bail out of re-rendering on a no-op event.
 */
export function applyEvent(parts: UIPart[], event: StreamEvent): UIPart[] {
  switch (event.type) {
    case "part":
      return [...parts, event.part];

    case "text-delta": {
      const index = parts.findIndex(
        (p) => p.id === event.id && p.type === "text",
      );
      if (index === -1) return parts;
      const next = parts.slice();
      const part = next[index] as TextPart;
      next[index] = { ...part, text: part.text + event.delta };
      return next;
    }

    case "patch": {
      const index = parts.findIndex((p) => p.id === event.id);
      if (index === -1) return parts;
      const next = parts.slice();
      next[index] = { ...next[index]!, ...event.patch } as UIPart;
      return next;
    }

    case "finish":
      return parts;
  }
}
