/**
 * AURA ONE — procedural device stage.
 *
 * Everything the site renders is built here from primitives: there is no model
 * file, no HDRI and no texture on disk. That is deliberate. It keeps the repo
 * asset-free, makes the render reproducible on any machine, and means the
 * Blender drop-in later only has to match the *output* contract
 * (360 square RGBA frames + two matched stills), not this file.
 *
 * It is also rendered live, by the configurator, which is why the finish and
 * the orbit are operations here rather than something the page does over the
 * top of a picture.
 *
 * The stage exposes to the prerender script:
 *   setSize(w, h)      resize the renderer
 *   renderFrame(t)     draw the scrollytelling timeline at t in 0..1
 *   renderXray(mode)   draw the matched X-Ray pair from one fixed camera
 *   clearance(t)       internals crossing a shell wall at t (check-clearance)
 *
 * …and to the configurator:
 *   prepare()          compile every shader without blocking the page
 *   orbit(az, el)      look at the assembled device from any direction
 *   setFinish(m)       recolour the shell
 *   dispose()          release the context
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  BOARD,
  pcbTextures,
  dieTextures,
  driverTextures,
  cellWrapTextures,
  grilleTextures,
  brushedTextures,
  perforationTextures,
  antennaTextures,
} from "./textures.mjs";

const TAU = Math.PI * 2;

/** Timeline phase boundaries, in scroll progress. */
export const PHASES = {
  ROTATE_END: 0.3,
  EXPLODE_END: 0.62,
  HOLD_END: 0.7,
  PUSH_END: 0.9,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Smootherstep: zero first *and* second derivative at both ends. Plain
 * smoothstep still shows a visible kink where one phase hands over to the next.
 */
const smoother = (v) => {
  const t = clamp01(v);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const range = (v, a, b) => smoother((v - a) / (b - a));

/**
 * Shell half-width and half-height — 26 × 18 mm at 1 unit = 10 mm, the figure
 * the walkthrough quotes — and the squash on Z that turns the lathe into a
 * pebble.
 */
const R = 1.3;
const H = 0.9;
const FLATTEN = 0.54;

/** Wall thickness, as the inner surface's scale against the outer. */
const WALL = 0.955;

/** Depth of the chamfer each half carries at the parting line. */
const CHAMFER = 0.02;

/** Where every shell lathe starts and ends its sweep: the back, the ear side. */
const SEAM_PHI = Math.PI;

/**
 * Half of the shell as a lathe profile.
 * A superellipse rather than a hemisphere: the flatter shoulder is what makes
 * it read as a designed object instead of a ball.
 */
function shellProfile(radius, halfHeight, sign, steps = 48) {
  const pts = [];
  // A chamfer, then a short vertical run. The two chamfers meet in a shallow
  // V at the parting line, which is what a machined split looks like; a flush
  // join is invisible in the closed pose and makes the split read as a glitch.
  pts.push(new THREE.Vector2(radius - CHAMFER, 0));
  pts.push(new THREE.Vector2(radius, sign * CHAMFER));
  pts.push(new THREE.Vector2(radius, sign * halfHeight * 0.06));
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const y = sign * halfHeight * (0.06 + u * 0.94);
    const n = Math.abs(y / halfHeight);
    const r = radius * Math.pow(Math.max(0, 1 - Math.pow(n, 2.5)), 1 / 2.7);
    pts.push(new THREE.Vector2(Math.max(r, 0.0008), y));
  }
  return sign > 0 ? pts : pts.reverse();
}

/** Shell radius at height `y`. Same superellipse as `shellProfile`. */
function profileRadius(radius, halfHeight, y) {
  const n = Math.min(Math.abs(y / halfHeight), 1);
  return radius * Math.pow(Math.max(0, 1 - Math.pow(n, 2.5)), 1 / 2.7);
}

/*
 * The lathe makes a pebble, symmetric every way, and a pebble is not an earbud:
 * nothing about it says which side goes in the ear or which end is which. Three
 * moves fix that, applied to every vertex of everything that is the shell or
 * sits on it:
 *
 *   TAPER       one end stands taller than the other, so the body has a
 *               direction instead of two identical ends;
 *   OUTER_FACE  the face that looks out of the ear is flatter — the touch
 *               surface;
 *   EAR_FACE    the face that sits in the concha is fuller.
 *
 * Each is a scale along one axis by a function of an axis it leaves alone, so
 * the inverse is exact. The clearance check needs the inverse; a deformation
 * without one would have meant testing against a mesh.
 */
const TAPER = 0.08;
const OUTER_FACE = 0.86;
const EAR_FACE = 1.1;

function deformPoint(v) {
  v.y *= 1 - (TAPER * v.x) / R;
  v.z *= v.z > 0 ? OUTER_FACE : EAR_FACE;
  return v;
}

function undeformPoint(v) {
  v.z /= v.z > 0 ? OUTER_FACE : EAR_FACE;
  v.y /= 1 - (TAPER * v.x) / R;
  return v;
}

/**
 * Carries a normal through the deformation: the inverse transpose of its
 * Jacobian, evaluated at the *undeformed* position `base`. Recomputing normals
 * from the deformed mesh instead would split them along the lathe's seam,
 * where the first and last columns share a position but not an index.
 */
function deformNormal(n, base) {
  const ty = 1 - (TAPER * base.x) / R;
  const slope = -TAPER / R;
  const kz = base.z > 0 ? OUTER_FACE : EAR_FACE;
  return n.set(n.x - ((base.y * slope) / ty) * n.y, n.y / ty, n.z / kz).normalize();
}

/** Applies the deformation to a geometry's positions and normals in place. */
function deformGeometry(g) {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    if (nor) {
      n.fromBufferAttribute(nor, i);
      deformNormal(n, p);
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    deformPoint(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  if (nor) nor.needsUpdate = true;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function canvasTexture(canvas, repeat = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

/**
 * The same, for a map that is data rather than a picture.
 *
 * Roughness, metalness and normals are numbers that happen to be stored in
 * colour channels. Decoding them through sRGB applies a gamma curve to a
 * quantity that has no gamma, which shows up as roughness that is wrong in the
 * mid-tones — subtle enough to be blamed on the lighting for an hour.
 */
function dataTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Every generated texture set, by name. One table so `createStage` and
 * `prebuildTextures` cannot disagree about a seed.
 */
const TEXTURE_SETS = {
  brushed: () => brushedTextures(42),
  pcb: () => pcbTextures(1337),
  die: () => dieTextures(7),
  grille: () => grilleTextures(),
  driver: () => driverTextures(91),
  wrap: () => cellWrapTextures(55),
  perforation: () => perforationTextures(),
  antenna: () => antennaTextures(23),
};

/** Sets built ahead of `createStage`, each taken exactly once. */
const prebuilt = new Map();

function textureSet(name) {
  const set = prebuilt.get(name) ?? TEXTURE_SETS[name]();
  // Taken, not kept: the stage disposes these with itself, and a module-level
  // reference would hold ~40 MB of canvases for the rest of the visit.
  prebuilt.delete(name);
  return set;
}

/**
 * Generates the texture sets one task at a time, ahead of `createStage`.
 *
 * Built inline they are a single main-thread task — 280 ms measured on a
 * desktop CPU, mid-scroll, as the configurator approaches — because the six
 * generators are pure JS and canvas work with no natural break between them.
 * Yielding after each set lets the page draw frames in between, so the cost
 * arrives as six short stalls nobody sees rather than one long one everybody
 * does. Optional: `createStage` builds whatever was not prebuilt.
 */
export async function prebuildTextures() {
  for (const [name, build] of Object.entries(TEXTURE_SETS)) {
    if (!prebuilt.has(name)) prebuilt.set(name, build());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The studio the shell reflects: a black room with softboxes in it.
 *
 * It used to be three's RoomEnvironment — a lit box full of smaller boxes —
 * which is a fine generic environment and the wrong one for a metal product
 * on a black page: every box became a blotch in the shell, which is most of
 * why it read as a chrome egg. Product photography lights metal with a few
 * large, soft, deliberate sources against darkness, so the reflections are
 * long clean gradients and the edges are drawn by rim strips. This is that,
 * as emissive panels: still not a single HDRI byte.
 */
function createStudio() {
  const studio = new THREE.Scene();
  const panel = (w, h, intensity, at, colour = 0xffffff) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(colour).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(at[0], at[1], at[2]);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  };
  // Overhead strip: the long highlight that runs along the crown.
  panel(9, 1.4, 6, [0, 7, 0.6]);
  // Key softbox, high and front-left: the broad gradient across the outer face.
  panel(6, 5, 3.4, [-4.5, 3.4, 5.5]);
  // Behind the camera, high: the face pointed at the viewer reflects whatever
  // is behind them, and with nothing there it went to near-black. A big soft
  // source above the lens is what puts a gradient down the front instead.
  panel(12, 4.5, 1.5, [0, 3.2, 8.5]);
  panel(12, 4, 0.5, [0, -1.4, 9]);
  // Rim strips behind either side: on a black page they *are* the silhouette.
  panel(1.1, 8, 7, [6, 0.6, -3.6]);
  panel(1.1, 8, 5, [-6, 0.6, -3.6]);
  // Warm bounce from below, so the underside is not a hole in the page.
  panel(10, 10, 0.45, [0, -7, 1], 0xf0e6d6);
  return studio;
}

/**
 * `offline` is for the baked frames: soft shadows between the internals,
 * which the live configurator neither needs (its case is closed) nor can
 * afford on every laptop.
 *
 * `deferEnvironment` is for the live configurator: it leaves the studio
 * environment unbuilt so `prepare()` can compile its shaders off the main
 * thread first. The prerender wants the synchronous form — a stall there costs
 * nobody anything, and it reads the canvas straight after the first render.
 */
export function createStage(canvas, { deferEnvironment = false, offline = false } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);
  // Khronos PBR Neutral rather than ACES. ACES is a film curve: it bends hue
  // and saturation on the way to white, so the configurator's four finishes
  // came out a shade off their own swatches. Neutral is built for exactly
  // this — product colour that survives the trip to the screen.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (offline) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  const scene = new THREE.Scene();

  // Procedural studio. See `createStudio`; built in `prepare()` instead when
  // the configurator defers it.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = createStudio();
  if (!deferEnvironment) {
    scene.environment = pmrem.fromScene(studio, 0.03).texture;
  }

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(3.4, 4.6, 4.2);
  scene.add(key);
  if (offline) {
    // Fitted to the exploded assembly, which is the widest the scene gets.
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const cam = key.shadow.camera;
    cam.left = cam.bottom = -3.4;
    cam.right = cam.top = 3.4;
    cam.near = 1;
    cam.far = 16;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.015;
    key.shadow.radius = 3;
  }

  const rim = new THREE.DirectionalLight(0xf3efe7, 2.8);
  rim.position.set(-4.2, 1.1, -3.6);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-1.5, -3.0, 2.0);
  scene.add(fill);

  // ---- Materials ---------------------------------------------------------
  // The shell is neutral grey on purpose: the walkthrough is baked to frames,
  // so a colour baked in here would mean re-rendering all 240 of them per
  // variant. `setFinish` overrides it for the live configurator.
  // Every generated map is registered here as it is made, because
  // `Material.dispose()` does not touch the textures hanging off it — and the
  // configurator creates and destroys this whole stage on every mount.
  const textures = [];
  const asData = (canvas) => {
    const tex = dataTexture(canvas);
    textures.push(tex);
    return tex;
  };
  const asColour = (canvas) => {
    const tex = canvasTexture(canvas);
    textures.push(tex);
    return tex;
  };

  const brushedMaps = textureSet("brushed");
  const brushedRM = asData(brushedMaps.rm);
  const brushedNormal = asData(brushedMaps.normal);

  // Bead-blasted, anodised: a satin metal whose highlights are broad and soft.
  // It rendered as chrome for a long time — see `brushedTextures` for why —
  // on a page whose copy says the opposite.
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xb6b9bf,
    metalness: 0.96,
    roughness: 0.42,
    roughnessMap: brushedRM,
    normalMap: brushedNormal,
    // Barely there on purpose. A brush mark is a few microns deep; pushed any
    // harder the shell stops looking anodised and starts looking hammered.
    normalScale: new THREE.Vector2(0.12, 0.12),
  });
  const shellInnerMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a30,
    metalness: 0.4,
    roughness: 0.75,
    side: THREE.BackSide,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x141418,
    metalness: 0.25,
    roughness: 0.45,
  });
  const copperMat = new THREE.MeshStandardMaterial({
    color: 0xb87333,
    metalness: 1,
    roughness: 0.33,
  });
  // The cell's end caps. Nickel-plated steel: bright, but rough enough that it
  // does not mirror the environment the way the shell does — a battery that
  // reflects as hard as the case reads as a second piece of jewellery.
  const terminalMat = new THREE.MeshStandardMaterial({
    color: 0x9a958c,
    metalness: 0.9,
    roughness: 0.34,
  });
  // Driver magnet and back plate: sintered neodymium under a nickel coat.
  const magnetMat = new THREE.MeshStandardMaterial({
    color: 0x4a4740,
    metalness: 0.85,
    roughness: 0.46,
  });
  const statusLedMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0c,
    emissive: 0xe4d9c8,
    emissiveIntensity: 1.4,
    roughness: 0.2,
  });

  // ---- Lit surfaces, not lit pictures ------------------------------------
  // These four all used to be a flat base colour with the whole texture on
  // `emissiveMap`, which is why the internals read as decals. Emissive light
  // does not come from anywhere: it takes no shading across a form, throws no
  // highlight, and leaves the key light with nothing to do. The maps now feed
  // `map` / `roughnessMap` / `metalnessMap` / `normalMap` and the parts are
  // lit by the same three lights as the shell.
  //
  // `emissive` stays, at a fraction of its old strength, because the
  // walkthrough drives it: the X-Ray pose and the push-in both lift these to
  // make the internals legible through the shell. That is a deliberate
  // stylisation on top of a lit surface, which is a different thing from the
  // surface being made of stylisation.
  const pcbMaps = textureSet("pcb");
  const pcbRM = asData(pcbMaps.rm);
  const pcbAlbedo = asColour(pcbMaps.albedo);
  const pcbMat = new THREE.MeshStandardMaterial({
    map: pcbAlbedo,
    roughnessMap: pcbRM,
    metalnessMap: pcbRM,
    normalMap: asData(pcbMaps.normal),
    normalScale: new THREE.Vector2(1.15, 1.15),
    metalness: 1,
    roughness: 1,
    emissive: 0xe4d9c8,
    emissiveMap: pcbAlbedo,
    emissiveIntensity: 0.06,
  });

  const dieMaps = textureSet("die");
  const dieRM = asData(dieMaps.rm);
  const dieAlbedo = asColour(dieMaps.albedo);
  const chipMat = new THREE.MeshStandardMaterial({
    map: dieAlbedo,
    roughnessMap: dieRM,
    metalnessMap: dieRM,
    normalMap: asData(dieMaps.normal),
    normalScale: new THREE.Vector2(1.0, 1.0),
    metalness: 1,
    roughness: 1,
    emissive: 0xe4d9c8,
    emissiveMap: dieAlbedo,
    emissiveIntensity: 0.05,
  });

  const grilleMaps = textureSet("grille");
  const grilleRM = asData(grilleMaps.rm);
  const grilleAlbedo = asColour(grilleMaps.albedo);
  const grilleMat = new THREE.MeshStandardMaterial({
    map: grilleAlbedo,
    roughnessMap: grilleRM,
    metalnessMap: grilleRM,
    normalMap: asData(grilleMaps.normal),
    normalScale: new THREE.Vector2(1.6, 1.6),
    metalness: 1,
    roughness: 1,
    emissive: 0xc9c4bb,
    emissiveMap: grilleAlbedo,
    emissiveIntensity: 0.04,
  });

  const coneMaps = textureSet("driver");
  const coneRM = asData(coneMaps.rm);
  const driverFaceMat = new THREE.MeshStandardMaterial({
    map: asColour(coneMaps.albedo),
    roughnessMap: coneRM,
    metalnessMap: coneRM,
    normalMap: asData(coneMaps.normal),
    normalScale: new THREE.Vector2(1.5, 1.5),
    metalness: 1,
    roughness: 1,
  });

  const wrapMaps = textureSet("wrap");
  const wrapRM = asData(wrapMaps.rm);
  const cellWrapMat = new THREE.MeshStandardMaterial({
    map: asColour(wrapMaps.albedo),
    roughnessMap: wrapRM,
    metalnessMap: wrapRM,
    normalMap: asData(wrapMaps.normal),
    normalScale: new THREE.Vector2(1.1, 1.1),
    metalness: 1,
    roughness: 1,
  });

  // ---- Geometry ----------------------------------------------------------
  const root = new THREE.Group();
  scene.add(root);

  /**
   * Every explodable part carries its own direction and travel, and may carry
   * a `turn`: extra local rotation, in radians per axis, applied in step with
   * the explode.
   *
   * The driver is why this exists. Its cone has to face the nozzle, which is
   * the ear side, which is away from the camera — so assembled correctly, the
   * one surface in the device worth looking at is the one nobody ever sees. An
   * exploded view is allowed to turn a part to present its working face; that
   * is what the convention is *for*. The turn runs off the same `explode`
   * value as the travel, so it unwinds on the way back with no extra state.
   */
  const parts = [];

  /**
   * When each part moves, as a share of the explode's own progress.
   *
   * Everything used to move at once, which is not something a case can do: the
   * internals set off sideways while the shell halves had barely parted, so
   * the N1 core and the board left through the front of the top shell and the
   * driver through the wall of the bottom one — about thirty frames, opening
   * and closing. The enclosure now opens first and the internals start only
   * once the rims have cleared them, then leave through the opening. The
   * overlap is what keeps it one movement rather than two. Played backwards,
   * the same windows put everything back in before the case closes.
   * `scripts/check-clearance.mjs` holds the line on every frame.
   */
  const OPENS_FIRST = new Set(["shellTop", "shellBottom", "bezel", "mics", "sensor"]);
  const ENCLOSURE_WINDOW = [0, 0.55];
  const INTERNAL_WINDOW = [0.3, 1];

  function addPart(name, object, dir, distance, turn) {
    object.userData.home = object.position.clone();
    object.userData.homeRot = object.rotation.clone();
    parts.push({
      name,
      object,
      dir: new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(),
      distance,
      turn: turn ? new THREE.Vector3(turn[0], turn[1], turn[2]) : null,
      window: OPENS_FIRST.has(name) ? ENCLOSURE_WINDOW : INTERNAL_WINDOW,
    });
    root.add(object);
    return object;
  }

  // ---- The surface -------------------------------------------------------
  // Everything that sits on the shell is placed on the *deformed* surface, by
  // the same functions the shell itself was built through. Intuition about
  // where "z = 0.6" is on a squashed, tapered superellipsoid is wrong nearly
  // everywhere, and a port that is wrong by a hair either sinks into the body
  // or floats off it.

  /** Shell surface point at (azimuth, height), in a half's local space. */
  function surfacePoint(azimuth, y, out) {
    const r = profileRadius(R, H, y);
    out.set(Math.sin(azimuth) * r, y, Math.cos(azimuth) * r * FLATTEN);
    return deformPoint(out);
  }

  const _sa = new THREE.Vector3();
  const _sb = new THREE.Vector3();
  const _ta2 = new THREE.Vector3();

  /** Outward normal there, from the surface's own tangents. */
  function surfaceNormal(azimuth, y, out) {
    const e = 1e-3;
    surfacePoint(azimuth + e, y, _sa);
    surfacePoint(azimuth - e, y, _sb);
    _ta2.subVectors(_sa, _sb);
    surfacePoint(azimuth, y + e, _sa);
    surfacePoint(azimuth, y - e, _sb);
    out.crossVectors(_ta2, _sa.sub(_sb)).normalize();
    surfacePoint(azimuth, y, _sa);
    if (out.dot(_sa) < 0) out.negate();
    return out;
  }

  /**
   * A stadium-shaped patch that lies *on* the surface: a grid, every vertex of
   * which is placed on the shell and lifted along its own normal.
   *
   * A flat decal on a curved body is a chord — its middle sinks into the shell
   * while its ends stand off it — and a ShapeGeometry triangulates a capsule
   * into slivers with no interior vertices at all, which is the same chord
   * problem at a larger scale. A grid that conforms vertex by vertex has
   * neither. `length` and `halfHeight` are in shell units along the surface;
   * a length of twice the half-height makes a circle.
   */
  function conformPatch({ azimuth, y, length, halfHeight, lift, repeat = [1, 1], segments = 40 }) {
    const rows = 8;
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const r0 = profileRadius(R, H, y);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const cap = halfHeight;
    const straight = Math.max(0, length / 2 - cap);
    for (let i = 0; i <= segments; i++) {
      const s = -length / 2 + (i / segments) * length;
      const over = Math.abs(s) - straight;
      const hw = over > 0 ? Math.sqrt(Math.max(0, cap * cap - over * over)) : cap;
      for (let j = 0; j <= rows; j++) {
        const t = -1 + (j / rows) * 2;
        const az = azimuth + s / r0;
        const yy = y + t * hw;
        surfaceNormal(az, yy, n);
        surfacePoint(az, yy, p).addScaledVector(n, lift);
        positions.push(p.x, p.y, p.z);
        normals.push(n.x, n.y, n.z);
        uvs.push(
          ((s + length / 2) / length) * repeat[0],
          ((t * hw + cap) / (2 * cap)) * repeat[1],
        );
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < rows; j++) {
        const a = i * (rows + 1) + j;
        const b = a + rows + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    return g;
  }

  // ---- Shell -------------------------------------------------------------
  // Two halves, each a solid wall rather than a skin: the outer lathe, an
  // inset inner lathe, and a machined rim joining them. A single surface read
  // as paper the moment the case opened — the rim was a line with nothing
  // behind it.
  const antennaMaps = textureSet("antenna");
  const antennaMat = new THREE.MeshStandardMaterial({
    map: asColour(antennaMaps.albedo),
    roughnessMap: asData(antennaMaps.rm),
    metalnessMap: asData(antennaMaps.rm),
    normalMap: asData(antennaMaps.normal),
    metalness: 1,
    roughness: 1,
    side: THREE.BackSide,
  });
  const bossMat = new THREE.MeshStandardMaterial({
    color: 0x3a3b41,
    metalness: 0.8,
    roughness: 0.5,
  });

  const shellGeoms = [];
  let shellBottom = null;
  for (const sign of [1, -1]) {
    const half = new THREE.Group();

    // `SEAM_PHI` puts the lathe's start-and-end column on the ear side, behind
    // the nozzle. At phi 0 it ran straight down the middle of the face the
    // hero is shot from: a hairline where the grain texture wraps.
    const outer = new THREE.LatheGeometry(shellProfile(R, H, sign), 128, SEAM_PHI);
    outer.scale(1, 1, FLATTEN);
    deformGeometry(outer);
    shellGeoms.push(outer);
    half.add(new THREE.Mesh(outer, shellMat));

    const inner = new THREE.LatheGeometry(shellProfile(R, H, sign), 96, SEAM_PHI);
    inner.scale(WALL, WALL, WALL * FLATTEN);
    deformGeometry(inner);
    half.add(new THREE.Mesh(inner, sign > 0 ? antennaMat : shellInnerMat));

    // The machined rim between them, facing the parting plane.
    const rim = new THREE.RingGeometry((R - CHAMFER) * WALL, R - CHAMFER, 128, 1);
    rim.rotateX(sign > 0 ? Math.PI / 2 : -Math.PI / 2);
    rim.scale(1, 1, FLATTEN);
    deformGeometry(rim);
    half.add(new THREE.Mesh(rim, shellMat));

    // Screw bosses on the inside, either side of the internals. Nothing on the
    // outside of a case says how it is held together; this says it the moment
    // it opens.
    for (const x of [-0.98, 0.98]) {
      const boss = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.058, 0.2, 20),
        bossMat,
      );
      boss.position.set(x, sign * 0.1, 0);
      deformPoint(boss.position);
      half.add(boss);
      const bore = new THREE.Mesh(new THREE.CircleGeometry(0.022, 16), darkMat);
      bore.rotation.x = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
      bore.position.set(0, -sign * 0.1005, 0);
      boss.add(bore);
    }

    if (sign < 0) {
      // Parting line: a fine dark line in the V the two chamfers make. It used
      // to be a torus 0.036 thick standing proud of the body — a black rubber
      // band round a metal pebble, which is not what "no seams you can catch a
      // fingernail on" describes.
      const seam = new THREE.TorusGeometry(R - CHAMFER * 0.6, 0.011, 10, 160);
      seam.rotateX(Math.PI / 2);
      seam.scale(1, 1, FLATTEN);
      deformGeometry(seam);
      half.add(new THREE.Mesh(seam, darkMat));
      shellBottom = half;
    }

    addPart(sign > 0 ? "shellTop" : "shellBottom", half, [0, sign, 0], 1.55);
  }

  // Ghost shell — only ever visible in the X-Ray "inner" pass. Deleting the
  // shell outright leaves the internals floating in a void with no sense of
  // scale; a translucent skin is what makes it read as *seeing into* the
  // product.
  // Back faces only, additively blended: you see the *far* wall of the
  // enclosure glowing behind the components, with nothing milky in front of
  // them. A double-sided translucent skin looks like the product was dipped in
  // milk; this looks like a scan.
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0x3a352c,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  // Deliberately coarse lathe — a 96-segment wireframe is a grey smear, a
  // 20-segment one reads as survey geometry.
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0xe4d9c8,
    wireframe: true,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const ghost = new THREE.Group();
  for (const g of shellGeoms) ghost.add(new THREE.Mesh(g, ghostMat));
  for (const sign of [1, -1]) {
    const coarse = new THREE.LatheGeometry(shellProfile(R, H, sign, 7), 20, SEAM_PHI);
    coarse.scale(1, 1, FLATTEN);
    deformGeometry(coarse);
    ghost.add(new THREE.Mesh(coarse, wireMat));
  }
  ghost.visible = false;
  root.add(ghost);

  // ---- Acoustic nozzle -----------------------------------------------------
  // The one feature that says *earbud*. It replaces a torus and a disc on the
  // ear face that read as a porthole: a short tube, angled the way an ear
  // canal runs — up and forward — with the acoustic mesh set back inside its
  // lip. Shell material, so a finish chosen in the configurator reaches it.
  const NOZZLE_AZ = Math.PI + 0.42;
  const NOZZLE_Y = -0.06;
  const nozzleProfile = [
    [0.43, -0.07],
    [0.4, 0.0],
    [0.35, 0.08],
    [0.325, 0.2],
    [0.318, 0.27],
    [0.322, 0.3],
    [0.312, 0.325],
    [0.29, 0.335],
    [0.268, 0.33],
    [0.262, 0.3],
  ].map(([r, h]) => new THREE.Vector2(r, h));
  const bezel = new THREE.Group();
  const nozzle = new THREE.Mesh(new THREE.LatheGeometry(nozzleProfile, 72), shellMat);
  bezel.add(nozzle);
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.264, 64), grilleMat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.302;
  bezel.add(mesh);
  // Sunk into the body so the flare meets the ear face with no visible gap.
  {
    const n = surfaceNormal(NOZZLE_AZ, NOZZLE_Y, new THREE.Vector3());
    surfacePoint(NOZZLE_AZ, NOZZLE_Y, bezel.position).addScaledVector(n, -0.03);
    // Tilted off the surface normal toward +Y and -X: up and forward, as a
    // canal runs, rather than straight out of the side of the head.
    const axis = n.clone().add(new THREE.Vector3(-0.22, 0.32, 0)).normalize();
    bezel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    bezel.userData.axis = axis;
  }
  addPart("bezel", bezel, bezel.userData.axis.toArray(), 1.25);

  // ---- 10 mm planar driver -------------------------------------------------
  //
  // A cylinder carries three material groups — wall, +Y cap, -Y cap — so the
  // basket, the magnet at the back and the cone at the front are one mesh with
  // three surfaces rather than three meshes. The group is turned a quarter
  // turn about X, which sends +Y to +Z, so the cone belongs to the -Y cap:
  // it has to face the nozzle, which is the ear side.
  const rubberMat = new THREE.MeshStandardMaterial({
    color: 0x16161a,
    metalness: 0,
    roughness: 0.82,
  });
  const driver = new THREE.Group();
  driver.add(
    new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.13, 56), [
      darkMat,
      magnetMat,
      driverFaceMat,
    ]),
  );
  // The surround: the rubber roll the diaphragm hangs from. Without it the face
  // is a printed disc in a can; with it, it is a membrane that can move.
  const surround = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.024, 10, 72), rubberMat);
  surround.rotation.x = Math.PI / 2;
  surround.position.y = -0.066;
  driver.add(surround);
  // Basket frame: a ring standing proud of the wall, with vent windows.
  const basket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.485, 0.485, 0.05, 72, 1, true),
    magnetMat,
  );
  basket.position.y = 0.03;
  driver.add(basket);
  for (let i = 0; i < 6; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.02), darkMat);
    const a = (i / 6) * TAU + 0.26;
    vent.position.set(Math.cos(a) * 0.488, 0.03, Math.sin(a) * 0.488);
    vent.rotation.y = -a + Math.PI / 2;
    driver.add(vent);
  }
  const coil = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.045, 16, 48),
    copperMat,
  );
  coil.rotation.x = Math.PI / 2;
  // Behind the cone, where a voice coil actually lives. It used to sit on top
  // of it, which put the one copper thing in the assembly in front of the one
  // surface worth looking at.
  coil.position.y = 0.075;
  driver.add(coil);
  const magnet = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.29, 0.06, 40),
    magnetMat,
  );
  magnet.position.y = 0.095;
  driver.add(magnet);
  driver.rotation.x = Math.PI / 2;
  driver.position.z = -0.28;
  // Half a turn about X swings the cone from the ear side round to the camera
  // over the course of the explode.
  addPart("driver", driver, [-0.42, -0.5, -1], 1.35, [Math.PI, 0, 0]);

  // ---- Li-Si cell ----------------------------------------------------------
  // Wrapped label on the wall, terminals on the two caps, rolled edges where a
  // can is crimped, and a nickel tab off the positive end — the thing the
  // flex is welded to. The tab used to be a copper brick half the cell's
  // length.
  const nickelMat = new THREE.MeshStandardMaterial({
    color: 0xb9b4aa,
    metalness: 1,
    roughness: 0.3,
  });
  const battery = new THREE.Group();
  const cell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.62, 48),
    [cellWrapMat, terminalMat, terminalMat],
  );
  cell.rotation.z = Math.PI / 2;
  battery.add(cell);
  for (const x of [-0.305, 0.305]) {
    const crimp = new THREE.Mesh(new THREE.TorusGeometry(0.326, 0.02, 10, 48), terminalMat);
    crimp.rotation.y = Math.PI / 2;
    crimp.position.x = x;
    battery.add(crimp);
  }
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.012), nickelMat);
  tab.position.set(0.39, 0.05, 0.0);
  battery.add(tab);
  battery.position.set(-0.32, -0.24, 0.1);
  addPart("battery", battery, [-1, 0.32, 0.25], 1.5);

  // ---- Main board ----------------------------------------------------------
  const BOARD_DEPTH = 0.07;
  const pcbGeometry = new RoundedBoxGeometry(BOARD.w, BOARD.h, BOARD_DEPTH, 3, 0.05);
  const pcb = new THREE.Mesh(pcbGeometry, pcbMat);
  // 0.06 lower than it sat in the pebble: under the flatter outer face of the
  // new shell, and now that the shell has a wall, the board's top corner was
  // inside it. The core moves down with it, so the socket stays under it.
  pcb.position.set(0.1, 0.2, 0.12);
  pcb.rotation.x = -0.12;

  /**
   * Board-local position of a point on the top face, from its texture UV.
   *
   * Read off the geometry rather than assumed: RoundedBoxGeometry spends the
   * outer margin of UV space on its rounded edge, so `(u - 0.5) * width` is
   * off by exactly as much as a part would visibly miss its painted pads.
   */
  const topFace = [];
  {
    const pos = pcbGeometry.getAttribute("position");
    const uv = pcbGeometry.getAttribute("uv");
    const index = pcbGeometry.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
      if (ids.every((id) => pos.getZ(id) > BOARD_DEPTH / 2 - 1e-4)) {
        topFace.push(
          ids.map((id) => ({
            p: new THREE.Vector3().fromBufferAttribute(pos, id),
            u: uv.getX(id),
            v: uv.getY(id),
          })),
        );
      }
    }
  }
  function boardPoint(u, v) {
    for (const [a, b, c] of topFace) {
      const d = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
      if (Math.abs(d) < 1e-12) continue;
      const wa = ((b.v - c.v) * (u - c.u) + (c.u - b.u) * (v - c.v)) / d;
      const wb = ((c.v - a.v) * (u - c.u) + (a.u - c.u) * (v - c.v)) / d;
      const wc = 1 - wa - wb;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      return new THREE.Vector3()
        .addScaledVector(a.p, wa)
        .addScaledVector(b.p, wb)
        .addScaledVector(c.p, wc);
    }
    return new THREE.Vector3((u - 0.5) * BOARD.w, (v - 0.5) * BOARD.h, BOARD_DEPTH / 2);
  }

  // Populated, in 3D, exactly over the parts the texture painted. The painted
  // bodies and their contact shadows stay underneath; the geometry is what
  // catches the key light along its top edge and throws a real shadow in the
  // baked frames.
  const smdBodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.05, roughness: 0.5 });
  const icMat = new THREE.MeshStandardMaterial({ color: 0x100e0c, metalness: 0.05, roughness: 0.42 });
  const canMat = new THREE.MeshStandardMaterial({
    color: 0xcdc7bd,
    metalness: 1,
    roughness: 0.32,
    roughnessMap: brushedRM,
  });
  {
    const px = pcbMaps.size;
    const sock = BOARD.socket;
    const sockHalfU = sock.size / BOARD.w / 2 + 0.01;
    const sockHalfV = sock.size / BOARD.h / 2 + 0.01;
    const underSocket = (u, v) =>
      Math.abs(u - sock.u) < sockHalfU && Math.abs(v - sock.v) < sockHalfV;
    const toUV = (x, y) => [x / px, 1 - y / px];
    const passives = pcbMaps.placements.filter((pl) => {
      if (pl.kind !== "passive") return false;
      const [u, v] = toUV(pl.x + pl.w / 2, pl.y + pl.h / 2);
      return !underSocket(u, v);
    });

    const box = new THREE.BoxGeometry(1, 1, 1);
    const bodies = new THREE.InstancedMesh(box, smdBodyMat, passives.length);
    const terminals = new THREE.InstancedMesh(box, terminalMat, passives.length * 2);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const dark = new THREE.Color(0x241d16);
    const light = new THREE.Color(0x4a3a26);
    passives.forEach((pl, i) => {
      const [u0, v0] = toUV(pl.x, pl.y + pl.h);
      const [u1, v1] = toUV(pl.x + pl.w, pl.y);
      const a = boardPoint(u0, v0);
      const b = boardPoint(u1, v1);
      const w = b.x - a.x;
      const h = b.y - a.y;
      const tall = 0.014;
      const centre = a.clone().add(b).multiplyScalar(0.5);
      centre.z = BOARD_DEPTH / 2 + tall / 2;
      m.compose(centre, q, s.set(w * 0.98, h * 0.98, tall));
      bodies.setMatrixAt(i, m);
      bodies.setColorAt(i, pl.light ? light : dark);
      // Terminals on the long axis, whichever way the part is turned.
      const along = w >= h;
      const tw = (along ? w : h) * 0.22;
      for (const side of [-1, 1]) {
        const tpos = centre.clone();
        if (along) tpos.x += side * (w / 2 - tw / 2);
        else tpos.y += side * (h / 2 - tw / 2);
        tpos.z += 0.001;
        m.compose(
          tpos,
          q,
          s.set(along ? tw : w * 1.02, along ? h * 1.02 : tw, tall + 0.002),
        );
        terminals.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), m);
      }
    });
    pcb.add(bodies, terminals);

    // The second IC goes under an RF shield can: the one brushed-metal box on
    // every real radio board, and the part that makes it read as a radio.
    const ics = pcbMaps.placements.filter((pl) => pl.kind === "ic");
    for (const pl of pcbMaps.placements) {
      if (pl.kind === "ic") {
        const [u0, v0] = toUV(pl.x, pl.y + pl.h);
        const [u1, v1] = toUV(pl.x + pl.w, pl.y);
        const a = boardPoint(u0, v0);
        const b = boardPoint(u1, v1);
        if (underSocket((u0 + u1) / 2, (v0 + v1) / 2)) continue;
        const shielded = pl === ics[1];
        const tall = shielded ? 0.036 : 0.026;
        const pad = shielded ? 0.022 : 0;
        const body = new THREE.Mesh(
          new RoundedBoxGeometry(b.x - a.x + pad * 2, b.y - a.y + pad * 2, tall, 2, shielded ? 0.006 : 0.004),
          shielded ? canMat : icMat,
        );
        body.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, BOARD_DEPTH / 2 + tall / 2);
        pcb.add(body);
      } else if (pl.kind === "can") {
        const c = boardPoint(...toUV(pl.x, pl.y));
        const edge = boardPoint(...toUV(pl.x + pl.r, pl.y));
        const radius = Math.abs(edge.x - c.x) * 0.72;
        const can = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.06, 32), canMat);
        can.rotation.x = Math.PI / 2;
        can.position.set(c.x, c.y, BOARD_DEPTH / 2 + 0.03);
        pcb.add(can);
      }
    }
  }
  addPart("pcb", pcb, [1, -0.15, 0.3], 1.45);

  // ---- AURA N1 neural core -------------------------------------------------
  // Flies toward the camera so the push-in has somewhere to go without
  // clipping through the rest of the assembly. A package on a substrate now,
  // rather than one slab: the step between the two is what says it is a
  // component that was soldered down and lifted off.
  const substrateMat = new THREE.MeshStandardMaterial({
    color: 0x1c2620,
    metalness: 0.2,
    roughness: 0.62,
  });
  const chip = new THREE.Mesh(
    new RoundedBoxGeometry(0.5, 0.5, 0.08, 2, 0.016),
    chipMat,
  );
  const substrate = new THREE.Mesh(
    new RoundedBoxGeometry(0.56, 0.56, 0.024, 2, 0.008),
    substrateMat,
  );
  substrate.position.z = -0.046;
  chip.add(substrate);
  chip.position.set(0.16, 0.24, 0.19);
  chip.rotation.x = -0.12;
  addPart("chip", chip, [0.55, 0.35, 1], 1.75);

  // ---- Flex ------------------------------------------------------------------
  // The rigid-flex board's tail, from the cell's tab to the connector on the
  // board. Rebuilt every frame from where its two ends are, so it bends and
  // stretches with the explode: the parts stay *connected* while they are
  // apart, instead of hanging in a void with nothing between them.
  // Polyimide: translucent amber, not traffic-cone orange.
  const flexMat = new THREE.MeshStandardMaterial({
    color: 0x8f531c,
    metalness: 0.1,
    roughness: 0.34,
    side: THREE.DoubleSide,
  });
  const FLEX_STEPS = 48;
  const FLEX_WIDTH = 0.085;
  const flexGeometry = new THREE.BufferGeometry();
  const flexPositions = new Float32Array((FLEX_STEPS + 1) * 2 * 3);
  flexGeometry.setAttribute("position", new THREE.BufferAttribute(flexPositions, 3));
  {
    const uvs = [];
    const idx = [];
    for (let i = 0; i <= FLEX_STEPS; i++) {
      uvs.push(i / FLEX_STEPS, 0, i / FLEX_STEPS, 1);
      if (i < FLEX_STEPS) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }
    flexGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    flexGeometry.setIndex(idx);
  }
  const flex = new THREE.Mesh(flexGeometry, flexMat);
  flex.frustumCulled = false;
  root.add(flex);

  // Ends, in each part's own space: off the end of the tab, and into the
  // board's connector, which the texture places near the left edge.
  const connector = pcbMaps.placements.find((pl) => pl.kind === "connector");
  const flexEnds = {
    start: { object: tab, point: new THREE.Vector3(0.08, 0, 0), heading: new THREE.Vector3(1, 0, 0.6), across: new THREE.Vector3(0, 1, 0) },
    end: {
      object: pcb,
      point: boardPoint(
        (connector.x + connector.w / 2) / pcbMaps.size,
        1 - (connector.y + connector.h / 2) / pcbMaps.size,
      ).add(new THREE.Vector3(0, 0, 0.004)),
      // Out of the connector along the board toward its near edge, the way a
      // flex is dressed, and only slightly off the surface. Leaving straight up
      // it looped back over the shield can.
      heading: new THREE.Vector3(-1, 0, 0.35),
      across: new THREE.Vector3(0, 1, 0),
    },
  };
  const _f0 = new THREE.Vector3();
  const _f1 = new THREE.Vector3();
  const _f2 = new THREE.Vector3();
  const _f3 = new THREE.Vector3();
  const _fw0 = new THREE.Vector3();
  const _fw1 = new THREE.Vector3();
  const _fp = new THREE.Vector3();
  const _ft = new THREE.Vector3();
  const _fw = new THREE.Vector3();
  const _d01 = new THREE.Vector3();
  const _d12 = new THREE.Vector3();
  const _d23 = new THREE.Vector3();
  const _inv = new THREE.Matrix4();

  /**
   * Re-lays the flex between its two ends. Call after matrices are current.
   *
   * Allocation-free: the configurator calls this every frame through `orbit`.
   */
  function layFlex() {
    _inv.copy(root.matrixWorld).invert();
    const end = (e, p, h, w) => {
      p.copy(e.point).applyMatrix4(e.object.matrixWorld).applyMatrix4(_inv);
      h.copy(e.heading).transformDirection(e.object.matrixWorld).transformDirection(_inv);
      w.copy(e.across).transformDirection(e.object.matrixWorld).transformDirection(_inv);
    };
    end(flexEnds.start, _f0, _f1, _fw0);
    end(flexEnds.end, _f3, _f2, _fw1);
    const span = _f0.distanceTo(_f3);
    const reach = Math.max(0.25, span * 0.45);
    _f1.multiplyScalar(reach).add(_f0);
    _f2.multiplyScalar(reach).add(_f3);
    // A sag that grows with the span. Pulled straight between two parts, a
    // flex reads as a wire under tension; a real one is slack, and it is the
    // droop that says it is a soft thing.
    _f1.y -= span * 0.22;
    _f2.y -= span * 0.22;
    _d01.subVectors(_f1, _f0);
    _d12.subVectors(_f2, _f1);
    _d23.subVectors(_f3, _f2);
    for (let i = 0; i <= FLEX_STEPS; i++) {
      const t = i / FLEX_STEPS;
      const mt = 1 - t;
      _fp
        .copy(_f0).multiplyScalar(mt * mt * mt)
        .addScaledVector(_f1, 3 * mt * mt * t)
        .addScaledVector(_f2, 3 * mt * t * t)
        .addScaledVector(_f3, t * t * t);
      _ft
        .copy(_d01).multiplyScalar(3 * mt * mt)
        .addScaledVector(_d12, 6 * mt * t)
        .addScaledVector(_d23, 3 * t * t)
        .normalize();
      _fw.copy(_fw0).lerp(_fw1, t);
      _fw.addScaledVector(_ft, -_fw.dot(_ft)).normalize().multiplyScalar(FLEX_WIDTH / 2);
      const k = i * 6;
      flexPositions[k] = _fp.x - _fw.x;
      flexPositions[k + 1] = _fp.y - _fw.y;
      flexPositions[k + 2] = _fp.z - _fw.z;
      flexPositions[k + 3] = _fp.x + _fw.x;
      flexPositions[k + 4] = _fp.y + _fw.y;
      flexPositions[k + 5] = _fp.z + _fw.z;
    }
    flexGeometry.attributes.position.needsUpdate = true;
    flexGeometry.computeVertexNormals();
    flexGeometry.computeBoundingSphere();
  }

  // ---- Trace light -----------------------------------------------------------
  // During the push-in, light runs along the board's routing into the socket
  // the core lifted off: pulses contracting on the N1 from every bundle on the
  // board. It replaces a ring of bright bars around the chip, which read as a
  // starburst stuck to the frame. Additive, on a plane just above the board,
  // reading a mask the board's own texture generator drew from the same
  // routing — so the light can only ever be where copper is.
  const flowMat = new THREE.ShaderMaterial({
    uniforms: {
      flowMap: { value: asData(pcbMaps.flow) },
      phase: { value: 0 },
      strength: { value: 0 },
      tint: { value: new THREE.Color(0xf2d7a0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D flowMap;
      uniform float phase;
      uniform float strength;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        vec4 f = texture2D(flowMap, vUv);
        float glow = 0.0;
        for (int i = 0; i < 3; i++) {
          float front = 1.0 - fract(phase + float(i) / 3.0);
          glow += smoothstep(0.04, 0.0, abs(f.g - front)) * (1.0 - front * 0.6);
        }
        gl_FragColor = vec4(tint * f.r * glow * strength, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const flowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD.w - 0.08, BOARD.h - 0.08),
    flowMat,
  );
  flowPlane.position.z = BOARD_DEPTH / 2 + 0.0015;
  flowPlane.visible = false;
  pcb.add(flowPlane);

  // ---- On the surface --------------------------------------------------------
  // MEMS quad-mic array: one slim perforated grille along the upper shoulder,
  // set in a dark recess. It was four round black holes in a row, which read
  // as a face. Travels with the top shell, because it is set into it.
  const perfMaps = textureSet("perforation");
  const micGrilleMat = new THREE.MeshStandardMaterial({
    map: asColour(perfMaps.albedo),
    roughnessMap: asData(perfMaps.rm),
    metalnessMap: asData(perfMaps.rm),
    normalMap: asData(perfMaps.normal),
    normalScale: new THREE.Vector2(1.4, 1.4),
    metalness: 1,
    roughness: 1,
  });
  for (const t of [micGrilleMat.map, micGrilleMat.roughnessMap, micGrilleMat.normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }
  const mics = new THREE.Group();
  // Enough columns that the rounded ends are round: at 40 the caps got three
  // columns each and came out as octagons.
  const MIC = { azimuth: -0.12, y: 0.6, length: 0.62, halfHeight: 0.045, segments: 120 };
  mics.add(
    new THREE.Mesh(
      conformPatch({ ...MIC, length: MIC.length + 0.026, halfHeight: MIC.halfHeight + 0.011, lift: 0.002 }),
      darkMat,
    ),
    // Holes at a pitch of about 0.02 — roughly 30 along and 5 across, which is
    // a laser-drilled grille at this size and not a texture that shimmers.
    new THREE.Mesh(
      conformPatch({ ...MIC, lift: 0.0035, repeat: [MIC.length / 0.16, (MIC.halfHeight * 2) / 0.16] }),
      micGrilleMat,
    ),
  );
  addPart("mics", mics, [0, 1, 0], 1.55);

  // Optical wear sensor: dark glass, flush, in a polished ring. It was a black
  // disc large enough to read as a hole in the case.
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xd4d6da,
    metalness: 1,
    roughness: 0.16,
  });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x1b1e25,
    metalness: 0.2,
    roughness: 0.06,
  });
  // Neutral, not red: two warm dots in a dark circle read as a pair of eyes.
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x30333b,
    metalness: 0.4,
    roughness: 0.22,
  });
  const sensor = new THREE.Group();
  const SENSOR = { azimuth: 0.34, y: -0.3 };
  sensor.add(
    new THREE.Mesh(conformPatch({ ...SENSOR, length: 0.22, halfHeight: 0.11, lift: 0.002, segments: 40 }), ringMat),
    new THREE.Mesh(conformPatch({ ...SENSOR, length: 0.18, halfHeight: 0.09, lift: 0.0035, segments: 40 }), lensMat),
    // Emitter and receiver behind the glass: the two things an optical sensor
    // actually is, and what stops the window reading as a hole.
    new THREE.Mesh(conformPatch({ azimuth: SENSOR.azimuth - 0.035, y: SENSOR.y, length: 0.05, halfHeight: 0.022, lift: 0.0042, segments: 8 }), windowMat),
    new THREE.Mesh(conformPatch({ azimuth: SENSOR.azimuth + 0.035, y: SENSOR.y, length: 0.05, halfHeight: 0.022, lift: 0.0042, segments: 8 }), windowMat),
  );
  // With the bottom shell, for the same reason as the mics.
  addPart("sensor", sensor, [0, -1, 0], 1.55);

  // Status LED: a pinhole. Reads as nothing at a glance and as a considered
  // detail on a second look, which is exactly what it is for.
  const led = new THREE.Mesh(
    conformPatch({ azimuth: -0.28, y: -0.44, length: 0.036, halfHeight: 0.018, lift: 0.002, segments: 12 }),
    statusLedMat,
  );
  // Parented to the lower half so it travels with it when the case opens.
  shellBottom.add(led);

  // ---- Shadows (baked frames only) -------------------------------------------
  // The internals cast onto each other — components onto the board, the core
  // onto its socket, the flex onto the cell. The shell halves do not: a dome
  // shadowing everything beneath it is correct and reads as gloom. Off in the
  // live configurator, where the case is closed and a shadow pass is cost
  // with nothing to show for it.
  if (offline) {
    for (const p of parts) {
      if (OPENS_FIRST.has(p.name)) continue;
      p.object.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
    }
    flex.castShadow = true;
    flex.receiveShadow = true;
    flowPlane.castShadow = false;
    flowPlane.receiveShadow = false;
  }

  // ---- Camera ------------------------------------------------------------
  // Long lens: product photography, minimal perspective distortion on the
  // shell silhouette.
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
  const CAM_HOME = new THREE.Vector3(0, 0.55, 7.0);
  const LOOK_HOME = new THREE.Vector3(0, 0, 0);

  /** Where the camera comes to rest relative to the core at full push-in. */
  const CHIP_OFFSET = new THREE.Vector3(0.55, 0.42, 1.35);

  const _camPos = new THREE.Vector3();
  const _camBase = new THREE.Vector3();
  const _lookAt = new THREE.Vector3();
  const _chipWorld = new THREE.Vector3();
  const _chipTarget = new THREE.Vector3();

  function setSize(w, h, pixelRatio = 1) {
    // The prerender wants exactly the pixels it asked for; the live
    // configurator wants the display's device pixel ratio, capped, because a
    // 3x phone would otherwise render nine times the fragments for a panel
    // that cannot show the difference.
    renderer.setPixelRatio(Math.min(pixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /** Applies the whole timeline. Pure function of `t` — no accumulated state. */
  function applyTimeline(t) {
    const rot = range(t, 0, PHASES.ROTATE_END);
    // How far open the case is, *linear* in t. Each part eases its own share of
    // it below; easing this as well would double the curve and turn every
    // part's move into a lurch through the middle.
    const open =
      t < PHASES.EXPLODE_END
        ? clamp01((t - PHASES.ROTATE_END) / (PHASES.EXPLODE_END - PHASES.ROTATE_END))
        : t < PHASES.PUSH_END
          ? 1
          : 1 - clamp01((t - PHASES.PUSH_END) / (1 - PHASES.PUSH_END));
    // The whole-assembly value, for the camera and the yaw: exactly what it
    // was before the parts were staggered.
    const explode = smoother(open);
    const push =
      t < PHASES.PUSH_END
        ? range(t, PHASES.HOLD_END, PHASES.PUSH_END)
        : 1 - range(t, PHASES.PUSH_END, 1);

    // A full turn, then a small extra yaw into a 3/4 pose that reads better
    // once the assembly is open.
    //
    // Plus a hair — 0.09° — so the hero pose is never exactly square to the
    // lens. At exactly zero the front meridian fell on a column of pixel
    // centres and the rasteriser left a one-pixel crack down the bottom shell
    // of the opening frame, the one frame everybody sees. It was in the old
    // render too; it moved with nothing and only existed at t = 0 and t = 1.
    root.rotation.y = rot * TAU + explode * 0.42 + 0.0015;
    root.rotation.x = explode * -0.17;

    for (const p of parts) {
      const e = range(open, p.window[0], p.window[1]);
      const d = p.distance * e;
      const home = p.object.userData.home;
      p.object.position.set(
        home.x + p.dir.x * d,
        home.y + p.dir.y * d,
        home.z + p.dir.z * d,
      );
      if (p.turn) {
        const r = p.object.userData.homeRot;
        p.object.rotation.set(
          r.x + p.turn.x * e,
          r.y + p.turn.y * e,
          r.z + p.turn.z * e,
        );
      }
    }

    // Silicon wakes up as the camera closes in.
    // Base levels are a twentieth of what they were, because these surfaces
    // are lit now. The lift during the push-in and the explode survives in
    // spirit -- it is there to keep the internals legible while the shell is
    // still around them -- but it now starts from a lit part instead of
    // standing in for the lighting altogether.
    chipMat.emissiveIntensity = 0.05 + push * 0.7;
    pcbMat.emissiveIntensity = 0.06 + explode * 0.16;

    root.updateMatrixWorld(true);
    chip.getWorldPosition(_chipWorld);
    layFlex();

    // Light along the routing into the socket: three fronts contracting on it,
    // fading in with the push and out again as the camera retreats. Phase is a
    // function of `push`, not of time, so every frame is still a pure function
    // of `t` and scrubbing backwards plays the light backwards.
    flowPlane.visible = push > 0.001;
    flowMat.uniforms.phase.value = push * 2.4;
    flowMat.uniforms.strength.value = smoother(push * 1.6) * 1.1;

    // Pull back as the assembly opens. The silhouette gets roughly 2.4x wider
    // between closed and fully exploded, so the framing has to follow it or
    // the outer parts simply leave the frame — the same move a camera operator
    // would make, and the reason Apple's exploded shots never feel cramped.
    //
    // Driven by the enclosure's own window, not the whole explode: the shell
    // halves are what reach the top and bottom of the frame, and they now get
    // there in the first half of the move. Following the overall progress
    // instead, the camera lagged them and the top shell left the frame.
    const spread = range(open, ENCLOSURE_WINDOW[0], ENCLOSURE_WINDOW[1]);
    _camBase.copy(CAM_HOME).multiplyScalar(1 + spread * 0.62);

    // Then dolly toward the core along a fixed offset.
    _chipTarget.copy(_chipWorld).add(CHIP_OFFSET);
    _camPos.copy(_camBase).lerp(_chipTarget, push);
    _lookAt.copy(LOOK_HOME).lerp(_chipWorld, push);
    camera.position.copy(_camPos);
    camera.lookAt(_lookAt);
  }

  function renderFrame(t) {
    applyTimeline(clamp01(t));
    renderer.render(scene, camera);
  }

  // ---- Live configurator -------------------------------------------------
  // The same scene, rendered a second way. Offline it is baked to a frame
  // sequence, because the walkthrough needs deterministic frames and a decode
  // cost you can budget. Here it runs live, because a turntable of frames can
  // only ever spin about one axis and the configurator has to go anywhere.
  //
  // One source of truth for the geometry either way: change the shell and both
  // the film and the object you can turn change with it.

  const ORBIT_RADIUS = CAM_HOME.length();

  /**
   * Points the camera at the assembled device from an arbitrary direction.
   *
   * `azimuth` and `elevation` are in radians. Elevation is clamped by the
   * caller, not here — this is the primitive, and the policy about how far over
   * the top you may tip belongs with the thing handling the drag.
   */
  function orbit(azimuth, elevation, distance = 1) {
    // t = 0 is the assembled pose with no rotation applied, which is what the
    // orbit is defined relative to. It also resets whatever the last render
    // left behind, so this stays a pure function of its arguments.
    applyTimeline(0);

    const radius = ORBIT_RADIUS * distance;
    const polar = Math.PI / 2 - elevation;
    camera.position.set(
      radius * Math.sin(polar) * Math.sin(azimuth),
      radius * Math.cos(polar),
      radius * Math.sin(polar) * Math.cos(azimuth),
    );
    camera.lookAt(LOOK_HOME);
    renderer.render(scene, camera);
  }

  /**
   * Recolours the shell.
   *
   * Only the outer shell: the driver, the board and the cell are the same parts
   * whatever the finish, and tinting them too is how a configurator starts
   * looking like a colour filter over a photograph.
   */
  function setFinish({ color, metalness, roughness }) {
    shellMat.color.set(color);
    shellMat.metalness = metalness;
    shellMat.roughness = roughness;
  }

  // ---- Shader warm-up ------------------------------------------------------
  // WebGL links a program lazily and the first draw that uses it waits for the
  // driver, on the main thread. Under ANGLE on Windows that driver is the D3D
  // shader compiler, and PMREM's GGX filter is a 256-sample loop it unrolls:
  // the environment cost 704 ms and the first orbit another 716 ms on a
  // discrete GPU, measured as two long tasks while the page was being scrolled.
  // `compileAsync` issues the same compiles through KHR_parallel_shader_compile
  // and polls for completion, so the page keeps drawing while the driver works.

  let preparing = null;
  let disposed = false;

  /**
   * Compiles every program the configurator draws with, without blocking.
   *
   * The PMREM half reaches into the generator's private interface, because
   * `fromScene` creates and uses its materials in one synchronous call and
   * offers no way in between. If a three.js upgrade renames any of it, this
   * falls through to the synchronous path: correct, just stalling.
   */
  function prepare() {
    preparing ??= (async () => {
      if (!scene.environment) {
        try {
          await warmEnvironment();
        } catch (error) {
          console.warn("[stage] environment warm-up skipped:", error);
        }
        if (disposed) return;
        scene.environment = pmrem.fromScene(studio, 0.03).texture;
      }
      // The orbit pose, so the compile sees exactly what `orbit` will draw.
      applyTimeline(0);
      await renderer.compileAsync(scene, camera);
    })();
    return preparing;
  }

  async function warmEnvironment() {
    if (
      typeof pmrem._setSize !== "function" ||
      typeof pmrem._allocateTargets !== "function"
    ) {
      return;
    }
    // Same size `fromScene` defaults to, so it finds the ping-pong target and
    // both filter materials already allocated and reuses them.
    pmrem._setSize(256);
    const target = pmrem._allocateTargets();

    // Program keys depend on the render target — tone mapping and output colour
    // space are both dropped when drawing off-screen — so each compile has to
    // run with a target bound, exactly as the generator will. `compile` reads
    // that state synchronously; only the wait is deferred.
    //
    // The geometry matters too: whether it has a `position` attribute is part
    // of the key. A bare `BufferGeometry` — which is what three's own
    // `_compileMaterial` uses — compiles a program the filter never draws with.
    const filters = new THREE.Scene();
    const plane = pmrem._lodMeshes?.[0]?.geometry;
    for (const material of [pmrem._blurMaterial, pmrem._ggxMaterial]) {
      if (plane && material) filters.add(new THREE.Mesh(plane, material));
    }
    renderer.setRenderTarget(target);
    const pending = [
      renderer.compileAsync(studio, new THREE.PerspectiveCamera(90, 1, 0.1, 100)),
      renderer.compileAsync(filters, new THREE.OrthographicCamera()),
    ];
    renderer.setRenderTarget(null);
    try {
      await Promise.all(pending);
    } finally {
      target.dispose();
    }
  }

  function dispose() {
    disposed = true;
    // `compileAsync` keeps polling its programs on a timer, and a disposed
    // material has none — tearing down mid-compile throws from inside three.
    if (preparing) {
      void preparing.then(release, release);
    } else {
      release();
    }
  }

  function release() {
    pmrem.dispose();
    // `Material.dispose()` releases the program, not the maps hanging off it.
    // Fifteen canvas textures across six parts is around 37 MB of GPU memory,
    // and the configurator builds and tears down this stage on every mount, so
    // leaving them to the collector is a leak that grows by a section visit.
    for (const tex of textures) tex.dispose();
    for (const tree of [scene, studio]) {
      tree.traverse((object) => {
        if (object.isMesh) {
          object.geometry.dispose();
          for (const material of [].concat(object.material)) material.dispose();
        }
      });
    }
    renderer.dispose();
  }

  // ---- Clearance ---------------------------------------------------------
  // The explode is choreography, and choreography can walk a part straight
  // through a wall without anything complaining: the N1 core used to leave
  // through the front of the top shell for about thirty frames of the
  // walkthrough, and nothing but a visitor ever noticed. This is the check that
  // would have. `scripts/check-clearance.mjs` runs it over every frame.

  const ENCLOSURE = ["shellTop", "shellBottom"];
  const INTERNALS = new Set(["driver", "battery", "pcb", "chip"]);
  /** Contact is not a crossing. Under a hundredth of the shell's radius. */
  const CLEARANCE_EPS = 0.01;
  const _sample = new THREE.Vector3();
  const _ta = new THREE.Vector3();
  const _tb = new THREE.Vector3();
  const _tc = new THREE.Vector3();

  /**
   * World-space points spread over every triangle of a mesh, not just its
   * vertices. A board's broad face has vertices only at its rounded edges, and
   * a dome can push through the middle of it without touching any of them.
   */
  function surfaceSamples(mesh, steps = 4) {
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    // An InstancedMesh is one geometry drawn many times; sampled as a plain
    // mesh it is a single unit cube at the board's origin, which would put a
    // phantom part through the shell and hide every real one.
    const transforms = [];
    if (mesh.isInstancedMesh) {
      for (let k = 0; k < mesh.count; k++) {
        const m = new THREE.Matrix4();
        mesh.getMatrixAt(k, m);
        transforms.push(m.premultiply(mesh.matrixWorld));
      }
    } else {
      transforms.push(mesh.matrixWorld);
    }
    const out = [];
    for (const matrix of transforms) {
      for (let i = 0; i < count; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        _ta.fromBufferAttribute(pos, ia);
        _tb.fromBufferAttribute(pos, ib);
        _tc.fromBufferAttribute(pos, ic);
        for (let u = 0; u <= steps; u++) {
          for (let v = 0; v <= steps - u; v++) {
            const w = steps - u - v;
            out.push(
              new THREE.Vector3()
                .addScaledVector(_ta, u / steps)
                .addScaledVector(_tb, v / steps)
                .addScaledVector(_tc, w / steps)
                .applyMatrix4(matrix),
            );
          }
        }
      }
    }
    return out;
  }

  /**
   * Internal parts that cross a shell wall at timeline position `t`.
   *
   * Each half is the solid it would be if its open rim were capped, tested
   * analytically from the same superellipse the lathe was built from. Points
   * on the open side of the rim are not counted either way — leaving through
   * the opening is exactly what a part is supposed to do. A part with samples
   * both inside and outside that solid, on the walled side, is through the
   * wall: every part here is near enough convex that it cannot get from one to
   * the other without crossing it.
   */
  const OUTSIDE = 1;
  const CAVITY = 2;
  const IN_WALL = 3;

  /**
   * Where a point in a half's local space sits against that half: outside it,
   * in its cavity, in the wall between the two surfaces, or (0) beyond the
   * open rim, where it is not counted either way. Tested in the undeformed
   * space, where both surfaces are the same superellipse — the inner one
   * scaled by `WALL`.
   */
  function classify(local, sign) {
    undeformPoint(local);
    const y = local.y * sign;
    if (y < 0) return 0;
    const radial = Math.hypot(local.x, local.z / FLATTEN);
    if (y > H + CLEARANCE_EPS) return OUTSIDE;
    if (radial - profileRadius(R, H, Math.min(y, H)) > CLEARANCE_EPS) return OUTSIDE;
    const yi = y / WALL;
    if (yi < H && radial - WALL * profileRadius(R, H, yi) < -CLEARANCE_EPS) return CAVITY;
    return IN_WALL;
  }

  function clearance(t) {
    applyTimeline(clamp01(t));
    const shells = parts.filter((p) => ENCLOSURE.includes(p.name));
    const crossings = [];
    const test = (name, mesh) => {
      const samples = surfaceSamples(mesh);
      for (const shell of shells) {
        const sign = shell.name === "shellTop" ? 1 : -1;
        let inside = 0;
        let outside = 0;
        let wall = 0;
        for (const point of samples) {
          _sample.copy(point);
          shell.object.worldToLocal(_sample);
          const where = classify(_sample, sign);
          if (where === CAVITY) inside++;
          else if (where === OUTSIDE) outside++;
          else if (where === IN_WALL) wall++;
        }
        // A part in the wall is through it, whatever else it touches.
        if (wall > 0 || (inside > 0 && outside > 0)) {
          crossings.push({ part: name, shell: shell.name, inside, outside, wall });
        }
      }
    };
    for (const part of parts) {
      if (!INTERNALS.has(part.name)) continue;
      part.object.traverse((mesh) => {
        if (mesh.isMesh) test(part.name, mesh);
      });
    }
    test("flex", flex);
    return crossings;
  }

  // ---- X-Ray pair --------------------------------------------------------
  // Both stills come from this one camera and pose. Rendering them from an
  // identical transform is what lets the scanner mask cross-fade between them
  // with zero registration error — doing it by hand in two passes never
  // lines up.
  const XRAY_CAM = new THREE.Vector3(1.56, 1.11, 4.18);
  const XRAY_POSE = { x: -0.34, y: 0.72 };
  const SHELL_PARTS = new Set(["shellTop", "shellBottom", "bezel"]);

  function poseForXray() {
    flowPlane.visible = false;
    ghost.visible = false;
    for (const p of parts) {
      p.object.position.copy(p.object.userData.home);
      p.object.rotation.copy(p.object.userData.homeRot);
    }
    root.rotation.set(XRAY_POSE.x, XRAY_POSE.y, 0);
    root.updateMatrixWorld(true);
    layFlex();
    camera.position.copy(XRAY_CAM);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  }

  function renderXray(mode) {
    poseForXray();
    const hideShell = mode === "inner";
    for (const p of parts) {
      if (SHELL_PARTS.has(p.name)) p.object.visible = !hideShell;
    }
    ghost.visible = hideShell;
    chipMat.emissiveIntensity = hideShell ? 0.75 : 0.05;
    pcbMat.emissiveIntensity = hideShell ? 0.55 : 0.06;
    grilleMat.emissiveIntensity = hideShell ? 0.24 : 0.04;
    renderer.render(scene, camera);
    for (const p of parts) p.object.visible = true;
    ghost.visible = false;
  }

  /**
   * Screen-space anchors for the scanner leader lines, in normalised 0..1
   * coordinates so they survive any output resolution.
   *
   * Projected from the same camera that renders the stills, which means the
   * labels cannot drift out of registration with the artwork — the usual
   * failure mode when hotspots are eyeballed by hand.
   */
  const HOTSPOT_META = {
    mics: {
      title: "MEMS Quad-Mic Array",
      detail: "Active beamforming // 68 dB SNR",
    },
    chip: {
      title: "AURA N1 Neural Core",
      detail: "2.4 GHz // 18 TOPS // 48 MB SRAM",
    },
    battery: {
      title: "Li-Si Cell",
      detail: "78 mAh // 3.85 V nominal",
    },
    driver: {
      title: "10 mm Planar Driver",
      detail: "5 Hz – 40 kHz // copper voice coil",
    },
    pcb: {
      title: "6-Layer Rigid-Flex PCB",
      detail: "0.07 mm stack // impedance matched",
    },
    sensor: {
      title: "Optical Wear Sensor",
      detail: "IR reflectance // 120 Hz sampling",
    },
  };

  function getHotspots() {
    poseForXray();
    const out = [];
    const v = new THREE.Vector3();
    const box = new THREE.Box3();
    for (const p of parts) {
      const meta = HOTSPOT_META[p.name];
      if (!meta) continue;
      p.object.updateMatrixWorld(true);
      // Bounding-box centre, not the object's origin. Several parts are Groups
      // whose transform sits at the world origin with the geometry offset in
      // the children — projecting the origin puts their label dead centre of
      // frame, pointing at nothing.
      box.setFromObject(p.object);
      box.getCenter(v);
      v.project(camera);
      out.push({
        id: p.name,
        x: Number(((v.x + 1) / 2).toFixed(5)),
        y: Number(((1 - v.y) / 2).toFixed(5)),
        title: meta.title,
        detail: meta.detail,
      });
    }
    return out;
  }

  return {
    renderer,
    setSize,
    renderFrame,
    renderXray,
    getHotspots,
    clearance,
    orbit,
    setFinish,
    prepare,
    dispose,
  };
}
