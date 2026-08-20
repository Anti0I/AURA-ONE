"use client";

import { useEffect, useRef, useState } from "react";
import { useConversation } from "@/lib/ai/useConversation";
import { useMicrophone } from "@/lib/audio/useMicrophone";
import { SCENARIOS } from "@/lib/ai/deterministic/scenarios";
import { hasWebGPU } from "@/lib/ai/webgpu/engine";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { useClientValue } from "@/lib/useClientValue";
import { cn } from "@/lib/utils";
import { PartRenderer } from "./parts";

/**
 * The Neural OS playground.
 *
 * A terminal that streams typed parts and renders each one as a widget. Both
 * engines answer through the same protocol, so switching between the scripted
 * simulator and a real 135M-parameter model running on the visitor's GPU
 * changes nothing about this component.
 */
export function PlaygroundSection() {
  const {
    messages,
    busy,
    engineId,
    engineStatus,
    selectEngine,
    send,
    abort,
    reset,
  } = useConversation();
  const mic = useMicrophone();

  const [draft, setDraft] = useState("");
  const webgpuAvailable = useClientValue(hasWebGPU, true);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the stream, but only while the reader is already at the bottom —
  // yanking the view back down while somebody is reading earlier output is one
  // of the more irritating things a chat UI can do.
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const atBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const submit = async (text: string) => {
    if (!text.trim() || busy) return;
    setDraft("");
    await send(text);
  };

  const recordAndSend = async () => {
    const samples = await mic.record();
    if (!samples) return;
    await send("Analyse the ambient sound you just captured", samples);
  };

  return (
    <section
      id="playground"
      className="relative border-t border-line px-gutter py-24"
    >
      <div aria-hidden className="noise-field" />

      <header className="relative mb-10 flex flex-wrap items-end justify-between gap-6">
        <div>
          <SectionLabel index={3}>Neural OS</SectionLabel>
          <h2 className="mt-5 max-w-[20ch] text-title font-medium text-ink">
            Ask it something.
          </h2>
        </div>
        <p className="max-w-[46ch] text-ink-dim">
          Two engines, one streaming protocol. The simulator answers instantly
          with zero download; the on-device model is a real 135M-parameter LLM
          running on your GPU.
        </p>
      </header>

      {/* ---- Engine switch ------------------------------------------------ */}
      <div className="relative mb-4 flex flex-wrap items-center gap-2">
        <EngineButton
          active={engineId === "deterministic"}
          onClick={() => void selectEngine("deterministic")}
          title="Simulator"
          detail="0 KB · instant"
        />
        <EngineButton
          active={engineId === "webgpu"}
          disabled={!webgpuAvailable}
          onClick={() => void selectEngine("webgpu")}
          title="On-device model"
          detail={
            !webgpuAvailable
              ? "WebGPU unavailable here"
              : engineStatus.state === "loading"
                ? (engineStatus.detail ?? "downloading")
                : engineStatus.state === "ready" && engineId === "webgpu"
                  ? "resident on GPU"
                  : "118 MB · WebGPU"
          }
          progress={
            engineId === "webgpu" && engineStatus.state === "loading"
              ? engineStatus.progress
              : undefined
          }
        />
        {engineStatus.state === "error" ? (
          <p className="rule-label text-alert">{engineStatus.detail}</p>
        ) : null}
      </div>

      {/* ---- Terminal ----------------------------------------------------- */}
      <div className="relative overflow-hidden rounded-tile border border-line bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <span aria-hidden className="flex gap-1.5">
            <span className="size-2 rounded-full bg-line-strong" />
            <span className="size-2 rounded-full bg-line-strong" />
            <span className="size-2 rounded-full bg-line-strong" />
          </span>
          <span className="rule-label">aura-os // inference shell</span>
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={reset}
              className="rule-label ml-auto transition-colors hover:text-ink"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="h-[min(56svh,32rem)] overflow-y-auto px-4 py-5 sm:px-6"
        >
          {messages.length === 0 ? (
            <EmptyState onPick={submit} />
          ) : (
            <ol className="space-y-8">
              {messages.map((message) => (
                <li key={message.id}>
                  {message.role === "user" ? (
                    <p className="flex gap-3">
                      <span aria-hidden className="rule-label mt-1 text-signal">
                        &gt;
                      </span>
                      <span className="text-ink">
                        {message.parts
                          .map((p) => (p.type === "text" ? p.text : ""))
                          .join("")}
                      </span>
                    </p>
                  ) : (
                    <div>
                      {message.parts.map((part) => (
                        <PartRenderer
                          key={part.id}
                          part={part}
                          streaming={
                            message.status === "streaming" &&
                            part === message.parts[message.parts.length - 1]
                          }
                        />
                      ))}
                      {message.status === "streaming" &&
                      message.parts.length === 0 ? (
                        <p className="rule-label animate-pulse">thinking</p>
                      ) : null}
                      {/* Shown for a stopped response too, not just a
                          completed one — the footer is where the reader looks
                          to find out what happened. */}
                      {message.usage || message.status === "aborted" ? (
                        <p className="rule-label mt-4">
                          {message.usage ? (
                            <>
                              <span data-numeric>
                                {message.usage.completionTokens}
                              </span>{" "}
                              tokens //{" "}
                              <span data-numeric>{message.usage.ttftMs}</span> ms
                              to first token //{" "}
                              <span data-numeric>{message.usage.totalMs}</span>{" "}
                              ms total
                            </>
                          ) : null}
                          {message.status === "aborted" ? (
                            <span className="text-alert">
                              {message.usage ? " // " : ""}stopped
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* ---- Input ------------------------------------------------------ */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(draft);
          }}
          className="flex items-end gap-2 border-t border-line p-3"
        >
          <label htmlFor="playground-prompt" className="sr-only">
            Prompt
          </label>
          <textarea
            id="playground-prompt"
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line. The convention every
              // chat interface has settled on, and worth matching exactly.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(draft);
              }
            }}
            placeholder="Analyse the noise around me…"
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-2 text-ink outline-none placeholder:text-ink-faint"
          />

          <button
            type="button"
            onClick={() => (mic.recording ? mic.cancel() : void recordAndSend())}
            disabled={!mic.supported || busy}
            aria-label={mic.recording ? "Stop recording" : "Record 2.4 seconds"}
            className={cn(
              "rule-label shrink-0 rounded-full border px-3 py-2 transition-colors",
              mic.recording
                ? "border-alert text-alert"
                : "border-line text-ink-dim hover:border-line-strong hover:text-ink",
              (!mic.supported || busy) && "cursor-not-allowed opacity-40",
            )}
          >
            {mic.recording ? (
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="block h-3 w-0.5 origin-bottom bg-alert"
                  style={{ transform: `scaleY(${0.3 + mic.level * 6})` }}
                />
                Listening
              </span>
            ) : (
              "Mic"
            )}
          </button>

          <button
            type={busy ? "button" : "submit"}
            onClick={busy ? abort : undefined}
            className={cn(
              "rule-label shrink-0 rounded-full px-4 py-2 transition-colors",
              busy
                ? "bg-alert text-void"
                : "bg-signal text-void hover:bg-ink disabled:opacity-40",
            )}
            disabled={!busy && !draft.trim()}
          >
            {busy ? "Stop" : "Send"}
          </button>
        </form>
      </div>

      {mic.error ? (
        <p className="rule-label relative mt-3 text-alert">{mic.error}</p>
      ) : null}
    </section>
  );
}

function EngineButton({
  active,
  disabled,
  onClick,
  title,
  detail,
  progress,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  detail: string;
  progress?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "relative overflow-hidden rounded-tile border px-4 py-2.5 text-left transition-colors",
        active ? "border-signal bg-signal/5" : "border-line hover:border-line-strong",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span
        className={cn("block text-sm", active ? "text-ink" : "text-ink-dim")}
      >
        {title}
      </span>
      <span className="rule-label mt-0.5 block">{detail}</span>
      {progress !== undefined ? (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-signal transition-transform duration-300"
          style={{ transform: `scaleX(${progress})` }}
        />
      ) : null}
    </button>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div>
      <p className="max-w-[54ch] text-ink-dim">
        The simulator routes your prompt to one of five prepared analyses and
        streams the answer as typed parts — text, tool calls, waveforms,
        telemetry. Pick one, type your own, or record 2.4 seconds of the room.
      </p>
      <ul className="mt-6 flex flex-wrap gap-2">
        {SCENARIOS.map((scenario) => (
          <li key={scenario.id}>
            <button
              type="button"
              onClick={() => onPick(scenario.title)}
              className="rule-label rounded-full border border-line px-3.5 py-2 text-ink-dim transition-colors hover:border-signal hover:text-ink"
            >
              {scenario.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
