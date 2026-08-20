"use client";

/**
 * Fixed-pool particle burst.
 *
 * Allocation is the whole design constraint. A naive emitter pushes objects
 * into an array and lets GC clean up, which on a 120 Hz page means a minor
 * collection every couple of seconds — and a minor collection during a scrub is
 * a visible hitch. Everything here lives in one preallocated Float32Array that
 * is written in place and never grows.
 *
 * Layout per particle: x, y, vx, vy, life, maxLife, size.
 */
const STRIDE = 7;
const X = 0;
const Y = 1;
const VX = 2;
const VY = 3;
const LIFE = 4;
const MAX_LIFE = 5;
const SIZE = 6;

export class Particles {
  private readonly data: Float32Array;
  private readonly capacity: number;
  private cursor = 0;
  private alive = 0;

  constructor(capacity = 140) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
  }

  get count() {
    return this.alive;
  }

  /**
   * Emits `count` particles from a point, in canvas pixels.
   *
   * Oldest particles are overwritten when the pool is full rather than the
   * burst being dropped — at these lifetimes the ones being recycled are
   * already almost invisible, and a burst that silently does nothing is worse
   * than one that is a few particles short.
   */
  emit(x: number, y: number, count = 22, speed = 90) {
    for (let i = 0; i < count; i++) {
      const base = this.cursor * STRIDE;
      const angle = Math.random() * Math.PI * 2;
      // sqrt keeps the distribution even across the disc instead of clumping
      // at the centre, which is what a plain random radius does.
      const magnitude = speed * (0.35 + Math.sqrt(Math.random()) * 0.65);
      const life = 0.45 + Math.random() * 0.55;

      this.data[base + X] = x;
      this.data[base + Y] = y;
      this.data[base + VX] = Math.cos(angle) * magnitude;
      this.data[base + VY] = Math.sin(angle) * magnitude;
      this.data[base + LIFE] = life;
      this.data[base + MAX_LIFE] = life;
      this.data[base + SIZE] = 0.8 + Math.random() * 1.9;

      this.cursor = (this.cursor + 1) % this.capacity;
      if (this.alive < this.capacity) this.alive++;
    }
  }

  /** Integrates and draws. Returns true while anything is still alive. */
  step(ctx: CanvasRenderingContext2D, delta: number, color: string): boolean {
    if (this.alive === 0) return false;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = color;

    let living = 0;
    for (let i = 0; i < this.capacity; i++) {
      const base = i * STRIDE;
      const life = this.data[base + LIFE]!;
      if (life <= 0) continue;

      const next = life - delta;
      this.data[base + LIFE] = next;
      if (next <= 0) continue;
      living++;

      const x = this.data[base + X]! + this.data[base + VX]! * delta;
      const y = this.data[base + Y]! + this.data[base + VY]! * delta;
      this.data[base + X] = x;
      this.data[base + Y] = y;

      // Drag, frame-rate independent. Particles that keep their speed read as
      // debris; ones that slow read as energy dissipating.
      const drag = Math.exp(-2.6 * delta);
      this.data[base + VX] = this.data[base + VX]! * drag;
      this.data[base + VY] = this.data[base + VY]! * drag;

      const t = next / this.data[base + MAX_LIFE]!;
      ctx.globalAlpha = t * t;
      const size = this.data[base + SIZE]! * (0.4 + t * 0.6);
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }

    ctx.restore();
    this.alive = living;
    return living > 0;
  }

  clear() {
    this.data.fill(0);
    this.alive = 0;
    this.cursor = 0;
  }
}
