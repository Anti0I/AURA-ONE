"use client";

import { useCallback, useRef, useState } from "react";
import type { AIEngine, EngineId, EngineStatus } from "./engine";
import { applyEvent, type Message, type StreamEvent } from "./protocol";
import { DeterministicEngine } from "./deterministic/engine";

let messageCounter = 0;

/**
 * Conversation state, engine-agnostic.
 *
 * The hook holds both engines and switches by id. Nothing below this line knows
 * which one is answering — that is the payoff for defining the part protocol
 * first and the implementations second.
 *
 * Deltas are coalesced into a microtask-flushed batch rather than setting state
 * per token. At 40+ tokens a second a naive setState per delta reconciles the
 * whole transcript every time; batching cuts it to one render per paint with no
 * visible difference in how the text appears.
 */
export function useConversation() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [engineId, setEngineId] = useState<EngineId>("deterministic");
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    state: "ready",
  });
  const [busy, setBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const enginesRef = useRef<Partial<Record<EngineId, AIEngine>>>({});

  /**
   * Engines are constructed on first use, not during render — a ref written
   * while rendering is a correctness bug waiting for concurrent rendering to
   * find it. The WebGPU module is also only imported once it is selected, so
   * the transformers.js bundle never reaches a visitor who does not ask for it.
   */
  const getEngine = useCallback(async (id: EngineId): Promise<AIEngine> => {
    const existing = enginesRef.current[id];
    if (existing) return existing;

    const engine: AIEngine =
      id === "deterministic"
        ? new DeterministicEngine()
        : new (await import("./webgpu/engine")).WebGpuEngine();

    enginesRef.current[id] = engine;
    return engine;
  }, []);

  const selectEngine = useCallback(
    async (id: EngineId) => {
      setEngineId(id);
      const engine = await getEngine(id);
      setEngineStatus(engine.status());
      if (id === "webgpu") {
        try {
          await engine.prepare(setEngineStatus);
        } catch {
          // prepare() has already reported the failure through setEngineStatus.
        }
      }
    },
    [getEngine],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (prompt: string, audio?: Float32Array | null) => {
      const trimmed = prompt.trim();
      if (!trimmed || busy) return;

      const engine = await getEngine(engineId);
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      const userId = `msg-${++messageCounter}`;
      const replyId = `msg-${++messageCounter}`;

      setMessages((prev) => [
        ...prev,
        {
          id: userId,
          role: "user",
          parts: [{ type: "text", id: `${userId}-t`, text: trimmed }],
          status: "done",
        },
        { id: replyId, role: "assistant", parts: [], status: "streaming" },
      ]);

      let queued: StreamEvent[] = [];
      let scheduled = false;
      const flush = () => {
        const batch = queued;
        queued = [];
        scheduled = false;
        if (batch.length === 0) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? {
                  ...m,
                  parts: batch.reduce(applyEvent, m.parts),
                  usage:
                    batch.find((e) => e.type === "finish")?.usage ?? m.usage,
                }
              : m,
          ),
        );
      };

      try {
        for await (const event of engine.stream(
          { prompt: trimmed, audio: audio ?? null },
          controller.signal,
        )) {
          queued.push(event);
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(flush);
          }
        }
        flush();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? { ...m, status: controller.signal.aborted ? "aborted" : "done" }
              : m,
          ),
        );
      } catch (error) {
        flush();
        const detail = error instanceof Error ? error.message : String(error);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? {
                  ...m,
                  status: "error",
                  parts: [
                    ...m.parts,
                    {
                      type: "text",
                      id: `${replyId}-err`,
                      text: `The engine failed: ${detail}`,
                    },
                  ],
                }
              : m,
          ),
        );
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, engineId, getEngine],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  return {
    messages,
    busy,
    engineId,
    engineStatus,
    selectEngine,
    send,
    abort,
    reset,
  };
}
