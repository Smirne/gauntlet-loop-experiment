// core/Random.js — deterministic randomness and the noise field library.
//
// Everything procedural in this game — every texture, every scattered crumb,
// every AI mistake — draws from here. Two rules follow from that:
//
//   * Determinism. The same seed produces the same bytes on every machine and
//     every run. No Math.random() anywhere in the codebase.
//   * Seamlessness. Textures are tiled across metre-scale surfaces at
//     centimetre scale, so a visible repeat seam is an instant fail. Every
//     noise function here has a `...Tiled` sibling that wraps *exactly* on a
//     given integer period — not a cross-faded approximation.
//
// Two families of tileable noise are provided, because they trade off:
//
//   perlin/value/worley Tiled  — the lattice indices are wrapped with a modulo
//     before hashing. Exactly periodic, cheap (a 2048² fbm at 6 octaves is
//     roughly a second), very slightly axis-biased.
//   simplex2DTiled / fbmTorus2D — the 2D plane is mapped onto a 4D torus and
//     sampled with 4D simplex noise. Exactly periodic *and* isotropic, no
//     lattice direction bias at all, about 3x the cost. Use it where a
//     directional artefact would read as wrong (felt, sand, brushed metal at
//     an angle).
//
// All functions are allocation-free on the hot path. The one exception is
// worley2DFull, which returns a shared result object — copy it if you keep it.

/* ---------------------------------------------------------------- primitives */

export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function saturate(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function fract(v) { return v - Math.floor(v); }
export function mix(a, b, t) { return a + (b - a) * t; }
export function remap(v, a, b, c, d) { return c + ((v - a) / (b - a)) * (d - c); }
export function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function smootherstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Perlin's quintic fade — C2 continuous, which is what keeps derived normal
 *  maps free of the faceting you get from a cubic fade. */
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function wrapi(v, p) {
  const r = v % p;
  return r < 0 ? r + p : r;
}

/* --------------------------------------------------------------------- seeds */

/** Turn anything (number, string, array, {seed}) into a uint32. */
export function hashSeed(seed) {
  if (seed === undefined || seed === null) return 0x2f6e2b1;
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) return 0x9e3779b9;
    // Fold the fractional part in so 1.5 and 1 do not collide.
    const i = Math.floor(seed);
    const f = Math.round((seed - i) * 0x7fffffff);
    let h = Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(f | 0, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  if (typeof seed === 'object') {
    if ('seed' in seed) return hashSeed(seed.seed);
    return hashSeed(String(seed));
  }
  const str = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Bare mulberry32 stream. Fast, tiny state, passes the smallcrush-level tests
 *  we actually care about (uniformity and lack of low-bit structure). */
export function mulberry32(seed) {
  let s = hashSeed(seed) | 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Full-fat seeded generator.
 * @param {number|string} seed
 * @returns {object} rng
 */
export function makeRng(seed = 0) {
  let s = hashSeed(seed) | 0;
  const initial = s;
  let spare = null; // cached second Box-Muller sample

  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = {
    /** the uint32 the stream was seeded from */
    seed: initial >>> 0,

    /** uniform in [0, 1) */
    next,
    float: next,

    /** uniform uint32 */
    uint() {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    },

    /** uniform in [a, b) */
    range(a, b) { return a + (b - a) * next(); },

    /** uniform integer in [a, b] — both ends inclusive */
    int(a, b) { return a + Math.floor(next() * (b - a + 1)); },

    /** uniform integer in [0, n) */
    index(n) { const i = Math.floor(next() * n); return i >= n ? n - 1 : i; },

    /** -1 or +1 */
    sign() { return next() < 0.5 ? -1 : 1; },

    /** true with probability p */
    bool(p = 0.5) { return next() < p; },
    chance(p = 0.5) { return next() < p; },

    pick(arr) {
      if (!arr || arr.length === 0) return undefined;
      const i = Math.floor(next() * arr.length);
      return arr[i >= arr.length ? arr.length - 1 : i];
    },

    /** pick(arr) weighted by a parallel array of non-negative weights */
    weighted(arr, weights) {
      if (!arr || arr.length === 0) return undefined;
      let total = 0;
      for (let i = 0; i < arr.length; i++) total += weights[i] || 0;
      if (total <= 0) return rng.pick(arr);
      let r = next() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= weights[i] || 0;
        if (r <= 0) return arr[i];
      }
      return arr[arr.length - 1];
    },

    /** Fisher-Yates, in place, returns the same array */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },

    /** normal distribution, Box-Muller with a cached spare */
    gauss(mean = 0, sd = 1) {
      if (spare !== null) { const v = spare; spare = null; return mean + sd * v; }
      let u = 0, v = 0, m = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        m = u * u + v * v;
      } while (m >= 1 || m === 0);
      const f = Math.sqrt((-2 * Math.log(m)) / m);
      spare = v * f;
      return mean + sd * u * f;
    },

    /** clamped normal — useful for AI skill jitter that must stay in range */
    gaussClamped(mean, sd, lo, hi) { return clamp(rng.gauss(mean, sd), lo, hi); },

    /** unit vector, written into `out` if given */
    unit2(out) {
      const a = next() * TAU;
      const x = Math.cos(a), y = Math.sin(a);
      if (out) { out.x = x; out.y = y; return out; }
      return { x, y };
    },

    /** uniform point inside a disc of radius r */
    inDisc(r = 1, out) {
      const a = next() * TAU;
      const d = r * Math.sqrt(next());
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (out) { out.x = x; out.y = y; return out; }
      return { x, y };
    },

    /**
     * Derive an independent named stream. Lets one track seed produce stable
     * sub-seeds ('props', 'crumbs', 'liveries') that do not shift when an
     * unrelated system changes how many numbers it draws.
     */
    fork(tag) { return makeRng((initial ^ hashSeed(tag)) >>> 0); },

    /** snapshot / restore, for replayable sequences */
    state() { return s; },
    setState(v) { s = v | 0; spare = null; return rng; },
    reset() { s = initial; spare = null; return rng; },
  };

  return rng;
}

/* ------------------------------------------------------------ integer hashes */

/** uint32 hash of a 2D integer lattice point. */
export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** uint32 hash of a 3D integer lattice point. */
export function hash3i(x, y, z, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** hash of a lattice point as a float in [0, 1) */
export function hash01(x, y, seed = 0) { return hash2i(x, y, seed) / 4294967296; }

/* ---------------------------------------------------------------- value noise */

/**
 * Value noise in [0, 1]. Quintic-faded, so its gradient is continuous and it
 * can safely be differenced into a normal map.
 */
export function value2D(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const a = hash2i(ix, iy, seed);
  const b = hash2i(ix + 1, iy, seed);
  const c = hash2i(ix, iy + 1, seed);
  const d = hash2i(ix + 1, iy + 1, seed);
  const k = 1 / 4294967296;
  const top = (a * k) + ((b - a) * k) * u;
  const bot = (c * k) + ((d - c) * k) * u;
  return top + (bot - top) * v;
}

/** Value noise that wraps exactly every `period` units in both axes. */
export function value2DTiled(x, y, period, seed = 0) {
  const p = Math.max(1, Math.round(period));
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const x0 = wrapi(ix, p), x1 = wrapi(ix + 1, p);
  const y0 = wrapi(iy, p), y1 = wrapi(iy + 1, p);
  const k = 1 / 4294967296;
  const a = hash2i(x0, y0, seed) * k;
  const b = hash2i(x1, y0, seed) * k;
  const c = hash2i(x0, y1, seed) * k;
  const d = hash2i(x1, y1, seed) * k;
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/* -------------------------------------------------------------- perlin (grad) */

// Eight unit gradients: axes plus diagonals. Unit length keeps the output
// symmetric so the sqrt(2) normalisation below is exact.
const R2 = Math.SQRT1_2;
const GRAD2 = new Float32Array([
  1, 0, -1, 0, 0, 1, 0, -1,
  R2, R2, -R2, R2, R2, -R2, -R2, -R2,
]);
const PERLIN_NORM = Math.SQRT2; // 2D perlin with unit gradients peaks at 1/sqrt(2)

function gdot(h, dx, dy) {
  const i = (h & 7) << 1;
  return GRAD2[i] * dx + GRAD2[i + 1] * dy;
}

/** Gradient (Perlin) noise in [-1, 1]. */
export function perlin2D(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const n00 = gdot(hash2i(ix, iy, seed), fx, fy);
  const n10 = gdot(hash2i(ix + 1, iy, seed), fx - 1, fy);
  const n01 = gdot(hash2i(ix, iy + 1, seed), fx, fy - 1);
  const n11 = gdot(hash2i(ix + 1, iy + 1, seed), fx - 1, fy - 1);
  const top = n00 + (n10 - n00) * u;
  const bot = n01 + (n11 - n01) * u;
  return (top + (bot - top) * v) * PERLIN_NORM;
}

/** Gradient noise that wraps exactly every `periodX`/`periodY` units. */
export function perlin2DTiled(x, y, periodX, periodY = periodX, seed = 0) {
  const px = Math.max(1, Math.round(periodX));
  const py = Math.max(1, Math.round(periodY));
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const x0 = wrapi(ix, px), x1 = wrapi(ix + 1, px);
  const y0 = wrapi(iy, py), y1 = wrapi(iy + 1, py);
  const n00 = gdot(hash2i(x0, y0, seed), fx, fy);
  const n10 = gdot(hash2i(x1, y0, seed), fx - 1, fy);
  const n01 = gdot(hash2i(x0, y1, seed), fx, fy - 1);
  const n11 = gdot(hash2i(x1, y1, seed), fx - 1, fy - 1);
  const top = n00 + (n10 - n00) * u;
  const bot = n01 + (n11 - n01) * u;
  return (top + (bot - top) * v) * PERLIN_NORM;
}

/* -------------------------------------------------------------------- simplex */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;
const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

// 12 gradients of length sqrt(2), the standard set for 2D/3D simplex.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// 32 gradients of length sqrt(3) for 4D.
const GRAD4 = new Float32Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);

const _permCache = new Map();
const PERM_CACHE_MAX = 24;

function permFor(seed) {
  const key = hashSeed(seed);
  const hit = _permCache.get(key);
  if (hit !== undefined) return hit;

  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  const rnd = mulberry32(key ^ 0x9e3779b9);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const pm12 = new Uint8Array(512);
  const pm32 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    const v = p[i & 255];
    perm[i] = v;
    pm12[i] = v % 12;
    pm32[i] = v & 31;
  }
  const entry = { perm, pm12, pm32 };
  if (_permCache.size >= PERM_CACHE_MAX) {
    _permCache.delete(_permCache.keys().next().value);
  }
  _permCache.set(key, entry);
  return entry;
}

/** 2D simplex noise in [-1, 1]. Isotropic — no lattice direction bias. */
export function simplex2D(xin, yin, seed = 0) {
  const tbl = permFor(seed);
  const perm = tbl.perm, pm12 = tbl.pm12;

  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);

  let i1 = 0, j1 = 1;
  if (x0 > y0) { i1 = 1; j1 = 0; }

  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;

  const ii = i & 255, jj = j & 255;
  let n = 0;

  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = pm12[ii + perm[jj]] * 3;
    t0 *= t0;
    n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = pm12[ii + i1 + perm[jj + j1]] * 3;
    t1 *= t1;
    n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = pm12[ii + 1 + perm[jj + 1]] * 3;
    t2 *= t2;
    n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2);
  }
  return 70 * n;
}

/** 3D simplex noise in [-1, 1]. Third axis is handy as an animation clock. */
export function simplex3D(xin, yin, zin, seed = 0) {
  const tbl = permFor(seed);
  const perm = tbl.perm, pm12 = tbl.pm12;

  const s = (xin + yin + zin) * F3;
  const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
  const t = (i + j + k) * G3;
  const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);

  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }

  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

  const ii = i & 255, jj = j & 255, kk = k & 255;
  let n = 0;

  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0) {
    const g = pm12[ii + perm[jj + perm[kk]]] * 3;
    t0 *= t0;
    n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0) {
    const g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    t1 *= t1;
    n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0) {
    const g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    t2 *= t2;
    n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0) {
    const g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
    t3 *= t3;
    n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
  }
  return 32 * n;
}

/** 4D simplex noise in [-1, 1]. Exists so 2D noise can be wrapped on a torus. */
export function simplex4D(xin, yin, zin, win, seed = 0) {
  const tbl = permFor(seed);
  const perm = tbl.perm, pm32 = tbl.pm32;

  const s = (xin + yin + zin + win) * F4;
  const i = Math.floor(xin + s), j = Math.floor(yin + s);
  const k = Math.floor(zin + s), l = Math.floor(win + s);
  const t = (i + j + k + l) * G4;
  const x0 = xin - (i - t), y0 = yin - (j - t);
  const z0 = zin - (k - t), w0 = win - (l - t);

  // Rank the four coordinates by magnitude; the ranks give the traversal order
  // through the simplex without needing the 64-entry lookup table.
  let rx = 0, ry = 0, rz = 0, rw = 0;
  if (x0 > y0) rx++; else ry++;
  if (x0 > z0) rx++; else rz++;
  if (x0 > w0) rx++; else rw++;
  if (y0 > z0) ry++; else rz++;
  if (y0 > w0) ry++; else rw++;
  if (z0 > w0) rz++; else rw++;

  const i1 = rx >= 3 ? 1 : 0, j1 = ry >= 3 ? 1 : 0, k1 = rz >= 3 ? 1 : 0, l1 = rw >= 3 ? 1 : 0;
  const i2 = rx >= 2 ? 1 : 0, j2 = ry >= 2 ? 1 : 0, k2 = rz >= 2 ? 1 : 0, l2 = rw >= 2 ? 1 : 0;
  const i3 = rx >= 1 ? 1 : 0, j3 = ry >= 1 ? 1 : 0, k3 = rz >= 1 ? 1 : 0, l3 = rw >= 1 ? 1 : 0;

  const x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
  const x2 = x0 - i2 + 2 * G4, y2 = y0 - j2 + 2 * G4, z2 = z0 - k2 + 2 * G4, w2 = w0 - l2 + 2 * G4;
  const x3 = x0 - i3 + 3 * G4, y3 = y0 - j3 + 3 * G4, z3 = z0 - k3 + 3 * G4, w3 = w0 - l3 + 3 * G4;
  const x4 = x0 - 1 + 4 * G4, y4 = y0 - 1 + 4 * G4, z4 = z0 - 1 + 4 * G4, w4 = w0 - 1 + 4 * G4;

  const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
  let n = 0;

  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
  if (t0 > 0) {
    const g = pm32[ii + perm[jj + perm[kk + perm[ll]]]] << 2;
    t0 *= t0;
    n += t0 * t0 * (GRAD4[g] * x0 + GRAD4[g + 1] * y0 + GRAD4[g + 2] * z0 + GRAD4[g + 3] * w0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
  if (t1 > 0) {
    const g = pm32[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]]] << 2;
    t1 *= t1;
    n += t1 * t1 * (GRAD4[g] * x1 + GRAD4[g + 1] * y1 + GRAD4[g + 2] * z1 + GRAD4[g + 3] * w1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
  if (t2 > 0) {
    const g = pm32[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]]] << 2;
    t2 *= t2;
    n += t2 * t2 * (GRAD4[g] * x2 + GRAD4[g + 1] * y2 + GRAD4[g + 2] * z2 + GRAD4[g + 3] * w2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
  if (t3 > 0) {
    const g = pm32[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]]] << 2;
    t3 *= t3;
    n += t3 * t3 * (GRAD4[g] * x3 + GRAD4[g + 1] * y3 + GRAD4[g + 2] * z3 + GRAD4[g + 3] * w3);
  }
  let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
  if (t4 > 0) {
    const g = pm32[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]]] << 2;
    t4 *= t4;
    n += t4 * t4 * (GRAD4[g] * x4 + GRAD4[g + 1] * y4 + GRAD4[g + 2] * z4 + GRAD4[g + 3] * w4);
  }
  return 27 * n;
}

/**
 * Isotropic tileable simplex, in [-1, 1].
 *
 * (x, y) is wrapped onto a 4D torus: x runs around one circle of radius
 * periodX/2pi, y around another. Because arc length per unit input is exactly 1
 * the feature scale matches plain simplex2D, and because both circles close,
 * the result is exactly periodic with no seam and no cross-fade ghosting.
 */
export function simplex2DTiled(x, y, periodX, periodY = periodX, seed = 0) {
  const px = periodX > 0 ? periodX : 1;
  const py = periodY > 0 ? periodY : 1;
  const rx = px / TAU, ry = py / TAU;
  const ax = (x / px) * TAU, ay = (y / py) * TAU;
  return simplex4D(Math.cos(ax) * rx, Math.sin(ax) * rx, Math.cos(ay) * ry, Math.sin(ay) * ry, seed);
}

/* ------------------------------------------------------------------- fractals */

/**
 * Fractional Brownian motion over simplex noise. Result in [-1, 1].
 * @param {number} octaves how many layers
 * @param {number} lacunarity frequency multiplier per octave (2 is standard)
 * @param {number} gain amplitude multiplier per octave (0.5 is standard)
 */
export function fbm2D(x, y, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    sum += amp * simplex2D(fx, fy, seed + i * 1013);
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Tileable fbm over wrapped gradient noise. Result in [-1, 1].
 *
 * `period` is in noise cells: sample with x in [0, period) across the texture
 * and the result wraps exactly. Each octave's period is rounded to an integer
 * and the coordinate rescaled to match, so any lacunarity still tiles exactly.
 */
export function fbm2DTiled(x, y, period, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  const base = Math.max(1, Math.round(period));
  let sum = 0, amp = 1, norm = 0, freq = 1;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(1, Math.round(base * freq));
    const s = p / base; // exact integer period in input space
    sum += amp * perlin2DTiled(x * s, y * s, p, p, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Tileable *and* isotropic fbm via the 4D torus. ~3x the cost of fbm2DTiled. */
export function fbmTorus2D(x, y, period, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  const p = period > 0 ? period : 1;
  const rBase = p / TAU;
  const ax = (x / p) * TAU, ay = (y / p) * TAU;
  const cax = Math.cos(ax), sax = Math.sin(ax);
  const cay = Math.cos(ay), say = Math.sin(ay);
  let sum = 0, amp = 1, norm = 0, freq = 1;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    const r = rBase * freq;
    sum += amp * simplex4D(cax * r, sax * r, cay * r, say * r, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal in [0, 1]. Sharp creases along the zero crossings —
 * the backbone of wood grain, cracked soil, brushed metal and scratches.
 */
export function ridged2D(x, y, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, sharpness = 2) {
  let sum = 0, amp = 0.5, norm = 0, weight = 1, fx = x, fy = y;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    let v = 1 - Math.abs(simplex2D(fx, fy, seed + i * 1013));
    v *= v;
    if (sharpness !== 2) v = Math.pow(v, sharpness * 0.5);
    v *= weight;
    weight = clamp(v * 2, 0, 1); // feeds detail into the crests only
    sum += v * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? clamp(sum / norm, 0, 1) : 0;
}

/** Tileable ridged multifractal in [0, 1]. */
export function ridged2DTiled(x, y, period, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, sharpness = 2) {
  const base = Math.max(1, Math.round(period));
  let sum = 0, amp = 0.5, norm = 0, weight = 1, freq = 1;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(1, Math.round(base * freq));
    const s = p / base;
    let v = 1 - Math.abs(perlin2DTiled(x * s, y * s, p, p, seed + i * 1013));
    v *= v;
    if (sharpness !== 2) v = Math.pow(v, sharpness * 0.5);
    v *= weight;
    weight = clamp(v * 2, 0, 1);
    sum += v * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? clamp(sum / norm, 0, 1) : 0;
}

/** Billowy (absolute-value) fbm in [0, 1] — clouds, foam, cut grass, felt pile. */
export function billow2D(x, y, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    sum += amp * Math.abs(simplex2D(fx, fy, seed + i * 1013));
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Tileable billow in [0, 1]. */
export function billow2DTiled(x, y, period, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  const base = Math.max(1, Math.round(period));
  let sum = 0, amp = 1, norm = 0, freq = 1;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(1, Math.round(base * freq));
    const s = p / base;
    sum += amp * Math.abs(perlin2DTiled(x * s, y * s, p, p, seed + i * 1013));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/* --------------------------------------------------------------- domain warp */

/**
 * fbm sampled through an fbm-displaced domain. Turns the uniform "cloud" look
 * into something with flow and structure: marbling in wood, swirl in spilled
 * milk, the drag pattern in a rug pile.
 * `warp` is the displacement in noise cells (0.3-1.5 is the useful band).
 */
export function warpFbm2D(x, y, warp = 0.6, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  const wx = fbm2D(x + 5.2, y + 1.3, 3, 2, 0.5, seed + 9173);
  const wy = fbm2D(x + 1.7, y + 9.2, 3, 2, 0.5, seed + 3319);
  return fbm2D(x + warp * wx, y + warp * wy, octaves, lacunarity, gain, seed);
}

/**
 * Tileable domain warp. Stays exactly periodic because the displacement field
 * is itself periodic with the same period: f(x+p + w(x+p)) === f(x + w(x)).
 */
export function warpFbm2DTiled(x, y, period, warp = 0.6, octaves = 5, lacunarity = 2, gain = 0.5, seed = 0) {
  const p = Math.max(1, Math.round(period));
  const wx = fbm2DTiled(x + 5.2, y + 1.3, p, 3, 2, 0.5, seed + 9173);
  const wy = fbm2DTiled(x + 1.7, y + 9.2, p, 3, 2, 0.5, seed + 3319);
  return fbm2DTiled(x + warp * wx, y + warp * wy, p, octaves, lacunarity, gain, seed);
}

/* ------------------------------------------------------------------- cellular */

// Shared result object: worley is called millions of times when baking a 2048²
// texture and per-call allocation would dominate the cost. Copy before storing.
const _cell = { f1: 0, f2: 0, edge: 0, id: 0, cellX: 0, cellY: 0, dx: 0, dy: 0 };

/**
 * Full cellular/Worley evaluation.
 * @param {object} [opts] { jitter=1, metric='euclidean'|'manhattan'|'chebyshev', period=0 }
 * @returns {object} SHARED result — { f1, f2, edge, id, cellX, cellY, dx, dy }
 */
export function worley2DFull(x, y, seed = 0, opts) {
  const jitter = opts?.jitter ?? 1;
  const metric = opts?.metric ?? 'euclidean';
  const period = opts?.period ?? 0;
  const p = period > 0 ? Math.max(1, Math.round(period)) : 0;

  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, bx = 0, by = 0, bid = 0, bdx = 0, bdy = 0;

  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const hx = p > 0 ? wrapi(cx, p) : cx;
      const hy = p > 0 ? wrapi(cy, p) : cy;
      const h = hash2i(hx, hy, seed);
      // Two independent 16-bit fields drive the feature point offset.
      const jx = ((h & 0xffff) / 65536 - 0.5) * jitter;
      const jy = (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
      const px = cx + 0.5 + jx;
      const py = cy + 0.5 + jy;
      const dx = px - x, dy = py - y;
      let d;
      if (metric === 'manhattan') d = Math.abs(dx) + Math.abs(dy);
      else if (metric === 'chebyshev') d = Math.max(Math.abs(dx), Math.abs(dy));
      else d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1; f1 = d;
        bx = hx; by = hy; bid = h; bdx = dx; bdy = dy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }

  _cell.f1 = f1;
  _cell.f2 = f2;
  _cell.edge = f2 - f1;
  _cell.id = bid >>> 0;
  _cell.cellX = bx;
  _cell.cellY = by;
  _cell.dx = bdx;
  _cell.dy = bdy;
  return _cell;
}

/** Distance to the nearest feature point, clamped to [0, 1]. */
export function worley2D(x, y, seed = 0) {
  const c = worley2DFull(x, y, seed);
  return c.f1 > 1 ? 1 : c.f1;
}

/** Tileable Worley: cell indices are wrapped before hashing, so it is exact. */
export function worley2DTiled(x, y, period, seed = 0) {
  const c = worley2DFull(x, y, seed, { period });
  return c.f1 > 1 ? 1 : c.f1;
}

/** F2 - F1: bright seams between cells. Grout lines, cracked mud, leather. */
export function worleyEdge2D(x, y, seed = 0, period = 0) {
  const c = worley2DFull(x, y, seed, { period });
  return c.edge > 1 ? 1 : c.edge;
}

/** Per-cell random value in [0, 1) — flat cell colours for tiles and pebbles. */
export function worleyCell2D(x, y, seed = 0, period = 0) {
  const c = worley2DFull(x, y, seed, { period });
  return (hash2i(c.cellX, c.cellY, seed ^ 0x5bf03635) / 4294967296);
}

/**
 * Ridged Worley: sharp cell boundaries stacked over octaves. This is what makes
 * gravel, crumbs and coarse sand read as discrete grains rather than as noise.
 */
export function worleyFbm2D(x, y, octaves = 3, lacunarity = 2, gain = 0.5, seed = 0, period = 0) {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  const base = period > 0 ? Math.max(1, Math.round(period)) : 0;
  const n = octaves | 0;
  for (let i = 0; i < n; i++) {
    let v;
    if (base > 0) {
      const p = Math.max(1, Math.round(base * freq));
      const s = p / base;
      v = worley2DFull(x * s, y * s, seed + i * 7919, { period: p }).f1;
    } else {
      v = worley2DFull(x * freq, y * freq, seed + i * 7919).f1;
    }
    sum += amp * (v > 1 ? 1 : v);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/* ------------------------------------------------------------ point sampling */

/**
 * Bridson Poisson-disc sampling: blue-noise points with a guaranteed minimum
 * separation. Scattering props or crumbs with plain uniform random gives
 * clumps and holes that read as cheap; this does not.
 *
 * @param {number} width  domain width
 * @param {number} height domain height
 * @param {number} radius minimum distance between points
 * @param {object|Function} rng makeRng() instance or a ()=>[0,1) function
 * @param {object} [opts] { tries = 24, tileable = false }
 * @returns {Float32Array} xy pairs, length = 2 * count
 */
export function poissonDisk2D(width, height, radius, rng, opts = {}) {
  const tries = opts.tries ?? 24;
  const tile = !!opts.tileable;
  const rnd = typeof rng === 'function' ? rng : (rng && rng.next ? () => rng.next() : mulberry32(1337));

  const r2 = radius * radius;
  const cell = radius / Math.SQRT2;
  const gw = Math.max(1, Math.ceil(width / cell));
  const gh = Math.max(1, Math.ceil(height / cell));
  // Cells are shrunk to divide the domain exactly. Without this the grid would
  // overhang the right/bottom edge and the toroidal neighbour lookup would not
  // line up with the toroidal distance wrap, letting pairs sit too close across
  // the seam. Shrinking only makes cells smaller, so the "at most one point per
  // cell" invariant still holds.
  const cellX = width / gw;
  const cellY = height / gh;
  const grid = new Int32Array(gw * gh).fill(-1);

  const px = [];
  const py = [];
  const active = [];

  const gridIndex = (gx, gy) => (tile ? wrapi(gy, gh) * gw + wrapi(gx, gw) : gy * gw + gx);

  const spanX = Math.ceil(radius / cellX);
  const spanY = Math.ceil(radius / cellY);

  const fits = (x, y) => {
    const gx = Math.floor(x / cellX), gy = Math.floor(y / cellY);
    for (let oy = -spanY; oy <= spanY; oy++) {
      for (let ox = -spanX; ox <= spanX; ox++) {
        const nx = gx + ox, ny = gy + oy;
        if (!tile && (nx < 0 || ny < 0 || nx >= gw || ny >= gh)) continue;
        const id = grid[gridIndex(nx, ny)];
        if (id < 0) continue;
        let dx = px[id] - x, dy = py[id] - y;
        if (tile) {
          if (dx > width * 0.5) dx -= width; else if (dx < -width * 0.5) dx += width;
          if (dy > height * 0.5) dy -= height; else if (dy < -height * 0.5) dy += height;
        }
        if (dx * dx + dy * dy < r2) return false;
      }
    }
    return true;
  };

  const push = (x, y) => {
    const id = px.length;
    px.push(x); py.push(y);
    grid[gridIndex(Math.floor(x / cellX), Math.floor(y / cellY))] = id;
    active.push(id);
  };

  push(rnd() * width, rnd() * height);

  while (active.length > 0) {
    const ai = Math.floor(rnd() * active.length);
    const id = active[ai];
    let placed = false;
    for (let t = 0; t < tries; t++) {
      const a = rnd() * TAU;
      const d = radius * (1 + rnd()); // annulus [r, 2r)
      let nx = px[id] + Math.cos(a) * d;
      let ny = py[id] + Math.sin(a) * d;
      if (tile) { nx = wrapi(nx, width); ny = wrapi(ny, height); }
      else if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!fits(nx, ny)) continue;
      push(nx, ny);
      placed = true;
      break;
    }
    if (!placed) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }

  const out = new Float32Array(px.length * 2);
  for (let i = 0; i < px.length; i++) {
    out[i * 2] = px[i];
    out[i * 2 + 1] = py[i];
  }
  return out;
}

/**
 * Jittered grid — the cheap, always-tileable cousin of Poisson discs. Good for
 * thousands of scatter points (grass tufts, sawdust) where exact separation
 * does not matter but visible rows would.
 * @returns {Float32Array} xy pairs in [0, cols) x [0, rows)
 */
export function jitteredGrid2D(cols, rows, jitter = 0.85, seed = 0) {
  const out = new Float32Array(cols * rows * 2);
  let w = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const h = hash2i(x, y, seed);
      const jx = ((h & 0xffff) / 65536 - 0.5) * jitter;
      const jy = (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
      out[w++] = x + 0.5 + jx;
      out[w++] = y + 0.5 + jy;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- convenience */

/** Bundle of the tileable generators pre-bound to one period and seed.
 *  ProcTex can hand this to a per-surface generator and forget the plumbing. */
export function makeNoise2D(period, seed = 0) {
  const p = Math.max(1, Math.round(period));
  return {
    period: p,
    seed,
    value: (x, y) => value2DTiled(x, y, p, seed),
    perlin: (x, y) => perlin2DTiled(x, y, p, p, seed),
    simplex: (x, y) => simplex2DTiled(x, y, p, p, seed),
    fbm: (x, y, o = 5, l = 2, g = 0.5) => fbm2DTiled(x, y, p, o, l, g, seed),
    fbmIso: (x, y, o = 5, l = 2, g = 0.5) => fbmTorus2D(x, y, p, o, l, g, seed),
    ridged: (x, y, o = 5, l = 2, g = 0.5, sharp = 2) => ridged2DTiled(x, y, p, o, l, g, seed, sharp),
    billow: (x, y, o = 5, l = 2, g = 0.5) => billow2DTiled(x, y, p, o, l, g, seed),
    warp: (x, y, w = 0.6, o = 5, l = 2, g = 0.5) => warpFbm2DTiled(x, y, p, w, o, l, g, seed),
    worley: (x, y) => worley2DTiled(x, y, p, seed),
    worleyEdge: (x, y) => worleyEdge2D(x, y, seed, p),
    worleyCell: (x, y) => worleyCell2D(x, y, seed, p),
    worleyFbm: (x, y, o = 3, l = 2, g = 0.5) => worleyFbm2D(x, y, o, l, g, seed, p),
    cell: (x, y, opts) => worley2DFull(x, y, seed, { period: p, ...opts }),
  };
}

/** Default process-wide stream. Prefer ctx.rng; this is for one-off tools. */
export const rng = makeRng(20260730);

export default {
  makeRng, mulberry32, hashSeed,
  value2D, value2DTiled,
  perlin2D, perlin2DTiled,
  simplex2D, simplex3D, simplex4D, simplex2DTiled,
  fbm2D, fbm2DTiled, fbmTorus2D,
  ridged2D, ridged2DTiled,
  billow2D, billow2DTiled,
  warpFbm2D, warpFbm2DTiled,
  worley2D, worley2DTiled, worley2DFull, worleyEdge2D, worleyCell2D, worleyFbm2D,
  poissonDisk2D, jitteredGrid2D, makeNoise2D,
  clamp, saturate, lerp, mix, fract, remap, smoothstep, smootherstep,
};
