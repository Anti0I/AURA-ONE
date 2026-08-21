import { describe, it, expect } from "vitest";
import {
  BATTERY,
  POWER_MODES,
  averageDraw,
  runtimeHours,
} from "@/data/specs";
import { SCENARIOS } from "@/lib/ai/deterministic/scenarios";
import { MATERIALS, MATERIAL_IDS, getMaterial } from "@/data/materials";

/**
 * Every battery figure on this site is quoted in three places: the bento
 * slider computes it, the playground scenario states it in prose, and the
 * generated PDF prints it. Nothing enforces that they agree except this file.
 *
 * The failure mode without it is not a crash — it is a spec sheet that
 * contradicts the paragraph next to it, which is the single most embarrassing
 * thing a product page can do.
 */
describe("power model", () => {
  const rows = SCENARIOS.find((s) => s.id === "power")!.steps.find(
    (s) => s.kind === "telemetry",
  )!;

  const stated = (label: string) => {
    if (rows.kind !== "telemetry") throw new Error("expected telemetry step");
    const row = rows.rows.find((r) => r.label === label);
    if (!row) throw new Error(`no row "${label}"`);
    return row.value;
  };

  it("the cell's energy is consistent with its rating", () => {
    expect(BATTERY.milliwattHours).toBeCloseTo(78 * 3.85, 6);
  });

  it("playback runtime matches the copy", () => {
    const mode = POWER_MODES.find((m) => m.id === "playback")!;
    expect(runtimeHours(mode.mw)).toBeCloseTo(stated("Playback only"), 1);
  });

  it("ANC runtime matches the copy", () => {
    const mode = POWER_MODES.find((m) => m.id === "anc")!;
    expect(runtimeHours(mode.mw)).toBeCloseTo(stated("With adaptive ANC"), 1);
  });

  it("inference runtime matches the copy", () => {
    const mode = POWER_MODES.find((m) => m.id === "inference")!;
    expect(runtimeHours(mode.mw)).toBeCloseTo(
      stated("Continuous inference"),
      1,
    );
  });

  it("the mixed duty cycle matches the copy and the tool call", () => {
    // The scenario's tool call declares 60/30/10; the same split has to
    // produce the number the following paragraph quotes.
    const hours = runtimeHours(
      averageDraw({ playback: 0.6, anc: 0.3, inference: 0.1 }),
    );
    expect(hours).toBeCloseTo(stated("Mixed duty cycle"), 1);

    const step = SCENARIOS.find((s) => s.id === "power")!.steps.find(
      (s) => s.kind === "tool",
    )!;
    if (step.kind !== "tool") throw new Error("expected tool step");
    expect(step.result).toContain(hours.toFixed(1));
  });

  it("modes are ordered from cheapest to most expensive", () => {
    const draws = POWER_MODES.map((m) => m.mw);
    expect([...draws].sort((a, b) => a - b)).toEqual(draws);
  });
});

describe("finishes", () => {
  it("every declared id has exactly one material", () => {
    expect(MATERIALS.map((m) => m.id).sort()).toEqual([...MATERIAL_IDS].sort());
    for (const id of MATERIAL_IDS) expect(getMaterial(id).id).toBe(id);
  });

  it("darker finishes carry lower exposure", () => {
    // The tint alone cannot darken anything (see Material.exposure), so a dark
    // finish that forgot its exposure would silently render as bright chrome —
    // which is exactly the bug this ordering check exists to catch.
    const byLightness = [...MATERIALS].sort(
      (a, b) => oklabL(a.tint) - oklabL(b.tint),
    );
    const exposures = byLightness.map((m) => m.exposure);
    expect([...exposures].sort((a, b) => a - b)).toEqual(exposures);
  });

  it("tints are six-digit hex", () => {
    for (const m of MATERIALS) expect(m.tint).toMatch(/^#[0-9a-f]{6}$/);
  });
});

function oklabL(hex: string): number {
  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const value = parseInt(hex.slice(1), 16);
  const r = toLinear(((value >> 16) & 255) / 255);
  const g = toLinear(((value >> 8) & 255) / 255);
  const b = toLinear((value & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}
