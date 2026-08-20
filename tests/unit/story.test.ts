import { describe, it, expect } from "vitest";
import { STORY, beatOpacity, activeBeat, PHASES } from "@/data/story";
import { HERO_HOLD } from "@/data/story";
import { clamp, damp, mapRange } from "@/lib/utils";

/**
 * The caption timing is the part of the scrollytelling most likely to break
 * silently: nothing errors when two beats overlap or when one never reaches
 * full opacity, it just looks slightly wrong in a way that is hard to catch by
 * scrolling past it.
 */
describe("story timeline", () => {
  it("never shows two beats at once", () => {
    for (let t = 0; t <= 1; t += 0.002) {
      const visible = STORY.filter((b) => beatOpacity(t, b) > 0.02);
      expect(visible.length, `two beats visible at t=${t.toFixed(3)}`).toBeLessThan(2);
    }
  });

  it("every beat reaches full opacity somewhere", () => {
    for (const beat of STORY) {
      let peak = 0;
      for (let t = beat.from; t <= beat.to; t += 0.001) {
        peak = Math.max(peak, beatOpacity(t, beat));
      }
      expect(peak, beat.id).toBeGreaterThan(0.99);
    }
  });

  it("beats are fully hidden outside their window", () => {
    for (const beat of STORY) {
      expect(beatOpacity(beat.from - 0.001, beat)).toBe(0);
      expect(beatOpacity(beat.to + 0.001, beat)).toBe(0);
    }
  });

  it("each beat sits inside the render phase it describes", () => {
    // Caption windows and the Blender/Three timeline are defined in two files;
    // this is what stops them drifting apart.
    expect(STORY[0]!.to).toBeLessThanOrEqual(PHASES.ROTATE_END);
    expect(STORY[1]!.from).toBeGreaterThanOrEqual(PHASES.ROTATE_END);
    expect(STORY[1]!.to).toBeLessThanOrEqual(PHASES.HOLD_END);
    expect(STORY[2]!.from).toBeGreaterThanOrEqual(PHASES.HOLD_END);
  });

  it("activeBeat agrees with the visible caption", () => {
    for (const [i, beat] of STORY.entries()) {
      const middle = (beat.from + beat.to) / 2;
      expect(activeBeat(middle)).toBe(i);
    }
  });

  it("the hero hold leaves the whole sequence reachable", () => {
    const t = (p: number) => clamp((p - HERO_HOLD) / (1 - HERO_HOLD), 0, 1);
    expect(t(HERO_HOLD)).toBe(0);
    expect(t(1)).toBe(1);
    expect(t(0)).toBe(0);
  });
});

describe("math helpers", () => {
  it("damp is frame-rate independent", () => {
    // The same elapsed time must produce the same result whether it arrived as
    // one 60 Hz frame or two at 120 Hz. A plain lerp fails this.
    const oneStep = damp(0, 1, 8, 1 / 60);

    let twoSteps = 0;
    twoSteps = damp(twoSteps, 1, 8, 1 / 120);
    twoSteps = damp(twoSteps, 1, 8, 1 / 120);

    expect(twoSteps).toBeCloseTo(oneStep, 10);
  });

  it("mapRange clamps to the output range in both directions", () => {
    expect(mapRange(5, 0, 10, 0, 1)).toBeCloseTo(0.5);
    expect(mapRange(-5, 0, 10, 0, 1)).toBe(0);
    expect(mapRange(50, 0, 10, 0, 1)).toBe(1);
    // Inverted output range — used for the spec sheet's fade-out.
    expect(mapRange(0, 10, 0, 0, 1)).toBe(1);
    expect(mapRange(20, 10, 0, 0, 1)).toBe(0);
  });
});
