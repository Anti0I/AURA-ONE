import type { Material } from "@/data/materials";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Recolours a frame at draw time.
 *
 * The sequence is rendered once, in neutral grey. Every finish in the
 * configurator is produced here instead — which is the difference between
 * adding a colour costing one object in a data file and costing 120 more
 * renders plus another 5 MB of transfer.
 *
 * Four operations, in an order that matters:
 *
 *  1. Draw the frame through a brightness/contrast filter. This is where the
 *     finish's *lightness* comes from, and it has to, because step 2 cannot
 *     supply it — see `Material.exposure`.
 *  2. Fill with the target colour in `color` blend mode. Canvas' non-separable
 *     blend modes take hue and saturation from the source and luminosity from
 *     the backdrop, which is exactly "repaint this object" — the shading,
 *     the brushed texture and the specular highlights all survive.
 *  3. Re-draw the frame in `overlay` at partial alpha. Step 2 flattens the
 *     specular response toward the tint; this puts the gloss back, scaled by
 *     how reflective the finish is meant to be.
 *  4. `destination-in` with the frame again. Steps 2 and 3 composite
 *     source-over, so they paint the tint across the transparent background as
 *     well. This clips everything back to the artwork's own alpha.
 *
 * Step 4 is the one that is easy to miss and impossible to ignore: without it
 * the canvas fills with a solid rectangle of the chosen colour.
 */
export function drawTinted(
  ctx: CanvasRenderingContext2D,
  bitmap: CanvasImageSource,
  dest: Rect,
  material: Material,
) {
  const { x, y, w, h } = dest;

  ctx.save();

  ctx.filter = `brightness(${material.exposure}) contrast(${material.contrast})`;
  ctx.drawImage(bitmap, x, y, w, h);
  ctx.filter = "none";

  ctx.globalCompositeOperation = "color";
  ctx.fillStyle = material.tint;
  ctx.fillRect(x, y, w, h);

  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = material.sheen * 0.55;
  ctx.drawImage(bitmap, x, y, w, h);
  ctx.globalAlpha = 1;

  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(bitmap, x, y, w, h);

  ctx.restore();
}

/**
 * Interpolates between two finishes.
 *
 * In OKLab rather than sRGB. Interpolating hex channels between, say, obsidian
 * and amber routes the transition through a muddy grey-brown, because sRGB is
 * not perceptually uniform; OKLab keeps the path through colours that look like
 * intermediate finishes rather than like a rendering error.
 */
export function mixMaterials(a: Material, b: Material, t: number): Material {
  return {
    ...b,
    tint: mixOklab(a.tint, b.tint, t),
    sheen: a.sheen + (b.sheen - a.sheen) * t,
    exposure: a.exposure + (b.exposure - a.exposure) * t,
    contrast: a.contrast + (b.contrast - a.contrast) * t,
  };
}

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToOklab(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((value >> 16) & 255) / 255);
  const g = srgbToLinear(((value >> 8) & 255) / 255);
  const b = srgbToLinear((value & 255) / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex(lab: [number, number, number]): string {
  const [L, A, B] = lab;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) =>
    Math.max(0, Math.min(255, Math.round(linearToSrgb(c) * 255))),
  );

  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function mixOklab(a: string, b: string, t: number): string {
  const [l1, a1, b1] = hexToOklab(a);
  const [l2, a2, b2] = hexToOklab(b);
  return oklabToHex([
    l1 + (l2 - l1) * t,
    a1 + (a2 - a1) * t,
    b1 + (b2 - b1) * t,
  ]);
}
