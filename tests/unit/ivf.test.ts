import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { IvfReader } from "@/lib/canvas/ivf";
import SEQUENCE from "@/data/sequence.json";

/**
 * The container reader, against the stream the site actually ships.
 *
 * A synthetic fixture would not have caught what was wrong with the previous
 * implementation, because the bug was not in the parse: the frames it produced
 * were correct. It was in what the parse *kept* — every frame was a `subarray`
 * of a growing accumulator, so each one pinned the whole accumulator it was cut
 * from, and none of them were ever released. 181 MB retained for a 4.31 MB
 * file, on the worker thread, during the hero.
 *
 * So the assertions that matter here are about identity across chunk sizes and
 * about bytes held, not about whether it can find a frame boundary.
 */

const FILE = path.join(process.cwd(), "public", "seq", "desktop.ivf");
const stream = new Uint8Array(fs.readFileSync(FILE));

/**
 * Read from the manifest the encoder writes, not typed in here.
 *
 * These were the literals 240 and 240/16, which is a test that has to be
 * remembered every time the render changes its frame count — and was not, the
 * first time it did. The manifest is written by the same script that produced
 * the file being parsed, so the two cannot disagree.
 */
const EXPECTED_FRAMES = SEQUENCE.video.desktop.frameCount;
const GOP = 16;

/** Byte-for-byte, without allocating a JS array per frame to do it. */
function same(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Feeds the whole stream in fixed-size pieces, as the network would. */
function parse(chunkSize: number) {
  const reader = new IvfReader();
  for (let at = 0; at < stream.length; at += chunkSize) {
    reader.push(stream.subarray(at, Math.min(at + chunkSize, stream.length)));
  }
  return reader;
}

describe("IvfReader", () => {
  // A byte at a time is 3.3 million pushes. It is in here because it is the
  // shape that broke the first rewrite — a queue that shifts is quadratic
  // exactly when the chunks are smallest.
  it("reads the same frames whatever the network chunking looks like", { timeout: 60_000 }, () => {
    const whole = parse(stream.length);
    expect(whole.open).toBe(true);
    expect(whole.frames.length).toBe(EXPECTED_FRAMES);

    // 1 byte at a time puts a split inside every header and every payload;
    // 13 is a prime that lands nowhere near a frame boundary; 65536 is a
    // realistic read. All three have to agree, byte for byte.
    for (const size of [1, 13, 4096, 65536]) {
      const reader = parse(size);
      expect(reader.frames.length, `${size} byte chunks`).toBe(
        whole.frames.length,
      );
      for (let i = 0; i < whole.frames.length; i++) {
        const a = whole.frames[i]!;
        const b = reader.frames[i]!;
        expect(b.index, `frame ${i} @${size}`).toBe(a.index);
        expect(b.key, `frame ${i} @${size}`).toBe(a.key);
        expect(same(a.data, b.data), `frame ${i} @${size}`).toBe(true);
      }
    }
  });

  it("finds a keyframe every GOP, read from the bitstream not the manifest", () => {
    const keys = parse(65536)
      .frames.filter((f) => f.key)
      .map((f) => f.index);
    expect(keys[0]).toBe(0);
    expect(keys.length).toBe(Math.ceil(EXPECTED_FRAMES / GOP));
    for (const index of keys) expect(index % GOP).toBe(0);
  });

  it("keeps no more than the stream itself, and releases consumed chunks", () => {
    const reader = parse(16384);

    // The retention regression. Each frame must own a buffer of exactly its own
    // size: a view into something larger pins the larger thing. `byteLength`
    // of the underlying buffer is what catches that — `data.length` would look
    // correct either way.
    let held = 0;
    for (const frame of reader.frames) {
      expect(frame.data.buffer.byteLength).toBe(frame.data.length);
      expect(frame.data.byteOffset).toBe(0);
      held += frame.data.buffer.byteLength;
    }

    expect(held).toBeLessThanOrEqual(stream.length);
    // Everything fed has been consumed; nothing is parked waiting for a frame
    // that will never complete.
    expect(reader.buffered).toBe(0);
  });

  it("waits rather than guessing when a frame is still arriving", () => {
    const reader = new IvfReader();
    // The file header alone completes nothing.
    expect(reader.push(stream.subarray(0, 32))).toEqual([]);
    expect(reader.open).toBe(true);
    // A frame header with none of its payload completes nothing either.
    expect(reader.push(stream.subarray(32, 44))).toEqual([]);
    expect(reader.frames.length).toBe(0);
  });

  it("rejects a stream that is not IVF", () => {
    const reader = new IvfReader();
    expect(() => reader.push(new Uint8Array(64))).toThrow(/not an IVF stream/);
  });
});
