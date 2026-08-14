// textures/ProcTex.js — the procedural PBR texture foundry.
//
// Every surface in MICRO GAUNTLET is baked here, in JavaScript, from noise.
// There are no image files anywhere in the project, so this module is the only
// thing standing between the game and a grey box.
//
// Three principles run through the whole file:
//
//  1. HEIGHT IS THE TRUTH. Every generator authors a scalar height field plus
//     albedo and roughness. The normal map is then *derived* from that height
//     by a Sobel operator scaled through real world units (a surface declares
//     its relief in centimetres and the size of one tile in centimetres, so the
//     gradient we encode is a genuine physical slope). Nothing is faked, and
//     the normal can never disagree with the AO or the displacement.
//
//  2. SEAMLESS BY CONSTRUCTION, NOT BY EYE. Every noise call goes through the
//     exactly-periodic generators in core/Random.js; every blur, Sobel and
//     upsample indexes with a wrap; every scattered element (grass blade,
//     pebble, crumb) is rasterised with modulo addressing so it reappears on
//     the far edge. `verifyTiling()` then measures it: it compares the gradient
//     energy across the wrap seam with the gradient energy in the interior. A
//     ratio of ~1.0 is a mathematical proof of continuity, not a squint test.
//
//  3. BAND-LIMITED, MULTI-RESOLUTION BAKING. A 6-octave fbm whose largest
//     feature is 8 cells wide carries no information above its own Nyquist, so
//     evaluating it at 2048² is pure waste. Every layer is evaluated at the
//     lowest resolution that can represent it and lifted to the bake size with
//     a wrap-aware Catmull-Rom filter (C1, so derived normals stay smooth).
//     Layers finer than the bake grid fade toward their mean instead of
//     aliasing, which is also what makes the low quality tiers look soft rather
//     than crunchy, and what makes the fast "draft" bake usable on screen.
//
// Public entry point is `makeTextureSet(kind, opts)`. It returns real
// THREE.DataTextures, fully configured, never a raw canvas.

import {
  DataTexture,
  RepeatWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

import * as Rnd from '../core/Random.js';
import * as Cfg from '../core/Settings.js';

/* ============================================================== settings shim */

const Settings = Cfg.Settings ?? Cfg.default ?? {
  textures: { resolution: 1024, maxResolution: 2048, proceduralDetail: 1, generateDisplacement: false, generateAO: true, cacheBudgetMB: 256 },
  render: { anisotropy: 8 },
};

function texCfg() {
  return Settings.textures ?? { resolution: 1024, proceduralDetail: 1 };
}

/* ================================================================ noise shims */
//
// Namespace import + explicit picks: a named import of something core/Random.js
// has not exported yet is a hard link error that would take the whole game
// down, whereas a missing property here just falls through to a local
// implementation. These fallbacks are deliberately complete enough to bake a
// shippable texture on their own.

function fbFade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function fbWrap(v, p) { const r = v % p; return r < 0 ? r + p : r; }

function fbHash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const FB_G = [1, 0, -1, 0, 0, 1, 0, -1, 0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071];

function fbPerlinTiled(x, y, px, py = px, seed = 0) {
  const ax = Math.max(1, Math.round(px)), ay = Math.max(1, Math.round(py));
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fbFade(fx), v = fbFade(fy);
  const x0 = fbWrap(ix, ax), x1 = fbWrap(ix + 1, ax);
  const y0 = fbWrap(iy, ay), y1 = fbWrap(iy + 1, ay);
  const d = (hx, hy, dx, dy) => { const i = (fbHash2i(hx, hy, seed) & 7) << 1; return FB_G[i] * dx + FB_G[i + 1] * dy; };
  const n00 = d(x0, y0, fx, fy), n10 = d(x1, y0, fx - 1, fy);
  const n01 = d(x0, y1, fx, fy - 1), n11 = d(x1, y1, fx - 1, fy - 1);
  const t = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (t + (b - t) * v) * Math.SQRT2;
}

function fbFbmTiled(x, y, period, oct = 5, lac = 2, gain = 0.5, seed = 0) {
  const base = Math.max(1, Math.round(period));
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let i = 0; i < oct; i++) {
    const p = Math.max(1, Math.round(base * freq));
    const s = p / base;
    sum += amp * fbPerlinTiled(x * s, y * s, p, p, seed + i * 1013);
    norm += amp; amp *= gain; freq *= lac;
  }
  return norm > 0 ? sum / norm : 0;
}

const _fbCell = { f1: 0, f2: 0, edge: 0, id: 0, cellX: 0, cellY: 0, dx: 0, dy: 0 };
function fbWorleyFull(x, y, seed = 0, opts) {
  const jitter = opts?.jitter ?? 1;
  const p = opts?.period > 0 ? Math.max(1, Math.round(opts.period)) : 0;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, bx = 0, by = 0, bid = 0, bdx = 0, bdy = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const hx = p > 0 ? fbWrap(cx, p) : cx;
      const hy = p > 0 ? fbWrap(cy, p) : cy;
      const h = fbHash2i(hx, hy, seed);
      const px2 = cx + 0.5 + ((h & 0xffff) / 65536 - 0.5) * jitter;
      const py2 = cy + 0.5 + (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
      const dx = px2 - x, dy = py2 - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; bx = hx; by = hy; bid = h; bdx = dx; bdy = dy; }
      else if (d < f2) f2 = d;
    }
  }
  _fbCell.f1 = f1; _fbCell.f2 = f2; _fbCell.edge = f2 - f1;
  _fbCell.id = bid >>> 0; _fbCell.cellX = bx; _fbCell.cellY = by; _fbCell.dx = bdx; _fbCell.dy = bdy;
  return _fbCell;
}

export const clamp = Rnd.clamp ?? ((v, a, b) => (v < a ? a : v > b ? b : v));
export const saturate = Rnd.saturate ?? ((v) => (v < 0 ? 0 : v > 1 ? 1 : v));
export const lerp = Rnd.lerp ?? ((a, b, t) => a + (b - a) * t);
export const smoothstep = Rnd.smoothstep ?? ((a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); });
export const smootherstep = Rnd.smootherstep ?? ((a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); });
const fract = Rnd.fract ?? ((v) => v - Math.floor(v));

const makeRng = Rnd.makeRng ?? ((seed) => {
  let s = (seed | 0) || 1;
  const next = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, float: next, range: (a, b) => a + (b - a) * next(), int: (a, b) => a + Math.floor(next() * (b - a + 1)), sign: () => (next() < 0.5 ? -1 : 1), bool: (p = 0.5) => next() < p, chance: (p = 0.5) => next() < p, pick: (arr) => arr[Math.min(arr.length - 1, Math.floor(next() * arr.length))], gauss: (m = 0, sd = 1) => m + sd * (next() + next() + next() + next() - 2) * 1.2 };
});

const hashSeed = Rnd.hashSeed ?? ((s) => {
  const str = String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h ^ (h >>> 16)) >>> 0;
});

const hash2i = Rnd.hash2i ?? fbHash2i;
const perlin2DTiled = Rnd.perlin2DTiled ?? fbPerlinTiled;
const fbm2DTiled = Rnd.fbm2DTiled ?? fbFbmTiled;
const fbmTorus2D = Rnd.fbmTorus2D ?? fbFbmTiled;
const worley2DFull = Rnd.worley2DFull ?? fbWorleyFull;
const value2DTiled = Rnd.value2DTiled ?? ((x, y, p, s) => fbPerlinTiled(x, y, p, p, s) * 0.5 + 0.5);

const ridged2DTiled = Rnd.ridged2DTiled ?? ((x, y, p, o = 5, l = 2, g = 0.5, seed = 0, sharp = 2) => {
  let sum = 0, amp = 0.5, norm = 0, weight = 1, freq = 1;
  const base = Math.max(1, Math.round(p));
  for (let i = 0; i < o; i++) {
    const pp = Math.max(1, Math.round(base * freq)), s = pp / base;
    let v = 1 - Math.abs(fbPerlinTiled(x * s, y * s, pp, pp, seed + i * 1013));
    v *= v; if (sharp !== 2) v = Math.pow(v, sharp * 0.5);
    v *= weight; weight = clamp(v * 2, 0, 1);
    sum += v * amp; norm += amp; amp *= g; freq *= l;
  }
  return norm > 0 ? clamp(sum / norm, 0, 1) : 0;
});

const billow2DTiled = Rnd.billow2DTiled ?? ((x, y, p, o = 5, l = 2, g = 0.5, seed = 0) => {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  const base = Math.max(1, Math.round(p));
  for (let i = 0; i < o; i++) {
    const pp = Math.max(1, Math.round(base * freq)), s = pp / base;
    sum += amp * Math.abs(fbPerlinTiled(x * s, y * s, pp, pp, seed + i * 1013));
    norm += amp; amp *= g; freq *= l;
  }
  return norm > 0 ? sum / norm : 0;
});

const warpFbm2DTiled = Rnd.warpFbm2DTiled ?? ((x, y, p, w = 0.6, o = 5, l = 2, g = 0.5, seed = 0) => {
  const wx = fbFbmTiled(x + 5.2, y + 1.3, p, 3, 2, 0.5, seed + 9173);
  const wy = fbFbmTiled(x + 1.7, y + 9.2, p, 3, 2, 0.5, seed + 3319);
  return fbFbmTiled(x + w * wx, y + w * wy, p, o, l, g, seed);
});

const worleyFbm2D = Rnd.worleyFbm2D ?? ((x, y, o = 3, l = 2, g = 0.5, seed = 0, period = 0) => {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  const base = period > 0 ? Math.max(1, Math.round(period)) : 0;
  for (let i = 0; i < o; i++) {
    let v;
    if (base > 0) { const p = Math.max(1, Math.round(base * freq)); const s = p / base; v = fbWorleyFull(x * s, y * s, seed + i * 7919, { period: p }).f1; }
    else v = fbWorleyFull(x * freq, y * freq, seed + i * 7919).f1;
    sum += amp * Math.min(1, v); norm += amp; amp *= g; freq *= l;
  }
  return norm > 0 ? sum / norm : 0;
});

/** Bundle of tiled generators bound to one integer period. */
const makeNoise2D = Rnd.makeNoise2D ?? ((period, seed = 0) => {
  const p = Math.max(1, Math.round(period));
  return {
    period: p, seed,
    value: (x, y) => value2DTiled(x, y, p, seed),
    perlin: (x, y) => perlin2DTiled(x, y, p, p, seed),
    simplex: (x, y) => perlin2DTiled(x, y, p, p, seed),
    fbm: (x, y, o = 5, l = 2, g = 0.5) => fbm2DTiled(x, y, p, o, l, g, seed),
    fbmIso: (x, y, o = 5, l = 2, g = 0.5) => fbmTorus2D(x, y, p, o, l, g, seed),
    ridged: (x, y, o = 5, l = 2, g = 0.5, s = 2) => ridged2DTiled(x, y, p, o, l, g, seed, s),
    billow: (x, y, o = 5, l = 2, g = 0.5) => billow2DTiled(x, y, p, o, l, g, seed),
    warp: (x, y, w = 0.6, o = 5, l = 2, g = 0.5) => warpFbm2DTiled(x, y, p, w, o, l, g, seed),
    worley: (x, y) => Math.min(1, worley2DFull(x, y, seed, { period: p }).f1),
    worleyEdge: (x, y) => Math.min(1, worley2DFull(x, y, seed, { period: p }).edge),
    worleyCell: (x, y) => { const c = worley2DFull(x, y, seed, { period: p }); return hash2i(c.cellX, c.cellY, seed ^ 0x5bf03635) / 4294967296; },
    worleyFbm: (x, y, o = 3, l = 2, g = 0.5) => worleyFbm2D(x, y, o, l, g, seed, p),
    cell: (x, y, opts) => worley2DFull(x, y, seed, { period: p, ...opts }),
  };
});

/* ================================================================== colour */

/** #rrggbb (or 0xrrggbb) to an sRGB triple in [0,1]. Textures are authored in
 *  sRGB — that is the space a hex value means something in. */
export function rgb(hex) {
  const v = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex | 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const _c3 = [0, 0, 0];
function mixC(a, b, t, out = _c3) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Perceptual-ish tint: hue rotate + saturate + lift, cheap enough for a
 *  million-pixel loop. Works directly on sRGB triples. */
function tint(out, r, g, b, hueDeg, satMul, valMul) {
  let h = 0, s = 0;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) * 0.5;
  const d = mx - mn;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = fract(h + hueDeg / 360);
  s = clamp(s * satMul, 0, 1);
  const l2 = clamp(l * valMul, 0, 1);
  if (s < 1e-6) { out[0] = out[1] = out[2] = l2; return out; }
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
  const p = 2 * l2 - q;
  const hk = (t) => {
    let tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  out[0] = hk(h + 1 / 3); out[1] = hk(h); out[2] = hk(h - 1 / 3);
  return out;
}

/* ============================================================ resampling */

const _cw = new Float32Array(4);
function catmull(f) {
  const f2 = f * f, f3 = f2 * f;
  _cw[0] = -0.5 * f3 + f2 - 0.5 * f;
  _cw[1] = 1.5 * f3 - 2.5 * f2 + 1;
  _cw[2] = -1.5 * f3 + 2 * f2 + 0.5 * f;
  _cw[3] = 0.5 * f3 - 0.5 * f2;
  return _cw;
}

function buildTaps(idx, wts, srcN, dstN) {
  for (let x = 0; x < dstN; x++) {
    // Both grids sample the same continuous periodic field at index*period/N,
    // so there is no half-texel offset: index x maps to srcN*x/dstN exactly.
    const sx = (x * srcN) / dstN;
    const i0 = Math.floor(sx);
    const w = catmull(sx - i0);
    for (let k = 0; k < 4; k++) {
      let j = (i0 - 1 + k) % srcN; if (j < 0) j += srcN;
      idx[x * 4 + k] = j;
      wts[x * 4 + k] = w[k];
    }
  }
}

/**
 * Wrap-aware separable Catmull-Rom upsample from sw x sh to size x size.
 *
 * Catmull-Rom rather than bilinear because the result is differentiated by the
 * Sobel pass: bilinear's discontinuous derivative would print the
 * low-resolution sampling grid straight into the normal map. Source dimensions
 * are independent so a strongly anisotropic field (felt nap, brushed metal) can
 * be evaluated at, say, 32 x 1024 instead of 1024².
 */
function upsampleWrapCubic(src, sw, sh, dst, size) {
  const tmp = new Float32Array(size * sh);
  const xi = new Int32Array(size * 4);
  const xw = new Float32Array(size * 4);
  buildTaps(xi, xw, sw, size);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    const orow = y * size;
    for (let x = 0; x < size; x++) {
      const o = x * 4;
      tmp[orow + x] =
        src[row + xi[o]] * xw[o] +
        src[row + xi[o + 1]] * xw[o + 1] +
        src[row + xi[o + 2]] * xw[o + 2] +
        src[row + xi[o + 3]] * xw[o + 3];
    }
  }
  const yi = new Int32Array(size * 4);
  const yw = new Float32Array(size * 4);
  buildTaps(yi, yw, sh, size);
  for (let y = 0; y < size; y++) {
    const o = y * 4;
    const r0 = yi[o] * size, r1 = yi[o + 1] * size, r2 = yi[o + 2] * size, r3 = yi[o + 3] * size;
    const w0 = yw[o], w1 = yw[o + 1], w2 = yw[o + 2], w3 = yw[o + 3];
    const orow = y * size;
    for (let x = 0; x < size; x++) {
      dst[orow + x] = tmp[r0 + x] * w0 + tmp[r1 + x] * w1 + tmp[r2 + x] * w2 + tmp[r3 + x] * w3;
    }
  }
  return dst;
}

/* ------------------------------------------------- anisotropic periodic noise */
//
// core/Random.js wraps on a single square period. Almost every real material
// with a direction — felt nap, brushed aluminium, wood fibre, lino jaspé — needs
// cells that are long on one axis and short on the other, wrapping exactly on
// both. Multiplying one input by a fraction (`fbm(x * 0.05, y)`) would silently
// break the wrap, so the period is carried per axis instead.

/** fbm with independent integer periods: x spans 0..px, y spans 0..py. */
function fbmAniso(x, y, px, py, oct = 4, lac = 2, gain = 0.5, seed = 0) {
  const bx = Math.max(1, Math.round(px)), by = Math.max(1, Math.round(py));
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let i = 0; i < oct; i++) {
    const qx = Math.max(1, Math.round(bx * freq));
    const qy = Math.max(1, Math.round(by * freq));
    sum += amp * perlin2DTiled(x * (qx / bx), y * (qy / by), qx, qy, seed + i * 1013);
    norm += amp; amp *= gain; freq *= lac;
  }
  return norm > 0 ? sum / norm : 0;
}

function ridgedAniso(x, y, px, py, oct = 4, lac = 2, gain = 0.5, seed = 0, sharp = 2) {
  const bx = Math.max(1, Math.round(px)), by = Math.max(1, Math.round(py));
  let sum = 0, amp = 0.5, norm = 0, weight = 1, freq = 1;
  for (let i = 0; i < oct; i++) {
    const qx = Math.max(1, Math.round(bx * freq));
    const qy = Math.max(1, Math.round(by * freq));
    let v = 1 - Math.abs(perlin2DTiled(x * (qx / bx), y * (qy / by), qx, qy, seed + i * 1013));
    v *= v;
    if (sharp !== 2) v = Math.pow(v, sharp * 0.5);
    v *= weight;
    weight = clamp(v * 2, 0, 1);
    sum += v * amp; norm += amp; amp *= gain; freq *= lac;
  }
  return norm > 0 ? clamp(sum / norm, 0, 1) : 0;
}

function billowAniso(x, y, px, py, oct = 4, lac = 2, gain = 0.5, seed = 0) {
  const bx = Math.max(1, Math.round(px)), by = Math.max(1, Math.round(py));
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let i = 0; i < oct; i++) {
    const qx = Math.max(1, Math.round(bx * freq));
    const qy = Math.max(1, Math.round(by * freq));
    sum += amp * Math.abs(perlin2DTiled(x * (qx / bx), y * (qy / by), qx, qy, seed + i * 1013));
    norm += amp; amp *= gain; freq *= lac;
  }
  return norm > 0 ? sum / norm : 0;
}

function makeAniso(cx, cy, seed) {
  return {
    cx, cy, seed,
    perlin: (x, y) => perlin2DTiled(x, y, cx, cy, seed),
    fbm: (x, y, o = 4, l = 2, g = 0.5) => fbmAniso(x, y, cx, cy, o, l, g, seed),
    ridged: (x, y, o = 4, l = 2, g = 0.5, s = 2) => ridgedAniso(x, y, cx, cy, o, l, g, seed, s),
    billow: (x, y, o = 4, l = 2, g = 0.5) => billowAniso(x, y, cx, cy, o, l, g, seed),
    // The displacement field shares the period, so warping preserves the wrap.
    warp: (x, y, w = 0.6, o = 4, l = 2, g = 0.5) => {
      const wx = fbmAniso(x + 5.2, y + 1.3, cx, cy, 3, 2, 0.5, seed + 9173);
      const wy = fbmAniso(x + 1.7, y + 9.2, cx, cy, 3, 2, 0.5, seed + 3319);
      return fbmAniso(x + w * wx, y + w * wy, cx, cy, o, l, g, seed);
    },
    worley: (x, y, jitter) => worleyAniso(x, y, cx, cy, seed, jitter),
  };
}

/** Separable box blur with wrap. Used for the multi-radius cavity AO. */
function boxBlurWrap(src, dst, size, radius, scratch) {
  const r = Math.max(1, radius | 0);
  const inv = 1 / (r * 2 + 1);
  const tmp = scratch || new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let acc = 0;
    for (let k = -r; k <= r; k++) { let i = k % size; if (i < 0) i += size; acc += src[row + i]; }
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc * inv;
      let outI = (x - r) % size; if (outI < 0) outI += size;
      let inI = (x + r + 1) % size; if (inI < 0) inI += size;
      acc += src[row + inI] - src[row + outI];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) { let i = k % size; if (i < 0) i += size; acc += tmp[i * size + x]; }
    for (let y = 0; y < size; y++) {
      dst[y * size + x] = acc * inv;
      let outI = (y - r) % size; if (outI < 0) outI += size;
      let inI = (y + r + 1) % size; if (inI < 0) inI += size;
      acc += tmp[inI * size + x] - tmp[outI * size + x];
    }
  }
  return dst;
}

/* ============================================================== bake object */

/**
 * The per-bake scratch state. Generators fill the channel buffers; the shared
 * finaliser turns them into textures. Buffers are pooled because a 2048² layer
 * is 16 MB and a rich generator wants eight of them.
 */
function makeBake(kind, size, def, opts) {
  const n = size * size;
  const seed = hashSeed(`${kind}|${opts.seed ?? 0}`) >>> 0;
  const B = {
    kind,
    size,
    n,
    seed,
    rng: makeRng(seed ^ 0x5f3759df),
    world: def.tileWorld,
    relief: def.relief,
    detail: clamp(texCfg().proceduralDetail ?? 1, 0.25, 1.5),
    // channels
    h: new Float32Array(n),
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    rough: new Float32Array(n),
    ao: null,
    metal: null,
    alpha: null,
    thick: null,
    aoStrength: def.aoStrength ?? 1,
    normalScale: def.normalScale ?? 1,
    pool: [],
  };
  B.px = B.world / size;            // world centimetres per texel
  B.take = () => (B.pool.length ? B.pool.pop() : new Float32Array(n));
  B.takeZero = () => { const a = B.take(); a.fill(0); return a; };
  B.give = (a) => { if (a && B.pool.length < 6) B.pool.push(a); };
  B.wantAo = () => { if (!B.ao) { B.ao = new Float32Array(n).fill(1); } return B.ao; };
  B.wantMetal = () => { if (!B.metal) B.metal = new Float32Array(n); return B.metal; };
  B.wantAlpha = () => { if (!B.alpha) B.alpha = new Float32Array(n); return B.alpha; };
  B.wantThick = () => { if (!B.thick) B.thick = new Float32Array(n); return B.thick; };

  /**
   * Evaluate a periodic field and lift it to the bake resolution.
   * @param {number} cells period of the field across the tile, in noise cells
   * @param {(nz, cells) => (x, y) => number} build receives a bound generator
   * @param {object} [o] { samples, full, neutral, seed }
   */
  B.field = (cells, build, o) => {
    const c = Math.max(1, Math.round(cells));
    const nz = makeNoise2D(c, (B.seed + ((o && o.seed) | 0)) | 0);
    return bakeLayer(B, c, build(nz, c), o);
  };

  /** Same, but you supply the sampling function directly (already periodic). */
  B.layer = (cells, fn, o) => bakeLayer(B, Math.max(1, Math.round(cells)), fn, o);

  /**
   * Directional layer: independent cell counts per axis, wrapping exactly on
   * both. Evaluated at a resolution chosen per axis, so a 6 x 900 nap costs a
   * few thousand samples instead of a million.
   */
  B.aniso = (cellsX, cellsY, build, o) => {
    const cx = Math.max(1, Math.round(cellsX));
    const cy = Math.max(1, Math.round(cellsY));
    const nz = makeAniso(cx, cy, (B.seed + ((o && o.seed) | 0)) | 0);
    return bakeAniso(B, cx, cy, build(nz, cx, cy), o);
  };

  return B;
}

function bakeLayer(B, c, fn, o = {}) {
  const size = B.size;
  const out = B.take();
  const neutral = o.neutral ?? 0;
  // Below ~4 texels per cell a layer cannot be represented; fading it toward
  // its mean is the band-limited answer and is what keeps drafts and the low
  // quality tier smooth rather than speckled.
  const w = 1 - smoothstep(size / 4, size / 1.8, c);
  if (w <= 0.002) { out.fill(neutral); return out; }

  const spc = o.samples ?? 4;
  let res = o.full ? size : Math.ceil(c * spc);
  if (res > size) res = size;
  if (res < 8) res = 8;

  if (res === size) {
    const k = c / size;
    for (let y = 0, i = 0; y < size; y++) {
      const fy = y * k;
      for (let x = 0; x < size; x++, i++) out[i] = fn(x * k, fy);
    }
  } else {
    const small = new Float32Array(res * res);
    const k = c / res;
    for (let y = 0, i = 0; y < res; y++) {
      const fy = y * k;
      for (let x = 0; x < res; x++, i++) small[i] = fn(x * k, fy);
    }
    upsampleWrapCubic(small, res, res, out, size);
  }

  if (w < 0.999) {
    for (let i = 0; i < B.n; i++) out[i] = neutral + (out[i] - neutral) * w;
  }
  return out;
}

function bakeAniso(B, cx, cy, fn, o = {}) {
  const size = B.size;
  const out = B.take();
  const neutral = o.neutral ?? 0;
  const w = 1 - smoothstep(size / 4, size / 1.8, Math.max(cx, cy));
  if (w <= 0.002) { out.fill(neutral); return out; }

  const spc = o.samples ?? 4;
  const rx = o.full ? size : Math.min(size, Math.max(8, Math.ceil(cx * spc)));
  const ry = o.full ? size : Math.min(size, Math.max(8, Math.ceil(cy * spc)));

  if (rx === size && ry === size) {
    const kx = cx / size, ky = cy / size;
    for (let y = 0, i = 0; y < size; y++) {
      const fy = y * ky;
      for (let x = 0; x < size; x++, i++) out[i] = fn(x * kx, fy);
    }
  } else {
    const small = new Float32Array(rx * ry);
    const kx = cx / rx, ky = cy / ry;
    for (let y = 0, i = 0; y < ry; y++) {
      const fy = y * ky;
      for (let x = 0; x < rx; x++, i++) small[i] = fn(x * kx, fy);
    }
    upsampleWrapCubic(small, rx, ry, out, size);
  }

  if (w < 0.999) {
    for (let i = 0; i < B.n; i++) out[i] = neutral + (out[i] - neutral) * w;
  }
  return out;
}

/* ========================================================== rasterisation */
//
// Scattered detail (grass blades, pebbles, crumbs, paper fibres) is *scattered*
// into the buffers rather than gathered per pixel. A gather needs a search
// radius large enough for the longest element and costs 25-80 evaluations per
// texel; a scatter touches each element's footprint exactly once and is an
// order of magnitude cheaper. Modulo addressing on write is what makes the
// result wrap.

/**
 * Rasterise a thick line segment (capsule).
 * @param {(i:number, t:number, s:number, cov:number) => void} cb
 *        i   wrapped buffer index
 *        t   position along the segment, [0,1]
 *        s   signed distance across, [-1,1] at the edges
 *        cov antialiased coverage, [0,1]
 */
function rasterCapsule(B, x0, y0, x1, y1, halfW, feather, cb) {
  const size = B.size;
  const pad = halfW + feather + 1;
  const minX = Math.floor(Math.min(x0, x1) - pad);
  const maxX = Math.ceil(Math.max(x0, x1) + pad);
  const minY = Math.floor(Math.min(y0, y1) - pad);
  const maxY = Math.ceil(Math.max(y0, y1) + pad);
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2) || 1e-6;
  const inv = len2 > 1e-9 ? 1 / len2 : 0;
  const e0 = halfW - feather, e1 = halfW + feather;
  for (let yy = minY; yy <= maxY; yy++) {
    let wy = yy % size; if (wy < 0) wy += size;
    const rowBase = wy * size;
    for (let xx = minX; xx <= maxX; xx++) {
      let t = ((xx - x0) * dx + (yy - y0) * dy) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = xx - (x0 + dx * t), ey = yy - (y0 + dy * t);
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d >= e1) continue;
      const cov = d <= e0 ? 1 : 1 - smoothstep(e0, e1, d);
      if (cov <= 0.003) continue;
      let wx = xx % size; if (wx < 0) wx += size;
      const s = halfW > 1e-6 ? (ex * dy - ey * dx) / len / halfW : 0;
      cb(rowBase + wx, t, s, cov);
    }
  }
}

/**
 * Rasterise a disc, optionally with a per-angle radius modulation so pebbles
 * and crumbs are irregular rather than circular.
 * @param {(i:number, d:number, cov:number, nx:number, ny:number) => void} cb
 */
function rasterDisc(B, cx, cy, r, feather, cb, lobe) {
  const size = B.size;
  const pad = r * (lobe ? 1 + lobe.amp : 1) + feather + 1;
  const minX = Math.floor(cx - pad), maxX = Math.ceil(cx + pad);
  const minY = Math.floor(cy - pad), maxY = Math.ceil(cy + pad);
  for (let yy = minY; yy <= maxY; yy++) {
    let wy = yy % size; if (wy < 0) wy += size;
    const rowBase = wy * size;
    const ey = yy - cy;
    for (let xx = minX; xx <= maxX; xx++) {
      const ex = xx - cx;
      const dist = Math.sqrt(ex * ex + ey * ey);
      let rr = r;
      if (lobe) {
        const a = Math.atan2(ey, ex);
        rr = r * (1 + lobe.amp * (Math.sin(a * lobe.k1 + lobe.p1) * 0.6 + Math.sin(a * lobe.k2 + lobe.p2) * 0.4));
      }
      if (dist >= rr + feather) continue;
      const cov = 1 - smoothstep(rr - feather, rr + feather, dist);
      if (cov <= 0.003) continue;
      let wx = xx % size; if (wx < 0) wx += size;
      const inv = rr > 1e-6 ? 1 / rr : 0;
      cb(rowBase + wx, dist * inv, cov, ex * inv, ey * inv);
    }
  }
}

/** Deterministic jittered scatter over the tile, in texel coordinates. */
function scatterPoints(B, count, seedOff) {
  const rng = makeRng((B.seed ^ 0x9e3779b9) + seedOff);
  const out = new Float32Array(count * 2);
  // A jittered grid rather than uniform random: uniform random clumps, and
  // clumping is the single most obvious "procedural" tell in scattered detail.
  const cols = Math.max(1, Math.round(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cw = B.size / cols, ch = B.size / rows;
  let w = 0;
  for (let y = 0; y < rows && w < count * 2; y++) {
    for (let x = 0; x < cols && w < count * 2; x++) {
      out[w++] = (x + 0.5 + (rng.next() - 0.5) * 1.35) * cw;
      out[w++] = (y + 0.5 + (rng.next() - 0.5) * 1.35) * ch;
    }
  }
  return out;
}

/* ================================================================ finalise */

/** Sobel gradient of the height field, in real slope units, into a normal map.
 *
 *  A surface declares `relief` (peak-to-trough height in cm) and `tileWorld`
 *  (the size of one tile in cm), so `relief / texelWorld` converts the [0,1]
 *  height buffer into a physical gradient. That is why a 1024² and a 2048²
 *  bake of the same surface produce the *same* apparent bumpiness instead of
 *  the resolution silently doubling the normal strength.
 */
function encodeNormal(B, out) {
  const { size, h } = B;
  const texelWorld = B.world / size;
  const k = (B.relief / texelWorld) * 0.125 * B.normalScale; // 0.125 = Sobel /8
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1) + size) % size;
    const yp = (y + 1) % size;
    const r0 = ym * size, r1 = y * size, r2 = yp * size;
    for (let x = 0; x < size; x++) {
      const xm = ((x - 1) + size) % size;
      const xp = (x + 1) % size;
      const h00 = h[r0 + xm], h10 = h[r0 + x], h20 = h[r0 + xp];
      const h01 = h[r1 + xm], h21 = h[r1 + xp];
      const h02 = h[r2 + xm], h12 = h[r2 + x], h22 = h[r2 + xp];
      const gx = (h20 + 2 * h21 + h22 - h00 - 2 * h01 - h02) * k;
      const gy = (h02 + 2 * h12 + h22 - h00 - 2 * h10 - h20) * k;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const o = (r1 + x) * 4;
      // DataTexture is flipY=false, so row index rises with v: both axes encode
      // as 0.5 - slope/2 in the OpenGL (+Y up) convention three expects. The
      // + 0.5 rounds rather than truncates: the mip builder measures the length
      // of averaged normals, so a systematic half-level bias on every texel
      // would read as surface roughness that is not there.
      out[o] = (0.5 - 0.5 * gx * inv) * 255 + 0.5;
      out[o + 1] = (0.5 - 0.5 * gy * inv) * 255 + 0.5;
      out[o + 2] = (0.5 + 0.5 * inv) * 255 + 0.5;
      out[o + 3] = 255;
    }
  }
}

/**
 * Multi-radius cavity ambient occlusion derived from the height field.
 *
 * For each radius the texel is compared with a wrapped box blur of the height
 * at that radius: sitting below the local average means geometry rises around
 * you, which is exactly what occludes the sky. Three radii cover the range
 * from a pore to a plank joint. Authored AO (a generator writing B.ao) is
 * multiplied on top so a recipe can darken something the height cannot express.
 */
function deriveAO(B) {
  const { size, n, h } = B;
  const out = new Float32Array(n).fill(1);
  if (texCfg().generateAO === false) return out;

  const blur = new Float32Array(n);
  const radii = [
    Math.max(1, Math.round(size / 340)),
    Math.max(2, Math.round(size / 110)),
    Math.max(4, Math.round(size / 34)),
  ];
  const weights = [0.42, 0.34, 0.24];
  const occ = new Float32Array(n);
  const scratch = new Float32Array(n);
  for (let ri = 0; ri < radii.length; ri++) {
    boxBlurWrap(h, blur, size, radii[ri], scratch);
    const w = weights[ri];
    for (let i = 0; i < n; i++) {
      const d = blur[i] - h[i];
      if (d > 0) occ[i] += w * (d > 0.34 ? 1 : d * 2.94);
    }
  }
  const s = B.aoStrength;
  for (let i = 0; i < n; i++) {
    let a = 1 - s * occ[i];
    if (a < 0.12) a = 0.12;
    // Slight gamma so mid occlusion does not read as a flat grey wash.
    out[i] = a * a * (3 - 2 * a) * 0.35 + a * 0.65;
  }
  if (B.ao) for (let i = 0; i < n; i++) out[i] *= B.ao[i];
  return out;
}

/* ------------------------------------------------------------- mip chains */
//
// The hardware box filter is the wrong filter for two of these three maps, and
// that is the single biggest reason a varnished table combs into red and blue
// bands at grazing angles.
//
// Averaging an *encoded* normal shortens the vector; the shader then
// renormalises it and throws away the only thing the average told us — how much
// the surface wobbles inside that footprint. Averaging roughness is worse: two
// texels at roughness 0.1 whose normals are twenty degrees apart do not behave
// like one texel at 0.1, they behave like a markedly rougher one. Discard that
// variance and every minified specular highlight has to be resolved by the
// pixel grid, which it cannot be, so it strobes.
//
// So the chain is built here. Each level keeps the *unnormalised* mean of the
// level-0 unit normals. The length of that mean is a von Mises-Fisher
// concentration (kappa = r(3 - r^2)/(1 - r^2)), and the extra GGX width it
// implies — alpha^2 += 2/kappa, the Olano-Baker / Frostbite result — is folded
// into the roughness byte stored at that level. Roughness therefore *rises*
// with distance, which is the entire point: the highlight that can no longer be
// resolved is turned into lobe width instead of into noise.

// Averaging sRGB bytes averages code values, not light, and darkens every edge
// in the texture. Both directions go through tables because a mip chain is
// ~1.33 n texels and Math.pow in that loop is a visible chunk of the bake.
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN2SRGB_N = 4096;
const LIN2SRGB = new Uint8Array(LIN2SRGB_N + 1);
for (let i = 0; i <= LIN2SRGB_N; i++) {
  const v = i / LIN2SRGB_N;
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LIN2SRGB[i] = clamp(Math.round(c * 255), 0, 255);
}
function linToSrgbByte(v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return LIN2SRGB[(v * LIN2SRGB_N) | 0];
}

/** Extra GGX alpha^2 implied by a mean normal of length `len`. */
function vmfAlphaSq(len) {
  const r = clamp(len, 1e-4, 0.999999);
  const r2 = r * r;
  const kappa = (r * (3 - r2)) / Math.max(1 - r2, 1e-6);
  return 2 / Math.max(kappa, 1e-6);
}

/**
 * Build the albedo / ORM / normal mip chains together.
 *
 * They have to be built together because the roughness stored at a level is a
 * function of the normal spread measured at that same level.
 *
 * @returns {{albedo: object[], orm: object[], normal: object[]}} level arrays
 *          in three's `texture.mipmaps` shape, level 0 first.
 */
function buildMipChains(albedo, orm, normal, size) {
  const out = {
    albedo: [{ data: albedo, width: size, height: size }],
    orm: [{ data: orm, width: size, height: size }],
    normal: [{ data: normal, width: size, height: size }],
  };

  let w = size;
  // Working state at the level we are reducing *from*. Null means "read the
  // level-0 byte arrays"; every later level reads these instead so the mean
  // normal stays relative to level 0 rather than to its immediate parent.
  let alb = null, nrm = null, m4 = null, aom = null;

  while (w > 1) {
    const nw = w >> 1;
    const nn = nw * nw;
    const nAlb = new Float32Array(nn * 4);
    const nNrm = new Float32Array(nn * 3);
    const nM4 = new Float32Array(nn);
    const nAom = new Float32Array(nn * 2);
    const bAlb = new Uint8Array(nn * 4);
    const bOrm = new Uint8Array(nn * 4);
    const bNrm = new Uint8Array(nn * 4);

    for (let y = 0; y < nw; y++) {
      for (let x = 0; x < nw; x++) {
        let ar = 0, ag = 0, ab = 0, aa = 0;
        let nx = 0, ny = 0, nz = 0;
        let r4 = 0, ao = 0, me = 0;
        for (let j = 0; j < 2; j++) {
          const sy = (y << 1) + j;
          for (let i = 0; i < 2; i++) {
            const si = sy * w + (x << 1) + i;
            if (alb === null) {
              const b = si * 4;
              ar += SRGB_TO_LIN[albedo[b]];
              ag += SRGB_TO_LIN[albedo[b + 1]];
              ab += SRGB_TO_LIN[albedo[b + 2]];
              aa += albedo[b + 3] * (1 / 255);
              nx += normal[b] * (2 / 255) - 1;
              ny += normal[b + 1] * (2 / 255) - 1;
              nz += normal[b + 2] * (2 / 255) - 1;
              ao += orm[b] * (1 / 255);
              const pr = orm[b + 1] * (1 / 255);
              const p2 = pr * pr;
              r4 += p2 * p2;
              me += orm[b + 2] * (1 / 255);
            } else {
              const b = si * 4, c = si * 3, d = si * 2;
              ar += alb[b]; ag += alb[b + 1]; ab += alb[b + 2]; aa += alb[b + 3];
              nx += nrm[c]; ny += nrm[c + 1]; nz += nrm[c + 2];
              r4 += m4[si];
              ao += aom[d]; me += aom[d + 1];
            }
          }
        }

        const o = y * nw + x;
        const q = 0.25;
        ar *= q; ag *= q; ab *= q; aa *= q;
        nx *= q; ny *= q; nz *= q;
        r4 *= q; ao *= q; me *= q;

        const a4 = o * 4, n3 = o * 3, a2 = o * 2;
        nAlb[a4] = ar; nAlb[a4 + 1] = ag; nAlb[a4 + 2] = ab; nAlb[a4 + 3] = aa;
        nNrm[n3] = nx; nNrm[n3 + 1] = ny; nNrm[n3 + 2] = nz;
        nM4[o] = r4;
        nAom[a2] = ao; nAom[a2 + 1] = me;

        bAlb[a4] = linToSrgbByte(ar);
        bAlb[a4 + 1] = linToSrgbByte(ag);
        bAlb[a4 + 2] = linToSrgbByte(ab);
        bAlb[a4 + 3] = clamp(aa, 0, 1) * 255;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const inv = len > 1e-6 ? 1 / len : 0;
        bNrm[a4] = (nx * inv * 0.5 + 0.5) * 255;
        bNrm[a4 + 1] = (ny * inv * 0.5 + 0.5) * 255;
        bNrm[a4 + 2] = (nz * inv * 0.5 + 0.5) * 255;
        bNrm[a4 + 3] = 255;

        // alpha^2 = mean(alpha_i^2) + 2/kappa, and perceptual roughness is
        // sqrt(alpha), hence the fourth root.
        const aSq = clamp(r4 + vmfAlphaSq(len), 0, 1);
        bOrm[a4] = clamp(ao, 0, 1) * 255;
        bOrm[a4 + 1] = clamp(Math.sqrt(Math.sqrt(aSq)), 0.02, 1) * 255;
        bOrm[a4 + 2] = clamp(me, 0, 1) * 255;
        bOrm[a4 + 3] = 255;
      }
    }

    out.albedo.push({ data: bAlb, width: nw, height: nw });
    out.orm.push({ data: bOrm, width: nw, height: nw });
    out.normal.push({ data: bNrm, width: nw, height: nw });

    alb = nAlb; nrm = nNrm; m4 = nM4; aom = nAom;
    w = nw;
  }

  return out;
}

/**
 * Wrap-aware bilinear magnification of a packed RGBA image.
 *
 * Only the draft bake uses this. A DataTexture's GPU storage is immutable once
 * three has allocated it, so a set that starts at draft resolution and later
 * sharpens must keep the *same* pixel dimensions throughout — otherwise the
 * sharp upload is silently dropped by the driver and the surface stays a blur
 * forever. The draft is therefore generated small and magnified to the final
 * size; only its detail is provisional, never its shape in memory.
 */
function upsampleRGBA(src, sw, dst, dw) {
  const k = sw / dw;
  for (let y = 0; y < dw; y++) {
    const fy = y * k;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const r0 = (y0 % sw) * sw;
    const r1 = ((y0 + 1) % sw) * sw;
    for (let x = 0; x < dw; x++) {
      const fx = x * k;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const c0 = x0 % sw;
      const c1 = (x0 + 1) % sw;
      const i00 = (r0 + c0) * 4, i10 = (r0 + c1) * 4;
      const i01 = (r1 + c0) * 4, i11 = (r1 + c1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
        const b = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
        dst[o + c] = a + (b - a) * ty;
      }
    }
  }
  return dst;
}

/**
 * @param {?object[]} mips level array (level 0 first) or null to let the
 *        driver box-filter its own chain — only appropriate for maps that are
 *        never minified, i.e. the vertex-stage displacement and thickness maps.
 */
function makeTex(data, size, srgb, aniso, mips) {
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  if (mips && mips.length > 1) {
    t.mipmaps = mips;
    t.generateMipmaps = false;
  } else {
    t.generateMipmaps = true;
  }
  t.anisotropy = aniso;
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Deliberately not texture.userData: THREE.Texture.copy() deep-clones userData
// through JSON, so parking a texture in there would make the next clone try to
// serialise a multi-megabyte typed array.
const _derived = new WeakMap();

/**
 * Register a repeat-adjusted clone of one of our textures.
 *
 * Texture.clone() shares the Source — and therefore the single GPU upload —
 * but it carries its own `version` and, critically, its own `mipmaps` array.
 * When a draft is re-baked in place only the original is marked dirty, so if a
 * clone happens to be bound first the driver is handed that clone's stale mip
 * chain and the sharp bake is silently thrown away. Tracking the clones lets an
 * in-place re-bake reach every view of the texture.
 */
export function linkDerived(base, derived) {
  if (!base || !derived || base === derived) return derived;
  let list = _derived.get(base);
  if (!list) { list = []; _derived.set(base, list); }
  if (list.indexOf(derived) < 0) list.push(derived);
  return derived;
}

let _anisotropy = 8;
/** Applied to every texture minted from here on; existing ones are retagged. */
export function setAnisotropy(v) {
  _anisotropy = clamp(v | 0, 1, 16);
  for (const set of _liveSets) {
    for (const t of set.textures) { t.anisotropy = _anisotropy; t.needsUpdate = true; }
  }
}

const _liveSets = new Set();

/* ===================================================== the generator table */
//
// Every entry fills B.h / B.r / B.g / B.b / B.rough (and optionally B.ao,
// B.metal, B.alpha). Defaults for relief, tile size and roughness live in
// GEN_DEF below so ProcTex is usable without Surfaces.js.

const GEN = Object.create(null);

/* ---------------------------------------------------------------- wood core */

/**
 * Shared timber generator.
 *
 * The cathedral figure of flat-sawn timber is not a noise pattern — it is what
 * you get when a plane slices a stack of nested cylinders. We model exactly
 * that: `depth` is the (slowly wandering) distance from the cut face to the
 * pith, and the ring coordinate is sqrt(across² + depth²). Where depth dips the
 * rings arch into the classic cathedral; where it rises they flatten into
 * straight quarter-sawn lines. Knots then domain-warp that coordinate radially,
 * so the grain genuinely flows around them instead of being drawn over.
 */
function woodBase(B, cfg) {
  const { size, n } = B;
  const rng = makeRng(B.seed ^ 0x00a1c3);
  const planks = cfg.planks;
  const plankW = B.world / planks;              // cm

  // Per-plank character.
  const P = [];
  for (let i = 0; i < planks; i++) {
    P.push({
      pith: rng.range(cfg.pithMin, cfg.pithMax),      // cm below the face
      arch: rng.range(cfg.archMin, cfg.archMax),
      phase: rng.next() * 100,
      centre: rng.range(0.25, 0.75),
      hue: rng.range(-cfg.hueJitter, cfg.hueJitter),
      sat: rng.range(1 - cfg.satJitter, 1 + cfg.satJitter),
      val: rng.range(1 - cfg.valJitter, 1 + cfg.valJitter),
      flip: rng.bool() ? 1 : -1,
      joint: rng.next(),                              // end-joint position
    });
  }

  // Knots, in texel coordinates, with wrapped distance queries.
  //
  // `phase` is load-bearing and used to be missing. The core's ring pattern
  // reads `kn.phase`, and `undefined * 0.1` is NaN; that NaN went through the
  // colour mix into every texel inside the knot radius, `clamp(NaN, 0, 1)` is
  // NaN, and storing NaN in a Uint8Array writes 0. Every knot in every timber
  // therefore baked as a hard-edged disc of pure black (D5) — which is what a
  // reviewer reported as "desaturated blue dots", because a black hole in the
  // albedo shows nothing but the environment term on top of it. Only the albedo
  // was affected, since nothing else in the bake reads `phase`, which is why the
  // height, roughness and AO around a knot were all correct.
  const knots = [];
  const nKnots = Math.round(cfg.knots);
  for (let i = 0; i < nKnots; i++) {
    knots.push({
      x: rng.next() * size,
      y: rng.next() * size,
      r: (rng.range(cfg.knotMin, cfg.knotMax) / B.world) * size,
      pull: rng.range(0.6, 1.25),
      dark: rng.range(0.62, 1),
      ringF: rng.range(9, 17),
      phase: rng.next() * 100,
      dead: rng.bool(cfg.deadKnot ?? 0.25),
    });
  }

  // Season-to-season variation in the ring, and how the two woods differ in
  // gloss. Defaulted rather than required so the two timbers that do not set
  // them (pine, laminate) keep working unchanged.
  const lateRamp = cfg.lateRamp ?? 0.34;
  const lateVary = cfg.lateVary ?? 0.16;
  const lateGloss = cfg.lateGloss ?? 0.12;
  const earlyRough = cfg.earlyRough ?? 0.06;

  // --- low-frequency fields -------------------------------------------------
  const archCells = Math.max(2, Math.round(cfg.archCells * B.detail));
  const wander = B.field(archCells, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.55), { samples: 6 });
  const patina = B.field(3, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 8 });
  const grainNoise = B.field(Math.max(8, Math.round(cfg.grainCells * B.detail)), (nz) => (x, y) => nz.fbm(x, y, 3, 2.1, 0.5), { samples: 5, seed: 71 });
  // Fibre and ray flecks run across the grain: long in u, thin in v.
  const fibreV = Math.round(clamp(cfg.fibreCells * B.detail, 8, size / 3.2));
  const fibre = B.aniso(Math.max(3, Math.round(fibreV * 0.16)), fibreV, (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 4, seed: 913 });

  const early = cfg.early, late = cfg.late, poreCol = cfg.pore, rayCol = cfg.ray, knotCol = cfg.knotColor;
  const col = [0, 0, 0], tmp = [0, 0, 0];

  // Vessels are evaluated per texel (their hard edge is the point), so they
  // cannot be band-limited by the layer machinery. Fade them out by hand once
  // the cells drop below ~3 texels, which is what keeps the draft bake and the
  // low quality tier smooth instead of speckled.
  const poreFade = cfg.pores > 0 ? 1 - smoothstep(size / 3.4, size / 1.9, cfg.poreCellsU) : 0;
  const poresOn = cfg.pores * poreFade;

  // --- main pass ------------------------------------------------------------
  // One ring spans many texels, so the per-ring season hash is memoised on the
  // last (ring, plank) pair rather than evaluated per texel: a scanline crosses
  // a few dozen rings, not a few thousand.
  const invSize = 1 / size;
  let lastRing = -1e9, lastPlank = -1, lateStart = 0, lateEnd = 1, seam = 1;
  for (let y = 0, i = 0; y < size; y++) {
    const v = y * invSize;
    for (let x = 0; x < size; x++, i++) {
      const u = x * invSize;
      const pf = u * planks;
      let pi = Math.floor(pf);
      if (pi >= planks) pi = planks - 1;
      const pu = pf - pi;
      const pk = P[pi];

      // Distance across the board from its virtual pith, in centimetres.
      let across = (pu - pk.centre) * plankW * pk.flip;
      let along = v * B.world;

      // Knot warp: push the grain coordinates radially outward and stretch
      // them along the trunk, which is what makes rings sweep around a knot.
      let knotIn = 0, knotRing = 0, knotCore = 0, knotDark = 1, knotDead = 0;
      for (let k = 0; k < knots.length; k++) {
        const kn = knots[k];
        let dx = x - kn.x, dy = y - kn.y;
        if (dx > size * 0.5) dx -= size; else if (dx < -size * 0.5) dx += size;
        if (dy > size * 0.5) dy -= size; else if (dy < -size * 0.5) dy += size;
        const d = Math.sqrt(dx * dx + dy * dy);
        const reach = kn.r * 4.2;
        if (d > reach) continue;
        const f = 1 - smoothstep(0, reach, d);
        const push = kn.pull * f * f * kn.r * (B.world / size);
        const invd = d > 1e-4 ? 1 / d : 0;
        across += dx * invd * push * 0.55;
        along += dy * invd * push * 1.6;
        if (d < kn.r) {
          const cIn = 1 - smoothstep(kn.r * 0.72, kn.r, d);
          // Take the strongest knot outright rather than mixing traits from two
          // overlapping ones, so a knot's own darkness and its own ring phase
          // stay together.
          if (cIn > knotCore) {
            knotCore = cIn;
            knotRing = fract((d / kn.r) * kn.ringF + kn.phase);
            knotDark = kn.dark;
            knotDead = kn.dead ? 1 : 0;
          }
        }
        knotIn = Math.max(knotIn, f);
      }

      const wob = wander[i];
      const depth = Math.max(0.25, pk.pith + pk.arch * wob + cfg.depthDrift * Math.sin(along * 0.09 + pk.phase));
      const ringR = Math.sqrt(across * across + depth * depth);
      let ringPos = ringR * cfg.ringsPerCm + pk.phase + grainNoise[i] * cfg.ringJitter;

      // Per-ring season. No two consecutive growth rings in real timber put the
      // same share of themselves into latewood, and drawing them all the same
      // width is most of why procedural wood reads as printed vinyl: the eye
      // picks up a constant-width contour loop instantly. Hashing the ring index
      // (with the plank folded in, so two planks never share a season) moves
      // both the start and the end of the dark band from ring to ring.
      const ringId = Math.floor(ringPos);
      if (ringId !== lastRing || pi !== lastPlank) {
        lastRing = ringId; lastPlank = pi;
        const rh = hash2i(ringId, pi, B.seed ^ 0x71c05) / 4294967296;
        const rh2 = hash2i(ringId, pi + 977, B.seed ^ 0x71c05) / 4294967296;
        lateStart = cfg.lateStart + (rh - 0.5) * lateVary;
        lateEnd = Math.min(0.99, cfg.lateEnd + (rh2 - 0.5) * lateVary * 0.6);
        seam = Math.max(0.04, lateEnd - lateStart);
      }

      const band = fract(ringPos);
      // Latewood: the dense, dark late-season band. Density does not step — it
      // climbs through the growing season and falls off a cliff at the ring
      // boundary — so the band is authored as two components rather than one
      // plateau with two hard sides. `ramp` is the seasonal climb and carries
      // the tone *inside* the band and the shading either side of it; `core` is
      // the narrow dense fibre that carries the edge, and therefore nearly all
      // of the derived normal. Separating them is what lets the band be soft to
      // look at and still sharp enough to show relief.
      const ramp = smoothstep(lateStart - lateRamp, lateEnd, band);
      const core = smoothstep(lateStart, lateStart + seam * 0.34, band)
        * (1 - smoothstep(lateEnd - seam * 0.30, lateEnd, band));
      const lateW = clamp(ramp * 0.42 + core * 0.66, 0, 1);
      // The densest fibre sits at the outer edge of the band. That gradient is
      // why real latewood has a sheen across it instead of being a flat stripe.
      const lateCore = core * smoothstep(lateStart, lateEnd, band);

      // Earlywood pore band sits immediately after the ring boundary.
      const earlyBand = 1 - smoothstep(0.0, cfg.poreBand, band);

      mixC(early, late, lateW, col);

      // Medullary rays: thin lenticular flecks running across the grain. They
      // only show where the cut is close to quarter-sawn, i.e. near the edges
      // of a flat-sawn board where the rings stand up.
      let rayW = 0;
      if (cfg.rays > 0) {
        const quarter = smoothstep(0.22, 0.78, Math.abs(pu - pk.centre) * 2);
        const rv = fibre[i];
        rayW = smoothstep(0.34, 0.62, rv) * quarter * cfg.rays;
        if (rayW > 0) mixC(col, rayCol, rayW * 0.85, col);
      }

      // Ring-porous vessels: the open pipes that make oak feel like oak.
      let poreW = 0;
      if (poresOn > 0.004) {
        const pn = poreField(B, x, y, cfg);
        poreW = pn * earlyBand * poresOn;
        if (poreW > 0) mixC(col, poreCol, poreW * 0.9, col);
      }

      // Knot colouring on top of everything. A live knot is resinous and only a
      // little darker than the board around it; a dead one is a near-black plug
      // ringed with bark. `cfg.deadKnot` is a *probability*, so the old test
      // against it was true for every timber and every knot came out dead —
      // the per-knot flag rolled from it is the one that means anything. The
      // mix is capped short of 1 as well: a knot is figure, not a hole.
      if (knotCore > 0) {
        const kc = knotCore * knotDark * (knotDead ? 0.92 : 0.60);
        mixC(col, knotCol, clamp(kc * (0.5 + 0.5 * knotRing), 0, 0.94), col);
      } else if (knotIn > 0) {
        mixC(col, knotCol, knotIn * knotIn * 0.28, col);
      }

      // Plank identity + slow patina.
      tint(tmp, col[0], col[1], col[2], pk.hue, pk.sat, pk.val * (1 + patina[i] * cfg.patina));
      let cr = tmp[0], cg = tmp[1], cb = tmp[2];

      // Plank joints: a recessed chamfer plus a dark shadow gap.
      const edge = Math.min(pu, 1 - pu);
      const jointW = cfg.jointWidth / plankW;
      const joint = 1 - smoothstep(0, jointW, edge);
      // Staggered end joints so planks do not read as full-length strips.
      const endPhase = fract(v + pk.joint);
      const endJoint = (1 - smoothstep(0, jointW * 0.55, Math.min(endPhase, 1 - endPhase))) * cfg.endJoints;

      const jj = Math.max(joint, endJoint);
      cr *= 1 - jj * 0.62; cg *= 1 - jj * 0.62; cb *= 1 - jj * 0.62;

      // --- height ---------------------------------------------------------
      // Latewood stands proud on a sanded board (earlywood abrades faster),
      // pores sink, rays sit fractionally high, joints are a groove.
      //
      // These amplitudes were roughly doubled after measuring the derived
      // normal map: 60% of the oak tile encoded to the flat normal exactly, and
      // the mean slope over the whole tile was 1.9 degrees against 2.6 for
      // concrete. The grain was physically honest and visually absent, which is
      // the other half of the "printed vinyl" read — a picture of wood with no
      // surface under it.
      //
      // The weight goes on `lateCore`, not on `lateW`, because `lateW` carries
      // the wide seasonal ramp: height there produces long smooth swells across
      // the board — dunes, not grain — which raise the mean-slope statistic and
      // look like melted plastic in a close-up. `lateCore` is the narrow dense
      // fibre, so the same height there becomes actual slope.
      let hh = 0.5
        + lateW * 0.15
        + lateCore * 0.26
        - poreW * 0.46
        + rayW * 0.08
        + fibre[i] * 0.10
        + grainNoise[i] * 0.05
        - jj * 0.55
        - knotCore * 0.16 * (knotDead ? 1 : 0.45);

      // --- roughness ------------------------------------------------------
      // Earlywood and latewood are different substances, not one substance in
      // two colours: the dense late fibre takes a polish and the open early
      // fibre scatters. Without that split the whole board returns one lobe
      // width and the grain can only ever be a printed pattern.
      let rr = cfg.rough
        - lateW * lateGloss
        - lateCore * lateGloss * 0.5
        + earlyBand * earlyRough
        + poreW * 0.30
        - rayW * 0.12
        + patina[i] * 0.05
        + jj * 0.12;

      B.r[i] = cr; B.g[i] = cg; B.b[i] = cb;
      B.h[i] = hh;
      B.rough[i] = rr;
    }
  }

  B.give(wander); B.give(patina); B.give(grainNoise); B.give(fibre);

  // Surface wear: fine scuffs and a few deeper scratches. Applied after the
  // grain so it reads as damage *to* the finish rather than part of it.
  // Scratch width is in texels, so it has to be tied to the bake resolution or
  // a 2048 bake would draw them at half the physical width of a 1024 one. At
  // size/620 a scratch is ~0.1 mm across on a 60 cm tile: fine, but still two
  // or three texels wide, which is the narrowest a feature can be and survive
  // the mip chain as anything other than noise.
  if (cfg.wear > 0) addScratches(B, {
    count: Math.round(cfg.wear * 130),
    lenMin: size * 0.02, lenMax: size * 0.16,
    width: size / 620, depth: 0.05, rough: 0.10, bright: 0.05, seed: 4411,
  });

  return { planks, knots };
}

/**
 * Anisotropic tileable Worley.
 *
 * core/Random.js wraps both axes on a single period, which is no use when the
 * cells must be stretched (wood vessels, felt nap, brushed metal). This wraps
 * each axis on its own integer period, so the field is exactly periodic on a
 * cu x cv lattice while the cells themselves are long and thin.
 *
 * @returns {number} distance to the nearest feature point, in cell units
 */
function worleyAniso(x, y, cu, cv, seed, jitter = 0.95) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      let hx = cx % cu; if (hx < 0) hx += cu;
      let hy = cy % cv; if (hy < 0) hy += cv;
      const h = hash2i(hx, hy, seed);
      const px = cx + 0.5 + ((h & 0xffff) / 65536 - 0.5) * jitter;
      const py = cy + 0.5 + (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < f1) f1 = d;
    }
  }
  return Math.sqrt(f1);
}

/** Elongated pore field: vessels are long pipes, so the cells are stretched
 *  hard along the grain. Evaluated at full resolution because the sharp edge
 *  is the whole point. */
function poreField(B, x, y, cfg) {
  const size = B.size;
  const cu = cfg.poreCellsU;
  const cv = Math.max(1, Math.round(cfg.poreCellsU / cfg.poreStretch));
  const f = worleyAniso((x / size) * cu, (y / size) * cv, cu, cv, B.seed ^ 0x2b17);
  return 1 - smoothstep(cfg.poreSize * 0.45, cfg.poreSize, f);
}

/** Fine scratch pass shared by wood, plastic, metal and lino. */
function addScratches(B, o) {
  const rng = makeRng((B.seed ^ 0x51ab00) + (o.seed | 0));
  const size = B.size;
  const dirBias = o.dirBias ?? 0;
  for (let s = 0; s < o.count; s++) {
    const len = rng.range(o.lenMin, o.lenMax);
    const a = o.arc
      ? o.arc.centreAngle + rng.range(-0.6, 0.6)
      : (dirBias ? rng.gauss(o.dir ?? 0, dirBias) : rng.next() * Math.PI * 2);
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
    const w = Math.max(0.55, o.width * rng.range(0.6, 1.8));
    const strength = rng.range(0.35, 1);
    rasterCapsule(B, x0, y0, x1, y1, w, 0.7, (i, t, sAcross, cov) => {
      const taper = Math.sin(Math.PI * t);
      const k = cov * strength * taper;
      B.h[i] -= o.depth * k;
      B.rough[i] += o.rough * k;
      if (o.bright) {
        B.r[i] = clamp(B.r[i] + o.bright * k, 0, 1);
        B.g[i] = clamp(B.g[i] + o.bright * k, 0, 1);
        B.b[i] = clamp(B.b[i] + o.bright * k, 0, 1);
      }
    });
  }
}

/** Elliptical fingerprint whorls. Roughness only — a print does not change the
 *  colour of a varnish, it changes how it scatters. */
function addFingerprints(B, count, strength, seedOff) {
  const rng = makeRng((B.seed ^ 0x1f9e) + seedOff);
  const size = B.size;
  for (let p = 0; p < count; p++) {
    const cx = rng.next() * size, cy = rng.next() * size;
    const rx = size * rng.range(0.035, 0.065);
    const ry = rx * rng.range(1.25, 1.7);
    const rot = rng.next() * Math.PI;
    const ca = Math.cos(rot), sa = Math.sin(rot);
    const freq = rng.range(48, 78);
    const swirl = rng.range(0.6, 1.6) * (rng.bool() ? 1 : -1);
    const amp = strength * rng.range(0.6, 1);
    const pad = Math.ceil(ry + 2);
    for (let yy = Math.floor(cy - pad); yy <= Math.ceil(cy + pad); yy++) {
      let wy = yy % size; if (wy < 0) wy += size;
      const row = wy * size;
      for (let xx = Math.floor(cx - pad); xx <= Math.ceil(cx + pad); xx++) {
        const dx = xx - cx, dy = yy - cy;
        const lx = (dx * ca + dy * sa) / rx;
        const ly = (-dx * sa + dy * ca) / ry;
        const d = Math.sqrt(lx * lx + ly * ly);
        if (d > 1) continue;
        let wx = xx % size; if (wx < 0) wx += size;
        const i = row + wx;
        const ang = Math.atan2(ly, lx);
        const ridge = Math.sin(d * freq + ang * swirl + Math.sin(ang * 3) * 0.8);
        const fade = 1 - smoothstep(0.55, 1, d);
        const k = amp * fade * (0.5 + 0.5 * ridge);
        B.rough[i] = clamp(B.rough[i] + k, 0.02, 1);
        B.h[i] += k * 0.012;
      }
    }
  }
}

/* ---------------------------------------------------------------- surfaces */

// Grain frequency is set by what the camera can resolve, not by botany.
//
// A 60 cm tile at 210 fibre cells and 300 pore cells puts features at 2.9 mm
// and 2.0 mm. In a gameplay frame the far half of the table runs at roughly one
// screen pixel per two millimetres, so those features land at or under Nyquist,
// and everything they touch — albedo, the derived normal, the roughness — turns
// into per-pixel noise that the specular lobe then amplifies into colour
// fringing. At 96 and 150 the same figure sits at 6.2 mm and 4.0 mm: still
// clearly oak in a close-up, still four to six texels wide at 1024, and it
// survives minification as grain rather than as sparkle.
GEN.oak = (B) => {
  woodBase(B, {
    planks: 5, ringsPerCm: 1.35, ringJitter: 0.30, archCells: 5,
    pithMin: 1.6, pithMax: 5.5, archMin: 0.8, archMax: 2.6, depthDrift: 0.35,
    lateStart: 0.58, lateEnd: 0.94, poreBand: 0.30,
    // Oak's ring boundary is the most abrupt of the four timbers, so its dense
    // core stays narrow; the seasonal ramp ahead of it is what carries the tone.
    lateRamp: 0.30, lateVary: 0.19, lateGloss: 0.13, earlyRough: 0.07,
    grainCells: 26, fibreCells: 96,
    early: rgb('#c39764'), late: rgb('#8d5f30'), pore: rgb('#4d3118'),
    ray: rgb('#dcb987'), knotColor: rgb('#503016'),
    rays: 0.85, pores: 1, poreCellsU: 150, poreStretch: 6, poreSize: 0.40,
    knots: 3, knotMin: 0.7, knotMax: 2.4, deadKnot: 0.2,
    hueJitter: 4, satJitter: 0.10, valJitter: 0.07, patina: 0.10,
    // Bare oak is not a semi-gloss surface. 0.44 was glossy enough that at
    // grazing incidence, where Fresnel drives reflectance towards 1 whatever the
    // base colour, the board returned a recognisable image of the sky instead of
    // a broad sheen. 0.62 is where a sanded, unfinished board actually sits.
    jointWidth: 0.09, endJoints: 0.7, rough: 0.62, wear: 0.9,
  });
};

GEN.pine = (B) => {
  woodBase(B, {
    planks: 4, ringsPerCm: 0.85, ringJitter: 0.26, archCells: 4,
    pithMin: 1.2, pithMax: 4.2, archMin: 1.0, archMax: 3.1, depthDrift: 0.5,
    lateStart: 0.66, lateEnd: 0.97, poreBand: 0.16,
    grainCells: 20, fibreCells: 88,
    early: rgb('#e6cfa4'), late: rgb('#a9682f'), pore: rgb('#7a4c22'),
    ray: rgb('#f0dcb6'), knotColor: rgb('#5c3512'),
    rays: 0.10, pores: 0.25, poreCellsU: 128, poreStretch: 8, poreSize: 0.30,
    knots: 7, knotMin: 0.6, knotMax: 3.0, deadKnot: 0.4,
    hueJitter: 5, satJitter: 0.13, valJitter: 0.09, patina: 0.12,
    jointWidth: 0.11, endJoints: 0.55, rough: 0.56, wear: 1.2,
  });

  // Resin streaks bleeding out of the knots: amber, glossy, slightly proud.
  const rng = makeRng(B.seed ^ 0x7e51);
  const size = B.size;
  const amber = rgb('#c8873a');
  for (let s = 0; s < 26; s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const a = rng.gauss(Math.PI * 0.5, 0.35);
    const len = size * rng.range(0.05, 0.22);
    rasterCapsule(B, x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len,
      size * rng.range(0.004, 0.011), size * 0.006, (i, t, sA, cov) => {
        const k = cov * Math.sin(Math.PI * t) * 0.55;
        B.r[i] = lerp(B.r[i], amber[0], k);
        B.g[i] = lerp(B.g[i], amber[1], k);
        B.b[i] = lerp(B.b[i], amber[2], k);
        B.rough[i] = lerp(B.rough[i], 0.22, k);
        B.h[i] += k * 0.03;
      });
  }
};

// This is the racing surface. It covers most of the lap on the kitchen table,
// the chase camera looks straight down it, and — because a car sits 2 cm above
// a horizontal plane — it is seen almost entirely at grazing incidence. That
// makes it the one material in the library where the *grazing* response, not
// the head-on response, is what the game actually looks like.
//
// The palette below is deliberately a mid walnut rather than the near-black one
// it used to be. A dark albedo does not read as dark wood at a grazing angle:
// it reads as whatever the specular term is reflecting, because the specular is
// an additive constant and the albedo is what has to out-vote it. Measured on
// the road ribbon, the old bake went from blue-red 16 apart (warm) at the
// camera's feet to 7 apart the *other* way (blue) at the horizon — the wood
// colour simply lost.
GEN.varnishedWood = (B) => {
  woodBase(B, {
    planks: 3, ringsPerCm: 2.1, ringJitter: 0.34, archCells: 6,
    pithMin: 2.2, pithMax: 7.0, archMin: 0.6, archMax: 2.0, depthDrift: 0.25,
    lateStart: 0.62, lateEnd: 0.95, poreBand: 0.26,
    // A film finish evens the gloss out, so the early/late split is smaller
    // here than on the bare board next to it — but not zero, and that residual
    // difference is what stops the varnish reading as a sheet of laminate.
    lateRamp: 0.36, lateVary: 0.17, lateGloss: 0.07, earlyRough: 0.045,
    grainCells: 32, fibreCells: 112,
    early: rgb('#8a5c34'), late: rgb('#57371c'), pore: rgb('#33200f'),
    ray: rgb('#a5754a'), knotColor: rgb('#40270f'),
    rays: 0.35, pores: 0.55, poreCellsU: 152, poreStretch: 7, poreSize: 0.34,
    knots: 1, knotMin: 0.6, knotMax: 1.6, deadKnot: 0.1,
    hueJitter: 3, satJitter: 0.08, valJitter: 0.06, patina: 0.07,
    jointWidth: 0.05, endJoints: 0.25, rough: 0.10, wear: 0.35,
  });

  const { size, n } = B;
  // The varnish wets the timber: deeper and more saturated. It does *not* fill
  // the grain flat — a wiped varnish is an open-pore finish and the pores stay
  // visible as depressions, which at 0.18 retention they did not: the derived
  // normal came out with a peak slope of 3 degrees across the whole tile, i.e.
  // a mirror-flat plane with a picture of wood on it.
  const tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    tint(tmp, B.r[i], B.g[i], B.b[i], 2, 1.14, 0.99);
    B.r[i] = tmp[0]; B.g[i] = tmp[1]; B.b[i] = tmp[2];
    B.h[i] = 0.5 + (B.h[i] - 0.5) * 0.45;
    // Satin, and a long way from a mirror. This is the grazing-angle clamp:
    // three's split-sum DFG approximation returns about 63% of the environment
    // radiance at grazing incidence for roughness 0.16 and about 29% at the
    // 0.33 this now bakes to, so widening the lobe removes more than half the
    // reflected sky from the surface that fills the frame. A ten-year-old
    // kitchen table that has had plates dragged across it every day sits here
    // anyway; the old 0.16 floor was a showroom finish nobody owns.
    B.rough[i] = clamp(0.34 + (B.rough[i] - 0.10) * 0.55, 0.29, 0.78);
  }

  // Orange peel: the long-wavelength ripple every sprayed finish has.
  const peel = B.field(Math.round(clamp(size / 26, 6, size / 5)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 6, seed: 33 });
  for (let i = 0; i < n; i++) B.h[i] += peel[i] * 0.50;
  B.give(peel);

  // Airborne dust caught in the coat, then handled: prints and fine swirls.
  const dust = scatterPoints(B, Math.round(size * 0.9), 5501);
  const drng = makeRng(B.seed ^ 0x0dabb);
  for (let p = 0; p < dust.length; p += 2) {
    const r = drng.range(0.6, 2.0);
    rasterDisc(B, dust[p], dust[p + 1], r, 0.8, (i, d, cov) => {
      B.rough[i] = clamp(B.rough[i] + 0.30 * cov, 0.03, 1);
      B.h[i] += 0.10 * cov;
      B.r[i] = clamp(B.r[i] + 0.05 * cov, 0, 1);
      B.g[i] = clamp(B.g[i] + 0.05 * cov, 0, 1);
      B.b[i] = clamp(B.b[i] + 0.045 * cov, 0, 1);
    });
  }
  addFingerprints(B, 4, 0.16, 22);
  addScratches(B, { count: 90, lenMin: size * 0.01, lenMax: size * 0.07, width: size / 1500, depth: 0.02, rough: 0.16, bright: 0.02, seed: 7 });
};

GEN.laminate = (B) => {
  // Laminate is a photograph of timber under a lacquer whose embossing does
  // *not* line up with the print. That mismatch is the entire visual tell, so
  // we bake the print first, flatten its relief, then emboss separately.
  woodBase(B, {
    planks: 2, ringsPerCm: 1.15, ringJitter: 0.28, archCells: 5,
    pithMin: 1.8, pithMax: 5.0, archMin: 0.9, archMax: 2.4, depthDrift: 0.3,
    lateStart: 0.60, lateEnd: 0.94, poreBand: 0.26,
    grainCells: 22, fibreCells: 104,
    early: rgb('#cba372'), late: rgb('#9a6d3c'), pore: rgb('#6a4522'),
    ray: rgb('#dfc296'), knotColor: rgb('#553318'),
    rays: 0.25, pores: 0.35, poreCellsU: 148, poreStretch: 6, poreSize: 0.34,
    knots: 2, knotMin: 0.7, knotMax: 2.0, deadKnot: 0.15,
    hueJitter: 2, satJitter: 0.06, valJitter: 0.05, patina: 0.06,
    jointWidth: 0.10, endJoints: 0.9, rough: 0.30, wear: 0.5,
  });

  const { size, n } = B;
  // The print is a photograph: it has no relief of its own.
  for (let i = 0; i < n; i++) B.h[i] = 0.5;

  // Registered emboss, deliberately out of phase with the print.
  const embossCells = Math.round(clamp(size / 5.5, 24, size / 3.4));
  const emb = B.aniso(Math.max(4, Math.round(embossCells * 0.14)), embossCells, (nz) => (x, y) => nz.fbm(x, y, 3, 2.2, 0.5), { samples: 4, seed: 4242 });
  const embLowV = Math.round(clamp(size / 34, 8, size / 8));
  const embLow = B.aniso(Math.max(3, Math.round(embLowV * 0.2)), embLowV, (nz) => (x, y) => nz.ridged(x, y, 3, 2, 0.5, 2.4), { samples: 6, seed: 91 });
  for (let i = 0; i < n; i++) {
    B.h[i] = 0.5 + emb[i] * 0.30 + (embLow[i] - 0.35) * 0.36;
    B.rough[i] = clamp(0.28 + emb[i] * 0.06 + (embLow[i] - 0.4) * 0.10, 0.16, 0.5);
  }
  B.give(emb); B.give(embLow);

  // Bevelled plank edges: a real V-groove that catches the key light.
  const planks = 2, rows = 4;
  const bevel = size * 0.006;
  for (let y = 0, i = 0; y < size; y++) {
    const v = y / size;
    const rowPhase = fract(v * rows);
    const rowEdge = Math.min(rowPhase, 1 - rowPhase) * size / rows;
    for (let x = 0; x < size; x++, i++) {
      const u = x / size;
      const colPhase = fract(u * planks);
      const colEdge = Math.min(colPhase, 1 - colPhase) * size / planks;
      const e = Math.min(colEdge, rowEdge);
      if (e < bevel * 2.2) {
        const k = 1 - smoothstep(0, bevel * 2.2, e);
        B.h[i] -= k * k * 0.6;
        B.rough[i] = clamp(B.rough[i] + k * 0.10, 0, 1);
        B.r[i] *= 1 - k * 0.30; B.g[i] *= 1 - k * 0.30; B.b[i] *= 1 - k * 0.30;
      }
    }
  }
  addScratches(B, { count: 140, lenMin: size * 0.015, lenMax: size * 0.12, width: size / 1400, depth: 0.05, rough: 0.14, bright: 0.03, seed: 61 });
};

GEN.poolFelt = (B) => {
  const { size, n } = B;
  // Baize: worsted wool with a very fine directional nap. Everything is
  // stretched hard along the nap axis; the specular anisotropy in Materials
  // finishes the job.
  const napCells = Math.round(clamp(size / 2.6, 40, size / 2.4));
  const nap = B.aniso(napCells, Math.max(4, Math.round(napCells * 0.055)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 4, seed: 11 });
  const nap2V = Math.round(clamp(size / 9, 20, size / 5));
  const nap2 = B.aniso(nap2V, Math.max(3, Math.round(nap2V * 0.10)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 4, seed: 12 });
  const brush = B.aniso(3, 7, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 10, seed: 13 });
  const cloud = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 14 });

  const base = rgb('#1d6b3c');
  const dark = rgb('#134a2a');
  const light = rgb('#2f8c52');
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const f = nap[i] * 0.6 + nap2[i] * 0.4;
    const t = saturate(0.5 + f * 0.9);
    mixC(dark, light, t, col);
    const shade = 1 + brush[i] * 0.10 + cloud[i] * 0.06;
    B.r[i] = clamp(lerp(base[0], col[0], 0.85) * shade, 0, 1);
    B.g[i] = clamp(lerp(base[1], col[1], 0.85) * shade, 0, 1);
    B.b[i] = clamp(lerp(base[2], col[2], 0.85) * shade, 0, 1);
    B.h[i] = 0.5 + f * 0.45 + brush[i] * 0.10;
    B.rough[i] = clamp(0.72 - f * 0.06 + brush[i] * 0.05, 0.55, 0.9);
  }
  B.give(nap); B.give(nap2); B.give(brush); B.give(cloud);

  // Loose fibres lying on the surface, plus cue chalk dust.
  const rng = makeRng(B.seed ^ 0xfe17);
  for (let s = 0; s < Math.round(size * 0.55); s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const a = rng.gauss(0, 0.30);
    const len = size * rng.range(0.004, 0.018);
    rasterCapsule(B, x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, 0.65, 0.6, (i, t, sA, cov) => {
      const k = cov * 0.5;
      B.h[i] += k * 0.10;
      B.r[i] = clamp(B.r[i] + k * 0.07, 0, 1);
      B.g[i] = clamp(B.g[i] + k * 0.10, 0, 1);
      B.b[i] = clamp(B.b[i] + k * 0.07, 0, 1);
    });
  }
  const chalk = scatterPoints(B, Math.round(size * 0.35), 88);
  const crng = makeRng(B.seed ^ 0x0c4a1);
  for (let p = 0; p < chalk.length; p += 2) {
    if (!crng.bool(0.35)) continue;
    rasterDisc(B, chalk[p], chalk[p + 1], crng.range(0.7, 2.2), 0.9, (i, d, cov) => {
      const k = cov * 0.45;
      B.r[i] = clamp(B.r[i] + k * 0.22, 0, 1);
      B.g[i] = clamp(B.g[i] + k * 0.26, 0, 1);
      B.b[i] = clamp(B.b[i] + k * 0.30, 0, 1);
      B.rough[i] = clamp(B.rough[i] + k * 0.15, 0, 1);
    });
  }
};

GEN.carpet = (B) => {
  const { size, n } = B;
  const tuftWorld = 0.55;                              // cm between tufts
  const cols = Math.max(6, Math.round(B.world / tuftWorld));
  const cw = size / cols;
  const rng = makeRng(B.seed ^ 0xca97);

  // Heather yarn: carpet is never one colour, it is three plied together.
  const pal = [rgb('#a8967c'), rgb('#8d7b62'), rgb('#c3b499'), rgb('#6f6152')];
  const backing = rgb('#3a3128');

  const vac = B.aniso(2, 5, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 12, seed: 5 });
  const blotch = B.field(3, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 6 });

  for (let i = 0; i < n; i++) {
    B.r[i] = backing[0]; B.g[i] = backing[1]; B.b[i] = backing[2];
    B.h[i] = 0.06;
    B.rough[i] = 0.95;
  }

  const zbuf = new Float32Array(n);
  const col = [0, 0, 0];
  for (let cy = 0; cy < cols; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const jx = (cx + 0.5 + (rng.next() - 0.5) * 0.9) * cw;
      const jy = (cy + 0.5 + (rng.next() - 0.5) * 0.9) * cw;
      const r = cw * rng.range(0.44, 0.66);
      const top = rng.range(0.55, 1);
      const cA = pal[rng.int(0, pal.length - 1)];
      const cB = pal[rng.int(0, pal.length - 1)];
      const twist = rng.next() * Math.PI;
      const shade = rng.range(0.82, 1.14);
      rasterDisc(B, jx, jy, r, 0.9, (i, d, cov, nx, ny) => {
        // Rounded fibre bundle; the dome is what gives carpet its soft AO.
        const dome = Math.sqrt(Math.max(0, 1 - d * d));
        const hgt = 0.10 + top * dome * 0.9;
        if (hgt <= zbuf[i]) return;
        zbuf[i] = hgt;
        // Ply twist: two yarn colours spiralling around the tuft.
        const ang = Math.atan2(ny, nx) + twist;
        const ply = 0.5 + 0.5 * Math.sin(ang * 3 + d * 6);
        mixC(cA, cB, ply, col);
        const k = cov;
        const lit = shade * (0.68 + 0.42 * dome);
        B.r[i] = lerp(B.r[i], clamp(col[0] * lit, 0, 1), k);
        B.g[i] = lerp(B.g[i], clamp(col[1] * lit, 0, 1), k);
        B.b[i] = lerp(B.b[i], clamp(col[2] * lit, 0, 1), k);
        B.h[i] = lerp(B.h[i], hgt, k);
        B.rough[i] = lerp(B.rough[i], 0.88 - dome * 0.06, k);
      });
    }
  }

  for (let i = 0; i < n; i++) {
    const v = 1 + vac[i] * 0.09 + blotch[i] * 0.05;
    B.r[i] = clamp(B.r[i] * v, 0, 1);
    B.g[i] = clamp(B.g[i] * v, 0, 1);
    B.b[i] = clamp(B.b[i] * v, 0, 1);
  }
  B.give(vac); B.give(blotch);
  B.aoStrength = 1.5;
};

GEN.rug = (B) => {
  const { size, n } = B;
  // Flat-woven kilim: warp threads run along v, weft across, interlacing
  // one-over-one. The motif is a mirrored diamond field so it reads as woven
  // design rather than printed noise.
  // Thread pitch is clamped so a thread is never thinner than ~6 texels; below
  // that the interlacing turns into moire instead of weave.
  const threads = Math.round(clamp(B.world / 0.22, 8, size / 6));
  const tw = size / threads;
  const motifN = 16;

  const rng = makeRng(B.seed ^ 0x2fa9);
  const palette = [
    rgb('#8f2c22'), rgb('#c98a3c'), rgb('#20303f'),
    rgb('#d8c8a6'), rgb('#3d5c4a'), rgb('#6d2340'),
  ];
  // Symmetric motif grid: quarter authored, mirrored twice.
  const motif = new Uint8Array(motifN * motifN);
  const half = motifN >> 1;
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const d = Math.abs(x - y);
      let idx;
      if (d === 0) idx = 0;
      else if ((x + y) % 5 === 0) idx = 1;
      else if (d < 2) idx = 4;
      else idx = ((x * 3 + y * 5) % 7 < 2) ? 2 : 3;
      if (rng.bool(0.12)) idx = 5;
      motif[y * motifN + x] = idx;
      motif[y * motifN + (motifN - 1 - x)] = idx;
      motif[(motifN - 1 - y) * motifN + x] = idx;
      motif[(motifN - 1 - y) * motifN + (motifN - 1 - x)] = idx;
    }
  }

  const wear = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 3 });
  const fuzz = B.field(Math.round(clamp(size / 3, 32, size / 2.6)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 3, full: true, seed: 4 });

  for (let y = 0, i = 0; y < size; y++) {
    const ty = y / tw;
    const iy = Math.floor(ty), fy = ty - iy;
    for (let x = 0; x < size; x++, i++) {
      const tx = x / tw;
      const ix = Math.floor(tx), fx = tx - ix;
      const over = ((ix + iy) & 1) === 0;   // warp on top

      const mx = Math.floor((x / size) * motifN) % motifN;
      const my = Math.floor((y / size) * motifN) % motifN;
      const c = palette[motif[my * motifN + mx]];

      // Rounded thread cross-section: the "over" thread is fully round, the
      // "under" one is clipped by its neighbour and sits lower.
      const across = over ? fx : fy;
      const round = Math.sin(Math.PI * clamp(across, 0, 1));
      const hgt = over ? 0.32 + round * 0.62 : 0.10 + round * 0.30;
      const lit = 0.70 + 0.42 * round * (over ? 1 : 0.7);

      const w = 1 - wear[i] * 0.16;
      B.r[i] = clamp(c[0] * lit * w, 0, 1);
      B.g[i] = clamp(c[1] * lit * w, 0, 1);
      B.b[i] = clamp(c[2] * lit * w, 0, 1);
      B.h[i] = hgt + fuzz[i] * 0.10;
      B.rough[i] = clamp(0.80 - round * 0.05 + fuzz[i] * 0.06, 0.6, 0.95);
    }
  }
  B.give(wear); B.give(fuzz);
  B.aoStrength = 1.25;
};

GEN.sand = (B) => {
  const { size, n } = B;
  // Three things make sand read as sand and not as beige noise: discrete
  // grains, asymmetric wind ripples, and the fact that individual mineral
  // grains are different colours.
  const grainCells = Math.round(clamp(B.world / 0.055, 40, size / 3.6));
  const grains = B.layer(grainCells, (x, y) => worleyFbm2D(x, y, 3, 2.1, 0.5, B.seed ^ 0x91, grainCells), { full: true });
  const midCells = Math.round(clamp(B.world / 0.9, 8, size / 8));
  const mid = B.field(midCells, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 5, seed: 2 });
  const drift = B.field(6, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.55), { samples: 10, seed: 3 });

  // Ripple crests roughly every 4 cm, meandering, and skewed: gentle windward
  // face, steep slip face. A pure sine here is the single biggest tell.
  const rippleCells = Math.max(2, Math.round(B.world / 4.2));
  const rippleWarp = B.field(5, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 10, seed: 4 });

  const dry = rgb('#dcc79c');
  const damp = rgb('#a8895f');
  const pale = rgb('#efe2c4');
  const col = [0, 0, 0], tmp = [0, 0, 0];

  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const phase = fract((y * inv) * rippleCells + rippleWarp[i] * 0.55);
      const rip = phase < 0.72 ? phase / 0.72 : 1 - (phase - 0.72) / 0.28;
      const ripS = rip * rip * (3 - 2 * rip);

      const gr = 1 - grains[i];
      const shade = 0.5 + drift[i] * 0.5;

      mixC(dry, pale, saturate(gr * 1.4 - 0.15), col);
      mixC(col, damp, saturate(0.28 - shade * 0.35 + (1 - ripS) * 0.18), col);

      // Per-grain mineral tint: a scatter of darker iron and glassy quartz.
      const cellHash = hash2i((x * grainCells / size) | 0, (y * grainCells / size) | 0, B.seed ^ 0x5a) / 4294967296;
      const mineral = cellHash < 0.055 ? -0.42 : cellHash > 0.955 ? 0.28 : 0;
      tint(tmp, col[0], col[1], col[2], mineral * 12, 1 + mineral * 0.5, 1 + mineral * 0.35);

      B.r[i] = tmp[0]; B.g[i] = tmp[1]; B.b[i] = tmp[2];
      B.h[i] = 0.35 + ripS * 0.42 + mid[i] * 0.16 + gr * 0.30;
      B.rough[i] = clamp(0.88 - gr * 0.05 + drift[i] * 0.04, 0.7, 0.98);
    }
  }
  B.give(grains); B.give(mid); B.give(drift); B.give(rippleWarp);

  // A handful of shells and small pebbles sitting proud of the ripples.
  const rng = makeRng(B.seed ^ 0x5eaa);
  const pts = scatterPoints(B, Math.round(size * 0.09), 771);
  const shell = rgb('#efe6d2');
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.5)) continue;
    const r = size * rng.range(0.004, 0.014);
    const c = rng.bool(0.6) ? shell : rgb('#8d7f6b');
    const lobe = { amp: 0.28, k1: rng.int(2, 4), k2: rng.int(5, 8), p1: rng.next() * 6.28, p2: rng.next() * 6.28 };
    rasterDisc(B, pts[p], pts[p + 1], r, 1, (i, d, cov) => {
      const dome = Math.sqrt(Math.max(0, 1 - d * d));
      const k = cov;
      B.r[i] = lerp(B.r[i], c[0] * (0.75 + dome * 0.4), k);
      B.g[i] = lerp(B.g[i], c[1] * (0.75 + dome * 0.4), k);
      B.b[i] = lerp(B.b[i], c[2] * (0.75 + dome * 0.4), k);
      B.h[i] = lerp(B.h[i], 0.55 + dome * 0.42, k);
      B.rough[i] = lerp(B.rough[i], 0.55, k);
    }, lobe);
  }
  B.aoStrength = 1.1;
};

GEN.grass = (B) => {
  const { size, n } = B;
  // Mown lawn seen from above. Blades are *rasterised*, not sampled: a gather
  // would need a 9x9 cell search because a blade is longer than the spacing,
  // where a scatter touches each blade's footprint exactly once.
  const soilCol = rgb('#3b2c1c');
  const thatch = rgb('#7a6a3f');
  const greens = [rgb('#4e7d2c'), rgb('#5f9435'), rgb('#3f6a24'), rgb('#78a844'), rgb('#93a856')];
  const dryCol = rgb('#b9a95e');

  const clump = B.field(6, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 1 });
  const bare = B.field(9, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.55), { samples: 8, seed: 2 });
  const mow = B.aniso(2, 4, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 12, seed: 3 });

  for (let i = 0; i < n; i++) {
    const t = saturate(0.35 + clump[i] * 0.8);
    const s = mixC(soilCol, thatch, t);
    const dark = 0.75 + bare[i] * 0.2;
    B.r[i] = s[0] * dark; B.g[i] = s[1] * dark; B.b[i] = s[2] * dark;
    B.h[i] = 0.05 + clump[i] * 0.05;
    B.rough[i] = 0.94;
  }

  const bladeWorld = 0.30;                             // cm between blade roots
  const cols = Math.max(8, Math.round(B.world / bladeWorld));
  const cw = size / cols;
  const bladeLen = (1.15 / B.world) * size;            // ~11 mm of leaf
  const bladeW = Math.max(0.75, (0.085 / B.world) * size);
  const rng = makeRng(B.seed ^ 0x67a55);
  const zbuf = new Float32Array(n);
  const col = [0, 0, 0];

  // Density falls where the noise says the lawn is worn; that patchiness is
  // what stops it reading as a uniform green carpet.
  for (let cy = 0; cy < cols; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bx = (cx + 0.5 + (rng.next() - 0.5) * 1.2) * cw;
      const by = (cy + 0.5 + (rng.next() - 0.5) * 1.2) * cw;
      const bi = (Math.floor(by) % size + size) % size * size + (Math.floor(bx) % size + size) % size;
      const density = 0.45 + clump[bi] * 0.9 - bare[bi] * 0.35;
      if (rng.next() > density) continue;

      // Mowing gives every blade a shared bias; the local noise twists it.
      const ang = mow[bi] * 2.4 + rng.gauss(0, 0.85) + Math.PI * 0.5;
      const len = bladeLen * rng.range(0.55, 1.35);
      const top = rng.range(0.45, 1);
      const dry = rng.bool(0.055);
      const c = dry ? dryCol : greens[rng.int(0, greens.length - 1)];
      const bend = rng.range(-0.35, 0.35);
      const x1 = bx + Math.cos(ang) * len - Math.sin(ang) * bend * len * 0.35;
      const y1 = by + Math.sin(ang) * len + Math.cos(ang) * bend * len * 0.35;
      const shade = rng.range(0.8, 1.18);

      rasterCapsule(B, bx, by, x1, y1, bladeW * rng.range(0.8, 1.4), 0.65, (i, t, sA, cov) => {
        // A blade tapers to a point and its tip catches more light.
        const taper = 1 - t * 0.75;
        if (cov * taper < 0.06) return;
        const hgt = 0.10 + top * (0.28 + t * 0.72);
        if (hgt <= zbuf[i]) return;
        zbuf[i] = hgt;
        const roundness = Math.sqrt(Math.max(0, 1 - sA * sA));
        const lit = shade * (0.55 + 0.55 * roundness) * (0.72 + t * 0.42);
        col[0] = clamp(c[0] * lit, 0, 1);
        col[1] = clamp(c[1] * lit, 0, 1);
        col[2] = clamp(c[2] * lit, 0, 1);
        const k = cov * saturate(taper * 1.4);
        B.r[i] = lerp(B.r[i], col[0], k);
        B.g[i] = lerp(B.g[i], col[1], k);
        B.b[i] = lerp(B.b[i], col[2], k);
        B.h[i] = lerp(B.h[i], hgt, k);
        B.rough[i] = lerp(B.rough[i], 0.62 - roundness * 0.08, k);
      });
    }
  }

  // Freshly cut clippings lying flat on top.
  for (let s = 0; s < Math.round(size * 0.35); s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const a = rng.next() * Math.PI * 2;
    const len = bladeLen * rng.range(0.25, 0.7);
    const c = rng.bool(0.5) ? dryCol : greens[1];
    rasterCapsule(B, x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, bladeW * 0.9, 0.6, (i, t, sA, cov) => {
      const k = cov * 0.85;
      B.r[i] = lerp(B.r[i], c[0] * 1.05, k);
      B.g[i] = lerp(B.g[i], c[1] * 1.05, k);
      B.b[i] = lerp(B.b[i], c[2] * 1.05, k);
      B.h[i] = Math.max(B.h[i], 0.82 * k);
      B.rough[i] = lerp(B.rough[i], 0.7, k);
    });
  }

  B.give(clump); B.give(bare); B.give(mow);
  B.aoStrength = 1.45;
};

GEN.soil = (B) => {
  const { size, n } = B;
  const clods = B.field(Math.round(clamp(B.world / 1.6, 8, size / 8)), (nz) => (x, y) => nz.worleyFbm(x, y, 3, 2, 0.55), { samples: 8, seed: 1 });
  const grit = B.field(Math.round(clamp(B.world / 0.16, 40, size / 3.6)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 2 });
  const moist = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 3 });
  const crackCells = Math.round(clamp(B.world / 2.6, 6, size / 10));
  const cracks = B.field(crackCells, (nz) => (x, y) => nz.worleyEdge(x, y), { samples: 8, seed: 4 });

  const wet = rgb('#3a2a1b');
  const dryS = rgb('#7a6146');
  const org = rgb('#4a3a1e');
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const m = saturate(0.5 + moist[i] * 0.85);
    mixC(wet, dryS, m, col);
    const c = clods[i];
    const g = grit[i];
    const crack = 1 - smoothstep(0.02, 0.10, cracks[i]);
    const lit = 0.82 + (1 - c) * 0.4 + g * 0.12;
    B.r[i] = clamp(lerp(col[0], org[0], 0.18) * lit * (1 - crack * 0.55), 0, 1);
    B.g[i] = clamp(lerp(col[1], org[1], 0.18) * lit * (1 - crack * 0.55), 0, 1);
    B.b[i] = clamp(lerp(col[2], org[2], 0.18) * lit * (1 - crack * 0.55), 0, 1);
    B.h[i] = 0.55 - c * 0.45 + (1 - g) * 0.22 - crack * 0.65;
    B.rough[i] = clamp(0.93 - m * 0.14 + g * 0.04, 0.6, 0.99);
  }
  B.give(clods); B.give(grit); B.give(moist); B.give(cracks);

  // Small stones and bits of leaf litter turned into the surface.
  const rng = makeRng(B.seed ^ 0x501a);
  const pts = scatterPoints(B, Math.round(size * 0.25), 313);
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.55)) continue;
    const stone = rng.bool(0.6);
    const r = size * (stone ? rng.range(0.003, 0.011) : rng.range(0.004, 0.016));
    const c = stone ? rgb('#8a8378') : rgb('#5d4a22');
    const lobe = { amp: stone ? 0.24 : 0.45, k1: rng.int(2, 5), k2: rng.int(6, 9), p1: rng.next() * 6.28, p2: rng.next() * 6.28 };
    rasterDisc(B, pts[p], pts[p + 1], r, 0.9, (i, d, cov) => {
      const dome = Math.sqrt(Math.max(0, 1 - d * d));
      const k = cov;
      const lit = 0.7 + dome * 0.5;
      B.r[i] = lerp(B.r[i], clamp(c[0] * lit, 0, 1), k);
      B.g[i] = lerp(B.g[i], clamp(c[1] * lit, 0, 1), k);
      B.b[i] = lerp(B.b[i], clamp(c[2] * lit, 0, 1), k);
      B.h[i] = lerp(B.h[i], 0.55 + dome * (stone ? 0.4 : 0.2), k);
      B.rough[i] = lerp(B.rough[i], stone ? 0.68 : 0.88, k);
    }, lobe);
  }
  B.aoStrength = 1.3;
};

GEN.gravel = (B) => {
  const { size, n } = B;
  // Fine grit substrate first, then the pebbles are dropped on top with a
  // depth buffer so they overlap the way tipped aggregate actually does.
  const gritCells = Math.round(clamp(B.world / 0.10, 40, size / 3.6));
  const grit = B.layer(gritCells, (x, y) => worleyFbm2D(x, y, 2, 2, 0.5, B.seed ^ 0x33, gritCells), { full: true });
  const dust = B.field(5, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 2 });
  const base = rgb('#6b6154');
  for (let i = 0; i < n; i++) {
    const g = 1 - grit[i];
    const lit = 0.72 + g * 0.5 + dust[i] * 0.12;
    B.r[i] = clamp(base[0] * lit, 0, 1);
    B.g[i] = clamp(base[1] * lit, 0, 1);
    B.b[i] = clamp(base[2] * lit, 0, 1);
    B.h[i] = 0.10 + g * 0.16;
    B.rough[i] = clamp(0.90 + dust[i] * 0.05, 0.7, 0.99);
  }
  B.give(grit); B.give(dust);

  const rng = makeRng(B.seed ^ 0x9ea1);
  const stoneCols = [rgb('#9a9184'), rgb('#7d766b'), rgb('#b0a794'), rgb('#6a5f52'), rgb('#c2b7a4'), rgb('#5b5f63')];
  const zbuf = new Float32Array(n);
  const pebbleWorld = 0.85;
  const cols = Math.max(4, Math.round(B.world / pebbleWorld));
  const cw = size / cols;
  const col = [0, 0, 0];
  // Two passes: a bed of smaller stones, then the larger ones on top.
  for (let pass = 0; pass < 2; pass++) {
    const scale = pass === 0 ? 0.62 : 1;
    for (let cy = 0; cy < cols; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (pass === 1 && rng.bool(0.28)) continue;
        const px = (cx + 0.5 + (rng.next() - 0.5) * 1.1) * cw;
        const py = (cy + 0.5 + (rng.next() - 0.5) * 1.1) * cw;
        const r = cw * scale * rng.range(0.42, 0.78);
        const flat = rng.range(0.45, 1);
        const c = stoneCols[rng.int(0, stoneCols.length - 1)];
        const speck = rng.range(0.04, 0.16);
        const wetStone = rng.bool(0.12);
        const lobe = { amp: 0.22, k1: rng.int(2, 4), k2: rng.int(5, 9), p1: rng.next() * 6.28, p2: rng.next() * 6.28 };
        const lift = 0.25 + pass * 0.2 + rng.range(0, 0.15);
        rasterDisc(B, px, py, r, 1.0, (i, d, cov, nx, ny) => {
          const dome = Math.sqrt(Math.max(0, 1 - d * d)) * flat;
          const hgt = lift + dome * 0.55;
          if (hgt <= zbuf[i]) return;
          zbuf[i] = hgt;
          // Mineral speckle inside each stone, in the stone's own frame.
          const sp = value2DTiled((nx + 1) * 9, (ny + 1) * 9, 64, B.seed ^ 0x77) - 0.5;
          const lit = (0.66 + dome * 0.5) * (1 + sp * speck * 4);
          col[0] = clamp(c[0] * lit, 0, 1);
          col[1] = clamp(c[1] * lit, 0, 1);
          col[2] = clamp(c[2] * lit, 0, 1);
          const k = cov;
          B.r[i] = lerp(B.r[i], col[0], k);
          B.g[i] = lerp(B.g[i], col[1], k);
          B.b[i] = lerp(B.b[i], col[2], k);
          B.h[i] = lerp(B.h[i], hgt, k);
          B.rough[i] = lerp(B.rough[i], wetStone ? 0.32 : 0.74 - dome * 0.06, k);
        }, lobe);
      }
    }
  }
  B.aoStrength = 1.55;
};

GEN.concrete = (B) => {
  const { size, n } = B;
  const blotch = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 5, 2, 0.5), { samples: 10, seed: 1 });
  const stain = B.field(7, (nz) => (x, y) => nz.warp(x, y, 0.8, 4, 2, 0.5), { samples: 8, seed: 2 });
  const aggCells = Math.round(clamp(B.world / 0.22, 30, size / 3.6));
  const agg = B.layer(aggCells, (x, y) => worleyFbm2D(x, y, 2, 2.2, 0.45, B.seed ^ 0x1c, aggCells), { full: true });
  // Trowel sweep: a strongly domain-warped ridge field gives the broad arcs a
  // power float leaves behind, and unlike a real arc it tiles exactly.
  const trowel = B.aniso(3, 6, (nz) => (x, y) => nz.warp(x, y, 1.5, 3, 2.3, 0.55), { samples: 12, seed: 3 });
  const crackCells = Math.round(clamp(B.world / 6, 4, size / 16));
  const cracks = B.field(crackCells, (nz) => (x, y) => nz.worleyEdge(x, y), { samples: 10, seed: 4 });

  const pale = rgb('#b4b1aa');
  const grey = rgb('#8e8b85');
  const dark = rgb('#63615c');
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = saturate(0.5 + blotch[i] * 0.9);
    mixC(grey, pale, t, col);
    const st = saturate(stain[i] * 1.2 - 0.15);
    mixC(col, dark, st * 0.55, col);
    const a = 1 - agg[i];
    const crack = 1 - smoothstep(0.012, 0.055, cracks[i]);
    const lit = 0.94 + a * 0.14 + trowel[i] * 0.05;
    B.r[i] = clamp(col[0] * lit * (1 - crack * 0.45), 0, 1);
    B.g[i] = clamp(col[1] * lit * (1 - crack * 0.45), 0, 1);
    B.b[i] = clamp(col[2] * lit * (1 - crack * 0.45), 0, 1);
    B.h[i] = 0.55 + a * 0.18 + trowel[i] * 0.10 + blotch[i] * 0.05 - crack * 0.75;
    B.rough[i] = clamp(0.76 + st * 0.10 - trowel[i] * 0.07 + a * 0.05, 0.5, 0.96);
  }
  B.give(blotch); B.give(stain); B.give(agg); B.give(trowel); B.give(cracks);

  // Entrained air voids. Small, round, dark and *recessed* — the single most
  // recognisable feature of a poured slab.
  const rng = makeRng(B.seed ^ 0xc047);
  const pts = scatterPoints(B, Math.round(size * 0.5), 4207);
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.42)) continue;
    const r = size * rng.range(0.0015, 0.006) * (rng.bool(0.12) ? 2.6 : 1);
    rasterDisc(B, pts[p], pts[p + 1], r, 0.8, (i, d, cov) => {
      const k = cov * (1 - d * d * 0.3);
      B.h[i] -= k * 0.55;
      B.r[i] *= 1 - k * 0.42; B.g[i] *= 1 - k * 0.42; B.b[i] *= 1 - k * 0.42;
      B.rough[i] = clamp(B.rough[i] + k * 0.12, 0, 1);
    });
  }
  B.aoStrength = 1.15;
};

GEN.ceramicTile = (B) => {
  const { size, n } = B;
  const tiles = Math.max(1, Math.round(B.world / 30));  // 30 cm field tiles
  const tw = size / tiles;
  const groutW = (0.32 / B.world) * size;
  const bevelW = (0.16 / B.world) * size;

  const mottle = B.field(Math.round(clamp(B.world / 3.2, 6, size / 10)), (nz) => (x, y) => nz.warp(x, y, 0.9, 4, 2, 0.5), { samples: 8, seed: 1 });
  const crazeCells = Math.round(clamp(B.world / 0.8, 12, size / 6));
  const craze = B.field(crazeCells, (nz) => (x, y) => nz.worleyEdge(x, y), { samples: 8, seed: 2 });
  const groutGrain = B.field(Math.round(clamp(B.world / 0.09, 40, size / 3.6)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 3 });
  const peel = B.field(Math.round(clamp(size / 22, 6, size / 6)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 6, seed: 4 });

  const glazeA = rgb('#e8e3d6');
  const glazeB = rgb('#cfc7b4');
  const groutC = rgb('#9a9186');
  const col = [0, 0, 0];
  const rng = makeRng(B.seed ^ 0x71e5);

  // Per-tile character, sampled once so every tile in the field differs.
  const tileTint = new Float32Array(tiles * tiles * 3);
  for (let i = 0; i < tiles * tiles; i++) {
    tileTint[i * 3] = rng.range(-4, 4);
    tileTint[i * 3 + 1] = rng.range(0.9, 1.12);
    tileTint[i * 3 + 2] = rng.range(0.94, 1.06);
  }

  const tmp = [0, 0, 0];
  for (let y = 0, i = 0; y < size; y++) {
    const ty = y / tw;
    const tiy = Math.min(tiles - 1, Math.floor(ty));
    const fy = (ty - tiy) * tw;
    for (let x = 0; x < size; x++, i++) {
      const tx = x / tw;
      const tix = Math.min(tiles - 1, Math.floor(tx));
      const fx = (tx - tix) * tw;

      const edge = Math.min(Math.min(fx, tw - fx), Math.min(fy, tw - fy));
      const inGrout = edge < groutW;
      const bevel = inGrout ? 0 : 1 - smoothstep(groutW, groutW + bevelW * 3, edge);

      if (inGrout) {
        const g = groutGrain[i];
        const dirt = 1 - smoothstep(0, groutW * 0.7, edge);   // muck packs into the corner
        const lit = 0.82 + (1 - g) * 0.3 - dirt * 0.22;
        B.r[i] = clamp(groutC[0] * lit, 0, 1);
        B.g[i] = clamp(groutC[1] * lit, 0, 1);
        B.b[i] = clamp(groutC[2] * lit, 0, 1);
        B.h[i] = 0.16 + (1 - g) * 0.10 - dirt * 0.08;
        B.rough[i] = clamp(0.88 - g * 0.04, 0.7, 0.97);
      } else {
        const ti = tiy * tiles + tix;
        mixC(glazeA, glazeB, saturate(0.5 + mottle[i] * 0.75), col);
        tint(tmp, col[0], col[1], col[2], tileTint[ti * 3], tileTint[ti * 3 + 1], tileTint[ti * 3 + 2]);
        const cz = 1 - smoothstep(0.006, 0.030, craze[i]);
        const lit = (1 - bevel * 0.10) * (1 - cz * 0.10);
        B.r[i] = clamp(tmp[0] * lit, 0, 1);
        B.g[i] = clamp(tmp[1] * lit, 0, 1);
        B.b[i] = clamp(tmp[2] * lit, 0, 1);
        B.h[i] = 0.90 - bevel * bevel * 0.62 + peel[i] * 0.05 - cz * 0.06;
        B.rough[i] = clamp(0.075 + cz * 0.16 + bevel * 0.05 + peel[i] * 0.015, 0.05, 0.5);
      }
    }
  }
  B.give(mottle); B.give(craze); B.give(groutGrain); B.give(peel);

  // Glaze pinholes: a few tiny matte specks per tile.
  const pts = scatterPoints(B, Math.round(size * 0.22), 990);
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.3)) continue;
    rasterDisc(B, pts[p], pts[p + 1], size * rng.range(0.0012, 0.004), 0.7, (i, d, cov) => {
      B.rough[i] = clamp(B.rough[i] + cov * 0.55, 0, 1);
      B.h[i] -= cov * 0.10;
    });
  }
  addScratches(B, { count: 70, lenMin: size * 0.01, lenMax: size * 0.09, width: size / 1600, depth: 0.02, rough: 0.22, bright: 0.02, seed: 12 });
  B.aoStrength = 1.2;
};

GEN.linoleum = (B) => {
  const { size, n } = B;
  // Jaspé marbling: linoleum is granulated pigment rolled into sheet, so the
  // colour comes in stretched streaks rather than blobs.
  const marbV = Math.round(clamp(B.world / 2.4, 6, size / 12));
  const marb = B.aniso(Math.max(3, Math.round(marbV * 0.45)), marbV, (nz) => (x, y) => nz.warp(x, y, 1.35, 5, 2.1, 0.55), { samples: 8, seed: 1 });
  const fineV = Math.round(clamp(B.world / 0.3, 24, size / 4));
  const fine = B.aniso(Math.max(6, Math.round(fineV * 0.5)), fineV, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 4, seed: 2 });
  const peel = B.field(Math.round(clamp(B.world / 0.14, 40, size / 3.4)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 3 });

  const cA = rgb('#b9a37e'), cB = rgb('#8a7455'), cC = rgb('#d8cbb0');
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = saturate(0.5 + marb[i] * 1.1);
    mixC(cB, cA, t, col);
    mixC(col, cC, saturate(fine[i] * 1.4 - 0.35) * 0.55, col);
    const lit = 1 + fine[i] * 0.06;
    B.r[i] = clamp(col[0] * lit, 0, 1);
    B.g[i] = clamp(col[1] * lit, 0, 1);
    B.b[i] = clamp(col[2] * lit, 0, 1);
    B.h[i] = 0.5 + peel[i] * 0.35 + marb[i] * 0.06;
    B.rough[i] = clamp(0.34 + peel[i] * 0.05 - marb[i] * 0.03, 0.2, 0.55);
  }
  B.give(marb); B.give(fine); B.give(peel);

  // Buffing swirls from a rotary polisher, then black rubber scuffs.
  addScratches(B, { count: 300, lenMin: size * 0.02, lenMax: size * 0.15, width: size / 2000, depth: 0.012, rough: 0.10, bright: 0.01, seed: 21 });
  const rng = makeRng(B.seed ^ 0x11a0);
  for (let s = 0; s < 22; s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const ang = rng.next() * Math.PI * 2;
    const len = size * rng.range(0.02, 0.10);
    rasterCapsule(B, x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len,
      size * rng.range(0.004, 0.012), size * 0.006, (i, t, sA, cov) => {
        const k = cov * Math.sin(Math.PI * t) * rng.range(0.3, 0.6);
        B.r[i] *= 1 - k * 0.55; B.g[i] *= 1 - k * 0.55; B.b[i] *= 1 - k * 0.55;
        B.rough[i] = clamp(B.rough[i] + k * 0.28, 0, 1);
      });
  }
  B.aoStrength = 0.7;
};

/* --------------------------------------------------------------------- metal */

GEN.brushedAluminium = (B) => {
  const { size, n } = B;
  // Abrasive belt grit leaves scratches that are hundreds of times longer than
  // they are wide. Three octaves of that at different aspect ratios, plus a
  // handful of deep individual scores, is the entire material.
  const fineV = Math.round(clamp(size / 1.9, 60, size / 1.8));
  const s1 = B.aniso(Math.max(3, Math.round(fineV * 0.012)), fineV, (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 4, seed: 1 });
  const s2 = B.aniso(Math.max(3, Math.round(fineV * 0.03)), Math.round(fineV * 0.42), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 4, seed: 2 });
  const s3 = B.aniso(Math.max(2, Math.round(fineV * 0.008)), Math.round(fineV * 0.16), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 5, seed: 3 });
  const cloud = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 4 });

  // Aluminium's reflectance is very slightly cool, and authoring it that way is
  // correct in isolation and wrong in context: a metal is nothing but tinted
  // environment, the environment here is a daylight sky, and the two cool casts
  // compound into the "matte blue paint" of D4. A hair on the warm side of
  // neutral costs nothing physically and puts the material back in the kitchen.
  const base = rgb('#e8e4dd');
  const metal = B.wantMetal();
  for (let i = 0; i < n; i++) {
    // The finest of the three grit octaves sits at ~1.9 texels per cell, which
    // is past what the tile can carry, so `bakeLayer` correctly fades it to a
    // few percent of its amplitude. Weighting the height toward the two coarser
    // octaves is therefore not a stylistic choice — it is putting the relief
    // where the bake can actually represent it. Before this the measured peak
    // slope over the whole tile was 2 degrees: no brush marks at all.
    const streak = s1[i] * 0.5 + s2[i] * 0.32 + s3[i] * 0.18;
    const relief = s1[i] * 0.30 + s2[i] * 0.44 + s3[i] * 0.26;
    const lit = 1 + streak * 0.10 + cloud[i] * 0.035;
    B.r[i] = clamp(base[0] * lit, 0, 1);
    B.g[i] = clamp(base[1] * lit, 0, 1);
    B.b[i] = clamp(base[2] * lit, 0, 1);
    B.h[i] = 0.5 + relief * 0.62;
    // Roughness follows the grit: a scratch trough scatters more than a plateau.
    B.rough[i] = clamp(0.26 - streak * 0.10 + cloud[i] * 0.04, 0.13, 0.46);
    metal[i] = 1;
  }
  B.give(s1); B.give(s2); B.give(s3); B.give(cloud);

  // Individual deep scores along the brush direction.
  //
  // `dir` is the scratch's heading in texel space and `addScratches` walks it
  // as (cos dir, sin dir), so Math.PI * 0.5 pointed every score straight down
  // +y — square across the three grit octaves above, which are cellsX-sparse
  // and cellsY-dense and therefore run along +x. The comment said "along the
  // brush direction" and the code drew the exact opposite, which is the one
  // thing in the tile with enough contrast to set the material's read: the
  // scores are the sharpest features in the roughness map, so they decided its
  // direction. Measured over the 1024 tile, mean |d rough/dy| : |d rough/dx|
  // was 0.78 — a roughness map that varied *faster across* the brush than
  // along it, i.e. cross-hatched, not brushed. At dir 0 the same ratio is 6.9,
  // the albedo 13.9 and the encoded normal 5.3.
  //
  // This matters beyond the tile. render/Materials.js hands the surface an
  // anisotropyRotation of PI/2 so three's alphaT lands on the bitangent, which
  // is the correct wide axis only if the grooves run along the tangent. Half
  // the tile disagreeing with that is a large part of why D4 still had no
  // brushed read after the albedo and roughness were already measuring fine.
  //
  // Worth noting what this does *not* do: it redistributes the encoded normal
  // rather than amplifying it. Mean |nx-128| falls 1.23 -> 0.50 while |ny-128|
  // rises 2.21 -> 2.67, so the combined magnitude moves under a tenth and the
  // geometric specular AA in Materials — which widens the lobe from the screen
  // -space derivative of the shading normal — sees essentially the same load.
  // A directional normal is also the case the texture's own anisotropic
  // filtering handles best, so this should minify cleaner than it did.
  addScratches(B, {
    count: 220, lenMin: size * 0.08, lenMax: size * 0.6, width: size / 2400,
    depth: 0.30, rough: 0.10, bright: 0.02, dir: 0, dirBias: 0.045, seed: 31,
  });
  addFingerprints(B, 3, 0.20, 77);
  B.aoStrength = 0.35;
};

GEN.galvanisedSteel = (B) => {
  const { size, n } = B;
  // Spangle: as the zinc freezes it grows large flat crystals in random
  // orientations. Each cell gets its own tilted *plane*, which is why real
  // galvanising flashes as you walk past it — the facets are mirrors at
  // slightly different angles, not bumps.
  const cellsF = Math.max(2, Math.round(B.world / 1.6));
  const dendV = Math.round(clamp(B.world / 0.06, 40, size / 3.4));
  const dend = B.aniso(Math.max(6, Math.round(dendV * 0.35)), dendV, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 4, seed: 2 });
  const bloom = B.field(5, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 3 });

  const base = rgb('#b6bcc0');
  const oxide = rgb('#d5d7d2');
  const metal = B.wantMetal();
  const col = [0, 0, 0];
  const inv = cellsF / size;
  for (let y = 0, i = 0; y < size; y++) {
    const fy = y * inv;
    for (let x = 0; x < size; x++, i++) {
      const c = worley2DFull(x * inv, fy, B.seed ^ 0x2a11, { period: cellsF, jitter: 0.95 });
      const id = hash2i(c.cellX, c.cellY, B.seed ^ 0x77ab);
      // Two independent bits of the cell hash become the facet gradient.
      const ax = ((id & 0xffff) / 65536 - 0.5) * 2;
      const ay = (((id >>> 16) & 0xffff) / 65536 - 0.5) * 2;
      const bright = 0.86 + ((id >>> 8) & 255) / 255 * 0.26;
      // c.dx / c.dy are the offset to the cell's seed point, which is exactly
      // the local coordinate a facet plane should be evaluated in.
      const facet = 0.5 + (ax * c.dx + ay * c.dy) * 0.42;
      const rim = 1 - smoothstep(0.0, 0.10, c.edge);   // crystal boundary

      const bl = saturate(bloom[i] * 1.3 - 0.25);
      mixC(base, oxide, bl * 0.8, col);
      const lit = bright * (1 + dend[i] * 0.05) * (1 - rim * 0.16);
      B.r[i] = clamp(col[0] * lit, 0, 1);
      B.g[i] = clamp(col[1] * lit, 0, 1);
      B.b[i] = clamp(col[2] * lit, 0, 1);
      B.h[i] = facet + dend[i] * 0.06 - rim * 0.30;
      B.rough[i] = clamp(0.30 + bl * 0.34 + rim * 0.12 + dend[i] * 0.04, 0.16, 0.8);
      metal[i] = 1 - bl * 0.35;
    }
  }
  B.give(dend); B.give(bloom);
  addScratches(B, { count: 110, lenMin: size * 0.02, lenMax: size * 0.22, width: size / 1500, depth: 0.12, rough: 0.14, bright: 0.05, seed: 44 });
  B.aoStrength = 0.5;
};

GEN.chromePlate = (B) => {
  const { size, n } = B;
  // Chrome is defined by what it is *not*: not rough. The only structure is
  // orange peel — the long, shallow undulation left by the nickel underlayer —
  // plus swirl marks from polishing. Amplitude is tiny but the wavelength is
  // long, so reflections wobble instead of blurring.
  const peelCells = Math.max(4, Math.round(B.world / 0.4));
  const peel = B.field(peelCells, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 6, seed: 1 });
  const micro = B.field(Math.round(clamp(B.world / 0.05, 40, size / 3.6)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { samples: 4, seed: 2 });

  const base = rgb('#f2f3f4');
  const metal = B.wantMetal();
  for (let i = 0; i < n; i++) {
    B.r[i] = base[0]; B.g[i] = base[1]; B.b[i] = base[2];
    B.h[i] = 0.5 + peel[i] * 0.46 + micro[i] * 0.06;
    // Buffed, not optically flat.
    //
    // At 0.035 this map returned nothing at all in game, and the reason is a
    // sampling argument rather than an aesthetic one. A metal has no diffuse
    // term: every pixel of it is an image of the environment, and a lobe that
    // narrow on a 9 cm fork at race distance integrates roughly one texel of
    // the probe. On a horizontal table the direction it happens to point at is
    // the sky, so a polished steel fork rendered as a flat blue-grey card —
    // exactly the thing it should never look like. Widening the lobe to a
    // hand-buffed 0.25-0.35 makes it integrate the key light as well, and a
    // broad bright highlight over a bright base is what actually reads as
    // metal. The remaining sharpness lives in the normal map's orange peel,
    // which is where a real plated finish keeps it.
    B.rough[i] = clamp(0.255 + Math.abs(micro[i]) * 0.09 + peel[i] * 0.05, 0.20, 0.40);
    metal[i] = 1;
  }
  B.give(peel); B.give(micro);

  // Polishing swirls and the occasional pit in the plating.
  addScratches(B, { count: 260, lenMin: size * 0.015, lenMax: size * 0.10, width: size / 2600, depth: 0.05, rough: 0.09, seed: 5 });
  const rng = makeRng(B.seed ^ 0xc470);
  const pts = scatterPoints(B, Math.round(size * 0.14), 616);
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.22)) continue;
    rasterDisc(B, pts[p], pts[p + 1], size * rng.range(0.001, 0.0035), 0.7, (i, d, cov) => {
      B.rough[i] = clamp(B.rough[i] + cov * 0.5, 0, 1);
      B.h[i] -= cov * 0.25;
      B.r[i] *= 1 - cov * 0.25; B.g[i] *= 1 - cov * 0.25; B.b[i] *= 1 - cov * 0.25;
    });
  }
  B.aoStrength = 0.25;
};

/* ------------------------------------------------------------------- plastic */

function plasticBase(B, o) {
  const { size, n } = B;
  // Injection-moulded ABS. The mould cavity is spark-eroded, which prints a
  // fine isotropic crater texture into every part; gloss parts get a polished
  // cavity instead, so only the flow lines and orange peel survive.
  const edm = B.field(Math.round(clamp(B.world / o.edmWorld, 24, size / 3.4)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2.2, 0.5), { full: true, seed: 1 });
  const peel = B.field(Math.round(clamp(B.world / 0.55, 6, size / 8)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 6, seed: 2 });
  const flowV = Math.round(clamp(B.world / 0.6, 6, size / 8));
  const flow = B.aniso(Math.max(2, Math.round(flowV * 0.10)), flowV, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 8, seed: 3 });
  const sink = B.field(3, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 10, seed: 4 });

  const base = o.color;
  for (let i = 0; i < n; i++) {
    const e = 1 - edm[i];
    const lit = 1 + e * o.edmShade + flow[i] * 0.02 + sink[i] * 0.015;
    B.r[i] = clamp(base[0] * lit, 0, 1);
    B.g[i] = clamp(base[1] * lit, 0, 1);
    B.b[i] = clamp(base[2] * lit, 0, 1);
    B.h[i] = 0.5 + e * o.edmRelief + peel[i] * o.peelRelief + sink[i] * 0.10 + flow[i] * 0.05;
    B.rough[i] = clamp(o.rough + e * o.edmRough + Math.abs(peel[i]) * 0.02, 0.03, 1);
  }
  B.give(edm); B.give(peel); B.give(flow); B.give(sink);
}

GEN.plasticMatte = (B) => {
  plasticBase(B, {
    color: rgb('#d8d8d6'), edmWorld: 0.055, edmShade: 0.05, edmRelief: 0.42,
    peelRelief: 0.10, rough: 0.52, edmRough: 0.10,
  });
  addScratches(B, { count: 60, lenMin: B.size * 0.01, lenMax: B.size * 0.09, width: B.size / 2000, depth: 0.03, rough: 0.08, bright: 0.02, seed: 9 });
  B.aoStrength = 0.55;
};

GEN.plasticGloss = (B) => {
  plasticBase(B, {
    color: rgb('#e2e2e0'), edmWorld: 0.09, edmShade: 0.015, edmRelief: 0.10,
    peelRelief: 0.55, rough: 0.10, edmRough: 0.02,
  });
  const { size } = B;
  // Dust settled into the gloss plus light handling marks: without these a
  // glossy plastic reads as a shader preview, not as a moulded toy part.
  const rng = makeRng(B.seed ^ 0x9105);
  const pts = scatterPoints(B, Math.round(size * 0.55), 3311);
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.4)) continue;
    rasterDisc(B, pts[p], pts[p + 1], rng.range(0.6, 1.9), 0.8, (i, d, cov) => {
      B.rough[i] = clamp(B.rough[i] + cov * 0.34, 0, 1);
      B.h[i] += cov * 0.08;
    });
  }
  addScratches(B, { count: 120, lenMin: size * 0.008, lenMax: size * 0.07, width: size / 2400, depth: 0.02, rough: 0.16, bright: 0.015, seed: 10 });
  addFingerprints(B, 2, 0.13, 41);
  B.aoStrength = 0.4;
};

GEN.rubber = (B) => {
  const { size, n } = B;
  // Tyre rubber out of a mould: a fine pebbled cavity finish, a faint parting
  // line, and the grey anti-ozonant bloom that stops it reading as pure black.
  const pebble = B.field(Math.round(clamp(B.world / 0.045, 30, size / 3.4)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2.2, 0.5), { full: true, seed: 1 });
  const coarse = B.field(Math.round(clamp(B.world / 0.4, 8, size / 8)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 5, seed: 2 });
  const bloom = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 3 });

  const black = rgb('#191919');
  const grey = rgb('#4a4a48');
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p = 1 - pebble[i];
    mixC(black, grey, saturate(bloom[i] * 0.9 + 0.12) * 0.55, col);
    const lit = 0.9 + p * 0.28 + coarse[i] * 0.06;
    B.r[i] = clamp(col[0] * lit, 0, 1);
    B.g[i] = clamp(col[1] * lit, 0, 1);
    B.b[i] = clamp(col[2] * lit, 0, 1);
    B.h[i] = 0.5 + p * 0.44 + coarse[i] * 0.16;
    B.rough[i] = clamp(0.80 - p * 0.06 + bloom[i] * 0.06, 0.55, 0.96);
  }
  B.give(pebble); B.give(coarse); B.give(bloom);
  B.aoStrength = 0.75;
};

/* --------------------------------------------------------------------- paper */

GEN.paper = (B) => {
  const { size, n } = B;
  // The tell for paper is *fibres*: individual cellulose strands you can pick
  // out at grazing light. Formation cloudiness alone reads as fabric.
  const form = B.field(Math.round(clamp(B.world / 1.4, 6, size / 10)), (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.55), { samples: 8, seed: 1 });
  const micro = B.field(Math.round(clamp(B.world / 0.055, 40, size / 3.4)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { full: true, seed: 2 });

  const base = rgb('#f3efe4');
  for (let i = 0; i < n; i++) {
    const lit = 1 + form[i] * 0.035 + micro[i] * 0.02;
    B.r[i] = clamp(base[0] * lit, 0, 1);
    B.g[i] = clamp(base[1] * lit, 0, 1);
    B.b[i] = clamp(base[2] * lit, 0, 1);
    B.h[i] = 0.5 + form[i] * 0.30 + micro[i] * 0.22;
    B.rough[i] = clamp(0.86 - form[i] * 0.05, 0.7, 0.96);
  }
  B.give(form); B.give(micro);

  const rng = makeRng(B.seed ^ 0x9a9e);
  const fibreLen = (0.07 / B.world) * size;
  const count = Math.round(size * size / 90);
  for (let s = 0; s < count; s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const a = rng.next() * Math.PI * 2;
    const len = fibreLen * rng.range(0.4, 3.2);
    const bright = rng.range(-0.05, 0.07);
    rasterCapsule(B, x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, Math.max(0.5, size / 2200), 0.65, (i, t, sA, cov) => {
      const k = cov * Math.sin(Math.PI * t) * 0.8;
      B.h[i] += k * 0.22;
      B.r[i] = clamp(B.r[i] + bright * k, 0, 1);
      B.g[i] = clamp(B.g[i] + bright * k, 0, 1);
      B.b[i] = clamp(B.b[i] + bright * k * 0.9, 0, 1);
      B.rough[i] = clamp(B.rough[i] + 0.03 * k, 0, 1);
    });
  }
  B.aoStrength = 0.9;
};

GEN.cardboard = (B) => {
  const { size, n } = B;
  // Kraft liner over a fluted core. The flutes are not on the surface — they
  // are underneath, and what you see is the liner sagging very slightly
  // between them. Tiny amplitude, unmistakable read.
  const flutes = Math.max(2, Math.round(B.world / 0.48));
  const form = B.field(Math.round(clamp(B.world / 1.2, 6, size / 10)), (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.55), { samples: 8, seed: 1 });
  const micro = B.field(Math.round(clamp(B.world / 0.07, 30, size / 3.4)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { full: true, seed: 2 });
  const fluteWarp = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 10, seed: 3 });

  const base = rgb('#b08a5c');
  const dark = rgb('#8a6a42');
  const col = [0, 0, 0];
  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const ph = (x * inv) * flutes + fluteWarp[i] * 0.06;
      const flute = Math.cos(ph * Math.PI * 2);
      mixC(base, dark, saturate(0.45 - form[i] * 0.8), col);
      const lit = 1 + flute * 0.035 + micro[i] * 0.03 + form[i] * 0.05;
      B.r[i] = clamp(col[0] * lit, 0, 1);
      B.g[i] = clamp(col[1] * lit, 0, 1);
      B.b[i] = clamp(col[2] * lit, 0, 1);
      B.h[i] = 0.5 + flute * 0.30 + form[i] * 0.22 + micro[i] * 0.22;
      B.rough[i] = clamp(0.88 - form[i] * 0.04, 0.72, 0.97);
    }
  }
  B.give(form); B.give(micro); B.give(fluteWarp);

  const rng = makeRng(B.seed ^ 0xcaad);
  // Coarse fibres and dark wood specks left in the pulp.
  const fibreLen = (0.12 / B.world) * size;
  for (let s = 0; s < Math.round(size * size / 220); s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    const a = rng.next() * Math.PI * 2;
    const len = fibreLen * rng.range(0.4, 2.6);
    const dk = rng.bool(0.18);
    const bright = dk ? rng.range(-0.16, -0.06) : rng.range(-0.03, 0.08);
    rasterCapsule(B, x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, Math.max(0.5, size / 1600), 0.65, (i, t, sA, cov) => {
      const k = cov * Math.sin(Math.PI * t) * 0.85;
      B.h[i] += k * (dk ? -0.10 : 0.24);
      B.r[i] = clamp(B.r[i] + bright * k, 0, 1);
      B.g[i] = clamp(B.g[i] + bright * k * 0.95, 0, 1);
      B.b[i] = clamp(B.b[i] + bright * k * 0.85, 0, 1);
    });
  }
  B.aoStrength = 0.95;
};

/* ------------------------------------------------------- liquids and overlays */
//
// These kinds are decals: they are laid over another surface, so they carry an
// alpha map and are authored as a *coverage* field. A radial blob around a
// point cannot tile (minimum-image distance creases at the half period), so the
// footprint comes from a thresholded periodic noise instead, which gives an
// organic outline and wraps exactly. Satellite droplets are then rasterised on
// top with modulo addressing.

/**
 * Build a wrapping coverage field.
 * @returns {Float32Array} coverage in [0,1] — the pooled body of a spill
 */
function splatField(B, o) {
  const { n } = B;
  const cells = Math.max(2, Math.round(o.cells));
  const body = B.field(cells, (nz) => (x, y) => nz.warp(x, y, o.warp ?? 0.9, 4, 2.1, 0.55), { samples: 8, seed: o.seed ?? 1 });
  const edge = B.field(Math.round(cells * 5), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 5, seed: (o.seed ?? 1) + 40 });
  const out = B.take();
  for (let i = 0; i < n; i++) {
    const v = body[i] + edge[i] * (o.ragged ?? 0.28);
    out[i] = smoothstep(o.threshold - o.soft, o.threshold + o.soft, v);
  }
  B.give(body); B.give(edge);
  return out;
}

/** Distance-to-edge proxy for a coverage field: blur it and read the falloff.
 *  Cheap, wrap-correct, and good enough to place a meniscus. */
function edgeBand(B, cov, radius) {
  const blurred = B.take();
  boxBlurWrap(cov, blurred, B.size, radius);
  const out = B.take();
  for (let i = 0; i < B.n; i++) out[i] = saturate((blurred[i] - cov[i] * 0.55) * 2.2) * cov[i];
  B.give(blurred);
  return out;
}

GEN.spilledMilk = (B) => {
  const { size, n } = B;
  const cov = splatField(B, { cells: 3, threshold: 0.02, soft: 0.10, ragged: 0.30, warp: 1.0, seed: 1 });
  const rim = edgeBand(B, cov, Math.max(2, Math.round(size / 90)));
  const ripple = B.field(Math.round(clamp(B.world / 0.6, 8, size / 8)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 6, seed: 2 });
  const skin = B.field(Math.round(clamp(B.world / 0.09, 30, size / 3.4)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { full: true, seed: 3 });

  const milk = rgb('#f6f5ef');
  const thin = rgb('#dfe4e2');       // thin film goes faintly blue-green
  const dried = rgb('#e6e0cd');
  const alpha = B.wantAlpha();
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = cov[i];
    const depth = saturate(c * 1.6 - rim[i] * 0.8);
    mixC(thin, milk, depth, col);
    mixC(col, dried, rim[i] * 0.55, col);
    B.r[i] = col[0]; B.g[i] = col[1]; B.b[i] = col[2];
    // Surface tension pulls the edge into a raised bead.
    B.h[i] = 0.5 + rim[i] * 0.45 + ripple[i] * 0.10 * depth + skin[i] * 0.04;
    B.rough[i] = clamp(0.07 + rim[i] * 0.42 + Math.abs(skin[i]) * 0.05, 0.05, 0.7);
    alpha[i] = c;
  }
  B.give(ripple); B.give(skin);

  // Thrown droplets around the main pool.
  const rng = makeRng(B.seed ^ 0x31c4);
  const pts = scatterPoints(B, Math.round(size * 0.22), 5150);
  for (let p = 0; p < pts.length; p += 2) {
    if (!rng.bool(0.3)) continue;
    const r = size * rng.range(0.002, 0.012);
    const lobe = { amp: 0.22, k1: rng.int(2, 4), k2: rng.int(5, 8), p1: rng.next() * 6.28, p2: rng.next() * 6.28 };
    rasterDisc(B, pts[p], pts[p + 1], r, 1.1, (i, d, c2) => {
      const dome = Math.sqrt(Math.max(0, 1 - d * d));
      alpha[i] = Math.max(alpha[i], c2);
      B.r[i] = lerp(B.r[i], milk[0], c2);
      B.g[i] = lerp(B.g[i], milk[1], c2);
      B.b[i] = lerp(B.b[i], milk[2], c2);
      B.h[i] = lerp(B.h[i], 0.5 + dome * 0.5, c2);
      B.rough[i] = lerp(B.rough[i], 0.07, c2);
    }, lobe);
  }
  B.give(cov); B.give(rim);
  B.aoStrength = 0.3;
};

GEN.oilSlick = (B) => {
  const { size, n } = B;
  const cov = splatField(B, { cells: 3, threshold: 0.05, soft: 0.16, ragged: 0.42, warp: 1.3, seed: 1 });
  const swirl = B.field(Math.round(clamp(B.world / 1.1, 6, size / 10)), (nz) => (x, y) => nz.warp(x, y, 1.6, 5, 2.1, 0.55), { samples: 8, seed: 2 });
  const micro = B.field(Math.round(clamp(B.world / 0.12, 24, size / 3.6)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { full: true, seed: 3 });

  const oil = rgb('#0a0908');
  const alpha = B.wantAlpha();
  // The thickness map is what drives three's iridescence: a thin-film
  // interference model needs a real film thickness in nanometres, and the
  // swirled noise here is exactly the spreading pattern that produces the
  // rainbow banding on a wet road.
  const thick = B.wantThick();
  for (let i = 0; i < n; i++) {
    const c = cov[i];
    const t = saturate(0.5 + swirl[i] * 0.75 + micro[i] * 0.08);
    B.r[i] = oil[0] * (1 + t * 0.5);
    B.g[i] = oil[1] * (1 + t * 0.5);
    B.b[i] = oil[2] * (1 + t * 0.6);
    B.h[i] = 0.5 + swirl[i] * 0.16 + micro[i] * 0.05;
    B.rough[i] = clamp(0.045 + (1 - c) * 0.25 + Math.abs(micro[i]) * 0.03, 0.03, 0.5);
    alpha[i] = c;
    // Thinner at the feathered edge, thickest in the middle of the film.
    thick[i] = saturate(t * 0.75 + c * 0.35);
  }
  B.give(cov); B.give(swirl); B.give(micro);
  B.aoStrength = 0.2;
};

GEN.waterPuddle = (B) => {
  const { size, n } = B;
  const cov = splatField(B, { cells: 2, threshold: 0.0, soft: 0.13, ragged: 0.26, warp: 1.1, seed: 1 });
  const rim = edgeBand(B, cov, Math.max(2, Math.round(size / 110)));
  // Two ripple scales: a slow swell and wind chop. Both are periodic, so the
  // water surface tiles even though it looks like it is moving.
  const swell = B.field(Math.max(3, Math.round(B.world / 8)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 10, seed: 2 });
  const chopV = Math.round(clamp(B.world / 0.35, 12, size / 5));
  const chop = B.aniso(Math.max(4, Math.round(chopV * 0.55)), chopV, (nz) => (x, y) => nz.fbm(x, y, 3, 2.1, 0.5), { samples: 5, seed: 3 });
  const grit = B.field(Math.round(clamp(B.world / 0.1, 30, size / 3.6)), (nz) => (x, y) => nz.fbm(x, y, 2, 2, 0.5), { full: true, seed: 4 });

  const deep = rgb('#131a1d');
  const shallow = rgb('#2e3a3a');
  const alpha = B.wantAlpha();
  const col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = cov[i];
    const depth = saturate(c * 1.5 - rim[i]);
    mixC(shallow, deep, depth, col);
    B.r[i] = col[0]; B.g[i] = col[1]; B.b[i] = col[2];
    // Flat water with ripples, plus the meniscus bead at the rim. The dish
    // itself deliberately does not appear in the height: the *surface* is
    // level, only the ground under it is not.
    B.h[i] = 0.5 + swell[i] * 0.14 + chop[i] * 0.30 + rim[i] * 0.30 + grit[i] * 0.03 * (1 - c);
    B.rough[i] = clamp(0.025 + (1 - c) * 0.55 + rim[i] * 0.18, 0.02, 0.85);
    alpha[i] = c;
  }
  B.give(cov); B.give(rim); B.give(swell); B.give(chop); B.give(grit);
  B.aoStrength = 0.2;
};

GEN.chalkLine = (B) => {
  const { size, n } = B;
  // A line snapped or drawn in chalk: powder sits in the tooth of the surface,
  // so the coverage is granular and the edges are ragged rather than cut.
  const along = B.aniso(2, Math.max(6, Math.round(B.world / 1.4)), (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 8, seed: 1 });
  const grain = B.field(Math.round(clamp(B.world / 0.045, 40, size / 3.4)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 2 });
  const streakV = Math.round(clamp(B.world / 0.5, 8, size / 8));
  const streak = B.aniso(Math.max(6, Math.round(streakV * 1.6)), Math.max(3, Math.round(streakV * 0.12)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 5, seed: 3 });

  const chalk = rgb('#f2f4f6');
  const alpha = B.wantAlpha();
  for (let i = 0; i < n; i++) {
    const g = 1 - grain[i];
    // Coverage breaks up where the stroke skipped and where the tooth is low.
    const a = saturate(0.62 + along[i] * 0.85 + streak[i] * 0.5) * saturate(g * 1.5 - 0.15);
    B.r[i] = chalk[0]; B.g[i] = chalk[1]; B.b[i] = chalk[2];
    B.h[i] = 0.5 + g * 0.5 + streak[i] * 0.12;
    B.rough[i] = clamp(0.94 - g * 0.04, 0.85, 0.99);
    alpha[i] = saturate(a);
  }
  B.give(along); B.give(grain); B.give(streak);
  B.aoStrength = 0.5;
};

GEN.gaffaTape = (B) => {
  const { size, n } = B;
  // Cloth-backed tape: a coarse polycotton scrim, over-under woven, flooded
  // with a matte PE coating that rounds the threads off.
  const threads = Math.round(clamp(B.world / 0.11, 6, size / 6));
  const tw = size / threads;
  const wrinkle = B.aniso(3, Math.max(4, Math.round(B.world / 1.6)), (nz) => (x, y) => nz.fbm(x, y, 3, 2, 0.5), { samples: 8, seed: 1 });
  const coat = B.field(Math.round(clamp(B.world / 0.08, 30, size / 3.4)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 2 });

  const base = rgb('#232426');
  const alpha = B.wantAlpha();
  for (let y = 0, i = 0; y < size; y++) {
    const ty = y / tw;
    const iy = Math.floor(ty), fy = ty - iy;
    for (let x = 0; x < size; x++, i++) {
      const tx = x / tw;
      const ix = Math.floor(tx), fx = tx - ix;
      const warpOnTop = ((ix + iy) & 1) === 0;
      const across = warpOnTop ? fx : fy;
      const round = Math.sin(Math.PI * clamp(across, 0, 1));
      const hgt = (warpOnTop ? 0.42 : 0.16) + round * (warpOnTop ? 0.5 : 0.26);
      const lit = 0.78 + round * 0.4 * (warpOnTop ? 1 : 0.65) + wrinkle[i] * 0.10;
      B.r[i] = clamp(base[0] * lit, 0, 1);
      B.g[i] = clamp(base[1] * lit, 0, 1);
      B.b[i] = clamp(base[2] * lit, 0, 1);
      B.h[i] = hgt + wrinkle[i] * 0.16 + coat[i] * 0.05;
      B.rough[i] = clamp(0.54 - round * 0.05 + coat[i] * 0.05, 0.32, 0.75);
      // A strip: opaque across the middle, fraying at the two long edges.
      const u = x / size;
      const dEdge = Math.min(u, 1 - u);
      alpha[i] = saturate(smoothstep(0.006, 0.045, dEdge) + coat[i] * 0.5 * (1 - smoothstep(0.0, 0.07, dEdge)));
    }
  }
  B.give(wrinkle); B.give(coat);
  B.aoStrength = 0.9;
};

GEN.crumbs = (B) => {
  const { size, n } = B;
  // Toast and biscuit debris. Every crumb is an irregular lump with a toasted
  // crust outside and a pale open crumb where it broke.
  const alpha = B.wantAlpha();
  const dustCells = Math.round(clamp(B.world / 0.05, 30, size / 3.4));
  const dust = B.field(dustCells, (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 1 });
  const spread = B.field(3, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 2 });

  const fine = rgb('#c9a878');
  for (let i = 0; i < n; i++) {
    const d = 1 - dust[i];
    const density = saturate(0.35 + spread[i] * 1.1);
    B.r[i] = fine[0]; B.g[i] = fine[1]; B.b[i] = fine[2];
    B.h[i] = 0.10 + d * 0.16;
    B.rough[i] = 0.92;
    alpha[i] = saturate((d * 1.6 - 0.75) * density * 1.6);
  }

  const rng = makeRng(B.seed ^ 0xc12b);
  const crust = [rgb('#8a5a28'), rgb('#a4703a'), rgb('#6d431c')];
  const inner = [rgb('#e8d5ac'), rgb('#f0e2c4'), rgb('#d8c193')];
  const burnt = rgb('#2e1d0d');
  const zbuf = new Float32Array(n);
  const pts = scatterPoints(B, Math.round(size * 1.15), 8080);
  const col = [0, 0, 0];
  for (let p = 0; p < pts.length; p += 2) {
    const idx = ((Math.floor(pts[p + 1]) % size + size) % size) * size + ((Math.floor(pts[p]) % size + size) % size);
    if (rng.next() > saturate(0.32 + spread[idx] * 1.2)) continue;
    const r = size * rng.range(0.0035, 0.026);
    const isBurnt = rng.bool(0.07);
    const cc = isBurnt ? burnt : crust[rng.int(0, 2)];
    const ci = inner[rng.int(0, 2)];
    const facet = rng.range(0.35, 0.95);
    const lobe = { amp: 0.42, k1: rng.int(2, 5), k2: rng.int(5, 9), p1: rng.next() * 6.28, p2: rng.next() * 6.28 };
    rasterDisc(B, pts[p], pts[p + 1], r, 0.9, (i, d, cov, nx, ny) => {
      const dome = Math.pow(Math.max(0, 1 - d * d), facet);
      const hgt = 0.25 + dome * 0.72;
      if (hgt <= zbuf[i]) return;
      zbuf[i] = hgt;
      // Broken faces show pale crumb; the outside kept its crust.
      const face = value2DTiled((nx + 1) * 5, (ny + 1) * 5, 32, B.seed ^ 0x5c);
      mixC(cc, ci, saturate(face * 1.6 - 0.45) * saturate(1.25 - d * 1.4), col);
      const lit = 0.72 + dome * 0.5;
      const k = cov;
      B.r[i] = lerp(B.r[i], clamp(col[0] * lit, 0, 1), k);
      B.g[i] = lerp(B.g[i], clamp(col[1] * lit, 0, 1), k);
      B.b[i] = lerp(B.b[i], clamp(col[2] * lit, 0, 1), k);
      B.h[i] = lerp(B.h[i], hgt, k);
      B.rough[i] = lerp(B.rough[i], isBurnt ? 0.78 : 0.86, k);
      alpha[i] = Math.max(alpha[i], k);
    }, lobe);
  }
  B.give(dust); B.give(spread);
  B.aoStrength = 1.4;
};

GEN.sawdust = (B) => {
  const { size, n } = B;
  const alpha = B.wantAlpha();
  const dust = B.field(Math.round(clamp(B.world / 0.04, 30, size / 3.4)), (nz) => (x, y) => nz.worleyFbm(x, y, 2, 2, 0.5), { full: true, seed: 1 });
  const drift = B.field(4, (nz) => (x, y) => nz.fbm(x, y, 4, 2, 0.5), { samples: 10, seed: 2 });

  const pale = rgb('#dcc79b');
  for (let i = 0; i < n; i++) {
    const d = 1 - dust[i];
    const density = saturate(0.30 + drift[i] * 1.2);
    const lit = 0.85 + d * 0.35;
    B.r[i] = clamp(pale[0] * lit, 0, 1);
    B.g[i] = clamp(pale[1] * lit, 0, 1);
    B.b[i] = clamp(pale[2] * lit, 0, 1);
    B.h[i] = 0.12 + d * 0.26;
    B.rough[i] = clamp(0.93 - d * 0.03, 0.8, 0.99);
    alpha[i] = saturate((d * 1.5 - 0.6) * density * 1.8);
  }

  // Curled shavings off a plane blade, plus square chips off a saw.
  const rng = makeRng(B.seed ^ 0x5a1d);
  const woodCols = [rgb('#e8d3a6'), rgb('#c9ab74'), rgb('#f2e3c0'), rgb('#a8894f')];
  const zbuf = new Float32Array(n);
  const shavings = Math.round(size * 0.9);
  for (let s = 0; s < shavings; s++) {
    const x0 = rng.next() * size, y0 = rng.next() * size;
    if (rng.next() > saturate(0.3 + drift[((Math.floor(y0) % size + size) % size) * size + ((Math.floor(x0) % size + size) % size)] * 1.2)) continue;
    const a = rng.next() * Math.PI * 2;
    const len = size * rng.range(0.006, 0.045);
    const curl = rng.range(-0.9, 0.9);
    const c = woodCols[rng.int(0, 3)];
    const w = Math.max(0.7, size * rng.range(0.0012, 0.004));
    const segs = 3;
    let px = x0, py = y0, ang = a;
    for (let sg = 0; sg < segs; sg++) {
      const nx2 = px + Math.cos(ang) * (len / segs);
      const ny2 = py + Math.sin(ang) * (len / segs);
      rasterCapsule(B, px, py, nx2, ny2, w, 0.6, (i, t, sA, cov) => {
        const roundv = Math.sqrt(Math.max(0, 1 - sA * sA));
        const hgt = 0.35 + roundv * 0.55;
        if (hgt <= zbuf[i]) return;
        zbuf[i] = hgt;
        const lit = 0.7 + roundv * 0.55;
        const k = cov;
        B.r[i] = lerp(B.r[i], clamp(c[0] * lit, 0, 1), k);
        B.g[i] = lerp(B.g[i], clamp(c[1] * lit, 0, 1), k);
        B.b[i] = lerp(B.b[i], clamp(c[2] * lit, 0, 1), k);
        B.h[i] = lerp(B.h[i], hgt, k);
        B.rough[i] = lerp(B.rough[i], 0.72, k);
        alpha[i] = Math.max(alpha[i], k);
      });
      px = nx2; py = ny2; ang += curl / segs;
    }
  }
  B.give(dust); B.give(drift);
  B.aoStrength = 1.2;
};

/* ================================================== per-kind bake parameters */
//
// `tileWorld` is how many centimetres one repeat of the texture covers, and
// `relief` is the peak-to-trough height of the surface in the same units.
// Together they turn the [0,1] height buffer into a physical slope, which is
// what makes the derived normal map correct at any bake resolution. `maxRes`
// caps the memory a kind is allowed to ask for: a chalk line does not need the
// same budget as the table the race is run on.

// A note on the timber relief numbers, because they look too large next to a
// caliper. `relief` is the peak-to-trough height of the *whole* height buffer,
// and on a plank surface most of that budget is spent on the joint grooves
// (0.55 of the buffer range) rather than on the grain (about 0.4 of it). Sizing
// `relief` so the grain is physically correct therefore sizes the grain to
// nothing: the measured mean slope of the old oak tile was 1.9 degrees, with
// 60% of its texels encoding to the flat normal exactly, against 2.6 degrees
// for concrete. These values put the grain where a raking key light can find
// it and leave the grooves deeper than a caliper would like, which is the right
// trade for a surface the camera only ever sees at a grazing angle.
export const GEN_DEF = {
  oak:               { tileWorld: 60, relief: 0.062, maxRes: 2048 },
  pine:              { tileWorld: 58, relief: 0.065, maxRes: 2048 },
  varnishedWood:     { tileWorld: 70, relief: 0.034, maxRes: 2048 },
  laminate:          { tileWorld: 80, relief: 0.030, maxRes: 2048 },
  poolFelt:          { tileWorld: 24, relief: 0.030, maxRes: 2048 },
  carpet:            { tileWorld: 34, relief: 0.340, maxRes: 2048 },
  rug:               { tileWorld: 55, relief: 0.130, maxRes: 2048 },
  sand:              { tileWorld: 30, relief: 0.230, maxRes: 2048 },
  // Capped at 1024: every blade is rasterised, so 2048 would quadruple a bake
  // that is already the most expensive in the library for no visible gain at
  // 39 texels per centimetre.
  grass:             { tileWorld: 26, relief: 0.480, maxRes: 1024 },
  soil:              { tileWorld: 44, relief: 0.320, maxRes: 1024 },
  gravel:            { tileWorld: 38, relief: 0.900, maxRes: 2048 },
  concrete:          { tileWorld: 90, relief: 0.105, maxRes: 2048 },
  ceramicTile:       { tileWorld: 60, relief: 0.200, maxRes: 2048 },
  linoleum:          { tileWorld: 70, relief: 0.022, maxRes: 1024 },
  brushedAluminium:  { tileWorld: 40, relief: 0.026, maxRes: 1024 },
  galvanisedSteel:   { tileWorld: 60, relief: 0.050, maxRes: 1024 },
  chromePlate:       { tileWorld: 8,  relief: 0.0035, maxRes: 1024 },
  plasticMatte:      { tileWorld: 6,  relief: 0.0055, maxRes: 512 },
  plasticGloss:      { tileWorld: 6,  relief: 0.0035, maxRes: 512 },
  rubber:            { tileWorld: 6,  relief: 0.014, maxRes: 512 },
  paper:             { tileWorld: 30, relief: 0.008, maxRes: 1024 },
  cardboard:         { tileWorld: 30, relief: 0.038, maxRes: 1024 },
  spilledMilk:       { tileWorld: 40, relief: 0.075, maxRes: 1024 },
  oilSlick:          { tileWorld: 45, relief: 0.020, maxRes: 1024 },
  waterPuddle:       { tileWorld: 55, relief: 0.045, maxRes: 1024 },
  chalkLine:         { tileWorld: 20, relief: 0.014, maxRes: 512 },
  gaffaTape:         { tileWorld: 12, relief: 0.030, maxRes: 512 },
  crumbs:            { tileWorld: 14, relief: 0.240, maxRes: 1024 },
  sawdust:           { tileWorld: 12, relief: 0.150, maxRes: 1024 },
};

/** Every kind this module can bake, in a stable order. */
export const TEXTURE_KINDS = Object.keys(GEN_DEF);

const FALLBACK_KIND = 'concrete';

export function hasKind(kind) { return !!GEN[kind]; }

export function defaultsFor(kind) {
  return GEN_DEF[kind] ? { ...GEN_DEF[kind] } : { ...GEN_DEF[FALLBACK_KIND] };
}

function resolveSize(kind, opts) {
  const def = GEN_DEF[kind] || GEN_DEF[FALLBACK_KIND];
  const cfg = texCfg();
  let s = opts.size ?? cfg.resolution ?? 1024;
  s = Math.min(s, cfg.maxResolution ?? 2048, def.maxRes ?? 2048);
  s = clamp(s, 64, 2048);
  // Snap to a power of two: mipmaps, wrapping and the tap tables all assume it.
  return 1 << Math.max(6, Math.min(11, Math.round(Math.log2(s))));
}

/* =================================================================== packing */

/**
 * Run a generator and pack the channel buffers into upload-ready byte arrays.
 *
 * AO, roughness and metalness share one texture (R/G/B respectively). three
 * reads exactly those channels for aoMap / roughnessMap / metalnessMap, so the
 * three maps become one sampler and one third of the memory — the standard ORM
 * packing, and worth doing when a track may have eight surfaces live at once.
 */
function bakeBuffers(kind, size, opts) {
  const gen = GEN[kind] || GEN[FALLBACK_KIND];
  const def = GEN_DEF[kind] || GEN_DEF[FALLBACK_KIND];
  const B = makeBake(kind, size, def, opts);
  B.rough.fill(0.6);
  gen(B);

  const n = B.n;
  const ao = deriveAO(B);

  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    albedo[o] = clamp(B.r[i], 0, 1) * 255;
    albedo[o + 1] = clamp(B.g[i], 0, 1) * 255;
    albedo[o + 2] = clamp(B.b[i], 0, 1) * 255;
    albedo[o + 3] = B.alpha ? clamp(B.alpha[i], 0, 1) * 255 : 255;
    orm[o] = clamp(ao[i], 0, 1) * 255;
    orm[o + 1] = clamp(B.rough[i], 0.02, 1) * 255;
    orm[o + 2] = B.metal ? clamp(B.metal[i], 0, 1) * 255 : 0;
    orm[o + 3] = 255;
  }

  const normal = new Uint8Array(n * 4);
  encodeNormal(B, normal);

  let height = null;
  if (opts.height ?? texCfg().generateDisplacement) {
    height = new Uint8Array(n * 4);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = B.h[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const k = hi > lo ? 1 / (hi - lo) : 1;
    for (let i = 0; i < n; i++) {
      const v = clamp((B.h[i] - lo) * k, 0, 1) * 255;
      const o = i * 4;
      height[o] = v; height[o + 1] = v; height[o + 2] = v; height[o + 3] = 255;
    }
  }

  let thickness = null;
  if (B.thick) {
    thickness = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = clamp(B.thick[i], 0, 1) * 255;
      const o = i * 4;
      thickness[o] = v; thickness[o + 1] = v; thickness[o + 2] = v; thickness[o + 3] = 255;
    }
  }

  return {
    albedo, orm, normal, height, thickness,
    hasAlpha: !!B.alpha,
    hasMetal: !!B.metal,
    relief: B.relief,
    tileWorld: B.world,
    size,
    // Handed back for verifyTiling, which needs the raw fields, not the bytes.
    fields: opts.keepFields ? { h: B.h, r: B.r, rough: B.rough, ao } : null,
  };
}

/* ============================================================== public bake */

/**
 * Bake a kind and hand back upload-ready level-0 images plus their filtered
 * mip chains, always at exactly `size` pixels.
 *
 * `opts.draft` runs the generator at a fraction of the linear resolution and
 * magnifies the result: a sixteenth of the generator's cost, which is what
 * keeps the boot from stalling on the first frame, while still handing the
 * driver an allocation that never has to change shape when the sharp bake
 * lands on top of it.
 */
function bakeAtSize(kind, size, opts = {}) {
  let genSize = size;
  if (opts.draft === true) {
    const req = clamp(opts.draftSize ?? 256, 64, size);
    genSize = Math.min(size, 1 << Math.round(Math.log2(req)));
  }
  const buf = bakeBuffers(kind, genSize, opts);

  if (genSize !== size) {
    const n4 = size * size * 4;
    const lift = (src) => (src ? upsampleRGBA(src, genSize, new Uint8Array(n4), size) : null);
    buf.albedo = lift(buf.albedo);
    buf.orm = lift(buf.orm);
    buf.normal = lift(buf.normal);
    buf.height = lift(buf.height);
    buf.thickness = lift(buf.thickness);
    buf.size = size;
  }

  return {
    buf,
    genSize,
    draft: genSize !== size,
    mips: buildMipChains(buf.albedo, buf.orm, buf.normal, size),
  };
}

/**
 * Bake a complete PBR set for a named surface.
 *
 * @param {string} kind one of TEXTURE_KINDS
 * @param {object} [opts] { size, seed, height, draft, draftSize }
 * @returns {object} { map, normalMap, roughnessMap, aoMap, metalnessMap,
 *                     displacementMap, thicknessMap, ormMap, ... }
 *
 * Coverage for the decal-style kinds (spills, chalk, crumbs) rides in the
 * alpha channel of `map`, which three multiplies into diffuseColor for free —
 * a dedicated alphaMap would be a whole extra texture for one channel.
 */
export function makeTextureSet(kind, opts = {}) {
  const k = GEN[kind] ? kind : FALLBACK_KIND;
  const size = resolveSize(k, opts);
  const bake = bakeAtSize(k, size, opts);
  const buf = bake.buf;

  const map = makeTex(buf.albedo, size, true, _anisotropy, bake.mips.albedo);
  const normalMap = makeTex(buf.normal, size, false, _anisotropy, bake.mips.normal);
  const ormMap = makeTex(buf.orm, size, false, _anisotropy, bake.mips.orm);
  const displacementMap = buf.height ? makeTex(buf.height, size, false, _anisotropy) : null;
  const thicknessMap = buf.thickness ? makeTex(buf.thickness, size, false, _anisotropy) : null;

  const set = {
    kind: k,
    size,
    map,
    normalMap,
    // One texture, three roles — see bakeBuffers().
    roughnessMap: ormMap,
    aoMap: ormMap,
    metalnessMap: buf.hasMetal ? ormMap : null,
    ormMap,
    displacementMap,
    thicknessMap,
    alphaMap: null,
    hasAlpha: buf.hasAlpha,
    hasMetal: buf.hasMetal,
    relief: buf.relief,
    tileWorld: buf.tileWorld,
    level: bake.draft ? 0 : 1,
    genSize: bake.genSize,
    seed: opts.seed ?? 0,
    opts: { ...opts },
    textures: [map, normalMap, ormMap],
    bytes: 0,
  };
  if (displacementMap) set.textures.push(displacementMap);
  if (thicknessMap) set.textures.push(thicknessMap);
  set.bytes = estimateBytes(set);

  /**
   * Re-bake at full detail, in place.
   *
   * The pixel dimensions never change — see `upsampleRGBA` for why they must
   * not — so this is a straight data swap into storage the driver has already
   * allocated. The Source objects behind the textures are mutated rather than
   * replaced, so every material and every repeat-clone already pointing at this
   * set picks the sharp pixels up on the next frame without being rebuilt.
   */
  set.upgrade = (_newSize, extra = {}) => {
    if (set.level >= 1 && !extra.force) return set;
    const nb = bakeAtSize(k, set.size, { ...opts, ...extra, draft: false });
    const swap = (tex, data, mips) => {
      if (!tex || !data) return;
      tex.image = { data, width: set.size, height: set.size };
      if (mips && tex.mipmaps.length === mips.length) tex.mipmaps = mips;
      tex.needsUpdate = true;
      // Every repeat-adjusted view of this texture too — see linkDerived().
      const derived = _derived.get(tex);
      if (derived) {
        for (let i = 0; i < derived.length; i++) {
          const d = derived[i];
          if (mips && d.mipmaps.length === mips.length) d.mipmaps = mips;
          d.needsUpdate = true;
        }
      }
    };
    swap(map, nb.buf.albedo, nb.mips.albedo);
    swap(normalMap, nb.buf.normal, nb.mips.normal);
    swap(ormMap, nb.buf.orm, nb.mips.orm);
    if (displacementMap && nb.buf.height) swap(displacementMap, nb.buf.height, null);
    if (thicknessMap && nb.buf.thickness) swap(thicknessMap, nb.buf.thickness, null);
    set.genSize = nb.genSize;
    set.level = 1;
    set.bytes = estimateBytes(set);
    return set;
  };

  set.dispose = () => {
    _liveSets.delete(set);
    for (const t of set.textures) t.dispose();
    set.textures.length = 0;
  };

  _liveSets.add(set);
  return set;
}

/** RGBA bytes plus the 1/3 mip tail, per texture in the set. */
export function estimateBytes(set) {
  let b = 0;
  const seen = new Set();
  for (const t of set.textures) {
    if (seen.has(t)) continue;
    seen.add(t);
    b += set.size * set.size * 4 * 1.34;
  }
  return Math.round(b);
}

export function disposeTextureSet(set) { set?.dispose?.(); }

export function getAnisotropy() { return _anisotropy; }

/* ============================================================ tiling proof */

/**
 * Measure wrap continuity numerically.
 *
 * "Looks seamless" is not a test. For each channel we compare the mean
 * absolute first difference *across* the wrap (column 0 against column N-1)
 * with the mean absolute first difference in the interior. If the field really
 * is periodic those two populations are drawn from the same distribution and
 * the ratio is ~1. A cross-faded or non-periodic field spikes well above 1 —
 * a hard discontinuity typically lands between 5x and 50x.
 *
 * The second difference is checked the same way, which catches C1 breaks (a
 * crease that matches in value but not in slope) that a value-only test misses.
 *
 * @returns {object} per-channel ratios plus a pass/fail against `tolerance`
 */
export function verifyTiling(kind, opts = {}) {
  const k = GEN[kind] ? kind : FALLBACK_KIND;
  const size = clamp(opts.size ?? 256, 64, 1024);
  const buf = bakeBuffers(k, 1 << Math.round(Math.log2(size)), { ...opts, keepFields: true, height: false });
  const f = buf.fields;
  const n = buf.size;
  const tolerance = opts.tolerance ?? 1.65;

  const report = { kind: k, size: n, channels: {}, worst: 0, pass: true };

  const check = (name, a) => {
    let seam1 = 0, in1 = 0, seam2 = 0, in2 = 0;
    // Columns
    for (let y = 0; y < n; y++) {
      const row = y * n;
      seam1 += Math.abs(a[row] - a[row + n - 1]);
      seam2 += Math.abs(a[row + 1] - 2 * a[row] + a[row + n - 1]);
      for (let x = 1; x < n - 1; x++) {
        in1 += Math.abs(a[row + x] - a[row + x - 1]);
        in2 += Math.abs(a[row + x + 1] - 2 * a[row + x] + a[row + x - 1]);
      }
    }
    // Rows
    for (let x = 0; x < n; x++) {
      seam1 += Math.abs(a[x] - a[(n - 1) * n + x]);
      seam2 += Math.abs(a[n + x] - 2 * a[x] + a[(n - 1) * n + x]);
      for (let y = 1; y < n - 1; y++) {
        in1 += Math.abs(a[y * n + x] - a[(y - 1) * n + x]);
        in2 += Math.abs(a[(y + 1) * n + x] - 2 * a[y * n + x] + a[(y - 1) * n + x]);
      }
    }
    const seamCount = n * 2;
    const inCount = n * (n - 2) * 2;
    const m1 = seam1 / seamCount, b1 = in1 / inCount || 1e-9;
    const m2 = seam2 / seamCount, b2 = in2 / inCount || 1e-9;
    const r1 = m1 / b1, r2 = m2 / b2;
    report.channels[name] = { valueRatio: +r1.toFixed(4), slopeRatio: +r2.toFixed(4) };
    const worst = Math.max(r1, r2);
    if (worst > report.worst) report.worst = +worst.toFixed(4);
    if (worst > tolerance) report.pass = false;
  };

  check('height', f.h);
  check('albedoR', f.r);
  check('roughness', f.rough);
  check('ao', f.ao);
  return report;
}

/** Run the wrap proof across every kind. Used by the dev overlay. */
export function verifyAllTiling(opts = {}) {
  const out = [];
  for (const kind of TEXTURE_KINDS) {
    try {
      out.push(verifyTiling(kind, opts));
    } catch (err) {
      out.push({ kind, pass: false, error: String(err && (err.message || err)) });
    }
  }
  return out;
}

export const ProcTex = {
  makeTextureSet,
  disposeTextureSet,
  linkDerived,
  estimateBytes,
  verifyTiling,
  verifyAllTiling,
  setAnisotropy,
  getAnisotropy,
  hasKind,
  defaultsFor,
  TEXTURE_KINDS,
  GEN_DEF,
  // Building blocks other texture-owning systems (decals, particles) can reuse.
  rgb,
  clamp,
  saturate,
  lerp,
  smoothstep,
};

export default ProcTex;
