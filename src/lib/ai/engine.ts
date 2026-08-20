import type { StreamEvent } from "./protocol";

export type EngineId = "deterministic" | "webgpu";

export interface EngineInput {
  prompt: string;
  /** Mono PCM captured from the microphone, if the user recorded something. */
  audio?: Float32Array | null;
  /** Sample rate of `audio`. */
  sampleRate?: number;
}

export interface EngineStatus {
  state: "idle" | "loading" | "ready" | "unsupported" | "error";
  /** 0..1 while a model is downloading. */
  progress?: number;
  detail?: string;
}

/**
 * One interface, two implementations.
 *
 * The deterministic engine ships with the page and starts instantly; the
 * WebGPU engine downloads a real model and runs it on the visitor's GPU. Both
 * emit the same typed part stream, so the entire UI — the renderer, the
 * message reducer, the abort handling, the usage readout — is written once and
 * neither implementation is privileged.
 *
 * That is deliberate, and it is the argument for building it this way rather
 * than picking one: shipping only the scripted engine leaves you unable to show
 * you can run a model in the browser, and shipping only the real one means a
 * visitor without WebGPU sees nothing at all. Behind one interface, the choice
 * becomes a runtime detail instead of a bet.
 */
export interface AIEngine {
  readonly id: EngineId;
  readonly label: string;
  /** What the visitor is asked to accept before this engine is used. */
  readonly cost: string;

  status(): EngineStatus;
  /** Idempotent. Resolves once the engine can serve a request. */
  prepare(onProgress?: (status: EngineStatus) => void): Promise<void>;
  stream(input: EngineInput, signal: AbortSignal): AsyncIterable<StreamEvent>;
  dispose(): void;
}

let counter = 0;

/**
 * Part ids. Deliberately not `crypto.randomUUID()`: these appear as React keys,
 * and a monotonic counter makes a streamed transcript reproducible in tests
 * and readable in devtools.
 */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Resolves after `ms`, or rejects the moment the request is aborted. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
