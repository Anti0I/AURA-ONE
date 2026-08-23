/**
 * Procedural textures for the device internals.
 *
 * These exist so the whole render pipeline stays asset-free: no PCB photo, no
 * die shot, nothing to license or ship. Everything is drawn to a 2D canvas at
 * prerender time and used as an emissive map.
 *
 * All generators take a seed and are deterministic, so re-running the render
 * produces byte-identical frames.
 */

/** mulberry32 — same PRNG as the noise tile, for consistency. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Printed circuit board: orthogonal copper traces with vias and a ground pour.
 * Routed on a grid with a random walk that only turns at 90 degrees, which is
 * what makes it read as a real board rather than as scribbles.
 */
export function pcbTraceTexture(seed = 1337, w = 1024, h = 1024) {
  const c = makeCanvas(w, h);
  const g = c.getContext("2d");
  const rand = mulberry32(seed);

  g.fillStyle = "#000000";
  g.fillRect(0, 0, w, h);

  const CELL = 26;
  const cols = Math.floor(w / CELL);
  const rows = Math.floor(h / CELL);

  g.lineCap = "square";
  g.lineJoin = "miter";

  for (let n = 0; n < 90; n++) {
    let cx = Math.floor(rand() * cols);
    let cy = Math.floor(rand() * rows);
    const len = 6 + Math.floor(rand() * 22);
    let horizontal = rand() < 0.5;

    g.beginPath();
    g.moveTo(cx * CELL, cy * CELL);
    g.strokeStyle = rand() < 0.18 ? "#e4d9c8" : "#6b6155";
    g.lineWidth = rand() < 0.25 ? 4 : 2.5;

    for (let s = 0; s < len; s++) {
      const run = 1 + Math.floor(rand() * 4);
      if (horizontal) cx += rand() < 0.5 ? run : -run;
      else cy += rand() < 0.5 ? run : -run;
      cx = Math.max(0, Math.min(cols, cx));
      cy = Math.max(0, Math.min(rows, cy));
      g.lineTo(cx * CELL, cy * CELL);
      horizontal = !horizontal;
    }
    g.stroke();

    // Via at the end of the run.
    g.fillStyle = "#c9a227";
    g.beginPath();
    g.arc(cx * CELL, cy * CELL, 4.5, 0, Math.PI * 2);
    g.fill();
  }

  // Component pads: dense rectangular clusters, the visual weight of a board.
  for (let n = 0; n < 34; n++) {
    const px = rand() * (w - 90);
    const py = rand() * (h - 60);
    const pads = 2 + Math.floor(rand() * 6);
    g.fillStyle = "#d8d8dd";
    for (let p = 0; p < pads; p++) {
      g.fillRect(px + p * 13, py, 8, 22);
    }
  }

  return c;
}

/**
 * Neural core die: a floorplan of compute tiles around a central bus, plus the
 * IO ring. Read at a distance it is just "a chip"; the close-up in phase 3 is
 * where the tile structure earns its pixels.
 */
export function dieTexture(seed = 7, size = 768) {
  const c = makeCanvas(size, size);
  const g = c.getContext("2d");
  const rand = mulberry32(seed);

  g.fillStyle = "#0a0806";
  g.fillRect(0, 0, size, size);

  const pad = size * 0.08;
  const inner = size - pad * 2;

  // IO ring.
  g.strokeStyle = "#a89b88";
  g.lineWidth = size * 0.012;
  g.strokeRect(pad, pad, inner, inner);

  // Bond pads around the perimeter.
  g.fillStyle = "#d8cfc0";
  const padCount = 26;
  for (let i = 0; i < padCount; i++) {
    const f = (i + 0.5) / padCount;
    const s = size * 0.018;
    g.fillRect(pad + f * inner, pad - s * 1.6, s, s);
    g.fillRect(pad + f * inner, pad + inner + s * 0.6, s, s);
    g.fillRect(pad - s * 1.6, pad + f * inner, s, s);
    g.fillRect(pad + inner + s * 0.6, pad + f * inner, s, s);
  }

  // Compute tiles: a 4x4 macro grid, each tile filled with SRAM banks.
  const grid = 4;
  const gap = inner * 0.035;
  const tile = (inner - gap * (grid - 1)) / grid;
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const x = pad + tx * (tile + gap);
      const y = pad + ty * (tile + gap);
      const central = tx >= 1 && tx <= 2 && ty >= 1 && ty <= 2;

      g.fillStyle = central ? "#2b261d" : "#1a1712";
      g.fillRect(x, y, tile, tile);

      const banks = central ? 10 : 6;
      for (let b = 0; b < banks; b++) {
        const bw = tile * 0.82;
        const bh = (tile * 0.72) / banks;
        g.fillStyle = rand() < 0.3 ? "#e4d9c8" : "#7a6f60";
        g.fillRect(
          x + tile * 0.09,
          y + tile * 0.14 + b * (bh * 1.18),
          bw,
          bh * 0.7,
        );
      }
    }
  }

  // Central bus, brightest element on the die.
  g.fillStyle = "#f2ebdd";
  g.fillRect(pad + inner * 0.485, pad, inner * 0.03, inner);
  g.fillRect(pad, pad + inner * 0.485, inner, inner * 0.03);

  return c;
}

/** Radial speaker grille used as an alpha/emissive detail on the driver. */
export function grilleTexture(size = 512) {
  const c = makeCanvas(size, size);
  const g = c.getContext("2d");
  g.fillStyle = "#000000";
  g.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  g.fillStyle = "#c8ccd4";
  for (let ring = 1; ring <= 7; ring++) {
    const r = (ring / 8) * (size * 0.46);
    const count = ring * 9;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ring * 0.13;
      g.beginPath();
      g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, size * 0.008, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

/**
 * Brushed-metal roughness map.
 *
 * The single highest-value texture in the scene: without it the shell is a
 * perfect mirror and reads as an untextured blob. Streaks run along U, which
 * on a lathe is the circumference — i.e. brushed around the body, the way an
 * anodised aluminium shell actually comes off the tool.
 *
 * Written to the roughness channel only. Tinting in the browser operates on
 * hue, so any colour baked here would fight the configurator.
 */
export function brushedRoughnessTexture(seed = 42, w = 1024, h = 512) {
  const c = makeCanvas(w, h);
  const g = c.getContext("2d");
  const rand = mulberry32(seed);

  // Mid roughness base; streaks push it either way.
  g.fillStyle = "#6e6e6e";
  g.fillRect(0, 0, w, h);

  for (let i = 0; i < 2600; i++) {
    const y = rand() * h;
    const len = w * (0.08 + rand() * 0.55);
    const x = rand() * w;
    const bright = rand();
    const v = Math.round(110 + (bright - 0.5) * 96);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = rand() < 0.75 ? 1 : 2;
    g.globalAlpha = 0.25 + rand() * 0.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + len, y + (rand() - 0.5) * 1.5);
    g.stroke();
  }
  g.globalAlpha = 1;

  return c;
}
