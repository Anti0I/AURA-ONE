/**
 * A field of stars flying past the camera, driven by scroll.
 *
 * Same discipline as `Particles`: one preallocated `Float32Array`, written in
 * place, never grown. A separate class rather than a mode on that one because
 * almost nothing is shared — there are no bursts here, no lifetimes and no
 * drag, just a perspective projection with wrap-around and a streak whose
 * length falls out of the speed.
 *
 * That last part is the whole trick, and it is why there is no switch between
 * "drifting dust" and "hyperspace". A star is drawn as the segment between
 * where it is and where it was a moment ago. Standing still that segment is
 * sub-pixel and the field reads as points; under a fast scroll it stretches
 * into the lines everyone recognises. One mechanism, both pictures.
 *
 * Layout per star: x, y, z, tint.
 */

const STRIDE = 4;
const X = 0;
const Y = 1;
const Z = 2;
const TINT = 3;

/** Depth range. A star passing NEAR is recycled to FAR. */
const NEAR = 0.09;
const FAR = 1;

/**
 * How far back along its own path a star is drawn from.
 *
 * Above 1 the streak is longer than the distance actually covered since the
 * last frame. That is a lie, and it is the right one: at a plausible cruise the
 * honest streak is a fifth of a pixel, so the field would only ever look like
 * static until the scroll got violent.
 */
const STREAK = 3.2;

/**
 * Depth is quantised into this many bands, and each band is stroked as a single
 * path.
 *
 * Brightness and line width both follow depth, and both are per-stroke state —
 * so drawing honestly means one stroke call per star. Four bands times two
 * tints is eight for the whole field. The same reasoning as the stepped blur
 * radius in `SectionHandoff`: the eye cannot resolve the steps, and the
 * compositor very much can.
 */
const BANDS = 4;

/** Fraction of stars drawn in the accent colour. */
const TINTED = 0.13;

export interface StarfieldColors {
  /** The great majority. */
  star: string;
  /** The accent minority, so the field belongs to this page and not to a demo. */
  warp: string;
}

export class Starfield {
  private readonly data: Float32Array;
  private readonly capacity: number;

  /** Per group: x1, y1, x2, y2 for each segment. Group = tint * BANDS + band. */
  private readonly groups: Float32Array[];
  private readonly counts: Int32Array;

  private width = 0;
  private height = 0;
  private focal = 0;

  constructor(capacity = 900) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.groups = Array.from(
      { length: BANDS * 2 },
      () => new Float32Array(capacity * 4),
    );
    this.counts = new Int32Array(BANDS * 2);

    for (let i = 0; i < capacity; i++) {
      this.spawn(i, NEAR + Math.random() * (FAR - NEAR));
    }
  }

  /** Places star `i` at depth `z` with a fresh position on the plane. */
  private spawn(i: number, z: number) {
    const base = i * STRIDE;
    this.data[base + X] = Math.random() * 2 - 1;
    this.data[base + Y] = Math.random() * 2 - 1;
    this.data[base + Z] = z;
    this.data[base + TINT] = Math.random() < TINTED ? 1 : 0;
  }

  /**
   * Resizes the backing store and restores the context state it just destroyed.
   *
   * Assigning `canvas.width` resets the entire 2D context — line caps, widths,
   * composite mode, all of it, and it does so even when the value assigned is
   * the one already there. Anything set once at construction survives exactly
   * until the first resize, and the first resize happens during layout. So the
   * state lives here, next to the assignment that wipes it.
   *
   * Dimensions are passed in rather than measured: this runs from a RENDER task
   * where a layout read would force a synchronous reflow.
   */
  resize(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
    dpr: number,
  ) {
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);
    if (width === this.width && height === this.height) return;

    canvas.width = width;
    canvas.height = height;
    this.width = width;
    this.height = height;
    // Wide enough that a star at the edge of the plane sits at the edge of the
    // frame when it is furthest away, and off it long before it arrives.
    this.focal = Math.max(width, height) * 0.62;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Round caps are what make a stationary star a dot rather than nothing: a
    // zero-length segment with a butt cap paints no pixels at all.
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "lighter";
  }

  /**
   * Advances the field by `delta` seconds at `speed` and draws it.
   *
   * `alpha` scales the whole field — the section pulls it down while a beat is
   * being read, because a starfield at full brightness under body copy is a
   * texture and not a background.
   */
  step(
    ctx: CanvasRenderingContext2D,
    delta: number,
    speed: number,
    alpha: number,
    colors: StarfieldColors,
  ) {
    this.project(speed * delta);
    this.paint(ctx, alpha, colors);
  }

  /**
   * Draws one frame with nothing moving.
   *
   * The reduced-motion and mobile path. Called once and never subscribed to the
   * frame loop, the same way the spectrum meter draws its resting state — the
   * section keeps its identity everywhere without animating anywhere it was
   * asked not to.
   */
  paintStill(
    ctx: CanvasRenderingContext2D,
    colors: StarfieldColors,
    alpha = 1,
  ) {
    this.project(0);
    this.paint(ctx, alpha, colors);
  }

  /** Integrates by `travel` in z and fills the per-band segment buffers. */
  private project(travel: number) {
    this.counts.fill(0);

    const cx = this.width / 2;
    const cy = this.height / 2;
    const focal = this.focal;
    const depth = FAR - NEAR;
    // A stationary star still has to paint something, so the segment is never
    // allowed to collapse completely.
    const trail = Math.max(travel * STREAK, 1e-4);

    for (let i = 0; i < this.capacity; i++) {
      const base = i * STRIDE;
      let z = this.data[base + Z]! - travel;
      if (z <= NEAR) {
        this.spawn(i, FAR);
        z = FAR;
      } else {
        this.data[base + Z] = z;
      }

      const x = this.data[base + X]!;
      const y = this.data[base + Y]!;

      const sx = cx + (x / z) * focal;
      const sy = cy + (y / z) * focal;
      // Off frame. Checked after projection rather than by culling in z,
      // because a star near the edge of the plane leaves the frame long before
      // it reaches the camera.
      if (
        sx < -32 ||
        sx > this.width + 32 ||
        sy < -32 ||
        sy > this.height + 32
      ) {
        continue;
      }

      const behind = Math.min(z + trail, FAR);
      const px = cx + (x / behind) * focal;
      const py = cy + (y / behind) * focal;

      // Nearest band is brightest and thickest. `| 0` rather than Math.floor:
      // this runs `capacity` times per frame at up to 120 Hz.
      const near = (FAR - z) / depth;
      let band = (near * BANDS) | 0;
      if (band >= BANDS) band = BANDS - 1;

      const group = this.data[base + TINT]! * BANDS + band;
      const at = this.counts[group]! * 4;
      const buffer = this.groups[group]!;
      buffer[at] = px;
      buffer[at + 1] = py;
      buffer[at + 2] = sx;
      buffer[at + 3] = sy;
      this.counts[group]!++;
    }
  }

  private paint(
    ctx: CanvasRenderingContext2D,
    alpha: number,
    colors: StarfieldColors,
  ) {
    ctx.clearRect(0, 0, this.width, this.height);
    if (alpha <= 0.01) return;

    // Line widths are authored against a 900px-tall frame so the field does not
    // turn to hairlines on a tall display or to rope on a short one.
    const scale = this.height / 900;

    for (let group = 0; group < this.groups.length; group++) {
      const count = this.counts[group]!;
      if (count === 0) continue;

      const band = group % BANDS;
      const near = (band + 0.5) / BANDS;

      ctx.strokeStyle = group < BANDS ? colors.star : colors.warp;
      ctx.globalAlpha = alpha * (0.3 + near * 0.7);
      ctx.lineWidth = Math.max(0.9, (0.85 + near * 1.9) * scale);

      const buffer = this.groups[group]!;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const at = i * 4;
        ctx.moveTo(buffer[at]!, buffer[at + 1]!);
        ctx.lineTo(buffer[at + 2]!, buffer[at + 3]!);
      }
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }
}
