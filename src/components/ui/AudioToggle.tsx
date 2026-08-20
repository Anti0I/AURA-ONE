"use client";

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { setAudioEnabled, disposeAudio, hasAmbient } from "@/lib/audio/AudioBus";
import { startAmbient, tick } from "@/lib/audio/synth";
import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

const BARS = [0.35, 0.85, 0.55, 1] as const;

/**
 * Ambient sound control.
 *
 * Off by default and staying that way until someone asks for it. Autoplaying
 * audio is blocked by every browser worth supporting, and the sites that work
 * around it are the reason it is blocked.
 *
 * The button is also the audio system's ignition: the click is the user gesture
 * the AudioContext needs, so nothing before this point can have created one.
 */
export function AudioToggle() {
  const enabled = useAppStore((s) => s.audioEnabled);
  const toggle = useAppStore((s) => s.toggleAudio);

  useEffect(() => {
    setAudioEnabled(enabled);
    if (enabled && !hasAmbient() && !prefersReducedMotion()) startAmbient();
  }, [enabled]);

  useEffect(() => () => disposeAudio(), []);

  return (
    <button
      type="button"
      onClick={() => {
        // Fires before the state flips, so turning sound *on* is confirmed by
        // the first sound you hear.
        if (!enabled) {
          setAudioEnabled(true);
          tick(1480, 0.12);
        }
        toggle();
      }}
      aria-pressed={enabled}
      className="group flex items-center gap-2.5 rounded-full border border-line px-3 py-1.5 transition-colors duration-[var(--duration-fast)] hover:border-line-strong"
    >
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {BARS.map((scale, i) => (
          <span
            key={i}
            className={cn(
              "w-[2px] origin-bottom bg-ink-faint transition-colors",
              enabled && "bg-live",
            )}
            style={{
              height: `${scale * 100}%`,
              // Prime-ish durations so the bars never line up into a pattern.
              animation: enabled
                ? `eq ${620 + i * 137}ms ease-in-out ${i * 90}ms infinite alternate`
                : undefined,
            }}
          />
        ))}
      </span>
      <span className="rule-label transition-colors group-hover:text-ink-dim">
        {enabled ? "Sound on" : "Sound off"}
      </span>
    </button>
  );
}
