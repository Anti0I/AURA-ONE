import { describe, expect, it } from "vitest";
import {
  activeStation,
  railTargets,
  settledAt,
  stationPhase,
  stationSpan,
  stationStart,
  PRESENT,
} from "@/components/acoustics/stations";

/**
 * The acoustics section's beat windows.
 *
 * These are unit tests rather than e2e ones on purpose. The bug they exist to
 * prevent — two beats readable at once — is a property of the arithmetic that
 * holds or fails at *every* scroll position, and checking it by driving a real
 * browser to forty positions costs three seconds each and still only samples
 * forty of them. Here it is a thousand samples in a millisecond, exhaustively.
 */

const COUNT = 3;

describe("station windows", () => {
  it("never has two beats on screen at once", () => {
    for (let s = 0; s <= 1000; s++) {
      const p = s / 1000;
      const present = Array.from({ length: COUNT }, (_, i) =>
        stationPhase(p, i, COUNT),
      ).filter((phase) => phase.presence > PRESENT);

      expect(present.length, `two beats overlap at p=${p.toFixed(3)}`)
        .toBeLessThanOrEqual(1);
    }
  });

  it("leaves a stretch of pure travel between beats", () => {
    // Not an accident to be tolerated — the flight is the transition. If a
    // change closes it up, the starfield has nothing to do and the section is
    // back to swapping paragraphs.
    const empty = (p: number) =>
      Array.from({ length: COUNT }, (_, i) => stationPhase(p, i, COUNT)).every(
        (phase) => phase.gone,
      );

    expect(empty(0.355)).toBe(true);
    expect(empty(0.695)).toBe(true);
  });

  it("holds each beat still for longer than it spends moving", () => {
    // A beat that is arriving or leaving for most of its window is a beat
    // nobody can read.
    for (let i = 0; i < COUNT; i++) {
      const span = stationSpan(COUNT);
      const start = stationStart(i, COUNT);
      let held = 0;
      for (let s = 0; s <= 1000; s++) {
        const p = s / 1000;
        if (p < start || p > start + span) continue;
        if (stationPhase(p, i, COUNT).presence >= 1) held++;
      }
      expect(held / (span * 1000)).toBeGreaterThan(0.5);
    }
  });

  it("settles the last beat and holds it to the end of the section", () => {
    const last = stationPhase(1, COUNT - 1, COUNT);
    expect(last.presence).toBe(1);
    expect(last.exit).toBe(0);
  });

  it("puts every rail target inside its own beat's readable window", () => {
    railTargets(COUNT).forEach((target, i) => {
      expect(stationPhase(target, i, COUNT).presence).toBe(1);
    });
    expect(railTargets(COUNT)).toEqual([0, 1, 2].map((i) => settledAt(i, COUNT)));
  });

  it("moves the rail marker mid-flight, not on arrival", () => {
    expect(activeStation(0.1, COUNT)).toBe(0);
    expect(activeStation(0.354, COUNT)).toBe(0);
    expect(activeStation(0.356, COUNT)).toBe(1);
    expect(activeStation(0.9, COUNT)).toBe(2);
  });
});
