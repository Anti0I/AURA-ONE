/**
 * IVF container reader.
 *
 * IVF is the thinnest container that ffmpeg will write and a browser can be
 * fed from: a 32-byte file header, then a 12-byte header before every frame.
 * That is the entire format. The alternative was MP4 — which means shipping a
 * demuxer, and mp4box.js is roughly 60 KB gzipped to solve a problem that is
 * thirty lines of `DataView` here.
 *
 * The reader is incremental on purpose. The stream arrives over the network
 * while the visitor is already looking at the hero, and the first frame lives
 * in the first hundred kilobytes or so; waiting for all 3.3 MB before drawing
 * anything would trade the whole benefit away.
 */

const SIGNATURE = 0x46494b44; // "DKIF", little-endian
const FILE_HEADER = 32;
const FRAME_HEADER = 12;

export interface IvfFrame {
  /** Presentation index, which is also the timestamp we hand the decoder. */
  index: number;
  data: Uint8Array;
  key: boolean;
}

export class IvfReader {
  private buffer = new Uint8Array(0);
  private cursor = 0;
  private started = false;

  readonly frames: IvfFrame[] = [];

  /** True once the file header has been read and looked like IVF. */
  get open() {
    return this.started;
  }

  /**
   * Appends bytes and returns whatever complete frames they completed.
   *
   * Copies into a single growing buffer rather than keeping a list of chunks.
   * A frame can straddle any number of network chunks, and the alternative —
   * stitching across a list on every parse — is more code for a buffer that
   * tops out at a few megabytes.
   */
  push(chunk: Uint8Array): IvfFrame[] {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    return this.drain();
  }

  private drain(): IvfFrame[] {
    const view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    );

    if (!this.started) {
      if (this.buffer.length < FILE_HEADER) return [];
      if (view.getUint32(0, true) !== SIGNATURE) {
        throw new Error("not an IVF stream");
      }
      this.cursor = view.getUint16(6, true) || FILE_HEADER;
      this.started = true;
    }

    const out: IvfFrame[] = [];
    for (;;) {
      if (this.cursor + FRAME_HEADER > this.buffer.length) break;
      const size = view.getUint32(this.cursor, true);
      const start = this.cursor + FRAME_HEADER;
      if (start + size > this.buffer.length) break;

      const data = this.buffer.subarray(start, start + size);
      const frame: IvfFrame = {
        index: this.frames.length,
        data,
        key: isKeyframe(data),
      };
      this.frames.push(frame);
      out.push(frame);
      this.cursor = start + size;
    }
    return out;
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
