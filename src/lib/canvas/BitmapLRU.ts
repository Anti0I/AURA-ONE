/**
 * Fixed-capacity cache of decoded frames.
 *
 * The reason this exists rather than a plain `Map`: an `ImageBitmap` holds
 * uncompressed pixels, and unlike ordinary JS objects it is *not* reclaimed
 * promptly by GC — the backing memory lives outside the JS heap and is only
 * released by `close()`. Holding all 120 frames at 1440² would pin roughly
 * 1 GB. A 24-frame window at the display size sits at 60–80 MB, which is what
 * makes the whole approach viable on a laptop.
 *
 * Recency is tracked with a monotonic counter rather than by re-inserting into
 * a Map: `touch()` runs on every drawn frame, and Map delete+set churns the
 * internal hash table 120 times a second for no benefit.
 */
export class BitmapLRU {
  private readonly entries = new Map<
    number,
    { bitmap: ImageBitmap; bytes: number; usedAt: number }
  >();
  private clock = 0;
  private bytes = 0;
  private guarded: ReadonlySet<number> = new Set();

  /**
   * @param capacity  Maximum frames retained.
   * @param maxBytes  Maximum decoded pixels retained.
   *
   * Both, because a frame count alone is not a memory budget. The same 24
   * frames are 39 MB decoded at 640² and 199 MB at 1440², so a cache sized by
   * count is either wasteful on a laptop or dangerous on a 4K display — and it
   * is the second one you find out about, from somebody else's machine.
   */
  constructor(
    public capacity: number,
    public maxBytes = Infinity,
  ) {}

  get size() {
    return this.entries.size;
  }

  get byteLength() {
    return this.bytes;
  }

  has(index: number) {
    return this.entries.has(index);
  }

  /** Returns the bitmap and marks it as most recently used. */
  get(index: number): ImageBitmap | undefined {
    const entry = this.entries.get(index);
    if (!entry) return undefined;
    entry.usedAt = ++this.clock;
    return entry.bitmap;
  }

  /** Peek without affecting recency — used when hunting for a fallback frame. */
  peek(index: number): ImageBitmap | undefined {
    return this.entries.get(index)?.bitmap;
  }

  set(index: number, bitmap: ImageBitmap, bytes: number) {
    const existing = this.entries.get(index);
    if (existing) {
      // A re-decode at a new size. Release the old pixels immediately.
      existing.bitmap.close();
      this.bytes -= existing.bytes;
    }
    this.entries.set(index, { bitmap, bytes, usedAt: ++this.clock });
    this.bytes += bytes;
    this.evict();
  }

  /**
   * Declares the frames the player is about to need.
   *
   * Eviction happens on *arrival* — a decoded frame lands and pushes the cache
   * over capacity — and during a fast scrub arrivals come in whatever order the
   * network hands them back. Without a standing guard, a frame that was
   * prefetched moments ago can be thrown out by its own siblings landing, and
   * the playhead reaches a gap it already paid to fill. Holding the window here
   * rather than passing it to each call is what makes that impossible.
   *
   * The cache may briefly exceed `capacity` when the whole window is guarded.
   * Overshooting by a few frames costs a few megabytes; a blank canvas mid-scrub
   * costs the illusion.
   */
  protect(indices: ReadonlySet<number>) {
    this.guarded = indices;
    this.evict();
  }

  private evict() {
    while (this.entries.size > this.capacity || this.bytes > this.maxBytes) {
      // Never evict below the guarded window, whatever the byte budget says.
      // Undershooting the prefetch window guarantees a blank frame; being a
      // few megabytes over the budget for a moment does not.
      if (this.entries.size <= this.guarded.size) return;
      let victim = -1;
      let oldest = Infinity;
      for (const [index, entry] of this.entries) {
        if (this.guarded.has(index)) continue;
        if (entry.usedAt < oldest) {
          oldest = entry.usedAt;
          victim = index;
        }
      }
      if (victim === -1) return; // everything is guarded; let it run over
      const entry = this.entries.get(victim)!;
      entry.bitmap.close();
      this.bytes -= entry.bytes;
      this.entries.delete(victim);
    }
  }

  /** Releases every bitmap. Must be called on unmount — GC will not do it. */
  clear() {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
    this.bytes = 0;
  }
}
