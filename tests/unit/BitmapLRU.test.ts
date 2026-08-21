import { describe, it, expect, vi } from "vitest";
import { BitmapLRU } from "@/lib/canvas/BitmapLRU";

/**
 * The cache's whole job is to stop the page from pinning a gigabyte of decoded
 * frames, and the mechanism that does it — calling `close()` on eviction — is
 * invisible: skip it and everything still *works*, it just leaks until the tab
 * dies. So these tests assert on `close()` calls, not only on `size`.
 */

function fakeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return {
    width: 900,
    height: 900,
    close: vi.fn(),
  } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

const BYTES = 900 * 900 * 4;

describe("BitmapLRU", () => {
  it("stays at capacity and releases what it evicts", () => {
    const cache = new BitmapLRU(4);
    const bitmaps = Array.from({ length: 7 }, fakeBitmap);

    bitmaps.forEach((b, i) => cache.set(i, b, BYTES));

    expect(cache.size).toBe(4);
    expect(cache.byteLength).toBe(4 * BYTES);
    // The first three are gone, and gone means closed.
    for (let i = 0; i < 3; i++) expect(bitmaps[i]!.close).toHaveBeenCalledOnce();
    for (let i = 3; i < 7; i++) expect(bitmaps[i]!.close).not.toHaveBeenCalled();
  });

  it("evicts by recency, not by insertion order", () => {
    const cache = new BitmapLRU(3);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const c = fakeBitmap();
    cache.set(0, a, BYTES);
    cache.set(1, b, BYTES);
    cache.set(2, c, BYTES);

    cache.get(0); // 0 is now the most recent, so 1 is the oldest
    cache.set(3, fakeBitmap(), BYTES);

    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(b.close).toHaveBeenCalledOnce();
  });

  it("peek does not affect recency", () => {
    const cache = new BitmapLRU(2);
    const a = fakeBitmap();
    cache.set(0, a, BYTES);
    cache.set(1, fakeBitmap(), BYTES);

    // A fallback draw peeks at neighbours; that must not rescue a stale frame
    // at the expense of one the playhead is heading towards.
    cache.peek(0);
    cache.set(2, fakeBitmap(), BYTES);

    expect(cache.has(0)).toBe(false);
    expect(a.close).toHaveBeenCalledOnce();
  });

  it("replacing an index releases the old bitmap", () => {
    const cache = new BitmapLRU(4);
    const small = fakeBitmap();
    cache.set(5, small, 1000);
    cache.set(5, fakeBitmap(), 2000);

    expect(small.close).toHaveBeenCalledOnce();
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(2000);
  });

  it("never evicts a guarded frame, even under its own arrivals", () => {
    // The failure this guards against: during a fast scrub, frames land in
    // whatever order the network returns them, and later arrivals evict
    // earlier ones from the very window the playhead is heading into.
    const cache = new BitmapLRU(2);
    cache.protect(new Set([3, 4]));

    const guarded = [fakeBitmap(), fakeBitmap()];
    cache.set(3, guarded[0]!, BYTES);
    cache.set(4, guarded[1]!, BYTES);
    for (let i = 5; i < 9; i++) cache.set(i, fakeBitmap(), BYTES);

    expect(cache.has(3)).toBe(true);
    expect(cache.has(4)).toBe(true);
    expect(guarded[0]!.close).not.toHaveBeenCalled();
    expect(guarded[1]!.close).not.toHaveBeenCalled();

    // Once the window moves on, the old frames become evictable again.
    cache.protect(new Set([8]));
    cache.set(9, fakeBitmap(), BYTES);
    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it("clear releases everything", () => {
    const cache = new BitmapLRU(8);
    const bitmaps = Array.from({ length: 5 }, fakeBitmap);
    bitmaps.forEach((b, i) => cache.set(i, b, BYTES));

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    for (const b of bitmaps) expect(b.close).toHaveBeenCalledOnce();
  });
});

describe("BitmapLRU byte budget", () => {
  it("evicts on bytes even when the frame count is fine", () => {
    // 24 frames is 39 MB at a 640 decode and 199 MB at 1440. A cache sized
    // only by count silently becomes the second one on a 4K display.
    const cache = new BitmapLRU(24, 40 * 1024 * 1024);
    for (let i = 0; i < 24; i++) cache.set(i, fakeBitmap(), 8 * 1024 * 1024);

    expect(cache.size).toBeLessThan(24);
    expect(cache.byteLength).toBeLessThanOrEqual(40 * 1024 * 1024);
  });

  it("keeps the guarded window over the *count* limit", () => {
    // Undershooting the prefetch window guarantees a blank frame mid-scrub;
    // holding a few frames more than the count says does not. The byte ceiling
    // is a different matter — see below, and note that this test used to
    // assert the guard won there too, which is what made that ceiling
    // unreachable in the one situation it existed for.
    const cache = new BitmapLRU(2, Infinity);
    const guarded = new Set([0, 1, 2, 3]);
    cache.protect(guarded);
    for (const i of guarded) cache.set(i, fakeBitmap(), BYTES);

    expect(cache.size).toBe(4);
    for (const i of guarded) expect(cache.has(i)).toBe(true);
  });

  it("defaults to no byte limit", () => {
    const cache = new BitmapLRU(4);
    for (let i = 0; i < 4; i++) cache.set(i, fakeBitmap(), 1e9);
    expect(cache.size).toBe(4);
  });
});

describe("BitmapLRU under a byte ceiling", () => {
  /**
   * The guarded window used to win outright, which made the byte ceiling
   * decorative. At 1440² a frame is 7.91 MB and the player's window is 29 of
   * them — 229 MB against a stated 160 — and because eviction stopped as soon
   * as everything left was guarded, the ceiling could never take effect. It
   * only shows up on a high-DPI display, so it is the kind of bug you hear
   * about from somebody else's machine: measured at 189.8 MB in a 3456x2234
   * canvas before the fix, 158.2 MB after.
   */
  it("keeps the byte ceiling even when the whole window is guarded", () => {
    const ceiling = 10 * BYTES;
    const cache = new BitmapLRU(64, ceiling);

    // Guard far more than the ceiling can hold.
    const window = new Set(Array.from({ length: 30 }, (_, i) => i));
    cache.protect(window);

    const bitmaps = Array.from({ length: 30 }, fakeBitmap);
    bitmaps.forEach((b, i) => cache.set(i, b, BYTES));

    expect(cache.byteLength).toBeLessThanOrEqual(ceiling);
    // And what it dropped, it released.
    const closed = bitmaps.filter((b) => b.close.mock.calls.length > 0).length;
    expect(closed).toBe(30 - cache.size);
  });

  it("still prefers unguarded frames when there are any", () => {
    const cache = new BitmapLRU(64, 3 * BYTES);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const c = fakeBitmap();
    const d = fakeBitmap();

    cache.set(0, a, BYTES);
    cache.set(1, b, BYTES);
    cache.set(2, c, BYTES);
    // 1 and 2 are the window; 0 is not, so 0 is what goes.
    cache.protect(new Set([1, 2, 3]));
    cache.set(3, d, BYTES);

    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
  });

  it("never empties itself to satisfy an impossible ceiling", () => {
    // A ceiling smaller than one frame. Two frames stay regardless: the one
    // being drawn and the one it is cross-fading towards. A blank canvas is
    // not a valid way to come in under budget.
    const cache = new BitmapLRU(64, BYTES / 4);
    const bitmaps = Array.from({ length: 5 }, fakeBitmap);
    cache.protect(new Set([0, 1, 2, 3, 4]));
    bitmaps.forEach((b, i) => cache.set(i, b, BYTES));

    expect(cache.size).toBe(2);
  });
});
