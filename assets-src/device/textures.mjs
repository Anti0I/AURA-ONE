/**
 * Procedural textures for the device internals.
 *
 * These exist so the whole render pipeline stays asset-free: no PCB photo, no
 * die shot, nothing to license or ship. Everything is drawn to a 2D canvas at
 * prerender time, and the same module is imported live by the configurator.
 *
 * All generators take a seed and are deterministic, so re-running the render
 * produces byte-identical frames.
 *
 * ---------------------------------------------------------------------------
 * Every one of these used to feed `emissiveMap` and nothing else, which is why
 * the internals read as stickers rather than as parts. An emissive pixel is
 * *self-lit*: it ignores the key light, takes no shading across a curve, has
 * no specular response and casts no sense of depth. A board lit that way is a
 * flat picture of a board no matter how good the picture is.
 *
 * So each generator now paints three canvases in lockstep, from one set of
 * drawing calls:
 *
 *   albedo   what colour the surface is
 *   rm       G = roughness, B = metalness  (the glTF packing, minus the AO
 *            channel — `aoMap` wants a second UV set and none of these have
 *            one, so R is left at zero)
 *   height   greyscale, fed through `normalFromHeight` into a normal map
 *
 * The packing matters: three.js reads `roughnessMap.g` and `metalnessMap.b`,
 * so pointing both at the same texture object costs one upload rather than
 * two. And roughness is the channel that does the heavy lifting here — bare
 * gold at 0.18 next to solder mask at 0.78 is what separates *pad* from
 * *board* to the eye, far more than the colours do.
 * ---------------------------------------------------------------------------
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
 * A canvas whose pixels are going to be read back into JS.
 *
 * Without the hint, Chromium keeps a 2D canvas on the GPU and the first
 * `getImageData` pays for a full synchronous readback plus a replay of every
 * queued draw — measured here at 4.5 s for the board, against 0.9 s for the
 * same drawing once the surface is held in main memory. It also does not show
 * up where you would look for it: canvas drawing is deferred, so the whole
 * bill lands on the line that reads the pixels, and the profile blames the
 * Sobel pass for work the paint calls did.
 */
function makeReadableCanvas(w, h) {
  const c = makeCanvas(w, h);
  c.getContext("2d", { willReadFrequently: true });
  return c;
}

/* ==========================================================================
   The three-canvas painter
   ========================================================================== */

/**
 * Opens one drawing surface that writes colour, roughness/metalness and height
 * at the same time.
 *
 * Keeping them in lockstep is not a convenience, it is the only way they stay
 * registered. A roughness map drawn in a second pass drifts from the albedo by
 * a pixel here and there, and a pad whose gloss is half a pixel off its colour
 * looks *wrong* in a way that is very hard to trace back to the texture.
 */
function painter(w, h) {
  const albedo = makeCanvas(w, h);
  const rm = makeCanvas(w, h);
  const height = makeReadableCanvas(w, h);
  return {
    w,
    h,
    albedo,
    rm,
    height,
    a: albedo.getContext("2d"),
    r: rm.getContext("2d"),
    z: height.getContext("2d"),
    get all() {
      return [this.a, this.r, this.z];
    },
  };
}

/**
 * Selects a surface: one colour, one gloss, one height, pointed at all three
 * contexts at once.
 *
 * Named `paint` rather than the more natural `use` because `use` is a React
 * hook, and the shared lint config reads any call to it as one -- fifty-three
 * errors from a file with no React in it.
 *
 * `rough` and `metal` are 0..1 and land in G and B. `height` is 0..1 where 0.5
 * is roughly "the plane of the board" — the normal map only ever sees slopes,
 * so the absolute value matters less than the steps between surfaces.
 */
function paint(p, mat, lineWidth) {
  const rgb = `rgb(0,${Math.round(mat.rough * 255)},${Math.round(mat.metal * 255)})`;
  const v = Math.round(mat.height * 255);
  const grey = `rgb(${v},${v},${v})`;
  p.a.fillStyle = p.a.strokeStyle = mat.colour;
  p.r.fillStyle = p.r.strokeStyle = rgb;
  p.z.fillStyle = p.z.strokeStyle = grey;
  if (lineWidth !== undefined) {
    for (const c of p.all) c.lineWidth = lineWidth;
  }
}

/** Runs the same path construction against all three contexts. */
function each(p, draw) {
  for (const c of p.all) draw(c);
}

function rect(p, x, y, w, h) {
  each(p, (c) => c.fillRect(x, y, w, h));
}

function disc(p, x, y, r) {
  each(p, (c) => {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  });
}

function ring(p, x, y, r, width) {
  each(p, (c) => {
    c.lineWidth = width;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
  });
}

/**
 * A colour-only overlay: paints into the albedo and leaves gloss and height
 * alone. Used for the things that are genuinely only a change of colour — the
 * printed fibre weave under the mask, the shadow gradient down a cell wrap —
 * where writing a height step as well would emboss something that is flat.
 */
function tint(p, draw) {
  draw(p.a);
}

/* ==========================================================================
   Height → normal
   ========================================================================== */

/**
 * Sobel over the height canvas, encoded as an OpenGL-convention normal map.
 *
 * Deliberately computed at a lower resolution than the albedo it accompanies.
 * A normal map describes which way a surface *leans*, which is a low-frequency
 * property — the fine detail is already in the colour and the gloss — and the
 * cost here is a per-pixel JS loop that also runs in the configurator, on the
 * user's main thread, the first time the section is opened. 512² is around
 * 5 ms. The 1024² that matches the albedo is four times that for a difference
 * nobody can see at the size these parts are drawn.
 */
export function normalFromHeight(heightCanvas, strength = 2.2, targetW = 512) {
  const aspect = heightCanvas.height / heightCanvas.width;
  const w = targetW;
  const h = Math.max(1, Math.round(targetW * aspect));

  const small = makeReadableCanvas(w, h);
  const g = small.getContext("2d");
  g.drawImage(heightCanvas, 0, 0, w, h);

  const src = g.getImageData(0, 0, w, h).data;
  const out = g.createImageData(w, h);
  const dst = out.data;

  // Wrapped sampling. Half of these maps tile (the cell wrap goes right around
  // the cylinder), and the ones that do not are bordered by flat margin, so
  // wrapping costs nothing and saves an edge case.
  const at = (x, y) => src[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const gx = (tr + 2 * r + br - tl - 2 * l - bl) / 1020;
      const gy = (bl + 2 * b + br - tl - 2 * t - tr) / 1020;

      // Canvas Y runs down and texture V runs up, so the vertical gradient is
      // already the right way round once negated into the normal.
      let nx = -gx * strength;
      let ny = gy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;

      const i = (y * w + x) * 4;
      dst[i] = Math.round((nx * 0.5 + 0.5) * 255);
      dst[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      dst[i + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
      dst[i + 3] = 255;
    }
  }

  g.putImageData(out, 0, 0);
  return small;
}

/* ==========================================================================
   Printed circuit board
   ========================================================================== */

const FR4 = { colour: "#6f6249", rough: 0.82, metal: 0.0, height: 0.36 };
const MASK = { colour: "#171310", rough: 0.78, metal: 0.02, height: 0.42 };
const POUR = { colour: "#221c15", rough: 0.7, metal: 0.14, height: 0.46 };
const TRACE = { colour: "#2f2417", rough: 0.62, metal: 0.22, height: 0.5 };
const GOLD = { colour: "#c9a227", rough: 0.18, metal: 1.0, height: 0.54 };
const GOLD_LIT = { colour: "#e8cf7a", rough: 0.14, metal: 1.0, height: 0.55 };
const DRILL = { colour: "#0a0806", rough: 0.9, metal: 0.0, height: 0.22 };
const SILK = { colour: "#d8cfc0", rough: 0.92, metal: 0.0, height: 0.45 };
const BODY_DARK = { colour: "#241d16", rough: 0.55, metal: 0.06, height: 0.78 };
const IC_BODY = { colour: "#0f0d0b", rough: 0.42, metal: 0.05, height: 0.86 };
const TERMINAL = { colour: "#c9c4bb", rough: 0.22, metal: 0.95, height: 0.74 };
const CAN = { colour: "#8d8378", rough: 0.24, metal: 0.9, height: 0.94 };

/**
 * Draws one surface-mount part: body, both terminals, and the highlight and
 * contact shadow that sell it as sitting *on* the board rather than in it.
 *
 * The shadow is painted into the albedo only. It is a lighting cue, not a
 * shape — embossing it into the height map would put a trench around every
 * part and the normal map would light the trench, which is one cue too many.
 */
function smdChip(p, x, y, w, h, body) {
  const term = Math.max(2, w * 0.22);

  tint(p, (c) => {
    c.save();
    c.fillStyle = "rgba(0,0,0,0.5)";
    c.filter = "blur(3px)";
    c.fillRect(x + 1.5, y + 2, w, h);
    c.restore();
  });

  paint(p, body);
  rect(p, x, y, w, h);
  paint(p, TERMINAL);
  rect(p, x, y, term, h);
  rect(p, x + w - term, y, term, h);

  tint(p, (c) => {
    c.fillStyle = "rgba(255,252,244,0.3)";
    c.fillRect(x, y, w, Math.max(1, h * 0.18));
  });
}

/** A leaded IC: epoxy body, pin-1 dimple, and lead frames down two sides. */
function smdIc(p, x, y, w, h, pins) {
  tint(p, (c) => {
    c.save();
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.filter = "blur(5px)";
    c.fillRect(x + 2, y + 3, w, h);
    c.restore();
  });

  const leadW = Math.max(3, w * 0.05);
  const pitch = h / pins;
  paint(p, GOLD);
  for (let i = 0; i < pins; i++) {
    const py = y + i * pitch + pitch * 0.22;
    const ph = pitch * 0.56;
    rect(p, x - leadW, py, leadW, ph);
    rect(p, x + w, py, leadW, ph);
  }

  paint(p, IC_BODY);
  rect(p, x, y, w, h);

  // Pin 1. On a real package this is a moulded dimple; here it is the one
  // detail that stops the body reading as a plain black rectangle.
  paint(p, { ...IC_BODY, colour: "#2a2520", height: 0.8 });
  disc(p, x + w * 0.16, y + h * 0.16, Math.max(2.5, w * 0.055));

  tint(p, (c) => {
    const grad = c.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, "rgba(255,250,240,0.16)");
    grad.addColorStop(0.35, "rgba(255,250,240,0.03)");
    grad.addColorStop(1, "rgba(0,0,0,0.25)");
    c.fillStyle = grad;
    c.fillRect(x, y, w, h);
  });
}

/**
 * Printed circuit board — solder mask over a flooded ground pour, routed in
 * parallel bundles, populated, and silkscreened.
 *
 * The bundles are the thing that makes it read as a board. The previous
 * version walked ninety lone traces at right angles, which is geometrically
 * correct and looks like nothing on earth: a real router carries a bus as a
 * pack of parallel tracks at a fixed pitch. Offsetting a rectilinear path by
 * an equal amount on both axes keeps every corner at ninety degrees and
 * staggers them the way a real fan-out does, so one path yields the whole
 * bundle for free.
 */
/**
 * Where the N1 sits on the board, in UV, and the board's proportions.
 *
 * Mirrors the placement in `scene.mjs` — chip centre 0.06 right of and 0.04
 * above the board's, a 0.52 package on a 1.55 × 0.9 board. The texture is
 * square and the board is not, so anything measured as a distance here has to
 * be scaled back to the board's aspect.
 */
export const BOARD = { w: 1.55, h: 0.9, socket: { u: 0.5387, v: 0.5444, size: 0.52 } };

export function pcbTextures(seed = 1337, size = 1024) {
  const p = painter(size, size);
  const rand = mulberry32(seed);
  const S = size / 1024; // everything below is authored at 1024

  // Everything the scene needs to put real geometry where parts are painted,
  // in canvas pixels. A painted part with a 3D body exactly on top of it is
  // what makes the board read as populated rather than printed.
  const placements = [];

  // The routing again, as a mask, for the light that runs along the traces
  // into the core during the push-in. At 256 the camera's close-up made every
  // trace a 30-pixel smear; 512 keeps them tracks.
  const FLOW = 512;
  const flow = makeReadableCanvas(FLOW, FLOW);
  const fg = flow.getContext("2d");
  fg.fillStyle = "#000";
  fg.fillRect(0, 0, FLOW, FLOW);
  const F = FLOW / size;

  // Milled edge. RoundedBoxGeometry maps the rounded rim to the outer margin
  // of UV space, so painting bare fibreglass in the border is what gives the
  // board an edge instead of a smear of stretched traces.
  paint(p, FR4);
  rect(p, 0, 0, size, size);

  const M = 42 * S;
  const inner = size - M * 2;

  paint(p, MASK);
  rect(p, M, M, inner, inner);

  // Woven glass showing through the mask. Colour only: the weave is printed
  // into the laminate, not raised above it.
  tint(p, (c) => {
    c.save();
    c.beginPath();
    c.rect(M, M, inner, inner);
    c.clip();
    c.globalAlpha = 0.05;
    c.strokeStyle = "#8f7f63";
    c.lineWidth = 5 * S;
    for (let i = -size; i < size * 2; i += 17 * S) {
      c.beginPath();
      c.moveTo(i, M);
      c.lineTo(i + inner, M + inner);
      c.stroke();
      c.beginPath();
      c.moveTo(i, M + inner);
      c.lineTo(i + inner, M);
      c.stroke();
    }
    c.restore();
  });

  // Ground pour: copper flooding every unrouted square millimetre, still under
  // the mask so it barely shows as colour — but it is metal, and the gloss map
  // is where it becomes visible.
  paint(p, POUR);
  rect(p, M + 10 * S, M + 10 * S, inner - 20 * S, inner - 20 * S);
  each(p, (c) => {
    c.save();
    c.beginPath();
    c.rect(M, M, inner, inner);
    c.clip();
    c.globalAlpha = 0.35;
    c.lineWidth = 2 * S;
    for (let i = -size; i < size * 2; i += 26 * S) {
      c.beginPath();
      c.moveTo(i, M);
      c.lineTo(i + inner, M + inner);
      c.stroke();
    }
    c.restore();
  });

  // ---- Routing -----------------------------------------------------------
  const CELL = 34 * S;
  const cols = Math.floor(inner / CELL);
  const rows = Math.floor(inner / CELL);
  const px = (cx) => M + Math.max(0, Math.min(cols, cx)) * CELL;
  const py = (cy) => M + Math.max(0, Math.min(rows, cy)) * CELL;

  for (let n = 0; n < 22; n++) {
    // One rectilinear spine per bundle.
    let cx = Math.floor(rand() * cols);
    let cy = Math.floor(rand() * rows);
    const steps = 4 + Math.floor(rand() * 7);
    let horizontal = rand() < 0.5;
    const pts = [[px(cx), py(cy)]];
    for (let s = 0; s < steps; s++) {
      const run = 2 + Math.floor(rand() * 5);
      if (horizontal) cx += rand() < 0.5 ? run : -run;
      else cy += rand() < 0.5 ? run : -run;
      cx = Math.max(0, Math.min(cols, cx));
      cy = Math.max(0, Math.min(rows, cy));
      pts.push([px(cx), py(cy)]);
      horizontal = !horizontal;
    }

    const width = rand() < 0.3 ? 5.5 * S : 3.2 * S;
    const pitch = width * 2.6;
    const count = 1 + Math.floor(rand() * 7);

    const spine = (c, dx) => {
      c.beginPath();
      c.moveTo(pts[0][0] + dx, pts[0][1] + dx);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0] + dx, pts[i][1] + dx);
      c.stroke();
    };

    for (let k = 0; k < count; k++) {
      const dx = k * pitch;
      // Mask clearance first, then the track inside it. Copper on a real board
      // is never flush against the pour; the gap is what reads as a track.
      paint(p, MASK, width + 6 * S);
      each(p, (c) => {
        c.lineCap = "square";
        c.lineJoin = "miter";
        spine(c, dx);
      });
      paint(p, TRACE, width);
      each(p, (c) => spine(c, dx));

      fg.save();
      fg.scale(F, F);
      fg.strokeStyle = "#f00";
      fg.lineWidth = Math.max(1 / F, width);
      fg.lineCap = "square";
      spine(fg, dx);
      fg.restore();
    }

    // Via at the end of the bundle: gold annulus around a drilled hole.
    const [ex, ey] = pts[pts.length - 1];
    for (let k = 0; k < Math.min(count, 4); k++) {
      const vx = ex + k * pitch;
      const vy = ey + k * pitch;
      paint(p, GOLD);
      disc(p, vx, vy, 6.5 * S);
      paint(p, DRILL);
      disc(p, vx, vy, 2.6 * S);
    }
  }

  // ---- Population --------------------------------------------------------
  paint(p, SILK);
  for (let n = 0; n < 26; n++) {
    const x = M + 24 * S + rand() * (inner - 90 * S);
    const y = M + 24 * S + rand() * (inner - 60 * S);
    const vertical = rand() < 0.4;
    const w = (vertical ? 13 : 30) * S;
    const h = (vertical ? 30 : 13) * S;
    const body = rand() < 0.45 ? BODY_DARK : { ...BODY_DARK, colour: "#4a3a26" };

    // Silkscreen outline goes under the part, as it does on a real board.
    paint(p, SILK, 1.6 * S);
    each(p, (c) => c.strokeRect(x - 4 * S, y - 4 * S, w + 8 * S, h + 8 * S));
    smdChip(p, x, y, w, h, body);
    placements.push({ kind: "passive", x, y, w, h, light: body !== BODY_DARK });
  }

  const ics = [
    [M + inner * 0.5, M + inner * 0.14, 118 * S, 150 * S, 9],
    [M + inner * 0.13, M + inner * 0.58, 86 * S, 108 * S, 7],
  ];
  for (const [x, y, w, h, pins] of ics) {
    smdIc(p, x, y, w, h, pins);
    placements.push({ kind: "ic", x, y, w, h });
  }

  // An electrolytic can, for the one part with real height on it.
  const canX = M + inner * 0.78;
  const canY = M + inner * 0.72;
  tint(p, (c) => {
    c.save();
    c.fillStyle = "rgba(0,0,0,0.6)";
    c.filter = "blur(7px)";
    c.beginPath();
    c.arc(canX + 4 * S, canY + 6 * S, 46 * S, 0, Math.PI * 2);
    c.fill();
    c.restore();
  });
  paint(p, CAN);
  disc(p, canX, canY, 44 * S);
  paint(p, { ...CAN, colour: "#3a352e", rough: 0.5, metal: 0.3, height: 0.92 });
  ring(p, canX, canY, 30 * S, 8 * S);
  tint(p, (c) => {
    const grad = c.createLinearGradient(canX - 44 * S, canY - 44 * S, canX + 44 * S, canY + 44 * S);
    grad.addColorStop(0, "rgba(255,252,246,0.5)");
    grad.addColorStop(0.5, "rgba(255,252,246,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.45)");
    c.fillStyle = grad;
    c.beginPath();
    c.arc(canX, canY, 44 * S, 0, Math.PI * 2);
    c.fill();
  });
  placements.push({ kind: "can", x: canX, y: canY, r: 44 * S });

  // A board-to-board connector: the densest thing on any real assembly.
  const fx = M + inner * 0.06;
  const fy = M + inner * 0.29;
  paint(p, { ...IC_BODY, colour: "#141110", height: 0.88 });
  rect(p, fx, fy, 44 * S, 190 * S);
  paint(p, GOLD_LIT);
  for (let i = 0; i < 20; i++) {
    rect(p, fx + 7 * S, fy + 10 * S + i * 8.6 * S, 30 * S, 3.6 * S);
  }
  placements.push({ kind: "connector", x: fx, y: fy, w: 44 * S, h: 190 * S });

  // ---- Silkscreen --------------------------------------------------------
  paint(p, SILK);
  each(p, (c) => {
    c.font = `600 ${13 * S}px ui-monospace, monospace`;
    c.textBaseline = "top";
  });
  const designators = ["R", "C", "L", "U", "D", "TP"];
  for (let n = 0; n < 30; n++) {
    const label = designators[Math.floor(rand() * designators.length)] + (1 + Math.floor(rand() * 60));
    each(p, (c) =>
      c.fillText(label, M + 20 * S + rand() * (inner - 60 * S), M + 20 * S + rand() * (inner - 40 * S)),
    );
  }
  each(p, (c) => {
    c.font = `700 ${26 * S}px ui-monospace, monospace`;
    c.fillText("AURA ONE  ·  MAIN  ·  REV C", M + 26 * S, M + inner - 46 * S);
  });

  // Fiducials: three bare-copper targets the pick-and-place aligns to.
  for (const [fxr, fyr] of [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94]]) {
    paint(p, MASK);
    disc(p, M + inner * fxr, M + inner * fyr, 13 * S);
    paint(p, GOLD_LIT);
    disc(p, M + inner * fxr, M + inner * fyr, 7 * S);
  }

  // ---- N1 land pattern ---------------------------------------------------
  // What the core leaves behind when it lifts off in the exploded view. It
  // used to leave random routing and half a painted IC, which said the chip
  // had been sitting on nothing in particular. A BGA land grid with its
  // silkscreen corners says *socket*. Painted last, over whatever the router
  // put there, because on a real board nothing else is routed under a BGA.
  const sock = BOARD.socket;
  const sw = (sock.size / BOARD.w) * size;
  const sh = (sock.size / BOARD.h) * size;
  const sx = sock.u * size - sw / 2;
  const sy = (1 - sock.v) * size - sh / 2;
  paint(p, MASK);
  rect(p, sx, sy, sw, sh);
  fg.fillStyle = "#000";
  fg.fillRect(sx * F, sy * F, sw * F, sh * F);
  const BALLS = 14;
  for (let i = 0; i < BALLS; i++) {
    for (let j = 0; j < BALLS; j++) {
      // The centre is depopulated, as it is on most large BGAs.
      if (Math.abs(i - 6.5) < 3 && Math.abs(j - 6.5) < 3) continue;
      paint(p, GOLD);
      each(p, (c) => {
        c.beginPath();
        c.ellipse(
          sx + ((i + 0.5) / BALLS) * sw,
          sy + ((j + 0.5) / BALLS) * sh,
          (sw / BALLS) * 0.28,
          (sh / BALLS) * 0.28,
          0,
          0,
          Math.PI * 2,
        );
        c.fill();
      });
    }
  }
  paint(p, SILK, 3 * S);
  const tick = Math.min(sw, sh) * 0.12;
  each(p, (c) => {
    for (const [cx, cy, dx, dy] of [
      [sx, sy, 1, 1],
      [sx + sw, sy, -1, 1],
      [sx, sy + sh, 1, -1],
      [sx + sw, sy + sh, -1, -1],
    ]) {
      c.beginPath();
      c.moveTo(cx + dx * tick, cy);
      c.lineTo(cx, cy);
      c.lineTo(cx, cy + dy * tick);
      c.stroke();
    }
  });
  paint(p, SILK);
  disc(p, sx + tick * 0.6, sy + tick * 0.6, 6 * S);

  // ---- Flow distance -------------------------------------------------------
  // G = how far each texel is from the socket, measured on the board rather
  // than on the square texture, so a pulse contracts as a circle and not as an
  // ellipse stretched along the long edge.
  const fd = fg.getImageData(0, 0, FLOW, FLOW);
  const reach = Math.hypot(BOARD.w * 0.6, BOARD.h * 0.6);
  for (let y = 0; y < FLOW; y++) {
    for (let x = 0; x < FLOW; x++) {
      const u = (x + 0.5) / FLOW;
      const v = 1 - (y + 0.5) / FLOW;
      const d = Math.hypot((u - sock.u) * BOARD.w, (v - sock.v) * BOARD.h) / reach;
      fd.data[(y * FLOW + x) * 4 + 1] = Math.round(Math.min(1, d) * 255);
    }
  }
  fg.putImageData(fd, 0, 0);

  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 2.6, 512),
    flow,
    placements,
    size,
  };
}

/* ==========================================================================
   Perforation
   ========================================================================== */

/**
 * A tileable laser-drilled hole pattern, for the mic grille.
 *
 * Holes are height as well as colour, for the same reason as the acoustic
 * grille's: a printed dot is a dot, a drilled hole has a lit lip and a shaded
 * one. Staggered rows, because a square grid of holes reads as a texture and a
 * staggered one reads as machining.
 */
export function perforationTextures(size = 256) {
  const p = painter(size, size);
  // The plate is close to the shell's own metal: a grille cut in the case, not
  // a black part set into it. Dark, it read as a slot.
  const PLATE = { colour: "#8c9097", rough: 0.46, metal: 0.95, height: 0.7 };
  const HOLE = { colour: "#030304", rough: 0.95, metal: 0.0, height: 0.1 };
  paint(p, PLATE);
  rect(p, 0, 0, size, size);
  // Eight columns and ten rows: an even row count is what lets the stagger
  // wrap, and 10 rows at 0.8 of the column pitch is near enough the 0.866 of
  // a true hexagonal packing. One row and column past each edge so the tile
  // wraps without a seam.
  const COLS = 8;
  const ROWS = 10;
  const pitch = size / COLS;
  const rowStep = size / ROWS;
  paint(p, HOLE);
  for (let row = -1; row <= ROWS; row++) {
    const shift = ((row % 2) + 2) % 2 ? 0.5 : 0;
    for (let col = -1; col <= COLS; col++) {
      disc(p, (col + shift + 0.5) * pitch, (row + 0.5) * rowStep, pitch * 0.27);
    }
  }
  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 2.4, 256),
  };
}

/* ==========================================================================
   Shell interior
   ========================================================================== */

/**
 * The inside of the top shell: bare anodic film over the machined pocket, and
 * an antenna plated straight onto it.
 *
 * Laser direct structuring is how small enclosures carry their antennas —
 * a meander of gold on the inner wall rather than a separate part — and it is
 * what turns the inside of the case from an empty grey bowl into evidence
 * that the case is part of the radio. Mapped in lathe UV: U runs around the
 * body, V from the rim to the crown.
 */
export function antennaTextures(seed = 23, w = 1024, h = 256) {
  const p = painter(w, h);
  const rand = mulberry32(seed);
  const WALL = { colour: "#2b2c31", rough: 0.62, metal: 0.55, height: 0.5 };
  const LDS = { colour: "#c9a24a", rough: 0.24, metal: 1.0, height: 0.56 };
  paint(p, WALL);
  rect(p, 0, 0, w, h);

  // Faint toolpath rings from the pocketing pass, colour and height together.
  for (let i = 0; i < 40; i++) {
    const y = rand() * h;
    paint(p, { ...WALL, colour: rand() < 0.5 ? "#303137" : "#28292e", height: 0.5 + (rand() - 0.5) * 0.04 }, 1 + rand() * 2);
    each(p, (c) => {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    });
  }

  // The meander, on one flank of the dome, fed from two pads at the rim.
  paint(p, LDS, 7);
  const x0 = w * 0.08;
  const x1 = w * 0.3;
  const top = h * 0.22;
  const bottom = h * 0.78;
  const turns = 7;
  each(p, (c) => {
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(x0, h * 0.96);
    c.lineTo(x0, bottom);
    for (let i = 0; i < turns; i++) {
      const x = x0 + ((i + 0.5) / turns) * (x1 - x0);
      const y = i % 2 ? bottom : top;
      c.lineTo(x, i % 2 ? top : bottom);
      c.lineTo(x, y);
    }
    c.lineTo(x1, h * 0.96);
    c.stroke();
  });
  paint(p, LDS);
  rect(p, x0 - 14, h * 0.9, 28, 18);
  rect(p, x1 - 14, h * 0.9, 28, 18);

  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 1.6, 512),
  };
}

/* ==========================================================================
   Neural core
   ========================================================================== */

const EPOXY = { colour: "#131110", rough: 0.46, metal: 0.04, height: 0.82 };
const SUBSTRATE = { colour: "#2a2318", rough: 0.66, metal: 0.1, height: 0.5 };
const DIE_BASE = { colour: "#141b1e", rough: 0.3, metal: 0.5, height: 0.66 };
const METAL_1 = { colour: "#8d8578", rough: 0.22, metal: 0.92, height: 0.68 };
const METAL_2 = { colour: "#4e4740", rough: 0.34, metal: 0.8, height: 0.67 };
const PASSIVATION = { colour: "#1d2429", rough: 0.5, metal: 0.35, height: 0.65 };
const BOND = { colour: "#d9b653", rough: 0.13, metal: 1.0, height: 0.9 };

/**
 * AURA N1 — an exposed die on a package substrate, wire-bonded to its ring.
 *
 * The floorplan survives from the previous version because it is the right
 * subject: phase 3 drives the camera into this face and a compute grid is
 * worth arriving at. What it lacked was any reason to believe it was made of
 * anything. Now the metal layers are metal (0.92) against passivation that is
 * not (0.35), the die sits on a step above the substrate, and gold bond wires
 * arc off its edge — which is the single detail that says *silicon* before a
 * viewer has read anything else in the frame.
 */
export function dieTextures(seed = 7, size = 1024) {
  const p = painter(size, size);
  const rand = mulberry32(seed);
  const S = size / 1024;

  // Package epoxy fills the margin, so the box's rounded rim and edges are
  // moulded plastic rather than a stretched picture of a die.
  paint(p, EPOXY);
  rect(p, 0, 0, size, size);

  const M = 96 * S;
  const inner = size - M * 2;

  paint(p, SUBSTRATE);
  rect(p, M, M, inner, inner);

  // Substrate routing: fine gold fan-out from the die shadow to the edge.
  paint(p, { ...BOND, rough: 0.3, height: 0.51 }, 2.4 * S);
  each(p, (c) => {
    for (let i = 0; i < 120; i++) {
      const f = (i + 0.5) / 120;
      c.beginPath();
      c.moveTo(M + f * inner, M + 4 * S);
      c.lineTo(M + inner * (0.22 + f * 0.56), M + inner * 0.2);
      c.stroke();
      c.beginPath();
      c.moveTo(M + f * inner, M + inner - 4 * S);
      c.lineTo(M + inner * (0.22 + f * 0.56), M + inner * 0.8);
      c.stroke();
    }
  });

  // ---- The die -----------------------------------------------------------
  const D = 130 * S;
  const dieSize = size - D * 2;

  tint(p, (c) => {
    c.save();
    c.fillStyle = "rgba(0,0,0,0.7)";
    c.filter = `blur(${9 * S}px)`;
    c.fillRect(D + 4 * S, D + 7 * S, dieSize, dieSize);
    c.restore();
  });

  paint(p, DIE_BASE);
  rect(p, D, D, dieSize, dieSize);

  // Seal ring and bond pads around the perimeter.
  paint(p, { ...METAL_2, colour: "#3f3931" }, 5 * S);
  each(p, (c) => c.strokeRect(D + 14 * S, D + 14 * S, dieSize - 28 * S, dieSize - 28 * S));

  const padCount = 30;
  const padSize = 15 * S;
  const padAt = [];
  paint(p, BOND);
  for (let i = 0; i < padCount; i++) {
    const f = (i + 0.5) / padCount;
    const q = D + 30 * S;
    const span = dieSize - 60 * S;
    const pts = [
      [q + f * span, D + 26 * S],
      [q + f * span, D + dieSize - 26 * S - padSize],
      [D + 26 * S, q + f * span],
      [D + dieSize - 26 * S - padSize, q + f * span],
    ];
    for (const [x, y] of pts) {
      rect(p, x, y, padSize, padSize);
      padAt.push([x + padSize / 2, y + padSize / 2]);
    }
  }

  // ---- Floorplan ---------------------------------------------------------
  const F = D + 52 * S;
  const fieldSize = dieSize - 104 * S;
  const grid = 4;
  const gap = fieldSize * 0.032;
  const tile = (fieldSize - gap * (grid - 1)) / grid;

  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const x = F + tx * (tile + gap);
      const y = F + ty * (tile + gap);
      const central = tx >= 1 && tx <= 2 && ty >= 1 && ty <= 2;

      paint(p, central ? { ...PASSIVATION, colour: "#232c31" } : PASSIVATION);
      rect(p, x, y, tile, tile);

      // SRAM banks. Dense parallel metal, which is what a memory macro looks
      // like from above and why it is the most legible thing on any die shot.
      // Banks come in runs of the same brightness rather than a coin flip per
      // bank. It reads the same -- a memory macro is built from identical
      // blocks, so runs are if anything more truthful -- and it compresses
      // enormously better: this face fills the frame at the end of the
      // push-in, and per-bank randomness is the most expensive thing you can
      // put in front of a codec.
      const banks = central ? 14 : 9;
      let bright = rand() < 0.4;
      let runLeft = 2 + Math.floor(rand() * 3);
      for (let b = 0; b < banks; b++) {
        if (runLeft-- <= 0) {
          bright = !bright;
          runLeft = 2 + Math.floor(rand() * 3);
        }
        const bh = (tile * 0.78) / banks;
        paint(p, bright ? METAL_1 : METAL_2);
        rect(p, x + tile * 0.08, y + tile * 0.11 + b * (bh * 1.16), tile * 0.84, bh * 0.66);
      }

      // Standard-cell rows in the gaps between macros: finer, dimmer, and
      // running the other way, which is what stops the whole face reading as
      // one repeated stamp.
      paint(p, { ...METAL_2, colour: "#39332d" }, 1.4 * S);
      each(p, (c) => {
        for (let i = 0; i < 12; i++) {
          const cx = x + tile * (0.06 + (i / 12) * 0.88);
          c.beginPath();
          c.moveTo(cx, y + tile * 0.06);
          c.lineTo(cx, y + tile * 0.94);
          c.stroke();
        }
      });
    }
  }

  // Power grid: the top metal layer, over everything.
  //
  // Half the width and a third of the brightness it started at. Coarse bright
  // bars on a 6x6 pitch turned the whole die into a window frame -- the eye
  // read the grid as the subject and the floorplan as wallpaper behind it,
  // which is the wrong way round for the one surface the camera flies into.
  paint(p, { ...METAL_1, colour: "#6e675c", height: 0.69 });
  for (let i = 0; i <= 6; i++) {
    const f = i / 6;
    rect(p, F + f * fieldSize - 2 * S, F, 4 * S, fieldSize);
    rect(p, F, F + f * fieldSize - 2 * S, fieldSize, 4 * S);
  }

  // ---- Bond wires --------------------------------------------------------
  // Drawn last, because they are physically above everything, and with a dark
  // under-stroke so each wire carries its own shadow onto the die.
  each(p, (c) => {
    c.lineCap = "round";
  });
  for (let i = 0; i < padAt.length; i += 2) {
    const [sx, sy] = padAt[i];
    const dx = sx - size / 2;
    const dy = sy - size / 2;
    const len = Math.hypot(dx, dy) || 1;
    const ex = size / 2 + (dx / len) * (len + 96 * S);
    const ey = size / 2 + (dy / len) * (len + 96 * S);
    const mx = (sx + ex) / 2 - (dy / len) * 26 * S;
    const my = (sy + ey) / 2 + (dx / len) * 26 * S;

    const arc = (c) => {
      c.beginPath();
      c.moveTo(sx, sy);
      c.quadraticCurveTo(mx, my, ex, ey);
      c.stroke();
    };

    tint(p, (c) => {
      c.save();
      c.strokeStyle = "rgba(0,0,0,0.55)";
      c.lineWidth = 6 * S;
      c.translate(2 * S, 3 * S);
      arc(c);
      c.restore();
    });
    paint(p, BOND, 3.4 * S);
    each(p, arc);
    paint(p, BOND);
    disc(p, ex, ey, 6 * S);
  }

  // Laser-etched part marking on the package shoulder.
  paint(p, { colour: "#6c6459", rough: 0.72, metal: 0.1, height: 0.83 });
  each(p, (c) => {
    c.font = `700 ${30 * S}px ui-monospace, monospace`;
    c.textBaseline = "top";
    c.fillText("AURA N1", 54 * S, 44 * S);
    c.font = `500 ${20 * S}px ui-monospace, monospace`;
    c.fillText("NPU · 2.4 TOPS", 54 * S, size - 66 * S);
  });

  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 3.0, 512),
  };
}

/* ==========================================================================
   Driver
   ========================================================================== */

/**
 * The face of the 10 mm planar driver, mapped onto a cylinder cap — whose UVs
 * are a disc centred at (0.5, 0.5), so everything here is concentric by
 * construction.
 *
 * This part had no texture at all: it was a plain dark cylinder with a copper
 * torus laid over it. The surround is the piece that matters. It is the one
 * ring on the whole assembly that is soft rubber next to hard everything
 * else, and the roughness step from 0.85 down to 0.3 across four pixels is
 * what a viewer reads as *speaker* without being told.
 */
export function driverTextures(seed = 91, size = 512) {
  const p = painter(size, size);
  const rand = mulberry32(seed);
  const c0 = size / 2;
  const R = size * 0.5;

  const BASKET = { colour: "#14120f", rough: 0.58, metal: 0.35, height: 0.4 };
  const SURROUND = { colour: "#1b1815", rough: 0.85, metal: 0.02, height: 0.72 };
  const CONE = { colour: "#2a251e", rough: 0.44, metal: 0.2, height: 0.5 };
  const CAP = { colour: "#3a332a", rough: 0.3, metal: 0.45, height: 0.86 };
  const COPPER = { colour: "#b87333", rough: 0.28, metal: 1.0, height: 0.6 };

  paint(p, BASKET);
  rect(p, 0, 0, size, size);

  // Frame ring with mounting bosses.
  paint(p, { ...BASKET, colour: "#1d1a16", height: 0.46 });
  disc(p, c0, c0, R * 0.98);
  paint(p, { colour: "#5c554b", rough: 0.35, metal: 0.85, height: 0.52 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    disc(p, c0 + Math.cos(a) * R * 0.9, c0 + Math.sin(a) * R * 0.9, R * 0.045);
  }

  // Surround: a rolled rubber torus, so its height rises and falls across the
  // band rather than stepping. Drawn as concentric strokes on a cosine.
  const sOuter = R * 0.86;
  const sInner = R * 0.68;
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const r = sOuter - f * (sOuter - sInner);
    const bulge = Math.sin(f * Math.PI);
    paint(p, { ...SURROUND, height: 0.5 + bulge * 0.34 }, (sOuter - sInner) / steps + 1.5);
    each(p, (c) => {
      c.beginPath();
      c.arc(c0, c0, r, 0, Math.PI * 2);
      c.stroke();
    });
  }

  // Cone, with the radial grain of a pressed diaphragm.
  paint(p, CONE);
  disc(p, c0, c0, sInner);
  paint(p, { ...CONE, colour: "#332c23", height: 0.52 }, 1.2);
  each(p, (c) => {
    for (let i = 0; i < 220; i++) {
      const a = (i / 220) * Math.PI * 2 + rand() * 0.01;
      c.beginPath();
      c.moveTo(c0 + Math.cos(a) * R * 0.22, c0 + Math.sin(a) * R * 0.22);
      c.lineTo(c0 + Math.cos(a) * sInner, c0 + Math.sin(a) * sInner);
      c.stroke();
    }
  });

  // Voice coil former showing through, then the dust cap over it.
  paint(p, COPPER, R * 0.05);
  each(p, (c) => {
    c.beginPath();
    c.arc(c0, c0, R * 0.32, 0, Math.PI * 2);
    c.stroke();
  });
  paint(p, CAP);
  disc(p, c0, c0, R * 0.26);
  tint(p, (c) => {
    const grad = c.createRadialGradient(
      c0 - R * 0.1, c0 - R * 0.12, R * 0.02,
      c0, c0, R * 0.26,
    );
    grad.addColorStop(0, "rgba(255,250,240,0.42)");
    grad.addColorStop(1, "rgba(0,0,0,0.35)");
    c.fillStyle = grad;
    c.beginPath();
    c.arc(c0, c0, R * 0.26, 0, Math.PI * 2);
    c.fill();
  });

  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 3.4, 512),
  };
}

/* ==========================================================================
   Cell wrap
   ========================================================================== */

/**
 * The label around the Li-Si cell. Mapped to a cylinder wall, where U runs the
 * full way around the circumference — so this is the one texture that has to
 * tile horizontally, and the normal map's wrapped sampling is what keeps the
 * seam from lighting up as a crease.
 *
 * The crimp bands at each end and the overlap seam are doing all the work.
 * They are the two features every cylindrical cell has and neither survives as
 * a colour: both are height, read by the light.
 */
export function cellWrapTextures(seed = 55, w = 1024, h = 512) {
  const p = painter(w, h);
  const rand = mulberry32(seed);

  const WRAP = { colour: "#2b2823", rough: 0.44, metal: 0.25, height: 0.6 };
  const PRINT = { colour: "#ded4c4", rough: 0.78, metal: 0.0, height: 0.62 };
  const DIM = { colour: "#6f6659", rough: 0.7, metal: 0.05, height: 0.61 };
  const CRIMP = { colour: "#7d7468", rough: 0.3, metal: 0.9, height: 0.34 };

  paint(p, WRAP);
  rect(p, 0, 0, w, h);

  // Crimped rims top and bottom, plus the shoulder that steps down to them.
  const rim = h * 0.1;
  for (const [y0, dir] of [[0, 1], [h - rim, -1]]) {
    for (let i = 0; i < 14; i++) {
      const f = i / 14;
      paint(p, { ...CRIMP, height: 0.3 + Math.sin(f * Math.PI * 3) * 0.12 });
      rect(p, 0, y0 + (dir > 0 ? f * rim : rim - f * rim), w, rim / 14 + 1);
    }
  }

  // Overlap seam. One vertical step, 1.5% of the way around.
  paint(p, { ...WRAP, colour: "#221f1b", height: 0.66 });
  rect(p, w * 0.5, rim, w * 0.015, h - rim * 2);

  paint(p, PRINT);
  each(p, (c) => {
    c.textBaseline = "middle";
    c.font = `700 ${h * 0.14}px ui-sans-serif, system-ui, sans-serif`;
    c.fillText("AURA", w * 0.06, h * 0.34);
    c.font = `500 ${h * 0.075}px ui-monospace, monospace`;
    c.fillText("Li-Si  ·  3.85 V  ·  210 mAh", w * 0.06, h * 0.52);
  });
  paint(p, DIM);
  each(p, (c) => {
    c.font = `500 ${h * 0.052}px ui-monospace, monospace`;
    c.fillText("DO NOT INCINERATE  ·  DO NOT DISASSEMBLE", w * 0.06, h * 0.66);
    c.fillText("CELL 0114-A  ·  MADE FROM CODE", w * 0.06, h * 0.75);
  });

  // Barcode. Deterministic from the seed, and the one block of high-frequency
  // detail that tells the eye how big the cell is.
  paint(p, PRINT);
  let bx = w * 0.62;
  for (let i = 0; i < 60 && bx < w * 0.94; i++) {
    const bw = 2 + Math.floor(rand() * 6);
    rect(p, bx, h * 0.3, bw, h * 0.34);
    bx += bw + 2 + Math.floor(rand() * 6);
  }

  // A polarity band at one end, because a cell without one looks like a pipe.
  paint(p, { colour: "#8e3b28", rough: 0.6, metal: 0.1, height: 0.61 });
  rect(p, 0, h * 0.86, w, h * 0.045);

  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 2.4, 512),
  };
}

/* ==========================================================================
   Grille
   ========================================================================== */

/**
 * Radial acoustic grille. Perforations are height, not colour: a hole painted
 * dark is a dot, a hole cut into the height map catches the key light on one
 * lip and shades the other, which is the difference between a printed pattern
 * and a drilled plate.
 */
export function grilleTextures(size = 512) {
  const p = painter(size, size);
  const c0 = size / 2;

  const PLATE = { colour: "#1b1b20", rough: 0.34, metal: 0.85, height: 0.72 };
  const HOLE = { colour: "#050506", rough: 0.9, metal: 0.05, height: 0.12 };
  const MESH = { colour: "#0d0d10", rough: 0.6, metal: 0.4, height: 0.3 };

  paint(p, MESH);
  rect(p, 0, 0, size, size);
  paint(p, PLATE);
  disc(p, c0, c0, size * 0.49);

  for (let ring = 1; ring <= 7; ring++) {
    const r = (ring / 8) * (size * 0.46);
    const count = ring * 9;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ring * 0.13;
      const x = c0 + Math.cos(a) * r;
      const y = c0 + Math.sin(a) * r;
      paint(p, HOLE);
      disc(p, x, y, size * 0.009);
    }
  }

  // Chamfered outer edge.
  paint(p, { ...PLATE, colour: "#2a2a31", height: 0.6 });
  ring(p, c0, c0, size * 0.475, size * 0.02);

  return {
    albedo: p.albedo,
    rm: p.rm,
    normal: normalFromHeight(p.height, 2.0, 512),
  };
}

/* ==========================================================================
   Shell
   ========================================================================== */

/**
 * Shell grain maps.
 *
 * Streaks run along U, which on a lathe is the circumference — around the
 * body, the way a shell comes off the tool.
 *
 * Colour is *not* written here, and cannot be: tinting in the configurator
 * operates on the material's base colour, so any hue baked into an albedo map
 * would fight every finish. What comes out is roughness, metalness and the
 * grain — and the grain has to exist in the normal as well as in the gloss,
 * because a brush mark that only changes roughness stays perfectly flat under
 * a moving light.
 *
 * The roughness channel sits near 1 and only *modulates*. It used to average
 * 0.43, and three.js multiplies the map by the material's own roughness, so a
 * shell authored at 0.38 rendered at 0.16: a mirror. That is the whole reason
 * the case read as chrome on a page that calls it bead-blasted aluminium — and
 * why every finish in the configurator was glossier than its own number.
 */
export function brushedTextures(seed = 42, w = 1024, h = 512) {
  const rm = makeCanvas(w, h);
  const height = makeReadableCanvas(w, h);
  const rg = rm.getContext("2d");
  const zg = height.getContext("2d");
  const rand = mulberry32(seed);

  // Full material roughness, fully metal; the grain varies it by a few percent.
  rg.fillStyle = "rgb(0,236,245)";
  rg.fillRect(0, 0, w, h);
  zg.fillStyle = "rgb(128,128,128)";
  zg.fillRect(0, 0, w, h);

  for (let i = 0; i < 2600; i++) {
    const y = rand() * h;
    const len = w * (0.08 + rand() * 0.55);
    const x = rand() * w;
    const bright = rand();
    const rough = Math.round(236 + (bright - 0.5) * 36);
    const lift = Math.round(128 + (bright - 0.5) * 46);
    const width = rand() < 0.75 ? 1 : 2;
    const alpha = 0.25 + rand() * 0.5;
    const dy = (rand() - 0.5) * 1.5;

    for (const [c, style] of [
      [rg, `rgb(0,${rough},245)`],
      [zg, `rgb(${lift},${lift},${lift})`],
    ]) {
      c.strokeStyle = style;
      c.lineWidth = width;
      c.globalAlpha = alpha;
      // A streak that runs off the right edge is drawn again one width to the
      // left, so it comes back in on the left: the map wraps around the lathe
      // without a seam. Only those streaks — drawing every one twice doubled
      // the cost of the most expensive set the configurator generates.
      for (const ox of x + len > w ? [0, -w] : [0]) {
        c.beginPath();
        c.moveTo(x + ox, y);
        c.lineTo(x + ox + len, y + dy);
        c.stroke();
      }
    }
  }
  rg.globalAlpha = 1;
  zg.globalAlpha = 1;

  return { rm, normal: normalFromHeight(height, 0.9, 512) };
}
