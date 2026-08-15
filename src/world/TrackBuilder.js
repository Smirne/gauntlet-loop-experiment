// world/TrackBuilder.js — track data in, finished geometry out.
//
// Everything here is swept: a set of longitudinal rows (spaced by arc length,
// densified wherever a hazard needs the resolution) crossed with a set of
// lateral columns, evaluated through Track.surfacePoint(). Because that is the
// same function the suspension asks for its ground height, the mesh you see and
// the surface you drive on are the same surface by construction, not by
// agreement.
//
// Three details do most of the visual work:
//
//   * **Normals are analytic.** Every vertex normal comes from finite
//     differences of the surface function in (t, lateral), not from
//     computeVertexNormals(). Faceting disappears over ramps, and the road and
//     its shoulder share exactly the same normal along their shared edge, so
//     there is no lighting crease where they meet.
//   * **UVs are metric.** u = lateral / texScale, v = arcLength / texScale, both
//     in world units. Texel density is therefore constant: the wood grain does
//     not stretch on the outside of a corner or bunch up on the inside, which
//     is the single most common tell of a swept road.
//   * **The road does not sit on the ground, it becomes the ground.** The same
//     grid carries the ribbon out through a cubic-eased shoulder until it is
//     level with the surrounding surface, and the material transition is hidden
//     under the painted edge line and the kerbs.
//
// Draw calls are kept low by building one geometry per material class and
// letting the road's per-surface runs live in groups on a single buffer.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  clamp, lerp, smoothstep, makeRng,
  fbm2DTiled, ridged2DTiled, worley2DTiled, worleyFbm2D, warpFbm2DTiled, value2DTiled,
} from '../core/Random.js';
import { KERB_WIDTH, KERB_HEIGHT, KERB_CURV_MIN, wrap01, cyclicDelta } from './Track.js';
// For tileWorld: the metric size a surface's bake was authored at. See
// metricScaleFor() for why the texture scale is asked for rather than declared.
import { GEN_DEF } from '../textures/ProcTex.js';

/* ------------------------------------------------------------------ tuning */

const ROW_STEP = 3.0;          // longitudinal sample pitch, world units
const HAZARD_ROW_STEP = 0.7;   // densified pitch inside a hazard
const LIP_EPS = 0.05;          // how tightly a ramp's launch edge is bracketed

const EDGE_OVERHANG = 1.2;     // road material continues this far past the nominal edge
const SKIRT_LIFT = 0.06;       // outermost shoulder row floats this far over the ground slab

const ROAD_TEX_SCALE = 62;     // world units per texture repeat on the road
const GROUND_TEX_SCALE = 96;
const KERB_TILE = 11;          // two kerb blocks per repeat
const WALL_TEX_SCALE = 34;

const MARK_ROWS = 8;
const MARK_ROW = {
  edge: 0,
  lane: 1,
  chalk: 2,
  checker: 3,
  tape: 4,
  grid: 5,
  hazard: 6,
  shade: 7,
};
// Narrow (across-the-mark) width and repeat length for each atlas row, in world
// units. Keeping these here means the texture and the geometry cannot disagree.
const MARK_SPEC = {
  edge: { width: 1.5, tile: 7 },
  lane: { width: 1.1, tile: 9 },
  chalk: { width: 1.8, tile: 11 },
  checker: { width: 5.2, tile: 20.8 },
  tape: { width: 6.5, tile: 26 },
  grid: { width: 5.6, tile: 10.5 },
  hazard: { width: 3.2, tile: 12.8 },
  shade: { width: 3.0, tile: 30 },
};

// Deliberately low: a car is 2.8 u tall and the chase camera sits at 48-62
// degrees, so anything much taller than this starts hiding the racing from the
// outside of a corner — which is exactly where the racing is.
const WALL_HEIGHT = 4.2;
const WALL_THICK = 2.4;
const WALL_CURV_MIN = 1 / 150;

/* -------------------------------------------------------------- table edge */
//
// The surrounding surface used to run to the horizon, so nothing in the frame
// ever said "this is a piece of furniture". A tabletop's thickness is a scale
// every viewer knows by hand, which makes the rim worth more to the miniature
// read than anything else this file draws — so the top now stops at a rectangle
// and rolls over a moulded lip into an underside.

const GROUND_N = 129;          // ground grid resolution. The rim samples its
                               // perimeter at exactly these positions, which is
                               // what lets the two meshes weld without a crack.
const TABLE_MARGIN = 58;       // bare surface beyond the outermost thing on it
const TABLE_PROP_ALLOW = 22;   // footprint allowance around a hand-placed prop
// D17. This was 3.4 — "34 mm board", literally correct at 1 u = 1 cm, and
// wrong here, because this project does not draw its table at 1 u = 1 cm.
// The playfield is ~460 x 340 u with 9 u cars standing on it: a table roughly
// 3.3x a real one relative to the toys, which is a deliberate part of the
// premise. render/Sky.js builds the room in that same stretched space and puts
// the floor 250 u down. The two were written in one wave by two agents who
// never compared numbers, and the result was a 3.4 u board floating 250 u up
// on nothing: 1:73 thickness-to-height where a real table is about 1:25.
//
// One scale wins, and it has to be the stretched one, because the room and the
// playfield are both already in it. 10 u of board against a 250 u height is
// 1:25 — a table you would recognise the proportions of.
const TABLE_THICK = 10.0;      // board depth, in the playfield's own scale
const TABLE_LIP_QUADS = 3;     // profile quads carrying the worn-lip material

/* -------------------------------------------------------------------- legs */
// A tabletop with no legs is only invisible while every camera looks down,
// which is true of all three today and is not a property worth depending on.
//
// Sky owns the floor and is the authority on how far down it is; this file
// asks and then reaches it. `_tableFloorDrop` resolves the same way Sky does
// (track.def.tableHeight, else the shared default) so the two cannot disagree
// without the definition saying so explicitly.
const LEG_DROP_DEFAULT = 250;  // matches ROOM.floorDrop in render/Sky.js
const LEG_INSET = 26;          // from the tabletop corner, along both axes
// Sized against the DROP, not picked in absolute units — which is how D17
// happened in the first place. A real table leg is roughly a twelfth of its
// height; the first pass here used 7.4 against a 250 drop, i.e. 1:34, and a
// low camera showed four wires holding up a plank.
const LEG_TOP = 20.0;          // square section under the apron
const LEG_FOOT = 14.0;         // tapered toward the floor
const LEG_SINK = 1.5;          // pushed into the floor so no gap can show

// Which themes stand on furniture. A lawn and a bedroom floor have no edge to
// find — they run to a fence or a skirting board, which is the room's business,
// not this file's. A definition can force the question either way with
// `tableEdge: true|false`.
const EDGED_THEMES = new Set(['kitchen', 'workbench', 'pool']);

// The rim is not always the same material as the top: a pool table is felt on
// top and varnished hardwood at the rail, and that change of material at the
// lip is most of what makes it read as a pool table rather than a green field.
const TABLE_EDGE_SURFACE = { kitchen: 'oak', workbench: 'pine', pool: 'varnishedWood' };

// Cross-section of the moulding, in world units: `o` is outward from the
// tabletop rectangle, `d` is down from its surface. It rolls out to a bullnose
// at a third of the board's depth, tucks back under, and finishes with a hard
// arris at the underside — which is the fold that catches the light and tells
// you how thick the board is.
// Expressed as FRACTIONS OF BOARD THICKNESS, not in world units. It was
// authored in absolute units against a 3.4 u board, so thickening the board
// left the bullnose rolling over in the first third and then dropping straight
// — the moulding deformed instead of scaling. Fractions keep the shape when
// the thickness changes, which it just did.
const TABLE_PROFILE = [
  { o: 0.000, d: 0.000 },
  { o: 0.182, d: -0.021 },
  { o: 0.312, d: -0.129 },
  { o: 0.368, d: -0.309 },
  { o: 0.335, d: -0.506 },
  { o: 0.212, d: -0.741 },
  { o: 0.088, d: -0.912 },
  { o: 0.029, d: -1.000, hard: true },
  { o: -0.353, d: -1.000 },
].map((p) => ({ o: p.o * TABLE_THICK, d: p.d * TABLE_THICK, hard: p.hard }));

/* ------------------------------------------------------------ module scratch */

const _p = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _pd = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _n = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _col = new THREE.Color();
const _uv = new THREE.Vector2();

/* ========================================================================== */
/* Procedural textures                                                        */
/* ========================================================================== */

const _texCache = new Map();

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finishTexture(canvas, { srgb = false, repeat = true, aniso = 16 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Height field -> tangent-space normal map, by central differences. */
function normalFromHeight(height, size, strength, wrapEdges = true) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const idx = (x, y) => {
    const xx = wrapEdges ? ((x % size) + size) % size : clamp(x, 0, size - 1);
    const yy = wrapEdges ? ((y % size) + size) % size : clamp(y, 0, size - 1);
    return yy * size + xx;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hl = height[idx(x - 1, y)];
      const hr = height[idx(x + 1, y)];
      const hd = height[idx(x, y - 1)];
      const hu = height[idx(x, y + 1)];
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l;
      const o = (y * size + x) * 4;
      d[o] = (nx * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * 0.5 + 0.5) * 255;
      d[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Look-up table for the built-in fallback surfaces. This exists so the track is
// never untextured if textures/Surfaces.js is unavailable; when A3's library is
// present its materials win and none of this runs.
const SURFACE_LOOK = {
  varnishedWood: { fam: 'wood', a: [0.40, 0.26, 0.14], b: [0.66, 0.47, 0.27], rough: [0.22, 0.46], bump: 0.7, grain: 7 },
  oak: { fam: 'wood', a: [0.42, 0.30, 0.18], b: [0.70, 0.53, 0.33], rough: [0.40, 0.68], bump: 1.0, grain: 6 },
  pine: { fam: 'wood', a: [0.62, 0.48, 0.30], b: [0.82, 0.68, 0.46], rough: [0.45, 0.72], bump: 1.0, grain: 9 },
  laminate: { fam: 'wood', a: [0.52, 0.40, 0.28], b: [0.74, 0.60, 0.44], rough: [0.20, 0.38], bump: 0.4, grain: 5 },
  concrete: { fam: 'stone', a: [0.44, 0.44, 0.43], b: [0.62, 0.62, 0.60], rough: [0.62, 0.88], bump: 1.1 },
  ceramicTile: { fam: 'stone', a: [0.72, 0.72, 0.70], b: [0.88, 0.88, 0.86], rough: [0.14, 0.30], bump: 0.5 },
  linoleum: { fam: 'stone', a: [0.58, 0.55, 0.48], b: [0.74, 0.71, 0.62], rough: [0.28, 0.46], bump: 0.4 },
  plasticMatte: { fam: 'plastic', a: [0.34, 0.36, 0.40], b: [0.46, 0.48, 0.52], rough: [0.52, 0.68], bump: 0.3 },
  plasticGloss: { fam: 'plastic', a: [0.62, 0.16, 0.14], b: [0.78, 0.26, 0.20], rough: [0.12, 0.26], bump: 0.25 },
  poolFelt: { fam: 'fibre', a: [0.06, 0.30, 0.16], b: [0.12, 0.44, 0.24], rough: [0.78, 0.94], bump: 0.8 },
  carpet: { fam: 'fibre', a: [0.30, 0.26, 0.24], b: [0.46, 0.41, 0.38], rough: [0.80, 0.96], bump: 1.4 },
  rug: { fam: 'fibre', a: [0.38, 0.20, 0.18], b: [0.60, 0.38, 0.32], rough: [0.78, 0.94], bump: 1.5 },
  grass: { fam: 'grass', a: [0.14, 0.30, 0.10], b: [0.34, 0.54, 0.18], rough: [0.70, 0.92], bump: 1.6 },
  soil: { fam: 'granular', a: [0.20, 0.14, 0.10], b: [0.36, 0.26, 0.18], rough: [0.78, 0.95], bump: 1.5 },
  sand: { fam: 'granular', a: [0.62, 0.53, 0.36], b: [0.82, 0.73, 0.54], rough: [0.72, 0.90], bump: 1.2 },
  gravel: { fam: 'granular', a: [0.32, 0.31, 0.30], b: [0.56, 0.55, 0.52], rough: [0.72, 0.94], bump: 1.9 },
  sawdust: { fam: 'granular', a: [0.60, 0.50, 0.34], b: [0.80, 0.71, 0.52], rough: [0.80, 0.96], bump: 1.3 },
  crumbs: { fam: 'granular', a: [0.52, 0.40, 0.24], b: [0.76, 0.62, 0.40], rough: [0.66, 0.90], bump: 1.6 },
  brushedAluminium: { fam: 'metal', a: [0.52, 0.53, 0.55], b: [0.72, 0.73, 0.76], rough: [0.24, 0.42], bump: 0.5 },
  galvanisedSteel: { fam: 'metal', a: [0.46, 0.47, 0.50], b: [0.64, 0.66, 0.70], rough: [0.32, 0.54], bump: 0.6 },
  cardboard: { fam: 'stone', a: [0.48, 0.36, 0.24], b: [0.64, 0.50, 0.34], rough: [0.72, 0.90], bump: 0.7 },
  paper: { fam: 'stone', a: [0.80, 0.79, 0.75], b: [0.92, 0.91, 0.88], rough: [0.62, 0.80], bump: 0.3 },
};

const DEFAULT_LOOK = { fam: 'stone', a: [0.40, 0.40, 0.40], b: [0.58, 0.58, 0.58], rough: [0.55, 0.80], bump: 0.8 };

/**
 * Fallback PBR set for a named surface: albedo, normal and roughness derived
 * from one shared height field so they agree with each other.
 */
function generateSurfaceMaps(kind, size, seed) {
  const key = `surf:${kind}:${size}:${seed}`;
  const hit = _texCache.get(key);
  if (hit) return hit;

  const look = SURFACE_LOOK[kind] || DEFAULT_LOOK;
  const P = 8; // noise period in cells — the texture tiles exactly on this
  const height = new Float32Array(size * size);
  const albedo = makeCanvas(size, size);
  const actx = albedo.getContext('2d');
  const aimg = actx.createImageData(size, size);
  const ad = aimg.data;
  const rough = makeCanvas(size, size);
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size);
  const rd = rimg.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fx = (x / size) * P;
      const fy = (y / size) * P;
      let h = 0;
      let mix = 0;

      switch (look.fam) {
        case 'wood': {
          // Rings from a warped, stretched coordinate, plus fine pore ridges.
          const warp = warpFbm2DTiled(fx * 0.6, fy * 0.6, P, 0.55, 3, 2, 0.5, seed) * 0.9;
          const rings = Math.abs(Math.sin((fy * look.grain + warp * 2.2) * Math.PI));
          const pores = ridged2DTiled(fx * 5, fy * 26, P, 3, 2, 0.5, seed + 11, 3);
          h = rings * 0.6 + pores * 0.4;
          mix = clamp(rings * 0.75 + pores * 0.3, 0, 1);
          break;
        }
        case 'fibre': {
          const nap = worleyFbm2D(fx * 14, fy * 14, 2, 2, 0.5, seed, P);
          const fuzz = fbm2DTiled(fx * 22, fy * 22, P, 3, 2.2, 0.55, seed + 3);
          h = nap * 0.7 + fuzz * 0.3;
          mix = clamp(0.35 + nap * 0.6 + fuzz * 0.25, 0, 1);
          break;
        }
        case 'grass': {
          const blades = ridged2DTiled(fx * 30, fy * 30, P, 3, 2, 0.5, seed, 3);
          const patch = fbm2DTiled(fx * 2.2, fy * 2.2, P, 4, 2, 0.5, seed + 7);
          h = blades * 0.8 + patch * 0.2;
          mix = clamp(0.3 + blades * 0.55 + patch * 0.5, 0, 1);
          break;
        }
        case 'granular': {
          const grains = 1 - worley2DTiled(fx * 26, fy * 26, P, seed);
          const clumps = worleyFbm2D(fx * 7, fy * 7, 3, 2, 0.5, seed + 5, P);
          h = grains * 0.65 + clumps * 0.35;
          mix = clamp(grains * 0.8 + clumps * 0.4, 0, 1);
          break;
        }
        case 'metal': {
          const brush = fbm2DTiled(fx * 3, fy * 90, P, 3, 2, 0.5, seed) * 0.5 + 0.5;
          const swirl = ridged2DTiled(fx * 6, fy * 40, P, 2, 2, 0.5, seed + 2, 2);
          h = brush * 0.7 + swirl * 0.3;
          mix = clamp(brush * 0.9 + swirl * 0.2, 0, 1);
          break;
        }
        case 'plastic': {
          const peel = fbm2DTiled(fx * 12, fy * 12, P, 3, 2.3, 0.5, seed) * 0.5 + 0.5;
          const flow = warpFbm2DTiled(fx * 2, fy * 2, P, 0.4, 3, 2, 0.5, seed + 9) * 0.5 + 0.5;
          h = peel * 0.8 + flow * 0.2;
          mix = clamp(0.4 + flow * 0.4, 0, 1);
          break;
        }
        default: {
          const base = fbm2DTiled(fx * 5, fy * 5, P, 4, 2, 0.5, seed) * 0.5 + 0.5;
          const speck = 1 - worley2DTiled(fx * 20, fy * 20, P, seed + 4);
          h = base * 0.7 + speck * 0.3;
          mix = clamp(base * 0.85 + speck * 0.35, 0, 1);
        }
      }

      // Large-scale tonal drift so the eye never latches onto a repeat.
      const drift = value2DTiled(fx * 0.55, fy * 0.55, P, seed + 31) * 0.16 - 0.08;
      height[i] = h;

      const o = i * 4;
      const m = clamp(mix + drift, 0, 1);
      ad[o] = clamp(lerp(look.a[0], look.b[0], m) + drift * 0.4, 0, 1) * 255;
      ad[o + 1] = clamp(lerp(look.a[1], look.b[1], m) + drift * 0.4, 0, 1) * 255;
      ad[o + 2] = clamp(lerp(look.a[2], look.b[2], m) + drift * 0.4, 0, 1) * 255;
      ad[o + 3] = 255;

      // Roughness anti-correlates with height on hard surfaces (the high spots
      // are polished by contact) and correlates on soft ones.
      const rv = look.fam === 'fibre' || look.fam === 'grass' || look.fam === 'granular'
        ? lerp(look.rough[0], look.rough[1], m)
        : lerp(look.rough[1], look.rough[0], m);
      const rq = clamp(rv + drift * 0.5, 0, 1) * 255;
      rd[o] = rq;
      rd[o + 1] = rq;
      rd[o + 2] = rq;
      rd[o + 3] = 255;
    }
  }

  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  const normalCanvas = normalFromHeight(height, size, look.bump * size * 0.012);

  const set = {
    map: finishTexture(albedo, { srgb: true }),
    normalMap: finishTexture(normalCanvas),
    roughnessMap: finishTexture(rough),
  };
  _texCache.set(key, set);
  return set;
}

/** Alternating painted kerb: bevel shading, chipped paint, tyre scuffs. */
function generateKerbTextures(size, seed) {
  const key = `kerb:${size}:${seed}`;
  const hit = _texCache.get(key);
  if (hit) return hit;

  const rng = makeRng((seed ^ 0x4b3c91) >>> 0);
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const half = size / 2;

  // Two blocks stacked along v; u runs across the kerb profile.
  const colours = [['#c8281e', '#93150f'], ['#f2efe6', '#cdc7ba']];
  for (let b = 0; b < 2; b++) {
    const grad = g.createLinearGradient(0, 0, size, 0);
    grad.addColorStop(0, colours[b][1]);
    grad.addColorStop(0.22, colours[b][0]);
    grad.addColorStop(0.72, colours[b][0]);
    grad.addColorStop(1, colours[b][1]);
    g.fillStyle = grad;
    g.fillRect(0, b * half, size, half);
  }
  // Soft joint between blocks — moulded plastic, not printed stripes.
  g.globalAlpha = 0.5;
  g.fillStyle = '#241f1c';
  g.fillRect(0, half - 2, size, 4);
  g.fillRect(0, size - 2, size, 4);
  g.fillRect(0, 0, size, 2);
  g.globalAlpha = 1;

  // Tyre scuffs and chipped paint.
  for (let i = 0; i < 220; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const w = rng.range(3, 34);
    const h = rng.range(1.2, 4);
    g.globalAlpha = rng.range(0.05, 0.24);
    g.fillStyle = rng.bool(0.6) ? '#1c1a19' : '#6d6660';
    g.beginPath();
    g.ellipse(x, y, w, h, rng.range(-0.2, 0.2), 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 90; i++) {
    g.globalAlpha = rng.range(0.15, 0.45);
    g.fillStyle = '#8e857c';
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    g.fillRect(x, y, rng.range(1, 5), rng.range(1, 4));
  }
  g.globalAlpha = 1;

  // Height: the moulded bevel across u plus scuff relief.
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const bevel = smoothstep(0, 0.16, u) * (1 - smoothstep(0.84, 1, u));
      const joint = 1 - Math.exp(-Math.pow(((y % half) - 0) / 6, 2)) * 0.9;
      const grit = fbm2DTiled((x / size) * 6, (y / size) * 6, 6, 3, 2, 0.5, seed) * 0.12;
      height[y * size + x] = bevel * 0.8 * joint + grit;
    }
  }

  const rc = makeCanvas(size, size);
  const rg = rc.getContext('2d');
  const rimg = rg.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    // Painted plastic: fairly smooth, rougher where it has been scrubbed.
    const v = clamp(0.26 + (1 - height[i]) * 0.34, 0, 1) * 255;
    rimg.data[i * 4] = v;
    rimg.data[i * 4 + 1] = v;
    rimg.data[i * 4 + 2] = v;
    rimg.data[i * 4 + 3] = 255;
  }
  rg.putImageData(rimg, 0, 0);

  const set = {
    map: finishTexture(c, { srgb: true }),
    normalMap: finishTexture(normalFromHeight(height, size, size * 0.006)),
    roughnessMap: finishTexture(rc),
  };
  _texCache.set(key, set);
  return set;
}

/**
 * One atlas for every painted or chalked mark on the track. Rows tile
 * horizontally (along the mark) and are clamped vertically (across it), so a
 * single material and a single draw call covers edge lines, lane chalk, the
 * start checker, gaffa tape, grid boxes and hazard stripes.
 */
function generateMarkingsAtlas(size, seed) {
  const key = `marks:${size}:${seed}`;
  const hit = _texCache.get(key);
  if (hit) return hit;

  const rng = makeRng(seed ^ 0x9f1c);
  const rowH = size / MARK_ROWS;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);

  const rowTop = (r) => r * rowH;

  // --- 0: solid edge line, feathered and worn --------------------------------
  {
    const y = rowTop(MARK_ROW.edge);
    const grad = g.createLinearGradient(0, y, 0, y + rowH);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.16, 'rgba(246,244,238,0.96)');
    grad.addColorStop(0.84, 'rgba(246,244,238,0.96)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, y, size, rowH);
    wearPass(g, rng, 0, y, size, rowH, 150, 0.5);
  }

  // --- 1: dashed lane line ---------------------------------------------------
  {
    const y = rowTop(MARK_ROW.lane);
    const dash = size * 0.56;
    const grad = g.createLinearGradient(0, y, 0, y + rowH);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.2, 'rgba(244,238,214,0.94)');
    grad.addColorStop(0.8, 'rgba(244,238,214,0.94)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, y, dash, rowH);
    wearPass(g, rng, 0, y, dash, rowH, 90, 0.55);
  }

  // --- 2: chalk stroke — dusty, broken, hand-drawn ---------------------------
  {
    const y = rowTop(MARK_ROW.chalk);
    const dash = size * 0.62;
    for (let i = 0; i < 900; i++) {
      const x = rng.range(0, dash);
      const cy = y + rowH * 0.5 + rng.gauss(0, rowH * 0.16);
      const r = rng.range(0.6, 2.4);
      const falloff = 1 - Math.abs(cy - (y + rowH * 0.5)) / (rowH * 0.55);
      g.globalAlpha = clamp(rng.range(0.05, 0.5) * falloff, 0, 1);
      g.fillStyle = '#f6f3ec';
      g.beginPath();
      g.arc(x, cy, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // --- 3: start/finish checker ----------------------------------------------
  {
    const y = rowTop(MARK_ROW.checker);
    const cells = 8;
    const cw = size / cells;
    const ch = rowH / 2;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < 2; j++) {
        const on = (i + j) % 2 === 0;
        g.fillStyle = on ? 'rgba(248,247,243,0.97)' : 'rgba(24,22,21,0.95)';
        g.fillRect(i * cw, y + j * ch, cw + 0.5, ch + 0.5);
      }
    }
    wearPass(g, rng, 0, y, size, rowH, 200, 0.4);
  }

  // --- 4: gaffa tape — matte, torn edges, fingerprints ----------------------
  {
    const y = rowTop(MARK_ROW.tape);
    g.fillStyle = 'rgba(38,38,40,0.98)';
    g.fillRect(0, y + rowH * 0.08, size, rowH * 0.84);
    // torn edges
    g.globalCompositeOperation = 'destination-out';
    for (let x = 0; x < size; x += 3) {
      const t0 = rng.range(0, rowH * 0.06);
      const t1 = rng.range(0, rowH * 0.06);
      g.fillStyle = '#000';
      g.fillRect(x, y + rowH * 0.08, 4, t0);
      g.fillRect(x, y + rowH * 0.92 - t1, 4, t1);
    }
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 130; i++) {
      g.globalAlpha = rng.range(0.04, 0.14);
      g.fillStyle = rng.bool(0.5) ? '#7e7e84' : '#101012';
      g.beginPath();
      g.ellipse(rng.range(0, size), y + rng.range(rowH * 0.1, rowH * 0.9), rng.range(4, 26), rng.range(1, 5), 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // --- 5: grid box outline (drawn once per slot, u stays inside 0..1) --------
  {
    const y = rowTop(MARK_ROW.grid);
    const inset = size * 0.02;
    g.strokeStyle = 'rgba(246,244,238,0.92)';
    g.lineWidth = Math.max(3, rowH * 0.09);
    g.strokeRect(inset, y + rowH * 0.12, size - inset * 2, rowH * 0.76);
    // Direction chevron inside the box.
    g.fillStyle = 'rgba(246,244,238,0.55)';
    const cx = size * 0.5;
    const cy = y + rowH * 0.5;
    g.beginPath();
    g.moveTo(cx + rowH * 0.34, cy);
    g.lineTo(cx - rowH * 0.1, cy - rowH * 0.26);
    g.lineTo(cx - rowH * 0.02, cy);
    g.lineTo(cx - rowH * 0.1, cy + rowH * 0.26);
    g.closePath();
    g.fill();
    wearPass(g, rng, 0, y, size, rowH, 70, 0.5);
  }

  // --- 6: hazard stripes, laid down before a ramp or a gap ------------------
  {
    const y = rowTop(MARK_ROW.hazard);
    const stripe = rowH * 0.9;
    g.save();
    g.beginPath();
    g.rect(0, y + rowH * 0.1, size, rowH * 0.8);
    g.clip();
    g.fillStyle = 'rgba(226,176,26,0.96)';
    g.fillRect(0, y, size, rowH);
    g.fillStyle = 'rgba(26,24,22,0.95)';
    for (let x = -rowH; x < size + rowH; x += stripe * 2) {
      g.beginPath();
      g.moveTo(x, y + rowH);
      g.lineTo(x + stripe, y + rowH);
      g.lineTo(x + stripe + rowH, y);
      g.lineTo(x + rowH, y);
      g.closePath();
      g.fill();
    }
    g.restore();
    wearPass(g, rng, 0, y, size, rowH, 160, 0.45);
  }

  // --- 7: soft contact shade, laid at the foot of walls and kerbs -----------
  {
    const y = rowTop(MARK_ROW.shade);
    const grad = g.createLinearGradient(0, y, 0, y + rowH);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0.20)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, y, size, rowH);
  }

  const map = finishTexture(c, { srgb: true });
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;

  // Paint sits proud of the road and is smoother than it; chalk is the exact
  // opposite. A per-row roughness is what makes a painted line catch a
  // highlight the wood does not, while the chalk stays dead matte beside it.
  const ROW_ROUGH = [0.30, 0.32, 0.94, 0.28, 0.60, 0.32, 0.30, 0.88];
  const rc = makeCanvas(size, size);
  const rg = rc.getContext('2d');
  for (let r = 0; r < MARK_ROWS; r++) {
    const v = Math.round(ROW_ROUGH[r] * 255);
    rg.fillStyle = `rgb(${v},${v},${v})`;
    rg.fillRect(0, r * rowH, size, rowH);
  }

  const set = { map, roughnessMap: finishTexture(rc) };
  set.roughnessMap.wrapT = THREE.ClampToEdgeWrapping;
  _texCache.set(key, set);
  return set;
}

/** Scatter translucent scuffs over a rect — the difference between paint and a decal. */
function wearPass(g, rng, x0, y0, w, h, count, strength) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < count; i++) {
    g.globalAlpha = rng.range(0.05, 0.35) * strength;
    g.fillStyle = '#000';
    g.beginPath();
    g.ellipse(x0 + rng.range(0, w), y0 + rng.range(0, h), rng.range(2, 18), rng.range(1, 4), rng.range(-0.3, 0.3), 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  g.globalAlpha = 1;
}

/** Wet patch: dark, glossy, with a rippled normal and a soft rim. */
function generateFluidTextures(kind, size, seed) {
  const key = `fluid:${kind}:${size}:${seed}`;
  const hit = _texCache.get(key);
  if (hit) return hit;

  const oil = kind === 'oil';
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const height = new Float32Array(size * size);
  const P = 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fx = (x / size) * P;
      const fy = (y / size) * P;
      const swirl = warpFbm2DTiled(fx * 1.6, fy * 1.6, P, 0.9, 4, 2, 0.5, seed) * 0.5 + 0.5;
      const ripple = fbm2DTiled(fx * 9, fy * 9, P, 3, 2, 0.5, seed + 3) * 0.5 + 0.5;
      height[i] = ripple * 0.6 + swirl * 0.4;
      const o = i * 4;
      if (oil) {
        // Iridescent film over near-black: hue shifts with film thickness.
        // Asked for in sRGB explicitly — the canvas this lands in is tagged
        // sRGB, and the working colour space is linear.
        const t = swirl;
        _col.setHSL(lerp(0.55, 0.92, t), 0.55, 0.10 + ripple * 0.06, THREE.SRGBColorSpace);
        d[o] = _col.r * 255;
        d[o + 1] = _col.g * 255;
        d[o + 2] = _col.b * 255;
      } else {
        const t = swirl * 0.6 + ripple * 0.4;
        d[o] = lerp(18, 46, t);
        d[o + 1] = lerp(26, 58, t);
        d[o + 2] = lerp(34, 70, t);
      }
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const set = {
    map: finishTexture(c, { srgb: true }),
    normalMap: finishTexture(normalFromHeight(height, size, size * 0.004)),
  };
  _texCache.set(key, set);
  return set;
}

/* ========================================================================== */
/* Geometry helpers                                                           */
/* ========================================================================== */

/**
 * Swept grid builder. Callbacks fill preallocated scratch, so nothing is
 * allocated per vertex beyond the final buffers.
 */
function sweep(rows, cols, opts) {
  const { position, normal, uv, color, quadGroup, quadSkip } = opts;
  const count = rows * cols;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colr = color ? new Float32Array(count * 3) : null;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const k = i * cols + j;
      position(i, j, _p);
      pos[k * 3] = _p.x;
      pos[k * 3 + 1] = _p.y;
      pos[k * 3 + 2] = _p.z;
      normal(i, j, _n);
      nor[k * 3] = _n.x;
      nor[k * 3 + 1] = _n.y;
      nor[k * 3 + 2] = _n.z;
      const t = uv(i, j);
      uvs[k * 2] = t.x;
      uvs[k * 2 + 1] = t.y;
      if (colr) {
        color(i, j, _col);
        colr[k * 3] = _col.r;
        colr[k * 3 + 1] = _col.g;
        colr[k * 3 + 2] = _col.b;
      }
    }
  }

  // Quads bucketed by group so the final index is contiguous per material.
  const buckets = new Map();
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      if (quadSkip && quadSkip(i, j)) continue;
      const gid = quadGroup ? quadGroup(i, j) : 0;
      if (gid < 0) continue;
      let arr = buckets.get(gid);
      if (!arr) { arr = []; buckets.set(gid, arr); }
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      // (a, c, b) + (a, d, c) faces +Y when j increases to the right and i
      // increases forward.
      arr.push(a, c, b, a, d, c);
    }
  }

  let total = 0;
  for (const arr of buckets.values()) total += arr.length;
  const index = count > 65535 ? new Uint32Array(total) : new Uint16Array(total);
  const groups = [];
  let w = 0;
  const ids = [...buckets.keys()].sort((x, y) => x - y);
  for (const gid of ids) {
    const arr = buckets.get(gid);
    groups.push({ start: w, count: arr.length, materialIndex: gid });
    for (let i = 0; i < arr.length; i++) index[w++] = arr[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colr) geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
  return geo;
}

/**
 * Expand a 2D cross-section into swept columns, duplicating vertices at hard
 * edges so a chamfer stays a chamfer instead of being smoothed away.
 * @param {Array<{lat:number, y:number, hard?:boolean}>} pts ordered by lateral
 * @returns {{lat:Float64Array, y:Float64Array, u:Float64Array, nl:Float64Array, nu:Float64Array}}
 */
function expandProfile(pts) {
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dl = pts[i + 1].lat - pts[i].lat;
    const dy = pts[i + 1].y - pts[i].y;
    const l = Math.hypot(dl, dy) || 1;
    seg.push({ nl: -dy / l, nu: dl / l, len: l });
  }

  const lat = [];
  const y = [];
  const nl = [];
  const nu = [];
  const arc = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = seg[i - 1];
    const next = seg[i];
    if (i > 0) acc += seg[i - 1].len;
    if (prev && next && pts[i].hard) {
      lat.push(pts[i].lat, pts[i].lat);
      y.push(pts[i].y, pts[i].y);
      nl.push(prev.nl, next.nl);
      nu.push(prev.nu, next.nu);
      arc.push(acc, acc);
    } else {
      let a = 0;
      let b = 0;
      if (prev) { a += prev.nl; b += prev.nu; }
      if (next) { a += next.nl; b += next.nu; }
      const l = Math.hypot(a, b) || 1;
      lat.push(pts[i].lat);
      y.push(pts[i].y);
      nl.push(a / l);
      nu.push(b / l);
      arc.push(acc);
    }
  }
  const total = acc || 1;
  return {
    lat: Float64Array.from(lat),
    y: Float64Array.from(y),
    u: Float64Array.from(arc.map((v) => v / total)),
    nl: Float64Array.from(nl),
    nu: Float64Array.from(nu),
    count: lat.length,
  };
}

/**
 * Distance to offset a perimeter sample by, given the sample's miter scale.
 *
 * Outward offsets take the miter unconditionally, which is what makes a
 * moulding meet itself cleanly at a corner. Inward ones are capped: a mitred
 * corner pulled inward travels along *both* of its sides as well as across
 * them, so once it passes the sample spacing it overtakes its own neighbours
 * and the ring doubles back over itself — an inverted triangle at every corner.
 * Measured at 2.09 u of overlap per corner on the kitchen table before the cap.
 */
function ringOffset(r, o) {
  if (o >= 0) return o * r.miter;
  return -Math.min(-o * r.miter, r.maxIn ?? Infinity);
}

/** Add a uv1 channel (three's aoMap reads channel 1) and clean up. */
function finaliseGeometry(geo, { tangents = true } = {}) {
  if (!geo) return geo;
  const uv = geo.getAttribute('uv');
  if (uv && !geo.getAttribute('uv1')) {
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv.array, uv.itemSize));
  }
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  if (tangents && geo.getIndex() && geo.getAttribute('normal') && uv) {
    try {
      geo.computeTangents();
    } catch (err) {
      /* tangents are an optimisation for normal mapping, never a requirement */
    }
  }
  return geo;
}

/* ========================================================================== */
/* TrackBuilder                                                               */
/* ========================================================================== */

export class TrackBuilder {
  name = 'trackBuilder';

  constructor(track, ctx = {}) {
    this.track = track;
    this.ctx = ctx;
    this.group = track.group || new THREE.Group();
    this.rng = makeRng((track.seed ?? 1337) ^ 0x7a1c);
    this.meshes = [];
    this.ownedMaterials = [];
    this.ownedTextures = [];
    this.time = 0;

    const quality = ctx?.settings?.quality || 'high';
    this.texSize = quality === 'low' ? 256 : quality === 'medium' ? 512 : 512;
    this.markSize = quality === 'low' ? 512 : 1024;
  }

  /* ------------------------------------------------------------------ build */

  async build() {
    const t0 = now();

    // The first three are prerequisites; if any of them fails there is nothing
    // to build and the caller's guard handles it. Everything after is staged
    // individually, because losing the walls is a bad afternoon and losing the
    // road is a black screen.
    this.buildRows();
    this.buildKerbAmounts();
    this.resolveMaterials();

    this.stage('ground', () => this.buildGround());
    this.stage('tableEdge', () => this.buildTableEdge());
    this.stage('tableLegs', () => this.buildTableLegs());
    this.stage('road', () => this.buildRoad());
    this.stage('kerbs', () => this.buildKerbs());
    this.stage('markings', () => this.buildMarkings());
    this.stage('walls', () => this.buildWalls());
    this.stage('hazards', () => this.buildHazardMeshes());

    this.buildMs = now() - t0;
    return this.group;
  }

  stage(name, fn) {
    try {
      fn();
    } catch (err) {
      console.warn(`[TrackBuilder] "${name}" stage failed:`, err);
      (this.failedStages || (this.failedStages = [])).push(name);
    }
  }

  /* ------------------------------------------------------------------- rows */

  /**
   * Longitudinal sample positions. Uniform by arc length, densified inside
   * every hazard, and bracketed tightly either side of a ramp's launch edge so
   * the lip is a crisp fold rather than a ramp back down.
   */
  buildRows() {
    const track = this.track;
    const L = track.length;
    const base = Math.max(64, Math.round(L / ROW_STEP));
    const ts = [];
    for (let i = 0; i < base; i++) ts.push(i / base);

    const eps = LIP_EPS / L;
    for (const h of track.hazards) {
      if (h.type === 'fan') continue;
      const span = h.halfSpanT * 2;
      const n = Math.max(4, Math.ceil(h.length / HAZARD_ROW_STEP));
      for (let k = 0; k <= n; k++) ts.push(wrap01(h.t0 + (k / n) * span));
      if (h.type === 'ramp') {
        ts.push(wrap01(h.t1 - eps), wrap01(h.t1 + eps));
      } else if (h.type === 'gap') {
        ts.push(wrap01(h.t0 - eps), wrap01(h.t0 + eps), wrap01(h.t1 - eps), wrap01(h.t1 + eps));
      }
      // A little run-up either side keeps the approach mesh dense enough for
      // the hazard stripes painted in front of it.
      for (let k = 1; k <= 6; k++) {
        ts.push(wrap01(h.t0 - (k * 2) / L), wrap01(h.t1 + (k * 2) / L));
      }
    }

    ts.sort((a, b) => a - b);
    const minGap = 0.02 / L;
    const rowT = [];
    for (let i = 0; i < ts.length; i++) {
      if (i === 0 || ts[i] - ts[i - 1] > minGap) rowT.push(ts[i]);
    }
    if (rowT.length && 1 - rowT[rowT.length - 1] < minGap) rowT.pop();

    // The closing row repeats the first geometrically but carries v = length,
    // so the texture runs continuously around the lap.
    this.rowT = Float64Array.from(rowT);
    this.rowCount = rowT.length + 1;
    this.rowS = new Float64Array(this.rowCount);
    for (let i = 0; i < rowT.length; i++) this.rowS[i] = rowT[i] * L;
    this.rowS[this.rowCount - 1] = L;
  }

  rowTAt(i) {
    return i < this.rowT.length ? this.rowT[i] : this.rowT[0];
  }

  /**
   * Nudge a longitudinal repeat length so a whole number of repeats fits the
   * lap. Without this every texture that runs the length of the circuit —
   * road grain, kerb blocks, the dashed lane line — meets itself mid-pattern at
   * the start/finish line and leaves a seam right where the camera starts.
   * The correction is under half a percent, which is invisible; the seam is not.
   */
  fitToLap(scale) {
    const L = this.track.length;
    const n = Math.max(1, Math.round(L / scale));
    return L / n;
  }

  /* ------------------------------------------------------------------ kerbs */

  /**
   * How much kerb, if any, each side of each row gets. Driven by curvature and
   * then smoothed, which is what produces the natural taper into and out of a
   * corner instead of a kerb that starts and stops abruptly.
   */
  buildKerbAmounts() {
    const track = this.track;
    const n = this.rowT.length;
    const inner = new Float32Array(n);
    const outer = new Float32Array(n);
    const side = new Int8Array(n);

    for (let i = 0; i < n; i++) {
      const k = track.curvatureAt(this.rowT[i]);
      const a = Math.abs(k);
      // Inside of the corner is where the apex kerb goes; positive curvature
      // turns left, so the inside is the left (negative lateral) side.
      side[i] = k >= 0 ? -1 : 1;
      inner[i] = smoothstep(KERB_CURV_MIN * 0.75, KERB_CURV_MIN * 1.7, a);
      outer[i] = smoothstep(KERB_CURV_MIN * 1.5, KERB_CURV_MIN * 3.0, a);
    }

    const smooth = (arr, passes) => {
      const tmp = new Float32Array(arr.length);
      for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
          const a = arr[(i - 1 + arr.length) % arr.length];
          const b = arr[i];
          const c = arr[(i + 1) % arr.length];
          tmp[i] = (a + 2 * b + c) * 0.25;
        }
        arr.set(tmp);
      }
    };
    smooth(inner, 10);
    smooth(outer, 10);

    // Resolve into a per-side amount: whichever role each side plays here.
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (side[i] < 0) { left[i] = inner[i]; right[i] = outer[i]; }
      else { right[i] = inner[i]; left[i] = outer[i]; }
    }
    smooth(left, 3);
    smooth(right, 3);
    this.kerbAmount = { left, right };
  }

  kerbAt(sideSign, i) {
    const arr = sideSign < 0 ? this.kerbAmount.left : this.kerbAmount.right;
    return arr[i % arr.length];
  }

  /* -------------------------------------------------------------- materials */

  /**
   * Prefer render/Materials.js, then textures/ProcTex.js, then the local
   * fallback generators. Materials from the shared factory are cloned before
   * being modified: they are cached and shared with the rest of the game, and
   * enabling vertexColors on someone else's material is a nasty bug to find.
   */
  resolveMaterials() {
    const track = this.track;
    this.matCache = new Map();
    this.roadMaterials = track.surfaceNames.map((s) => this.surfaceMaterial(s, {
      vertexColors: true,
      texScale: this.metricScaleFor(s, ROAD_TEX_SCALE),
    }));
    // The shoulder is off-track terrain, so it uses whatever surfaceAt() reports
    // out there — grip, particles and pixels then all agree about what the car
    // just put two wheels on.
    this.offMaterial = this.surfaceMaterial(track.offTrackSurface, {
      vertexColors: true,
      texScale: this.metricScaleFor(track.offTrackSurface, GROUND_TEX_SCALE),
    });
    // The slab beyond the shoulder defaults to the same surface as the shoulder
    // so the two are literally one material, and there is no line in the world
    // where the verge stops being the verge. A definition can still override it.
    const groundKind = track.def.groundSurface || track.offTrackSurface;
    this.groundMaterial = this.surfaceMaterial(groundKind, {
      vertexColors: true,
      texScale: this.metricScaleFor(groundKind, GROUND_TEX_SCALE),
    });
    this.wallMaterial = this.surfaceMaterial(track.themeSurfaces.wall || 'plasticMatte', {
      vertexColors: true,
      texScale: WALL_TEX_SCALE,
    });

    const kerbTex = generateKerbTextures(this.texSize, track.seed);
    this.kerbMaterial = new THREE.MeshStandardMaterial({
      map: kerbTex.map,
      normalMap: kerbTex.normalMap,
      roughnessMap: kerbTex.roughnessMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      name: 'track:kerb',
    });
    this.ownedMaterials.push(this.kerbMaterial);

    const marks = generateMarkingsAtlas(this.markSize, track.seed);
    this.markMaterial = new THREE.MeshStandardMaterial({
      map: marks.map,
      roughnessMap: marks.roughnessMap,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      name: 'track:markings',
    });
    this.ownedMaterials.push(this.markMaterial);

    this.pitMaterial = this.surfaceMaterial('cardboard', { texScale: 40, vertexColors: true, tag: 'pit' });
    // A trough is seen from inside and out depending on where the camera is.
    this.pitMaterial.side = THREE.DoubleSide;
  }

  /**
   * Spill materials are built on demand. Their textures are per-pixel noise and
   * cost real milliseconds, and most circuits have no puddle or oil on them at
   * all — there is no reason to pay for them at load on every track.
   */
  fluidMaterial(kind) {
    const key = kind === 'oil' ? 'oilMaterial' : 'puddleMaterial';
    if (this[key]) return this[key];

    const size = Math.min(256, this.texSize);
    const oil = kind === 'oil';
    const tex = generateFluidTextures(oil ? 'oil' : 'water', size, this.track.seed + (oil ? 9 : 5));
    const mat = new THREE.MeshStandardMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      normalScale: new THREE.Vector2(oil ? 0.3 : 0.35, oil ? 0.3 : 0.35),
      // Standing liquid is the smoothest thing in the scene by a wide margin;
      // that mirror-sharp highlight is the whole reason it reads as wet.
      roughness: oil ? 0.06 : 0.08,
      metalness: oil ? 0.45 : 0.0,
      vertexColors: true,
      transparent: true,
      opacity: oil ? 0.94 : 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      name: oil ? 'track:oil' : 'track:puddle',
    });
    this.ownedMaterials.push(mat);
    this[key] = mat;
    return mat;
  }

  /**
   * @param {string} kind named surface
   * @param {{vertexColors?: boolean, texScale?: number}} opts
   * @returns {THREE.Material}
   */
  surfaceMaterial(kind, opts = {}) {
    // `tag` opts out of sharing, for the few materials that get mutated after
    // creation and must not drag every other user of the same surface with them.
    const cacheKey = `${kind}|${opts.texScale ?? ROAD_TEX_SCALE}|${opts.vertexColors ? 1 : 0}|${opts.tag || ''}`;
    if (this.matCache?.has(cacheKey)) return this.matCache.get(cacheKey);

    const factory = this.ctx?.materials || this.ctx?.assets?.materials;
    let mat = null;
    try {
      if (factory?.surface) mat = factory.surface(kind, { repeat: 1, triplanar: false });
      else if (factory?.get) mat = factory.get(kind, { repeat: 1 });
    } catch (err) {
      mat = null;
    }
    if (mat && mat.isMaterial) {
      mat = mat.clone();
    } else {
      mat = null;
      const proc = this.ctx?.procTex || this.ctx?.assets?.tex;
      let set = null;
      try {
        set = proc?.makeTextureSet?.(kind, { size: this.texSize, seed: this.track.seed });
      } catch (err) {
        set = null;
      }
      if (!set || !set.map) set = generateSurfaceMaps(kind, this.texSize, this.track.seed);
      mat = new THREE.MeshStandardMaterial({
        map: set.map || null,
        normalMap: set.normalMap || null,
        roughnessMap: set.roughnessMap || null,
        aoMap: set.aoMap || null,
        roughness: 1,
        metalness: kind === 'brushedAluminium' || kind === 'galvanisedSteel' ? 0.85 : 0.0,
      });
    }

    mat.name = `track:${kind}`;
    if (opts.vertexColors) mat.vertexColors = true;
    mat.userData.texScale = this.texScaleFor(mat, opts.texScale ?? ROAD_TEX_SCALE);
    this.ownedMaterials.push(mat);
    this.matCache?.set(cacheKey, mat);
    return mat;
  }

  /**
   * World units per UV repeat, corrected for whatever repeat the incoming
   * texture already carries. Three multiplies uv by texture.repeat in the
   * shader, so the UVs are pre-divided instead of the shared texture being
   * cloned and re-uploaded.
   */
  texScaleFor(mat, worldScale) {
    const r = mat.map?.repeat;
    const k = r && Number.isFinite(r.x) && r.x > 0 ? r.x : 1;
    return worldScale * k;
  }

  /**
   * World units per repeat for a surface, taken from the surface's own declared
   * `tileWorld` where it has one.
   *
   * The constants below were authored independently of the bake, so the ground
   * asked for 96 cm per repeat while oak declares 60 — a 1.6x stretch applied
   * to every grain feature on the table, on top of the pore density already
   * being dropped deliberately for aliasing. Asking the surface is the only way
   * these two numbers cannot drift apart again.
   *
   * Falls back to the caller's constant when a kind declares nothing, so an
   * unlisted surface behaves exactly as before.
   */
  metricScaleFor(kind, fallback) {
    const w = GEN_DEF?.[kind]?.tileWorld;
    return Number.isFinite(w) && w > 0 ? w : fallback;
  }

  /* ------------------------------------------------------------- table edge */

  /** Seed for the broad tonal blotches, shared by the top and its rim. */
  groundBlotchSeed() {
    if (this._blotchSeed == null) this._blotchSeed = makeRng(this.track.seed ^ 0x1d3a).uint();
    return this._blotchSeed;
  }

  /**
   * Broad tonal blotches at a scale far larger than the texture tile. This,
   * more than resolution, is what hides a repeating texture. The rim reads it at
   * the same (x, z) as the top does, so the shared edge cannot show a seam.
   */
  groundTint(x, z, out) {
    const v = fbm2DTiled(x * 0.0022, z * 0.0022, 32, 3, 2, 0.5, this.groundBlotchSeed()) * 0.5 + 0.5;
    const s = lerp(0.82, 1.08, v);
    out.setRGB(s, s * 0.995, s * 0.985);
    return out;
  }

  /** True when the surrounding surface is furniture, and so has an edge. */
  tableIsEdged() {
    const def = this.track.def;
    if (def.buildGround === false) return false;
    if (def.tableEdge != null) return !!def.tableEdge;
    return EDGED_THEMES.has(def.theme || this.track.theme || '');
  }

  /**
   * The rectangle the surrounding surface occupies, memoised because the top and
   * the rim have to agree about it to the last decimal.
   *
   * An edged table stops a short way past the outermost thing standing on it
   * rather than at `groundPad`, which is 300-380 u of wood and puts the rim
   * outside every shot the game actually takes — an edge nobody sees is worth
   * nothing. Hand-placed props are folded in first: a mug left hanging in the
   * air past the rim is a worse tell than having no rim at all. Unedged themes
   * keep the full pad and the mesh they have always had.
   */
  tableRect() {
    if (this._tableRect) return this._tableRect;
    const track = this.track;
    const b = track.bounds;
    const pad = track.def.groundPad ?? 340;
    const edged = this.tableIsEdged();

    let x0 = b.min.x;
    let x1 = b.max.x;
    let z0 = b.min.z;
    let z1 = b.max.z;

    if (edged) {
      for (const p of track.def.props || []) {
        const q = p?.position;
        if (!Array.isArray(q) || q.length < 3) continue;
        const s = typeof p.scale === 'number' && p.scale > 0 ? p.scale : 1;
        const r = TABLE_PROP_ALLOW * s;
        x0 = Math.min(x0, q[0] - r);
        x1 = Math.max(x1, q[0] + r);
        z0 = Math.min(z0, q[2] - r);
        z1 = Math.max(z1, q[2] + r);
      }
      // Never larger than the slab that used to be built here, so a definition
      // that wants a small table gets one by shrinking groundPad.
      x0 = Math.max(b.min.x - pad, x0 - TABLE_MARGIN);
      x1 = Math.min(b.max.x + pad, x1 + TABLE_MARGIN);
      z0 = Math.max(b.min.z - pad, z0 - TABLE_MARGIN);
      z1 = Math.min(b.max.z + pad, z1 + TABLE_MARGIN);
    } else {
      x0 = b.min.x - pad;
      x1 = b.max.x + pad;
      z0 = b.min.z - pad;
      z1 = b.max.z + pad;
    }

    this._tableRect = { x0, x1, z0, z1, edged };
    return this._tableRect;
  }

  /**
   * Perimeter samples for the rim: position, unit outward direction, the miter
   * scale that offset must be multiplied by, and arc length for the UV.
   *
   * Sides are sampled at the ground grid's own boundary positions so every top
   * vertex has a rim vertex on top of it. Corners carry the bisector and a
   * 1/cos scale, which is what makes the moulding meet itself in a clean miter
   * instead of leaving a notch out of the silhouette.
   */
  tablePerimeter() {
    const { x0, x1, z0, z1 } = this.tableRect();
    const n = Math.max(2, GROUND_N - 1);
    const corner = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const out = [];
    let s = 0;

    for (let k = 0; k < 4; k++) {
      const a = corner[k];
      const b = corner[(k + 1) % 4];
      const prev = corner[(k + 3) % 4];

      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      // Walking the corners in this order leaves the interior on the left, so
      // rotating the travel direction by -90 degrees points out of the table.
      const ox = dz / len;
      const oz = -dx / len;

      const pdx = a[0] - prev[0];
      const pdz = a[1] - prev[1];
      const plen = Math.hypot(pdx, pdz) || 1;
      const px = pdz / plen;
      const pz = -pdx / plen;

      let bx = ox + px;
      let bz = oz + pz;
      const bl = Math.hypot(bx, bz) || 1;
      bx /= bl;
      bz /= bl;
      const miter = 1 / Math.max(0.2, bx * ox + bz * oz);

      // How far a corner may be pulled inward before it overtakes its own
      // neighbours along the side and folds the ring back over itself. See
      // ringOffset().
      const maxIn = Math.min(plen, len) / n;

      out.push({ x: a[0], z: a[1], ox: bx, oz: bz, miter, maxIn, s });
      for (let i = 1; i < n; i++) {
        const f = i / n;
        out.push({
          x: a[0] + dx * f, z: a[1] + dz * f, ox, oz, miter: 1, maxIn: Infinity, s: s + len * f,
        });
      }
      s += len;
    }

    // The closing sample repeats the first geometrically but carries the full
    // perimeter as its arc length, so the texture runs continuously round.
    out.push({ ...out[0], s });
    return out;
  }

  /**
   * Two materials, one geometry. The rolled lip a forearm actually rests on is
   * polished smoother than the face below it — the same maps, the same texel
   * density, one number apart, which is what wear looks like on furniture.
   * Built on demand for the same reason the fluids are: most tracks never ask.
   */
  tableEdgeMaterials() {
    if (this._tableEdgeMats) return this._tableEdgeMats;
    const track = this.track;
    const def = track.def;
    const kind = def.tableEdgeSurface
      || TABLE_EDGE_SURFACE[def.theme || track.theme]
      || def.groundSurface
      || track.offTrackSurface;
    const texScale = this.metricScaleFor(kind, GROUND_TEX_SCALE);

    const lip = this.surfaceMaterial(kind, { vertexColors: true, texScale, tag: 'tableLip' });
    const face = this.surfaceMaterial(kind, { vertexColors: true, texScale, tag: 'tableFace' });
    lip.roughness = 0.74;
    lip.name = 'track:tableLip';
    face.name = 'track:tableFace';
    // A rim is seen from above at the near edge and edge-on at the far one, and
    // the underside cap is seen from below or not at all. A backfacing hole in
    // the table's silhouette costs far more than the fill this saves on what is
    // background geometry in every frame.
    lip.side = THREE.DoubleSide;
    face.side = THREE.DoubleSide;

    this._tableEdgeMats = [lip, face];
    return this._tableEdgeMats;
  }

  /**
   * The rim: the cross-section above, swept around the perimeter. Top row sits
   * exactly on the ground mesh's boundary vertices, so the join is welded rather
   * than merely close.
   */
  /**
   * How far the floor is below the tabletop (D17).
   *
   * Resolved exactly the way render/Sky.js resolves it, from the same source in
   * the same order, so the legs land on the floor rather than near it. If a
   * track definition sets `tableHeight`, both read that number; otherwise both
   * take their shared default. This is the reconciliation the room agent asked
   * for when it wrote "table height is a guess the other agent must match".
   */
  _tableFloorDrop() {
    const h = this.track?.def?.tableHeight;
    return Number.isFinite(h) && h > 0 ? h : LEG_DROP_DEFAULT;
  }

  /**
   * Four tapered legs from under the apron down to the room floor.
   *
   * Deliberately plain: they are seen edge-on, far from any camera the game
   * uses today, and against a floor that is itself a flat analytic shade. A
   * square section with a taper reads as furniture from any angle that will
   * ever see them, and costs four boxes.
   */
  buildTableLegs() {
    const rect = this.tableRect();
    if (!rect.edged) return;

    const drop = this._tableFloorDrop();
    const height = drop - TABLE_THICK + LEG_SINK;
    if (!(height > 0)) return;

    const mats = this.tableEdgeMaterials();
    const material = Array.isArray(mats) ? mats[mats.length - 1] : mats;
    if (!material) return;

    const inset = LEG_INSET;
    const corners = [
      [rect.x0 + inset, rect.z0 + inset],
      [rect.x1 - inset, rect.z0 + inset],
      [rect.x1 - inset, rect.z1 - inset],
      [rect.x0 + inset, rect.z1 - inset],
    ];

    // One unit box, scaled per leg, tapered by moving the bottom four corners
    // inward. BoxGeometry's vertex order is stable, so this is a direct edit of
    // the position attribute rather than a per-leg geometry build.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const pos = geo.attributes.position;
    const taper = LEG_FOOT / LEG_TOP;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 0) {
        pos.setX(i, pos.getX(i) * taper);
        pos.setZ(i, pos.getZ(i) * taper);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    for (let i = 0; i < corners.length; i++) {
      const [x, z] = corners[i];
      const leg = new THREE.Mesh(geo, material);
      leg.name = `track:tableLeg${i}`;
      leg.scale.set(LEG_TOP, height, LEG_TOP);
      leg.position.set(x, -TABLE_THICK - height * 0.5 + LEG_SINK * 0.0, z);
      leg.castShadow = false;      // far outside the shadow cascade
      leg.receiveShadow = false;
      leg.matrixAutoUpdate = false;
      leg.updateMatrix();
      this.add(leg);
    }
  }

  buildTableEdge() {
    if (!this.tableRect().edged) return;

    const track = this.track;
    const ring = this.tablePerimeter();
    const prof = expandProfile(TABLE_PROFILE.map((p) => ({ lat: p.o, y: p.d, hard: p.hard })));

    let arc = 0;
    for (let i = 1; i < TABLE_PROFILE.length; i++) {
      arc += Math.hypot(
        TABLE_PROFILE[i].o - TABLE_PROFILE[i - 1].o,
        TABLE_PROFILE[i].d - TABLE_PROFILE[i - 1].d
      );
    }
    if (!(arc > 0)) arc = 1;

    const mats = this.tableEdgeMaterials();
    const scale = mats[0].userData.texScale || GROUND_TEX_SCALE;

    const geo = sweep(ring.length, prof.count, {
      position: (i, j, out) => {
        const r = ring[i];
        const o = ringOffset(r, prof.lat[j]);
        out.set(r.x + r.ox * o, track.groundHeight(r.x, r.z) + prof.y[j], r.z + r.oz * o);
      },
      normal: (i, j, out) => {
        const r = ring[i];
        out.set(r.ox * prof.nl[j], prof.nu[j], r.oz * prof.nl[j]).normalize();
      },
      uv: (i, j) => {
        _uv.set(ring[i].s / scale, (prof.u[j] * arc) / scale);
        return _uv;
      },
      color: (i, j, out) => {
        const r = ring[i];
        this.groundTint(r.x, r.z, out);
        const t = clamp(-prof.y[j] / TABLE_THICK, 0, 1);
        // A narrow band just below the arris is where hands go, so it stays
        // bright; below that it ramps down to a third, which is the ambient
        // occlusion of a board against its own underside baked in rather than
        // left for a screen-space pass to find at a grazing angle.
        const polish = smoothstep(0, 0.10, t) * (1 - smoothstep(0.10, 0.28, t));
        out.multiplyScalar(lerp(1, 0.32, smoothstep(0.06, 0.92, t)) * (1 + 0.08 * polish));
      },
      quadGroup: (i, j) => (j < TABLE_LIP_QUADS ? 0 : 1),
    });

    const mesh = new THREE.Mesh(finaliseGeometry(geo), mats);
    mesh.name = 'track:tableEdge';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);

    this.buildTableUnderside(ring, prof, mats[1]);
  }

  /**
   * A flat cap closing the bottom of the board. Fanned from the centre out to
   * the rim's innermost ring, because sharing those exact points is the only
   * way two separately-tessellated meshes are guaranteed not to open a crack.
   */
  buildTableUnderside(ring, prof, mat) {
    const track = this.track;
    const j = prof.count - 1;
    const inset = prof.lat[j];
    const drop = prof.y[j];
    const n = ring.length - 1;          // the last sample repeats the first
    if (n < 3) return;

    const rect = this.tableRect();
    const cx = (rect.x0 + rect.x1) * 0.5;
    const cz = (rect.z0 + rect.z1) * 0.5;
    const count = n + 1;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const col = new Float32Array(count * 3);
    const scale = mat.userData.texScale || GROUND_TEX_SCALE;

    const write = (k, x, y, z) => {
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      nor[k * 3] = 0;
      nor[k * 3 + 1] = -1;
      nor[k * 3 + 2] = 0;
      uvs[k * 2] = x / scale;
      uvs[k * 2 + 1] = z / scale;
      this.groundTint(x, z, _col);
      // Nothing reaches under a table but bounce, and not much of that.
      col[k * 3] = _col.r * 0.26;
      col[k * 3 + 1] = _col.g * 0.25;
      col[k * 3 + 2] = _col.b * 0.24;
    };

    for (let i = 0; i < n; i++) {
      const r = ring[i];
      const o = ringOffset(r, inset);
      write(i, r.x + r.ox * o, track.groundHeight(r.x, r.z) + drop, r.z + r.oz * o);
    }
    write(n, cx, track.groundHeight(cx, cz) + drop, cz);

    const index = count > 65535 ? new Uint32Array(n * 3) : new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) {
      index[i * 3] = n;
      index[i * 3 + 1] = i;
      index[i * 3 + 2] = (i + 1) % n;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const mesh = new THREE.Mesh(finaliseGeometry(geo, { tangents: false }), mat);
    mesh.name = 'track:tableUnderside';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);
  }

  /* ----------------------------------------------------------------- ground */

  /** The surface the whole circuit is improvised on. */
  buildGround() {
    const track = this.track;
    if (track.def.buildGround === false) return;

    // Extent comes from tableRect() rather than groundPad directly: on a themed
    // piece of furniture the top has to stop where its rim begins.
    const { x0, x1, z0, z1 } = this.tableRect();
    const n = GROUND_N;
    const scale = this.groundMaterial.userData.texScale;

    const geo = sweep(n, n, {
      position: (i, j, out) => {
        const x = lerp(x0, x1, j / (n - 1));
        const z = lerp(z0, z1, i / (n - 1));
        out.set(x, track.groundHeight(x, z), z);
      },
      normal: (i, j, out) => {
        const x = lerp(x0, x1, j / (n - 1));
        const z = lerp(z0, z1, i / (n - 1));
        const e = 6;
        const hx = track.groundHeight(x + e, z) - track.groundHeight(x - e, z);
        const hz = track.groundHeight(x, z + e) - track.groundHeight(x, z - e);
        out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
      },
      uv: (i, j) => {
        _uv.set(lerp(x0, x1, j / (n - 1)) / scale, lerp(z0, z1, i / (n - 1)) / scale);
        return _uv;
      },
      color: (i, j, out) => {
        this.groundTint(lerp(x0, x1, j / (n - 1)), lerp(z0, z1, i / (n - 1)), out);
      },
    });

    const mesh = new THREE.Mesh(finaliseGeometry(geo), this.groundMaterial);
    mesh.name = 'track:ground';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);
  }

  /* ------------------------------------------------------------------- road */

  /**
   * The ribbon and its shoulder, as one grid. Columns are declared once and
   * evaluated per row so the whole thing tracks the varying width; the two
   * duplicated columns at the material boundary let the road and the ground
   * carry independent UV scales without opening a crack between them.
   */
  buildRoad() {
    const track = this.track;
    const rows = this.rowCount;
    const shoulder = track.shoulderWidth;

    // kind: 'frac' = fraction of the half width, 'off' = offset outside the edge
    // `seam: true` marks the first of a coincident pair. The quad between the
    // pair is dropped, which is what lets the road and the shoulder carry
    // independent UV projections without opening a crack between them.
    const cols = [];
    const skirtOffsets = [shoulder + 3, shoulder, 7.0, 4.6, 2.8];
    for (const o of skirtOffsets) cols.push({ kind: 'off', v: -o, group: 'skirt' });
    cols.push({ kind: 'off', v: -EDGE_OVERHANG, group: 'skirt', seam: true });
    cols.push({ kind: 'off', v: -EDGE_OVERHANG, group: 'road' });
    for (const f of [-1, -0.85, -0.62, -0.32, 0, 0.32, 0.62, 0.85, 1]) {
      cols.push({ kind: 'frac', v: f, group: 'road' });
    }
    cols.push({ kind: 'off', v: EDGE_OVERHANG, group: 'road', seam: true });
    cols.push({ kind: 'off', v: EDGE_OVERHANG, group: 'skirt' });
    for (const o of [2.8, 4.6, 7.0, shoulder, shoulder + 3]) {
      cols.push({ kind: 'off', v: o, group: 'skirt' });
    }
    this.roadCols = cols;
    const nCols = cols.length;

    // Material index 0..n-1 are the road surfaces; the shoulder material follows.
    const groundIndex = this.roadMaterials.length;
    const materials = [...this.roadMaterials, this.offMaterial];

    const roadScale = this.roadMaterials[0]?.userData.texScale ?? ROAD_TEX_SCALE;
    const roadScaleV = this.fitToLap(roadScale);
    const groundScale = this.offMaterial.userData.texScale;

    // Where the racing line runs at each row — the rubbered-in groove is drawn
    // from this, and it is the single cheapest thing that makes a track look
    // used rather than new.
    const line = track.racingLine;
    const lineLat = new Float32Array(rows);
    if (line && line.ready) {
      for (let i = 0; i < rows; i++) {
        const s = line.sampleAtTrackT(this.rowTAt(i));
        lineLat[i] = s.lateral;
      }
    }

    const lateralOf = (i, j) => {
      const c = cols[j];
      const hw = track.widthAt(this.rowTAt(i)) * 0.5;
      return c.kind === 'frac' ? c.v * hw : (c.v < 0 ? -hw + c.v : hw + c.v);
    };
    const lift = (j) => (j === 0 || j === nCols - 1 ? SKIRT_LIFT : 0);

    const geo = sweep(rows, nCols, {
      position: (i, j, out) => {
        track.surfacePoint(this.rowTAt(i), lateralOf(i, j), out);
        out.y += lift(j);
      },
      normal: (i, j, out) => {
        this.surfaceNormalAt(this.rowTAt(i), lateralOf(i, j), out);
      },
      uv: (i, j) => {
        const c = cols[j];
        const lat = lateralOf(i, j);
        if (c.group === 'road') {
          _uv.set(lat / roadScale, this.rowS[i] / roadScaleV);
        } else {
          // The shoulder is projected in world XZ exactly like the ground slab,
          // so the two share a continuous texture instead of meeting at a
          // direction change.
          track.surfacePoint(this.rowTAt(i), lat, _pd);
          _uv.set(_pd.x / groundScale, _pd.z / groundScale);
        }
        return _uv;
      },
      color: (i, j, out) => {
        const c = cols[j];
        const lat = lateralOf(i, j);
        const hw = track.widthAt(this.rowTAt(i)) * 0.5;
        const al = Math.abs(lat);
        let v = 1;
        if (c.group === 'road') {
          // Rubber laid down on the line, grit and dust collected at the edges.
          const d = Math.abs(lat - lineLat[i]);
          const groove = Math.exp(-(d * d) / (5.5 * 5.5));
          const edge = smoothstep(hw * 0.62, hw * 1.02, al);
          v = 1 - groove * 0.24 - edge * 0.10;
        } else {
          // Dirt banked up against the road, fading out into clean ground.
          const k = smoothstep(hw + EDGE_OVERHANG, hw + shoulder, al);
          v = lerp(0.80, 1.0, k);
        }
        const blot = fbm2DTiled(this.rowS[i] * 0.010, lat * 0.010, 32, 3, 2, 0.5, track.seed + 77) * 0.06;
        const s = clamp(v + blot, 0, 1.4);
        out.setRGB(s, s * 0.997, s * 0.99);
      },
      quadGroup: (i, j) => {
        if (cols[j].seam) return -1;
        if (cols[j].group === 'road' && cols[j + 1].group === 'road') {
          return track.data.surf[Math.floor(this.rowTAt(i) * track.count) % track.count];
        }
        return groundIndex;
      },
      quadSkip: (i, j) => {
        // Cut the deck away over a gap: the pit trough is built in its place.
        const t = this.rowTAt(i);
        const tn = this.rowTAt((i + 1) % this.rowT.length);
        const mid = wrap01(t + cyclicDelta(tn, t) * 0.5);
        return this.gapCoversRow(mid);
      },
    });

    const mesh = new THREE.Mesh(finaliseGeometry(geo), materials);
    mesh.name = 'track:road';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);
  }

  /** True where a full-width gap hazard removes the deck. */
  gapCoversRow(t) {
    const hz = this.track.hazards;
    for (let i = 0; i < hz.length; i++) {
      if (hz[i].type !== 'gap') continue;
      if (this.track.hazardSpanU(hz[i], t) < 1) return true;
    }
    return false;
  }

  /**
   * Surface normal at (t, lateral) by central differences of the surface
   * function itself. Exact over banking, ramps, bumps and the shoulder blend,
   * and identical on both sides of a duplicated column.
   */
  surfaceNormalAt(t, lateral, out) {
    const track = this.track;
    const dl = 0.35;
    const dt = 1.2 / track.length;
    track.surfacePoint(t, lateral + dl, _pa);
    track.surfacePoint(t, lateral - dl, _pb);
    track.surfacePoint(wrap01(t + dt), lateral, _pc);
    track.surfacePoint(wrap01(t - dt), lateral, _pd);
    _du.subVectors(_pa, _pb);
    _dv.subVectors(_pc, _pd);
    out.crossVectors(_du, _dv);
    if (out.lengthSq() < 1e-12) out.set(0, 1, 0); else out.normalize();
    if (out.y < 0) out.negate();
    return out;
  }

  /* ------------------------------------------------------------------ kerbs */

  buildKerbs() {
    const parts = [];
    for (const side of [-1, 1]) {
      const g = this.buildKerbSide(side);
      if (g) parts.push(g);
    }
    if (!parts.length) return;
    const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!geo) return;
    const mesh = new THREE.Mesh(finaliseGeometry(geo), this.kerbMaterial);
    mesh.name = 'track:kerbs';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);
  }

  buildKerbSide(sideSign) {
    const track = this.track;
    const rows = this.rowCount;
    const kerbTile = this.fitToLap(KERB_TILE);

    // Cross-section, as offsets outside the road edge. The base sits just past
    // the road's overhang so the kerb never overlaps the deck, and the corners
    // are rounded rather than creased: this is a moulded plastic border, and a
    // rounded edge is what catches the key light along its whole length.
    const base = EDGE_OVERHANG + 0.05;
    const prof = [
      { o: base, y: 0.0 },
      { o: base + 0.55, y: 0.74 },
      { o: base + 1.5, y: 1.0 },
      { o: base + KERB_WIDTH - 0.55, y: 1.0 },
      { o: base + KERB_WIDTH, y: 0.55 },
      { o: base + KERB_WIDTH + 0.8, y: 0.0 },
    ];
    const nCols = prof.length;

    // Columns must run in increasing lateral order for the winding and the
    // analytic normal to come out facing up on both sides of the track.
    const order = sideSign > 0 ? prof.map((_, i) => i) : prof.map((_, i) => nCols - 1 - i);

    const latOf = (i, j) => {
      const p = prof[order[j]];
      const hw = track.widthAt(this.rowTAt(i)) * 0.5;
      return sideSign * (hw + p.o);
    };
    const heightOf = (i, j) => prof[order[j]].y * KERB_HEIGHT * this.kerbAt(sideSign, i % this.rowT.length);

    let any = false;
    const geo = sweep(rows, nCols, {
      position: (i, j, out) => {
        track.surfacePoint(this.rowTAt(i), latOf(i, j), out);
        out.y += heightOf(i, j);
      },
      normal: (i, j, out) => {
        // Columns always run in increasing lateral, so the cross-section slope
        // (dl > 0, dy) has outward normal (-dy, dl) in the frame's
        // (right, up) plane — no per-side sign juggling.
        const jp = Math.max(0, j - 1);
        const jn = Math.min(nCols - 1, j + 1);
        const dl = latOf(i, jn) - latOf(i, jp);
        const dy = heightOf(i, jn) - heightOf(i, jp);
        const l = Math.hypot(dl, dy) || 1;
        const s = track.sampleAt(this.rowTAt(i));
        const hl = Math.hypot(s.right.x, s.right.z) || 1;
        _right.set(s.right.x / hl, s.right.y / hl, s.right.z / hl);
        _up.copy(s.normal);
        out.copy(_up).multiplyScalar(dl / l).addScaledVector(_right, -dy / l);
        if (out.lengthSq() < 1e-9) out.copy(_up); else out.normalize();
      },
      uv: (i, j) => {
        const p = prof[order[j]];
        const u = (p.o - base) / (KERB_WIDTH + 0.8);
        _uv.set(u, this.rowS[i] / kerbTile);
        return _uv;
      },
      color: (i, j, out) => {
        // Scuffed darker where cars actually ride the kerb.
        const amt = this.kerbAt(sideSign, i % this.rowT.length);
        const scuff = 1 - clamp(amt - 0.55, 0, 1) * 0.28;
        out.setRGB(scuff, scuff, scuff);
      },
      quadSkip: (i, j) => {
        const a = this.kerbAt(sideSign, i % this.rowT.length);
        const b = this.kerbAt(sideSign, (i + 1) % this.rowT.length);
        if (a < 0.03 && b < 0.03) return true;
        const t = this.rowTAt(i);
        if (this.gapCoversRow(t)) return true;
        any = true;
        return false;
      },
    });

    return any ? geo : null;
  }

  /* --------------------------------------------------------------- markings */

  /**
   * Every painted and chalked mark, in one geometry against one atlas: two edge
   * lines, two chalked lane dividers, the start/finish checker, the grid boxes,
   * gaffa tape over each surface change and hazard stripes ahead of every ramp
   * and gap.
   */
  buildMarkings() {
    const track = this.track;
    const parts = [];

    // Edge lines, just inside the nominal edge.
    for (const side of [-1, 1]) {
      const g = this.buildLongitudinalMark({
        row: MARK_ROW.edge,
        lateral: (i) => side * (track.widthAt(this.rowTAt(i)) * 0.5 - 0.85),
        lift: 0.04,
      });
      if (g) parts.push(g);
    }

    // Chalked lane dividers at the thirds.
    for (const side of [-1, 1]) {
      const g = this.buildLongitudinalMark({
        row: MARK_ROW.chalk,
        lateral: (i) => side * track.widthAt(this.rowTAt(i)) * 0.1667,
        lift: 0.035,
      });
      if (g) parts.push(g);
    }

    // Start/finish checker across the full width.
    parts.push(this.buildCrossMark({
      row: MARK_ROW.checker,
      t: track.startT,
      widthScale: 1.0,
      lift: 0.05,
    }));

    // Grid boxes behind the line.
    const slots = Math.min(track.spawnPoints.length, track.def.gridSize ?? 12);
    for (let i = 0; i < slots; i++) {
      const sp = track.spawnPoints[i];
      const g = this.buildGridBox(sp);
      if (g) parts.push(g);
    }

    // Gaffa tape wherever the road surface changes: it hides the material seam
    // and is exactly what someone taping a circuit onto a table would do.
    // Capped: a definition with rapidly alternating spans would otherwise carpet
    // the whole circuit in tape.
    const seams = this.surfaceSeams().slice(0, 12);
    for (const t of seams) {
      parts.push(this.buildCrossMark({ row: MARK_ROW.tape, t, widthScale: 1.06, lift: 0.045 }));
    }

    // Hazard stripes in front of ramps and gaps.
    for (const h of track.hazards) {
      if (h.type !== 'ramp' && h.type !== 'gap') continue;
      const t = wrap01(h.t0 - 7 / track.length);
      parts.push(this.buildCrossMark({ row: MARK_ROW.hazard, t, widthScale: 1.0, lift: 0.045 }));
    }

    const list = parts.filter(Boolean);
    if (!list.length) return;
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) return;
    const mesh = new THREE.Mesh(finaliseGeometry(geo, { tangents: false }), this.markMaterial);
    mesh.name = 'track:markings';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 3;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);
  }

  /** t values where the road surface changes, for the tape bands. */
  surfaceSeams() {
    const track = this.track;
    const out = [];
    const surf = track.data.surf;
    const n = track.count;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (surf[i] !== surf[j]) out.push((j / n));
    }
    return out;
  }

  /** A mark that runs the length of the lap at a (possibly varying) offset. */
  buildLongitudinalMark({ row, lateral, lift }) {
    const track = this.track;
    const rows = this.rowCount;
    const spec = MARK_SPEC[keyOfRow(row)];
    const tile = this.fitToLap(spec.tile);
    const half = spec.width * 0.5;
    const v0 = (row + 0.02) / MARK_ROWS;
    const v1 = (row + 0.98) / MARK_ROWS;
    let any = false;

    const geo = sweep(rows, 2, {
      position: (i, j, out) => {
        const lat = lateral(i) + (j === 0 ? -half : half);
        track.surfacePoint(this.rowTAt(i), lat, out);
        out.y += lift;
      },
      normal: (i, j, out) => {
        this.surfaceNormalAt(this.rowTAt(i), lateral(i), out);
      },
      uv: (i, j) => {
        _uv.set(this.rowS[i] / tile, j === 0 ? v0 : v1);
        return _uv;
      },
      quadSkip: (i) => {
        if (this.gapCoversRow(this.rowTAt(i))) return true;
        any = true;
        return false;
      },
    });
    return any ? geo : null;
  }

  /** A band laid across the track: start line, tape, hazard stripes. */
  buildCrossMark({ row, t, widthScale, lift }) {
    const track = this.track;
    const spec = MARK_SPEC[keyOfRow(row)];
    const hw = track.widthAt(t) * 0.5 * widthScale + EDGE_OVERHANG;
    const cols = 17;
    const rows = 5;
    const halfLen = spec.width * 0.5;
    const v0 = (row + 0.02) / MARK_ROWS;
    const v1 = (row + 0.98) / MARK_ROWS;
    const L = track.length;

    return sweep(rows, cols, {
      position: (i, j, out) => {
        const lat = lerp(-hw, hw, j / (cols - 1));
        const off = lerp(-halfLen, halfLen, i / (rows - 1));
        track.surfacePoint(wrap01(t + off / L), lat, out);
        out.y += lift;
      },
      normal: (i, j, out) => {
        const lat = lerp(-hw, hw, j / (cols - 1));
        this.surfaceNormalAt(t, lat, out);
      },
      uv: (i, j) => {
        // The long axis of the band is across the track, so u runs with lateral.
        const lat = lerp(-hw, hw, j / (cols - 1));
        _uv.set(lat / spec.tile, lerp(v0, v1, i / (rows - 1)));
        return _uv;
      },
    });
  }

  /** The painted box a car lines up in on the grid. */
  buildGridBox(spawn) {
    const track = this.track;
    const spec = MARK_SPEC.grid;
    const v0 = (MARK_ROW.grid + 0.02) / MARK_ROWS;
    const v1 = (MARK_ROW.grid + 0.98) / MARK_ROWS;
    const L = track.length;
    const halfW = spec.width * 0.5;
    const halfL = spec.tile * 0.5;
    const cols = 5;
    const rows = 7;

    return sweep(rows, cols, {
      position: (i, j, out) => {
        const lat = spawn.lateral + lerp(-halfW, halfW, j / (cols - 1));
        const off = lerp(-halfL, halfL, i / (rows - 1));
        track.surfacePoint(wrap01(spawn.t + off / L), lat, out);
        out.y += 0.042;
      },
      normal: (i, j, out) => {
        this.surfaceNormalAt(spawn.t, spawn.lateral, out);
      },
      uv: (i, j) => {
        _uv.set(i / (rows - 1), lerp(v0, v1, j / (cols - 1)));
        return _uv;
      },
    });
  }

  /* ------------------------------------------------------------------ walls */

  /**
   * Low moulded barriers. Explicit spans from the definition if there are any,
   * otherwise generated on the outside of every corner tight enough to throw a
   * car off — which is where a real toy circuit gets its plastic borders too.
   */
  buildWalls() {
    const track = this.track;
    const spans = Array.isArray(track.def.walls) && track.def.walls.length
      ? track.def.walls.map((w) => ({
        from: wrap01(w.from ?? 0),
        to: wrap01(w.to ?? 1),
        side: w.side === 'left' ? -1 : w.side === 'both' ? 0 : 1,
        height: w.height ?? WALL_HEIGHT,
      }))
      : this.autoWallSpans();
    if (!spans.length) return;

    const parts = [];
    for (const span of spans) {
      const sides = span.side === 0 ? [-1, 1] : [span.side];
      for (const s of sides) {
        const g = this.buildWallRun(span, s);
        if (g) parts.push(g);
      }
    }
    if (!parts.length) return;

    const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!geo) return;
    const mesh = new THREE.Mesh(finaliseGeometry(geo), this.wallMaterial);
    mesh.name = 'track:walls';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);

    // Published so physics/World.js can raise colliders for them without
    // re-deriving where they went: inner face at |lateral| = offset, running
    // outward by `thickness`.
    this.wallSpans = spans;
    this.track.walls = spans.map((s) => ({
      from: s.from,
      to: s.to,
      side: s.side,
      height: s.height ?? WALL_HEIGHT,
      thickness: WALL_THICK,
      offset: track.shoulderWidth * 0.62,
    }));
  }

  /**
   * Barriers on the outside of every corner tight enough to throw a car off.
   * Runs are tracked by sample count rather than by parameter difference: a
   * one-sample run has from === to, and a cyclic difference cannot tell that
   * apart from a barrier that goes all the way round.
   */
  autoWallSpans() {
    const track = this.track;
    const n = track.count;
    const spans = [];
    let run = null;
    const minSamples = Math.max(4, Math.round((26 / track.length) * n));
    const pad = 14 / track.length;

    for (let i = 0; i < n; i++) {
      const t = i / n;
      const k = track.curvatureAt(t);
      const need = Math.abs(k) > WALL_CURV_MIN;
      const side = k >= 0 ? 1 : -1; // outside of the corner
      if (need && run && run.side === side) {
        run.to = t;
        run.samples++;
      } else {
        if (run && run.samples >= minSamples) spans.push(run);
        run = need ? { from: t, to: t, side, samples: 1, height: WALL_HEIGHT } : null;
      }
    }
    if (run && run.samples >= minSamples) spans.push(run);

    return spans.map((s) => ({
      from: wrap01(s.from - pad),
      to: wrap01(s.to + pad),
      side: s.side,
      height: s.height,
    }));
  }

  buildWallRun(span, sideSign) {
    const track = this.track;
    const L = track.length;
    const spanT = cyclicSpan(span.from, span.to);
    const lenU = spanT * L;
    const rows = Math.max(6, Math.round(lenU / 3.2) + 1);
    const off = track.shoulderWidth * 0.62;
    const h = span.height ?? WALL_HEIGHT;
    const cham = 0.55;

    // Cross-section, ordered by increasing lateral for the right side and
    // mirrored for the left. Chamfers on every edge so the barrier picks up a
    // highlight instead of reading as an extruded rectangle.
    const inner = [
      { d: 0, y: 0, hard: true },
      { d: 0, y: h - cham, hard: true },
      { d: cham, y: h, hard: true },
      { d: WALL_THICK - cham, y: h, hard: true },
      { d: WALL_THICK, y: h - cham, hard: true },
      { d: WALL_THICK, y: 0, hard: true },
    ];
    const prof = expandProfile(inner.map((p) => ({ lat: p.d, y: p.y, hard: p.hard })));
    const nCols = prof.count;
    const order = sideSign > 0 ? prof : reverseProfile(prof);

    const tAt = (i) => wrap01(span.from + (i / (rows - 1)) * spanT);
    // Taper the height in at both ends so a barrier never starts as a wall.
    const taper = (i) => {
      const u = i / (rows - 1);
      return smoothstep(0, 0.10, u) * (1 - smoothstep(0.90, 1, u));
    };
    // reverseProfile() already mirrors both the offsets and their normals, so
    // the columns run in increasing lateral on either side of the track and the
    // frame's right vector is used unmodified.
    const latOf = (i, j) => {
      const hw = track.widthAt(tAt(i)) * 0.5;
      return sideSign * (hw + off) + order.lat[j];
    };

    return sweep(rows, nCols, {
      position: (i, j, out) => {
        const t = tAt(i);
        // Base follows the ground, not the road plane, so the wall never floats.
        track.surfacePoint(t, latOf(i, j), out);
        out.y += order.y[j] * taper(i);
      },
      normal: (i, j, out) => {
        const s = track.sampleAt(tAt(i));
        const hl = Math.hypot(s.right.x, s.right.z) || 1;
        _right.set(s.right.x / hl, s.right.y / hl, s.right.z / hl);
        _up.set(0, 1, 0);
        out.copy(_up).multiplyScalar(order.nu[j]).addScaledVector(_right, order.nl[j]);
        if (out.lengthSq() < 1e-9) out.set(0, 1, 0); else out.normalize();
      },
      uv: (i, j) => {
        const s = (i / (rows - 1)) * lenU;
        _uv.set(s / WALL_TEX_SCALE, order.u[j] * ((WALL_THICK + h * 2) / WALL_TEX_SCALE));
        return _uv;
      },
      color: (i, j, out) => {
        // Darker towards the foot: cheap, always-correct contact occlusion.
        const k = clamp(order.y[j] / Math.max(0.001, h), 0, 1);
        const v = lerp(0.55, 1.06, Math.pow(k, 0.6));
        out.setRGB(v, v, v);
      },
    });
  }

  /* ---------------------------------------------------------------- hazards */

  buildHazardMeshes() {
    const track = this.track;
    const pits = [];
    const puddles = [];
    const oils = [];

    for (const h of track.hazards) {
      if (h.type === 'gap') {
        const g = this.buildPit(h);
        if (g) pits.push(g);
      } else if (h.type === 'puddle') {
        puddles.push(this.buildFluidPatch(h, 0.05));
      } else if (h.type === 'oil') {
        oils.push(this.buildFluidPatch(h, 0.055));
      }
    }

    if (pits.length) {
      const geo = pits.length === 1 ? pits[0] : mergeGeometries(pits, false);
      if (geo) {
        // No tangents: the vertical walls have zero-area UV triangles, which
        // would come back from computeTangents as NaN.
        const mesh = new THREE.Mesh(finaliseGeometry(geo, { tangents: false }), this.pitMaterial);
        mesh.name = 'track:pits';
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.add(mesh);
      }
    }
    if (puddles.length) this.addFluidMesh(puddles, this.fluidMaterial('water'), 'track:puddles');
    if (oils.length) this.addFluidMesh(oils, this.fluidMaterial('oil'), 'track:oil');
  }

  addFluidMesh(parts, material, name) {
    const list = parts.filter(Boolean);
    if (!list.length) return;
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) return;
    const mesh = new THREE.Mesh(finaliseGeometry(geo, { tangents: false }), material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 4;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.add(mesh);
  }

  /**
   * A trough where the deck was cut away: two end walls, two side walls and a
   * floor, so a gap reads as a hole through the table rather than a black quad.
   */
  buildPit(h) {
    const track = this.track;
    const L = track.length;
    const t0 = h.t0;
    const t1 = h.t1;
    const spanT = cyclicSpan(t0, t1);
    const rows = Math.max(4, Math.round((spanT * L) / 2.5) + 1);
    // Must reach exactly as far as the deck that was cut away, or the trough
    // leaves a slot of open space along its rim.
    const halfW = track.widthAt(h.t) * 0.5 + track.shoulderWidth + 3;
    const floorY = track.groundY - h.depth;
    const floorCols = 5;

    // Cross-section of the trough: down the near wall, across the floor, up the
    // far wall. `down` marks a vertex that sits on the floor rather than on the
    // surface, and `face` is its normal in the frame's (right, up) plane.
    const rim = [
      { lat: -halfW, down: false, nl: 1, nu: 0 },
      { lat: -halfW, down: true, nl: 1, nu: 0 },
    ];
    for (let i = 1; i < floorCols - 1; i++) {
      rim.push({ lat: lerp(-halfW, halfW, i / (floorCols - 1)), down: true, nl: 0, nu: 1 });
    }
    rim.push({ lat: halfW, down: true, nl: -1, nu: 0 });
    rim.push({ lat: halfW, down: false, nl: -1, nu: 0 });

    const frameNormal = (t, nl, nu, out) => {
      const s = track.sampleAt(t);
      const hl = Math.hypot(s.right.x, s.right.z) || 1;
      _right.set(s.right.x / hl, s.right.y / hl, s.right.z / hl);
      out.set(0, nu, 0).addScaledVector(_right, nl);
      if (out.lengthSq() < 1e-9) out.set(0, 1, 0); else out.normalize();
    };

    const parts = [];
    // Floor and the two side walls, swept along the gap.
    parts.push(sweep(rows, rim.length, {
      position: (i, j, out) => {
        const t = wrap01(t0 + (i / (rows - 1)) * spanT);
        track.surfacePoint(t, rim[j].lat, out);
        if (rim[j].down) out.y = floorY;
      },
      normal: (i, j, out) => {
        frameNormal(wrap01(t0 + (i / (rows - 1)) * spanT), rim[j].nl, rim[j].nu, out);
      },
      uv: (i, j) => {
        const s = (i / (rows - 1)) * spanT * L;
        _uv.set(rim[j].lat / 40, s / 40);
        return _uv;
      },
      color: (i, j, out) => {
        const v = rim[j].down ? 0.42 : 0.9;
        out.setRGB(v, v, v);
      },
    }));

    // End walls, closing the trough across the track. The two ends face
    // opposite ways, so one is wound backwards; the material is double-sided
    // rather than paying for two special cases.
    for (const end of [0, 1]) {
      const t = end === 0 ? t0 : t1;
      parts.push(sweep(2, rim.length, {
        position: (i, j, out) => {
          track.surfacePoint(t, rim[j].lat, out);
          if (i === 0) out.y = floorY;
        },
        normal: (i, j, out) => {
          const s = track.sampleAt(t);
          out.copy(s.tangent).multiplyScalar(end === 0 ? 1 : -1);
        },
        uv: (i, j) => {
          _uv.set(rim[j].lat / 40, i === 0 ? h.depth / 40 : 0);
          return _uv;
        },
        color: (i, j, out) => {
          const v = i === 0 ? 0.4 : 0.85;
          out.setRGB(v, v, v);
        },
      }));
    }

    return mergeGeometries(parts, false);
  }

  /** An elliptical spill conformed to the road surface, with a soft rim. */
  buildFluidPatch(h, lift) {
    const track = this.track;
    const L = track.length;
    const rings = 5;
    const radial = 24;
    const halfT = h.halfSpanT;
    const halfW = (h.width > 0 ? h.width : track.widthAt(h.t) * 0.72) * 0.5;
    const seed = makeRng(track.seed ^ (h.t * 100000));
    // Per-spill irregularity: a perfect ellipse reads as a decal.
    const wobble = [];
    for (let a = 0; a < radial; a++) wobble.push(0.78 + seed.next() * 0.34);

    return sweep(rings, radial + 1, {
      position: (i, j, out) => {
        const r = i / (rings - 1);
        const a = (j % radial) / radial * Math.PI * 2;
        const w = lerp(1, wobble[j % radial], 0.85);
        const dt = Math.cos(a) * halfT * r * w;
        const dl = Math.sin(a) * halfW * r * w;
        track.surfacePoint(wrap01(h.t + dt), h.lateral + dl, out);
        out.y += lift;
      },
      normal: (i, j, out) => {
        this.surfaceNormalAt(h.t, h.lateral, out);
      },
      uv: (i, j) => {
        const r = i / (rings - 1);
        const a = (j % radial) / radial * Math.PI * 2;
        _uv.set(0.5 + Math.cos(a) * r * 0.5, 0.5 + Math.sin(a) * r * 0.5);
        return _uv;
      },
      color: (i, j, out) => {
        // Alpha is not available per-vertex on a standard material, so the rim
        // is faded by darkening it into the road instead.
        const r = i / (rings - 1);
        const v = lerp(1, 0.25, smoothstep(0.55, 1, r));
        out.setRGB(v, v, v);
      },
    });
  }

  /* ------------------------------------------------------------------ utils */

  add(mesh) {
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  update(dt) {
    this.time += dt;
    // Slow drift on the fluid normal maps: a puddle that is perfectly still
    // looks like paint.
    const off = (this.time * 0.02) % 1;
    if (this.puddleMaterial?.normalMap) {
      this.puddleMaterial.normalMap.offset.set(off, off * 0.6);
    }
    if (this.oilMaterial?.normalMap) {
      this.oilMaterial.normalMap.offset.set(-off * 0.4, off * 0.3);
    }
  }

  info() {
    let tris = 0;
    for (const m of this.meshes) {
      const idx = m.geometry?.getIndex();
      if (idx) tris += idx.count / 3;
    }
    return {
      meshes: this.meshes.length,
      drawCalls: this.meshes.reduce((n, m) => n + (Array.isArray(m.material) ? m.geometry.groups.length || 1 : 1), 0),
      triangles: Math.round(tris),
      rows: this.rowCount,
      buildMs: this.buildMs != null ? +this.buildMs.toFixed(1) : null,
      failed: this.failedStages || [],
    };
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry?.dispose?.();
      m.parent?.remove?.(m);
    }
    for (const mat of this.ownedMaterials) mat.dispose?.();
    this.meshes.length = 0;
    this.ownedMaterials.length = 0;
    for (const set of _texCache.values()) {
      for (const k in set) set[k]?.dispose?.();
    }
    _texCache.clear();
  }
}

/* --------------------------------------------------------------- free utils */

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

function keyOfRow(row) {
  for (const k in MARK_ROW) if (MARK_ROW[k] === row) return k;
  return 'edge';
}

/** Forward span from a to b on the unit circle, always in (0, 1]. */
function cyclicSpan(a, b) {
  let d = b - a;
  d -= Math.floor(d);
  return d <= 1e-6 ? 1 : d;
}

/** Mirror an expanded profile so its columns still run in increasing lateral. */
function reverseProfile(p) {
  const n = p.count;
  const lat = new Float64Array(n);
  const y = new Float64Array(n);
  const u = new Float64Array(n);
  const nl = new Float64Array(n);
  const nu = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    lat[i] = -p.lat[j];
    y[i] = p.y[j];
    u[i] = 1 - p.u[j];
    nl[i] = -p.nl[j];
    nu[i] = p.nu[j];
  }
  return { lat, y, u, nl, nu, count: n };
}

export default TrackBuilder;
