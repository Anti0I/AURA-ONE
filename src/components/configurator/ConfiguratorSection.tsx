"use client";

import { useCallback, useState } from "react";
import { MATERIALS, getMaterial } from "@/data/materials";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";
import { useClientValue } from "@/lib/useClientValue";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ConfiguratorLive } from "./ConfiguratorLive";
import { ConfiguratorFallback } from "./ConfiguratorFallback";

/**
 * Probes for a WebGL2 context on a throwaway canvas.
 *
 * Feature-detecting by construction rather than by sniffing: plenty of machines
 * report the API and then fail to give you a context — blocklisted drivers,
 * a browser with hardware acceleration switched off, a VM. The one that lies
 * is the one the fallback exists for.
 */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * Finish configurator.
 *
 * The product here is the live procedural scene — the same one the walkthrough
 * is baked from — so it turns in any direction rather than spinning about a
 * single axis, and the finishes are real materials under a real environment
 * map rather than a tint applied over a photograph.
 */
export function ConfiguratorSection() {
  const material = useAppStore((s) => s.material);
  const setMaterial = useAppStore((s) => s.setMaterial);

  // Assume WebGL on the server so the markup does not flash the fallback.
  const supported = useClientValue(hasWebGL, true);
  // Detection can still be wrong — a context that constructs and then fails to
  // do anything useful. The live view reports that itself.
  const [failed, setFailed] = useState(false);
  const onFail = useCallback(() => setFailed(true), []);

  const live = supported && !failed;
  const active = getMaterial(material);

  return (
    <section
      id="configurator"
      className="relative border-t border-line px-gutter py-24"
    >
      <div aria-hidden className="noise-field" />

      <header className="relative mb-12 flex flex-wrap items-end justify-between gap-6">
        <div>
          <SectionLabel index={3}>Configure</SectionLabel>
          <h2 className="mt-5 max-w-[18ch] text-title font-medium text-ink">
            One scene, rendered twice.
          </h2>
        </div>
        <p className="max-w-[44ch] text-ink-dim">
          The walkthrough above is this object, baked to frames offline where
          deterministic timing matters. Here it runs live, because turning
          something over is not a thing a strip of frames can do.
        </p>
      </header>

      <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {live ? <ConfiguratorLive onFail={onFail} /> : <ConfiguratorFallback />}

        <div className="flex flex-col gap-3">
          <fieldset>
            <legend className="rule-label mb-3">Finish</legend>
            <ul className="flex flex-col gap-2">
              {MATERIALS.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setMaterial(option.id);
                      // Each finish gets its own pitch, which a sample could
                      // not do without shipping four of them.
                    }}
                    aria-pressed={material === option.id}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-tile border px-3 py-3 text-left transition-colors",
                      material === option.id
                        ? "border-signal bg-signal/5"
                        : "border-line hover:border-line-strong",
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-6 shrink-0 rounded-full border border-line-strong"
                      style={{ backgroundColor: option.color }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-ink">
                        {option.name}
                      </span>
                      <span className="rule-label block">{option.code}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>

          <p className="mt-1 text-sm leading-relaxed text-ink-dim">
            {active.blurb}
          </p>

          {!live ? (
            <p className="rule-label mt-2 leading-relaxed">
              WebGL unavailable — showing the pre-rendered turntable, which
              turns about one axis only.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
