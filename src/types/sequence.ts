import type { DeviceTier } from "@/lib/motion";

export interface SequenceVariant {
  width: number;
  height: number;
  basePath: string;
  ext: string;
  /** Frames in *this* variant. Mobile ships every second source frame. */
  frameCount: number;
  stride: number;
  totalBytes: number;
  maxFrameBytes: number;
  avgFrameBytes: number;
}

export interface XraySource {
  width: number;
  url: string;
  bytes: number;
}

/**
 * The VP9 stream the player uses when WebCodecs is available.
 *
 * Colour and matte are packed side by side in one frame, because video has no
 * alpha channel; `width`/`height` describe the drawable half and `matteX` says
 * where the other one starts.
 */
export interface VideoVariant {
  url: string;
  /** Full codec string — `VideoDecoder` rejects anything less specific. */
  codec: string;
  frameCount: number;
  /** Keyframe interval, i.e. the worst-case number of decodes to seek. */
  gop: number;
  width: number;
  height: number;
  matteX: number;
  packedWidth: number;
  packedHeight: number;
  bytes: number;
}

export interface SequenceManifest {
  generatedAt: string;
  sourceFrameCount: number;
  source: { width: number; height: number };
  variants: Record<DeviceTier, SequenceVariant>;
  video: Record<DeviceTier, VideoVariant>;
  xray: Record<"outer" | "inner", XraySource[]>;
}

/** Builds the URL for one frame. Indices are 1-based, matching the files. */
export function frameUrl(variant: SequenceVariant, index: number): string {
  return `${variant.basePath}/aura_${String(index + 1).padStart(4, "0")}.${variant.ext}`;
}

// ---- Worker protocol ------------------------------------------------------

export type DecodeRequest =
  | {
      type: "decode";
      index: number;
      url: string;
      decodeWidth: number;
      /** Bumped whenever decode size changes; stale results are dropped. */
      generation: number;
      /** True for the frame on screen right now — jumps the queue. */
      urgent: boolean;
    }
  | { type: "drop"; generation: number }
  /**
   * The frames the player still cares about, as an inclusive range.
   *
   * Without this the only way a request left the queue was by being satisfied,
   * so a fast scrub had the worker decoding, compositing and transferring
   * frames the playhead had passed several hundred milliseconds earlier — work
   * that is wasted twice, because the result then evicts a frame that is still
   * wanted. Two numbers rather than the set: the window is contiguous by
   * construction, and this is sent whenever it moves.
   */
  | { type: "window"; lo: number; hi: number }
  /** Video worker only: hands it the stream to open. */
  | { type: "open"; video: VideoVariant };

export type DecodeResponse =
  | {
      type: "decoded";
      index: number;
      bitmap: ImageBitmap;
      bytes: number;
      generation: number;
    }
  | { type: "failed"; index: number; generation: number; message: string }
  /**
   * Video worker only: this browser cannot decode the stream, so the player
   * should swap to the still sequence. Reported by the worker rather than
   * probed on the main thread, because `VideoDecoder.isConfigSupported` is
   * async and the answer is only ever needed here.
   */
  | { type: "unsupported"; reason: string };
