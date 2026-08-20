"use client";

import type {
  TelemetryPart,
  TextPart,
  ToolCallPart,
  TranscriptPart,
  UIPart,
} from "@/lib/ai/protocol";
import { cn } from "@/lib/utils";
import { SpectrumWidget, WaveformWidget } from "./CanvasParts";

/**
 * The registry.
 *
 * One switch, exhaustively typed against the part union — add a part type to
 * the protocol and this fails to compile until it has somewhere to render.
 * That is the whole reason the response is a typed stream rather than markdown:
 * a widget is a first-class thing the engine can emit, not a fenced block that
 * has to be parsed back out of prose and hoped for.
 */
export function PartRenderer({
  part,
  streaming,
}: {
  part: UIPart;
  streaming: boolean;
}) {
  switch (part.type) {
    case "text":
      return <TextBlock part={part} streaming={streaming} />;
    case "tool-call":
      return <ToolCall part={part} />;
    case "waveform":
      return <WaveformWidget part={part} />;
    case "telemetry":
      return <Telemetry part={part} />;
    case "spectrum":
      return <SpectrumWidget part={part} />;
    case "transcript":
      return <Transcript part={part} />;
  }
}

function TextBlock({ part, streaming }: { part: TextPart; streaming: boolean }) {
  return (
    <p className="mt-3 max-w-[68ch] leading-relaxed text-ink-dim first:mt-0">
      {part.text}
      {streaming ? (
        // Block caret rather than a spinner: it says "still writing" in the
        // place the next word will appear, which is where the eye already is.
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.12em] animate-[caret_1s_steps(2)_infinite] bg-signal align-baseline"
        />
      ) : null}
    </p>
  );
}

function ToolCall({ part }: { part: ToolCallPart }) {
  const args = Object.entries(part.args)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");

  return (
    <div className="mt-4 overflow-hidden rounded-tile border border-line bg-void/60">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            part.status === "running" && "animate-pulse bg-live",
            part.status === "done" && "bg-signal",
            part.status === "error" && "bg-alert",
          )}
        />
        <code data-numeric className="text-xs text-ink">
          {part.name}
          <span className="text-ink-faint">({args})</span>
        </code>
        <span className="rule-label ml-auto">
          {part.status === "running"
            ? "running"
            : part.durationMs
              ? `${part.durationMs} ms`
              : part.status}
        </span>
      </div>
      {part.result ? (
        <p className="rule-label border-t border-line px-3 py-2 text-signal">
          {part.result}
        </p>
      ) : null}
    </div>
  );
}

function Telemetry({ part }: { part: TelemetryPart }) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
      {part.rows.map((row) => (
        <div
          key={row.label}
          className="rounded-tile border border-line bg-void/60 p-3"
        >
          <dt className="rule-label">{row.label}</dt>
          <dd
            data-numeric
            className={cn(
              "mt-1.5 text-xl leading-none",
              row.tone === "good" && "text-live",
              row.tone === "warn" && "text-alert",
              (!row.tone || row.tone === "neutral") && "text-ink",
            )}
          >
            {row.value}
            {row.unit ? (
              <span className="ml-1 text-xs text-ink-faint">{row.unit}</span>
            ) : null}
          </dd>
          {row.ratio !== undefined ? (
            <div className="mt-2.5 h-px w-full bg-line">
              <div
                className={cn(
                  "h-px origin-left transition-transform duration-700 ease-[var(--ease-out-expo)]",
                  row.tone === "warn" ? "bg-alert" : "bg-signal",
                )}
                style={{ width: `${Math.round(Math.abs(row.ratio) * 100)}%` }}
              />
            </div>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

function Transcript({ part }: { part: TranscriptPart }) {
  return (
    <ol className="mt-4 divide-y divide-line overflow-hidden rounded-tile border border-line bg-void/60">
      {part.lines.map((line, i) => (
        <li key={i} className="flex gap-3 px-3 py-2.5">
          <span data-numeric className="shrink-0 text-xs text-ink-faint">
            {line.at}
          </span>
          <span className="rule-label w-10 shrink-0 text-signal">
            {line.speaker}
          </span>
          <span className="flex-1 text-sm text-ink-dim">{line.text}</span>
          {/* Confidence is shown because a transcript without one invites
              being read as fact. */}
          <span data-numeric className="shrink-0 text-xs text-ink-faint">
            {(line.confidence * 100).toFixed(0)}%
          </span>
        </li>
      ))}
    </ol>
  );
}
