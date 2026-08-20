import type { AIEngine, EngineInput, EngineStatus } from "../engine";
import { delay, nextId } from "../engine";
import type { StreamEvent } from "../protocol";
import { SCENARIOS, FALLBACK, type Scenario, type Step } from "./scenarios";

/**
 * The engine that ships with the page.
 *
 * Zero bytes downloaded, first token in under 300 ms, identical on every
 * machine — which is exactly what you want a visitor's first interaction to be.
 * It routes a prompt to one of five prepared analyses and streams the response
 * through the same part protocol the real model uses.
 *
 * The timing model is the part that matters. Emitting a scripted string
 * instantly reads as a lookup table; emitting it at a fixed interval reads as a
 * typewriter effect. Neither reads as inference. Real decoding has a
 * measurable time-to-first-token, per-token latency that varies with what is
 * being decoded, and longer pauses at clause boundaries where the model commits
 * to a direction — so that is what this reproduces.
 */
export class DeterministicEngine implements AIEngine {
  readonly id = "deterministic" as const;
  readonly label = "Simulator";
  readonly cost = "0 KB · instant";

  status(): EngineStatus {
    return { state: "ready", detail: "no download" };
  }

  async prepare(): Promise<void> {
    // Nothing to load. Present so callers never branch on which engine they hold.
  }

  dispose(): void {}

  async *stream(
    input: EngineInput,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const started = performance.now();
    let firstTokenAt = 0;
    let completionTokens = 0;

    const scenario = route(input.prompt);
    const steps = scenario?.steps ?? FALLBACK;

    const usage = () => ({
      promptTokens: estimateTokens(input.prompt),
      completionTokens,
      ttftMs: Math.round((firstTokenAt || performance.now()) - started),
      totalMs: Math.round(performance.now() - started),
    });

    try {
      for (const step of steps) {
        for await (const event of this.runStep(step, input, signal)) {
          if (event.type === "text-delta") {
            completionTokens++;
            if (!firstTokenAt) firstTokenAt = performance.now();
          }
          yield event;
        }
      }

      yield { type: "finish", reason: "stop", usage: usage() };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // A stopped response still reports what it produced. Dropping the
        // usage on abort is the easy path and it loses the one number the
        // reader is most likely to want: how far it actually got.
        yield { type: "finish", reason: "abort", usage: usage() };
        return;
      }
      throw error;
    }
  }

  private async *runStep(
    step: Step,
    input: EngineInput,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    switch (step.kind) {
      case "think":
        await delay(step.ms, signal);
        return;

      case "say":
        yield* streamText(step.text, signal);
        return;

      case "tool": {
        const id = nextId("tool");
        yield {
          type: "part",
          part: {
            type: "tool-call",
            id,
            name: step.name,
            args: step.args,
            status: "running",
          },
        };
        await delay(step.ms, signal);
        yield {
          type: "patch",
          id,
          patch: { status: "done", result: step.result, durationMs: step.ms },
        };
        return;
      }

      case "waveform":
        yield {
          type: "part",
          part: {
            type: "waveform",
            id: nextId("wave"),
            label: step.label,
            // A real capture wins over a synthetic one every time — the point of
            // wiring up the microphone is that the widget shows *your* room.
            samples:
              step.source === "mic" && input.audio?.length
                ? input.audio
                : synthesise(step.source),
            ...(step.focus ? { focus: step.focus } : {}),
          },
        };
        await delay(180, signal);
        return;

      case "telemetry":
        yield {
          type: "part",
          part: { type: "telemetry", id: nextId("tel"), rows: step.rows },
        };
        await delay(220, signal);
        return;

      case "spectrum": {
        const bands = 24;
        const before: number[] = [];
        const after: number[] = [];
        for (let i = 0; i < bands; i++) {
          const f = i / (bands - 1);
          // Pink-ish room noise: energy falls with frequency.
          const level = 72 - f * 26 + Math.sin(i * 2.1) * 3;
          before.push(level);
          // Suppression is deep at the bottom, released across the speech band,
          // partial again at the top — the same shape the copy describes.
          const speechWindow = Math.exp(-Math.pow((f - 0.42) / 0.16, 2));
          const cut = step.reductionDb * (1 - speechWindow * 0.94) * (1 - f * 0.42);
          after.push(level - cut);
        }
        yield {
          type: "part",
          part: {
            type: "spectrum",
            id: nextId("spec"),
            label: step.label,
            before,
            after,
            reductionDb: step.reductionDb,
          },
        };
        await delay(260, signal);
        return;
      }

      case "transcript":
        yield {
          type: "part",
          part: { type: "transcript", id: nextId("tr"), lines: step.lines },
        };
        await delay(240, signal);
        return;
    }
  }
}

/**
 * Keyword routing, scored rather than first-match.
 *
 * First-match on an ordered list means whichever scenario happens to be
 * declared first wins any prompt that mentions two topics. Scoring by hit count
 * and requiring a minimum makes "how loud is my battery" resolve sensibly and
 * "what is the capital of France" fall through to the honest answer.
 */
function route(prompt: string): Scenario | null {
  const text = prompt.toLowerCase();
  let best: Scenario | null = null;
  let bestScore = 0;

  for (const scenario of SCENARIOS) {
    let score = 0;
    for (const keyword of scenario.keywords) {
      if (text.includes(keyword)) score += keyword.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = scenario;
    }
  }

  // Requires a real hit, not an incidental three-letter substring.
  return bestScore >= 4 ? best : null;
}

/**
 * Streams a string with decode-like timing.
 *
 * Splitting on whitespace-with-trailing-space keeps the tokens renderable as
 * they arrive — no reflow from words assembling character by character, which
 * no model does anyway.
 */
async function* streamText(
  text: string,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const id = nextId("text");
  yield { type: "part", part: { type: "text", id, text: "" } };

  const tokens = text.match(/\S+\s*/g) ?? [];
  for (const token of tokens) {
    // 14–34 ms per token with a long tail, plus a real pause after a sentence
    // ends. Constant intervals are the tell that gives a typewriter away.
    const base = 14 + Math.random() * 20;
    const boundary = /[.!?]\s*$/.test(token) ? 150 + Math.random() * 130 : 0;
    const comma = /[,;:—]\s*$/.test(token) ? 60 : 0;
    await delay(base + boundary + comma, signal);
    yield { type: "text-delta", id, delta: token };
  }
}

/** Rough token estimate. Good enough for a usage readout, and honest about it. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().length / 4));
}

/**
 * Synthetic capture, used when the microphone was not.
 *
 * Built from actual signal components rather than random noise, so the
 * waveform has the envelope of the thing it claims to be: a speech buffer gets
 * syllable-rate amplitude modulation, an ambient one does not.
 */
function synthesise(kind: "ambient" | "speech" | "mic"): Float32Array {
  const length = 4096;
  const out = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const t = i / length;
    let v = 0;

    // Low rumble, present in both.
    v += Math.sin(t * Math.PI * 2 * 7) * 0.22;
    v += Math.sin(t * Math.PI * 2 * 11.3 + 1.1) * 0.12;
    v += (Math.random() - 0.5) * 0.16;

    if (kind === "speech" || kind === "mic") {
      // Syllable-rate envelope, roughly 4 Hz, with formant-ish content inside.
      const envelope = Math.max(0, Math.sin(t * Math.PI * 2 * 4.2)) ** 0.6;
      v += envelope * Math.sin(t * Math.PI * 2 * 180) * 0.5;
      v += envelope * Math.sin(t * Math.PI * 2 * 420 + 0.7) * 0.24;
      v += envelope * (Math.random() - 0.5) * 0.3;
    }

    out[i] = Math.max(-1, Math.min(1, v));
  }

  return out;
}
