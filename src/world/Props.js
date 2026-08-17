// world/Props.js — the instanced scenery system.
//
// This module is why the tracks read as *places* rather than as ribbons in a
// void. It owns a library of household objects, modelled procedurally at their
// real centimetre sizes against a 9 cm car, and a placement pass that scatters
// them along the verges with blue-noise separation and hard clearance from the
// racing surface.
//
// Four ideas carry the whole file.
//
// 1. ONE DRAW CALL PER PROP TYPE PER MATERIAL. Every model is authored as a
//    handful of primitives, each tinted through a *vertex colour* attribute and
//    then merged by material. A cereal box with a printed front panel, a white
//    band and brown flaps is one geometry with one material, not four meshes.
//    Everything repeated goes into an InstancedMesh.
//
// 2. NO TWO INSTANCES IDENTICAL. Instancing shares geometry, so variation has to
//    come from somewhere else. Three sources are stacked: a per-instance
//    transform (yaw, lean, non-uniform scale), a per-instance colour on
//    `instanceColor`, and — the one that actually kills the tell — a per-instance
//    *texture offset* injected into the vertex shader from a per-instance seed
//    attribute, so forty sugar cubes do not all show the same crystal pattern in
//    the same place. The same seed also jitters roughness a few percent.
//
// 3. CONTACT. A prop with a shadow-mapped shadow but no contact darkening reads
//    as floating; it is the single most common amateur tell. This file does not
//    implement that darkening — render/Lighting.js owns the one contact-shadow
//    system in the project and every prop registers with it through
//    addContactShadow(). An earlier version of this file grew its own rig, and
//    two of its choices (sRGB texture, MultiplyBlending without
//    premultipliedAlpha) combined into a blob that rendered as an opaque *pale*
//    card: every prop in the establishing shot stood on a rectangle brighter
//    than the table. There is now exactly one implementation, and its shader can
//    only ever darken. The local fallback below is for the case where there is
//    no lighting system at all, and it darkens too.
//
// 4. COLLISION IS DATA, NOT MESHES. Each model declares a proxy shape (box,
//    cylinder or sphere) derived from its own bounds. Proxies are published to
//    physics/World.js if it exists, and always to a local uniform-grid index so
//    anything else can ask "what is near (x, z)?" without a scene traversal.
//    Small props flagged `knockable` are simulated locally when no physics world
//    claims them, which is what lets a pack of cars scatter the pool balls.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, clamp, lerp, smoothstep, TAU } from '../core/Random.js';
import * as MaterialsMod from '../render/Materials.js';
import * as SurfacesMod from '../textures/Surfaces.js';
import * as SettingsMod from '../core/Settings.js';

const Materials = MaterialsMod.Materials ?? MaterialsMod.default ?? null;
const Surfaces = SurfacesMod.Surfaces ?? SurfacesMod.default ?? null;
const Settings = SettingsMod.Settings ?? SettingsMod.default ?? { world: {}, render: {} };

/* ========================================================== module scratch */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _e0 = new THREE.Euler();
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _box = new THREE.Box3();
const _sph = new THREE.Sphere();
const UP = new THREE.Vector3(0, 1, 0);
// Dedicated to orientedFootprint() so it can never alias a caller's scratch.
const _fpVec = new THREE.Vector3();
const _fpQuat = new THREE.Quaternion();
const _fpOut = { w: 0, l: 0, h: 0, baseY: 0 };
// Dedicated to the composition pass, for the same reason: it runs inside the
// scatter loop, which is already holding _v0 and _q0.
const _zoneOut = { x: 0, z: 0 };
const _liftVec = new THREE.Vector3();
const _liftQuat = new THREE.Quaternion();
const _liftEuler = new THREE.Euler();

/* ============================================================ geometry kit */

/**
 * World-space box projection. Prop geometry is assembled from a dozen unrelated
 * primitives whose own UV layouts have nothing to do with each other; projecting
 * one set of UVs across the finished part in centimetres is what makes a single
 * tiling material sit on all of it without stretching or seams that matter.
 * @param {THREE.BufferGeometry} geo
 * @param {number} scale UV units per world unit (1 / tileWorld)
 */
function projectUV(geo, scale) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!pos || !nrm) return geo;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let u;
    let v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Flat per-vertex colour. Written through THREE.Color so sRGB hex literals
 *  land in the renderer's linear working space. */
function paint(geo, hex) {
  const n = geo.attributes.position.count;
  _c0.set(hex);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _c0.r;
    arr[i * 3 + 1] = _c0.g;
    arr[i * 3 + 2] = _c0.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Ensure a geometry can be merged with any other: non-indexed, and carrying
 *  exactly position/normal/uv/color. */
function normalize(geo, hex) {
  let g = geo;
  if (g.index) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') g.deleteAttribute(key);
  }
  paint(g, hex);
  return g;
}

/** Apply the placement options every primitive helper accepts. */
function place(geo, o) {
  if (!o) return geo;
  const sx = o.sx ?? o.s ?? 1;
  const sy = o.sy ?? o.s ?? 1;
  const sz = o.sz ?? o.s ?? 1;
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  if (o.rx) geo.rotateX(o.rx);
  if (o.rz) geo.rotateZ(o.rz);
  if (o.ry) geo.rotateY(o.ry);
  if (o.x || o.y || o.z) geo.translate(o.x || 0, o.y || 0, o.z || 0);
  return geo;
}

/**
 * The builder handed to every model. Each call appends one primitive, already
 * tinted and positioned, to the part list for a named material.
 */
class PartBuilder {
  constructor(rng, quality) {
    this.parts = [];
    this.rng = rng;
    this.q = quality; // 0 = low, 1 = medium, 2 = high — drives segment counts
  }

  push(mat, geo, hex, o) {
    place(geo, o);
    this.parts.push({ mat, geo: normalize(geo, hex ?? 0xffffff) });
    return this;
  }

  /** Rounded box. Every box in this file is rounded: a sharp 90° corner on a
   *  centimetre-scale object is the fastest way to look untextured. */
  box(mat, w, h, d, o = {}) {
    const r = clamp(o.radius ?? Math.min(w, h, d) * 0.09, 0.008, Math.min(w, h, d) * 0.49);
    const seg = o.seg ?? (this.q > 1 ? 3 : 2);
    return this.push(mat, new RoundedBoxGeometry(w, h, d, seg, r), o.c, o);
  }

  /** Hard-edged box, for things that really are sharp (paper, thin panels). */
  slab(mat, w, h, d, o = {}) {
    return this.push(mat, new THREE.BoxGeometry(w, h, d), o.c, o);
  }

  cyl(mat, rt, rb, h, o = {}) {
    const seg = o.seg ?? (this.q > 1 ? 24 : this.q > 0 ? 16 : 10);
    return this.push(mat, new THREE.CylinderGeometry(rt, rb, h, seg, o.hseg ?? 1, !!o.open), o.c, o);
  }

  sphere(mat, r, o = {}) {
    const w = o.seg ?? (this.q > 1 ? 26 : this.q > 0 ? 18 : 12);
    return this.push(mat, new THREE.SphereGeometry(r, w, Math.max(6, w >> 1), o.phiStart ?? 0,
      o.phiLength ?? TAU, o.thetaStart ?? 0, o.thetaLength ?? Math.PI), o.c, o);
  }

  torus(mat, r, tube, o = {}) {
    const rad = o.seg ?? (this.q > 1 ? 12 : 8);
    const tub = o.tseg ?? (this.q > 1 ? 28 : 18);
    return this.push(mat, new THREE.TorusGeometry(r, tube, rad, tub, o.arc ?? TAU), o.c, o);
  }

  /** Surface of revolution from a flat [x0,y0, x1,y1, ...] profile in cm. */
  lathe(mat, profile, o = {}) {
    const pts = [];
    for (let i = 0; i < profile.length; i += 2) pts.push(new THREE.Vector2(profile[i], profile[i + 1]));
    const seg = o.seg ?? (this.q > 1 ? 30 : this.q > 0 ? 20 : 12);
    return this.push(mat, new THREE.LatheGeometry(pts, seg, o.phiStart ?? 0, o.phiLength ?? TAU), o.c, o);
  }

  /** Extrude a closed 2D outline (array of [x,y]) along +Z, then centre it. */
  extrude(mat, outline, depth, o = {}) {
    const shape = new THREE.Shape();
    shape.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
    shape.closePath();
    const bevel = o.bevel ?? Math.min(depth * 0.2, 0.12);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(0.01, depth - bevel * 2),
      bevelEnabled: bevel > 0.005,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: this.q > 1 ? 2 : 1,
      curveSegments: o.curveSegments ?? (this.q > 1 ? 8 : 4),
    });
    geo.translate(0, 0, -depth * 0.5 + bevel);
    return this.push(mat, geo, o.c, o);
  }

  /** Sweep a tube through a list of [x,y,z] control points. */
  tube(mat, points, radius, o = {}) {
    const pts = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, !!o.closed, o.curveType || 'catmullrom', 0.5);
    const tubular = o.tubular ?? Math.max(8, Math.round(pts.length * (this.q > 1 ? 6 : 3)));
    const radial = o.radial ?? (this.q > 1 ? 12 : 7);
    return this.push(mat, new THREE.TubeGeometry(curve, tubular, radius, radial, !!o.closed), o.c, o);
  }

  /** A regular prism — hex bolt heads, pencil barrels, nuts. */
  prism(mat, sides, r, h, o = {}) {
    return this.push(mat, new THREE.CylinderGeometry(o.rt ?? r, r, h, sides, 1, false), o.c, o);
  }
}

/* ========================================================= prop materials */

// Each key maps onto a Surfaces kind plus the handful of overrides that turn a
// generic surface into a specific object's material. `uv` multiplies the
// projection density: bread wants a far finer grain than the 30 cm sand tile it
// borrows its texture from.
const MAT_SPECS = {
  cardboard:     { kind: 'cardboard', uv: 1.0 },
  paper:         { kind: 'paper', uv: 1.0 },
  oakWood:       { kind: 'oak', uv: 1.0 },
  pineWood:      { kind: 'pine', uv: 1.0 },
  varnishedWood: { kind: 'varnishedWood', uv: 1.0 },
  laminateWood:  { kind: 'laminate', uv: 1.0 },
  steel:         { kind: 'galvanisedSteel', uv: 1.4, roughness: 0.42, metalness: 1 },
  aluminium:     { kind: 'brushedAluminium', uv: 1.6, roughness: 0.38, metalness: 1 },
  chrome:        { kind: 'chromePlate', uv: 2.0, roughness: 0.10, metalness: 1 },
  plasticGloss:  { kind: 'plasticGloss', uv: 1.0 },
  plasticMatte:  { kind: 'plasticMatte', uv: 1.0 },
  rubber:        { kind: 'rubber', uv: 1.2 },
  // Glazed ceramic is gloss plastic's shader with the normal flattened and the
  // clearcoat pushed: a fired glaze is smoother than any moulded polymer.
  ceramic:       { kind: 'plasticGloss', uv: 0.7, normalScale: 0.25, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.35 },
  terracotta:    { kind: 'concrete', uv: 2.6, normalScale: 1.25, roughness: 0.94, color: 0xd08050 },
  felt:          { kind: 'poolFelt', uv: 1.0 },
  wax:           { kind: 'plasticMatte', uv: 1.3, normalScale: 0.45, roughness: 0.62, clearcoat: 0.3, clearcoatRoughness: 0.5 },
  chalk:         { kind: 'concrete', uv: 3.4, normalScale: 0.9, roughness: 0.99 },
  bread:         { kind: 'sand', uv: 3.2, normalScale: 1.5, roughness: 0.95 },
  soilMat:       { kind: 'soil', uv: 1.4 },
  gravelMat:     { kind: 'gravel', uv: 1.2 },
  fabric:        { kind: 'carpet', uv: 1.1, normalScale: 0.7 },
  foliage:       { kind: 'grass', uv: 1.2, sway: 0.55, side: THREE.DoubleSide, normalScale: 0.6 },
  glassMat:      { special: 'glass', uv: 1.0 },
  chromeShine:   { special: 'chrome', uv: 1.0 },
};

const _matCache = new Map();
const _swayMats = [];

/**
 * Rebuild a Materials.js material as an independent, vertex-coloured, per-instance
 * varying sibling.
 *
 * Cloning is not an option: THREE.Material.copy() deliberately does not carry
 * `onBeforeCompile` or `customProgramCacheKey`, and it JSON round-trips userData,
 * which would silently strip the uniform objects Materials.js relies on. So the
 * PBR state is copied through the subclass's own copy() (which does bring every
 * map across, keeping the single shared GPU upload), and the shader injection is
 * re-attached explicitly and composed with ours.
 */
function propVariant(base, spec, key) {
  const m = new base.constructor();
  m.copy(base);
  m.userData = {};
  m.name = 'prop:' + key;
  m.vertexColors = true;
  m.transparent = spec.transparent ?? false;
  m.depthWrite = true;
  m.polygonOffset = false;
  m.alphaTest = spec.alphaTest ?? (spec.side === THREE.DoubleSide ? base.alphaTest : 0);
  if (spec.side !== undefined) m.side = spec.side;
  if (spec.color !== undefined) m.color.set(spec.color);
  if (spec.roughness !== undefined) m.roughness = spec.roughness;
  if (spec.metalness !== undefined) m.metalness = spec.metalness;
  if (spec.envMapIntensity !== undefined) m.envMapIntensity = spec.envMapIntensity;
  if (spec.normalScale !== undefined && m.normalScale) m.normalScale.set(spec.normalScale, spec.normalScale);
  if (spec.clearcoat !== undefined && 'clearcoat' in m) {
    m.clearcoat = spec.clearcoat;
    m.clearcoatRoughness = spec.clearcoatRoughness ?? 0.08;
  }

  const baseCompile = base.onBeforeCompile;
  const baseKey = typeof base.customProgramCacheKey === 'function' ? base.customProgramCacheKey() : '';
  const uniforms = {
    uPropTime: { value: 0 },
    uPropVary: { value: spec.vary ?? 0.16 },
    uPropSway: { value: spec.sway ?? 0 },
  };
  m.userData.propUniforms = uniforms;

  m.onBeforeCompile = (shader, renderer) => {
    // Materials.js gets first refusal so its macro-variation and triplanar
    // injections land exactly as they would on the original material.
    if (typeof baseCompile === 'function') baseCompile.call(base, shader, renderer);
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPropSeed;
varying float vPropSeed;
uniform float uPropTime;
uniform float uPropSway;
vec2 mgPropUvOffset( float s ) {
  return vec2( fract( sin( s * 12.9898 ) * 43758.5453 ), fract( sin( s * 78.233 + 4.1 ) * 43758.5453 ) );
}`)
      // vMapUv and friends are assigned by <uv_vertex>; shifting them here is the
      // only place a per-instance texture offset can be applied, because a
      // varying is read-only in the fragment stage.
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vPropSeed = aPropSeed;
{
  vec2 mgOff = mgPropUvOffset( aPropSeed );
  #ifdef USE_MAP
    vMapUv += mgOff;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv += mgOff;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv += mgOff;
  #endif
  #ifdef USE_METALNESSMAP
    vMetalnessMapUv += mgOff;
  #endif
  #ifdef USE_AOMAP
    vAoMapUv += mgOff;
  #endif
}`);

    if ((spec.sway ?? 0) > 0) {
      // Foliage only: a two-frequency shear that grows with height above the
      // prop's own base, so blades bend and the root stays planted.
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float mgH = max( transformed.y, 0.0 );
  float mgP = aPropSeed * 6.2831;
  float mgW = sin( uPropTime * 1.7 + mgP ) * 0.62 + sin( uPropTime * 3.9 + mgP * 2.3 ) * 0.38;
  transformed.x += mgW * uPropSway * mgH * mgH * 0.055;
  transformed.z += cos( uPropTime * 1.3 + mgP * 1.7 ) * uPropSway * mgH * mgH * 0.035;
}`);
    }

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPropSeed;\nuniform float uPropVary;')
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float mgS = fract( sin( vPropSeed * 21.17 + 0.3 ) * 4173.31 ) - 0.5;
  // A single multiply gives both a value shift and a slight warm/cool drift, so
  // a row of identical objects stops reading as a copy-paste.
  diffuseColor.rgb *= 1.0 + mgS * uPropVary * vec3( 1.06, 1.0, 0.90 );
}`)
      .replace('#include <normal_fragment_begin>', `{
  float mgR = fract( sin( vPropSeed * 91.7 + 2.9 ) * 2941.7 ) - 0.5;
  roughnessFactor = clamp( roughnessFactor * ( 1.0 + mgR * 0.22 ), 0.02, 1.0 );
}
#include <normal_fragment_begin>`);
  };

  m.customProgramCacheKey = () => 'mgprop:' + key + '|' + baseKey;
  m.needsUpdate = true;
  if ((spec.sway ?? 0) > 0) _swayMats.push(uniforms);
  return m;
}

/** Cached material for a prop material key. Never throws and never returns null. */
export function propMaterial(key) {
  const hit = _matCache.get(key);
  if (hit) return hit;
  const spec = MAT_SPECS[key] || MAT_SPECS.plasticMatte;
  let base = null;
  try {
    if (spec.special === 'glass') base = Materials?.glass?.({ opacity: 0.34, roughness: 0.05 });
    else if (spec.special === 'chrome') base = Materials?.chrome?.();
    else base = Materials?.surface?.(spec.kind, { normalScale: spec.normalScale ?? 1 });
  } catch (err) {
    console.warn('[Props] material unavailable for', key, err);
  }
  if (!base) {
    base = new THREE.MeshStandardMaterial({ color: 0xb4aea3, roughness: 0.82, metalness: 0 });
  }
  let mat;
  try {
    mat = propVariant(base, spec, key);
  } catch (err) {
    console.warn('[Props] variant failed for', key, err);
    mat = new THREE.MeshStandardMaterial({ color: 0xb4aea3, roughness: 0.82, vertexColors: true });
  }
  _matCache.set(key, mat);
  return mat;
}

/** UV density for a material key, in UV units per centimetre. */
function uvScaleFor(key) {
  const spec = MAT_SPECS[key] || MAT_SPECS.plasticMatte;
  let tile = 40;
  try {
    tile = Surfaces?.tileWorld?.(spec.kind || 'plasticMatte') ?? 40;
  } catch (err) { /* fall through to the default tile size */ }
  return ((spec.uv ?? 1) / Math.max(1, tile));
}

/* ============================================================ the library */

// Sizes are real. A cereal box is 30 cm tall next to a 9 cm car; a pool ball is
// 5.7 cm because that is what a pool ball is. Getting these right is most of
// what sells the miniature illusion — the optics do the rest.

const CRUST = 0x9a6234;
const KRAFT = 0xb98a55;

export const PROP_MODELS = {

  /* ------------------------------------------------------------- kitchen */

  cerealBox: {
    tags: ['kitchen'], collide: 'box', mass: 0.5, restitution: 0.25,
    build(P, rng) {
      const w = 20, h = 30, d = 7;
      P.box('cardboard', w, h, d, { y: h / 2, c: 0xc8382a, radius: 0.55, seg: 3 });
      // Printed panel: a proud inset panel with a band and a "window" reads as
      // packaging at 30 cm far better than a blurred texture would.
      P.slab('cardboard', w - 3.2, h - 6, 0.25, { y: h / 2 + 1.2, z: d / 2 + 0.05, c: 0xf2e2b8 });
      P.slab('cardboard', w - 5.6, 7.5, 0.35, { y: h - 8, z: d / 2 + 0.16, c: 0xe8a02c });
      P.slab('cardboard', w - 8, 4.2, 0.3, { y: 9.5, z: d / 2 + 0.16, c: 0x2f6c4f });
      P.slab('cardboard', w - 3.2, 1.1, 0.3, { y: 4.2, z: d / 2 + 0.16, c: 0x2a2725 });
      P.slab('cardboard', 5.2, 5.2, 0.3, { y: 20.5, z: -d / 2 - 0.14, c: 0xf2e2b8 });
      // Top flaps, slightly ajar.
      P.slab('cardboard', w - 0.6, 0.5, d - 0.6, { y: h + 0.1, ry: 0.02, c: KRAFT });
      P.slab('cardboard', w - 1.2, 3.4, 0.4, { y: h + 1.5, z: -d / 2 + 0.2, rx: -0.34, c: KRAFT });
    },
  },

  milkCarton: {
    tags: ['kitchen'], collide: 'box', mass: 0.4, restitution: 0.2,
    build(P) {
      const s = 9.4, h = 20;
      P.box('paper', s, h, s, { y: h / 2, c: 0xf4f2ec, radius: 0.35, seg: 3 });
      // Gable top: two leaning slabs plus the pinched ridge.
      P.slab('paper', s, 6.6, 0.42, { y: h + 2.7, z: 2.2, rx: -0.62, c: 0xf1efe8 });
      P.slab('paper', s, 6.6, 0.42, { y: h + 2.7, z: -2.2, rx: 0.62, c: 0xeae7df });
      P.slab('paper', s - 0.4, 3.0, 1.5, { y: h + 5.3, c: 0xf4f2ec });
      P.slab('paper', s + 0.06, 5.4, s + 0.06, { y: 6.4, c: 0x2d63a8 });
      P.slab('paper', s + 0.12, 1.0, s + 0.12, { y: 9.6, c: 0xf6f4ee });
      P.slab('paper', 5.2, 3.4, 0.24, { y: 14.5, z: s / 2 + 0.06, c: 0x2d63a8 });
      P.cyl('plasticGloss', 1.45, 1.45, 1.9, { y: h + 4.4, z: 1.5, rx: -0.62, c: 0xe23c2e });
    },
  },

  mug: {
    tags: ['kitchen'], collide: 'cylinder', mass: 0.35, restitution: 0.15,
    build(P) {
      // Profile in cm: foot ring, wall, lip, and back down the inside so the
      // interior is real geometry rather than a one-sided shell.
      P.lathe('ceramic', [
        0.0, 0.0, 3.6, 0.0, 3.9, 0.5, 4.15, 2.2, 4.25, 6.2, 4.15, 8.6, 4.3, 9.2,
        4.05, 9.5, 3.75, 9.1, 3.65, 3.0, 3.5, 1.1, 0.0, 0.9,
      ], { c: 0xf3f1ea, seg: 34 });
      P.torus('ceramic', 2.55, 0.62, { x: 4.9, y: 6.0, rx: Math.PI / 2, ry: 0, c: 0xf3f1ea, sx: 1, sz: 0.72 });
      P.cyl('plasticMatte', 3.62, 3.62, 0.12, { y: 8.05, c: 0x3f2416 });
      P.torus('plasticMatte', 3.2, 0.16, { y: 8.1, rx: Math.PI / 2, c: 0x8a6038, sx: 1, sy: 1, sz: 0.5 });
    },
  },

  toast: {
    tags: ['kitchen'], collide: 'box', mass: 0.06, restitution: 0.05, knockable: true,
    build(P) {
      // A slice: crumb slab, crust rim, and the domed shoulder a real slice has.
      P.box('bread', 10.6, 1.5, 10.2, { y: 0.75, c: 0xe7c184, radius: 0.5, seg: 3 });
      P.box('bread', 10.9, 1.62, 10.5, { y: 0.78, c: CRUST, radius: 0.62, sy: 0.98, seg: 3 });
      P.box('bread', 9.6, 1.68, 9.2, { y: 0.8, c: 0xefcf9a, radius: 0.42, seg: 3 });
      P.cyl('bread', 4.6, 4.6, 1.7, { y: 0.85, z: -4.1, rx: Math.PI / 2, sy: 1, sz: 0.42, c: CRUST, seg: 22 });
      P.box('bread', 8.4, 0.22, 8.0, { y: 1.56, c: 0xd7a765, radius: 0.1 });
    },
  },

  sugarCube: {
    tags: ['kitchen'], collide: 'box', mass: 0.02, restitution: 0.1, knockable: true,
    build(P) { P.box('chalk', 1.75, 1.5, 1.75, { y: 0.75, c: 0xf7f6f2, radius: 0.12, seg: 2 }); },
  },

  cutleryFork: {
    tags: ['kitchen'], collide: 'box', mass: 0.12, restitution: 0.3,
    build(P) {
      P.box('chromeShine', 1.55, 0.42, 11.5, { y: 0.21, z: 1.0, c: 0xe8ebee, radius: 0.16 });
      P.box('chromeShine', 2.35, 0.36, 4.2, { y: 0.2, z: -6.6, c: 0xe8ebee, radius: 0.14, sy: 1.15 });
      for (let i = 0; i < 4; i++) {
        P.box('chromeShine', 0.4, 0.3, 4.4, { x: -0.9 + i * 0.6, y: 0.2, z: 9.0, c: 0xe8ebee, radius: 0.1 });
      }
      P.box('chromeShine', 2.0, 0.34, 1.6, { y: 0.2, z: 6.6, c: 0xe8ebee, radius: 0.14 });
    },
  },

  cutleryKnife: {
    tags: ['kitchen'], collide: 'box', mass: 0.14, restitution: 0.3,
    build(P) {
      P.box('chromeShine', 1.5, 0.9, 8.0, { y: 0.45, z: -6.0, c: 0xdfe3e7, radius: 0.4 });
      P.box('chromeShine', 1.35, 0.45, 5.0, { y: 0.24, z: -0.4, c: 0xe8ebee, radius: 0.16 });
      P.box('chromeShine', 2.2, 0.3, 8.6, { y: 0.16, z: 6.4, c: 0xeef1f4, radius: 0.1, sy: 1 });
      P.box('chromeShine', 1.4, 0.22, 2.4, { y: 0.14, z: 11.4, c: 0xeef1f4, radius: 0.09 });
    },
  },

  cutlerySpoon: {
    tags: ['kitchen'], collide: 'box', mass: 0.11, restitution: 0.3,
    build(P) {
      P.box('chromeShine', 1.5, 0.4, 11.0, { y: 0.2, z: -1.4, c: 0xe8ebee, radius: 0.16 });
      P.box('chromeShine', 2.3, 0.34, 4.0, { y: 0.19, z: -8.0, c: 0xe8ebee, radius: 0.14, sy: 1.2 });
      // Bowl: a squashed hemisphere shell, opening upward.
      P.sphere('chromeShine', 2.0, {
        y: 0.62, z: 6.4, sy: 0.52, sz: 1.5, c: 0xf0f3f6,
        thetaStart: Math.PI * 0.5, thetaLength: Math.PI * 0.5,
      });
      P.sphere('chromeShine', 1.86, {
        y: 0.72, z: 6.4, sy: 0.5, sz: 1.5, c: 0xdfe4e9,
        thetaStart: Math.PI * 0.5, thetaLength: Math.PI * 0.5,
      });
    },
  },

  jamJar: {
    tags: ['kitchen', 'workbench'], collide: 'cylinder', mass: 0.3, restitution: 0.1,
    build(P) {
      P.lathe('glassMat', [
        0.0, 0.0, 3.1, 0.0, 3.3, 0.4, 3.35, 5.4, 3.05, 6.6, 2.75, 6.9, 2.75, 8.0,
        2.5, 8.05, 2.5, 6.7, 2.85, 6.3, 3.05, 5.2, 3.05, 0.5, 0.0, 0.5,
      ], { c: 0xdfe9e6, seg: 30 });
      P.lathe('plasticGloss', [0.0, 0.35, 2.9, 0.35, 2.95, 5.6, 2.6, 6.4, 0.0, 6.5],
        { c: 0x8e1b23, seg: 26 });
      P.cyl('steel', 2.95, 2.9, 1.5, { y: 8.4, c: 0xc23a2c, seg: 26 });
      P.torus('steel', 2.9, 0.16, { y: 8.05, rx: Math.PI / 2, c: 0xa8301f });
      P.cyl('paper', 3.12, 3.12, 3.1, { y: 3.2, c: 0xf0e3c6, seg: 26, open: true });
      P.cyl('paper', 3.14, 3.14, 0.9, { y: 4.1, c: 0x8e1b23, seg: 26, open: true });
    },
  },

  cerealBowl: {
    tags: ['kitchen'], collide: 'cylinder', mass: 0.5, restitution: 0.1,
    build(P, rng) {
      P.lathe('ceramic', [
        0.0, 0.0, 3.2, 0.0, 3.5, 0.4, 4.8, 1.6, 6.8, 4.4, 7.4, 6.2, 7.55, 6.5,
        7.15, 6.5, 7.0, 6.0, 6.4, 4.4, 4.4, 1.7, 3.0, 0.85, 0.0, 0.85,
      ], { c: 0xf1efe8, seg: 34 });
      P.cyl('plasticGloss', 6.5, 4.2, 0.2, { y: 4.6, c: 0xf6f4ec, seg: 30 });
      for (let i = 0; i < 9; i++) {
        const a = rng.next() * TAU;
        const r = 1.2 + rng.next() * 4.3;
        P.box('bread', 1.5, 0.32, 1.2, {
          x: Math.cos(a) * r, y: 4.72 + rng.next() * 0.2, z: Math.sin(a) * r,
          ry: rng.next() * TAU, rx: rng.range(-0.3, 0.3), c: 0xd8952f, radius: 0.12,
        });
      }
    },
  },

  cornflake: {
    tags: ['kitchen'], collide: null, mass: 0.005, knockable: true,
    build(P) {
      P.sphere('bread', 1.05, { y: 0.16, sy: 0.19, sz: 0.78, c: 0xd0912e, seg: 12 });
      P.sphere('bread', 0.72, { y: 0.24, x: 0.2, sy: 0.16, sz: 0.8, c: 0xe0a63c, seg: 10 });
    },
  },

  eggShell: {
    tags: ['kitchen'], collide: 'sphere', mass: 0.05, restitution: 0.2, knockable: true,
    build(P) {
      P.sphere('ceramic', 2.4, { y: 1.5, sy: 1.28, c: 0xf6ece0, thetaStart: Math.PI * 0.42, thetaLength: Math.PI * 0.58 });
      P.sphere('ceramic', 2.24, { y: 1.5, sy: 1.28, c: 0xd8c6b2, thetaStart: Math.PI * 0.42, thetaLength: Math.PI * 0.58 });
    },
  },

  // The die-cast carry case the cars came out of: eight moulded pockets, every
  // one of them empty, and the lid thrown back onto its hinge stop.
  //
  // This is the one object on a breakfast table that answers the question the
  // whole premise asks — why is there a racetrack on it — so it is modelled to
  // be *named* at establishing distance rather than merely seen. Three things do
  // that work. The shell is built as a rim and a floor rather than a solid box,
  // because a capped-off block reads as a lunchbox and only an open well reads
  // as a case. The pockets are sized against the cars they are missing, 6.6 u
  // across and 12.3 long against a 4.15 x 9.5 car, so the eye can tell what
  // belongs in them. And there are exactly eight, which is the size of the
  // field: everything that lived here is out on the circuit.
  //
  // 30.6 u tall with the lid up, i.e. a cereal box, so it obeys the same
  // placement discipline every tall prop here does.
  carCase: {
    tags: ['kitchen', 'bedroom'], collide: 'box', mass: 1.2, restitution: 0.3,
    build(P) {
      const W = 30;        // across the pockets
      const D = 28;        // hinge to front lip
      const H = 7.5;       // shell height
      const LID = 26;      // hinge to lid edge
      const OPEN = -2.05;  // 27 degrees past vertical — where a stiff hinge stops
      const SHELL = 0xd23a2c;
      const TRAY = 0xe8b93a;
      const zF = D / 2;
      const zB = -D / 2;

      // Floor and four walls.
      P.box('plasticGloss', W, 1.5, D, { y: 0.75, c: SHELL, radius: 0.4, seg: 3 });
      P.box('plasticGloss', W, H, 1.7, { y: H / 2, z: zF - 0.85, c: SHELL, radius: 0.35, seg: 3 });
      P.box('plasticGloss', W, H, 1.7, { y: H / 2, z: zB + 0.85, c: SHELL, radius: 0.35, seg: 3 });
      P.box('plasticGloss', 1.7, H, D, { y: H / 2, x: -W / 2 + 0.85, c: SHELL, radius: 0.35, seg: 3 });
      P.box('plasticGloss', 1.7, H, D, { y: H / 2, x: W / 2 - 0.85, c: SHELL, radius: 0.35, seg: 3 });

      // The moulded tray, sunk 5.5 u below the rim, and the ribs that divide it
      // into four columns of two.
      const iw = W - 3.4;
      const id = D - 3.4;
      P.slab('plasticGloss', iw, 0.5, id, { y: 1.75, c: TRAY });
      for (let i = 1; i < 4; i++) {
        P.slab('plasticGloss', 0.6, 3.0, id, { x: -iw / 2 + i * (iw / 4), y: 3.5, c: TRAY });
      }
      P.slab('plasticGloss', iw, 3.0, 0.6, { y: 3.5, c: TRAY });

      // Lid, hinged along the back top edge. Its own long axis in world space is
      // (0, -sin, cos) after the rotation and its inner face points along
      // (0, -cos, -sin); everything mounted on the lid is positioned by walking
      // those two vectors out from the hinge, so the panel can never drift off
      // the panel it is printed on however the angle is retuned.
      const ax = -Math.sin(OPEN);   // lid length, world Y component
      const az = Math.cos(OPEN);    // lid length, world Z component
      const ny = -Math.cos(OPEN);   // inner face normal, world Y
      const nz = -Math.sin(OPEN);   // inner face normal, world Z
      P.box('plasticGloss', W, 1.4, LID, {
        y: H + ax * LID * 0.5, z: zB + az * LID * 0.5, rx: OPEN, c: SHELL, radius: 0.35, seg: 2,
      });
      P.slab('plasticGloss', W - 4, 0.35, LID - 4, {
        y: H + ax * LID * 0.5 + ny, z: zB + az * LID * 0.5 + nz, rx: OPEN, c: 0xf2e8d0,
      });
      P.slab('plasticGloss', W - 4, 0.3, 5.0, {
        y: H + ax * LID * 0.72 + ny * 1.35, z: zB + az * LID * 0.72 + nz * 1.35, rx: OPEN, c: 0x2f6ea8,
      });

      // Carry handle across the front, and the two latches the lid closes onto.
      P.tube('plasticMatte', [
        [-7.5, 5.2, zF + 0.4], [-7.0, 9.4, zF + 1.6], [0, 10.4, zF + 1.9],
        [7.0, 9.4, zF + 1.6], [7.5, 5.2, zF + 0.4],
      ], 0.75, { c: 0x2c2f33, tubular: 36, radial: 8 });
      P.box('chrome', 3.2, 1.6, 1.2, { x: -10.5, y: 6.4, z: zF + 0.7, c: 0xcfd5da, radius: 0.24 });
      P.box('chrome', 3.2, 1.6, 1.2, { x: 10.5, y: 6.4, z: zF + 0.7, c: 0xcfd5da, radius: 0.24 });
    },
  },

  /* -------------------------------------------------------------- garden */

  plantPot: {
    tags: ['garden'], collide: 'cylinder', mass: 2.2, restitution: 0.1,
    build(P, rng) {
      P.lathe('terracotta', [
        0.0, 0.0, 7.4, 0.0, 7.8, 0.6, 9.9, 16.0, 10.1, 16.4, 11.3, 16.6, 11.4, 19.4,
        11.2, 19.8, 10.0, 19.6, 9.9, 17.4, 9.6, 17.0, 8.0, 3.2, 0.0, 2.6,
      ], { c: 0xc4703f, seg: 32 });
      P.cyl('soilMat', 9.5, 9.2, 1.4, { y: 17.4, c: 0x54402c, seg: 28 });
      // A few broad leaves fanning out of the soil. Foliage sways in the shader.
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + rng.range(-0.2, 0.2);
        const lean = 0.55 + rng.next() * 0.5;
        P.extrude('foliage', [
          [0, 0], [1.6, 3.4], [2.1, 8.0], [0.9, 12.4], [0, 13.6],
          [-0.9, 12.4], [-2.1, 8.0], [-1.6, 3.4],
        ], 0.22, {
          x: Math.cos(a) * 2.0, y: 17.8, z: Math.sin(a) * 2.0,
          rx: -Math.PI / 2 + lean * Math.cos(a) * 0, ry: a, rz: 0,
          c: i % 2 ? 0x4d8a34 : 0x639c3d, bevel: 0.03,
        });
      }
      P.sphere('plasticGloss', 1.5, { y: 30.5, sy: 0.7, c: 0xe0533b, seg: 14 });
    },
  },

  seedPacket: {
    tags: ['garden'], collide: 'box', mass: 0.04, restitution: 0.1, knockable: true,
    build(P) {
      P.box('paper', 8.4, 12.0, 0.7, { y: 6.0, c: 0xe8dcc0, radius: 0.16, seg: 2 });
      P.slab('paper', 6.6, 5.4, 0.16, { y: 8.4, z: 0.42, c: 0x3f7fa8 });
      P.slab('paper', 6.6, 0.8, 0.16, { y: 4.6, z: 0.42, c: 0xd0512c });
      P.slab('paper', 5.0, 0.5, 0.16, { y: 3.2, z: 0.42, c: 0x4b4740 });
      P.slab('paper', 8.4, 1.4, 0.72, { y: 11.6, c: 0xd6c8a6 });
    },
  },

  trowel: {
    tags: ['garden'], collide: 'box', mass: 0.35, restitution: 0.3,
    build(P) {
      P.box('oakWood', 2.4, 2.4, 7.6, { y: 1.3, z: -7.0, c: 0x8a5a30, radius: 0.9, seg: 3 });
      P.cyl('steel', 0.55, 0.55, 3.0, { y: 1.1, z: -2.4, rx: Math.PI / 2, c: 0xb9bec3 });
      P.sphere('steel', 3.4, {
        y: 1.35, z: 4.6, sx: 1.15, sy: 0.34, sz: 1.9, c: 0xc7ccd1,
        thetaStart: Math.PI * 0.5, thetaLength: Math.PI * 0.5,
      });
      P.sphere('steel', 3.2, {
        y: 1.5, z: 4.6, sx: 1.15, sy: 0.32, sz: 1.9, c: 0x9aa1a8,
        thetaStart: Math.PI * 0.5, thetaLength: Math.PI * 0.5,
      });
      P.box('steel', 0.9, 0.5, 3.2, { y: 1.5, z: 9.6, c: 0xc7ccd1, radius: 0.24 });
    },
  },

  hoseCoil: {
    tags: ['garden'], collide: 'cylinder', mass: 1.6, restitution: 0.4,
    build(P) {
      // Three loops of a real helix, so the coil has depth instead of reading as
      // stacked doughnuts.
      const pts = [];
      const turns = 2.6;
      for (let i = 0; i <= 96; i++) {
        const t = i / 96;
        const a = t * TAU * turns;
        const r = 13.5 - t * 2.4;
        pts.push([Math.cos(a) * r, 1.35 + t * 2.6, Math.sin(a) * r]);
      }
      P.tube('rubber', pts, 1.35, { c: 0x2f6b45, tubular: 150, radial: 9 });
      P.cyl('plasticGloss', 1.1, 1.1, 3.2, { x: 11.6, y: 1.35, z: 6.0, rx: Math.PI / 2, ry: 0.6, c: 0xd8ba52 });
    },
  },

  wateringCan: {
    tags: ['garden'], collide: 'cylinder', mass: 1.1, restitution: 0.3,
    build(P) {
      P.lathe('steel', [
        0.0, 0.0, 6.4, 0.0, 6.9, 0.7, 7.1, 12.4, 6.4, 14.2, 6.5, 14.8, 6.1, 14.9,
        6.0, 14.0, 6.7, 12.4, 6.6, 1.0, 0.0, 0.9,
      ], { c: 0x3f7f6e, seg: 30 });
      P.cyl('steel', 1.05, 1.9, 14.0, { x: -8.6, y: 8.8, rz: 0.72, rx: 0.0, c: 0x3f7f6e, seg: 18 });
      P.sphere('steel', 2.5, { x: -13.6, y: 13.4, sy: 0.55, c: 0x2f6555, seg: 18 });
      P.torus('steel', 4.4, 0.55, { y: 16.2, z: 1.6, rx: 1.32, c: 0x36705f });
      P.torus('steel', 2.4, 0.5, { x: 6.2, y: 10.0, ry: Math.PI / 2, rx: 0.2, c: 0x36705f });
    },
  },

  pebble: {
    tags: ['garden', 'workbench'], collide: 'sphere', mass: 0.3, restitution: 0.35, knockable: true,
    build(P, rng) {
      P.sphere('gravelMat', 2.1, { y: 1.15, sx: 1.25, sy: 0.72, sz: 0.95, c: 0x9d9587, seg: 16 });
      P.sphere('gravelMat', 1.15, { x: 1.0, y: 1.1, z: 0.5, sy: 0.6, c: 0xa9a294, seg: 12 });
    },
  },

  grassTuft: {
    tags: ['garden'], collide: null, mass: 0, foliage: true,
    build(P, rng) {
      for (let i = 0; i < 9; i++) {
        const a = rng.next() * TAU;
        const h = 3.4 + rng.next() * 3.4;
        const lean = rng.range(-0.42, 0.42);
        P.extrude('foliage', [
          [0.34, 0], [0.22, h * 0.55], [0.05, h], [-0.05, h], [-0.22, h * 0.55], [-0.34, 0],
        ], 0.1, {
          x: Math.cos(a) * rng.range(0.2, 1.5), z: Math.sin(a) * rng.range(0.2, 1.5),
          ry: a, rz: lean, c: i % 3 === 0 ? 0x74a648 : 0x568f34, bevel: 0,
        });
      }
    },
  },

  brickPaver: {
    tags: ['garden'], collide: 'box', mass: 3, restitution: 0.1,
    build(P) {
      P.box('terracotta', 19.0, 5.2, 9.4, { y: 2.6, c: 0xa8523a, radius: 0.42, seg: 3 });
      P.box('terracotta', 17.4, 0.36, 8.0, { y: 5.1, c: 0x93472f, radius: 0.2 });
    },
  },

  leaf: {
    tags: ['garden', 'bedroom'], collide: null, mass: 0.004, knockable: true,
    build(P) {
      P.extrude('foliage', [
        [0, 0], [1.3, 1.4], [2.0, 3.6], [1.5, 5.6], [0, 6.8],
        [-1.5, 5.6], [-2.0, 3.6], [-1.3, 1.4],
      ], 0.14, { rx: -Math.PI / 2, y: 0.09, c: 0x9a7a34, bevel: 0.02 });
    },
  },

  sprinklerHead: {
    tags: ['garden'], collide: 'cylinder', mass: 0.6, restitution: 0.2,
    build(P) {
      P.cyl('plasticGloss', 4.6, 5.4, 1.6, { y: 0.8, c: 0x2f5f3f, seg: 22 });
      P.cyl('plasticGloss', 2.0, 2.6, 5.0, { y: 4.0, c: 0x3a7550, seg: 20 });
      P.torus('plasticGloss', 2.2, 0.5, { y: 6.4, rx: Math.PI / 2, c: 0xd8ba52 });
      P.cyl('chrome', 0.5, 0.5, 3.6, { y: 7.6, rz: 0.5, c: 0xd8dcdf, seg: 12 });
      P.sphere('chrome', 0.85, { x: -1.6, y: 9.2, c: 0xe4e8eb, seg: 12 });
    },
  },

  /* ----------------------------------------------------------- workbench */

  screwdriver: {
    tags: ['workbench'], collide: 'box', mass: 0.22, restitution: 0.3,
    build(P) {
      // Fluted grip: a low-sided prism reads as the moulded ribs at this scale.
      P.prism('plasticGloss', 12, 1.85, 8.4, { z: -6.4, y: 1.85, rx: Math.PI / 2, c: 0xd8342a });
      P.sphere('plasticGloss', 1.85, { z: -10.7, y: 1.85, sz: 0.7, c: 0xd8342a, seg: 16 });
      P.cyl('plasticGloss', 1.3, 1.95, 1.6, { z: -1.4, y: 1.85, rx: Math.PI / 2, c: 0xb52a20 });
      P.cyl('chrome', 0.52, 0.52, 11.0, { z: 5.6, y: 1.85, rx: Math.PI / 2, c: 0xdde2e6, seg: 14 });
      P.box('chrome', 1.5, 0.28, 1.5, { z: 11.4, y: 1.85, c: 0xc9d0d6, radius: 0.1 });
    },
  },

  wrench: {
    tags: ['workbench'], collide: 'box', mass: 0.42, restitution: 0.35,
    build(P) {
      P.extrude('steel', [
        [-1.05, -9.2], [1.05, -9.2], [0.85, -3.0], [2.6, -1.2], [3.1, 1.4],
        [1.9, 2.6], [1.2, 1.9], [1.2, 0.7], [-1.2, 0.7], [-1.2, 1.9],
        [-1.9, 2.6], [-3.1, 1.4], [-2.6, -1.2], [-0.85, -3.0],
      ], 0.85, { rx: -Math.PI / 2, y: 0.44, c: 0xb9c0c6, bevel: 0.13 });
      P.extrude('steel', [
        [-1.05, 9.2], [1.05, 9.2], [0.9, 4.4], [2.4, 3.0], [2.9, 0.8],
        [1.6, -0.4], [-1.6, -0.4], [-2.9, 0.8], [-2.4, 3.0], [-0.9, 4.4],
      ], 0.85, { rx: -Math.PI / 2, ry: Math.PI, y: 0.44, z: 12.0, c: 0xb9c0c6, bevel: 0.13 });
      P.box('steel', 1.7, 0.7, 6.0, { y: 0.44, z: 4.0, c: 0xa9b1b8, radius: 0.3 });
    },
  },

  bolt: {
    tags: ['workbench'], collide: 'cylinder', mass: 0.05, restitution: 0.25, knockable: true,
    build(P) {
      P.prism('steel', 6, 1.6, 1.15, { y: 0.58, c: 0xa8b0b7 });
      P.cyl('steel', 1.15, 1.05, 0.28, { y: 1.2, c: 0x9aa2a9, seg: 14 });
      P.cyl('steel', 0.82, 0.82, 5.6, { y: 4.0, c: 0xb4bcc3, seg: 14 });
      // Thread: five shallow rings, enough to catch a highlight.
      for (let i = 0; i < 6; i++) {
        P.torus('steel', 0.84, 0.13, { y: 1.9 + i * 0.85, rx: Math.PI / 2, c: 0x99a1a8, seg: 6, tseg: 12 });
      }
    },
  },

  nut: {
    tags: ['workbench'], collide: 'cylinder', mass: 0.02, restitution: 0.2, knockable: true,
    build(P) {
      P.prism('steel', 6, 1.5, 1.2, { y: 0.6, c: 0xa2aab1 });
      P.cyl('plasticMatte', 0.78, 0.78, 1.4, { y: 0.6, c: 0x2e3236, seg: 12 });
    },
  },

  paintTin: {
    tags: ['workbench'], collide: 'cylinder', mass: 1.8, restitution: 0.2,
    build(P) {
      P.lathe('steel', [
        0.0, 0.0, 5.6, 0.0, 6.0, 0.5, 6.0, 12.6, 6.35, 13.0, 6.35, 13.6, 5.7, 13.6,
        5.7, 13.1, 5.6, 12.8, 5.6, 0.7, 0.0, 0.6,
      ], { c: 0xb9bfc4, seg: 28 });
      P.cyl('steel', 6.1, 6.1, 0.6, { y: 13.5, c: 0xd8dde1, seg: 28 });
      P.torus('steel', 5.75, 0.28, { y: 13.5, rx: Math.PI / 2, c: 0x9ba2a8 });
      P.cyl('paper', 6.05, 6.05, 8.6, { y: 6.6, c: 0xe8e2d2, seg: 28, open: true });
      P.cyl('paper', 6.07, 6.07, 3.0, { y: 8.6, c: 0x2f6ea8, seg: 28, open: true });
      P.cyl('paper', 6.07, 6.07, 0.7, { y: 4.0, c: 0xd8b23c, seg: 28, open: true });
      // Wire handle, and the drip that says this tin has been opened.
      P.tube('chrome', [[-6.1, 12.4, 0], [-4.6, 17.4, 0], [0, 19.2, 0], [4.6, 17.4, 0], [6.1, 12.4, 0]],
        0.24, { c: 0xc6ccd1, tubular: 40, radial: 7 });
      P.lathe('plasticGloss', [0.0, 0.0, 1.1, 0.0, 1.35, 1.6, 0.9, 4.2, 0.32, 6.4, 0.0, 6.5],
        { x: 4.4, y: 6.6, z: 3.6, c: 0x2f6ea8, seg: 14 });
    },
  },

  springCoil: {
    tags: ['workbench'], collide: 'cylinder', mass: 0.1, restitution: 0.6, knockable: true,
    build(P) {
      const pts = [];
      for (let i = 0; i <= 72; i++) {
        const t = i / 72;
        const a = t * TAU * 5.5;
        pts.push([Math.cos(a) * 1.85, 0.35 + t * 6.4, Math.sin(a) * 1.85]);
      }
      P.tube('chrome', pts, 0.34, { c: 0xc4cad0, tubular: 110, radial: 8 });
    },
  },

  woodOffcut: {
    tags: ['workbench', 'bedroom'], collide: 'box', mass: 1.2, restitution: 0.2,
    build(P) {
      P.box('pineWood', 15.5, 4.0, 7.6, { y: 2.0, c: 0xd6ab73, radius: 0.28, seg: 3 });
      P.box('pineWood', 15.6, 0.3, 7.0, { y: 4.0, c: 0xc59a63, radius: 0.14 });
      P.cyl('pineWood', 0.75, 0.75, 4.2, { x: 3.6, y: 2.0, rx: Math.PI / 2, c: 0x6b4a2b, seg: 14 });
    },
  },

  tapeRoll: {
    tags: ['workbench', 'bedroom'], collide: 'cylinder', mass: 0.35, restitution: 0.4,
    build(P) {
      P.lathe('rubber', [3.2, 0.0, 5.6, 0.0, 5.6, 3.8, 3.2, 3.8, 3.2, 0.0], { c: 0x2b2c2e, seg: 30 });
      P.cyl('cardboard', 3.2, 3.2, 3.9, { y: 1.95, c: 0xb08a58, seg: 26, open: true });
      P.cyl('rubber', 5.75, 5.75, 0.6, { y: 3.5, c: 0x3a3c3f, seg: 30, open: true });
    },
  },

  oilCan: {
    tags: ['workbench'], collide: 'cylinder', mass: 0.5, restitution: 0.25,
    build(P) {
      P.lathe('steel', [0.0, 0.0, 4.2, 0.0, 4.5, 0.6, 4.5, 6.2, 3.4, 7.6, 1.2, 8.2, 0.0, 8.3],
        { c: 0x8f2d24, seg: 26 });
      P.cyl('chrome', 0.34, 0.85, 9.0, { y: 12.2, rz: -0.42, x: -1.9, c: 0xc4cad0, seg: 14 });
      P.cyl('steel', 4.55, 4.55, 2.4, { y: 3.4, c: 0xd8d2c0, seg: 26, open: true });
      P.torus('steel', 2.6, 0.4, { y: 1.4, z: -4.2, rx: 0.3, ry: 0, c: 0x7a251d, sy: 0.7 });
    },
  },

  sandpaperSheet: {
    tags: ['workbench'], collide: null, mass: 0.01, knockable: true,
    build(P) {
      P.box('gravelMat', 11.0, 0.16, 14.0, { y: 0.08, c: 0xa06a3c, radius: 0.06 });
      P.box('paper', 10.8, 0.1, 13.8, { y: -0.02, c: 0xd8c8a8, radius: 0.05 });
    },
  },

  /* ---------------------------------------------------------------- pool */

  poolBall: {
    tags: ['pool'], collide: 'sphere', mass: 0.16, restitution: 0.86, knockable: true, roll: true,
    build(P) {
      P.sphere('plasticGloss', 2.86, { y: 2.86, c: 0xffffff, seg: 30 });
      // Number spot: two discs, one either side, sunk a hair into the surface.
      P.cyl('plasticGloss', 1.05, 1.05, 0.06, { y: 5.68, c: 0xf7f4ec, seg: 18 });
      P.cyl('plasticGloss', 1.05, 1.05, 0.06, { y: 0.04, c: 0xf7f4ec, seg: 18 });
    },
  },

  poolBallStripe: {
    tags: ['pool'], collide: 'sphere', mass: 0.16, restitution: 0.86, knockable: true, roll: true,
    build(P) {
      P.sphere('plasticGloss', 2.86, { y: 2.86, c: 0xf7f4ec, seg: 30 });
      // The stripe is a band of the sphere, not a decal: it catches its own
      // highlight and survives any camera angle.
      P.sphere('plasticGloss', 2.875, {
        y: 2.86, c: 0xffffff, seg: 30, thetaStart: Math.PI * 0.32, thetaLength: Math.PI * 0.36,
      });
      P.cyl('plasticGloss', 1.05, 1.05, 0.06, { y: 5.7, c: 0xf7f4ec, seg: 18 });
    },
  },

  chalkCube: {
    tags: ['pool'], collide: 'box', mass: 0.02, restitution: 0.1, knockable: true,
    build(P) {
      P.box('chalk', 2.5, 2.4, 2.5, { y: 1.2, c: 0x2b6fa8, radius: 0.14, seg: 2 });
      P.sphere('chalk', 1.9, { y: 3.35, sy: 0.42, c: 0x1f5480, seg: 16 });
      P.box('paper', 2.54, 1.5, 2.54, { y: 0.75, c: 0x3f86bf, radius: 0.1 });
    },
  },

  cueStick: {
    tags: ['pool'], collide: 'box', mass: 2.4, restitution: 0.3,
    build(P) {
      const L = 145;
      P.cyl('varnishedWood', 0.65, 1.55, L * 0.62, { y: 1.6, z: -L * 0.19, rx: Math.PI / 2, c: 0xd8b070, seg: 20 });
      P.cyl('varnishedWood', 1.55, 1.95, L * 0.38, { y: 1.6, z: L * 0.31, rx: Math.PI / 2, c: 0x5a2f1a, seg: 20 });
      P.cyl('rubber', 1.98, 1.98, 9.0, { y: 1.6, z: L * 0.47, rx: Math.PI / 2, c: 0x24211e, seg: 20 });
      P.cyl('chrome', 1.6, 1.6, 1.2, { y: 1.6, z: L * 0.12, rx: Math.PI / 2, c: 0xd0d6da, seg: 20 });
      P.cyl('plasticMatte', 0.66, 0.66, 1.1, { y: 1.6, z: -L * 0.5, rx: Math.PI / 2, c: 0xf0efe8, seg: 16 });
      P.cyl('rubber', 0.64, 0.64, 0.7, { y: 1.6, z: -L * 0.505, rx: Math.PI / 2, c: 0x3d5f80, seg: 16 });
    },
  },

  triangleRack: {
    tags: ['pool'], collide: 'box', mass: 0.8, restitution: 0.3,
    build(P) {
      const s = 34;
      const h = s * Math.sin(Math.PI / 3);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + Math.PI / 6;
        P.box('varnishedWood', s + 3.6, 2.2, 2.4, {
          x: Math.cos(a + Math.PI / 2) * (h / 3), z: Math.sin(a + Math.PI / 2) * (h / 3),
          y: 1.1, ry: -a - Math.PI / 2, c: 0x5a3218, radius: 0.5, seg: 3,
        });
      }
    },
  },

  coaster: {
    tags: ['pool', 'kitchen'], collide: 'cylinder', mass: 0.02, restitution: 0.1, knockable: true,
    build(P) {
      P.cyl('cardboard', 4.6, 4.6, 0.42, { y: 0.21, c: 0xe4d8bc, seg: 26 });
      P.torus('cardboard', 3.6, 0.12, { y: 0.44, rx: Math.PI / 2, c: 0x9c3226, sy: 1, sz: 0.5 });
      P.cyl('cardboard', 2.2, 2.2, 0.06, { y: 0.45, c: 0x9c3226, seg: 20 });
    },
  },

  /* ------------------------------------------------------------- bedroom */

  buildingBlock: {
    tags: ['bedroom'], collide: 'box', mass: 0.12, restitution: 0.4, knockable: true,
    build(P) {
      P.box('oakWood', 5.0, 5.0, 5.0, { y: 2.5, c: 0xd8b070, radius: 0.42, seg: 3 });
      P.slab('oakWood', 3.2, 3.2, 0.12, { y: 2.5, z: 2.52, c: 0xc0392b });
      P.slab('oakWood', 3.2, 3.2, 0.12, { y: 2.5, x: 2.52, ry: Math.PI / 2, c: 0x2874a6 });
      P.slab('oakWood', 3.2, 0.12, 3.2, { y: 5.02, c: 0x1e8449 });
    },
  },

  legoBrick: {
    tags: ['bedroom'], collide: 'box', mass: 0.03, restitution: 0.4, knockable: true,
    build(P) {
      P.box('plasticGloss', 3.2, 1.05, 1.6, { y: 0.53, c: 0xd8241f, radius: 0.08, seg: 2 });
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 2; j++) {
          P.cyl('plasticGloss', 0.24, 0.24, 0.22, {
            x: -1.2 + i * 0.8, z: -0.4 + j * 0.8, y: 1.16, c: 0xd8241f, seg: 12,
          });
        }
      }
    },
  },

  legoBrick2: {
    tags: ['bedroom'], collide: 'box', mass: 0.02, restitution: 0.4, knockable: true,
    build(P) {
      P.box('plasticGloss', 1.6, 1.05, 1.6, { y: 0.53, c: 0x2e86c1, radius: 0.08, seg: 2 });
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          P.cyl('plasticGloss', 0.24, 0.24, 0.22, {
            x: -0.4 + i * 0.8, z: -0.4 + j * 0.8, y: 1.16, c: 0x2e86c1, seg: 12,
          });
        }
      }
    },
  },

  crayon: {
    tags: ['bedroom'], collide: 'cylinder', mass: 0.02, restitution: 0.2, knockable: true, roll: true,
    build(P) {
      P.cyl('wax', 0.44, 0.46, 8.4, { y: 0.46, z: -0.4, rx: Math.PI / 2, c: 0xd8342a, seg: 16 });
      P.cyl('wax', 0.12, 0.46, 1.3, { y: 0.46, z: 4.85, rx: Math.PI / 2, c: 0xc22a20, seg: 16 });
      P.cyl('paper', 0.48, 0.48, 6.2, { y: 0.46, z: -0.9, rx: Math.PI / 2, c: 0xe8523c, seg: 18, open: true });
      P.cyl('paper', 0.49, 0.49, 0.5, { y: 0.46, z: 1.6, rx: Math.PI / 2, c: 0xf6f2e6, seg: 18, open: true });
      P.cyl('paper', 0.49, 0.49, 0.5, { y: 0.46, z: -3.4, rx: Math.PI / 2, c: 0xf6f2e6, seg: 18, open: true });
    },
  },

  book: {
    tags: ['bedroom'], collide: 'box', mass: 1.4, restitution: 0.1,
    build(P) {
      const w = 20, h = 3.4, d = 14;
      P.box('cardboard', w, h * 0.72, d, { y: h * 0.36 + 0.28, c: 0xf0e8d2, radius: 0.1, seg: 2 });
      P.box('fabric', w + 0.7, 0.55, d + 0.7, { y: 0.28, c: 0x2b5f8c, radius: 0.14, seg: 2 });
      P.box('fabric', w + 0.7, 0.55, d + 0.7, { y: h - 0.02, c: 0x2b5f8c, radius: 0.14, seg: 2 });
      P.box('fabric', 1.4, h + 0.3, d + 0.7, { x: -w / 2 - 0.35, y: h / 2, c: 0x23507a, radius: 0.34, seg: 3 });
      P.slab('fabric', 9.0, 0.1, 1.1, { x: 1.0, y: h + 0.24, c: 0xd8b44a });
      P.slab('fabric', 6.0, 0.1, 0.7, { x: -0.5, y: h + 0.24, z: 2.6, c: 0xd8b44a });
    },
  },

  bookStack: {
    tags: ['bedroom'], collide: 'box', mass: 4, restitution: 0.1,
    build(P, rng) {
      const covers = [0x8c3b2b, 0x2b5f8c, 0x3f6b45, 0x6b4a8c];
      let y = 0;
      for (let i = 0; i < 4; i++) {
        const w = 20 - i * 1.4;
        const d = 14 - i * 0.9;
        const h = 2.6 + rng.next() * 1.4;
        const yaw = rng.range(-0.12, 0.12);
        const c = covers[i % covers.length];
        P.box('cardboard', w - 1.2, h * 0.7, d - 1.2, { y: y + h * 0.5, ry: yaw, c: 0xefe6cf, radius: 0.1 });
        P.box('fabric', w, 0.5, d, { y: y + 0.25, ry: yaw, c, radius: 0.12, seg: 2 });
        P.box('fabric', w, 0.5, d, { y: y + h - 0.25, ry: yaw, c, radius: 0.12, seg: 2 });
        P.box('fabric', 1.2, h, d, { x: -w / 2 + 0.2, y: y + h / 2, ry: yaw, c, radius: 0.3, seg: 3 });
        y += h + 0.06;
      }
    },
  },

  gameController: {
    tags: ['bedroom'], collide: 'box', mass: 0.5, restitution: 0.25,
    build(P) {
      // Body: a wide centre with two swept grips, built from overlapping rounded
      // boxes so the silhouette has the pinched waist a real pad has.
      P.box('plasticMatte', 12.4, 3.4, 7.4, { y: 1.9, c: 0x33373d, radius: 1.5, seg: 3 });
      P.box('plasticMatte', 4.6, 3.6, 8.6, { x: -6.0, y: 1.85, z: 1.6, ry: 0.28, c: 0x2d3137, radius: 1.7, seg: 3 });
      P.box('plasticMatte', 4.6, 3.6, 8.6, { x: 6.0, y: 1.85, z: 1.6, ry: -0.28, c: 0x2d3137, radius: 1.7, seg: 3 });
      P.box('plasticMatte', 9.0, 1.6, 2.6, { y: 3.0, z: -3.0, c: 0x24272c, radius: 0.7, seg: 3 });
      // Sticks
      for (const sx of [-3.4, 3.4]) {
        P.cyl('plasticMatte', 1.15, 1.35, 0.5, { x: sx, y: 3.5, z: 1.3, c: 0x22252a, seg: 18 });
        P.cyl('rubber', 0.95, 0.75, 1.0, { x: sx, y: 4.1, z: 1.3, c: 0x1a1c20, seg: 18 });
        P.sphere('rubber', 0.98, { x: sx, y: 4.55, z: 1.3, sy: 0.42, c: 0x26292e, seg: 16 });
      }
      // D-pad and face buttons
      P.box('plasticGloss', 2.6, 0.5, 0.9, { x: -3.6, y: 3.75, z: -1.6, c: 0x1c1f23, radius: 0.16 });
      P.box('plasticGloss', 0.9, 0.5, 2.6, { x: -3.6, y: 3.75, z: -1.6, c: 0x1c1f23, radius: 0.16 });
      const btn = [[3.0, -0.9, 0xd8443a], [4.6, -1.9, 0x3f8fd0], [3.0, -2.9, 0x4fae60], [1.4, -1.9, 0xe0b53c]];
      for (const [bx, bz, bc] of btn) {
        P.cyl('plasticGloss', 0.62, 0.62, 0.42, { x: bx, y: 3.78, z: bz, c: bc, seg: 14 });
      }
      P.cyl('plasticGloss', 0.5, 0.5, 0.3, { y: 3.72, z: -1.2, c: 0x9aa2aa, seg: 14 });
      P.tube('rubber', [[0, 2.6, -3.8], [0, 3.2, -7.5], [2.6, 1.0, -11.5], [7.5, 0.5, -13.5]],
        0.42, { c: 0x2a2d31, tubular: 34, radial: 8 });
    },
  },

  toyDie: {
    tags: ['bedroom', 'pool'], collide: 'box', mass: 0.01, restitution: 0.55, knockable: true,
    build(P) {
      P.box('plasticGloss', 1.7, 1.7, 1.7, { y: 0.85, c: 0xf2efe6, radius: 0.24, seg: 3 });
      const pip = (x, y, z, rx, ry) => P.cyl('plasticGloss', 0.2, 0.2, 0.08, { x, y, z, rx, ry, c: 0x22201e, seg: 10 });
      pip(0, 1.72, 0, 0, 0);
      for (const d of [-0.45, 0.45]) { pip(d, 0.85, 0.86, Math.PI / 2, 0); pip(-d, 0.85, -0.86, Math.PI / 2, 0); }
      for (const a of [-0.45, 0.45]) for (const b of [-0.45, 0.45]) pip(0.86, 0.85 + a, b, 0, 0, 0);
    },
  },

  marble: {
    tags: ['bedroom'], collide: 'sphere', mass: 0.01, restitution: 0.8, knockable: true, roll: true,
    build(P) {
      P.sphere('glassMat', 0.85, { y: 0.85, c: 0xd8ecf2, seg: 20 });
      P.sphere('plasticGloss', 0.42, { y: 0.85, sy: 1.6, sz: 0.28, c: 0x2f7fc8, seg: 14 });
      P.sphere('plasticGloss', 0.38, { y: 0.85, sx: 0.3, sy: 1.5, c: 0xe0a52c, seg: 14 });
    },
  },

  dominoTile: {
    tags: ['bedroom'], collide: 'box', mass: 0.02, restitution: 0.3, knockable: true,
    build(P) {
      P.box('plasticGloss', 2.3, 0.85, 4.6, { y: 0.42, c: 0xf2efe6, radius: 0.14, seg: 2 });
      P.slab('plasticGloss', 2.05, 0.04, 0.14, { y: 0.86, c: 0x22201e });
      for (const z of [-1.6, -0.8, 0.8, 1.6, 2.4]) {
        P.cyl('plasticGloss', 0.2, 0.2, 0.06, { y: 0.87, z, c: 0x22201e, seg: 10 });
      }
    },
  },

  jigsawPiece: {
    tags: ['bedroom'], collide: 'box', mass: 0.01, restitution: 0.2, knockable: true,
    build(P) {
      P.extrude('cardboard', [
        [-2.4, -2.4], [-0.7, -2.4], [-0.7, -3.3], [0.7, -3.3], [0.7, -2.4], [2.4, -2.4],
        [2.4, -0.7], [3.3, -0.7], [3.3, 0.7], [2.4, 0.7], [2.4, 2.4],
        [0.7, 2.4], [0.7, 1.5], [-0.7, 1.5], [-0.7, 2.4], [-2.4, 2.4],
      ], 0.55, { rx: -Math.PI / 2, y: 0.28, c: 0x3f7f9c, bevel: 0.08 });
      P.slab('cardboard', 3.6, 0.06, 3.6, { y: 0.57, c: 0x5aa2bd });
    },
  },

  /* ------------------------------------------------------------- general */

  pencil: {
    tags: ['kitchen', 'workbench', 'bedroom'], collide: 'cylinder', mass: 0.03,
    restitution: 0.25, knockable: true, roll: true,
    build(P) {
      P.prism('plasticGloss', 6, 0.44, 14.4, { y: 0.44, z: -1.0, rx: Math.PI / 2, c: 0xe8b32c });
      P.cyl('pineWood', 0.44, 0.12, 1.7, { y: 0.44, z: 7.05, rx: Math.PI / 2, c: 0xe0c090, seg: 14 });
      P.cyl('plasticMatte', 0.13, 0.10, 0.7, { y: 0.44, z: 7.9, rx: Math.PI / 2, c: 0x2a2724, seg: 10 });
      P.cyl('aluminium', 0.47, 0.47, 1.6, { y: 0.44, z: -8.6, rx: Math.PI / 2, c: 0xc0c6cc, seg: 14 });
      P.cyl('rubber', 0.44, 0.40, 1.2, { y: 0.44, z: -10.0, rx: Math.PI / 2, c: 0xe08a92, seg: 14 });
    },
  },

  eraser: {
    tags: ['workbench', 'bedroom'], collide: 'box', mass: 0.01, restitution: 0.15, knockable: true,
    build(P) {
      P.box('rubber', 4.3, 1.2, 1.9, { y: 0.6, c: 0xe4d8c4, radius: 0.14, seg: 2 });
      P.slab('paper', 2.0, 1.24, 1.94, { y: 0.6, c: 0x3f6fa8 });
    },
  },

  battery: {
    tags: ['workbench', 'bedroom'], collide: 'cylinder', mass: 0.05,
    restitution: 0.3, knockable: true, roll: true,
    build(P) {
      P.cyl('plasticGloss', 0.72, 0.72, 5.0, { y: 0.72, rx: Math.PI / 2, c: 0x2a2c2f, seg: 18 });
      P.cyl('plasticGloss', 0.73, 0.73, 1.5, { y: 0.72, z: -0.6, rx: Math.PI / 2, c: 0xc8a02c, seg: 18, open: true });
      P.cyl('steel', 0.71, 0.71, 0.4, { y: 0.72, z: 2.5, rx: Math.PI / 2, c: 0xc8ccd0, seg: 18 });
      P.cyl('steel', 0.3, 0.3, 0.4, { y: 0.72, z: 2.8, rx: Math.PI / 2, c: 0xd6dade, seg: 12 });
    },
  },

  coin: {
    tags: ['kitchen', 'bedroom', 'pool'], collide: 'cylinder', mass: 0.008,
    restitution: 0.35, knockable: true,
    build(P) {
      P.cyl('steel', 1.2, 1.2, 0.2, { y: 0.1, c: 0xc0a55c, seg: 26 });
      P.torus('steel', 1.02, 0.05, { y: 0.21, rx: Math.PI / 2, c: 0xa88a44, sy: 1, sz: 0.6 });
      P.cyl('steel', 0.5, 0.5, 0.04, { y: 0.22, c: 0xd4bb72, seg: 18 });
    },
  },

  bottleCap: {
    tags: ['kitchen', 'workbench'], collide: 'cylinder', mass: 0.006,
    restitution: 0.3, knockable: true,
    build(P) {
      P.prism('steel', 21, 1.55, 0.95, { y: 0.48, c: 0xc8342a });
      P.cyl('steel', 1.32, 1.32, 0.16, { y: 0.97, c: 0xe8e2d2, seg: 22 });
    },
  },
};

export const MODEL_NAMES = Object.keys(PROP_MODELS);

/* ================================================== contact shadow fallback */

/**
 * Soft elliptical falloff for the fallback blob, drawn once and shared.
 *
 * The falloff lives entirely in ALPHA and the RGB is flat white, so the
 * material's own dark tint is what reaches the frame buffer and a plain
 * source-over blend can only ever darken. The previous version of this texture
 * put the falloff in RGB over an opaque white background and relied on
 * MultiplyBlending — which r180's WebGLState silently declines to configure
 * unless the material is premultiplied — so it painted a bright card instead.
 */
function makeBlobTexture(size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const d = Math.min(1, Math.hypot(dx, dy));
      const t = 1 - d;
      // Dense core plus a long thin skirt. A linear ramp reads as an airbrushed
      // disc; occlusion is concentrated where the object meets the surface.
      const a = clamp(t * t * (0.60 + 0.40 * t * t * t * t), 0, 1);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  // No transfer function to undo: this is a mask, not a colour.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ================================================== placement bookkeeping */

/** Uniform-grid occupancy used both for scatter rejection and for the public
 *  collider query. Never allocates on lookup. */
class Grid {
  constructor(cell = 32) {
    this.cell = cell;
    this.map = new Map();
  }

  key(x, z) {
    return ((Math.floor(x / this.cell) & 0xffff) << 16) | (Math.floor(z / this.cell) & 0xffff);
  }

  insert(item) {
    const k = this.key(item.x, item.z);
    let bucket = this.map.get(k);
    if (!bucket) { bucket = []; this.map.set(k, bucket); }
    bucket.push(item);
  }

  /**
   * Smallest gap between (x,z) and any stored item's radius. Negative = overlap.
   *
   * `minR` ignores stored items smaller than that radius. A separation rule is
   * a statement about things of comparable size — "keep the cereal boxes 46 u
   * apart" — and applying it against every crumb on the table instead means a
   * table with crumbs on it has room for nothing else. Omit it for the old
   * behaviour: every item counts.
   */
  clearance(x, z, r, minR = 0) {
    const c = this.cell;
    const gx = Math.floor(x / c);
    const gz = Math.floor(z / c);
    let best = Infinity;
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const bucket = this.map.get((((gx + ox) & 0xffff) << 16) | ((gz + oz) & 0xffff));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const it = bucket[i];
          if (it.r < minR) continue;
          const d = Math.hypot(it.x - x, it.z - z) - it.r - r;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  collect(x, z, radius, out) {
    const c = this.cell;
    const span = Math.ceil(radius / c);
    const gx = Math.floor(x / c);
    const gz = Math.floor(z / c);
    for (let oz = -span; oz <= span; oz++) {
      for (let ox = -span; ox <= span; ox++) {
        const bucket = this.map.get((((gx + ox) & 0xffff) << 16) | ((gz + oz) & 0xffff));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const it = bucket[i];
          if (Math.hypot(it.x - x, it.z - z) <= radius + it.r) out.push(it.body || it);
        }
      }
    }
    return out;
  }

  clear() { this.map.clear(); }
}

/* ============================================================ the system */

const KNOCK_MAX = 48;

// render/Lighting.js draws every contact blob in the game — cars included —
// from one instance pool that tops out in the low hundreds. Scenery therefore
// gets a budget rather than a slot per placement, and candidates are sorted by
// footprint before it is applied: a 30 cm cereal box needs grounding, a 1.7 cm
// sugar cube reads as grounded from its own cast shadow alone.
const CONTACT_BUDGET = 256;

// Anything shorter than this casts no meaningful occlusion of its own — a leaf,
// a sheet of sandpaper, a coin. A blob under it would be bigger than the object.
const CONTACT_MIN_HEIGHT = 0.6;

/* ------------------------------------------------------------- composition */

// A real table is zoned, not evenly sprinkled. It has a place where somebody
// was sitting and everything gathered around them, and it has a margin that got
// swept clear with a forearm when the box of cars came out. Those two readings
// are what turn scenery into a story, and they cost nothing but a bias on where
// a candidate position is drawn.
//
// This applies to the `field` band only. The verge keeps its even scatter,
// because crumbs and sugar are precisely what a sweep leaves behind — pushing
// those away from the road as well would read as a table cleaned twice.
// 0.80, not 0.55. At 0.55 the pull was a lean rather than a rule: nearly half
// the field still landed on a uniform draw, so the clusters read as three
// slightly denser patches of the same even sprinkle. The zones only ever
// SUGGEST — every candidate still faces the road keep-out and the spacing test
// — so raising this cannot put anything anywhere it was not already allowed to
// be. It only decides how much of the field gathers.
const ZONE_PULL = 0.80;        // share of field candidates drawn from a cluster
const CLUSTER_ZONES = 3;
const SWEPT_ZONES = 2;
const CLUSTER_SPACING = 0.66;  // blue-noise gap multiplier inside a cluster
const ZONE_TRIES = 420;        // candidate centres tested when siting the zones

// A prop taller than this can hide a corner from the chase camera, which is a
// gameplay bug rather than a dressing choice. Set above the tallest thing that
// is deliberately laid ON the road anywhere in world/tracks — a pool ball at
// 5.7 u, a building block at 5.0, a slice of toast at 1.7 — and below the
// shortest vessel that could occlude, the mug at 9.5.
const OCCLUDER_HEIGHT = 8;

// Vessels that read as "knocked over when the cars came out". Only these are
// ever tipped, only in the field band, and only where they are either gathered
// into a cluster or already well past the clearance their entry demanded — a
// prop lying on its side near the circuit is an obstacle, not a story beat.
const TIPPABLE = new Set(['mug', 'jamJar', 'milkCarton', 'paintTin', 'oilCan', 'wateringCan']);
const TIP_CHANCE = 0.45;
const TIP_MAX = 1;             // per model — one knocked-over mug is a story, six is a mess
const TIP_MARGIN = 25;         // extra road clearance demanded of a tipped prop

export class Props {
  name = 'props';

  constructor(ctx) {
    this.ctx = ctx || {};
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.meshes = [];
    this.byModel = new Map();
    this.colliders = [];
    this.dynamics = [];
    this.grid = new Grid(34);
    this.built = false;
    this.trackRef = null;
    this.pending = [];
    this.stats = { models: 0, instances: 0, drawCalls: 0, colliders: 0 };
    this.quality = qualityLevel(this.ctx.settings ?? Settings);
    this.density = (this.ctx.settings ?? Settings)?.world?.propDensity ?? 1;
    this._geoCache = new Map();
    this._blobTex = null;
    this._contact = null;          // fallback blob mesh, only when there is no Lighting
    this._contactEntries = [];     // handles returned by Lighting.addContactShadow
    this._time = 0;
    this._zones = [];              // story zones, sited in populate()
    // Track.projectXZ hands back a SHARED record; owning one means the scatter
    // loop can never have it changed underneath it by another caller.
    this._proj = {
      t: 0, lateral: 0, distance: 0, halfWidth: 13, index: 0, frac: 0,
      centreY: 0, slopeY: 0, tangentX: 0, tangentY: 0, tangentZ: 1,
    };
  }

  async init() {
    this.ctx.scene?.add?.(this.group);
    this.ctx.bus?.on?.('track:ready', (track) => {
      try { this.populate(track); } catch (err) { console.error('[Props] populate failed', err); }
    });
    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.props = this;
    }
    return this;
  }

  /* ------------------------------------------------------------ authoring */

  /**
   * Queue one explicit placement. Safe to call before the track exists.
   * @param {string} model a PROP_MODELS key
   * @param {object} opts { position | t + lateral, rotation, scale, collide, seed, color }
   */
  add(model, opts = {}) {
    if (!PROP_MODELS[model]) {
      console.warn('[Props] unknown model', model);
      return this;
    }
    this.pending.push({ ...opts, model });
    if (this.built) this._flushPending();
    return this;
  }

  /* ------------------------------------------------------------ build pass */

  /** Idempotent. Reads the track definition's `props` array and builds
   *  everything in one pass. */
  populate(track) {
    const t = track || this.ctx.track;
    if (!t || this.built) return this;
    this.trackRef = t;
    this.built = true;

    const seed = (t.seed ?? 1337) ^ 0x50524f50;
    const rng = makeRng(seed);
    const entries = Array.isArray(t.def?.props) ? t.def.props : [];

    // Real footprints before anything is placed, so every separation test in
    // this pass is judged against the object's true size.
    this._warmMetrics(entries);

    const placements = [];
    // Explicit placements land first so hero composition always wins the space
    // and the scatter has to work around it, never the other way round.
    for (const e of entries) {
      if (!e || !e.model) continue;
      if (e.count == null) {
        const p = this._resolveExplicit(e, t, rng);
        if (p) placements.push(p);
      }
    }
    // Sited after the hero props are down and before the scatter, on their own
    // stream: the composition has to work around what was authored by hand, and
    // adding it must not shift a single one of those authored placements.
    this._zones = this._buildZones(t, t.seed ?? 1337, placements);

    for (const e of entries) {
      if (!e || !e.model || e.count == null) continue;
      this._scatter(e, t, rng, placements);
    }
    for (const e of this.pending) {
      const p = this._resolveExplicit(e, t, rng);
      if (p) placements.push(p);
    }
    this.pending.length = 0;

    this._buildMeshes(placements, rng);
    this._registerContactShadows(placements);
    this._publishColliders();

    this.ctx.bus?.emit?.('props:ready', this.stats);
    return this;
  }

  _flushPending() {
    if (!this.trackRef || !this.pending.length) return;
    // Rebuilding wholesale is the only way to keep one draw call per type; this
    // path only runs for runtime authoring, never during a race.
    const rng = makeRng((this.trackRef.seed ?? 1337) ^ 0x7a11);
    const extra = [];
    for (const e of this.pending) {
      const p = this._resolveExplicit(e, this.trackRef, rng);
      if (p) extra.push(p);
    }
    this.pending.length = 0;
    if (!extra.length) return;
    this._teardownMeshes();
    this._allPlacements = (this._allPlacements || []).concat(extra);
    this._buildMeshes(this._allPlacements, rng);
    this._registerContactShadows(this._allPlacements);
    this._publishColliders();
  }

  /* ---------------------------------------------------------- placement */

  _groundAt(x, z) {
    const t = this.trackRef;
    if (!t) return 0;
    try {
      const y = t.heightAt?.(x, z);
      return Number.isFinite(y) ? y : 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Ground normal, forced into the upper hemisphere. The sign guard is load
   * bearing, not padding: world/Track.js builds its frame normal as
   * cross(right, tangent), which evaluates to -up, and a prop oriented to it
   * would be rotated 180 degrees and planted through the floor.
   */
  _normalAt(x, z, out) {
    const t = this.trackRef;
    out.set(0, 1, 0);
    if (!t?.normalAt) return out;
    try {
      const n = t.normalAt(x, z, out);
      if (n && Number.isFinite(n.x + n.y + n.z) && n.lengthSq() > 1e-6) {
        out.copy(n);
        if (out.y < 0) out.negate();
      } else {
        out.set(0, 1, 0);
      }
    } catch (err) {
      out.set(0, 1, 0);
    }
    return out;
  }

  /**
   * Build the geometry of every model this track names, before anything is
   * placed.
   *
   * _modelGeometry() writes the model's true footprint back onto its entry as
   * `radius` and `size`, and until it has run every model reports the 4 u
   * placeholder. That used to happen during _buildMeshes, i.e. after the whole
   * scatter had already been laid out against the placeholder — so a 20 u
   * cereal box and a 2 u cornflake claimed the same footprint, and which one a
   * track got depended on whether some earlier track had already built that
   * model into the module-level table. Warming them here makes the numbers real
   * and makes them the same on every load. It costs nothing: this build is
   * needed for the meshes regardless, and it is cached.
   *
   * @param {object[]} entries the track definition's props array
   */
  _warmMetrics(entries) {
    const seen = new Set();
    const take = (model) => {
      if (!model || seen.has(model) || !PROP_MODELS[model]) return;
      seen.add(model);
      try {
        this._modelGeometry(model);
      } catch (err) {
        console.warn('[Props] could not measure', model, err);
      }
    };
    if (Array.isArray(entries)) for (const e of entries) take(e?.model);
    for (const e of this.pending) take(e?.model);
    return seen.size;
  }

  /* -------------------------------------------------------- the keep-out */

  /**
   * Horizontal gap between (x, z) and the nearest edge of the racing surface.
   * Negative means the point is on the road.
   *
   * This is the one test that decides whether a prop may exist somewhere, so
   * everything that places anything in the field goes through it — including
   * the composition pass below, which is allowed to *suggest* a position and
   * never to approve one.
   *
   * A track with no projection cannot have a ribbon for us to intrude on, so an
   * unanswerable query returns Infinity rather than blocking the whole scatter.
   */
  _roadClearance(x, z) {
    const t = this.trackRef;
    if (typeof t?.projectXZ !== 'function') return Infinity;
    try {
      const p = t.projectXZ(x, z, this._proj);
      if (!p || !Number.isFinite(p.lateral) || !Number.isFinite(p.halfWidth)) return Infinity;
      return Math.abs(p.lateral) - p.halfWidth;
    } catch (err) {
      return Infinity;
    }
  }

  /**
   * The same keep-out, applied to a HAND-AUTHORED placement.
   *
   * The scatter has refused to put anything near the ribbon since it was
   * written; explicit placements were trusted, which is right for the toast
   * propped against the jump lip and for the pool balls lying in the racing
   * line on purpose, and wrong for anything tall enough to hide a corner from
   * the chase camera.
   *
   * So the rule is deliberately narrow, and it is about height and centres, not
   * about footprints: a prop over OCCLUDER_HEIGHT whose CENTRE sits inside the
   * driving surface is dropped, and one whose centre is merely over the edge is
   * reported. Nothing currently authored in world/tracks trips either branch —
   * this is a guard against the next placement, not a change to any existing
   * one.
   *
   * @param {string} model a PROP_MODELS key
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number|{x:number,y:number,z:number}} scale resolved placement scale
   * @returns {boolean} true when the placement must be dropped
   */
  _explicitKeepOut(model, x, z, scale) {
    const def = PROP_MODELS[model];
    if (!def) return false;
    const sy = typeof scale === 'number' ? scale : (scale?.y ?? 1);
    const sxz = typeof scale === 'number' ? scale : Math.max(scale?.x ?? 1, scale?.z ?? 1);
    // def.size is written by _modelGeometry, which populate() warms before any
    // placement resolves. A model that has not been measured reports nothing and
    // is left alone rather than guessed at.
    const height = (def.size?.y ?? 0) * sy;
    if (!(height > OCCLUDER_HEIGHT)) return false;
    const gap = this._roadClearance(x, z);
    if (!Number.isFinite(gap) || gap >= 0) return false;
    const radius = (def.radius ?? 4) * sxz;
    if (gap < -radius * 0.5) {
      console.warn('[Props] keep-out: dropped', model, 'at', Math.round(x), Math.round(z),
        '— it stands on the racing surface');
      return true;
    }
    console.warn('[Props] keep-out:', model, 'at', Math.round(x), Math.round(z),
      'overhangs the road edge');
    return false;
  }

  /* ------------------------------------------------------- composition */

  /**
   * Story zones declared by the track definition itself, as
   * `def.propZones: [{ x, z, rx, rz, yaw, weight, kind }]`.
   *
   * Procedural siting can find a plausible pocket but it cannot know which
   * pocket the definition meant, and the whole point of a composed vignette is
   * that the loose dressing gathers around it — crumbs where somebody actually
   * ate. An authored zone is the definition saying so.
   *
   * A zone still only biases where a candidate is DRAWN — the road keep-out and
   * the spacing test decide whether it may exist — but a cluster that reached
   * back over the ribbon would waste most of its attempts, so the declared
   * ellipse is shrunk until its whole boundary is clear of the road.
   *
   * @param {object} track the built track
   * @returns {object[]} validated zones, possibly empty
   */
  _authoredZones(track) {
    const out = [];
    const list = track?.def?.propZones;
    if (!Array.isArray(list)) return out;
    for (const spec of list) {
      if (!spec || !Number.isFinite(spec.x) || !Number.isFinite(spec.z)) continue;
      const kind = spec.kind === 'swept' ? 'swept' : 'cluster';
      const yaw = Number.isFinite(spec.yaw) ? spec.yaw : 0;
      let rx = clamp(spec.rx ?? 30, 6, 140);
      let rz = clamp(spec.rz ?? 30, 6, 140);

      // A swept lane is the one zone that is MEANT to lie against the circuit:
      // it marks where dressing is absent, it affects only the verge and field
      // scatter, and clamping it away from the road would erase it. Everything
      // below is for clusters.
      if (kind !== 'swept') {
        const raw = this._roadClearance(spec.x, spec.z);
        if (Number.isFinite(raw) && raw <= 0) {
          console.warn('[Props] propZone cluster centre is on the road, ignored:', spec.x, spec.z);
          continue;
        }
        // Shrunk uniformly rather than clamped per axis. A pocket between two
        // straights is long one way and narrow the other, and capping both
        // radii by the centre's single clearance number throws that shape away
        // — which is most of what makes an authored zone worth authoring.
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        for (let i = 0; i < 14; i++) {
          let worst = Infinity;
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * TAU;
            const ex = Math.cos(a) * rx;
            const ez = Math.sin(a) * rz;
            const g = this._roadClearance(spec.x + ex * c - ez * s, spec.z + ex * s + ez * c);
            if (Number.isFinite(g) && g < worst) worst = g;
          }
          if (!(worst < 0)) break;
          rx *= 0.88;
          rz *= 0.88;
          if (rx < 6 || rz < 6) break;
        }
      }

      out.push({
        kind,
        x: spec.x,
        z: spec.z,
        rx,
        rz,
        yaw,
        weight: kind === 'swept' ? 0 : Math.max(0, spec.weight ?? 1),
        authored: true,
      });
    }
    return out;
  }

  /**
   * Site this track's story zones: a few places where the clutter gathers, and
   * one or two lanes beside the circuit that were swept clear to make room for
   * it.
   *
   * Zones only bias where a candidate is drawn. Every candidate still faces the
   * road keep-out and the spacing test afterwards, so the worst a badly sited
   * zone can do is waste attempts — it can never move a prop onto the racing
   * line. It draws from its own seeded stream so that adding it cannot shift a
   * single hand-authored placement.
   *
   * @param {object} track the built track
   * @param {number} seed
   * @param {object[]} anchors placements already authored by hand, used to site
   *   the near cluster so the scatter reinforces the composition in the track
   *   definition instead of competing with it
   * @returns {object[]} zones, possibly empty
   */
  _buildZones(track, seed, anchors) {
    // Authored first, so a definition that composed a vignette gets the ground
    // it asked for and the procedural siting below has to keep away from it —
    // push() and the swept loop both test against whatever is already here.
    const zones = this._authoredZones(track);
    const b = track?.bounds;
    if (!b || !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) return zones;
    const spanX = b.max.x - b.min.x;
    const spanZ = b.max.z - b.min.z;
    if (!(spanX > 60) || !(spanZ > 60)) return zones;

    const rng = makeRng(((seed ?? 1337) ^ 0x2ce77a1e) >>> 0);
    const pad = 26;
    const open = [];   // out in the clear: what got shoved aside
    const mid = [];    // a pocket inside the circuit: where somebody was sitting
    const near = [];   // hard against the ribbon: what got swept
    for (let i = 0; i < ZONE_TRIES; i++) {
      const x = lerp(b.min.x - pad, b.max.x + pad, rng.next());
      const z = lerp(b.min.z - pad, b.max.z + pad, rng.next());
      const raw = this._roadClearance(x, z);
      const gap = Number.isFinite(raw) ? raw : 60;
      if (gap > 48) open.push({ x, z, gap });
      else if (gap > 26) mid.push({ x, z, gap });
      if (gap > 10 && gap < 36) {
        // The tangent is read straight out of the projection that just ran, so
        // a swept lane can lie along the circuit rather than across it.
        near.push({ x, z, gap, yaw: Math.atan2(this._proj.tangentX || 0, this._proj.tangentZ || 1) });
      }
    }

    const sep = Math.min(spanX, spanZ) * 0.34;
    const push = (c, weight) => {
      for (let j = 0; j < zones.length; j++) {
        if (Math.hypot(zones[j].x - c.x, zones[j].z - c.z) < sep) return false;
      }
      // Radius is capped by the centre's own clearance, so the ellipse stays in
      // the ground it was chosen for instead of reaching back over the road.
      const r = clamp(c.gap * 0.7, 22, 56);
      const cap = c.gap * 0.9;
      zones.push({
        kind: 'cluster',
        x: c.x,
        z: c.z,
        rx: Math.min(r * rng.range(0.8, 1.3), cap),
        rz: Math.min(r * rng.range(0.8, 1.3), cap),
        yaw: rng.next() * TAU,
        weight,
      });
      return true;
    };

    // Somebody's place. Sited at the pocket nearest the props the track
    // definition placed by hand, so the crumbs and the toast gather around the
    // authored breakfast rather than starting a second one somewhere else.
    // A pocket is narrow, so what can actually land in one skews short: a prop
    // whose entry demands more clearance than the pocket has is turned away by
    // the keep-out, which is the right story as well as the safe outcome.
    if (mid.length) {
      let best = mid[0];
      if (anchors && anchors.length) {
        let bestD = Infinity;
        for (let i = 0; i < mid.length; i++) {
          let d = Infinity;
          for (let j = 0; j < anchors.length; j++) {
            const dd = Math.hypot(anchors[j].x - mid[i].x, anchors[j].z - mid[i].z);
            if (dd < d) d = dd;
          }
          if (d < bestD) { bestD = d; best = mid[i]; }
        }
      }
      push(best, 1);
    }

    // Shoved aside. Taken in generation order rather than by largest gap: the
    // roomiest point on a rectangular table is always a corner, and three
    // clusters in three corners is a pattern, not a composition.
    for (let i = 0; i < open.length && zones.length < CLUSTER_ZONES; i++) {
      push(open[i], 0.8 - zones.length * 0.15);
    }

    // The sweep. Elongated along the circuit, because that is the shape a
    // forearm makes when it clears a space.
    for (let i = 0; i < near.length && zones.length < CLUSTER_ZONES + SWEPT_ZONES; i++) {
      const c = near[i];
      let ok = true;
      for (let j = 0; j < zones.length; j++) {
        if (Math.hypot(zones[j].x - c.x, zones[j].z - c.z) < sep * 0.8) { ok = false; break; }
      }
      if (!ok) continue;
      zones.push({
        kind: 'swept',
        x: c.x,
        z: c.z,
        rx: 26 + rng.next() * 12,
        rz: 54 + rng.next() * 30,
        yaw: c.yaw,
        weight: 0,
      });
    }
    return zones;
  }

  /** One attracting zone, chosen by weight. Null when there are none. */
  _pickCluster(rng) {
    const zones = this._zones;
    if (!zones || !zones.length) return null;
    let total = 0;
    for (let i = 0; i < zones.length; i++) {
      if (zones[i].kind === 'cluster' && zones[i].weight > 0) total += zones[i].weight;
    }
    if (!(total > 0)) return null;
    let r = rng.next() * total;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (z.kind !== 'cluster' || !(z.weight > 0)) continue;
      r -= z.weight;
      if (r <= 0) return z;
    }
    return null;
  }

  /** A point inside a zone's ellipse, uniform in area. Fills and returns the
   *  shared record — read it out before the next call. */
  _zonePoint(zone, rng, out) {
    const a = rng.next() * TAU;
    const d = Math.sqrt(rng.next());
    const ex = Math.cos(a) * d * zone.rx;
    const ez = Math.sin(a) * d * zone.rz;
    const c = Math.cos(zone.yaw);
    const s = Math.sin(zone.yaw);
    out.x = zone.x + ex * c - ez * s;
    out.z = zone.z + ex * s + ez * c;
    return out;
  }

  /** True when (x, z) lies in a lane that was swept clear for the circuit. */
  _inSweptZone(x, z) {
    const zones = this._zones;
    if (!zones || !zones.length) return false;
    for (let i = 0; i < zones.length; i++) {
      const zo = zones[i];
      if (zo.kind !== 'swept') continue;
      const dx = x - zo.x;
      const dz = z - zo.z;
      const c = Math.cos(zo.yaw);
      const s = Math.sin(zo.yaw);
      // Inverse of the rotation _zonePoint applies.
      const lx = (dx * c + dz * s) / zo.rx;
      const lz = (-dx * s + dz * c) / zo.rz;
      if (lx * lx + lz * lz < 1) return true;
    }
    return false;
  }

  /**
   * How far a prop's origin must rise so that, once tilted, its lowest corner
   * still touches the surface instead of sinking through it.
   *
   * Only the tilt is measured. A yaw about Y cannot change a box's lowest point,
   * and the rotation that aligns a prop to a banked surface tilts the ground
   * with it — correcting for that in world Y would lift the prop off the bank it
   * is standing on.
   *
   * Returns the exact lift, which is what the tip path wants. A caller that only
   * wanted to take the sink out of a few degrees of scatter tilt would want to
   * clamp this against the prop's own height first, so that a thin flat object
   * is not left standing on one corner.
   */
  _settleLift(model, tilt, scale) {
    if (!tilt || (!tilt[0] && !tilt[1])) return 0;
    const def = PROP_MODELS[model];
    if (!def || def.foliage) return 0;   // blades bend from a root that stays put
    let entry = this._geoCache.get(model);
    if (!entry) {
      try { entry = this._modelGeometry(model); } catch (err) { return 0; }
    }
    const b = entry?.bounds;
    if (!b || b.isEmpty()) return 0;
    const sx = typeof scale === 'number' ? scale : (scale?.x ?? 1);
    const sy = typeof scale === 'number' ? scale : (scale?.y ?? 1);
    const sz = typeof scale === 'number' ? scale : (scale?.z ?? 1);
    _liftEuler.set(tilt[0], 0, tilt[1], 'XYZ');
    _liftQuat.setFromEuler(_liftEuler);
    let minY = Infinity;
    for (let i = 0; i < 8; i++) {
      _liftVec.set(
        (i & 1 ? b.max.x : b.min.x) * sx,
        (i & 2 ? b.max.y : b.min.y) * sy,
        (i & 4 ? b.max.z : b.min.z) * sz
      ).applyQuaternion(_liftQuat);
      if (_liftVec.y < minY) minY = _liftVec.y;
    }
    if (!Number.isFinite(minY)) return 0;
    return Math.max(0, -minY);
  }

  _resolveExplicit(e, track, rng) {
    const def = PROP_MODELS[e.model];
    if (!def) return null;
    let x = 0;
    let z = 0;
    let yOff = 0;
    let baseYaw = 0;

    if (Array.isArray(e.position)) {
      x = e.position[0] ?? 0;
      yOff = e.position[1] ?? 0;
      z = e.position[2] ?? 0;
    } else if (e.t != null && track?.surfacePoint) {
      // Track-relative authoring: this is how every definition in world/tracks
      // places its scenery, because a lap fraction survives a layout edit and a
      // hard-coded world position does not.
      const s = track.sampleAt(e.t);
      const lat = e.lateral ?? 0;
      const p = track.surfacePoint(e.t, lat, _v0);
      x = p.x;
      z = p.z;
      yOff = e.y ?? 0;
      baseYaw = Math.atan2(s.tangent.x, s.tangent.z);
    } else {
      return null;
    }

    const scale = resolveScale(e.scale, 1);
    const yaw = e.rotation === undefined || e.rotation === null
      ? baseYaw + (e.yaw ?? 0)
      : (Array.isArray(e.rotation) ? e.rotation[1] : e.rotation) + (e.relative ? baseYaw : 0);
    const tilt = Array.isArray(e.rotation) ? [e.rotation[0] || 0, e.rotation[2] || 0] : [0, 0];

    // `settle: true` asks for the lift that puts a tipped prop's lowest corner
    // back on the table. Authoring one by hand means reading a lathe profile and
    // trusting the arithmetic; the scatter has measured it from the real bounds
    // since the tip pass was written, and this is the same call.
    if (e.settle) yOff += this._settleLift(e.model, tilt, scale);

    if (this._explicitKeepOut(e.model, x, z, scale)) return null;

    return this._makePlacement(e.model, x, z, yOff, yaw, tilt, scale, e, rng);
  }

  _scatter(e, track, rng, out) {
    const def = PROP_MODELS[e.model];
    if (!def) return;
    const density = clamp(this.density, 0, 3);
    const want = Math.max(0, Math.round((e.count || 0) * (e.ignoreDensity ? 1 : density)));
    if (!want) return;

    const band = e.band || 'verge';
    const from = e.from ?? 0;
    const to = e.to ?? 1;
    const span = to > from ? to - from : 1 - from + to;
    const offMin = e.offset?.[0] ?? 6;
    const offMax = e.offset?.[1] ?? 30;
    const spacing = e.spacing ?? 4;
    const side = e.side ?? 0;
    const bounds = track.bounds;

    // Footprints were warmed in populate(), so def.radius is real here.
    const canTip = band === 'field' && TIPPABLE.has(e.model);

    let placed = 0;
    let tipped = 0;
    // Floored, not just proportional. A halved count is a small count, and a
    // count of one demanding 50 u of road clearance had fourteen attempts to
    // find it — most of which now start inside a cluster that may be too tight
    // for it. The floor costs nothing when the entry is easy to satisfy.
    const tries = Math.max(28, want * 14);
    for (let i = 0; i < tries && placed < want; i++) {
      let x;
      let z;
      let baseYaw = 0;
      let inCluster = false;
      let roadGap = 0;
      if (band === 'field') {
        if (!bounds) break;
        // A zone suggests where to look; it never approves a position.
        const zone = rng.next() < ZONE_PULL ? this._pickCluster(rng) : null;
        if (zone) {
          this._zonePoint(zone, rng, _zoneOut);
          x = _zoneOut.x;
          z = _zoneOut.z;
          inCluster = true;
        } else {
          x = lerp(bounds.min.x - 26, bounds.max.x + 26, rng.next());
          z = lerp(bounds.min.z - 26, bounds.max.z + 26, rng.next());
        }
        // Anything inside the ribbon plus a car's width of margin is rejected:
        // scenery in the racing line is a bug, not a hazard.
        roadGap = this._roadClearance(x, z);
        if (roadGap < (e.clear ?? 14)) continue;
        if (this._inSweptZone(x, z)) continue;
      } else {
        // Stratified in t, so a hundred tufts spread over the lap instead of
        // clumping wherever the stream happened to land.
        const t = (from + span * ((placed + rng.next()) / want)) % 1;
        const s = track.sampleAt(t);
        const sgn = side !== 0 ? side : (rng.next() < 0.5 ? -1 : 1);
        const lateral = sgn * (s.halfWidth + lerp(offMin, offMax, rng.next() ** (e.bias ?? 1)));
        const p = track.surfacePoint(t, lateral, _v0);
        x = p.x;
        z = p.z;
        baseYaw = Math.atan2(s.tangent.x, s.tangent.z) + (e.align ? 0 : rng.range(-0.5, 0.5));
        // The verge is where the sweep actually shows: it carries the dense
        // crumb scatter, and a stretch of table wiped clean beside the circuit
        // is only legible against that. Road-band props are deliberate hazards
        // and are left alone.
        if (band === 'verge' && this._inSweptZone(x, z)) continue;
        if (band === 'road') {
          const p2 = track.surfacePoint(t, sgn * s.halfWidth * rng.range(0.1, 0.85), _v0);
          x = p2.x;
          z = p2.z;
        }
      }

      const scale = resolveScale(e.scale, 1, rng);
      const radius = (def.radius ?? 4) * (typeof scale === 'number' ? scale : scale.x);
      // Clutter touches. Blue noise at the field's own spacing inside a cluster
      // would just be a small field, which is the thing this pass exists to stop.
      // Separation is judged against neighbours of comparable size: a mug has to
      // stand clear of other mugs, not of a table's worth of crumbs.
      const gap = this.grid.clearance(x, z, radius, radius * 0.5);
      if (gap < (inCluster ? spacing * CLUSTER_SPACING : spacing)) continue;

      const yaw = e.align ? baseYaw + (e.yaw ?? 0) : rng.next() * TAU;
      let tilt = e.tilt ? [rng.range(-e.tilt, e.tilt), rng.range(-e.tilt, e.tilt)] : [0, 0];
      let yOff = e.y ?? 0;
      // Tipped where it reads as story and cannot read as an obstacle: gathered
      // in a cluster, or otherwise well beyond the clearance this prop already
      // had to satisfy.
      const tipOk = inCluster || roadGap > (e.clear ?? 14) + TIP_MARGIN;
      if (canTip && tipOk && tipped < TIP_MAX && rng.next() < TIP_CHANCE) {
        // Rolled onto its side about its own long axis, then raised so it comes
        // to rest on the table instead of half inside it.
        tilt = [rng.next() < 0.5 ? Math.PI * 0.5 : -Math.PI * 0.5, 0];
        yOff += this._settleLift(e.model, tilt, scale);
        tipped++;
      }
      const p = this._makePlacement(e.model, x, z, yOff, yaw, tilt, scale, e, rng);
      if (p) { out.push(p); placed++; }
    }
  }

  _makePlacement(model, x, z, yOff, yaw, tilt, scale, e, rng) {
    const def = PROP_MODELS[model];
    const sx = typeof scale === 'number' ? scale : scale.x;
    const sy = typeof scale === 'number' ? scale : scale.y;
    const sz = typeof scale === 'number' ? scale : scale.z;
    const y = this._groundAt(x, z) + (yOff || 0);

    // Sit the prop on the surface it is actually standing on: on a banked corner
    // or a ramp flank an unrotated prop leans through the ground.
    this._normalAt(x, z, _v1);
    _q0.setFromUnitVectors(UP, _v1);
    _q1.setFromAxisAngle(UP, yaw);
    _q0.multiply(_q1);
    if (tilt && (tilt[0] || tilt[1])) {
      _e0.set(tilt[0], 0, tilt[1], 'XYZ');
      _q0.multiply(_q1.setFromEuler(_e0));
    }

    const radius = (def.radius ?? 4) * Math.max(sx, sz);
    this.grid.insert({ x, z, r: radius * 0.72 });

    return {
      model,
      x, y, z,
      quaternion: _q0.clone(),
      scale: new THREE.Vector3(sx, sy, sz),
      seed: rng.next(),
      collide: e?.collide ?? (def.collide !== null),
      tint: e?.color ?? null,
      tintJitter: e?.tintJitter ?? def.tintJitter ?? 0.05,
      knockable: e?.knockable ?? def.knockable ?? false,
      radius,
    };
  }

  /* ------------------------------------------------------------- geometry */

  /** Merged, UV-projected geometry for one model, keyed by material. Built once
   *  and shared by every track that uses the model. */
  _modelGeometry(model, rng) {
    const hit = this._geoCache.get(model);
    if (hit) return hit;
    const def = PROP_MODELS[model];
    const P = new PartBuilder(makeRng(0x9e37 ^ hashName(model)), this.quality);
    try {
      def.build(P, P.rng);
    } catch (err) {
      console.error('[Props] model build failed:', model, err);
    }
    if (!P.parts.length) {
      // A model that fails to build must not leave a hole in the scene graph.
      P.box('plasticMatte', 3, 3, 3, { y: 1.5, c: 0xb0aca4 });
    }

    const byMat = new Map();
    for (const part of P.parts) {
      let list = byMat.get(part.mat);
      if (!list) { list = []; byMat.set(part.mat, list); }
      list.push(part.geo);
    }

    const out = [];
    const bounds = new THREE.Box3();
    bounds.makeEmpty();
    for (const [mat, list] of byMat) {
      let geo = null;
      try {
        geo = list.length === 1 ? list[0] : BGU.mergeGeometries(list, false);
      } catch (err) {
        console.warn('[Props] merge failed for', model, mat, err);
        geo = list[0];
      }
      if (!geo) continue;
      if (list.length > 1) for (const g of list) if (g !== geo) g.dispose();
      projectUV(geo, uvScaleFor(mat));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      bounds.union(geo.boundingBox);
      out.push({ mat, geo });
    }

    const size = bounds.getSize(new THREE.Vector3());
    const centre = bounds.getCenter(new THREE.Vector3());
    const entry = { parts: out, bounds, size, centre };
    // Cached back onto the model so scatter clearance can use the real footprint.
    def.radius = Math.max(1, Math.hypot(size.x, size.z) * 0.5);
    def.size = size;
    this._geoCache.set(model, entry);
    return entry;
  }

  _buildMeshes(placements, rng) {
    this._allPlacements = placements;
    const groups = new Map();
    for (const p of placements) {
      let list = groups.get(p.model);
      if (!list) { list = []; groups.set(p.model, list); }
      list.push(p);
    }

    let drawCalls = 0;
    let instances = 0;

    for (const [model, list] of groups) {
      const geoSet = this._modelGeometry(model, rng);
      const def = PROP_MODELS[model];
      const n = list.length;
      const built = [];

      for (const part of geoSet.parts) {
        const geo = part.geo.clone();
        const seeds = new Float32Array(n);
        for (let i = 0; i < n; i++) seeds[i] = list[i].seed;
        geo.setAttribute('aPropSeed', new THREE.InstancedBufferAttribute(seeds, 1));

        const mesh = new THREE.InstancedMesh(geo, propMaterial(part.mat), n);
        mesh.name = `prop:${model}:${part.mat}`;
        mesh.castShadow = def.castShadow !== false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.instanceMatrix.setUsage(def.knockable ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);

        for (let i = 0; i < n; i++) {
          const p = list[i];
          _m0.compose(_v0.set(p.x, p.y, p.z), p.quaternion, p.scale);
          mesh.setMatrixAt(i, _m0);
          const jitter = p.tintJitter;
          if (p.tint != null) _c1.set(p.tint);
          else _c1.setRGB(1, 1, 1);
          if (jitter > 0) {
            const k = 1 + (hash01(p.seed) - 0.5) * jitter * 2;
            _c1.multiplyScalar(k);
          }
          mesh.setColorAt(i, _c1);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();

        this.group.add(mesh);
        this.meshes.push(mesh);
        built.push(mesh);
        drawCalls++;
      }

      this.byModel.set(model, { meshes: built, placements: list });
      instances += n;

      // Collision proxies, one per placement, sized from the real merged bounds.
      for (let i = 0; i < n; i++) {
        const p = list[i];
        if (!p.collide || def.collide === null) continue;
        this.colliders.push(makeCollider(model, def, geoSet, p, i));
      }
      if (def.knockable) {
        for (let i = 0; i < n && this.dynamics.length < KNOCK_MAX; i++) {
          const p = list[i];
          if (!p.knockable) continue;
          this.dynamics.push({
            model, index: i, meshes: built, placement: p,
            pos: new THREE.Vector3(p.x, p.y, p.z),
            rest: new THREE.Vector3(p.x, p.y, p.z),
            vel: new THREE.Vector3(),
            spin: new THREE.Vector3(),
            quat: p.quaternion.clone(),
            scale: p.scale,
            radius: Math.max(0.4, (def.size ? Math.max(def.size.x, def.size.z) : 2) * 0.5 * p.scale.x),
            height: (def.size ? def.size.y : 2) * p.scale.y,
            mass: def.mass ?? 0.1,
            restitution: def.restitution ?? 0.3,
            roll: !!def.roll,
            asleep: true,
            collider: null,
          });
        }
      }
    }

    this.stats = {
      models: groups.size,
      instances,
      drawCalls: drawCalls + 1,
      colliders: this.colliders.length,
    };

    // Wire every dynamic body to its collider so a knock moves both at once.
    for (const d of this.dynamics) {
      d.collider = this.colliders.find((c) => c.model === d.model && c.instance === d.index) || null;
    }
  }

  /**
   * Ground every prop that is tall enough to occlude anything.
   *
   * The blobs themselves belong to render/Lighting.js: one instanced,
   * correctly-blended pool shared with the cars, whose shader is structurally
   * incapable of brightening the frame. All this does is describe each prop to
   * it — footprint, contact plane, surface normal — and keep the handles so
   * they can be released on teardown.
   *
   * @param {object[]} placements every placement in the scene
   */
  _registerContactShadows(placements) {
    const candidates = [];
    for (const p of placements) {
      const def = PROP_MODELS[p.model];
      if (!def || def.contact === false) continue;
      const fit = orientedFootprint(this._geoCache.get(p.model)?.bounds, p, def.size);
      if (!(fit.h > CONTACT_MIN_HEIGHT)) continue;
      if (!Number.isFinite(fit.w) || !Number.isFinite(fit.l) || !Number.isFinite(fit.baseY)) continue;
      candidates.push({ p, w: fit.w, l: fit.l, h: fit.h, baseY: fit.baseY, area: fit.w * fit.l });
    }
    if (!candidates.length) return;
    // Biggest footprint first, so if the pool runs out it is the sugar cubes
    // that go without and never the cereal boxes.
    candidates.sort((a, b) => b.area - a.area);
    if (candidates.length > CONTACT_BUDGET) candidates.length = CONTACT_BUDGET;

    // A knocked prop's blob has to travel with it, so those register against the
    // live dynamics record instead of a frozen transform.
    const dynByPlacement = new Map();
    for (const d of this.dynamics) if (d.placement) dynByPlacement.set(d.placement, d);

    const lighting = this.ctx.lighting;
    if (typeof lighting?.addContactShadow === 'function') {
      for (const c of candidates) {
        const entry = this._registerOne(lighting, c, dynByPlacement.get(c.p));
        // If the very first one comes back empty the pool never built, so stop
        // asking and take the fallback rather than logging it 256 times.
        if (!entry && !this._contactEntries.length) break;
        if (entry) this._contactEntries.push(entry);
      }
      if (this._contactEntries.length) return;
    }
    this._buildFallbackContact(candidates);
  }

  /** One registration. Never throws: a peer mid-edit must not cost us the scene. */
  _registerOne(lighting, c, dyn) {
    const p = c.p;
    const opts = contactOptsFor(c);
    // Lighting measures a target's height above the surface from its origin, so
    // it has to be told how far the origin sits above the face that touches the
    // ground. Zero for the upright majority; 4.6 u for the milk carton lying on
    // its side, whose blob would otherwise fade to a fifth and lean away from
    // the key as though it were airborne.
    opts.baseOffset = Math.max(0, p.y - c.baseY);
    if (dyn) {
      // Falls and rolls: let Lighting query the ground and fade the blob out as
      // the prop leaves it.
      opts.static = false;
      opts.maxHeight = Math.max(4, c.h * 1.5);
      return safeAddContact(lighting, { position: dyn.pos, quaternion: dyn.quat }, opts);
    }
    // A resting prop's own lowest point *is* the plane it stands on — exact on a
    // bank, a ramp or on top of another prop, where a terrain query is not, and
    // it costs nothing per frame.
    opts.static = true;
    opts.grounded = true;
    opts.groundY = c.baseY;
    this._normalAt(p.x, p.z, _v1);
    opts.normal = [_v1.x, _v1.y, _v1.z];
    return safeAddContact(lighting, { position: new THREE.Vector3(p.x, p.y, p.z), quaternion: p.quaternion }, opts);
  }

  /**
   * Grounding of last resort, for a build with no render/Lighting.js at all.
   * One instanced quad per prop, alpha-blended toward a warm near-black: a plain
   * source-over blend of a dark colour cannot brighten what is under it whatever
   * the renderer's blend state happens to be.
   */
  _buildFallbackContact(candidates) {
    if (!this._blobTex) {
      try { this._blobTex = makeBlobTexture(128); } catch (err) { this._blobTex = null; }
    }
    if (!this._blobTex) return;

    const mat = new THREE.MeshBasicMaterial({
      map: this._blobTex,
      color: 0x14110c,
      transparent: true,
      opacity: 0.62,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, mat, candidates.length);
    mesh.name = 'prop:contactFallback';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.renderOrder = -5; // first thing in the transparent queue, like Lighting's

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const o = contactOptsFor(c);
      // Heading only: a blob quad that inherits a prop's lean stands on edge.
      _v1.set(0, 0, 1).applyQuaternion(c.p.quaternion);
      _q0.setFromAxisAngle(UP, Math.atan2(_v1.x, _v1.z));
      _m0.compose(
        _v0.set(c.p.x, c.baseY + o.lift, c.p.z),
        _q0,
        _v2.set(o.width, 1, o.length)
      );
      mesh.setMatrixAt(i, _m0);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this._contact = mesh;
  }

  /** Hand every registered blob back to Lighting. Idempotent. */
  _releaseContactShadows() {
    const lighting = this.ctx.lighting;
    for (const entry of this._contactEntries) {
      try { lighting?.removeContactShadow?.(entry); } catch (err) { /* already gone */ }
    }
    this._contactEntries.length = 0;
  }

  _publishColliders() {
    this.grid.clear();
    for (const c of this.colliders) {
      this.grid.insert({ x: c.position.x, z: c.position.z, r: c.boundingRadius, body: c });
    }
    const physics = this.ctx.physics;
    if (!physics?.addBody) return;
    for (const c of this.colliders) {
      try {
        const handle = physics.addBody(c);
        if (handle && typeof handle === 'object') c.handle = handle;
        c.externallySimulated = c.externallySimulated || !!c.dynamic;
      } catch (err) {
        // A physics world that rejects our body shape is not a reason to lose
        // the scenery; the local index still answers queries.
        break;
      }
    }
  }

  /* ------------------------------------------------------------- queries */

  /** Every collider whose footprint touches the disc (x, z, radius). */
  queryColliders(x, z, radius, out = []) {
    out.length = 0;
    return this.grid.collect(x, z, radius, out);
  }

  /** Bounds of everything placed, useful for framing an establishing shot. */
  computeBounds(target = new THREE.Box3()) {
    target.makeEmpty();
    for (const m of this.meshes) {
      if (!m.boundingSphere) m.computeBoundingSphere();
      if (m.boundingSphere) {
        _sph.copy(m.boundingSphere).applyMatrix4(m.matrixWorld);
        target.expandByPoint(_v0.copy(_sph.center).addScalar(_sph.radius));
        target.expandByPoint(_v0.copy(_sph.center).addScalar(-_sph.radius));
      }
    }
    return target;
  }

  /* -------------------------------------------------------------- runtime */

  update(dt, ctx) {
    if (!this.built) {
      const t = ctx?.track || this.ctx.track;
      if (t) {
        try { this.populate(t); } catch (err) { console.error('[Props] populate failed', err); }
      }
      return;
    }
    this._time += dt;
    for (let i = 0; i < _swayMats.length; i++) _swayMats[i].uPropTime.value = this._time;
  }

  fixedUpdate(fdt, ctx) {
    if (!this.built || !this.dynamics.length) return;
    const cars = ctx?.vehicles || this.ctx.vehicles;
    if (!cars || !cars.length) return;
    this._stepKnockables(fdt, cars);
  }

  /**
   * Local rigid-ish integration for the small props flagged `knockable`.
   *
   * This only runs for bodies physics/World.js has not claimed. It is not a
   * general solver — it is the minimum that makes a pool ball behave like a pool
   * ball when a car arrives at 90 u/s, which is a moment the game would feel
   * dead without.
   */
  _stepKnockables(fdt, cars) {
    const g = (this.ctx.settings ?? Settings)?.physics?.gravity ?? 260;
    for (let i = 0; i < this.dynamics.length; i++) {
      const d = this.dynamics[i];
      if (d.collider?.externallySimulated) continue;

      // Impulse from any car overlapping the prop's footprint.
      for (let c = 0; c < cars.length; c++) {
        const car = cars[c];
        const cp = car?.position;
        if (!cp) continue;
        const dx = d.pos.x - cp.x;
        const dz = d.pos.z - cp.z;
        const reach = d.radius + 5.2;
        if (dx * dx + dz * dz > reach * reach) continue;
        if (Math.abs(d.pos.y - cp.y) > 6) continue;
        const cv = car.velocity;
        const speed = cv ? Math.hypot(cv.x, cv.z) : 0;
        if (speed < 6) continue;
        const inv = 1 / Math.max(0.001, Math.hypot(dx, dz));
        // Momentum transfer scaled by the mass ratio; a 1.0-mass car against a
        // 0.16 pool ball should send it a long way, and it does.
        const k = clamp(1.4 / Math.max(0.02, d.mass), 1, 26);
        d.vel.x += dx * inv * speed * 0.55 * Math.min(1, k * 0.12) + cv.x * 0.34;
        d.vel.z += dz * inv * speed * 0.55 * Math.min(1, k * 0.12) + cv.z * 0.34;
        d.vel.y += Math.min(speed * 0.16, 44);
        d.spin.x += cv.z * 0.02;
        d.spin.z -= cv.x * 0.02;
        d.asleep = false;
      }

      if (d.asleep) continue;

      d.vel.y -= g * fdt;
      d.pos.addScaledVector(d.vel, fdt);

      const ground = this._groundAt(d.pos.x, d.pos.z);
      if (d.pos.y <= ground) {
        d.pos.y = ground;
        if (d.vel.y < 0) d.vel.y = -d.vel.y * d.restitution;
        if (Math.abs(d.vel.y) < 6) d.vel.y = 0;
        const fr = d.roll ? 0.992 : 0.90;
        d.vel.x *= fr;
        d.vel.z *= fr;
        d.spin.multiplyScalar(d.roll ? 0.995 : 0.86);
      }

      // Keep them on the table: anything that leaves the playfield is parked
      // rather than allowed to fall forever.
      const b = this.trackRef?.bounds;
      if (b) {
        if (d.pos.x < b.min.x || d.pos.x > b.max.x || d.pos.z < b.min.z || d.pos.z > b.max.z) {
          d.pos.copy(d.rest);
          d.vel.set(0, 0, 0);
          d.spin.set(0, 0, 0);
          d.asleep = true;
        }
      }

      if (d.roll) {
        const sp = Math.hypot(d.vel.x, d.vel.z);
        if (sp > 0.4) {
          _v1.set(d.vel.z, 0, -d.vel.x).normalize();
          _q1.setFromAxisAngle(_v1, (sp / Math.max(0.3, d.radius)) * fdt);
          d.quat.premultiply(_q1);
        }
      } else if (d.spin.lengthSq() > 1e-4) {
        _v1.copy(d.spin);
        const len = _v1.length();
        _q1.setFromAxisAngle(_v1.multiplyScalar(1 / len), len * fdt);
        d.quat.premultiply(_q1);
      }

      const still = d.vel.lengthSq() < 1.2 && Math.abs(d.pos.y - ground) < 0.05;
      if (still) {
        d.vel.set(0, 0, 0);
        d.spin.set(0, 0, 0);
        d.asleep = true;
      }

      _m0.compose(d.pos, d.quat, d.scale);
      for (let m = 0; m < d.meshes.length; m++) {
        d.meshes[m].setMatrixAt(d.index, _m0);
        d.meshes[m].instanceMatrix.needsUpdate = true;
      }
      if (d.collider) {
        d.collider.position.copy(d.pos);
        d.collider.quaternion.copy(d.quat);
      }
    }
  }

  /* -------------------------------------------------------------- config */

  applySettings(settings) {
    const s = settings || this.ctx.settings || Settings;
    const next = s?.world?.propDensity ?? 1;
    this.density = next;
    const q = qualityLevel(s);
    if (q !== this.quality) this.quality = q;
    return this;
  }

  setVisible(v) { this.group.visible = !!v; }

  _teardownMeshes() {
    this._releaseContactShadows();
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    if (this._contact) {
      this.group.remove(this._contact);
      this._contact.geometry.dispose();
      this._contact.material.dispose();
      this._contact = null;
    }
    this.meshes.length = 0;
    this.byModel.clear();
    this.colliders.length = 0;
    this.dynamics.length = 0;
    this.grid.clear();
  }

  dispose() {
    this._teardownMeshes();
    for (const entry of this._geoCache.values()) {
      for (const part of entry.parts) part.geo.dispose();
    }
    this._geoCache.clear();
    if (this._blobTex) { this._blobTex.dispose(); this._blobTex = null; }
    this.group.parent?.remove(this.group);
    this.built = false;
  }

  static get MODEL_NAMES() { return MODEL_NAMES; }
}

/* ================================================================ helpers */

/**
 * Blob shape for one candidate. Shared by the Lighting registration and the
 * fallback so the two cannot drift apart.
 *
 * The quad is sized so its dense core lands on the prop's own footprint — the
 * falloff reaches zero at the quad's edge, not at its core — and widens with
 * height, because the occlusion of a tall object spreads further than its base
 * under anything but a vertical key.
 * @param {{w:number,l:number,h:number}} c
 */
function contactOptsFor(c) {
  const grow = 1.72 + clamp(c.h / 34, 0, 0.62);
  return {
    width: Math.max(0.4, c.w * grow),
    length: Math.max(0.4, c.l * grow),
    opacity: clamp(0.72 + c.h * 0.02, 0, 1),
    softness: clamp(0.34 + c.h / 90, 0.2, 0.62),
    lift: 0.06,
    yaw: true,
    tilt: true,
  };
}

/**
 * Extents of a placed prop measured in its own yaw-local frame, plus the world
 * height of its lowest point. Fills and returns a shared record — read it out
 * before the next call.
 *
 * Both numbers matter for grounding, and neither is the model's bounding box.
 * The milk carton in the kitchen definition is authored lying on its side and
 * raised 4.6 u: its footprint is nothing like its upright box, and its origin is
 * several centimetres above the table it is resting on. Take the placement's y
 * as the contact plane and its blob hangs in mid-air over the spill.
 *
 * @param {?THREE.Box3} bounds model-local bounds, before scale
 * @param {object} p placement
 * @param {?THREE.Vector3} size fallback model size when bounds are unavailable
 */
function orientedFootprint(bounds, p, size) {
  const out = _fpOut;
  if (!bounds || bounds.isEmpty()) {
    out.w = (size ? size.x : 4) * p.scale.x;
    out.l = (size ? size.z : 4) * p.scale.z;
    out.h = (size ? size.y : 4) * p.scale.y;
    out.baseY = p.y;
    return out;
  }
  // Undo the heading: Lighting turns the blob quad with the prop, so the extents
  // it wants are measured along the prop's own axes, not the world's.
  _fpVec.set(0, 0, 1).applyQuaternion(p.quaternion);
  _fpQuat.setFromAxisAngle(UP, -Math.atan2(_fpVec.x, _fpVec.z));
  _fpQuat.multiply(p.quaternion);

  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    _fpVec.set(
      (i & 1 ? bounds.max.x : bounds.min.x) * p.scale.x,
      (i & 2 ? bounds.max.y : bounds.min.y) * p.scale.y,
      (i & 4 ? bounds.max.z : bounds.min.z) * p.scale.z
    ).applyQuaternion(_fpQuat);
    if (_fpVec.x < minX) minX = _fpVec.x;
    if (_fpVec.x > maxX) maxX = _fpVec.x;
    if (_fpVec.y < minY) minY = _fpVec.y;
    if (_fpVec.y > maxY) maxY = _fpVec.y;
    if (_fpVec.z < minZ) minZ = _fpVec.z;
    if (_fpVec.z > maxZ) maxZ = _fpVec.z;
  }
  out.w = maxX - minX;
  out.l = maxZ - minZ;
  out.h = maxY - minY;
  out.baseY = p.y + minY;
  return out;
}

/**
 * render/Lighting.js is built by another agent and may be mid-edit; a scene full
 * of props must not be lost to one bad registration.
 * @returns {?object} the live handle, or null if nothing was registered
 */
function safeAddContact(lighting, target, opts) {
  try {
    return lighting.addContactShadow(target, opts) || null;
  } catch (err) {
    console.warn('[Props] contact shadow registration failed', err);
    return null;
  }
}

function hashName(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hash01(v) {
  const x = Math.sin(v * 127.1 + 3.7) * 43758.5453;
  return x - Math.floor(x);
}

function qualityLevel(s) {
  const q = s?.quality ?? 'high';
  return q === 'low' ? 0 : q === 'medium' ? 1 : 2;
}

function resolveScale(spec, fallback, rng) {
  if (spec == null) return fallback;
  if (typeof spec === 'number') return spec;
  if (Array.isArray(spec)) {
    if (spec.length === 2 && rng) return lerp(spec[0], spec[1], rng.next());
    if (spec.length === 2) return (spec[0] + spec[1]) * 0.5;
    return { x: spec[0] ?? 1, y: spec[1] ?? 1, z: spec[2] ?? 1 };
  }
  return fallback;
}

/**
 * Collision proxy for one placed instance.
 * Shapes are deliberately coarse — a car needs to bounce off a cereal box, not
 * off its printed panel — and are derived from the merged render bounds so the
 * proxy can never drift from what is drawn.
 */
function makeCollider(model, def, geoSet, p, index) {
  const size = geoSet.size;
  const centre = geoSet.centre;
  const hx = (size.x * 0.5) * p.scale.x;
  const hy = (size.y * 0.5) * p.scale.y;
  const hz = (size.z * 0.5) * p.scale.z;
  const shape = def.collide || 'box';
  const body = {
    type: 'prop',
    kind: model,
    shape,
    static: !def.knockable,
    dynamic: !!def.knockable,
    mass: def.knockable ? (def.mass ?? 0.1) : 0,
    restitution: def.restitution ?? 0.25,
    friction: def.friction ?? 0.8,
    position: new THREE.Vector3(p.x + centre.x * 0, p.y, p.z),
    quaternion: p.quaternion.clone(),
    halfExtents: new THREE.Vector3(hx, hy, hz),
    centreOffset: new THREE.Vector3(0, centre.y * p.scale.y, 0),
    radius: shape === 'sphere' ? Math.max(hx, hy, hz) : Math.max(hx, hz),
    height: hy * 2,
    boundingRadius: Math.hypot(hx, hz),
    surface: def.surface || 'plasticMatte',
    instance: index,
    externallySimulated: false,
  };
  body.aabb = new THREE.Box3(
    new THREE.Vector3(p.x - hx, p.y, p.z - hz),
    new THREE.Vector3(p.x + hx, p.y + hy * 2, p.z + hz)
  );
  return body;
}

export const PropSystem = Props;
export default Props;
