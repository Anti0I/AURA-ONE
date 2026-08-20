import type { AIEngine, EngineInput, EngineStatus } from "../engine";
import { nextId } from "../engine";
import type { StreamEvent } from "../protocol";

/**
 * SmolLM2-135M-Instruct, q4f16.
 *
 * Chosen on download size, not on benchmark scores. The q4f16 export is 118 MB;
 * the next capable step up is three to four times that, and a visitor is not
 * going to wait out a 400 MB download to try a demo. At 135M parameters it
 * writes coherent short answers and nothing more, which is the honest scope of
 * what fits in a browser tab.
 */
const MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct";

const SYSTEM_PROMPT =
  "You are the assistant embedded in AURA ONE, a neural audio wearable that runs entirely on-device. " +
  "Answer in two or three sentences. Be concrete and never invent specifications you were not given.";

/**
 * A real language model, running on the visitor's GPU.
 *
 * Everything here is gated behind an explicit click. A page that starts a
 * 118 MB download because someone scrolled past a section is not a
 * demonstration of anything except poor judgement — so `prepare()` is never
 * called speculatively, the size is stated up front, and the deterministic
 * engine is what answers until this one is ready.
 *
 * The model is fetched from the Hugging Face CDN and cached by the browser's
 * Cache Storage, so a second visit is instant. That is the one external request
 * the site makes, and it only happens on request.
 */
export class WebGpuEngine implements AIEngine {
  readonly id = "webgpu" as const;
  readonly label = "On-device model";
  readonly cost = "118 MB · WebGPU";

  private state: EngineStatus = { state: "idle" };
  private generator: unknown = null;
  private loading: Promise<void> | null = null;
  private interrupt: (() => void) | null = null;

  status(): EngineStatus {
    if (this.state.state === "idle" && !hasWebGPU()) {
      return {
        state: "unsupported",
        detail: "WebGPU not available in this browser",
      };
    }
    return this.state;
  }

  async prepare(onProgress?: (status: EngineStatus) => void): Promise<void> {
    if (this.generator) return;
    if (this.loading) return this.loading;

    if (!hasWebGPU()) {
      this.state = {
        state: "unsupported",
        detail: "WebGPU not available in this browser",
      };
      onProgress?.(this.state);
      throw new Error("WebGPU unavailable");
    }

    this.loading = (async () => {
      const report = (status: EngineStatus) => {
        this.state = status;
        onProgress?.(status);
      };
      report({ state: "loading", progress: 0, detail: "fetching weights" });

      // Dynamic import: the library is ~1 MB of JavaScript on top of the
      // weights, and nobody who never presses the button should pay for it.
      const { pipeline } = await import("@huggingface/transformers");

      // The library reports progress per file. Summing loaded/total across
      // files gives a bar that tracks the download rather than one that jumps
      // between files.
      const files = new Map<string, { loaded: number; total: number }>();

      this.generator = await pipeline("text-generation", MODEL_ID, {
        device: "webgpu",
        dtype: "q4f16",
        progress_callback: (event: unknown) => {
          const e = event as {
            status?: string;
            file?: string;
            loaded?: number;
            total?: number;
          };
          if (e.status === "progress" && e.file && e.total) {
            files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
            let loaded = 0;
            let total = 0;
            for (const f of files.values()) {
              loaded += f.loaded;
              total += f.total;
            }
            report({
              state: "loading",
              progress: total ? loaded / total : 0,
              detail: `${(loaded / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`,
            });
          }
        },
      });

      report({ state: "ready", detail: "resident on GPU" });
    })().catch((error: unknown) => {
      this.state = {
        state: "error",
        detail: error instanceof Error ? error.message : String(error),
      };
      onProgress?.(this.state);
      this.loading = null;
      throw error;
    });

    return this.loading;
  }

  dispose(): void {
    this.interrupt?.();
    this.generator = null;
    this.loading = null;
    this.state = { state: "idle" };
  }

  async *stream(
    input: EngineInput,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    await this.prepare();
    const generator = this.generator as GenerationPipeline;

    const { TextStreamer, InterruptableStoppingCriteria } = await import(
      "@huggingface/transformers"
    );

    const stopper = new InterruptableStoppingCriteria();
    this.interrupt = () => stopper.interrupt();
    const onAbort = () => stopper.interrupt();
    signal.addEventListener("abort", onAbort, { once: true });

    const queue = new TokenQueue();
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => queue.push(text),
    });

    const textId = nextId("text");
    const started = performance.now();
    let firstTokenAt = 0;
    let tokens = 0;

    yield { type: "part", part: { type: "text", id: textId, text: "" } };

    const run = generator(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input.prompt },
      ],
      {
        max_new_tokens: 220,
        do_sample: true,
        temperature: 0.6,
        top_p: 0.9,
        repetition_penalty: 1.1,
        streamer,
        stopping_criteria: stopper,
      },
    )
      .catch((error: unknown) => {
        queue.fail(error);
      })
      .finally(() => queue.close());

    try {
      for await (const delta of queue) {
        if (!firstTokenAt) firstTokenAt = performance.now();
        tokens++;
        yield { type: "text-delta", id: textId, delta };
      }
      await run;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.interrupt = null;
    }

    const totalMs = performance.now() - started;
    const decodeMs = totalMs - (firstTokenAt - started);

    // Real numbers off the visitor's own hardware. This is the part that makes
    // the difference between "it says it runs locally" and "it does".
    yield {
      type: "part",
      part: {
        type: "telemetry",
        id: nextId("tel"),
        rows: [
          {
            label: "Decode rate",
            value: Math.round((tokens / Math.max(decodeMs, 1)) * 1000),
            unit: "tok/s",
            ratio: 0.7,
            tone: "good",
          },
          {
            label: "Time to first token",
            value: Math.round(firstTokenAt - started),
            unit: "ms",
            ratio: 0.3,
          },
          { label: "Tokens", value: tokens, ratio: Math.min(1, tokens / 220) },
          {
            label: "Sent to a server",
            value: 0,
            unit: "bytes",
            ratio: 0,
            tone: "good",
          },
        ],
      },
    };

    yield {
      type: "finish",
      reason: signal.aborted ? "abort" : "stop",
      usage: {
        promptTokens: Math.round(input.prompt.length / 4),
        completionTokens: tokens,
        ttftMs: Math.round(firstTokenAt - started),
        totalMs: Math.round(totalMs),
      },
    };
  }
}

interface GenerationPipeline {
  (messages: unknown, options: Record<string, unknown>): Promise<unknown>;
  tokenizer: never;
}

export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * Bridges the library's push-style callback to an async iterable.
 *
 * `TextStreamer` calls a function per chunk and cannot be awaited, but the
 * engine interface is an async generator — so chunks are buffered here and
 * handed out as the consumer asks for them. Without the buffer, a consumer
 * slower than the GPU would silently drop tokens.
 */
class TokenQueue implements AsyncIterable<string> {
  private readonly buffer: string[] = [];
  private waiting: ((value: IteratorResult<string>) => void) | null = null;
  private closed = false;
  private error: unknown = null;

  push(value: string) {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  fail(error: unknown) {
    this.error = error;
    this.close();
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as string, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.error) {
          const error = this.error;
          this.error = null;
          return Promise.reject(error);
        }
        const next = this.buffer.shift();
        if (next !== undefined) {
          return Promise.resolve({ value: next, done: false });
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as string,
            done: true,
          });
        }
        return new Promise<IteratorResult<string>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
