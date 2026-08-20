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

export interface SequenceManifest {
  generatedAt: string;
  sourceFrameCount: number;
  source: { width: number; height: number };
  variants: Record<DeviceTier, SequenceVariant>;
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
  | { type: "drop"; generation: number };

export type DecodeResponse =
  | {
      type: "decoded";
      index: number;
      bitmap: ImageBitmap;
      bytes: number;
      generation: number;
    }
  | { type: "failed"; index: number; generation: number; message: string };
