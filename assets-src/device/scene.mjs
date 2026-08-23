/**
 * AURA ONE — procedural device stage.
 *
 * Everything the site renders is built here from primitives: there is no model
 * file, no HDRI and no texture on disk. That is deliberate. It keeps the repo
 * asset-free, makes the render reproducible on any machine, and means the
 * Blender drop-in later only has to match the *output* contract
 * (240 square RGBA frames + two matched stills), not this file.
 *
 * It is also rendered live, by the configurator, which is why the finish and
 * the orbit are operations here rather than something the page does over the
 * top of a picture.
 *
 * The stage exposes to the prerender script:
 *   setSize(w, h)      resize the renderer
 *   renderFrame(t)     draw the scrollytelling timeline at t in 0..1
 *   renderXray(mode)   draw the matched X-Ray pair from one fixed camera
 *
 * …and to the configurator:
 *   orbit(az, el)      look at the assembled device from any direction
 *   setFinish(m)       recolour the shell
 *   dispose()          release the context
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  pcbTraceTexture,
  dieTexture,
  grilleTexture,
  brushedRoughnessTexture,
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
 * Half of the shell as a lathe profile.
 * A superellipse rather than a hemisphere: the flatter shoulder is what makes
 * it read as a designed object instead of a ball.
 */
function shellProfile(radius, halfHeight, sign, steps = 48) {
  const pts = [];
  // A short vertical run at the seam gives the two halves a crisp parting
  // line, which is the whole point of the exploded view.
  pts.push(new THREE.Vector2(radius, 0));
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

function canvasTexture(canvas, repeat = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  // Procedural studio environment. RoomEnvironment gives soft area-light
  // reflections in brushed metal without shipping a single HDRI byte.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(3.4, 4.6, 4.2);
  scene.add(key);

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
  const brushedTex = canvasTexture(brushedRoughnessTexture(42));
  brushedTex.colorSpace = THREE.NoColorSpace; // roughness is data, not colour
  brushedTex.repeat.set(1, 1);

  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x9ca0a8,
    metalness: 0.96,
    roughness: 0.38,
    roughnessMap: brushedTex,
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
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0b0e14,
    metalness: 0.1,
    roughness: 0.07,
  });
  const copperMat = new THREE.MeshStandardMaterial({
    color: 0xb87333,
    metalness: 1,
    roughness: 0.33,
  });
  const cellMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a44,
    metalness: 0.75,
    roughness: 0.42,
  });
  const statusLedMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0c,
    emissive: 0xe4d9c8,
    emissiveIntensity: 1.4,
    roughness: 0.2,
  });

  const pcbTex = canvasTexture(pcbTraceTexture(1337));
  const pcbMat = new THREE.MeshStandardMaterial({
    color: 0x08130f,
    metalness: 0.35,
    roughness: 0.62,
    emissive: 0xffffff,
    emissiveMap: pcbTex,
    emissiveIntensity: 0.55,
  });

  const dieTex = canvasTexture(dieTexture(7));
  const chipMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0e,
    metalness: 0.55,
    roughness: 0.35,
    emissive: 0xffffff,
    emissiveMap: dieTex,
    emissiveIntensity: 0.4,
  });

  const grilleTex = canvasTexture(grilleTexture());
  const grilleMat = new THREE.MeshStandardMaterial({
    color: 0x17171c,
    metalness: 0.8,
    roughness: 0.4,
    emissive: 0xc9c4bb,
    emissiveMap: grilleTex,
    emissiveIntensity: 0.22,
  });

  // ---- Geometry ----------------------------------------------------------
  const R = 1.3;
  const H = 0.9;
  const FLATTEN = 0.54; // squashes the lathe on Z into a pebble

  const root = new THREE.Group();
  scene.add(root);

  /** Every explodable part carries its own direction and travel. */
  const parts = [];
  function addPart(name, object, dir, distance) {
    object.userData.home = object.position.clone();
    parts.push({
      name,
      object,
      dir: new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(),
      distance,
    });
    root.add(object);
    return object;
  }

  /**
   * Places an object flush on the shell surface at (azimuth, height) and aims
   * it outward along the local normal.
   *
   * Doing this analytically rather than by eye is what stops the mic ports and
   * the sensor window from either sinking into the body or floating off it —
   * the surface is a squashed superellipsoid, so intuition about "z = 0.6"
   * is wrong nearly everywhere.
   */
  function seatOnShell(object, azimuth, y, lift = 0.012) {
    const r = profileRadius(R, H, y);
    const sx = Math.sin(azimuth) * r;
    const sz = Math.cos(azimuth) * r * FLATTEN;

    // Gradient of the implicit surface gives the outward normal; the Z term is
    // scaled back up because the geometry was squashed after the fact.
    const nx = sx;
    const nz = sz / (FLATTEN * FLATTEN);
    const ny = (y / (H * H)) * r * 0.55;
    const n = new THREE.Vector3(nx, ny, nz).normalize();

    object.position.set(sx, y, sz).addScaledVector(n, lift);
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    return object;
  }

  // Shell halves. Kept as separate lathes so the exploded view has a real
  // parting line instead of a mesh that magically splits.
  const shellGeoms = [];
  let shellBottom = null;
  for (const sign of [1, -1]) {
    const g = new THREE.LatheGeometry(shellProfile(R, H, sign), 96);
    g.scale(1, 1, FLATTEN);
    shellGeoms.push(g);
    const half = new THREE.Group();
    half.add(new THREE.Mesh(g, shellMat));
    half.add(new THREE.Mesh(g, shellInnerMat)); // visible once split open

    if (sign < 0) {
      // Parting band: a torus squashed onto the equator, poking out by ~0.02.
      // Without it the two halves meet flush and the seam is invisible in the
      // closed pose, which makes the split look like a glitch rather than a
      // reveal.
      const seam = new THREE.Mesh(
        new THREE.TorusGeometry(R - 0.022, 0.036, 14, 128),
        darkMat,
      );
      seam.rotation.x = Math.PI / 2;
      seam.scale.set(1, FLATTEN, 1);
      half.add(seam);
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
    const coarse = new THREE.LatheGeometry(shellProfile(R, H, sign, 7), 20);
    coarse.scale(1, 1, FLATTEN);
    ghost.add(new THREE.Mesh(coarse, wireMat));
  }
  ghost.visible = false;
  root.add(ghost);

  // Acoustic bezel + grille, facing -Z (the ear side).
  const bezel = new THREE.Group();
  bezel.add(
    new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.055, 20, 72), shellMat),
  );
  const grille = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), grilleMat);
  grille.position.z = 0.01;
  bezel.add(grille);
  bezel.position.z = -0.62;
  addPart("bezel", bezel, [0, 0, -1], 1.55);

  // 10 mm planar driver.
  const driver = new THREE.Group();
  driver.add(
    new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.13, 56), darkMat),
  );
  const coil = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.045, 16, 48),
    copperMat,
  );
  coil.rotation.x = Math.PI / 2;
  coil.position.y = 0.02;
  driver.add(coil);
  driver.rotation.x = Math.PI / 2;
  driver.position.z = -0.28;
  addPart("driver", driver, [-0.42, -0.5, -1], 1.35);

  // Li-Si cell with its copper tab.
  const battery = new THREE.Group();
  const cell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.62, 48),
    cellMat,
  );
  cell.rotation.z = Math.PI / 2;
  battery.add(cell);
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.5), copperMat);
  tab.position.x = 0.36;
  battery.add(tab);
  battery.position.set(-0.32, -0.24, 0.1);
  addPart("battery", battery, [-1, 0.32, 0.25], 1.5);

  // Main board.
  const pcb = new THREE.Mesh(
    new RoundedBoxGeometry(1.55, 0.9, 0.07, 3, 0.05),
    pcbMat,
  );
  pcb.position.set(0.1, 0.26, 0.12);
  pcb.rotation.x = -0.12;
  addPart("pcb", pcb, [1, -0.15, 0.3], 1.45);

  // AURA N1 neural core — flies toward the camera so the push-in has somewhere
  // to go without clipping through the rest of the assembly.
  const chip = new THREE.Mesh(
    new RoundedBoxGeometry(0.52, 0.52, 0.09, 2, 0.018),
    chipMat,
  );
  chip.position.set(0.16, 0.3, 0.19);
  chip.rotation.x = -0.12;
  addPart("chip", chip, [0.55, 0.35, 1], 1.75);

  // MEMS quad-mic array, seated on the upper shoulder of the shell.
  const mics = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const port = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, 0.03, 24),
      glassMat,
    );
    port.rotation.x = Math.PI / 2; // cylinder axis onto +Z, then seated
    const holder = new THREE.Group();
    holder.add(port);
    seatOnShell(holder, -0.62 + i * 0.41, 0.46, 0.006);
    mics.add(holder);
  }
  addPart("mics", mics, [0, 1, -0.55], 0.95);

  // Optical wear sensor on the outer face.
  const sensor = new THREE.Group();
  const window_ = new THREE.Mesh(
    new THREE.CylinderGeometry(0.115, 0.115, 0.03, 40),
    glassMat,
  );
  window_.rotation.x = Math.PI / 2;
  sensor.add(window_);
  // A machined bezel around the glass. Without it the window reads as a hole
  // punched in the shell rather than as a component set into it.
  const sensorRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.126, 0.012, 12, 40),
    shellMat,
  );
  sensor.add(sensorRing);
  seatOnShell(sensor, 0.34, -0.3, 0.004);
  addPart("sensor", sensor, [0.7, -0.5, 1], 1.1);

  // Status LED. Reads as nothing at a glance and as a considered detail on a
  // second look, which is exactly what it is for.
  const led = new THREE.Group();
  led.add(new THREE.Mesh(new THREE.CircleGeometry(0.035, 24), statusLedMat));
  seatOnShell(led, -0.28, -0.44, 0.004);
  // Parented to the lower half so it travels with it when the case opens.
  shellBottom.add(led);

  // Data pulses that bloom around the core during the push-in.
  const pulseMat = new THREE.MeshBasicMaterial({
    color: 0x8fe6ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pulses = new THREE.Group();
  const PULSE_COUNT = 16;
  for (let i = 0; i < PULSE_COUNT; i++) {
    pulses.add(new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.16), pulseMat));
  }
  root.add(pulses);

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
  const _local = new THREE.Vector3();

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
    const explode =
      t < PHASES.EXPLODE_END
        ? range(t, PHASES.ROTATE_END, PHASES.EXPLODE_END)
        : t < PHASES.PUSH_END
          ? 1
          : 1 - range(t, PHASES.PUSH_END, 1);
    const push =
      t < PHASES.PUSH_END
        ? range(t, PHASES.HOLD_END, PHASES.PUSH_END)
        : 1 - range(t, PHASES.PUSH_END, 1);

    // A full turn, then a small extra yaw into a 3/4 pose that reads better
    // once the assembly is open.
    root.rotation.y = rot * TAU + explode * 0.42;
    root.rotation.x = explode * -0.17;

    for (const p of parts) {
      const d = p.distance * explode;
      const home = p.object.userData.home;
      p.object.position.set(
        home.x + p.dir.x * d,
        home.y + p.dir.y * d,
        home.z + p.dir.z * d,
      );
    }

    // Silicon wakes up as the camera closes in.
    chipMat.emissiveIntensity = 0.4 + push * 2.3;
    pcbMat.emissiveIntensity = 0.55 + explode * 0.5;

    root.updateMatrixWorld(true);
    chip.getWorldPosition(_chipWorld);

    pulseMat.opacity = push * 0.85;
    pulses.visible = push > 0.001;
    _local.copy(_chipWorld);
    root.worldToLocal(_local);
    pulses.position.copy(_local);
    for (let i = 0; i < PULSE_COUNT; i++) {
      const q = pulses.children[i];
      const a = (i / PULSE_COUNT) * TAU + push * 1.9;
      // Kept just outside the die's half-diagonal (0.37) and inside the frame
      // the camera actually sees at full push-in.
      const r = 0.42 + push * 0.16 + (i % 3) * 0.05;
      q.position.set(Math.cos(a) * r, Math.sin(a) * r * 0.75, 0.14);
      q.rotation.z = a + Math.PI / 2;
      q.scale.setScalar(0.6 + push * 0.9);
    }

    // Pull back as the assembly opens. The silhouette gets roughly 2.4x wider
    // between closed and fully exploded, so the framing has to follow it or
    // the outer parts simply leave the frame — the same move a camera operator
    // would make, and the reason Apple's exploded shots never feel cramped.
    _camBase.copy(CAM_HOME).multiplyScalar(1 + explode * 0.62);

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

  function dispose() {
    pmrem.dispose();
    scene.traverse((object) => {
      if (object.isMesh) {
        object.geometry.dispose();
        for (const material of [].concat(object.material)) material.dispose();
      }
    });
    renderer.dispose();
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
    pulses.visible = false;
    ghost.visible = false;
    for (const p of parts) p.object.position.copy(p.object.userData.home);
    root.rotation.set(XRAY_POSE.x, XRAY_POSE.y, 0);
    root.updateMatrixWorld(true);
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
    chipMat.emissiveIntensity = hideShell ? 1.9 : 0.4;
    pcbMat.emissiveIntensity = hideShell ? 1.35 : 0.55;
    grilleMat.emissiveIntensity = hideShell ? 0.6 : 0.22;
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
    orbit,
    setFinish,
    dispose,
  };
}
