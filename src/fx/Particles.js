// fx/Particles.js — the instanced particle foundry.
//
// One draw call per kind, one preallocated pool per kind, and not a single
// allocation after init(). Eleven kinds share one shader, specialised by
// #defines, so the whole system is three programs' worth of GPU state.
//
// ---------------------------------------------------------------- the design
//
// **The CPU never simulates a particle.** A particle is fully described by its
// spawn state — position, velocity, birth time, lifetime, seed — and every
// frame the vertex shader re-derives where it is from `uTime - birth`. That
// means the attribute buffers are written exactly once, at spawn, and the
// per-frame CPU cost is one pass over the live list to retire the dead ones.
// A 6000-particle scene costs about 0.1 ms of JavaScript.
//
// The integration is analytic, not stepped:
//
//   v(t) = (v0 - g/k) e^-kt + g/k
//   p(t) = p0 + (v0 - g/k)(1 - e^-kt)/k + (g/k) t
//
// which is the exact solution of linear drag under constant gravity. Sparks and
// debris swap that for a ballistic path with an analytic bounce against the
// ground plane they were born on — solve for the impact time, reflect, repeat
// three times. Both are closed-form, so a particle looks identical whether the
// frame rate is 30 or 300, and `?t=12` fast-forwards them for free.
//
// ------------------------------------------------------------ what sells them
//
// 1. **Soft particles.** A half-resolution depth prepass of the opaque scene is
//    kept in a DepthTexture; the fragment shader fades alpha out over the last
//    few units before the intersection. Without it every puff cuts the ground
//    with a razor line and the whole frame reads as amateur. See DepthProbe.
//
// 2. **Lighting with form.** The billboard is shaded as if it were a sphere:
//    the sprite UV gives a hemispherical normal, which is rotated into world
//    space and lit with a *wrapped* diffuse term (light bends around a puff
//    rather than terminating at the equator), a hemisphere ambient split
//    sky/ground, and a forward-scattering lobe so a puff between the camera and
//    the sun glows at its rim. Grey smoke is the single biggest tell there is.
//
// 3. **Curl turbulence.** Displacement is the curl of an analytic three-octave
//    sine potential. Curl of anything is divergence-free by construction, so
//    the field neither compresses nor rarefies the cloud: it rolls it. Nine
//    cosines, no noise texture, no finite differences.
//
// 4. **Erosion, not fading.** Each sprite carries a second mask in its green
//    channel; alpha is thresholded against it and the threshold climbs with
//    age. Smoke therefore dissipates into wisps instead of uniformly dimming.
//
// ---------------------------------------------------------------- the shaders
//
// Everything below is a `ShaderMaterial`, which means three prepends its own
// prefix. That prefix declares `modelMatrix`, `modelViewMatrix`,
// `projectionMatrix`, `normalMatrix` and `cameraPosition` in the VERTEX stage,
// but only `viewMatrix`, `cameraPosition` and `isOrthographic` in the FRAGMENT
// stage. Referencing a vertex-only uniform from the fragment shader silently
// fails to link and the material draws nothing at all — that mistake has
// already cost this project one debugging session (DEFECTS.md D1). Everything
// the fragment stage here needs is either declared by that prefix, declared by
// us, or passed as a varying. Do not add `normalMatrix` to the fragment shader.

import * as THREE from 'three';
import {
  clamp, saturate, lerp, smoothstep, makeRng, fbm2D, simplex2D, worley2D,
} from '../core/Random.js';
import { surfaceRecord } from '../vehicle/Tires.js';

/* ==========================================================================
 * Module scratch. Nothing in this file allocates after init().
 * ========================================================================== */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const _size = new THREE.Vector2();

/* ==========================================================================
 * Surface metadata
 *
 * Tires.js already resolves the physical record (grip, hardness, particle
 * kind, colour) and is safe to import statically — it depends only on
 * core/Random.js. Surfaces.js additionally carries `particleRate`, but it
 * pulls in ProcTex and Settings at module scope, so it is adopted
 * asynchronously exactly the way Tires.js does it: if it never resolves, the
 * rates below stand and nothing breaks.
 * ========================================================================== */

let _surfaceMod = null;
try {
  import('../textures/Surfaces.js')
    .then((m) => { if (m && m.SURFACE_DEFS) _surfaceMod = m; })
    .catch(() => { /* defaults stand */ });
} catch (_) { /* environments without dynamic import */ }

function surfaceParticleRate(name) {
  const d = _surfaceMod?.SURFACE_DEFS?.[name];
  return Number.isFinite(d?.particleRate) ? d.particleRate : 1;
}

function surfaceParticleColor(name) {
  const d = _surfaceMod?.SURFACE_DEFS?.[name];
  if (Number.isFinite(d?.particleColor)) return d.particleColor;
  return surfaceRecord(name).particleColor || 0xb9a68c;
}

/* ==========================================================================
 * Kind table
 *
 * Every number here is an art decision. Sizes are in world units, i.e.
 * centimetres: a car is 9 long and a wheel is 1.15 in radius, so a tyre-smoke
 * puff that starts at 2 and grows to 13 is a plume about one and a half car
 * lengths across by the time it dies. That is the correct scale for a
 * miniature — real-scale smoke at this camera distance reads as fog.
 * ========================================================================== */

const KIND_DEFS = {
  tyreSmoke: {
    sprite: 'smoke',
    blend: 'alpha', lit: true, soft: true, erode: true, fog: true,
    renderOrder: 12,
    life: [0.95, 1.85],
    size: [1.9, 13.5], growPow: 0.52,
    color: 0xb9b3ab, colorEnd: 0x7d7b78,
    opacity: 0.46, fadeIn: 0.10, fadeOut: 0.42,
    drag: 2.1, gravity: -0.030, turbulence: 1.00, turbScale: 0.055,
    // softDist is the world depth over which the puff fades into whatever is
    // behind it. It has to be about a puff radius: any longer and a plume
    // sitting on the road — which is where every plume starts — is dimmed to
    // nothing by the very ground it is standing on.
    spin: 1.5, wrap: 0.62, scatter: 0.85, softDist: 3.0,
  },
  dust: {
    sprite: 'smoke',
    blend: 'alpha', lit: true, soft: true, erode: true, fog: true,
    renderOrder: 12,
    life: [0.75, 1.5],
    size: [1.5, 9.5], growPow: 0.50,
    color: 0xb9a68c, colorEnd: 0x9d8e78,
    opacity: 0.40, fadeIn: 0.09, fadeOut: 0.40,
    drag: 2.4, gravity: 0.020, turbulence: 0.72, turbScale: 0.070,
    spin: 1.7, wrap: 0.58, scatter: 0.70, softDist: 2.6,
  },
  // Grains, chips, droplets and sparks are all a few pixels across and mostly
  // *resting on* the ground rather than intersecting it. Depth-fading them
  // would erase them the moment they land, and there is no hard intersection
  // line to hide at that size: the ordinary depth test is the right answer.
  sand: {
    sprite: 'grain',
    blend: 'alpha', lit: true, soft: false, erode: false, fog: true,
    bounce: true,
    renderOrder: 13,
    life: [0.45, 0.95],
    size: [0.42, 0.30], growPow: 1.0,
    color: 0xdcc79c, colorEnd: 0xc0ab84,
    opacity: 0.95, fadeIn: 0.02, fadeOut: 0.72,
    drag: 0.55, gravity: 1.0, turbulence: 0, turbScale: 0.10,
    spin: 5.5, wrap: 0.35, scatter: 0.25, softDist: 2.5,
    restitution: 0.10, tangentFriction: 0.42,
  },
  grassClipping: {
    sprite: 'blade',
    blend: 'alpha', lit: true, soft: false, erode: false, fog: true,
    bounce: true,
    renderOrder: 13,
    life: [0.7, 1.5],
    size: [0.85, 0.85], growPow: 1.0,
    color: 0x5f9435, colorEnd: 0x4d7a2c,
    opacity: 1.0, fadeIn: 0.03, fadeOut: 0.76,
    // Low gravity scale plus heavy tangential loss: a clipping flutters down
    // and stops dead, which is exactly what a shred of grass does.
    drag: 1.5, gravity: 0.55, turbulence: 0, turbScale: 0.16,
    spin: 11.0, wrap: 0.40, scatter: 0.55, softDist: 2.0,
    restitution: 0.05, tangentFriction: 0.25,
  },
  sparks: {
    sprite: 'streak',
    blend: 'add', lit: false, soft: false, erode: false, fog: 'fade',
    stretch: true, bounce: true,
    renderOrder: 22,
    life: [0.28, 0.72],
    size: [0.24, 0.10], growPow: 1.0,
    // Longest at birth, when it is moving fastest; the shader scales this
    // again by the projected speed so a spark coming at the camera is a point.
    stretchLength: [3.2, 1.1],
    color: 0xffd9a0, colorEnd: 0xff4a12,
    opacity: 1.0, fadeIn: 0.0, fadeOut: 0.42,
    drag: 0.12, gravity: 1.0, turbulence: 0.0, turbScale: 0.0,
    spin: 0, wrap: 0, scatter: 0, softDist: 1.6,
    restitution: 0.42, tangentFriction: 0.72,
  },
  waterSplash: {
    sprite: 'droplet',
    blend: 'alpha', lit: true, soft: false, erode: false, fog: true,
    bounce: true,
    renderOrder: 14,
    life: [0.35, 0.8],
    size: [0.55, 0.34], growPow: 1.0,
    color: 0xbcd4dc, colorEnd: 0x8fb2be,
    opacity: 0.82, fadeIn: 0.02, fadeOut: 0.58,
    drag: 0.42, gravity: 1.0, turbulence: 0, turbScale: 0.10,
    spin: 2.0, wrap: 0.75, scatter: 1.15, softDist: 2.2,
    restitution: 0.08, tangentFriction: 0.30,
  },
  milkSplash: {
    sprite: 'droplet',
    blend: 'alpha', lit: true, soft: false, erode: false, fog: true,
    bounce: true,
    renderOrder: 14,
    life: [0.4, 0.9],
    size: [0.62, 0.40], growPow: 1.0,
    color: 0xf6f5ef, colorEnd: 0xe4e2d8,
    opacity: 0.95, fadeIn: 0.02, fadeOut: 0.58,
    drag: 0.55, gravity: 1.0, turbulence: 0, turbScale: 0.10,
    spin: 2.0, wrap: 0.85, scatter: 0.55, softDist: 2.2,
    restitution: 0.06, tangentFriction: 0.28,
  },
  exhaust: {
    sprite: 'smoke',
    blend: 'alpha', lit: true, soft: true, erode: true, fog: true,
    renderOrder: 11,
    life: [0.42, 0.85],
    size: [0.75, 4.6], growPow: 0.45,
    color: 0x9c9891, colorEnd: 0x76736e,
    opacity: 0.24, fadeIn: 0.12, fadeOut: 0.30,
    drag: 3.4, gravity: -0.14, turbulence: 0.90, turbScale: 0.11,
    spin: 2.6, wrap: 0.68, scatter: 0.75, softDist: 2.0,
  },
  debris: {
    sprite: 'grain',
    blend: 'alpha', lit: true, soft: false, erode: false, fog: true,
    bounce: true,
    renderOrder: 13,
    life: [0.55, 1.3],
    size: [0.34, 0.26], growPow: 1.0,
    color: 0x9a9184, colorEnd: 0x7d7568,
    opacity: 1.0, fadeIn: 0.02, fadeOut: 0.78,
    drag: 0.35, gravity: 1.0, turbulence: 0, turbScale: 0.10,
    spin: 9.0, wrap: 0.35, scatter: 0.2, softDist: 1.6,
    restitution: 0.30, tangentFriction: 0.6,
  },
  boostFlame: {
    sprite: 'flame',
    blend: 'add', lit: false, soft: true, erode: true, fog: 'fade',
    renderOrder: 21,
    life: [0.16, 0.34],
    size: [1.5, 4.2], growPow: 0.62,
    color: 0x66c6ff, colorEnd: 0x1a3fd0,
    opacity: 0.85, fadeIn: 0.06, fadeOut: 0.22,
    drag: 3.6, gravity: -0.35, turbulence: 0.85, turbScale: 0.13,
    spin: 4.0, wrap: 0, scatter: 0, softDist: 1.5,
  },
  dustMote: {
    sprite: 'mote',
    blend: 'add', lit: false, soft: false, erode: false, fog: 'fade',
    renderOrder: 20,
    life: [7.0, 15.0],
    // A few pixels across at chase distance; the tilt-shift turns them into
    // bokeh. Any bigger and a light shaft reads as falling snow.
    size: [0.16, 0.22], growPow: 1.0,
    color: 0xfff0d8, colorEnd: 0xffe9c4,
    opacity: 0.30, fadeIn: 0.16, fadeOut: 0.55,
    // Amplitude is deliberately tiny: over a fifteen-second life even 0.06
    // wanders a mote several units, which is all the air movement a kitchen has.
    drag: 0.5, gravity: 0.0012, turbulence: 0.06, turbScale: 0.026,
    spin: 0.4, wrap: 0, scatter: 0, softDist: 3,
  },
};

export const PARTICLE_KINDS = Object.keys(KIND_DEFS);

/** Default pool sizes, used when Settings does not supply a per-kind budget. */
const DEFAULT_CAPACITY = {
  tyreSmoke: 1400, dust: 1200, sand: 700, grassClipping: 400, sparks: 600,
  waterSplash: 500, milkSplash: 400, exhaust: 400, debris: 300,
  boostFlame: 300, dustMote: 900,
};

/* ==========================================================================
 * Sprite foundry
 *
 * Four channels, each doing a job:
 *   R  fine luminance detail — breaks the sprite up so two overlapping puffs
 *      do not read as one flat blob
 *   G  erosion mask — thresholded against age so smoke dissipates in wisps
 *   B  optical thickness — darkens the core under the key light, which is what
 *      gives a puff an inside and an outside
 *   A  density
 *
 * Written straight into a DataTexture rather than through a canvas: a 2D
 * canvas stores premultiplied colour, so round-tripping through one quantises
 * every channel wherever alpha is low, which is exactly where smoke lives.
 * ========================================================================== */

function makeSpriteTexture(w, h, fill) {
  const data = new Uint8Array(w * h * 4);
  fill(data, w, h);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Raw mask data, not colour: no sRGB decode may be applied to it.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return tex;
}

const SPRITES = {
  /** Billowing puff: warped radial falloff, fbm density, erosion and thickness. */
  smoke(seed) {
    return makeSpriteTexture(128, 128, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const v = (y / (h - 1)) * 2 - 1;
        for (let x = 0; x < w; x++) {
          const u = (x / (w - 1)) * 2 - 1;
          const r = Math.sqrt(u * u + v * v);
          // Low-frequency radius warp: the silhouette is lumpy, not circular.
          const warp = fbm2D(u * 1.45 + 11.3, v * 1.45 - 7.1, 3, 2.1, 0.55, seed) * 0.30;
          const rr = r * (1 + warp);
          let a = 1 - smoothstep(0.30, 1.0, rr);
          const det = fbm2D(u * 3.3 + 3.7, v * 3.3 + 9.1, 5, 2.2, 0.52, seed ^ 0x51) * 0.5 + 0.5;
          a *= 0.36 + 0.86 * det;
          a = saturate(a);
          const eroN = fbm2D(u * 2.5 - 5.1, v * 2.5 + 2.7, 4, 2.0, 0.5, seed ^ 0x9d) * 0.5 + 0.5;
          // Erosion eats from the rim inwards: the centre survives longest.
          const ero = saturate(eroN * 0.60 + (1 - saturate(rr)) * 0.52);
          const th = saturate((1 - smoothstep(0.02, 0.92, rr)) * (0.5 + 0.5 * det));
          const lum = 0.5 + 0.5 * (simplex2D(u * 6.7 + 1.7, v * 6.7 - 4.2, seed ^ 0x2f) * 0.5 + 0.5);
          const o = (y * w + x) * 4;
          d[o] = lum * 255;
          d[o + 1] = ero * 255;
          d[o + 2] = th * 255;
          d[o + 3] = a * 255;
        }
      }
    });
  },

  /** One irregular granule: sand, gravel chip, crumb. Hard rim, lit face. */
  grain(seed) {
    return makeSpriteTexture(64, 64, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const v = (y / (h - 1)) * 2 - 1;
        for (let x = 0; x < w; x++) {
          const u = (x / (w - 1)) * 2 - 1;
          const r = Math.sqrt(u * u + v * v);
          const ang = Math.atan2(v, u);
          // Faceted outline from angular noise: a chip, not a ball bearing.
          const facet = 1 + 0.26 * simplex2D(Math.cos(ang) * 2.2, Math.sin(ang) * 2.2, seed);
          const rr = r * facet;
          const a = 1 - smoothstep(0.72, 0.92, rr);
          const grit = worley2D(u * 3.4 + 5.0, v * 3.4 - 2.0, seed ^ 0x77);
          // Light comes from up-left in sprite space, so the granule has a
          // shaded side and reads as a solid rather than a dot.
          const shade = saturate(0.45 - u * 0.36 - v * 0.30 + grit * 0.25);
          const o = (y * w + x) * 4;
          d[o] = (0.55 + 0.6 * shade) * 255;
          d[o + 1] = 255;
          d[o + 2] = (1 - shade) * 200;
          d[o + 3] = saturate(a) * 255;
        }
      }
    });
  },

  /** Grass clipping: a tapered blade with a fold highlight along its spine. */
  blade(seed) {
    return makeSpriteTexture(64, 64, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const t = y / (h - 1);
        // Waisted profile — wide at the base, pointed at the tip.
        const half = 0.16 * Math.sin(Math.PI * Math.pow(t, 0.75)) + 0.02;
        const bendC = (simplex2D(t * 2.6, 3.1, seed) * 0.10);
        for (let x = 0; x < w; x++) {
          const u = x / (w - 1) - 0.5 - bendC;
          const a = 1 - smoothstep(half * 0.72, half, Math.abs(u));
          const spine = 1 - smoothstep(0.0, half * 0.9, Math.abs(u));
          const o = (y * w + x) * 4;
          d[o] = (0.62 + 0.42 * spine) * 255;
          d[o + 1] = 255;
          d[o + 2] = (0.25 + 0.5 * (1 - spine)) * 255;
          d[o + 3] = saturate(a) * 255;
        }
      }
    });
  },

  /**
   * Spark streak — a comet, not a bar.
   *
   * V runs along the direction of travel, and the vertex shader puts V = 1 at
   * the leading edge. So the head sits at V = 1: fat, white-hot, with a hard
   * front. The tail thins and fades back toward V = 0. That asymmetry is the
   * entire reason a stretched billboard reads as motion.
   */
  streak() {
    return makeSpriteTexture(32, 128, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const t = y / (h - 1);
        const along = smoothstep(0.0, 0.34, t) * (1 - smoothstep(0.95, 1.0, t));
        const width = lerp(0.16, 0.55, Math.pow(t, 0.7));
        for (let x = 0; x < w; x++) {
          const u = Math.abs(x / (w - 1) - 0.5) * 2;
          const across = 1 - smoothstep(width * 0.35, width, u);
          const core = Math.pow(1 - saturate(u / Math.max(1e-3, width)), 2) * (0.35 + 0.65 * t);
          const a = saturate(along * across);
          const o = (y * w + x) * 4;
          d[o] = saturate(0.35 + core) * 255;   // white-hot head, warm tail
          d[o + 1] = 255;
          d[o + 2] = 0;
          d[o + 3] = a * 255;
        }
      }
    });
  },

  /** Water / milk droplet: teardrop body with a specular hit near the top. */
  droplet(seed) {
    return makeSpriteTexture(64, 64, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const v = (y / (h - 1)) * 2 - 1;
        for (let x = 0; x < w; x++) {
          const u = (x / (w - 1)) * 2 - 1;
          // Squash the lower half so the drop has a tail hanging behind it.
          const vv = v < 0 ? v * 0.78 : v * 1.18;
          const r = Math.sqrt(u * u + vv * vv) * (1 + 0.07 * simplex2D(u * 3, v * 3, seed));
          const a = 1 - smoothstep(0.66, 0.9, r);
          const spec = Math.pow(saturate(1 - Math.hypot(u + 0.26, v + 0.3) * 2.6), 3);
          const rim = smoothstep(0.42, 0.86, r) * 0.5;
          const o = (y * w + x) * 4;
          d[o] = saturate(0.5 + spec * 1.2 + rim) * 255;
          d[o + 1] = 255;
          d[o + 2] = saturate(0.6 - spec) * 255;
          d[o + 3] = saturate(a) * 255;
        }
      }
    });
  },

  /** Boost flame: hot core, turbulent skirt, eroded edge. */
  flame(seed) {
    return makeSpriteTexture(96, 96, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const v = (y / (h - 1)) * 2 - 1;
        for (let x = 0; x < w; x++) {
          const u = (x / (w - 1)) * 2 - 1;
          const r = Math.sqrt(u * u + v * v);
          const turb = fbm2D(u * 3.1 + 2.2, v * 3.1 - 6.4, 4, 2.3, 0.5, seed) * 0.5 + 0.5;
          const rr = r * (1 + (turb - 0.5) * 0.55);
          const a = saturate((1 - smoothstep(0.12, 0.96, rr)) * (0.55 + 0.7 * turb));
          const core = Math.pow(saturate(1 - rr * 1.5), 2.2);
          const o = (y * w + x) * 4;
          d[o] = saturate(0.35 + core * 1.6) * 255;
          d[o + 1] = saturate(turb * 0.7 + (1 - rr) * 0.5) * 255;
          d[o + 2] = 255;
          d[o + 3] = a * 255;
        }
      }
    });
  },

  /** Dust mote hanging in a light shaft: a soft disc with a faint bokeh ring. */
  mote() {
    return makeSpriteTexture(32, 32, (d, w, h) => {
      for (let y = 0; y < h; y++) {
        const v = (y / (h - 1)) * 2 - 1;
        for (let x = 0; x < w; x++) {
          const u = (x / (w - 1)) * 2 - 1;
          const r = Math.sqrt(u * u + v * v);
          // Out-of-focus points have a brighter rim than centre: that ring is
          // the whole reason a mote reads as a defocused speck, not a dot.
          const disc = 1 - smoothstep(0.55, 1.0, r);
          const ring = Math.exp(-Math.pow((r - 0.62) * 4.4, 2)) * 0.55;
          const a = saturate(disc * 0.7 + ring);
          const o = (y * w + x) * 4;
          d[o] = 255;
          d[o + 1] = 255;
          d[o + 2] = 255;
          d[o + 3] = a * 255;
        }
      }
    });
  },
};

/* ==========================================================================
 * Shaders
 * ========================================================================== */

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>

attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aTime;   // x birth, y 1/life, z seed, w ground plane Y
attribute vec4 aSize;   // x size0, y size1, z rot0, w rotRate
attribute vec4 aTint;   // rgb colour, a opacity scale
attribute vec4 aDyn;    // x drag, y gravity scale, z turbulence, w spare

uniform float uTime;
uniform float uGravity;
uniform float uSizeScale;
uniform vec3  uColorEnd;
uniform float uGrowPow;
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uTurbScale;
uniform vec2  uStretch;      // x length at birth, y length at death
uniform float uRestitution;
uniform float uTangentFriction;

varying vec2  vUv;
varying vec4  vColor;
varying float vErode;
varying float vViewZ;
varying vec3  vWorldPos;
varying vec4  vProj;

/**
 * Curl of a three-octave analytic sine potential.
 *
 * For a potential whose components are single sines of one coordinate each,
 * the curl collapses to three cosines — and being a curl it is exactly
 * divergence-free, so the field rolls the cloud instead of squeezing it.
 * Nine cosines total, no texture fetch, no finite differencing.
 */
vec3 curlField(vec3 p, float t, float seed) {
  vec3 c = vec3(0.0);
  float k = 1.0;
  float amp = 1.0;
  vec3 ph = vec3(seed * 37.1, seed * 11.7, seed * 53.3);
  for (int i = 0; i < 3; i++) {
    vec3 q = p * k + ph + vec3(t * 0.63, t * 0.47, t * 0.81);
    c += amp * vec3(cos(q.z), cos(q.x), cos(q.y));
    k *= 2.17;
    amp *= 0.52;
    ph += vec3(2.7, 5.9, 1.3);
  }
  return c * 0.62;
}

void main() {
  float age = uTime - aTime.x;
  float u = age * aTime.y;

  // Retired, unborn, or a stale slot: collapse behind the far plane so the
  // rasteriser never sees it. Cheaper than any branch downstream.
  if (u < 0.0 || u >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    vErode = 1.0;
    vViewZ = 0.0;
    vWorldPos = vec3(0.0);
    vProj = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float g = uGravity * aDyn.y;
  vec3 world;
  vec3 vel;

#ifdef MG_BOUNCE
  // Ballistic with an analytic bounce against the plane the particle was born
  // over. Three impacts is more than the eye can follow at these lifetimes.
  float gg = max(abs(g), 1.0);
  float y  = aPos.y - aTime.w;
  float vy = aVel.y;
  vec2  hp = aPos.xz;
  vec2  hv = aVel.xz;
  float t  = age;
  for (int i = 0; i < 3; i++) {
    float disc = vy * vy + 2.0 * gg * y;
    if (disc <= 0.0) break;
    float th = (vy + sqrt(disc)) / gg;
    if (th <= 1e-5 || th >= t) break;
    hp += hv * th;
    hv *= uTangentFriction;
    y = 0.0;
    vy = -(vy - gg * th) * uRestitution;
    t -= th;
  }
  hp += hv * t;
  float yEnd = y + vy * t - 0.5 * gg * t * t;
  vy = vy - gg * t;
  world = vec3(hp.x, aTime.w + max(yEnd, 0.0), hp.y);
  vel = vec3(hv.x, vy, hv.y);
#else
  // Exact solution of dv/dt = -k v + g. Clamped k, because the k -> 0 limit of
  // the closed form is a division by zero rather than a straight line.
  float k = max(aDyn.x, 0.05);
  float e = exp(-k * age);
  vec3 vTerm = vec3(0.0, g, 0.0) / k;
  world = aPos + (aVel - vTerm) * (1.0 - e) / k + vTerm * age;
  vel = (aVel - vTerm) * e + vTerm;
#endif

// Deliberately excluded from the bouncing kinds: a grain of sand that has come
// to rest on the floor must stay there, and a turbulent field would drag it
// straight back through it.
#if defined( MG_TURBULENCE ) && !defined( MG_BOUNCE )
  // Evaluated at the ballistic position and weighted by age: neighbouring
  // particles sample nearly the same field, so a plume rolls as one body
  // instead of dissolving into independent jitter. The weight grows slightly
  // faster than linearly, which is what makes a puff *unfold*.
  //
  // aDyn.z is an amplitude in u/s and the weight is in seconds, so the total
  // displacement is bounded by amplitude * lifetime. That is the number to
  // check when a kind's turbulence looks wrong: a 12-second dust mote and a
  // 1.4-second smoke puff need very different amplitudes for the same look.
  vec3 turb = curlField(world * uTurbScale, uTime, aTime.z);
  float tw = age * (0.30 + 0.70 * u);
  world += turb * (aDyn.z * 6.0 * tw);
  vel += turb * (aDyn.z * 4.0 * u);
#endif

  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);

  float size = mix(aSize.x, aSize.y, pow(u, uGrowPow)) * uSizeScale;
  vec2 corner = position.xy;

#ifdef MG_STRETCH
  // Velocity-stretched billboard: the long axis follows the screen-space
  // projection of the particle's own velocity, so a spark draws its path.
  vec3 vView = mat3(modelViewMatrix) * vel;
  vec2 dir = vView.xy;
  float dl = length(dir);
  dir = dl > 1e-4 ? dir / dl : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  float len = mix(uStretch.x, uStretch.y, u) * uSizeScale
            * (0.35 + 0.65 * clamp(dl / 60.0, 0.0, 1.0));
  mvPosition.xy += corner.y * len * dir + corner.x * size * side;
  vUv = uv;
#else
  float rot = aSize.z + aSize.w * age;
  float cs = cos(rot);
  float sn = sin(rot);
  mvPosition.xy += vec2(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs) * size;
  vUv = uv;
#endif

  gl_Position = projectionMatrix * mvPosition;

  float fadeIn = smoothstep(0.0, max(uFadeIn, 1e-4), u);
  float fadeOut = 1.0 - smoothstep(uFadeOut, 1.0, u);
  vColor = vec4(aTint.rgb * mix(vec3(1.0), uColorEnd, u), aTint.a * fadeIn * fadeOut);
  vErode = u;
  vViewZ = -mvPosition.z;
  vWorldPos = world;
  // Clip position carried through so the fragment stage can derive its own
  // screen UV. Deriving it from gl_FragCoord would need the drawing-buffer
  // size as a uniform, and the composer, the shadow pass and the headless
  // capture path all render at different sizes.
  vProj = gl_Position;

  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>

uniform sampler2D uMap;
uniform float uOpacity;

#ifdef MG_SOFT
uniform sampler2D uDepth;
uniform float uNear;
uniform float uFar;
uniform float uSoftDist;
#endif

#ifdef MG_LIT
uniform vec3  uSunDir;      // world space, pointing TOWARDS the sun
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uWrap;
uniform float uScatter;
#endif

varying vec2  vUv;
varying vec4  vColor;
varying float vErode;
varying float vViewZ;
varying vec3  vWorldPos;
varying vec4  vProj;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a * uOpacity;

#ifdef MG_ERODE
  // Dissolve rather than dim: the threshold climbs with age, so the sprite
  // breaks into wisps from its thinnest parts outward.
  a *= 1.0 - smoothstep(tex.g, tex.g + 0.30, vErode * 1.22);
#endif

  if (a < 0.0035) discard;

  vec3 base = vColor.rgb * (0.70 + 0.60 * tex.r);

#ifdef MG_LIT
  // Shade the billboard as if it were a sphere. The sprite UV gives a
  // hemispherical normal in VIEW space; multiplying the vector on the LEFT of
  // mat3(viewMatrix) is a transpose-multiply, which for a rotation is its
  // inverse — that is the view -> world rotation, obtained without needing a
  // uniform three only declares in the vertex stage.
  vec2 d = vUv * 2.0 - 1.0;
  float r2 = min(dot(d, d), 1.0);
  vec3 nView = vec3(d, sqrt(1.0 - r2));
  vec3 n = normalize(nView * mat3(viewMatrix));

  // Wrapped diffuse: light bends around a translucent puff instead of
  // terminating at its equator, which is why smoke has form and a Lambert
  // billboard looks like a sticker.
  float nl = dot(n, uSunDir);
  float wrapped = clamp((nl + uWrap) / (1.0 + uWrap), 0.0, 1.0);

  // Thick centres self-shadow; thin edges transmit.
  float thickness = tex.b;
  vec3 key = uSunColor * wrapped * mix(1.0, 0.42, thickness);
  vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);

  // Forward scattering: a puff between the camera and the sun lights up at the
  // rim. This is the term that makes backlit smoke read as volume.
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  float fwd = pow(clamp(dot(viewDir, -uSunDir), 0.0, 1.0), 5.0);
  vec3 scatter = uSunColor * fwd * uScatter * (1.0 - thickness * 0.55);

  base *= amb + key;
  base += scatter * vColor.rgb;
#endif

#ifdef MG_SOFT
  vec2 screenUv = vProj.xy / max(vProj.w, 1e-6) * 0.5 + 0.5;
  float sceneDepth = texture2D(uDepth, screenUv).x;
  // A cleared depth buffer reads 1.0, which linearises to the far plane; that
  // is exactly the "nothing behind it" answer we want, so no special case.
  float sceneZ = -perspectiveDepthToViewZ(sceneDepth, uNear, uFar);
  a *= clamp((sceneZ - vViewZ) / uSoftDist, 0.0, 1.0);
  // ...and the same trick against the near plane, so a puff the camera flies
  // through dissolves instead of filling the frame.
  a *= clamp((vViewZ - uNear) / 8.0, 0.0, 1.0);
  if (a < 0.0035) discard;
#endif

  gl_FragColor = vec4(base, a);

#ifdef MG_FOG_FADE
  // Additive kinds must not be mixed towards the fog colour — that would make
  // distant sparks brighter. Attenuate instead.
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.a *= 1.0 - fogFactor;
  #endif
#else
  #include <fog_fragment>
#endif

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ==========================================================================
 * DepthProbe — the opaque scene's depth, for soft particles
 *
 * A half-resolution render of the scene with a colour-write-disabled override
 * material: no shading work at all, just the depth attachment. Only the
 * geometry cost remains, and it is skipped outright on any frame where no
 * depth-consuming particle is alive.
 *
 * The pass runs in lateUpdate(), which is one system before game/Director.js
 * finalises the camera, so the depth is a frame behind under camera motion.
 * For a fade that spans several world units that is invisible; a re-render is
 * forced from onResize() so the headless capture path — which calls
 * onResize() and then renderFrame() twice with no update() in between — always
 * composites against depth taken at the capture resolution.
 * ========================================================================== */

class DepthProbe {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = 0.5;
    this.width = 2;
    this.height = 2;
    this.target = null;
    this.texture = null;
    this.enabled = true;
    this.hidden = [];

    this.override = new THREE.MeshBasicMaterial({
      colorWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      name: 'fx:depthOnly',
    });
    this._build(2, 2);
  }

  _build(w, h) {
    this.target?.dispose();
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      depthTexture: depth,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.texture = depth;
    this.width = w;
    this.height = h;
  }

  /** Match the drawing buffer. Returns true when the size actually changed. */
  sync() {
    const r = this.renderer;
    if (!r) return false;
    r.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(_size.x * this.scale));
    const h = Math.max(2, Math.round(_size.y * this.scale));
    if (w === this.width && h === this.height) return false;
    this.target.setSize(w, h);
    this.width = w;
    this.height = h;
    return true;
  }

  /**
   * Render opaque scene depth. `exclude` is a short list of roots that must not
   * occlude the particles they belong to — the fx groups and the ground decal
   * layer, which is coplanar with the road and would otherwise self-occlude.
   */
  render(scene, camera, exclude) {
    const r = this.renderer;
    if (!r || !scene || !camera) return;

    const prevTarget = r.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = r.shadowMap.autoUpdate;
    const prevShadowNeeds = r.shadowMap.needsUpdate;
    const hidden = this.hidden;
    hidden.length = 0;

    try {
      for (let i = 0; i < exclude.length; i++) {
        const o = exclude[i];
        if (o && o.visible) { o.visible = false; hidden.push(o); }
      }
      // A second renderer.render() would otherwise re-rasterise every shadow
      // cascade for a pass that cannot see shadows at all.
      r.shadowMap.autoUpdate = false;
      r.shadowMap.needsUpdate = false;
      scene.overrideMaterial = this.override;
      r.setRenderTarget(this.target);
      r.clear(true, true, false);
      r.render(scene, camera);
    } catch (err) {
      this.enabled = false;
      console.warn('[Particles] depth prepass failed; soft particles disabled', err);
    } finally {
      scene.overrideMaterial = prevOverride;
      r.shadowMap.autoUpdate = prevShadowAuto;
      r.shadowMap.needsUpdate = prevShadowNeeds;
      r.setRenderTarget(prevTarget);
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
    }
  }

  dispose() {
    this.target?.dispose();
    this.override?.dispose();
    this.target = null;
    this.texture = null;
  }
}

/* ==========================================================================
 * Emitter — one kind, one pool, one draw call
 * ========================================================================== */

const FLOATS = { pos: 3, vel: 3, time: 4, size: 4, tint: 4, dyn: 4 };

class Emitter {
  constructor(kind, def, capacity, texture, opts) {
    this.kind = kind;
    this.def = def;
    this.capacity = Math.max(0, capacity | 0);
    this.count = 0;          // live particles, always packed into [0, count)
    this.cursor = 0;         // recycle pointer, used only when the pool is full
    this.spawned = 0;
    this.dropped = 0;
    this._lo = Infinity;
    this._hi = -Infinity;

    this.texture = texture;
    this.mesh = null;
    this.geometry = null;
    this.material = null;
    this.attrs = null;
    this.arrays = null;

    if (this.capacity > 0) this._build(opts);
  }

  _build(opts) {
    const n = this.capacity;
    const def = this.def;

    const geo = new THREE.InstancedBufferGeometry();
    // Unit quad, corners at +-0.5, so the vertex shader can scale it directly.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    const arrays = {};
    const attrs = {};
    const names = { aPos: 'pos', aVel: 'vel', aTime: 'time', aSize: 'size', aTint: 'tint', aDyn: 'dyn' };
    for (const attrName in names) {
      const key = names[attrName];
      const itemSize = FLOATS[key];
      const arr = new Float32Array(n * itemSize);
      const attr = new THREE.InstancedBufferAttribute(arr, itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(attrName, attr);
      arrays[key] = arr;
      attrs[key] = attr;
    }
    geo.instanceCount = 0;
    // Particles move entirely on the GPU, so any bounding volume computed from
    // the spawn positions would be wrong within a frame. Cull manually.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const defines = {};
    if (def.turbulence > 0) defines.MG_TURBULENCE = '';
    if (def.stretch) defines.MG_STRETCH = '';
    if (def.bounce) defines.MG_BOUNCE = '';
    if (def.erode) defines.MG_ERODE = '';
    if (def.lit && opts.lit) defines.MG_LIT = '';
    if (def.soft && opts.soft) defines.MG_SOFT = '';
    if (def.fog === 'fade') defines.MG_FOG_FADE = '';

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uMap: { value: null },
        uTime: { value: 0 },
        uGravity: { value: 260 },
        uSizeScale: { value: 1 },
        uOpacity: { value: def.opacity ?? 1 },
        uColorEnd: { value: new THREE.Color(1, 1, 1) },
        uGrowPow: { value: def.growPow ?? 1 },
        uFadeIn: { value: def.fadeIn ?? 0.1 },
        uFadeOut: { value: def.fadeOut ?? 0.5 },
        uTurbScale: { value: def.turbScale ?? 0.06 },
        uStretch: { value: new THREE.Vector2(1, 1) },
        uRestitution: { value: def.restitution ?? 0.35 },
        uTangentFriction: { value: def.tangentFriction ?? 0.7 },
        uDepth: { value: null },
        uNear: { value: 2 },
        uFar: { value: 4000 },
        uSoftDist: { value: def.softDist ?? 6 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.35) },
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        uSkyColor: { value: new THREE.Color(0.32, 0.38, 0.48) },
        uGroundColor: { value: new THREE.Color(0.18, 0.15, 0.12) },
        uWrap: { value: def.wrap ?? 0.5 },
        uScatter: { value: def.scatter ?? 0.6 },
      },
    ]);
    uniforms.uMap.value = this.texture;
    // UniformsUtils.merge clones values, so the colours have to be re-seated
    // after the merge rather than trusted from the literal above.
    _col.setHex(def.colorEnd ?? 0xffffff);
    _col2.setHex(def.color ?? 0xffffff);
    // colorEnd is applied as a MULTIPLIER on the spawn tint, so store the ratio
    // and not the absolute colour: that keeps per-emit colour overrides working.
    uniforms.uColorEnd.value.setRGB(
      _col.r / Math.max(1e-4, _col2.r),
      _col.g / Math.max(1e-4, _col2.g),
      _col.b / Math.max(1e-4, _col2.b)
    );
    if (def.stretch) {
      uniforms.uStretch.value.set(def.stretchLength[0], def.stretchLength[1]);
    }

    const mat = new THREE.ShaderMaterial({
      name: `fx:${this.kind}`,
      uniforms,
      defines,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: def.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    // Two kinds share a source but never a program: the defines differ, and
    // three's default cache key does not include them for ShaderMaterial.
    const sig = Object.keys(defines).sort().join(',');
    mat.customProgramCacheKey = () => `mg:fx:${this.kind}:${sig}`;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `fx:${this.kind}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = def.renderOrder ?? 12;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;

    this.geometry = geo;
    this.material = mat;
    this.mesh = mesh;
    this.arrays = arrays;
    this.attrs = attrs;
  }

  /**
   * Claim a slot. Returns its index, or -1 when this kind is disabled.
   * A full pool recycles round-robin: the alternative is dropping the newest
   * particle, and a burst that silently does nothing is worse than one that
   * overwrites an older puff.
   */
  _claim() {
    if (this.capacity <= 0) return -1;
    let i;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      this.dropped++;
    }
    if (i < this._lo) this._lo = i;
    if (i > this._hi) this._hi = i;
    this.spawned++;
    return i;
  }

  /** Retire everything past its lifetime, keeping the live set packed. */
  retire(now) {
    const time = this.arrays.time;
    let n = this.count;
    for (let i = 0; i < n;) {
      const age = now - time[i * 4];
      if (age * time[i * 4 + 1] < 1) { i++; continue; }
      n--;
      if (i !== n) {
        this._move(n, i);
        if (i < this._lo) this._lo = i;
        if (i > this._hi) this._hi = i;
      }
    }
    this.count = n;
    if (this.cursor >= n) this.cursor = 0;
  }

  _move(from, to) {
    const a = this.arrays;
    for (const key in FLOATS) {
      const w = FLOATS[key];
      const arr = a[key];
      const s = from * w;
      const d = to * w;
      for (let k = 0; k < w; k++) arr[d + k] = arr[s + k];
    }
  }

  /** Push the touched slots to the GPU. Whole-buffer above ~60% coverage. */
  flush() {
    this.geometry.instanceCount = this.count;
    if (this.mesh) this.mesh.visible = this.count > 0;
    if (this._hi < this._lo) return;
    const lo = Math.max(0, this._lo);
    const hi = Math.min(this.capacity - 1, this._hi);
    this._lo = Infinity;
    this._hi = -Infinity;
    const span = hi - lo + 1;
    const whole = span > this.capacity * 0.6;
    for (const key in FLOATS) {
      const attr = this.attrs[key];
      const w = FLOATS[key];
      if (!whole && typeof attr.addUpdateRange === 'function') {
        attr.clearUpdateRanges?.();
        attr.addUpdateRange(lo * w, span * w);
      } else if (typeof attr.clearUpdateRanges === 'function') {
        attr.clearUpdateRanges();
      }
      attr.needsUpdate = true;
    }
  }

  clear() {
    this.count = 0;
    this.cursor = 0;
    this.geometry.instanceCount = 0;
    if (this.mesh) this.mesh.visible = false;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.mesh = null;
  }
}

/* ==========================================================================
 * Particles
 * ========================================================================== */

export class Particles {
  name = 'particles';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.enabled = true;
    this.clock = 0;
    this._steppedThisFrame = false;

    this.group = new THREE.Group();
    this.group.name = 'fx:particles';
    this.group.matrixAutoUpdate = false;

    this.emitters = new Map();
    this.textures = new Map();
    this.probe = null;
    this._excludeFromDepth = [];

    this.rng = makeRng((ctx.seed ?? 20260730) ^ 0x9a10c5);

    const s = ctx.settings?.particles ?? {};
    this.softParticles = s.softParticles !== false;
    this.lit = s.lit !== false;
    this.sizeScale = Number.isFinite(s.sizeScale) ? s.sizeScale : 1;
    this.budget = Number.isFinite(s.budget) ? s.budget : 6000;
    this.kindBudget = { ...DEFAULT_CAPACITY, ...(s.kinds || {}) };
    if (s.enabled === false) this.enabled = false;
    /** Live soft particles below which the depth prepass is not worth running. */
    this.depthThreshold = 6;

    /* --- emission state, keyed by vehicle -------------------------------- */
    this._carFx = new Map();
    this._moteTarget = 0;
    this._moteTimer = 0;
    this._offBus = [];

    /* --- tunables a reviewer might want to pull on ----------------------- */
    this.tuning = {
      smokeRate: 46,        // particles/s at full slip on a hard surface
      looseRate: 30,        // particles/s at full slip on sand, grass, gravel
      rollRate: 9,          // particles/s from merely rolling over loose ground
      splashRate: 44,
      sparkRate: 26,
      exhaustRate: 13,
      boostRate: 95,
      slipFloor: 8,         // u/s of scrub below which nothing is thrown
      moteDensity: 1,
      moteFill: 0.40,       // fraction of the mote pool a density of 1 fills
      moteRadius: 150,
      moteHeight: 56,
    };

    this._ready = false;
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const ctx = this.ctx;
    const seed = ctx.seed ?? ctx.track?.seed ?? 1337;

    // One sprite per family, shared by every kind that uses it. Yielding
    // between bakes keeps the boot screen animating on a slow CPU.
    const families = ['smoke', 'grain', 'blade', 'streak', 'droplet', 'flame', 'mote'];
    for (let i = 0; i < families.length; i++) {
      const f = families[i];
      try {
        this.textures.set(f, SPRITES[f]((seed ^ (i * 0x9e37)) >>> 0));
      } catch (err) {
        console.warn(`[Particles] sprite "${f}" failed to bake`, err);
      }
      await new Promise((res) => setTimeout(res, 0));
    }

    this._buildEmitters();

    if (ctx.renderer && this.softParticles) {
      try {
        this.probe = new DepthProbe(ctx.renderer);
        this.probe.sync();
      } catch (err) {
        console.warn('[Particles] depth probe unavailable; soft particles off', err);
        this.probe = null;
        this.softParticles = false;
      }
    }

    ctx.scene?.add?.(this.group);
    this.group.updateMatrixWorld(true);

    const bus = ctx.bus;
    if (bus?.on) {
      this._offBus.push(bus.on('vehicle:land', (p) => this._onLand(p)));
      this._offBus.push(bus.on('vehicle:shift', (p) => this._onShift(p)));
      this._offBus.push(bus.on('vehicle:respawn', (p) => this._onRespawn(p)));
      this._offBus.push(bus.on('race:reset', () => this.clear()));
      this._offBus.push(bus.on('race:restart', () => this.clear()));
    }

    this._syncAmbient();

    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.particles = this;
    }
    this._ready = true;
    return this;
  }

  _buildEmitters() {
    for (const kind of PARTICLE_KINDS) {
      const def = KIND_DEFS[kind];
      const cap = this._capacityFor(kind);
      const tex = this.textures.get(def.sprite) || null;
      if (!tex) continue;
      let em = null;
      try {
        em = new Emitter(kind, def, cap, tex, { lit: this.lit, soft: this.softParticles });
      } catch (err) {
        console.warn(`[Particles] emitter "${kind}" failed to build`, err);
        continue;
      }
      if (em.mesh) this.group.add(em.mesh);
      this.emitters.set(kind, em);
    }
    this._excludeFromDepth = [this.group];
  }

  /** Per-kind pool size, scaled so the sum honours the tier's total budget. */
  _capacityFor(kind) {
    const want = this.kindBudget[kind] ?? DEFAULT_CAPACITY[kind] ?? 200;
    let total = 0;
    for (const k of PARTICLE_KINDS) total += this.kindBudget[k] ?? DEFAULT_CAPACITY[k] ?? 0;
    if (total <= 0) return 0;
    const scale = Math.min(1, this.budget / total);
    return Math.max(0, Math.round(want * scale));
  }

  /* ------------------------------------------------------------- contract */

  /**
   * Spawn particles.
   *
   * @param {string} kind one of PARTICLE_KINDS
   * @param {object} o
   * @param {THREE.Vector3|{x,y,z}} o.position  spawn point (required)
   * @param {THREE.Vector3|{x,y,z}} [o.velocity] initial velocity, u/s
   * @param {THREE.Vector3|{x,y,z}} [o.direction] unit-ish bias, used with speed
   * @param {number} [o.speed]     magnitude applied along direction
   * @param {number} [o.count=1]
   * @param {number} [o.spread=0]  u/s of random velocity added per axis
   * @param {number|THREE.Color} [o.color]
   * @param {number} [o.scale=1]   multiplier on the kind's authored size
   * @param {number} [o.life=1]    multiplier on the kind's authored lifetime
   * @param {number} [o.opacity=1]
   * @param {number} [o.groundY]   plane the bouncing kinds rebound from
   * @param {number} [o.jitter=0]  u of random positional offset
   * @returns {number} how many were actually spawned
   */
  emit(kind, o) {
    if (!this.enabled || !o || !o.position) return 0;
    const em = this.emitters.get(kind);
    if (!em || em.capacity <= 0) return 0;
    const def = em.def;

    const n = Math.max(1, Math.min(o.count | 0 || 1, em.capacity));
    const rng = this.rng;
    const px = o.position.x;
    const py = o.position.y;
    const pz = o.position.z;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return 0;

    const vx0 = o.velocity?.x ?? 0;
    const vy0 = o.velocity?.y ?? 0;
    const vz0 = o.velocity?.z ?? 0;
    const dir = o.direction;
    const speed = o.speed ?? 0;
    const spread = o.spread ?? 0;
    const jitter = o.jitter ?? 0;
    const scale = o.scale ?? 1;
    const lifeMul = o.life ?? 1;
    const opacity = o.opacity ?? 1;
    const groundY = Number.isFinite(o.groundY) ? o.groundY : py;

    if (o.color === undefined || o.color === null) _col.setHex(def.color);
    else if (typeof o.color === 'number') _col.setHex(o.color);
    else _col.set(o.color);

    const A = em.arrays;
    let made = 0;
    for (let i = 0; i < n; i++) {
      const idx = em._claim();
      if (idx < 0) break;
      const p3 = idx * 3;
      const p4 = idx * 4;

      A.pos[p3] = px + (jitter ? (rng.next() * 2 - 1) * jitter : 0);
      A.pos[p3 + 1] = py + (jitter ? (rng.next() * 2 - 1) * jitter * 0.5 : 0);
      A.pos[p3 + 2] = pz + (jitter ? (rng.next() * 2 - 1) * jitter : 0);

      let vx = vx0;
      let vy = vy0;
      let vz = vz0;
      if (dir && speed) {
        vx += dir.x * speed;
        vy += dir.y * speed;
        vz += dir.z * speed;
      }
      if (spread) {
        vx += (rng.next() * 2 - 1) * spread;
        vy += (rng.next() * 2 - 1) * spread;
        vz += (rng.next() * 2 - 1) * spread;
      }
      A.vel[p3] = vx;
      A.vel[p3 + 1] = vy;
      A.vel[p3 + 2] = vz;

      const life = Math.max(0.02, lerp(def.life[0], def.life[1], rng.next()) * lifeMul);
      A.time[p4] = this.clock;
      A.time[p4 + 1] = 1 / life;
      A.time[p4 + 2] = rng.next();
      A.time[p4 + 3] = groundY;

      const sv = 0.78 + rng.next() * 0.52;
      A.size[p4] = def.size[0] * scale * sv;
      A.size[p4 + 1] = def.size[1] * scale * sv;
      A.size[p4 + 2] = rng.next() * Math.PI * 2;
      A.size[p4 + 3] = (rng.next() * 2 - 1) * (def.spin ?? 0);

      // A little per-particle value variation: a cloud of identically-toned
      // puffs reads as a decal, a cloud with 15% spread reads as material.
      const tv = 0.86 + rng.next() * 0.28;
      A.tint[p4] = _col.r * tv;
      A.tint[p4 + 1] = _col.g * tv;
      A.tint[p4 + 2] = _col.b * tv;
      A.tint[p4 + 3] = opacity * (0.82 + rng.next() * 0.36);

      A.dyn[p4] = def.drag * (0.8 + rng.next() * 0.4);
      A.dyn[p4 + 1] = def.gravity;
      A.dyn[p4 + 2] = def.turbulence * (0.6 + rng.next() * 0.8);
      A.dyn[p4 + 3] = 0;
      made++;
    }
    return made;
  }

  /** Contract alias. */
  spawn(kind, o) { return this.emit(kind, o); }

  /* --------------------------------------------------------------- config */

  setBudget(total, kinds) {
    if (Number.isFinite(total) && total > 0) this.budget = total;
    if (kinds && typeof kinds === 'object') this.kindBudget = { ...this.kindBudget, ...kinds };
    this._rebuild();
    return this;
  }

  applySettings(settings) {
    const s = (settings || this.ctx?.settings)?.particles;
    if (!s) return this;
    const wasSoft = this.softParticles;
    const wasLit = this.lit;
    this.enabled = s.enabled !== false;
    this.sizeScale = Number.isFinite(s.sizeScale) ? s.sizeScale : this.sizeScale;
    this.softParticles = s.softParticles !== false;
    this.lit = s.lit !== false;
    if (Number.isFinite(s.budget)) this.budget = s.budget;
    if (s.kinds) this.kindBudget = { ...this.kindBudget, ...s.kinds };
    this.group.visible = this.enabled;

    if (this.softParticles && !this.probe && this.ctx?.renderer) {
      try { this.probe = new DepthProbe(this.ctx.renderer); this.probe.sync(); } catch (_) { this.softParticles = false; }
    }
    // Soft particles and lighting are #defines, and the budget changes the
    // buffer sizes, so a settings change is always a full rebuild. It only ever
    // happens on a quality switch, never in a frame that is also rendering.
    void wasSoft; void wasLit;
    this._rebuild();
    return this;
  }

  setQuality() {
    return this.applySettings(this.ctx?.settings);
  }

  _rebuild() {
    for (const em of this.emitters.values()) {
      this.group.remove(em.mesh);
      em.dispose();
    }
    this.emitters.clear();
    this._buildEmitters();
  }

  clear() {
    for (const em of this.emitters.values()) em.clear();
    return this;
  }

  /* ------------------------------------------------------------ simulation */

  /**
   * Emission runs on the fixed tick, not the render frame.
   *
   * Two reasons, both load-bearing: the slip signal it reads is written at
   * 120 Hz by the tyre model, and `?t=12` fast-forwards by calling stepFixed()
   * with no rendering at all — so a review capture arrives with smoke already
   * hanging in the air and skid marks already down.
   */
  fixedUpdate(fdt, ctx) {
    if (!this.enabled || !this._ready) return;
    this.ctx = ctx || this.ctx;
    this.clock += fdt;
    this._steppedThisFrame = true;

    const vehicles = this.ctx?.vehicles;
    if (vehicles && vehicles.length) {
      for (let i = 0; i < vehicles.length; i++) this._emitForVehicle(vehicles[i], fdt);
    }
    this._emitMotes(fdt);

    for (const em of this.emitters.values()) em.retire(this.clock);
  }

  update(dt, ctx) {
    if (!this._ready) return;
    this.ctx = ctx || this.ctx;
    if (!this._steppedThisFrame) {
      // The engine renders frames with no fixed step during capture and while
      // paused; keep the clock honest so nothing freezes mid-flight.
      this.clock += Math.min(dt, 0.05);
      for (const em of this.emitters.values()) em.retire(this.clock);
    }
    this._steppedThisFrame = false;

    this._syncUniforms();
    for (const em of this.emitters.values()) em.flush();
  }

  /**
   * Depth prepass. Runs as late as the registration order allows — one system
   * before the camera director, hence one frame of camera lag on the fade,
   * which spans several world units and is not resolvable at any sane pan rate.
   */
  lateUpdate(dt, ctx) {
    if (!this._ready || !this.enabled) return;
    const probe = this.probe;
    if (!probe || !probe.enabled || !this.softParticles) return;
    if (!this._needsDepth()) return;
    const c = ctx || this.ctx;
    probe.sync();
    this._collectDepthExclusions(c);
    probe.render(c.scene, c.camera, this._excludeFromDepth);
  }

  /**
   * True when enough soft-particle work is on screen to pay for a second
   * geometry pass. The prepass is the single most expensive thing this module
   * does, and a race spends most of its time with nothing sliding — so a few
   * stray grains of sand are not worth re-rendering the circuit for.
   */
  _needsDepth() {
    let live = 0;
    for (const em of this.emitters.values()) {
      if (em.def.soft) live += em.count;
      if (live >= this.depthThreshold) return true;
    }
    return false;
  }

  /**
   * Roots the depth prepass must not see.
   *
   * Three categories, all for the same reason — nothing that is itself a
   * transparent volume may act as an occluder for the volumes behind it:
   *   - our own particles, and the ribbons and overlay from the sibling fx
   *     modules;
   *   - ground decals, which are coplanar with the road and would make every
   *     skid mark an occluder for the smoke sitting on top of it;
   *   - render/Sky.js's own dust motes and light shafts. The motes are a
   *     THREE.Points cloud, and a Points object drawn through a mesh
   *     overrideMaterial has no gl_PointSize at all.
   */
  _collectDepthExclusions(ctx) {
    const list = this._excludeFromDepth;
    list.length = 0;
    list.push(this.group);
    const trails = ctx?.fx?.trails?.group;
    if (trails) list.push(trails);
    const impacts = ctx?.fx?.impacts?.group;
    if (impacts) list.push(impacts);
    const decals = ctx?.decals?.group;
    if (decals) list.push(decals);
    const skyDust = ctx?.sky?.dust?.points;
    if (skyDust) list.push(skyDust);
    const shafts = ctx?.sky?.shafts?.group;
    if (shafts) list.push(shafts);
  }

  onResize(w, h) {
    if (!this.probe || !this.softParticles) return;
    // The headless capture path resizes, then renders twice with no update()
    // in between. Refresh here or the review frame composites its particles
    // against depth taken at the previous resolution.
    this.probe.sync();
    this._syncUniforms();
    if (this._needsDepth()) {
      this._collectDepthExclusions(this.ctx);
      this.probe.render(this.ctx?.scene, this.ctx?.camera, this._excludeFromDepth);
    }
  }

  /* --------------------------------------------------------------- uniforms */

  _syncUniforms() {
    const ctx = this.ctx;
    const cam = ctx?.camera;
    const lighting = ctx?.lighting;
    const gravity = ctx?.settings?.physics?.gravity ?? 260;

    // Key light. sunDir points from the scene towards the sun, which is the
    // convention Lighting.js publishes and the one the wrapped diffuse wants.
    if (lighting?.sunDir) _v0.copy(lighting.sunDir).normalize();
    else _v0.set(0.42, 0.78, 0.46).normalize();
    const sunI = lighting?.sun?.intensity ?? 2.4;
    if (lighting?.sun?.color) _col.copy(lighting.sun.color).multiplyScalar(clamp(sunI * 0.32, 0.15, 1.5));
    else _col.setRGB(1, 0.95, 0.88);

    const fillI = lighting?.fill?.intensity ?? 0.8;
    if (lighting?.fill?.color) _col2.copy(lighting.fill.color).multiplyScalar(clamp(fillI * 0.42, 0.06, 1.1));
    else _col2.setRGB(0.34, 0.40, 0.52);
    if (lighting?.fill?.groundColor) _v1.set(lighting.fill.groundColor.r, lighting.fill.groundColor.g, lighting.fill.groundColor.b);
    else _v1.set(0.20, 0.16, 0.12);
    _v1.multiplyScalar(clamp(fillI * 0.34, 0.04, 0.9));
    const ambI = lighting?.ambient?.intensity ?? 0.15;
    if (lighting?.ambient?.color) {
      _v2.set(lighting.ambient.color.r, lighting.ambient.color.g, lighting.ambient.color.b).multiplyScalar(ambI);
    } else {
      _v2.set(0.05, 0.06, 0.09);
    }

    const depthTex = this.probe?.texture ?? null;

    for (const em of this.emitters.values()) {
      const u = em.material?.uniforms;
      if (!u) continue;
      u.uTime.value = this.clock;
      u.uGravity.value = gravity;
      u.uSizeScale.value = this.sizeScale;
      if (u.uSunDir) {
        u.uSunDir.value.copy(_v0);
        u.uSunColor.value.copy(_col);
        u.uSkyColor.value.setRGB(_col2.r + _v2.x, _col2.g + _v2.y, _col2.b + _v2.z);
        u.uGroundColor.value.setRGB(_v1.x + _v2.x, _v1.y + _v2.y, _v1.z + _v2.z);
      }
      if (u.uDepth) {
        u.uDepth.value = depthTex;
        if (cam) {
          u.uNear.value = cam.near ?? 2;
          u.uFar.value = cam.far ?? 4000;
        }
      }
    }
  }

  /* ------------------------------------------------------ vehicle emission */

  _fxState(car) {
    let s = this._carFx.get(car);
    if (!s) {
      s = {
        wheels: [
          { acc: 0, accB: 0 }, { acc: 0, accB: 0 },
          { acc: 0, accB: 0 }, { acc: 0, accB: 0 },
        ],
        exhaust: 0,
        boost: 0,
      };
      this._carFx.set(car, s);
    }
    return s;
  }

  /**
   * Everything a car throws off, driven by the real contact state.
   *
   * The kind is chosen by the surface under each individual wheel — not by the
   * car's averaged surface — so a car straddling the edge of the sandbox
   * genuinely throws sand from two wheels and smoke from the other two.
   */
  _emitForVehicle(car, fdt) {
    if (!car || !Array.isArray(car.wheels) || car.wheels.length < 4) return;
    const st = this._fxState(car);
    const T = this.tuning;
    const speed = car.speed || 0;
    const tires = car.tires;
    const smokeStart = tires?.smokeStart ?? 13;
    const loadRef = tires?.loadRef ?? 65;

    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const ws = st.wheels[i];
      if (!w || !w.grounded) { ws.acc = 0; ws.accB = 0; continue; }

      const rec = surfaceRecord(w.surface);
      const hardness = rec.hardness ?? 1;
      const scrub = w.slipSpeed || 0;
      const loadK = clamp((w.load || loadRef) / Math.max(1e-3, loadRef), 0.2, 2.0);
      const rate = surfaceParticleRate(w.surface);

      const cx = w.contactX;
      const cy = w.contactY;
      const cz = w.contactZ;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

      // Material leaves the contact patch backwards along the car's travel and
      // is flung up and outwards by the tread. Rear-biased, because that is
      // where the driven wheels are and where the eye expects it.
      const vel = car.velocity;
      _v3.set(vel?.x ?? 0, 0, vel?.z ?? 0);
      const vLen = _v3.length();
      if (vLen > 1e-3) _v3.multiplyScalar(1 / vLen);
      else _v3.set(0, 0, 1);

      /* --- rubber smoke: hard surfaces only ------------------------------ */
      if (hardness > 0.55) {
        const smoke = (w.smoke || 0) * hardness;
        if (smoke > 0.035 && scrub > T.slipFloor) {
          ws.acc += T.smokeRate * smoke * (0.45 + 0.55 * saturate(scrub / 60)) * loadK * fdt;
          const n = Math.floor(ws.acc);
          if (n > 0) {
            ws.acc -= n;
            // Smoke is burnt rubber hanging in the air: it inherits only a
            // fraction of the car's momentum, then stops and billows.
            _v4.copy(_v3).multiplyScalar(-speed * 0.17);
            _v4.y = 5 + smoke * 9;
            this.emit('tyreSmoke', {
              position: _tmpPos(cx, cy + 0.55, cz),
              velocity: _v4,
              count: n,
              spread: 5.5 + smoke * 7,
              jitter: 0.8,
              scale: 0.72 + smoke * 0.62,
              life: 0.8 + smoke * 0.55,
              opacity: 0.55 + smoke * 0.65,
              groundY: cy,
            });
          }
        }
      }

      /* --- the surface's own material ------------------------------------ */
      const kind = rec.particle && this.emitters.has(rec.particle) ? rec.particle : 'dust';
      const looseness = 1 - hardness;
      // Loose ground throws material from rolling alone; a hard floor only
      // does it when the tyre is actually scrubbing.
      const slipDrive = saturate((scrub - T.slipFloor) / Math.max(1, smokeStart * 3));
      const rollDrive = looseness * saturate(speed / 70);
      const wetness = rec.category === 'liquid' || kind === 'waterSplash' || kind === 'milkSplash';
      let intensity = wetness
        ? saturate(speed / 55) * 0.9 + slipDrive * 0.5
        : slipDrive * (0.35 + 0.85 * looseness) + rollDrive * 0.85;
      if (kind === 'sparks') intensity = saturate((scrub - 22) / 45) * hardness;
      intensity *= loadK;

      if (intensity > 0.02) {
        const base = wetness ? T.splashRate : kind === 'sparks' ? T.sparkRate
          : looseness > 0.35 ? T.looseRate : T.rollRate;
        ws.accB += base * rate * intensity * fdt;
        const n = Math.floor(ws.accB);
        if (n > 0) {
          ws.accB -= n;
          const throwSpeed = kind === 'sparks'
            ? 22 + scrub * 0.8
            : (14 + speed * 0.34 + scrub * 0.42) * (wetness ? 0.75 : 1);
          _v4.copy(_v3).multiplyScalar(-throwSpeed);
          _v4.y = throwSpeed * (wetness ? 0.55 : 0.42);
          this.emit(kind, {
            position: _tmpPos(cx, cy + 0.3, cz),
            velocity: _v4,
            count: n,
            spread: throwSpeed * 0.42,
            jitter: 0.9,
            color: kind === 'sparks' ? undefined : surfaceParticleColor(w.surface),
            scale: 0.75 + intensity * 0.6,
            life: 0.85 + intensity * 0.4,
            opacity: saturate(0.5 + intensity),
            groundY: cy,
          });
        }
      }
    }

    /* --- exhaust and boost, from the tail of the car --------------------- */
    this._emitTailpipe(car, st, fdt);
  }

  _emitTailpipe(car, st, fdt) {
    const T = this.tuning;
    const len = car.spec?.bodyLength ?? 9;
    const hgt = car.spec?.bodyHeight ?? 2.8;
    _v0.set(0, hgt * 0.30, -len * 0.5 - 0.5);
    if (car.quaternion) _v0.applyQuaternion(car.quaternion);
    if (car.position) _v0.add(car.position);

    _v1.set(0, 0, -1);
    if (car.quaternion) _v1.applyQuaternion(car.quaternion);

    const throttle = saturate(car.throttle ?? 0);
    const load = saturate(car.engineLoad ?? throttle);
    const rpmFrac = saturate((car.rpm ?? 0) / Math.max(1, car.tuning?.redlineRpm ?? 8000));
    // Overrun: closed throttle at high revs is when a real engine spits.
    const overrun = saturate((rpmFrac - 0.55) * 2) * (1 - throttle);
    const drive = load * (0.35 + 0.65 * rpmFrac) + overrun * 0.6;

    if (drive > 0.05) {
      st.exhaust += T.exhaustRate * drive * fdt;
      const n = Math.floor(st.exhaust);
      if (n > 0) {
        st.exhaust -= n;
        _v2.copy(_v1).multiplyScalar(16 + drive * 26);
        if (car.velocity) _v2.addScaledVector(car.velocity, 0.55);
        _v2.y += 3;
        this.emit('exhaust', {
          position: _v0,
          velocity: _v2,
          count: n,
          spread: 3.5,
          jitter: 0.35,
          scale: 0.7 + drive * 0.6 + overrun * 0.5,
          opacity: 0.55 + overrun * 0.9,
          groundY: _v0.y,
        });
      }
    }

    const boost = saturate(car.boostAmount ?? (car.boosting ? 1 : 0));
    if (boost > 0.04) {
      st.boost += T.boostRate * boost * fdt;
      const n = Math.floor(st.boost);
      if (n > 0) {
        st.boost -= n;
        _v2.copy(_v1).multiplyScalar(34 + boost * 40);
        if (car.velocity) _v2.addScaledVector(car.velocity, 0.85);
        this.emit('boostFlame', {
          position: _v0,
          velocity: _v2,
          count: n,
          spread: 5,
          jitter: 0.3,
          scale: 0.65 + boost * 0.7,
          opacity: boost,
          groundY: _v0.y,
        });
      }
    }
  }

  /* ------------------------------------------------------------ dust motes */

  /**
   * Read the track's authored dust density once the track exists.
   *
   * render/Sky.js ships its own ambient mote field — a tier-scaled Points cloud
   * that follows the camera through a 300 x 92 x 300 box (Sky._buildDust). Two
   * mote systems in one frame is twice the density and reads as falling snow,
   * so when Sky's layer is live this one keeps its pool and its API but sits at
   * a population of zero. `emit('dustMote', ...)` still works for anything that
   * wants a local puff of hanging dust, and if Sky's layer is off — low tier,
   * or Sky failed to build — this takes over the ambient job.
   */
  _syncAmbient() {
    const amb = this.ctx?.track?.def?.ambient ?? this.ctx?.track?.ambient;
    const density = Number.isFinite(amb?.dustDensity) ? amb.dustDensity : 1;
    const worldScale = this.ctx?.settings?.world?.dustMotes ?? 1;
    const skyOwnsMotes = !!this.ctx?.sky?.dust?.points;
    this.tuning.moteDensity = skyOwnsMotes ? 0 : clamp(density * worldScale, 0, 1.5);
    const em = this.emitters.get('dustMote');
    this._moteTarget = em
      ? Math.min(em.capacity, Math.round(em.capacity * this.tuning.moteFill * this.tuning.moteDensity))
      : 0;
  }

  /**
   * Motes hang in the light shafts around the action rather than filling the
   * playfield: a fixed population is respawned inside a box that follows the
   * camera subject, so the density on screen is constant wherever the race is.
   */
  _emitMotes(fdt) {
    const em = this.emitters.get('dustMote');
    if (!em || em.capacity <= 0) return;
    if (this._moteTarget <= 0) {
      this._moteTimer += fdt;
      if (this._moteTimer > 1) { this._moteTimer = 0; this._syncAmbient(); }
      return;
    }

    const focus = this.ctx?.player?.position ?? this.ctx?.vehicles?.[0]?.position ?? this.ctx?.camera?.position;
    if (!focus) return;

    const deficit = this._moteTarget - em.count;
    if (deficit <= 0) return;
    // Top up gradually so a race start does not pop a full field into being.
    const n = Math.max(1, Math.min(deficit, Math.ceil(this._moteTarget * 0.6 * fdt) + 1));
    const R = this.tuning.moteRadius;
    const H = this.tuning.moteHeight;
    const rng = this.rng;
    const groundY = this.ctx?.track?.groundY ?? 0;

    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = R * Math.sqrt(rng.next());
      _v0.set(focus.x + Math.cos(a) * r, groundY + 2 + rng.next() * H, focus.z + Math.sin(a) * r);
      _v1.set((rng.next() * 2 - 1) * 1.6, rng.next() * 1.1 - 0.15, (rng.next() * 2 - 1) * 1.6);
      this.emit('dustMote', {
        position: _v0,
        velocity: _v1,
        count: 1,
        scale: 0.6 + rng.next() * 0.9,
        life: 0.7 + rng.next() * 0.7,
        opacity: 0.35 + rng.next() * 0.65,
        groundY,
      });
    }
  }

  /* ---------------------------------------------------------------- events */

  _onLand(p) {
    const v = p?.vehicle;
    if (!v || !this.enabled) return;
    const air = Math.max(0, p?.airTime ?? 0);
    if (air < 0.16) return;
    const strength = saturate(air * 1.5) * saturate((p?.speed ?? v.speed ?? 0) / 60);
    if (strength < 0.05) return;

    for (let i = 0; i < 4; i++) {
      const w = v.wheels?.[i];
      if (!w) continue;
      const rec = surfaceRecord(w.surface);
      const kind = rec.particle && this.emitters.has(rec.particle) ? rec.particle : 'dust';
      _v0.set(w.contactX, w.contactY + 0.4, w.contactZ);
      if (!Number.isFinite(_v0.x)) continue;
      this.emit('dust', {
        position: _v0,
        velocity: _v1.set(0, 9 + strength * 12, 0),
        count: Math.round(3 + strength * 7),
        spread: 12 + strength * 16,
        jitter: 1.2,
        color: surfaceParticleColor(w.surface),
        scale: 0.8 + strength * 0.8,
        opacity: 0.55 + strength * 0.7,
        groundY: w.contactY,
      });
      if (kind !== 'dust' && kind !== 'tyreSmoke') {
        this.emit(kind, {
          position: _v0,
          velocity: _v1.set(0, 18 + strength * 22, 0),
          count: Math.round(2 + strength * 6),
          spread: 20 + strength * 22,
          color: surfaceParticleColor(w.surface),
          opacity: 0.9,
          groundY: w.contactY,
        });
      }
    }
  }

  _onShift(p) {
    const v = p?.vehicle;
    if (!v || !this.enabled || p?.up === false) return;
    const len = v.spec?.bodyLength ?? 9;
    const hgt = v.spec?.bodyHeight ?? 2.8;
    _v0.set(0, hgt * 0.30, -len * 0.5 - 0.5).applyQuaternion(v.quaternion).add(v.position);
    _v1.set(0, 0, -1).applyQuaternion(v.quaternion).multiplyScalar(52);
    if (v.velocity) _v1.addScaledVector(v.velocity, 0.7);
    this.emit('exhaust', {
      position: _v0, velocity: _v1, count: 6, spread: 7, jitter: 0.4,
      scale: 1.5, opacity: 1.5, groundY: _v0.y,
    });
    this.emit('sparks', {
      position: _v0, velocity: _v1, count: 4, spread: 16,
      scale: 0.7, opacity: 0.8, groundY: _v0.y - 2,
    });
  }

  _onRespawn(p) {
    const v = p?.vehicle;
    if (!v || !this.enabled) return;
    _v0.copy(v.position);
    this.emit('dust', {
      position: _v0, velocity: _v1.set(0, 6, 0), count: 14, spread: 26,
      jitter: 3, scale: 1.3, opacity: 0.5, groundY: _v0.y - 2,
    });
  }

  /* ---------------------------------------------------------------- report */

  info() {
    const kinds = {};
    let live = 0;
    let cap = 0;
    for (const [k, em] of this.emitters) {
      kinds[k] = { live: em.count, capacity: em.capacity, spawned: em.spawned, recycled: em.dropped };
      live += em.count;
      cap += em.capacity;
    }
    return {
      live,
      capacity: cap,
      drawCalls: this.emitters.size,
      soft: !!(this.softParticles && this.probe?.enabled),
      lit: this.lit,
      depth: this.probe ? `${this.probe.width}x${this.probe.height}` : 'off',
      kinds,
    };
  }

  dispose() {
    for (const off of this._offBus) { try { off?.(); } catch (_) { /* already gone */ } }
    this._offBus.length = 0;
    for (const em of this.emitters.values()) em.dispose();
    this.emitters.clear();
    for (const t of this.textures.values()) t.dispose?.();
    this.textures.clear();
    this.probe?.dispose();
    this.probe = null;
    this.group.parent?.remove(this.group);
    this._carFx.clear();
  }
}

/* Small helper so emit() call sites read as coordinates rather than as vector
 * bookkeeping. Returns module scratch — never hold on to it. */
function _tmpPos(x, y, z) { return _v0.set(x, y, z); }

export const ParticleSystem = Particles;
export default Particles;
