// fx/Trails.js — ribbons: fresh rubber, speed trails, exhaust shimmer.
//
// Three ribbon layers, three ring-buffered triangle strips, three draw calls.
// Every one of them is a growing strip laid down at the fixed tick and faded
// out on the GPU from a per-vertex birth stamp, so nothing here has to be
// rewritten per frame and `?t=12` fast-forwards them for free.
//
// ------------------------------------------------- who owns the ground marks
//
// world/Decals.js already owns the *persistent* rubber laid on the road: a
// 3600-segment ring with a proper mark atlas, surface tinting and a contact-
// normal-aligned strip. It publishes `ownsTyreMarks` and `disableTyreMarks()`
// precisely so this module can take the job over.
//
// It should not. Two systems drawing the same black line in the same place
// double its density and z-fight. What is genuinely missing — and what this
// module draws — is the *fresh* mark: the hot, wet-looking rubber that appears
// under a sliding tyre and fades over a second and a half, sitting a hair
// above the permanent one. That is what makes a slide read as happening now
// rather than as a decal that was always there, and it composites over the
// Decals layer instead of competing with it.
//
// If Decals is missing or has already surrendered the marks, this module
// notices at init and stretches its own lifetime out to a full race, so the
// skid ribbons are still there. Call `takeGroundMarks()` to force that.
//
// ------------------------------------------------------------ the other two
//
// **Speed ribbon.** Two tapering strips off the rear quarters, additive,
// keyed to boost and to the top 20% of the speed range. It is the readability
// cue that tells you, from a top-down camera at 55 degrees, that the car in
// front is on the power.
//
// **Exhaust shimmer.** A real heat haze refracts, and refraction needs a copy
// of the frame buffer that a forward renderer cannot hand out mid-pass. What
// hot air actually *looks* like in a macro shot backlit by a window is a faint
// scattering wobble, so that is what this draws: a low-amplitude additive
// ribbon whose noise is warped along its own length. Kept deliberately below
// the threshold where it could ever read as a grey smear.

import * as THREE from 'three';
import {
  clamp, saturate, simplex2D, fbm2D, fbm2DTiled,
} from '../core/Random.js';
import { surfaceRecord } from '../vehicle/Tires.js';

/* ==========================================================================
 * Module scratch
 * ========================================================================== */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _col = new THREE.Color();

/** Half width of a tyre's contact patch at reference load, world units. */
const TYRE_HALF = 0.62;

/** Lift above the contact point, so the ribbon clears the permanent decal. */
const SKID_LIFT = 0.055;

// Segment length. 1.15 u is a tenth of a car and a ninth of the widest smoke
// puff, so the strip reads as a smooth curve, while keeping the worst case —
// eight cars sliding on all four wheels at once — inside the ring budget.
const STEP_MIN2 = 1.15 * 1.15;

/** Squared distance above which the strip is broken rather than bridged. */
const BREAK2 = 26 * 26;

/* ==========================================================================
 * Ribbon
 *
 * A ring buffer of quads sharing an edge with their predecessor. Each vertex
 * carries (birth, seed) so the fragment shader can fade it without the CPU
 * ever touching a vertex twice; a slot whose life has run out simply stops
 * contributing and is eventually overwritten.
 * ========================================================================== */

class Ribbon {
  constructor(maxSegments, material) {
    this.max = Math.max(4, maxSegments | 0);
    this.head = 0;
    this.filled = 0;
    this.enabled = true;
    this._lo = Infinity;
    this._hi = -Infinity;

    const verts = this.max * 4;
    this.pos = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.life = new Float32Array(verts * 2);   // x birth, y strength
    this.tint = new Float32Array(verts * 3);

    const idx = new (verts > 65535 ? Uint32Array : Uint16Array)(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const v = i * 4;
      const o = i * 6;
      idx[o] = v; idx[o + 1] = v + 2; idx[o + 2] = v + 1;
      idx[o + 3] = v; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aTint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    // The ring is written all over the playfield; any bounding sphere would be
    // stale within a frame of being computed, so cull manually.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;

    this.geometry = geo;
    this.mesh = mesh;
  }

  /**
   * Push one quad spanning the previous edge (l0,r0) and the new edge (l1,r1).
   * @param {number} v0 texture V at the trailing edge, v1 at the leading edge
   */
  push(l0, r0, l1, r1, birth, strength0, strength1, v0, v1, cr, cg, cb) {
    const slot = this.head;
    this.head = (this.head + 1) % this.max;
    if (this.filled < this.max) this.filled++;

    const b = slot * 4;
    const p = b * 3;
    const t = b * 2;

    this.pos[p] = l0.x; this.pos[p + 1] = l0.y; this.pos[p + 2] = l0.z;
    this.pos[p + 3] = r0.x; this.pos[p + 4] = r0.y; this.pos[p + 5] = r0.z;
    this.pos[p + 6] = r1.x; this.pos[p + 7] = r1.y; this.pos[p + 8] = r1.z;
    this.pos[p + 9] = l1.x; this.pos[p + 10] = l1.y; this.pos[p + 11] = l1.z;

    this.uv[t] = 0; this.uv[t + 1] = v0;
    this.uv[t + 2] = 1; this.uv[t + 3] = v0;
    this.uv[t + 4] = 1; this.uv[t + 5] = v1;
    this.uv[t + 6] = 0; this.uv[t + 7] = v1;

    this.life[t] = birth; this.life[t + 1] = strength0;
    this.life[t + 2] = birth; this.life[t + 3] = strength0;
    this.life[t + 4] = birth; this.life[t + 5] = strength1;
    this.life[t + 6] = birth; this.life[t + 7] = strength1;

    for (let k = 0; k < 4; k++) {
      const c = (b + k) * 3;
      this.tint[c] = cr; this.tint[c + 1] = cg; this.tint[c + 2] = cb;
    }

    if (slot < this._lo) this._lo = slot;
    if (slot > this._hi) this._hi = slot;
    return slot;
  }

  flush() {
    this.geometry.setDrawRange(0, this.filled * 6);
    if (this.mesh) this.mesh.visible = this.enabled && this.filled > 0;
    if (this._hi < this._lo) return;
    const lo = this._lo;
    const hi = this._hi;
    this._lo = Infinity;
    this._hi = -Infinity;
    const geo = this.geometry;
    const upload = (name, itemSize) => {
      const attr = geo.getAttribute(name);
      if (!attr) return;
      if (typeof attr.addUpdateRange === 'function') {
        attr.clearUpdateRanges?.();
        attr.addUpdateRange(lo * 4 * itemSize, (hi - lo + 1) * 4 * itemSize);
      }
      attr.needsUpdate = true;
    };
    upload('position', 3);
    upload('uv', 2);
    upload('aLife', 2);
    upload('aTint', 3);
  }

  clear() {
    this.head = 0;
    this.filled = 0;
    this.life.fill(0);
    this._lo = 0;
    this._hi = this.max - 1;
    this.geometry.setDrawRange(0, 0);
    if (this.mesh) this.mesh.visible = false;
  }

  dispose() {
    this.geometry?.dispose();
    this.geometry = null;
    this.mesh = null;
  }
}

/* ==========================================================================
 * Shaders
 *
 * As in fx/Particles.js: this is a ShaderMaterial, so three declares
 * modelMatrix / modelViewMatrix / projectionMatrix / normalMatrix in the
 * VERTEX prefix only. The fragment stage gets viewMatrix, cameraPosition and
 * isOrthographic and nothing else. Referencing a vertex-only uniform from the
 * fragment shader fails the link silently and draws nothing (DEFECTS.md D1).
 * ========================================================================== */

const RIBBON_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>

attribute vec2 aLife;   // x birth time, y strength 0..1
attribute vec3 aTint;

uniform float uTime;
uniform float uLife;

varying vec2  vUv;
varying float vFade;
varying vec3  vTint;

void main() {
  float age = uTime - aLife.x;
  float f = 1.0 - clamp(age / max(uLife, 1e-3), 0.0, 1.0);
  // A dead segment collapses to a point rather than being skipped on the CPU:
  // the ring buffer stays contiguous and the draw range never fragments.
  if (aLife.y <= 0.0 || f <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vFade = 0.0;
    vTint = vec3(0.0);
    return;
  }
  vUv = uv;
  vFade = aLife.y * f;
  vTint = aTint;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SKID_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>

uniform sampler2D uMap;
uniform float uOpacity;

varying vec2  vUv;
varying float vFade;
varying vec3  vTint;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  // Across the strip: dense in the middle, ragged at the shoulders, exactly
  // like the edge of a real contact patch.
  float across = tex.a;
  float a = across * vFade * uOpacity;
  if (a < 0.004) discard;

  // Fresh rubber is wet-looking: it darkens the road AND catches a faint sheen
  // down the middle of the patch. Cubing the fade keeps that highlight to the
  // first fraction of a second — it is the "just laid" cue, not a paint stripe.
  float sheen = tex.g * pow(1.0 - abs(vUv.x * 2.0 - 1.0), 3.0) * pow(vFade, 3.0);
  vec3 col = vTint * (0.55 + 0.45 * tex.r) + vec3(sheen * 0.085);

  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPEED_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>

uniform float uOpacity;
uniform float uTime;

varying vec2  vUv;
varying float vFade;
varying vec3  vTint;

void main() {
  // Taper across the ribbon: no texture, just a shaped falloff, which stays
  // crisp at any resolution and costs nothing. The taper ALONG the ribbon is
  // vFade — V is a running distance in world units and grows without bound, so
  // it can only be used for phase, never as a 0..1 position.
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  across = across * across;
  // A gentle travelling ripple so the trail reads as moving air, not as a
  // painted stripe.
  float ripple = 0.82 + 0.18 * sin(vUv.y * 26.0 - uTime * 12.0);
  float a = across * vFade * vFade * uOpacity * ripple;
  if (a < 0.004) discard;
  vec3 col = vTint * (0.6 + 0.9 * across);
  // Additive blending is (SrcAlpha, One), so the alpha channel already scales
  // the contribution. Pre-multiplying here as well would square it.
  gl_FragColor = vec4(col, a);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.a *= 1.0 - fogFactor;
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HAZE_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>

uniform sampler2D uMap;
uniform float uOpacity;
uniform float uTime;

varying vec2  vUv;
varying float vFade;
varying vec3  vTint;

void main() {
  // Two counter-scrolling samples of the same noise, warped by each other.
  // The interference is what gives the shimmer its characteristic rolling
  // cell structure instead of a uniform crawl.
  vec2 w = vec2(vUv.x, vUv.y * 0.35 - uTime * 0.55);
  float n1 = texture2D(uMap, w).r;
  vec2 w2 = vec2(vUv.x * 1.7 + n1 * 0.12, vUv.y * 0.6 + uTime * 0.31);
  float n2 = texture2D(uMap, w2).r;
  float shimmer = abs(n1 - n2) * 2.4;

  // As in the speed ribbon: V is an unbounded running distance, so the taper
  // along the strip has to come from vFade, not from the coordinate.
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = across * vFade * vFade * uOpacity * shimmer;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vTint, a);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.a *= 1.0 - fogFactor;
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ==========================================================================
 * Textures
 * ========================================================================== */

/**
 * Contact-patch profile.
 *   R  tread structure across the patch — a tyre is grooved, so is its mark
 *   G  sheen mask for the wet-rubber highlight
 *   A  density: dense centre, torn shoulders
 * V runs along the strip, so vertical banding is the tread pattern.
 */
function makeSkidTexture(w, h, seed) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const c = Math.abs(u * 2 - 1);
      // Ragged shoulders: the edge wanders along the length of the strip.
      const edge = 0.80 + 0.16 * simplex2D(u * 2.0, v * 12.0, seed);
      let a = 1 - Math.max(0, (c - edge * 0.62) / Math.max(1e-3, edge - edge * 0.62));
      a = clamp(a, 0, 1);
      a *= 0.72 + 0.34 * (fbm2D(u * 5.0, v * 22.0, 3, 2.2, 0.55, seed ^ 0x31) * 0.5 + 0.5);
      // Longitudinal tread grooves: four ribs, softened by wear.
      const groove = 0.5 + 0.5 * Math.cos(u * Math.PI * 8);
      a *= 0.62 + 0.38 * groove;
      const sheen = clamp(groove * (0.4 + 0.6 * (simplex2D(u * 9, v * 30, seed ^ 0x7f) * 0.5 + 0.5)), 0, 1);
      const struct = 0.45 + 0.55 * (fbm2D(u * 9.0, v * 40.0, 3, 2.1, 0.5, seed ^ 0x55) * 0.5 + 0.5);
      const o = (y * w + x) * 4;
      data[o] = struct * 255;
      data[o + 1] = sheen * 255;
      data[o + 2] = 0;
      data[o + 3] = clamp(a, 0, 1) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Seamless noise tile for the heat shimmer. Tiles exactly in both axes, so
 *  the two counter-scrolling samples never reveal a repeat seam. */
function makeHazeTexture(size, seed) {
  const data = new Uint8Array(size * size * 4);
  // An INTEGER period, and the pixel grid mapped exactly onto it: fbm2DTiled
  // rounds the period it is given, so a fractional one wraps a hair off and
  // leaves a seam that a scrolling sample crosses twice a second.
  const PERIOD = 8;
  const step = PERIOD / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm2DTiled(x * step, y * step, PERIOD, 4, 2.1, 0.55, seed);
      const v = clamp(n * 0.85 + 0.5, 0, 1);
      const o = (y * size + x) * 4;
      data[o] = v * 255;
      data[o + 1] = v * 255;
      data[o + 2] = v * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ==========================================================================
 * Trails
 * ========================================================================== */

export class Trails {
  name = 'trails';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.enabled = true;
    this.clock = 0;
    this._steppedThisFrame = false;
    this._ready = false;

    this.group = new THREE.Group();
    this.group.name = 'fx:trails';
    this.group.matrixAutoUpdate = false;

    const q = ctx.settings?.quality ?? 'high';
    const skidBudget = ctx.settings?.world?.skidBudget
      ?? (q === 'low' ? 24 : q === 'medium' ? 48 : q === 'high' ? 72 : 96);
    // Settings publishes skidBudget as "simultaneous ribbons". At 1.15 u per
    // segment this gives each of them ~39 u of strip before the ring starts
    // eating its own tail — a full slide through a hairpin at racing speed.
    this.skidSegments = clamp(Math.round(skidBudget * 34), 400, 5200);
    this.speedSegments = clamp(Math.round(skidBudget * 5), 96, 700);
    this.hazeSegments = clamp(Math.round(skidBudget * 3), 64, 420);

    /* --- ownership handshake with world/Decals.js ------------------------ */
    this.ownsGroundMarks = false;
    this.skidLife = 1.5;          // s — fresh rubber, fading onto the decal
    this.persistentLife = 240;    // s — used when we own the marks outright

    this.tuning = {
      skidMinStrength: 0.06,
      speedThreshold: 0.80,       // fraction of top speed the ribbon starts at
      speedLife: 0.34,
      hazeLife: 0.42,
      // Layered over the permanent decal, this is an accent; owning the marks
      // outright makes it the only mark on the road, so it has to carry.
      skidOpacity: 0.48,
      speedOpacity: 0.55,
      hazeOpacity: 0.16,
    };

    this.skid = null;
    this.speed = null;
    this.haze = null;
    this._materials = [];
    this._textures = [];
    this._wheels = new Map();     // vehicle -> per-wheel strip state
    this._cars = new Map();       // vehicle -> speed/haze strip state
    this._offBus = [];
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const ctx = this.ctx;
    const seed = ctx.seed ?? ctx.track?.seed ?? 1337;

    // world/Decals.js keeps the permanent rubber unless it is absent or has
    // already handed the job over. See the header note.
    const decals = ctx.decals;
    this.ownsGroundMarks = !decals || decals.ownsTyreMarks === false || !decals.markMesh;

    try {
      const skidTex = makeSkidTexture(64, 256, seed);
      this._textures.push(skidTex);
      const skidMat = new THREE.ShaderMaterial({
        name: 'fx:skidRibbon',
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uMap: { value: null },
            uTime: { value: 0 },
            uLife: { value: this.ownsGroundMarks ? this.persistentLife : this.skidLife },
            uOpacity: { value: this.ownsGroundMarks ? 0.92 : this.tuning.skidOpacity },
          },
        ]),
        vertexShader: RIBBON_VERT,
        fragmentShader: SKID_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        fog: true,
        // Sits above the permanent decal, which itself is offset off the road.
        polygonOffset: true,
        polygonOffsetFactor: -8,
        polygonOffsetUnits: -16,
      });
      skidMat.uniforms.uMap.value = skidTex;
      skidMat.customProgramCacheKey = () => 'mg:fx:skid';
      this._materials.push(skidMat);
      this.skid = new Ribbon(this.skidSegments, skidMat);
      this.skid.mesh.name = 'fx:skidRibbon';
      this.skid.mesh.renderOrder = 7;   // Decals draws its marks at 6
      this.group.add(this.skid.mesh);
    } catch (err) {
      console.warn('[Trails] skid ribbon unavailable', err);
    }

    try {
      const speedMat = new THREE.ShaderMaterial({
        name: 'fx:speedRibbon',
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uTime: { value: 0 },
            uLife: { value: this.tuning.speedLife },
            uOpacity: { value: this.tuning.speedOpacity },
          },
        ]),
        vertexShader: RIBBON_VERT,
        fragmentShader: SPEED_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: true,
      });
      speedMat.customProgramCacheKey = () => 'mg:fx:speed';
      this._materials.push(speedMat);
      this.speed = new Ribbon(this.speedSegments, speedMat);
      this.speed.mesh.name = 'fx:speedRibbon';
      this.speed.mesh.renderOrder = 21;
      this.group.add(this.speed.mesh);
    } catch (err) {
      console.warn('[Trails] speed ribbon unavailable', err);
    }

    try {
      const hazeTex = makeHazeTexture(128, seed ^ 0x4d2);
      this._textures.push(hazeTex);
      const hazeMat = new THREE.ShaderMaterial({
        name: 'fx:heatHaze',
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uMap: { value: null },
            uTime: { value: 0 },
            uLife: { value: this.tuning.hazeLife },
            uOpacity: { value: this.tuning.hazeOpacity },
          },
        ]),
        vertexShader: RIBBON_VERT,
        fragmentShader: HAZE_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: true,
      });
      hazeMat.uniforms.uMap.value = hazeTex;
      hazeMat.customProgramCacheKey = () => 'mg:fx:haze';
      this._materials.push(hazeMat);
      this.haze = new Ribbon(this.hazeSegments, hazeMat);
      this.haze.mesh.name = 'fx:heatHaze';
      this.haze.mesh.renderOrder = 19;
      this.group.add(this.haze.mesh);
    } catch (err) {
      console.warn('[Trails] heat haze unavailable', err);
    }

    ctx.scene?.add?.(this.group);
    this.group.updateMatrixWorld(true);
    this.applySettings(ctx.settings);

    const bus = ctx.bus;
    if (bus?.on) {
      this._offBus.push(bus.on('race:reset', () => this.clear()));
      this._offBus.push(bus.on('race:restart', () => this.clear()));
      this._offBus.push(bus.on('vehicle:respawn', (p) => this._breakStrips(p?.vehicle)));
    }

    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.trails = this;
    }
    this._ready = true;
    return this;
  }

  /**
   * Take the permanent ground marks away from world/Decals.js. Not the default
   * — see the header — but exposed so a reviewer can A/B the two layers.
   */
  takeGroundMarks() {
    this.ownsGroundMarks = true;
    try { this.ctx?.decals?.disableTyreMarks?.(); } catch (_) { /* optional peer */ }
    const u = this.skid?.mesh?.material?.uniforms;
    if (u) {
      u.uLife.value = this.persistentLife;
      u.uOpacity.value = 0.92;
    }
    return this;
  }

  /* ------------------------------------------------------------- per tick */

  fixedUpdate(fdt, ctx) {
    if (!this._ready || !this.enabled) return;
    this.ctx = ctx || this.ctx;
    this.clock += fdt;
    this._steppedThisFrame = true;

    const vehicles = this.ctx?.vehicles;
    if (!vehicles || !vehicles.length) return;
    for (let i = 0; i < vehicles.length; i++) {
      const car = vehicles[i];
      if (!car) continue;
      this._layStrips(car);
      this._laySpeed(car);
      this._layHaze(car);
    }
  }

  update(dt, ctx) {
    if (!this._ready) return;
    this.ctx = ctx || this.ctx;
    if (!this._steppedThisFrame) this.clock += Math.min(dt, 0.05);
    this._steppedThisFrame = false;

    for (let i = 0; i < this._materials.length; i++) {
      this._materials[i].uniforms.uTime.value = this.clock;
    }
    this.skid?.flush();
    this.speed?.flush();
    this.haze?.flush();
  }

  /* ------------------------------------------------------------- skid marks */

  _wheelState(car) {
    let s = this._wheels.get(car);
    if (!s) {
      s = [];
      for (let i = 0; i < 4; i++) {
        s.push({
          active: false, hasEdge: false,
          x: 0, y: 0, z: 0,
          lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0,
          strength: 0, v: 0,
        });
      }
      this._wheels.set(car, s);
    }
    return s;
  }

  /**
   * Lay fresh rubber under every sliding tyre.
   *
   * The strip follows the *contact point* the suspension actually found — not
   * the wheel hub and not the car's centreline — and its width comes from the
   * vertical load through that corner, so a heavily loaded outside front lays a
   * visibly broader mark than an unloaded inside rear. That asymmetry is what
   * makes the pair of lines out of a corner read as a car under load.
   */
  _layStrips(car) {
    const ribbon = this.skid;
    const wheels = car.wheels;
    if (!ribbon || !Array.isArray(wheels) || wheels.length < 4) return;
    const st = this._wheelState(car);
    const loadRef = car.tires?.loadRef ?? 65;
    const minS = this.tuning.skidMinStrength;

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const rec = st[i];
      if (!w) continue;

      const hardness = w.surfaceHardness ?? 1;
      let strength = w.markIntensity ?? 0;
      // A loose surface does not blacken — it churns, which is Particles' job.
      if (!w.grounded || hardness < 0.3 || strength < minS) {
        rec.active = false;
        rec.hasEdge = false;
        continue;
      }

      const cx = w.contactX;
      const cy = w.contactY;
      const cz = w.contactZ;
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) { rec.active = false; continue; }

      if (!rec.active) {
        rec.active = true;
        rec.hasEdge = false;
        rec.x = cx; rec.y = cy; rec.z = cz;
        continue;
      }

      const dx = cx - rec.x;
      const dy = cy - rec.y;
      const dz = cz - rec.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < STEP_MIN2) continue;
      if (d2 > BREAK2) {
        // Respawned or teleported: start again rather than draw a 40 u smear.
        rec.hasEdge = false;
        rec.x = cx; rec.y = cy; rec.z = cz;
        continue;
      }

      const d = Math.sqrt(d2);
      const inv = 1 / d;

      // Lateral axis = travel direction crossed with the contact normal, so the
      // strip lies in the plane of the road even through banking and over a bump.
      let nx = w.normalX;
      let ny = w.normalY;
      let nz = w.normalZ;
      if (!(ny > 0.05)) { nx = 0; ny = 1; nz = 0; }
      _v0.set(dx * inv, dy * inv, dz * inv);
      _v1.set(nx, ny, nz).normalize();
      _v2.crossVectors(_v1, _v0);
      if (_v2.lengthSq() < 1e-8) _v2.set(dz * inv, 0, -dx * inv);
      _v2.normalize();

      const loadK = clamp((w.load ?? loadRef) / Math.max(1e-3, loadRef), 0.3, 1.9);
      const halfW = TYRE_HALF * (0.70 + 0.42 * loadK);

      if (w.locked) strength = Math.min(1, strength * 1.30 + 0.20);
      else if (w.spinning) strength = Math.min(1, strength * 1.15 + 0.10);
      strength = clamp(strength * hardness * clamp(0.55 + 0.45 * loadK, 0.35, 1.15), 0, 1);
      if (strength < minS) { rec.x = cx; rec.y = cy; rec.z = cz; continue; }

      const lift = SKID_LIFT;
      _v3.set(cx - _v2.x * halfW + _v1.x * lift,
        cy - _v2.y * halfW + _v1.y * lift,
        cz - _v2.z * halfW + _v1.z * lift);
      _v0.set(cx + _v2.x * halfW + _v1.x * lift,
        cy + _v2.y * halfW + _v1.y * lift,
        cz + _v2.z * halfW + _v1.z * lift);

      if (!rec.hasEdge) {
        rec.lx = _v3.x; rec.ly = _v3.y; rec.lz = _v3.z;
        rec.rx = _v0.x; rec.ry = _v0.y; rec.rz = _v0.z;
        rec.hasEdge = true;
        rec.v = 0;
        rec.strength = strength;
        rec.x = cx; rec.y = cy; rec.z = cz;
        continue;
      }

      _v1.set(rec.lx, rec.ly, rec.lz);
      _v2.set(rec.rx, rec.ry, rec.rz);
      const v1 = rec.v + d / 6.0;
      const tint = this._tintFor(w.surface);
      ribbon.push(_v1, _v2, _v3, _v0, this.clock, rec.strength, strength,
        rec.v, v1, tint.r, tint.g, tint.b);

      rec.lx = _v3.x; rec.ly = _v3.y; rec.lz = _v3.z;
      rec.rx = _v0.x; rec.ry = _v0.y; rec.rz = _v0.z;
      rec.v = v1;
      rec.strength = strength;
      rec.x = cx; rec.y = cy; rec.z = cz;
    }
  }

  /**
   * Colour of the mark. Rubber on wood is not the same black as rubber on
   * tile, and a tyre dragging through milk leaves a pale streak, so the tint
   * comes from the surface library rather than from a constant.
   */
  _tintFor(surface) {
    const rec = surfaceRecord(surface);
    _col.setHex(rec.skidTint ?? 0x1a1a1a);
    // Lift it fractionally off pure black: a mark that crushes to zero reads as
    // a hole in the road, which is DEFECTS.md D3 in miniature.
    _col.r = Math.max(_col.r, 0.012);
    _col.g = Math.max(_col.g, 0.012);
    _col.b = Math.max(_col.b, 0.014);
    return _col;
  }

  /* ---------------------------------------------------- speed / boost trail */

  _carState(car) {
    let s = this._cars.get(car);
    if (!s) {
      s = {
        speed: [
          { has: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, v: 0, s: 0 },
          { has: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, v: 0, s: 0 },
        ],
        haze: { has: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, v: 0, s: 0 },
      };
      this._cars.set(car, s);
    }
    return s;
  }

  /**
   * Two ribbons off the rear quarters. They exist to make speed legible from a
   * high camera: boost dominates, and above 80% of the car's own top speed a
   * fainter trail comes in so a fast car is readable even without boost.
   */
  _laySpeed(car) {
    const ribbon = this.speed;
    if (!ribbon || !ribbon.enabled) return;
    const top = Math.max(1, car.topSpeed || 100);
    const frac = (car.speed || 0) / top;
    const boost = saturate(car.boostAmount ?? (car.boosting ? 1 : 0));
    const fast = saturate((frac - this.tuning.speedThreshold) / Math.max(0.01, 1 - this.tuning.speedThreshold));
    const strength = saturate(boost * 1.0 + fast * 0.45);
    const st = this._carState(car);

    if (strength < 0.05) {
      st.speed[0].has = false;
      st.speed[1].has = false;
      return;
    }

    const halfW = (car.spec?.bodyWidth ?? 4) * 0.42;
    const len = car.spec?.bodyLength ?? 9;
    const hgt = car.spec?.bodyHeight ?? 2.8;
    // Boost runs blue and hot; a plain speed trail is a cool white so it never
    // reads as "this car is boosting" when it is not.
    _col.setHex(boost > 0.15 ? 0x5fb8ff : 0xdfe9f5);
    const width = 0.55 + boost * 0.85;

    for (let side = 0; side < 2; side++) {
      const rec = st.speed[side];
      const sx = side === 0 ? -halfW : halfW;
      _v0.set(sx, hgt * 0.34, -len * 0.5 - 0.4);
      if (car.quaternion) _v0.applyQuaternion(car.quaternion);
      if (car.position) _v0.add(car.position);

      // Ribbon plane: perpendicular to the car's forward, tilted so the strip
      // faces roughly upward — the chase camera looks down at 55 degrees.
      _v1.set(0, 1, 0);
      if (car.quaternion) _v1.applyQuaternion(car.quaternion);
      _v2.copy(_v1).multiplyScalar(width);
      _v3.copy(_v0).sub(_v2);
      _v2.copy(_v0).add(_v2);

      if (!rec.has) {
        rec.has = true;
        rec.ax = _v3.x; rec.ay = _v3.y; rec.az = _v3.z;
        rec.bx = _v2.x; rec.by = _v2.y; rec.bz = _v2.z;
        rec.v = 0;
        rec.s = strength;
        continue;
      }

      const dx = _v3.x - rec.ax;
      const dy = _v3.y - rec.ay;
      const dz = _v3.z - rec.az;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1.1 * 1.1) continue;
      if (d2 > 60 * 60) {
        rec.has = false;
        continue;
      }
      const v1 = rec.v + Math.sqrt(d2) / 26;
      _v0.set(rec.ax, rec.ay, rec.az);
      _v1.set(rec.bx, rec.by, rec.bz);
      ribbon.push(_v0, _v1, _v3, _v2, this.clock, rec.s, strength, rec.v, v1, _col.r, _col.g, _col.b);

      rec.ax = _v3.x; rec.ay = _v3.y; rec.az = _v3.z;
      rec.bx = _v2.x; rec.by = _v2.y; rec.bz = _v2.z;
      rec.v = v1;
      rec.s = strength;
    }
  }

  /* ------------------------------------------------------------- heat haze */

  /**
   * Exhaust shimmer. Driven by engine load rather than by speed, so it is
   * strongest under acceleration out of a corner — which is when the camera is
   * behind the car and can actually see it.
   */
  _layHaze(car) {
    const ribbon = this.haze;
    if (!ribbon || !ribbon.enabled) return;
    const st = this._carState(car).haze;
    const load = saturate(car.engineLoad ?? car.throttle ?? 0);
    const rpm = saturate((car.rpm ?? 0) / Math.max(1, car.tuning?.redlineRpm ?? 8000));
    const boost = saturate(car.boostAmount ?? 0);
    const strength = saturate(load * (0.35 + 0.65 * rpm) * 0.8 + boost * 0.6);
    if (strength < 0.06 || car.isAirborne) { st.has = false; return; }

    const len = car.spec?.bodyLength ?? 9;
    const hgt = car.spec?.bodyHeight ?? 2.8;
    _v0.set(0, hgt * 0.36, -len * 0.5 - 0.9);
    if (car.quaternion) _v0.applyQuaternion(car.quaternion);
    if (car.position) _v0.add(car.position);

    const width = 1.5 + strength * 1.6;
    _v1.set(1, 0, 0);
    if (car.quaternion) _v1.applyQuaternion(car.quaternion);
    _v1.multiplyScalar(width);
    _v3.copy(_v0).sub(_v1);
    _v2.copy(_v0).add(_v1);

    if (!st.has) {
      st.has = true;
      st.ax = _v3.x; st.ay = _v3.y; st.az = _v3.z;
      st.bx = _v2.x; st.by = _v2.y; st.bz = _v2.z;
      st.v = 0;
      st.s = strength;
      return;
    }

    const dx = _v3.x - st.ax;
    const dy = _v3.y - st.ay;
    const dz = _v3.z - st.az;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1.6 * 1.6) return;
    if (d2 > 60 * 60) { st.has = false; return; }

    const v1 = st.v + Math.sqrt(d2) / 22;
    _v0.set(st.ax, st.ay, st.az);
    _v1.set(st.bx, st.by, st.bz);
    // A warm, almost colourless tint: hot air scatters slightly warm, and
    // anything more saturated stops reading as air.
    ribbon.push(_v0, _v1, _v3, _v2, this.clock, st.s, strength, st.v, v1, 0.30, 0.24, 0.17);

    st.ax = _v3.x; st.ay = _v3.y; st.az = _v3.z;
    st.bx = _v2.x; st.by = _v2.y; st.bz = _v2.z;
    st.v = v1;
    st.s = strength;
  }

  /* ---------------------------------------------------------------- control */

  /** Break every open strip for a vehicle, so nothing bridges a teleport. */
  _breakStrips(car) {
    if (!car) return;
    const st = this._wheels.get(car);
    if (st) for (let i = 0; i < 4; i++) { st[i].active = false; st[i].hasEdge = false; }
    const cs = this._cars.get(car);
    if (cs) {
      cs.speed[0].has = false;
      cs.speed[1].has = false;
      cs.haze.has = false;
    }
  }

  clear() {
    this.skid?.clear();
    this.speed?.clear();
    this.haze?.clear();
    for (const st of this._wheels.values()) {
      for (let i = 0; i < 4; i++) { st[i].active = false; st[i].hasEdge = false; }
    }
    for (const cs of this._cars.values()) {
      cs.speed[0].has = false;
      cs.speed[1].has = false;
      cs.haze.has = false;
    }
    return this;
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.group.visible = this.enabled;
    return this;
  }

  applySettings(settings) {
    const s = settings || this.ctx?.settings;
    const on = s?.particles?.enabled !== false && s?.post?.decals !== false;
    this.setEnabled(on);
    const q = s?.quality;
    // Speed ribbons and haze are the first things to go on a weak machine;
    // the skid ribbon stays, because it is a gameplay read, not decoration.
    if (this.speed) this.speed.enabled = q !== 'low';
    if (this.haze) this.haze.enabled = q === 'high' || q === 'ultra' || q === undefined;
    return this;
  }

  setQuality(tier) {
    return this.applySettings(this.ctx?.settings);
  }

  onResize() {}

  info() {
    return {
      ownsGroundMarks: this.ownsGroundMarks,
      skid: this.skid ? `${this.skid.filled}/${this.skid.max}` : 'off',
      speed: this.speed ? `${this.speed.filled}/${this.speed.max}` : 'off',
      haze: this.haze ? `${this.haze.filled}/${this.haze.max}` : 'off',
      skidLife: this.skid?.mesh?.material?.uniforms?.uLife?.value ?? 0,
    };
  }

  dispose() {
    for (const off of this._offBus) { try { off?.(); } catch (_) { /* already gone */ } }
    this._offBus.length = 0;
    this.skid?.dispose();
    this.speed?.dispose();
    this.haze?.dispose();
    for (const m of this._materials) m.dispose?.();
    for (const t of this._textures) t.dispose?.();
    this._materials.length = 0;
    this._textures.length = 0;
    this._wheels.clear();
    this._cars.clear();
    this.group.parent?.remove(this.group);
  }
}

export const TrailSystem = Trails;
export default Trails;
