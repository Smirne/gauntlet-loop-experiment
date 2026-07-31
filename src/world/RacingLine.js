// world/RacingLine.js — the line a good driver would actually take.
//
// Not the centreline. The centreline is where the track is; the racing line is
// where the *speed* is, and the two agree almost nowhere. What follows is the
// standard two-stage treatment used by real lap-time simulation:
//
//   1. Geometry. Parameterise the line by one lateral offset per node and
//      minimise a blend of squared curvature and squared length subject to the
//      offsets staying inside the drivable corridor. Both terms are convex
//      quadratics and the corridor is a box, so the problem is convex — there
//      is exactly one optimum and no initial guess can strand us in a local
//      minimum. Minimum curvature alone gives the classic wide-entry /
//      late-apex / wide-exit shape; a minority weight on length pulls it back
//      from the slightly-too-generous pure-curvature answer, which is what real
//      solvers do too.
//
//   2. Speed. Curvature caps cornering speed at sqrt(aLat/kappa). A backward
//      pass then enforces the braking limit and a forward pass the traction
//      limit, both using a friction ellipse so grip spent on cornering is not
//      also spent on braking. Two wrapped passes each, because on a closed
//      circuit the profile has to be consistent across the start line as well.
//
// The solver is projected Gauss-Seidel with over-relaxation over the banded
// normal equations, run coarse-to-fine. Plain gradient descent converges the
// short-wavelength shape quickly but crawls on the long sweeps — the fourth
// difference operator's smallest eigenvalues are ~(2*pi/M)^4 — so the coarse
// levels exist to converge those cheaply and hand them down.
//
// Consumed by ai/Driver.js (target point + target speed) and ui/HUD.js (the
// minimap trace).

import * as THREE from 'three';
import { clamp, lerp } from '../core/Random.js';
import {
  PolylineIndex, makeClosedCurve, buildArcTable, uAtDistance,
  smoothClosed, wrap01, cyclicDelta, surfaceInfo,
} from './Track.js';

/* ------------------------------------------------------------------ tuning */

const NODE_PITCH = 3.0;        // solver node spacing in world units
const FRAME_PITCH = 1.6;       // output frame spacing
const MIN_NODES = 96;
const MAX_NODES = 1280;

const CAR_HALF_WIDTH = 2.0;    // a car is 4 u wide
const EDGE_MARGIN = 1.15;      // how much clean track to leave outside the tyre

const CURV_WEIGHT = 1.0;
const LEN_WEIGHT = 0.22;       // 0 = pure minimum curvature, 1 = rubber band
const SOR = 1.55;              // over-relaxation factor for the Gauss-Seidel sweeps

// Vehicle envelope the speed profile is planned against. These describe the
// *reference* car the line is drawn for; individual chassis differ, and
// ai/Driver.js scales the result by driver skill.
const DEFAULT_LIMITS = {
  vMax: 104,        // u/s
  aLat: 155,        // u/s^2 lateral, on grip 1.0 — ~0.6 g at our 260 gravity
  aBrake: 235,      // u/s^2
  aDrive: 105,      // u/s^2 at low speed
  powerV: 55,       // above this, drive force is power- not traction-limited
};

const EPS_CURV = 1e-5;

/* ------------------------------------------------------------ module scratch */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

const SAMPLE_RING = 16;
const _ring = [];
let _cursor = 0;
for (let i = 0; i < SAMPLE_RING; i++) {
  _ring.push({
    t: 0,
    distance: 0,
    pos: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    curvature: 0,
    speed: 0,
    lateral: 0,
    trackT: 0,
  });
}
function nextSample() {
  const s = _ring[_cursor];
  _cursor = (_cursor + 1) & (SAMPLE_RING - 1);
  return s;
}

/* ========================================================================== */

export class RacingLine {
  name = 'racingLine';

  /**
   * @param {import('./Track.js').Track} track
   * @param {object} ctx shared context
   */
  constructor(track, ctx = {}) {
    this.track = track;
    this.ctx = ctx;
    this.ready = false;
    this.length = 0;
    this.count = 0;

    const opts = (track && track.def && track.def.racingLine) || {};
    this.limits = {
      vMax: opts.vMax ?? DEFAULT_LIMITS.vMax,
      aLat: opts.aLat ?? DEFAULT_LIMITS.aLat,
      aBrake: opts.aBrake ?? DEFAULT_LIMITS.aBrake,
      aDrive: opts.aDrive ?? DEFAULT_LIMITS.aDrive,
      powerV: opts.powerV ?? DEFAULT_LIMITS.powerV,
    };
    // Drag is derived, not authored: it is whatever makes aDrive fall to zero
    // exactly at vMax, so the two numbers can never contradict each other.
    this.dragK = (this.limits.aDrive * this.limits.powerV) / Math.pow(Math.max(1, this.limits.vMax), 3);
    this.curvWeight = opts.curvatureWeight ?? CURV_WEIGHT;
    this.lenWeight = opts.lengthWeight ?? LEN_WEIGHT;
    this.margin = opts.margin ?? EDGE_MARGIN;

    if (!track || !track.data || !track.count) {
      console.warn('[RacingLine] no track data; racing line disabled');
      this.makeEmpty();
      return;
    }

    try {
      this.solve();
      this.ready = true;
    } catch (err) {
      console.warn('[RacingLine] solve failed, falling back to the centreline:', err);
      this.fallbackToCentreline();
    }
  }

  /* -------------------------------------------------------------- pipeline */

  solve() {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

    const target = clamp(Math.round(this.track.length / NODE_PITCH), MIN_NODES, MAX_NODES);
    // Coarse-to-fine ladder, each level twice the previous, ending at `target`.
    const levels = [];
    for (let m = target; m >= MIN_NODES; m = Math.floor(m / 2)) levels.push(m);
    levels.reverse();

    let alpha = null;
    let level = null;
    for (let i = 0; i < levels.length; i++) {
      const m = levels[i];
      const next = this.buildLevel(m);
      alpha = alpha ? prolong(alpha, next.count) : new Float64Array(next.count);
      clampArray(alpha, next.lo, next.hi);
      // Coarse levels get more sweeps: they are cheap and they are where the
      // long-wavelength shape of the line is actually decided.
      const sweeps = i === levels.length - 1 ? 420 : 700;
      relax(alpha, next, this.curvWeight, this.lenWeight, sweeps);
      level = next;
    }

    // Round off the kinks where the solution ran into the corridor wall, then
    // re-clamp so the smoothing cannot push the line off the track.
    boundedSmooth(alpha, level.lo, level.hi, 3);

    this.nodes = level;
    this.alpha = alpha;

    this.buildFrames(level, alpha);
    this.buildSpeedProfile();
    this.buildIndex();

    this.solveMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - t0;
  }

  /**
   * Sample the track into `count` evenly-spaced solver nodes: centre point,
   * horizontal right vector, and the corridor the offset may live in.
   */
  buildLevel(count) {
    const track = this.track;
    const cx = new Float64Array(count);
    const cz = new Float64Array(count);
    const rx = new Float64Array(count);
    const rz = new Float64Array(count);
    const lo = new Float64Array(count);
    const hi = new Float64Array(count);
    const tt = new Float64Array(count);

    for (let i = 0; i < count; i++) {
      const t = i / count;
      const s = track.sampleAt(t);
      cx[i] = s.pos.x;
      cz[i] = s.pos.z;
      const hl = Math.hypot(s.right.x, s.right.z) || 1;
      rx[i] = s.right.x / hl;
      rz[i] = s.right.z / hl;
      const limit = Math.max(0.5, s.halfWidth - CAR_HALF_WIDTH - this.margin);
      lo[i] = -limit;
      hi[i] = limit;
      tt[i] = t;
    }

    this.applyHazardCorridor(lo, hi, count);

    return { count, cx, cz, rx, rz, lo, hi, tt };
  }

  /**
   * Narrow the corridor around anything the line must not cross. A gap is
   * absolute; oil is merely a very good reason to be somewhere else. The side
   * to pass on is decided once per hazard from the room available at its
   * centre, so the corridor never zig-zags around a single obstacle.
   */
  applyHazardCorridor(lo, hi, count) {
    const track = this.track;
    const hazards = track.hazards || [];
    for (let h = 0; h < hazards.length; h++) {
      const hz = hazards[h];
      if (hz.type !== 'gap' && hz.type !== 'oil' && hz.type !== 'puddle') continue;

      const clear = hz.type === 'gap' ? CAR_HALF_WIDTH + 1.2 : CAR_HALF_WIDTH * 0.5;
      const centreIdx = Math.floor(wrap01(hz.t) * count) % count;
      const halfW = (hz.width > 0 ? hz.width : track.widthAt(hz.t)) * 0.5;
      const b0 = hz.lateral - halfW - clear;
      const b1 = hz.lateral + halfW + clear;

      const leftRoom = b0 - lo[centreIdx];
      const rightRoom = hi[centreIdx] - b1;
      if (leftRoom < 1 && rightRoom < 1) continue; // no room either side: ignore
      const passLeft = leftRoom >= rightRoom;

      const span = Math.max(1, Math.round(hz.halfSpanT * 2 * count));
      const start = Math.floor(wrap01(hz.t - hz.halfSpanT) * count);
      for (let k = 0; k <= span; k++) {
        const i = (start + k) % count;
        if (passLeft) {
          const nh = Math.min(hi[i], b0);
          if (nh - lo[i] > 1) hi[i] = nh;
        } else {
          const nl = Math.max(lo[i], b1);
          if (hi[i] - nl > 1) lo[i] = nl;
        }
      }
    }
  }

  /* -------------------------------------------------------------- geometry */

  /** Turn solved offsets into an arc-length-uniform frame table. */
  buildFrames(level, alpha) {
    const track = this.track;
    const pts = [];
    for (let i = 0; i < level.count; i++) {
      const t = level.tt[i];
      const p = track.surfacePoint(t, alpha[i], new THREE.Vector3());
      pts.push(p);
    }

    const curve = makeClosedCurve(pts);
    const arc = buildArcTable(curve, Math.max(2048, level.count * 4));
    this.curve = curve;
    this.length = arc.length;

    const count = clamp(Math.round(this.length / FRAME_PITCH), 192, 4096);
    this.count = count;
    this.pitch = this.length / count;

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    const pz = new Float32Array(count);
    const tx = new Float32Array(count);
    const ty = new Float32Array(count);
    const tz = new Float32Array(count);
    const nx = new Float32Array(count);
    const ny = new Float32Array(count);
    const nz = new Float32Array(count);
    const curv = new Float32Array(count);
    const lat = new Float32Array(count);
    const trackT = new Float64Array(count);
    const grip = new Float32Array(count);

    const p = _v0;
    for (let i = 0; i < count; i++) {
      const s = (i / count) * this.length;
      curve.getPoint(uAtDistance(arc, s), p);
      px[i] = p.x;
      py[i] = p.y;
      pz[i] = p.z;
    }

    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const dz = pz[b] - pz[a];
      const l = Math.hypot(dx, dy, dz) || 1;
      tx[i] = dx / l;
      ty[i] = dy / l;
      tz[i] = dz / l;
    }

    // Signed curvature in the horizontal plane, positive turning left.
    const ds = this.pitch;
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      const dtx = (tx[b] - tx[a]) / (2 * ds);
      const dtz = (tz[b] - tz[a]) / (2 * ds);
      curv[i] = -(dtx * tz[i] + dtz * -tx[i]);
    }
    smoothClosed(curv, 3);

    // Track-relative data: where on the track each frame sits, which surface it
    // is on, and how far off the centreline it runs.
    for (let i = 0; i < count; i++) {
      const proj = track.projectXZ(px[i], pz[i]);
      trackT[i] = proj.t;
      lat[i] = proj.lateral;
      const s = track.surfaceAt(_v1.set(px[i], py[i], pz[i]));
      grip[i] = surfaceInfo(s).grip;
      const n = track.surfaceNormal(proj.t, proj.lateral);
      nx[i] = n.x;
      ny[i] = n.y;
      nz[i] = n.z;
    }

    // Unwrapped track parameter, monotone increasing, for binary search.
    const mono = new Float64Array(count + 1);
    mono[0] = trackT[0];
    for (let i = 1; i <= count; i++) {
      const prev = trackT[(i - 1) % count];
      const cur = trackT[i % count];
      let d = cyclicDelta(cur, prev);
      if (d < 0) d = 0; // guard the odd non-monotone frame at a hairpin
      mono[i] = mono[i - 1] + d;
    }
    this.monoTrackT = mono;

    this.frames = { px, py, pz, tx, ty, tz, nx, ny, nz, curv, lat, trackT, grip };
    this.speeds = new Float32Array(count);
  }

  /* ----------------------------------------------------------------- speed */

  /**
   * Forward-backward speed profile with a friction ellipse.
   * Runs both passes twice around the loop: on a closed circuit the entry speed
   * to a corner depends on the exit speed of the one before it, which on the
   * first wrap is not yet known.
   */
  buildSpeedProfile() {
    const { curv, grip } = this.frames;
    const n = this.count;
    const v = this.speeds;
    const L = this.limits;
    const ds = this.pitch;

    for (let i = 0; i < n; i++) {
      const k = Math.abs(curv[i]);
      const aLat = L.aLat * grip[i];
      const vCorner = k > EPS_CURV ? Math.sqrt(aLat / k) : Infinity;
      v[i] = Math.min(L.vMax, vCorner);
    }

    for (let pass = 0; pass < 2; pass++) {
      // Backward: how fast may I arrive here and still slow down in time?
      for (let step = n - 1; step >= 0; step--) {
        const i = step;
        const j = (i + 1) % n;
        const aLat = L.aLat * grip[i];
        const used = clamp((v[i] * v[i] * Math.abs(curv[i])) / Math.max(1e-6, aLat), 0, 1);
        const aBrake = L.aBrake * grip[i] * Math.sqrt(Math.max(0, 1 - used * used));
        const cap = Math.sqrt(Math.max(0, v[j] * v[j] + 2 * aBrake * ds));
        if (cap < v[i]) v[i] = cap;
      }
      // Forward: how fast can I actually be here given what I could accelerate
      // out of the last frame?
      for (let step = 0; step < n; step++) {
        const i = step;
        const h = (i - 1 + n) % n;
        const aLat = L.aLat * grip[i];
        const used = clamp((v[h] * v[h] * Math.abs(curv[i])) / Math.max(1e-6, aLat), 0, 1);
        const ellipse = Math.sqrt(Math.max(0, 1 - used * used));
        const aDrive = this.driveAccel(v[h]) * grip[i] * ellipse;
        const cap = Math.sqrt(Math.max(0, v[h] * v[h] + 2 * aDrive * ds));
        if (cap < v[i]) v[i] = cap;
      }
    }

    smoothClosed(v, 2);

    let min = Infinity;
    let max = 0;
    let time = 0;
    for (let i = 0; i < n; i++) {
      if (v[i] < min) min = v[i];
      if (v[i] > max) max = v[i];
      time += ds / Math.max(6, v[i]);
    }
    this.minSpeed = min;
    this.maxSpeed = max;
    this.estimatedLapTime = time;
  }

  /** Longitudinal acceleration available at speed v, before the grip ellipse. */
  driveAccel(v) {
    const L = this.limits;
    const s = Math.max(1, v);
    const tractive = L.aDrive * Math.min(1, L.powerV / s);
    return Math.max(0, tractive - this.dragK * s * s);
  }

  /* ----------------------------------------------------------------- index */

  buildIndex() {
    this.index = new PolylineIndex(this.frames.px, this.frames.pz, this.count, {
      stride: 4,
      cell: 16,
    });
  }

  /* ------------------------------------------------------------------- API */

  /**
   * Frame on the racing line at t (uniform in distance along the line).
   * @returns {{pos, tangent, normal, curvature, speed, t, distance, lateral, trackT}}
   *   SHARED — a ring of 16 is rotated; pass `out` to keep one.
   */
  sampleAt(t, out) {
    const res = out || nextSample();
    if (!this.count) return res;
    const f = this.frames;
    const n = this.count;
    const x = wrap01(t) * n;
    const i = Math.floor(x) % n;
    const j = (i + 1) % n;
    const b = x - Math.floor(x);
    const a = 1 - b;

    res.t = wrap01(t);
    res.distance = res.t * this.length;
    res.pos.set(f.px[i] * a + f.px[j] * b, f.py[i] * a + f.py[j] * b, f.pz[i] * a + f.pz[j] * b);
    res.tangent.set(f.tx[i] * a + f.tx[j] * b, f.ty[i] * a + f.ty[j] * b, f.tz[i] * a + f.tz[j] * b).normalize();
    res.normal.set(f.nx[i] * a + f.nx[j] * b, f.ny[i] * a + f.ny[j] * b, f.nz[i] * a + f.nz[j] * b).normalize();
    res.curvature = f.curv[i] * a + f.curv[j] * b;
    res.speed = this.speeds[i] * a + this.speeds[j] * b;
    res.lateral = f.lat[i] * a + f.lat[j] * b;
    res.trackT = f.trackT[i];
    return res;
  }

  /** Frame at a distance along the line (wraps). */
  sampleAtDistance(s, out) {
    return this.sampleAt(this.length > 0 ? s / this.length : 0, out);
  }

  /** Position on the line at t. Writes into `out` if given. */
  pointAt(t, out) {
    const res = out || new THREE.Vector3();
    return res.copy(this.sampleAt(t).pos);
  }

  /** Signed curvature (1/u) at line parameter t. Positive turns left. */
  curvatureAt(t) {
    if (!this.count) return 0;
    const n = this.count;
    const x = wrap01(t) * n;
    const i = Math.floor(x) % n;
    const j = (i + 1) % n;
    const b = x - Math.floor(x);
    return this.frames.curv[i] * (1 - b) + this.frames.curv[j] * b;
  }

  /** Planned speed (u/s) at line parameter t. */
  speedAt(t) {
    if (!this.count) return this.limits.vMax;
    const n = this.count;
    const x = wrap01(t) * n;
    const i = Math.floor(x) % n;
    const j = (i + 1) % n;
    const b = x - Math.floor(x);
    return this.speeds[i] * (1 - b) + this.speeds[j] * b;
  }

  /** Alias matching the wording the AI contract uses. */
  targetSpeedAt(t) {
    return this.speedAt(t);
  }

  /**
   * Slowest planned speed within `distance` ahead of t. This, not the speed at
   * the car, is what a driver brakes for.
   */
  minSpeedAhead(t, distance) {
    if (!this.count) return this.limits.vMax;
    const steps = Math.max(1, Math.round(distance / this.pitch));
    const n = this.count;
    let i = Math.floor(wrap01(t) * n) % n;
    let min = Infinity;
    for (let k = 0; k < steps; k++) {
      const v = this.speeds[i];
      if (v < min) min = v;
      i = (i + 1) % n;
    }
    return min;
  }

  /** Nearest line parameter to a world position. */
  nearestT(pos) {
    if (!pos || !this.count) return 0;
    return this.project(pos.x, pos.z).t;
  }

  /**
   * Project a world position onto the line.
   * @returns {{t, lateral, index}} plain object, allocated per call — this is
   *   not on the physics hot path, and callers keep the result.
   */
  project(x, z) {
    const f = this.frames;
    const n = this.count;
    const coarse = this.index.nearest(x, z);
    const span = this.index.stride + 2;

    let bestD = Infinity;
    let bestI = coarse;
    let bestF = 0;
    for (let o = -span; o <= span; o++) {
      const i = ((coarse + o) % n + n) % n;
      const j = (i + 1) % n;
      const ax = f.px[i];
      const az = f.pz[i];
      const ex = f.px[j] - ax;
      const ez = f.pz[j] - az;
      const len2 = ex * ex + ez * ez;
      let u = len2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u - x;
      const qz = az + ez * u - z;
      const d = qx * qx + qz * qz;
      if (d < bestD) { bestD = d; bestI = i; bestF = u; }
    }

    const i = bestI;
    const j = (i + 1) % n;
    const ex = f.px[j] - f.px[i];
    const ez = f.pz[j] - f.pz[i];
    const el = Math.hypot(ex, ez) || 1;
    // Right of the tangent (tx, tz) is (tz, -tx), so a positive result means
    // the query sits to the right of the line — the same sign convention the
    // track's own lateral offset uses.
    const lateral = ((x - f.px[i]) * ez - (z - f.pz[i]) * ex) / el;

    return { t: wrap01((i + bestF) / n), lateral, index: i, distance: Math.sqrt(bestD) };
  }

  /**
   * The point `distance` further along the line than the given world position —
   * the aim point an AI steers at.
   */
  lookahead(pos, distance, out) {
    const t = this.nearestT(pos);
    return this.sampleAt(wrap01(t + (this.length > 0 ? distance / this.length : 0)), out);
  }

  /** Frame on the line closest to a *track* parameter. */
  sampleAtTrackT(trackT, out) {
    return this.sampleAt(this.lineTAtTrackT(trackT), out);
  }

  /**
   * Map a track parameter to a line parameter. The line's own trackT sequence
   * is unwrapped into a monotone array at build time, so this is a binary
   * search rather than a nearest-point query.
   */
  lineTAtTrackT(trackT) {
    const mono = this.monoTrackT;
    if (!mono || !this.count) return wrap01(trackT);
    const base = mono[0];
    let x = wrap01(trackT - base) + base;
    const n = this.count;
    if (x < mono[0]) x += 1;
    let lo = 0;
    let hi = n;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (mono[mid] <= x) lo = mid; else hi = mid;
    }
    const span = mono[hi] - mono[lo];
    const f = span > 1e-9 ? (x - mono[lo]) / span : 0;
    return wrap01((lo + f) / n);
  }

  /* ------------------------------------------------------------ minimap/dbg */

  /**
   * Flat XZ polyline for the minimap.
   * @param {number} n vertex count
   * @returns {Float32Array} [x0, z0, x1, z1, ...]
   */
  toPolyline(n = 160) {
    const out = new Float32Array(n * 2);
    if (!this.count) return out;
    for (let i = 0; i < n; i++) {
      const s = this.sampleAt(i / n);
      out[i * 2] = s.pos.x;
      out[i * 2 + 1] = s.pos.z;
    }
    return out;
  }

  /** Sampled points, three.js-curve style. */
  getPoints(n = 200) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.sampleAt(i / n).pos.clone());
    return out;
  }

  /**
   * Debug ribbon coloured by planned speed (blue slow, red fast). Hidden by
   * default; Debug.js toggles it via Settings.debug.showRacingLine.
   */
  createDebugObject() {
    if (!this.count) return null;
    const n = this.count;
    const pos = new Float32Array((n + 1) * 3);
    const col = new Float32Array((n + 1) * 3);
    const f = this.frames;
    const range = Math.max(1, this.maxSpeed - this.minSpeed);
    const c = new THREE.Color();
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      pos[i * 3] = f.px[k];
      pos[i * 3 + 1] = f.py[k] + 1.2;
      pos[i * 3 + 2] = f.pz[k];
      const u = (this.speeds[k] - this.minSpeed) / range;
      c.setHSL(lerp(0.62, 0.0, u), 0.95, 0.55);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, depthTest: false });
    const line = new THREE.Line(g, m);
    line.name = 'racingLine:debug';
    line.renderOrder = 999;
    line.frustumCulled = false;
    this._debugObject = line;
    return line;
  }

  /* --------------------------------------------------------------- degraded */

  makeEmpty() {
    this.frames = null;
    this.speeds = new Float32Array(0);
    this.count = 0;
    this.length = 0;
    this.pitch = 1;
    this.minSpeed = 0;
    this.maxSpeed = 0;
    this.estimatedLapTime = 0;
    this.index = null;
    this.monoTrackT = null;
  }

  /** Last resort: the centreline is a legal, if slow, racing line. */
  fallbackToCentreline() {
    const track = this.track;
    if (!track || !track.count) { this.makeEmpty(); return; }
    const n = track.count;
    const d = track.data;
    this.count = n;
    this.length = track.length;
    this.pitch = track.pitch;
    this.frames = {
      px: d.px, py: d.py, pz: d.pz,
      tx: d.tx, ty: d.ty, tz: d.tz,
      nx: d.nx, ny: d.ny, nz: d.nz,
      curv: d.curv,
      lat: new Float32Array(n),
      trackT: (() => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i / n; return a; })(),
      grip: (() => { const a = new Float32Array(n); a.fill(1); return a; })(),
    };
    this.speeds = new Float32Array(n);
    this.buildSpeedProfile();
    const mono = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) mono[i] = i / n;
    this.monoTrackT = mono;
    this.buildIndex();
    this.ready = true;
  }

  /* ---------------------------------------------------------------- system */

  info() {
    return {
      nodes: this.nodes ? this.nodes.count : 0,
      frames: this.count,
      length: +this.length.toFixed(1),
      trackLength: this.track ? +this.track.length.toFixed(1) : 0,
      minSpeed: +(this.minSpeed || 0).toFixed(1),
      maxSpeed: +(this.maxSpeed || 0).toFixed(1),
      lapTime: +(this.estimatedLapTime || 0).toFixed(2),
      solveMs: this.solveMs != null ? +this.solveMs.toFixed(1) : null,
    };
  }

  dispose() {
    if (this._debugObject) {
      this._debugObject.geometry?.dispose?.();
      this._debugObject.material?.dispose?.();
      this._debugObject.parent?.remove?.(this._debugObject);
      this._debugObject = null;
    }
    this.curve = null;
  }
}

/* ------------------------------------------------------------------ solver */

/**
 * One projected SOR sweep set over the banded normal equations of
 *   E(alpha) = wc * sum |p[i-1] - 2p[i] + p[i+1]|^2 + wl * sum |p[i+1] - p[i]|^2
 * with p[i] = c[i] + alpha[i] * r[i].
 *
 * The circulant stencil of the combined energy is
 *   W = wc * [1, -4, 6, -4, 1] + wl * [0, -1, 2, -1, 0]
 * so the system matrix is A[i][i+k] = W[k] * dot(r[i], r[i+k]) — pentadiagonal
 * and symmetric — with right-hand side -b, b[i] = sum_k W[k] * dot(r[i], c[i+k]).
 * Clamping each updated offset to its corridor makes this projected SOR, which
 * converges to the constrained optimum because A is positive semi-definite and
 * the feasible set is a box.
 */
function relax(alpha, level, wc, wl, sweeps) {
  const { count: n, cx, cz, rx, rz, lo, hi } = level;
  const W = [wc, -4 * wc - wl, 6 * wc + 2 * wl, -4 * wc - wl, wc];
  const diag = W[2];
  if (!(diag > 0)) return alpha;
  const invDiag = 1 / diag;

  // b is fixed for the whole solve; computing it once is most of the win.
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rix = rx[i];
    const riz = rz[i];
    let acc = 0;
    for (let k = -2; k <= 2; k++) {
      const j = ((i + k) % n + n) % n;
      acc += W[k + 2] * (rix * cx[j] + riz * cz[j]);
    }
    b[i] = acc;
  }

  for (let s = 0; s < sweeps; s++) {
    // Alternating sweep direction keeps the solution symmetric; a single
    // direction biases the line slightly downstream on long constant-radius
    // corners, which shows up as a lopsided apex.
    const forward = (s & 1) === 0;
    let maxDelta = 0;
    for (let step = 0; step < n; step++) {
      const i = forward ? step : n - 1 - step;
      const rix = rx[i];
      const riz = rz[i];
      let acc = b[i];
      for (let k = -2; k <= 2; k++) {
        if (k === 0) continue;
        const j = ((i + k) % n + n) % n;
        acc += W[k + 2] * (rix * rx[j] + riz * rz[j]) * alpha[j];
      }
      const target = -acc * invDiag;
      let next = alpha[i] + SOR * (target - alpha[i]);
      const l = lo[i];
      const h = hi[i];
      next = next < l ? l : next > h ? h : next;
      const d = next - alpha[i];
      if (d > maxDelta) maxDelta = d; else if (-d > maxDelta) maxDelta = -d;
      alpha[i] = next;
    }
    // 0.2 mm at 1:64 — far below anything a car or a camera can resolve.
    if (s > 24 && maxDelta < 2e-4) break;
  }
  return alpha;
}

/** Linear resample of a cyclic offset array onto a new node count. */
function prolong(alpha, count) {
  const m = alpha.length;
  const out = new Float64Array(count);
  if (m === 0) return out;
  for (let i = 0; i < count; i++) {
    const x = (i / count) * m;
    const a = Math.floor(x) % m;
    const b = (a + 1) % m;
    const f = x - Math.floor(x);
    out[i] = alpha[a] * (1 - f) + alpha[b] * f;
  }
  return out;
}

function clampArray(a, lo, hi) {
  for (let i = 0; i < a.length; i++) {
    a[i] = a[i] < lo[i] ? lo[i] : a[i] > hi[i] ? hi[i] : a[i];
  }
  return a;
}

/** Binomial smoothing that re-projects into the corridor after every pass. */
function boundedSmooth(a, lo, hi, passes) {
  const n = a.length;
  if (n < 3) return a;
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const x = a[(i - 1 + n) % n] + 2 * a[i] + a[(i + 1) % n];
      tmp[i] = x * 0.25;
    }
    for (let i = 0; i < n; i++) {
      a[i] = tmp[i] < lo[i] ? lo[i] : tmp[i] > hi[i] ? hi[i] : tmp[i];
    }
  }
  return a;
}

export default RacingLine;
