/**
 * Types for the procedural scene.
 *
 * `scene.mjs` is plain ESM with no build step, because the prerender harness
 * serves it straight to headless Chromium through an import map — a bundler in
 * the render path would be one more thing between the geometry and the pixels.
 * The configurator imports the same file, so this describes the surface it uses
 * rather than converting the scene to TypeScript and putting a compiler back in
 * the render path.
 *
 * Only what the app actually calls is declared. The prerender script is
 * JavaScript and does not need any of this.
 */

export interface Finish {
  /** Any CSS colour string; passed to `THREE.Color.set`. */
  color: string;
  metalness: number;
  roughness: number;
}

export interface Stage {
  /** Sizes the drawing buffer. `pixelRatio` is capped at 2 internally. */
  setSize(width: number, height: number, pixelRatio?: number): void;
  /** Draws the scrollytelling timeline at `t` in 0..1. */
  renderFrame(t: number): void;
  /**
   * Points the camera at the assembled device and draws it. Angles in radians;
   * clamping elevation is the caller's job.
   */
  orbit(azimuth: number, elevation: number, distance?: number): void;
  setFinish(finish: Finish): void;
  /**
   * Builds a deferred environment and compiles every program `orbit` draws
   * with, without blocking the main thread. Resolves when the first `orbit`
   * will not stall on the shader compiler.
   */
  prepare(): Promise<void>;
  /** Releases geometry, materials and the WebGL context. */
  dispose(): void;
}

/**
 * Generates the procedural texture sets one task at a time, so the
 * `createStage` that follows does not build them in one long block.
 */
export declare function prebuildTextures(): Promise<void>;

export declare function createStage(
  canvas: HTMLCanvasElement,
  options?: { deferEnvironment?: boolean },
): Stage;

export declare const PHASES: {
  ROTATE_END: number;
  EXPLODE_END: number;
  HOLD_END: number;
  PUSH_END: number;
};
