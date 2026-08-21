/**
 * IVF container reader.
 *
 * IVF is the thinnest container that ffmpeg will write and a browser can be
 * fed from: a 32-byte file header, then a 12-byte header before every frame.
 * That is the entire format. The alternative was MP4 — which means shipping a
 * demuxer, and mp4box.js is roughly 60 KB gzipped to solve a problem that is
 * a hundred lines of `DataView` here.
 *
 * The reader is incremental on purpose. The stream arrives over the network
 * while the visitor is already looking at the hero, and the first frame lives
 * in the first hundred kilobytes or so; waiting for all 3.3 MB before drawing
 * anything would trade the whole benefit away.
 *
 * **It holds a queue of arrived chunks, not one growing buffer.** The obvious
 * implementation — concatenate each chunk onto an accumulator and parse from
 * that — is quadratic, and on this file it is not a theoretical amount:
 *
 *     16 KB chunks -> 214 allocations, 359 MB memcpy, 181 MB retained
 *     64 KB chunks ->  54 allocations,  93 MB memcpy,  84 MB retained
 *                                             (the file is 3.34 MB)
 *
 * The retention is the worse half and the less obvious one. A `subarray` is a
 * view, not a copy, so every frame handed out kept alive the entire accumulator
 * it was cut from — and `frames` is never released, so those accumulators
 * stayed for the session. All of it on the worker thread, during the hero,
 * competing with the decode it exists to feed.
 *
 * Here each frame is copied out exactly once into a buffer of its own size, and
 * a chunk is dropped the moment the last byte of it has been consumed. Total
 * retained is the size of the stream, which is the floor.
 */

const SIGNATURE = 0x46494b44; // "DKIF", little-endian
const FILE_HEADER = 32;
const FRAME_HEADER = 12;

/** Shared stand-in for a consumed slot, so the real chunk can be collected. */
const EMPTY = new Uint8Array(0);

export interface IvfFrame {
  /** Presentation index, which is also the timestamp we hand the decoder. */
  index: number;
  data: Uint8Array;
  key: boolean;
}

export class IvfReader {
  /** Arrived and not yet fully consumed, oldest first. */
  private chunks: Uint8Array[] = [];
  /**
   * Index of the first chunk still holding unconsumed bytes.
   *
   * A head pointer rather than `shift()`: shifting is O(n) in the queue
   * length, and the queue is longest exactly when chunks are smallest — which
   * turns "many small reads" from the slow case into the quadratic one. The
   * consumed prefix is cleared as it is passed so the buffers are collectable.
   */
  private head = 0;
  /** Bytes of `chunks[head]` already consumed. */
  private consumed = 0;
  /** Unconsumed bytes across the whole queue. */
  private available = 0;
  private started = false;

  readonly frames: IvfFrame[] = [];

  /** True once the file header has been read and looked like IVF. */
  get open() {
    return this.started;
  }

  /** Bytes currently held in the queue, waiting to complete a frame. */
  get buffered() {
    return this.available;
  }

  /**
   * Appends bytes and returns whatever complete frames they completed.
   *
   * The chunk is referenced, not copied. It is released as soon as the last
   * frame that needed it has taken its bytes.
   */
  push(chunk: Uint8Array): IvfFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.available += chunk.length;
    }
    // Compact once the consumed prefix dominates, so the array does not grow
    // without bound over a long stream of small reads.
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return this.drain();
  }

  private drain(): IvfFrame[] {
    if (!this.started) {
      if (this.available < FILE_HEADER) return [];
      if (this.readUint32(0) !== SIGNATURE) {
        throw new Error("not an IVF stream");
      }
      const headerLength = this.readUint16(6) || FILE_HEADER;
      if (this.available < headerLength) return [];
      this.advance(headerLength, null);
      this.started = true;
    }

    const out: IvfFrame[] = [];
    for (;;) {
      if (this.available < FRAME_HEADER) break;
      const size = this.readUint32(0);
      if (this.available < FRAME_HEADER + size) break;

      this.advance(FRAME_HEADER, null);
      // One copy, exactly the size of the frame, owning its own buffer. This
      // is what lets the chunks behind it be released.
      const data = new Uint8Array(size);
      this.advance(size, data);

      const frame: IvfFrame = {
        index: this.frames.length,
        data,
        key: isKeyframe(data),
      };
      this.frames.push(frame);
      out.push(frame);
    }
    return out;
  }

  /** Byte at a virtual offset from the read cursor. Header reads only. */
  private byteAt(at: number): number {
    let remaining = at + this.consumed;
    for (let i = this.head; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      if (remaining < chunk.length) return chunk[remaining]!;
      remaining -= chunk.length;
    }
    throw new Error("read past the end of the buffer");
  }

  private readUint16(at: number): number {
    return this.byteAt(at) | (this.byteAt(at + 1) << 8);
  }

  private readUint32(at: number): number {
    // `>>> 0` because the top bit of a frame size would otherwise come back
    // negative, and a negative size reads as "wait for more" forever.
    return (
      (this.byteAt(at) |
        (this.byteAt(at + 1) << 8) |
        (this.byteAt(at + 2) << 16) |
        (this.byteAt(at + 3) << 24)) >>>
      0
    );
  }

  /**
   * Consumes `count` bytes, copying them into `into` when one is given.
   *
   * Chunks that end up fully consumed are dropped here — that release is the
   * whole point of the queue, and doing it anywhere else would be easy to
   * forget.
   */
  private advance(count: number, into: Uint8Array | null) {
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[this.head];
      if (!chunk) throw new Error("advanced past the end of the buffer");

      const from = this.consumed;
      const take = Math.min(chunk.length - from, count - written);
      if (into) into.set(chunk.subarray(from, from + take), written);

      written += take;
      this.consumed += take;
      this.available -= take;

      if (this.consumed >= chunk.length) {
        // Null out as well as advance: the array entry is the only remaining
        // reference to the chunk, so leaving it in place would keep the whole
        // stream alive in a different shape.
        this.chunks[this.head] = EMPTY;
        this.head++;
        this.consumed = 0;
      }
    }
  }
}

/**
 * Reads the frame type out of VP9's uncompressed header.
 *
 * The first byte is bit-packed, MSB first: a two-bit frame marker, two profile
 * bits, `show_existing_frame`, `frame_type`, `show_frame`, `error_resilient`.
 * `frame_type` is 0 for a keyframe.
 *
 * The encoder writes a keyframe every GOP and nothing else, so this could have
 * been derived from the manifest instead. Reading it from the bitstream means
 * the file describes itself: re-encode with different settings and the player
 * is still right, with nothing to keep in sync.
 */
function isKeyframe(data: Uint8Array): boolean {
  const byte = data[0];
  if (byte === undefined) return false;
  const showExisting = (byte >> 3) & 1;
  const frameType = (byte >> 2) & 1;
  return showExisting === 0 && frameType === 0;
}
