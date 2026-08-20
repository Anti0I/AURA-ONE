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
