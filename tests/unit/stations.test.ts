import { describe, expect, it } from "vitest";
import {
  activeStation,
  railTargets,
  settledAt,
  stationPhase,
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

    expect(empty(0.3583)).toBe(true);
    expect(empty(0.6917)).toBe(true);
  });

  it("gives the approach about twice the scroll the retreat gets", () => {
    // The first version made these equal, and short: a fifth of a station
    // each, which is a wheel notch and a half from parked to fully arrived.
    // That is not an approach, it is a cut, and it was reported as one.
    //
    // Coming towards you is the part worth watching. Leaving is not — the beat
    // has been read and the scroll is already going somewhere else.
    let arriving = 0;
    let leaving = 0;
    for (let s = 0; s <= 20000; s++) {
      const phase = stationPhase(s / 20000, 0, COUNT);
      if (phase.presence <= PRESENT) continue;
      if (phase.enter < 1) arriving++;
      else if (phase.exit > 0) leaving++;
    }
    expect(arriving / leaving).toBeGreaterThan(1.8);
    expect(arriving / leaving).toBeLessThan(2.3);
  });

  it("holds each beat still long enough to read it", () => {
    // The hold is deliberately no longer the majority of a station — the
    // approach is. But it still has to be a stop rather than a turning point,
    // and at the section's height 8% of it is a little under forty viewport
    // heights of scroll with the card flat, centred and motionless.
    for (let i = 0; i < COUNT; i++) {
      let held = 0;
      for (let s = 0; s <= 20000; s++) {
        if (stationPhase(s / 20000, i, COUNT).presence >= 1) held++;
      }
      expect(held / 20000, `beat ${i + 1} barely stops`).toBeGreaterThan(0.08);
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
    expect(activeStation(0.357, COUNT)).toBe(0);
    expect(activeStation(0.36, COUNT)).toBe(1);
    expect(activeStation(0.9, COUNT)).toBe(2);
  });
});
