// vehicle/CarModels.js — the eight chassis, their geometry, and their liveries.
//
// Every car in the game is generated here, in code, from a small profile table
// and a shared modelling toolkit. Nothing is a primitive: bodies are lofted
// through rounded cross-sections, wheel faces are extruded shapes with real
// spoke apertures, tyres are revolved profiles, and bumpers, exhausts, cages
// and wings are swept along paths. Everything carries a generous edge radius
// because a die-cast toy is a *cast* object — there are no sharp corners on one,
// and a highlight rolling around a 0.3 u fillet is most of what sells the scale.
//
// --------------------------------------------------------------- conventions
//
// UNITS    1 world unit = 1 cm (ARCHITECTURE section 2).
// AXES     Body local: +Z forward, +Y up, +X to the car's LEFT. This matches
//          Vehicle.js exactly, including which wheel index is which corner.
// ORIGIN   Geometry is authored with the ground at y = 0 (much easier to think
//          about) and translated down by cgHeight on the way out, because
//          Vehicle.js puts the body origin at the centre of mass.
//
// ------------------------------------------------------------------- the UVs
//
// The painted shell is unwrapped as a full ring: U runs along the car (0 at the
// tail, 1 at the nose) and V runs *around* the cross-section, starting at the
// underside centreline, up the right flank, over the roof, down the left flank
// and back. That single decision is what makes the livery system possible: the
// seam lands on the car's belly where nobody can see it, both flanks get their
// own region of the canvas so text can be drawn the right way round on each,
// and the roof gets a true plan view instead of a smear. buildChassis() returns
// the exact V boundaries of each band so the livery painter never has to guess.
//
// ------------------------------------------------------------- wheel arches
//
// A closed lofted shell cannot have a hole cut in it without CSG, so the arch
// is built into the loft: the floor line of the cross-section rises over each
// axle on a true circular arc of radius (wheelRadius + clearance). Above the
// tyre the body is solid, below it there is nothing — which is precisely a
// wheel arch, and it is generated from the axle positions rather than authored,
// so it can never drift out of register with the suspension.

import * as THREE from 'three';
import { makeRng, clamp, saturate, lerp, smoothstep } from '../core/Random.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ==========================================================================
 * Scratch. Module scope, never allocated per frame or per vertex.
 * ========================================================================== */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();

/* ==========================================================================
 * 1. Geometry toolkit
 * ========================================================================== */

/**
 * Merge a list of geometries carrying position/normal/uv into one indexed
 * BufferGeometry. Written here rather than pulled from BufferGeometryUtils so
 * this module has exactly one import and cannot be broken by an addon path.
 *
 * @param {Array<THREE.BufferGeometry|{geometry:THREE.BufferGeometry, matrix?:THREE.Matrix4}>} items
 */
export function mergeGeoms(items) {
  const list = [];
  for (const it of items) {
    if (!it) continue;
    const g = it.isBufferGeometry ? it : it.geometry;
    if (!g || !g.attributes || !g.attributes.position) continue;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    list.push({
      g,
      m: it.isBufferGeometry ? null : (it.matrix || null),
      // Collapse this part's UVs onto one texel of the livery atlas. See
      // makeCollector: a swept arch lip or a lofted boot lip carries its own
      // 0..1 unwrap, so mapped into the atlas it wears a squashed copy of the
      // entire livery — number roundel, sponsor text, window graphic and all.
      uvc: it.isBufferGeometry ? null : (it.uvConst || null),
    });
  }
  if (!list.length) return new THREE.BufferGeometry();
  if (list.length === 1 && !list[0].m && !list[0].uvc) return list[0].g;

  let vTotal = 0;
  let iTotal = 0;
  for (const { g } of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }

  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = vTotal > 65534 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vo = 0;
  let io = 0;
  const nm = new THREE.Matrix3();
  for (const { g, m, uvc } of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    const count = p.count;
    if (m) nm.setFromMatrix4(m).invert().transpose();
    for (let i = 0; i < count; i++) {
      _v3a.fromBufferAttribute(p, i);
      if (m) _v3a.applyMatrix4(m);
      pos[(vo + i) * 3] = _v3a.x;
      pos[(vo + i) * 3 + 1] = _v3a.y;
      pos[(vo + i) * 3 + 2] = _v3a.z;
      _v3b.fromBufferAttribute(n, i);
      if (m) _v3b.applyMatrix3(nm).normalize();
      nrm[(vo + i) * 3] = _v3b.x;
      nrm[(vo + i) * 3 + 1] = _v3b.y;
      nrm[(vo + i) * 3 + 2] = _v3b.z;
      uv[(vo + i) * 2] = uvc ? uvc[0] : t.getX(i);
      uv[(vo + i) * 2 + 1] = uvc ? uvc[1] : t.getY(i);
    }
    if (g.index) {
      const gi = g.index;
      for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
      io += gi.count;
    } else {
      for (let i = 0; i < count; i++) idx[io + i] = i + vo;
      io += count;
    }
    vo += count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Convenience: a Matrix4 from position / euler / uniform-or-vector scale. */
export function xform(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _quat.setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
  return new THREE.Matrix4().compose(
    _v3a.set(px, py, pz), _quat, _v3b.set(sx, sy, sz)
  );
}

/**
 * Round the corners of a closed 2D polygon and sample the result.
 *
 * Handles reflex vertices correctly (the fillet centre falls outside the
 * polygon and the arc sweeps the other way), which is what lets a cross-section
 * carry a crease or a tuck rather than only convex blobs.
 *
 * The sample count per vertex is FIXED — `cornerSteps + 1` arc samples then
 * `edgeSteps` interior samples along the following edge — so two sections with
 * wildly different proportions still correspond vertex-for-vertex and the loft
 * between them cannot twist.
 *
 * @param {number[][]} poly counter-clockwise vertices
 * @param {number[]} radii per-vertex fillet radius
 * @returns {{pts: Float64Array, nrm: Float64Array, count: number}}
 */
export function roundPolygon(poly, radii, cornerSteps = 4, edgeSteps = 2) {
  const n = poly.length;
  const per = cornerSteps + 1 + edgeSteps;
  const count = n * per;
  const pts = new Float64Array(count * 2);
  const nrm = new Float64Array(count * 2);
  let w = 0;

  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n];
    const v = poly[i];
    const q = poly[(i + 1) % n];

    let ax = p[0] - v[0];
    let ay = p[1] - v[1];
    let bx = q[0] - v[0];
    let by = q[1] - v[1];
    const la = Math.hypot(ax, ay) || 1e-6;
    const lb = Math.hypot(bx, by) || 1e-6;
    ax /= la; ay /= la; bx /= lb; by /= lb;

    const theta = Math.acos(clamp(ax * bx + ay * by, -1, 1));
    const half = theta * 0.5;
    const sinH = Math.sin(half);
    const tanH = Math.tan(half);

    // The turn direction: cross(incoming, outgoing). Incoming is -a.
    const cross = (-ax) * by - (-ay) * bx;
    const convex = cross > 0;

    let r = Math.max(0, radii[i] || 0);
    if (sinH > 1e-4 && tanH > 1e-4) r = Math.min(r, 0.46 * Math.min(la, lb) * tanH);
    else r = 0;

    const d = r > 1e-6 && tanH > 1e-6 ? r / tanH : 0;
    const sx = v[0] + ax * d;
    const sy = v[1] + ay * d;
    const ex = v[0] + bx * d;
    const ey = v[1] + by * d;

    if (r > 1e-6 && sinH > 1e-4) {
      let wx = ax + bx;
      let wy = ay + by;
      const lw = Math.hypot(wx, wy);
      if (lw > 1e-6) {
        wx /= lw; wy /= lw;
        const cx = v[0] + wx * (r / sinH);
        const cy = v[1] + wy * (r / sinH);
        const a0 = Math.atan2(sy - cy, sx - cx);
        const a1 = Math.atan2(ey - cy, ex - cx);
        let da = a1 - a0;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        for (let k = 0; k <= cornerSteps; k++) {
          const a = a0 + da * (k / cornerSteps);
          const px = cx + Math.cos(a) * r;
          const py = cy + Math.sin(a) * r;
          pts[w * 2] = px;
          pts[w * 2 + 1] = py;
          // Outward normal points away from the fillet centre on a convex
          // corner and toward it on a concave one.
          const s = convex ? 1 : -1;
          nrm[w * 2] = ((px - cx) / r) * s;
          nrm[w * 2 + 1] = ((py - cy) / r) * s;
          w++;
        }
      } else {
        for (let k = 0; k <= cornerSteps; k++) {
          pts[w * 2] = v[0]; pts[w * 2 + 1] = v[1];
          nrm[w * 2] = by; nrm[w * 2 + 1] = -bx;
          w++;
        }
      }
    } else {
      // Effectively straight: spread the samples over a hair of the corner so
      // no two land on the same point and produce a degenerate triangle.
      const eps = 0.004 * Math.min(la, lb);
      for (let k = 0; k <= cornerSteps; k++) {
        const t = k / cornerSteps;
        pts[w * 2] = lerp(v[0] + ax * eps, v[0] + bx * eps, t);
        pts[w * 2 + 1] = lerp(v[1] + ay * eps, v[1] + by * eps, t);
        nrm[w * 2] = by; nrm[w * 2 + 1] = -bx;
        w++;
      }
    }

    // Interior samples of the straight edge that follows.
    const nx2 = poly[(i + 1) % n];
    const p2 = poly[(i + 2) % n];
    let cx2 = p2[0] - nx2[0];
    let cy2 = p2[1] - nx2[1];
    const lc = Math.hypot(cx2, cy2) || 1e-6;
    cx2 /= lc; cy2 /= lc;
    const theta2 = Math.acos(clamp((-bx) * cx2 + (-by) * cy2, -1, 1));
    const tanH2 = Math.tan(theta2 * 0.5);
    let r2 = Math.max(0, radii[(i + 1) % n] || 0);
    if (tanH2 > 1e-4) r2 = Math.min(r2, 0.46 * Math.min(lb, lc) * tanH2);
    else r2 = 0;
    const d2 = r2 > 1e-6 && tanH2 > 1e-6 ? r2 / tanH2 : 0;
    const fx = nx2[0] - bx * d2;
    const fy = nx2[1] - by * d2;
    const enx = by;
    const eny = -bx;
    for (let k = 1; k <= edgeSteps; k++) {
      const t = k / (edgeSteps + 1);
      pts[w * 2] = lerp(ex, fx, t);
      pts[w * 2 + 1] = lerp(ey, fy, t);
      nrm[w * 2] = enx;
      nrm[w * 2 + 1] = eny;
      w++;
    }
  }

  return { pts, nrm, count, per, vertices: n };
}

/** Cumulative arc-length parameterisation of a closed ring, normalised to 1. */
function arcTable(ring) {
  const n = ring.count;
  const t = new Float64Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring.pts[j * 2] - ring.pts[i * 2];
    const dy = ring.pts[j * 2 + 1] - ring.pts[i * 2 + 1];
    total += Math.hypot(dx, dy);
    t[i + 1] = total;
  }
  if (total < 1e-9) { for (let i = 0; i <= n; i++) t[i] = i / n; return t; }
  for (let i = 0; i <= n; i++) t[i] /= total;
  return t;
}

/**
 * Loft a series of cross-sections into a closed shell.
 *
 * @param {Array<{z:number, ring:{pts:Float64Array,count:number}}>} slices tail to nose
 * @param {object} o
 * @param {Float64Array} o.vTable arc parameter per ring index (length count+1)
 * @param {boolean} [o.capFront] close the +Z end with a fan
 * @param {boolean} [o.capBack] close the -Z end with a fan
 * @param {number} [o.zMin] U reference (defaults to the slice range)
 */
export function loftShell(slices, o = {}) {
  const S = slices.length;
  const N = slices[0].ring.count;
  const cols = N + 1;
  const vTable = o.vTable || arcTable(slices[0].ring);
  const zMin = o.zMin !== undefined ? o.zMin : slices[0].z;
  const zMax = o.zMax !== undefined ? o.zMax : slices[S - 1].z;
  const zSpan = Math.max(1e-4, zMax - zMin);

  const capFront = o.capFront !== false;
  const capBack = o.capBack !== false;
  const extra = (capFront ? 1 : 0) + (capBack ? 1 : 0);
  const vCount = S * cols + extra;

  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);

  for (let s = 0; s < S; s++) {
    const sl = slices[s];
    const u = (sl.z - zMin) / zSpan;
    for (let j = 0; j < cols; j++) {
      const jj = j % N;
      const w = s * cols + j;
      pos[w * 3] = sl.ring.pts[jj * 2];
      pos[w * 3 + 1] = sl.ring.pts[jj * 2 + 1];
      pos[w * 3 + 2] = sl.z;
      uv[w * 2] = u;
      uv[w * 2 + 1] = j === N ? 1 : vTable[j];
    }
  }

  const quads = (S - 1) * N;
  let triCount = quads * 2;
  if (capFront) triCount += N;
  if (capBack) triCount += N;
  const idx = vCount > 65534 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let w = 0;
  for (let s = 0; s < S - 1; s++) {
    for (let j = 0; j < N; j++) {
      const a = s * cols + j;
      const b = s * cols + j + 1;
      const c = (s + 1) * cols + j + 1;
      const d = (s + 1) * cols + j;
      idx[w++] = a; idx[w++] = b; idx[w++] = c;
      idx[w++] = a; idx[w++] = c; idx[w++] = d;
    }
  }

  let next = S * cols;
  if (capFront) {
    const sl = slices[S - 1];
    let cx = 0; let cy = 0;
    for (let j = 0; j < N; j++) { cx += sl.ring.pts[j * 2]; cy += sl.ring.pts[j * 2 + 1]; }
    cx /= N; cy /= N;
    const ci = next++;
    pos[ci * 3] = cx; pos[ci * 3 + 1] = cy; pos[ci * 3 + 2] = sl.z;
    uv[ci * 2] = (sl.z - zMin) / zSpan; uv[ci * 2 + 1] = 0.5;
    const base = (S - 1) * cols;
    for (let j = 0; j < N; j++) {
      idx[w++] = ci; idx[w++] = base + j; idx[w++] = base + j + 1;
    }
  }
  if (capBack) {
    const sl = slices[0];
    let cx = 0; let cy = 0;
    for (let j = 0; j < N; j++) { cx += sl.ring.pts[j * 2]; cy += sl.ring.pts[j * 2 + 1]; }
    cx /= N; cy /= N;
    const ci = next++;
    pos[ci * 3] = cx; pos[ci * 3 + 1] = cy; pos[ci * 3 + 2] = sl.z;
    uv[ci * 2] = (sl.z - zMin) / zSpan; uv[ci * 2 + 1] = 0.5;
    for (let j = 0; j < N; j++) {
      idx[w++] = ci; idx[w++] = j + 1; idx[w++] = j;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * Loft an open strip through a contiguous run of ring indices — used for the
 * glazing shell, which is a band of the body surface pushed a hair proud.
 */
export function loftStrip(slices, j0, j1, o = {}) {
  const S = slices.length;
  const N = slices[0].ring.count;
  const span = j1 - j0;
  const cols = span + 1;
  const vTable = o.vTable || arcTable(slices[0].ring);
  const zMin = o.zMin !== undefined ? o.zMin : slices[0].z;
  const zMax = o.zMax !== undefined ? o.zMax : slices[S - 1].z;
  const zSpan = Math.max(1e-4, zMax - zMin);

  const pos = new Float32Array(S * cols * 3);
  const uv = new Float32Array(S * cols * 2);
  for (let s = 0; s < S; s++) {
    const sl = slices[s];
    const u = (sl.z - zMin) / zSpan;
    for (let j = 0; j < cols; j++) {
      const jj = (j0 + j) % N;
      const w = s * cols + j;
      pos[w * 3] = sl.ring.pts[jj * 2];
      pos[w * 3 + 1] = sl.ring.pts[jj * 2 + 1];
      pos[w * 3 + 2] = sl.z;
      uv[w * 2] = u;
      uv[w * 2 + 1] = vTable[j0 + j] !== undefined ? vTable[j0 + j] : 1;
    }
  }
  const idx = [];
  for (let s = 0; s < S - 1; s++) {
    for (let j = 0; j < span; j++) {
      const a = s * cols + j;
      const b = s * cols + j + 1;
      const c = (s + 1) * cols + j + 1;
      const d = (s + 1) * cols + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Sweep a closed 2D profile along a 3D path with a stable world-up frame.
 *
 * Parallel transport would be more general, but a fixed reference up never
 * twists, and every swept part in this file (bumpers, exhausts, roll cages,
 * wing pylons, arch flares) is authored to suit that.
 *
 * @param {number[][]} path world points
 * @param {number[][]} profile closed CCW 2D outline in (side, up)
 * @param {object} [o] { caps, up, scale(i)->[sx,sy], closed }
 */
export function sweep(path, profile, o = {}) {
  const P = path.length;
  const M = profile.length;
  const closedPath = !!o.closed;
  const caps = o.caps !== false && !closedPath;
  const upRef = o.up || [0, 1, 0];
  const rings = closedPath ? P : P;

  const vCount = rings * (M + 1) + (caps ? 2 : 0);
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);

  const tx = new Float64Array(3);
  for (let i = 0; i < rings; i++) {
    const cur = path[i];
    const prev = path[i > 0 ? i - 1 : (closedPath ? P - 1 : 0)];
    const next = path[i < P - 1 ? i + 1 : (closedPath ? 0 : P - 1)];
    tx[0] = next[0] - prev[0];
    tx[1] = next[1] - prev[1];
    tx[2] = next[2] - prev[2];
    let tl = Math.hypot(tx[0], tx[1], tx[2]);
    if (tl < 1e-8) { tx[0] = 0; tx[1] = 0; tx[2] = 1; tl = 1; }
    const t0 = tx[0] / tl; const t1 = tx[1] / tl; const t2 = tx[2] / tl;

    // side = up x tangent; if they are near-parallel pick another reference.
    let ux = upRef[0]; let uy = upRef[1]; let uz = upRef[2];
    if (Math.abs(ux * t0 + uy * t1 + uz * t2) > 0.985) { ux = 0; uy = 0; uz = 1; }
    let sx = uy * t2 - uz * t1;
    let sy = uz * t0 - ux * t2;
    let sz = ux * t1 - uy * t0;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const vx = t1 * sz - t2 * sy;
    const vy = t2 * sx - t0 * sz;
    const vz = t0 * sy - t1 * sx;

    const sc = o.scale ? o.scale(i / Math.max(1, rings - 1), i) : null;
    const scx = sc ? sc[0] : 1;
    const scy = sc ? sc[1] : 1;
    const u = i / Math.max(1, rings - 1);

    for (let j = 0; j <= M; j++) {
      const pr = profile[j % M];
      const a = pr[0] * scx;
      const b = pr[1] * scy;
      const w = i * (M + 1) + j;
      pos[w * 3] = cur[0] + sx * a + vx * b;
      pos[w * 3 + 1] = cur[1] + sy * a + vy * b;
      pos[w * 3 + 2] = cur[2] + sz * a + vz * b;
      uv[w * 2] = u;
      uv[w * 2 + 1] = j / M;
    }
  }

  const idx = [];
  const segs = closedPath ? rings : rings - 1;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % rings;
    for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j;
      const b = i * (M + 1) + j + 1;
      const c = i2 * (M + 1) + j + 1;
      const d = i2 * (M + 1) + j;
      idx.push(a, d, c, a, c, b);
    }
  }
  if (caps) {
    const c0 = rings * (M + 1);
    const c1 = c0 + 1;
    for (const [ci, ri, flip] of [[c0, 0, true], [c1, rings - 1, false]]) {
      let cx = 0; let cy = 0; let cz = 0;
      for (let j = 0; j < M; j++) {
        const w = ri * (M + 1) + j;
        cx += pos[w * 3]; cy += pos[w * 3 + 1]; cz += pos[w * 3 + 2];
      }
      pos[ci * 3] = cx / M; pos[ci * 3 + 1] = cy / M; pos[ci * 3 + 2] = cz / M;
      uv[ci * 2] = flip ? 0 : 1; uv[ci * 2 + 1] = 0.5;
      for (let j = 0; j < M; j++) {
        const a = ri * (M + 1) + j;
        const b = ri * (M + 1) + j + 1;
        if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A closed rounded-rectangle outline, for sweep profiles. */
export function rectProfile(halfW, halfH, radius, steps = 3) {
  const poly = [[halfW, -halfH], [halfW, halfH], [-halfW, halfH], [-halfW, -halfH]];
  const r = Math.min(radius, Math.min(halfW, halfH) * 0.95);
  const ring = roundPolygon(poly, [r, r, r, r], steps, 0);
  const out = [];
  for (let i = 0; i < ring.count; i++) out.push([ring.pts[i * 2], ring.pts[i * 2 + 1]]);
  return out;
}

/** A closed circle outline. */
export function circleProfile(radius, steps = 10) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return out;
}

/** A box with a real fillet on every edge — the die-cast staple. */
export function bevelBox(w, h, d, r = 0.16, cornerSteps = 3) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const rr = Math.min(r, Math.min(hw, hh, hd) * 0.9);
  const poly = [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
  const radii = [rr, rr, rr, rr];
  const slices = [];
  const capSteps = 3;
  // Quarter-round the two end faces so the box reads as a cast part.
  for (let k = capSteps; k >= 1; k--) {
    const a = (k / capSteps) * (Math.PI * 0.5);
    const inset = rr * (1 - Math.cos(a));
    const z = -hd + rr * (1 - Math.sin(a));
    slices.push({ z, ring: insetRing(roundPolygon(poly, radii, cornerSteps, 1), inset) });
  }
  slices.push({ z: -hd + rr, ring: roundPolygon(poly, radii, cornerSteps, 1) });
  slices.push({ z: hd - rr, ring: roundPolygon(poly, radii, cornerSteps, 1) });
  for (let k = 1; k <= capSteps; k++) {
    const a = (k / capSteps) * (Math.PI * 0.5);
    const inset = rr * (1 - Math.cos(a));
    const z = hd - rr * (1 - Math.sin(a));
    slices.push({ z, ring: insetRing(roundPolygon(poly, radii, cornerSteps, 1), inset) });
  }
  return loftShell(slices, { capFront: true, capBack: true });
}

/**
 * Offset a ring along its own outward normals: positive inward, negative proud.
 *
 * The early-out used to be `d <= 1e-6`, which silently swallowed every negative
 * offset — and `buildGlazing` is built entirely on negative offsets, because
 * that is how it lifts the pane off the paint. The result was a glazing shell
 * sharing its vertices exactly with the body shell underneath it. With
 * `depthWrite: false` and the default LESS depth test, every one of those
 * fragments failed on equal depth and the glass drew literally nothing: eight
 * cars, four frames, not one transparent surface anywhere in the set. The
 * material, the tint and the interior tub were all correct and all invisible.
 */
function insetRing(ring, d) {
  if (!(Math.abs(d) > 1e-6)) return ring;
  const pts = new Float64Array(ring.pts.length);
  for (let i = 0; i < ring.count; i++) {
    pts[i * 2] = ring.pts[i * 2] - ring.nrm[i * 2] * d;
    pts[i * 2 + 1] = ring.pts[i * 2 + 1] - ring.nrm[i * 2 + 1] * d;
  }
  return { pts, nrm: ring.nrm, count: ring.count, per: ring.per, vertices: ring.vertices };
}

/** Even-odd crossing test of (x, y) against a closed cross-section ring. */
function ringContains(ring, x, y) {
  let inside = false;
  const n = ring.count;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring.pts[i * 2];
    const yi = ring.pts[i * 2 + 1];
    const xj = ring.pts[j * 2];
    const yj = ring.pts[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * How far back (dir < 0) or forward (dir > 0) the body shell actually reaches
 * at (x, y), in world z. Null when the point is outside the silhouette.
 *
 * This exists because the end caps are built by insetting rings, so the shell
 * runs a whole cap radius past its last key station and the surface over any
 * given (x, y) is nowhere near where the key stations suggest. Rear hardware
 * authored by eye against the stations therefore sits *inside* the car: on the
 * muscle the tail lamps span z -4.73..-4.43 while the body's rear face is a
 * flat n-gon at z = -4.75, so the lens is behind the paint and the only thing
 * the macro camera sees from behind is blank bodywork. Marching the real cap
 * rings is the only way to know, and it stays correct when a cap radius is
 * retuned.
 */
function endSurfaceZ(shell, x, y, dir) {
  const S = shell.slices;
  if (dir < 0) {
    for (let i = 0; i < S.length; i++) if (ringContains(S[i].ring, x, y)) return S[i].z;
  } else {
    for (let i = S.length - 1; i >= 0; i--) if (ringContains(S[i].ring, x, y)) return S[i].z;
  }
  return null;
}

/**
 * Slide a flat lamp plate along z until its outer face clears the bodywork
 * everywhere under its footprint, and never the other way: a lamp that already
 * stands proud keeps the z it was authored with.
 *
 * @param {object} shell  the built body shell
 * @param {object} l      lamp record { x, y, w, h, z }
 * @param {number} depth  plate depth before the bevel
 * @param {number} dir    -1 for the tail, +1 for the nose
 * @param {number} proud  how far the face should stand off the paint
 */
function lampZ(shell, l, depth, dir, proud = 0.05) {
  const half = depth * 0.5 + Math.min(0.05, depth * 0.4);
  const ax = Math.abs(l.x);
  const hw = (l.w ?? 0.4) * 0.5 * 0.92;
  const hh = (l.h ?? 0.3) * 0.5 * 0.92;
  let reach = null;
  for (const px of [ax - hw, ax, ax + hw]) {
    for (const py of [l.y - hh, l.y, l.y + hh]) {
      const z = endSurfaceZ(shell, px, py, dir);
      if (z === null) continue;
      // The most extreme surface under the footprint is the one to clear.
      if (reach === null) reach = z;
      else reach = dir < 0 ? Math.min(reach, z) : Math.max(reach, z);
    }
  }
  if (reach === null) return l.z;
  // Face sits at reach + dir * proud; the centre is half a plate in from that.
  const want = reach + dir * (proud - half);
  return dir < 0 ? Math.min(l.z, want) : Math.max(l.z, want);
}

/**
 * Where a round lamp's bucket has to sit for its lens to reach the surface it
 * is mounted in.
 *
 * `lampZ` cannot do this one: it is written for a flat plate centred on its own
 * z, while `makeRoundLamp` puts the lens face 0.24 of the bucket depth ahead of
 * the origin and hangs the bucket a whole depth behind it. Measured on the
 * muscle, whose nose runs to z 4.75, the headlamps were authored at 4.50 and
 * 4.56 — so roughly half of each lens was inside the paint and what showed was
 * a crescent.
 *
 * The reach is taken at the lamp's centre rather than across its footprint,
 * which is the opposite of what lampZ does at the tail and is deliberate: a
 * bucket lamp on a nose that curves away is meant to sit in a recess, so
 * clearing the outermost point under its rim would push the whole assembly out
 * onto the nose tip instead of seating it in the face it belongs to.
 */
function roundLampZ(shell, l, depth, dir, proud = 0.03) {
  const reach = endSurfaceZ(shell, Math.abs(l.x), l.y, dir);
  if (reach === null) return l.z;
  const want = reach + dir * (proud - depth * 0.24);
  return dir < 0 ? Math.min(l.z, want) : Math.max(l.z, want);
}

/** Revolve a (radius, axial) profile about the local X axis. */
export function revolveX(profile, segments = 28, phiStart = 0, phiLength = TAU) {
  const pts = profile.map((p) => new THREE.Vector2(Math.max(1e-4, p[0]), p[1]));
  const g = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  g.rotateZ(-Math.PI / 2);
  return g;
}

/** Extrude a Shape along +Z with a bevel, then face it down +X (wheel axis). */
export function extrudeDisc(shape, depth, bevel = 0.05, curveSegments = 14) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
    steps: 1,
  });
  g.clearGroups();
  g.translate(0, 0, -depth * 0.5);
  g.rotateY(Math.PI / 2);
  return g;
}

/** Extrude a Shape in the XY plane along Z (plates, wings, splitters). */
export function extrudePlate(shape, depth, bevel = 0.06, curveSegments = 12) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
    steps: 1,
  });
  g.clearGroups();
  g.translate(0, 0, -depth * 0.5);
  return g;
}

/**
 * Rewrite a flat part's UVs as a planar unwrap of its own w x h face.
 *
 * ExtrudeGeometry's default UV generator emits the *shape coordinates* as UVs,
 * so an extruded plate 1.08 u wide comes out with u running -0.54..0.54 — which
 * with RepeatWrapping tiles a texture five times across the part and mirrors it
 * about the centre. Derived from position rather than from the existing UVs so
 * the side walls and the back cap get sane values too instead of the extruder's
 * (x, 1-z) side-wall scheme, which would smear the face texture up the edge.
 *
 * Must be called before the part is placed: positions have to still be in the
 * shape's own centred space.
 *
 * `flipU` is not cosmetic. +Z is the nose, so a part on the tail is read from
 * -Z, and a viewer standing there has world +X on their *left*. Mapping u
 * straight off x therefore hands them mirrored text. Anything on the nose wants
 * flipU false; anything on the tail wants it true.
 */
function planarUV(geom, w, h, flipU = false) {
  const p = geom?.attributes?.position;
  const uv = geom?.attributes?.uv;
  if (!p || !uv || uv.count !== p.count) return geom;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    uv.setXY(i, (flipU ? (w * 0.5 - x) : (x + w * 0.5)) / w, (p.getY(i) + h * 0.5) / h);
  }
  uv.needsUpdate = true;
  return geom;
}

/** Rounded-rectangle Shape centred on the origin. */
export function roundRectShape(w, h, r) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const rr = Math.min(r, Math.min(hw, hh) * 0.98);
  const s = new THREE.Shape();
  s.moveTo(-hw + rr, -hh);
  s.lineTo(hw - rr, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + rr);
  s.lineTo(hw, hh - rr);
  s.quadraticCurveTo(hw, hh, hw - rr, hh);
  s.lineTo(-hw + rr, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - rr);
  s.lineTo(-hw, -hh + rr);
  s.quadraticCurveTo(-hw, -hh, -hw + rr, -hh);
  return s;
}

/* ==========================================================================
 * 2. Wheels
 *
 * A wheel is four separate objects because they move differently and are made
 * of different things: a revolved tyre carcass, an extruded rim face with real
 * apertures, a lathe-turned barrel behind it, and a brake disc that glows.
 * ========================================================================== */

/** Tyre carcass: a revolved profile with a bulged sidewall and a crowned tread. */
function buildTyre(R, halfW, o = {}) {
  const rimR = o.rimR ?? R * 0.62;
  const shoulder = o.shoulder ?? 0.72;   // how square the tread shoulder is
  const bulge = o.bulge ?? 1.0;
  const profile = [];
  const push = (r, x) => profile.push([r, x]);

  // Inboard bead -> inboard sidewall -> shoulder -> tread -> mirror out.
  push(rimR * 0.98, -halfW * 0.90);
  push(rimR * 1.10, -halfW * 0.99);
  push(R * 0.70 * bulge + rimR * (1 - 0.70), -halfW * 1.02);
  push(R * 0.88, -halfW * 0.98);
  push(R * 0.966, -halfW * 0.90);
  push(R * 0.998, -halfW * shoulder);
  push(R, -halfW * shoulder * 0.55);
  push(R * 1.004, 0);
  push(R, halfW * shoulder * 0.55);
  push(R * 0.998, halfW * shoulder);
  push(R * 0.966, halfW * 0.90);
  push(R * 0.88, halfW * 0.98);
  push(R * 0.70 * bulge + rimR * (1 - 0.70), halfW * 1.02);
  push(rimR * 1.10, halfW * 0.99);
  push(rimR * 0.98, halfW * 0.90);

  const g = revolveX(profile, o.segments ?? 30);
  // Record where the tread band sits in V so the tyre texture can be authored
  // against it rather than eyeballed.
  g.userData.treadV = [5 / (profile.length - 1), 9 / (profile.length - 1)];
  return g;
}

/** Chunky moulded tread blocks, for anything that leaves the tarmac. */
function buildLugs(R, halfW, o = {}) {
  const rows = o.rows ?? 2;
  const per = o.count ?? 13;
  const lugW = o.lugW ?? halfW * 0.42;
  const lugH = o.lugH ?? R * 0.13;
  const lugL = o.lugL ?? R * 0.34;
  const parts = [];
  const block = bevelBox(lugW, lugH, lugL, lugH * 0.34, 2);
  for (let r = 0; r < rows; r++) {
    const ax = rows === 1 ? 0 : lerp(-halfW * 0.46, halfW * 0.46, r / (rows - 1));
    const phase = (r % 2) * (TAU / per) * 0.5;
    for (let i = 0; i < per; i++) {
      const a = phase + (i / per) * TAU;
      const cy = Math.cos(a) * (R + lugH * 0.30);
      const cz = Math.sin(a) * (R + lugH * 0.30);
      // The block's local Y must point radially outward.
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromAxisAngle(_v3a.set(1, 0, 0), -a + Math.PI * 0.5);
      const skew = (r === 0 ? 1 : -1) * 0.20;
      const q2 = new THREE.Quaternion().setFromAxisAngle(_v3b.set(0, 1, 0), skew);
      q.multiply(q2);
      m.compose(_v3c.set(ax, cy, cz), q, _v3a.set(1, 1, 1));
      parts.push({ geometry: block, matrix: m });
    }
  }
  return mergeGeoms(parts);
}

/**
 * Rim face: a disc Shape with `spokes` apertures cut out of it, extruded with a
 * bevel. Actual holes in actual geometry — the light gets through them and the
 * bevel catches a highlight on every spoke edge.
 */
function buildRimFace(rimR, style, o = {}) {
  const spokes = o.spokes ?? 5;
  const depth = o.depth ?? 0.16;
  const outer = rimR * 0.965;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, TAU, false);

  const hubR = rimR * (o.hubR ?? 0.30);
  const rimBand = rimR * (o.band ?? 0.13);   // solid ring at the lip
  const rIn = hubR;
  const rOut = outer - rimBand;

  if (style !== 'solid' && rOut > rIn * 1.15) {
    for (let i = 0; i < spokes; i++) {
      const a0 = (i / spokes) * TAU;
      const path = new THREE.Path();
      if (style === 'round') {
        const rc = (rIn + rOut) * 0.5;
        // Two constraints, and both matter: the hole has to fit between the hub
        // and the lip, and adjacent holes must not touch — overlapping holes in
        // a Shape make the triangulator produce garbage.
        const rr = Math.min((rOut - rIn) * 0.42, (TAU * rc / spokes) * 0.36);
        path.absarc(Math.cos(a0) * rc, Math.sin(a0) * rc, rr, 0, TAU, true);
      } else {
        // A tapered aperture: narrow at the hub, wide at the lip, rounded ends.
        const halfIn = (o.apertureIn ?? 0.30) * (TAU / spokes);
        const halfOut = (o.apertureOut ?? 0.40) * (TAU / spokes);
        const steps = 5;
        const pts = [];
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const a = a0 + lerp(-halfIn, -halfOut, t);
          const r = lerp(rIn, rOut, t);
          pts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        for (let k = steps; k >= 0; k--) {
          const t = k / steps;
          const a = a0 + lerp(halfIn, halfOut, t);
          const r = lerp(rIn, rOut, t);
          pts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        // Round the aperture corners so the spokes are cast, not stamped.
        const radii = pts.map(() => (rOut - rIn) * 0.16);
        const ring = roundPolygon(pts, radii, 2, 0);
        path.moveTo(ring.pts[0], ring.pts[1]);
        for (let k = 1; k < ring.count; k++) path.lineTo(ring.pts[k * 2], ring.pts[k * 2 + 1]);
        path.closePath();
      }
      shape.holes.push(path);
    }
  }
  return extrudeDisc(shape, depth, o.bevel ?? Math.min(0.055, depth * 0.42), 16);
}

/** Rim barrel: the dish behind the face, plus the outer lip. */
function buildRimBarrel(rimR, halfW, o = {}) {
  const inset = o.inset ?? 0.30;         // how deep the face sits from the lip
  const profile = [
    [rimR * 0.26, -halfW * 0.80],
    [rimR * 0.94, -halfW * 0.86],
    [rimR * 1.00, -halfW * 0.72],
    [rimR * 0.90, -halfW * 0.55],
    [rimR * 0.88, halfW * (0.60 - inset)],
    [rimR * 0.99, halfW * (0.74 - inset * 0.4)],
    [rimR * 1.00, halfW * 0.80],
    [rimR * 0.94, halfW * 0.90],
    [rimR * 0.80, halfW * 0.88],
  ];
  return revolveX(profile, o.segments ?? 26);
}

/** Lug nuts and a centre cap — the detail that reads as "machined". */
function buildRimTrim(rimR, halfW, o = {}) {
  const parts = [];
  const bolts = o.bolts ?? 5;
  const br = rimR * (o.boltR ?? 0.34);
  const bolt = new THREE.CylinderGeometry(rimR * 0.055, rimR * 0.062, 0.075, 6);
  bolt.rotateZ(-Math.PI / 2);
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * TAU + (o.boltPhase ?? 0);
    parts.push({
      geometry: bolt,
      matrix: xform(halfW * 0.78, Math.cos(a) * br, Math.sin(a) * br),
    });
  }
  const cap = revolveX([
    [0.001, halfW * 0.74],
    [rimR * 0.20, halfW * 0.80],
    [rimR * 0.24, halfW * 0.70],
    [rimR * 0.20, halfW * 0.60],
    [0.001, halfW * 0.58],
  ], 16);
  parts.push({ geometry: cap, matrix: xform(0, 0, 0) });
  return mergeGeoms(parts);
}

/** Vented brake disc with a drilled face, plus a fixed caliper. */
function buildBrake(rimR, halfW, o = {}) {
  const dR = rimR * (o.discR ?? 0.80);
  const disc = revolveX([
    [rimR * 0.20, -0.05],
    [rimR * 0.34, -0.05],
    [rimR * 0.36, -0.10],
    [dR, -0.10],
    [dR, 0.10],
    [rimR * 0.36, 0.10],
    [rimR * 0.34, 0.05],
    [rimR * 0.20, 0.05],
  ], 24);
  disc.translate(-halfW * 0.10, 0, 0);
  const caliper = mergeGeoms([
    { geometry: bevelBox(halfW * 0.42, dR * 0.55, dR * 0.34, 0.05, 2), matrix: xform(-halfW * 0.10, dR * 0.86, -dR * 0.10) },
  ]);
  return { disc, caliper };
}

/**
 * Assemble one corner's worth of wheel geometry.
 * @param {object} cfg { R, halfW, rimR, style, spokes, lugs, ... }
 */
export function buildWheelSet(cfg) {
  const R = cfg.R;
  const halfW = cfg.halfW;
  const rimR = cfg.rimR ?? R * 0.62;
  const tyre = [{ geometry: buildTyre(R, halfW, { rimR, shoulder: cfg.shoulder, bulge: cfg.bulge, segments: cfg.segments }) }];
  if (cfg.lugs) tyre.push({ geometry: buildLugs(R, halfW, cfg.lugs) });
  const tyreGeom = mergeGeoms(tyre);
  tyreGeom.userData.treadV = tyre[0].geometry.userData.treadV || [0.35, 0.65];

  const rim = mergeGeoms([
    { geometry: buildRimFace(rimR, cfg.style || 'taper', cfg), matrix: xform(halfW * (0.58 - (cfg.inset ?? 0.30) * 0.5), 0, 0) },
    { geometry: buildRimBarrel(rimR, halfW, cfg) },
  ]);
  const rimTrim = buildRimTrim(rimR, halfW, cfg);
  const brake = buildBrake(rimR, halfW, cfg);

  return {
    tyre: tyreGeom,
    rim,
    rimTrim,
    disc: brake.disc,
    caliper: brake.caliper,
    radius: R,
    halfWidth: halfW,
    rimR,
  };
}

/* ==========================================================================
 * 3. Canvas foundry — tyres and liveries
 * ========================================================================== */

const HEADLINE_FONT = '"Arial Black", "Helvetica Neue", Impact, "Franklin Gothic Bold", sans-serif';
const PLATE_FONT = '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif';

function canvas2d(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  return { canvas: c, g, w, h };
}

/** Rounded-rect path. Written out rather than using ctx.roundRect so the
 *  livery bake does not depend on a comparatively recent canvas API. */
function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

function finishTexture(canvas, srgb, aniso = 8) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a greyscale height canvas into a tangent-space normal map.
 * Derived from the height field, never faked — the same rule the texture
 * contract imposes on ProcTex.
 */
function normalFromHeight(src, strength = 1.6, wrapX = true) {
  const w = src.width;
  const h = src.height;
  const sg = src.getContext('2d');
  const data = sg.getImageData(0, 0, w, h).data;
  const out = canvas2d(w, h);
  if (!out) return null;
  const img = out.g.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => {
    const xx = wrapX ? ((x % w) + w) % w : clamp(x, 0, w - 1);
    const yy = clamp(y, 0, h - 1);
    return data[(yy * w + xx) * 4] / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1); const t = at(x, y - 1); const tr = at(x + 1, y - 1);
      const l = at(x - 1, y); const r = at(x + 1, y);
      const bl = at(x - 1, y + 1); const b = at(x, y + 1); const br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  out.g.putImageData(img, 0, 0);
  return out.canvas;
}

/** Deterministic value noise wash — kills the "flat vinyl" read of flat fills. */
function noiseWash(g, w, h, rng, amount = 0.05, cell = 26) {
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = rng.next();
      const a = (v - 0.5) * 2 * amount;
      g.fillStyle = a >= 0 ? `rgba(255,255,255,${a.toFixed(3)})` : `rgba(0,0,0,${(-a).toFixed(3)})`;
      g.fillRect(x * cell, y * cell, cell + 1, cell + 1);
    }
  }
}

/* ------------------------------------------------------------------- tyres */

const TYRE_TEXTURES = new Map();

/**
 * Tyre albedo + normal. U wraps the circumference, V crosses the carcass, so
 * the sidewall lettering runs around the wheel and the tread pattern repeats
 * along it exactly as a moulded tyre's does.
 */
export function tyreTexture(style = 'road', treadV = [0.35, 0.65], size = 1024) {
  const key = `${style}|${treadV[0].toFixed(3)}|${treadV[1].toFixed(3)}|${size}`;
  const hit = TYRE_TEXTURES.get(key);
  if (hit) return hit;

  const W = size;
  const H = Math.max(128, size >> 2);
  const c = canvas2d(W, H);
  const hc = canvas2d(W >> 1, H >> 1);
  if (!c || !hc) return { map: null, normalMap: null };
  const { g } = c;
  const gh = hc.g;
  const rng = makeRng(`tyre:${style}`);

  const y0 = (1 - treadV[1]) * H;
  const y1 = (1 - treadV[0]) * H;
  const treadTop = Math.min(y0, y1);
  const treadH = Math.abs(y1 - y0);

  // DEFECTS D3 said this palette was too dark (#202124, 0.019 linear, then
  // multiplied by a tint down to 0.0006 — a hole). The correction overshot:
  // #4a4845 is 0.068 linear, the top of the plausible range for a bloomed
  // sidewall, and with the sheen the material was adding on top the tyre
  // measured luma 95-115 in the macro frame against a rim face at ~140. That
  // is 1.4:1, and it made the rubber *brighter* than the sunlit paint and the
  // sunlit table, which is backwards: rubber is the value anchor of a die-cast,
  // the darkest thing on the object, and the tyre/rim boundary is its
  // highest-contrast edge.
  //
  // Carbon-black tyre rubber measures 3-7% diffuse reflectance. #333230 is
  // 0.033 linear — squarely inside that, 55x above the D3 void, and dark enough
  // that the alloy rim finally out-values it by the margin a photograph shows.
  // The tread band below is darker again because it is scrubbed of bloom.
  g.fillStyle = '#333230';
  g.fillRect(0, 0, W, H);
  gh.fillStyle = '#808080';
  gh.fillRect(0, 0, hc.w, hc.h);

  // Sidewall: concentric moulding ribs plus a raised rim-protector band.
  for (const [top, bottom] of [[0, treadTop], [treadTop + treadH, H]]) {
    for (let y = top; y < bottom; y += 3) {
      const t = (y - top) / Math.max(1, bottom - top);
      const shade = 0.86 + Math.sin(t * 22) * 0.05 + (rng.next() - 0.5) * 0.03;
      g.fillStyle = `rgb(${(58 * shade) | 0},${(56 * shade) | 0},${(53 * shade) | 0})`;
      g.fillRect(0, y, W, 3);
      gh.fillStyle = `rgba(${(128 + Math.sin(t * 22) * 26) | 0},0,0,1)`;
      gh.fillRect(0, (y * 0.5) | 0, hc.w, 2);
    }
  }

  // Sidewall lettering. Raised, so it reads as moulded rubber rather than ink.
  const labelY = treadTop * 0.55;
  const labelY2 = treadTop + treadH + (H - treadTop - treadH) * 0.45;
  const marks = ['MICRO GAUNTLET', style === 'knobbly' ? 'CLAWTRAC MT' : style === 'slick' ? 'GRIP-X R' : 'GRIP-X GT'];
  for (let rep = 0; rep < 2; rep++) {
    for (let k = 0; k < 2; k++) {
      const yy = k === 0 ? labelY : labelY2;
      const txt = marks[(rep + k) % marks.length];
      const px = (rep * 0.5 + 0.06) * W;
      const fs = Math.max(9, H * 0.085);
      g.save();
      g.translate(px, yy);
      if (k === 1) g.scale(1, -1);
      g.font = `700 ${fs}px ${HEADLINE_FONT}`;
      g.textBaseline = 'middle';
      // Raised lettering is the same rubber catching a little more light, not
      // white ink. Against a #333230 sidewall this lands about 45% brighter,
      // which is what a moulded relief actually does; the old 214-grey at 0.30
      // was painting near-white text onto the darkest part of the car.
      g.fillStyle = 'rgba(140,136,130,0.26)';
      g.fillText(txt, 0, 0);
      g.restore();
      gh.save();
      gh.translate(px * 0.5, yy * 0.5);
      if (k === 1) gh.scale(1, -1);
      gh.font = `700 ${fs * 0.5}px ${HEADLINE_FONT}`;
      gh.textBaseline = 'middle';
      gh.fillStyle = '#c8c8c8';
      gh.fillText(txt, 0, 0);
      gh.restore();
    }
  }

  // Tread. Each style is a real pattern, not noise: a groove layout plus block
  // edges, which is what gives the normal map something to catch light on.
  // The tread band is the working surface: scrubbed clean of bloom, so it is
  // the darkest part of the tyre rather than the same value as the sidewall.
  g.fillStyle = '#262523';
  g.fillRect(0, treadTop, W, treadH);
  gh.fillStyle = '#8c8c8c';
  gh.fillRect(0, treadTop * 0.5, hc.w, treadH * 0.5);

  const drawBlock = (x, y, bw, bh, shade) => {
    g.fillStyle = `rgb(${(54 * shade) | 0},${(52 * shade) | 0},${(49 * shade) | 0})`;
    g.fillRect(x, y, bw, bh);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(x, y, bw, 1.5);
    gh.fillStyle = '#d2d2d2';
    gh.fillRect(x * 0.5, y * 0.5, bw * 0.5, bh * 0.5);
  };

  if (style === 'knobbly') {
    const cols = 12;
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        const off = (r % 2) * (W / cols) * 0.5;
        const x = off + (i / cols) * W;
        const bw = (W / cols) * 0.56;
        const bh = (treadH / rows) * 0.66;
        const y = treadTop + (r / rows) * treadH + (treadH / rows) * 0.17;
        drawBlock(x, y, bw, bh, 0.94 + rng.next() * 0.12);
      }
    }
  } else if (style === 'slick') {
    for (let i = 0; i < 4; i++) {
      const y = treadTop + treadH * (0.18 + i * 0.22);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, y, W, Math.max(1, treadH * 0.012));
      gh.fillStyle = '#6a6a6a';
      gh.fillRect(0, y * 0.5, hc.w, 1);
    }
    drawBlock(0, treadTop, W, treadH * 0.02, 1.0);
  } else {
    // Directional road tread: three longitudinal grooves and angled sipes.
    //
    // The pattern is authored at 1:1 and then looked at from three metres away
    // on a 2.3 u wheel, and that is the whole problem. At the game camera the
    // tread band is a handful of pixels tall, so a groove drawn 5.5% of it deep
    // at 55% black does not resolve as a groove — it averages into the band as
    // a flat, very dark strip, and the same happens to the sipes across the
    // whole width. The tyre then has no internal structure at all, only one
    // near-black value, and the rim face inside it loses the contrast it needs
    // to read as a separate, brighter object. Rubber staying the darkest thing
    // on the car is correct; the tyre out-contrasting the rim is not.
    //
    // Cut to a little under half in both depth and fill, so the grooves are
    // still there under the macro lens and average close to the tread's own
    // value at race distance.
    const grooves = [0.22, 0.44, 0.66];
    const grooveH = 0.030;
    for (const gy of grooves) {
      const y = treadTop + treadH * gy;
      g.fillStyle = 'rgba(0,0,0,0.30)';
      g.fillRect(0, y, W, Math.max(2, treadH * grooveH));
      gh.fillStyle = '#4a4a4a';
      gh.fillRect(0, y * 0.5, hc.w, Math.max(1, treadH * grooveH * 0.5));
    }
    // Sipes on the outer ribs only. A real tyre sipes the shoulders hardest
    // anyway, and confining them there leaves the two centre ribs as clean
    // rubber — which is what carries the crown highlight along the top of the
    // wheel and stops the whole band collapsing to one value.
    const ribs = [[0, grooves[0]], [grooves[grooves.length - 1] + grooveH, 1]];
    const cols = style === 'rally' ? 20 : 28;
    for (let i = 0; i < cols; i++) {
      const x = (i / cols) * W;
      const skew = style === 'rally' ? 0.34 : 0.18;
      // The frame stays anchored at the top of the tread band and the rib is
      // selected by the rect's own y, so the skew carries the same slant across
      // both shoulders instead of restarting at each one.
      g.save();
      gh.save();
      g.translate(x, treadTop);
      gh.translate(x * 0.5, treadTop * 0.5);
      g.transform(1, 0, skew, 1, 0, 0);
      gh.transform(1, 0, skew, 1, 0, 0);
      g.fillStyle = 'rgba(0,0,0,0.42)';
      gh.fillStyle = '#5e5e5e';
      for (const [v0, v1] of ribs) {
        const ry = treadH * v0;
        const rh = treadH * (v1 - v0);
        if (rh <= 0) continue;
        g.fillRect(0, ry, Math.max(2, W / cols * 0.20), rh);
        gh.fillRect(0, ry * 0.5, Math.max(1, W / cols * 0.10), rh * 0.5);
      }
      g.restore();
      gh.restore();
    }
  }

  noiseWash(g, W, H, rng, 0.045, 9);

  const set = {
    map: finishTexture(c.canvas, true),
    normalMap: finishTexture(normalFromHeight(hc.canvas, 2.1, true) || hc.canvas, false),
  };
  TYRE_TEXTURES.set(key, set);
  return set;
}

/* ------------------------------------------------------------- number plate */

const PLATE_TEXTURES = new Map();

/**
 * The pressed rear registration plate.
 *
 * The plate blank was already its own material — an off-white that out-values
 * every paint in the roster in shadow — but a blank slab of it is a white
 * rectangle, and a white rectangle on a tail is exactly as much of a
 * placeholder as the painted slab it replaced. What identifies a die-cast from
 * behind is *characters*: dark glyphs on a light ground is the highest-contrast
 * element on the whole car, and it survives being three pixels tall because at
 * that size it stops being letters and becomes a dark bar with a light margin,
 * which is still the right read.
 *
 * Three separate things carry it:
 *   - albedo: the pressed ground, a colour band, and the glyphs;
 *   - height (and so the normal map derived from it): the glyphs stand proud,
 *     the border groove is pressed in. A plate whose text is painted on rather
 *     than embossed goes flat the moment the key leaves it, which on a tail is
 *     most of the time;
 *   - the border groove itself, which gives the blank an edge that is not just
 *     the silhouette against the paint behind it.
 *
 * Cached by text, so eight cars carrying eight numbers cost eight small
 * canvases once, and every car of the same number shares one.
 */
export function plateTexture(text = 'MG 01', opts = {}) {
  const label = String(text || 'MG 01').toUpperCase().slice(0, 8);
  const key = `${label}|${opts.size || 512}`;
  const hit = PLATE_TEXTURES.get(key);
  if (hit) return hit;

  const W = opts.size || 512;
  const H = Math.max(64, Math.round(W * 0.22));
  const c = canvas2d(W, H);
  const hc = canvas2d(W, H);
  if (!c || !hc) return { map: null, normalMap: null };
  const { g } = c;
  const gh = hc.g;
  const rng = makeRng(`plate:${label}`);

  // Ground. Slightly warm off-white with a top-down gradient: a pressed alloy
  // blank is never one value, it catches the sky along its top edge.
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#f2f2ee');
  grad.addColorStop(0.55, '#e4e5e1');
  grad.addColorStop(1, '#d2d3cf');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  gh.fillStyle = '#9a9a9a';
  gh.fillRect(0, 0, W, H);

  // Colour band down the left edge — the one saturated element on the tail
  // that is neither paint nor a lamp, so it reads as a separate object even
  // when the plate itself is in shadow.
  const bandW = Math.round(W * 0.13);
  g.fillStyle = '#152a63';
  g.fillRect(0, 0, bandW, H);
  g.fillStyle = 'rgba(255,255,255,0.10)';
  g.fillRect(0, 0, bandW, Math.max(1, H * 0.10));
  // A ring of pips rather than a country code: three letters at this size are
  // mush, a dot pattern still resolves as a mark.
  g.fillStyle = '#e8c23a';
  const pipR = Math.max(1, H * 0.045);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU - Math.PI / 2;
    g.beginPath();
    g.arc(bandW * 0.5 + Math.cos(a) * bandW * 0.26, H * 0.42 + Math.sin(a) * bandW * 0.26, pipR, 0, TAU);
    g.fill();
  }

  // Pressed border groove, inset from the edge, on both albedo and height.
  const pad = Math.max(2, H * 0.10);
  const lw = Math.max(1.5, H * 0.035);
  g.lineWidth = lw;
  g.strokeStyle = 'rgba(60,62,58,0.55)';
  roundRectPath(g, pad, pad, W - pad * 2, H - pad * 2, H * 0.10);
  g.stroke();
  gh.lineWidth = lw;
  gh.strokeStyle = '#4e4e4e';
  roundRectPath(gh, pad, pad, W - pad * 2, H - pad * 2, H * 0.10);
  gh.stroke();

  // Characters. Embossed: the height canvas gets them bright, so the normal
  // map lifts them off the blank.
  const textX = bandW + (W - bandW) * 0.5;
  const fs = H * 0.62;
  for (const target of [g, gh]) {
    target.save();
    target.translate(textX, H * 0.54);
    target.font = `700 ${fs}px ${PLATE_FONT}`;
    target.textAlign = 'center';
    target.textBaseline = 'middle';
    target.fillStyle = target === g ? '#1a1f2b' : '#e0e0e0';
    target.fillText(label, 0, 0);
    target.restore();
  }
  // A one-pixel light lip along the top of each glyph sells the emboss in the
  // albedo as well, for the frames where the normal map is facing away.
  g.save();
  g.translate(textX, H * 0.54 - Math.max(1, H * 0.02));
  g.font = `700 ${fs}px ${PLATE_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillText(label, 0, 0);
  g.restore();

  noiseWash(g, W, H, rng, 0.028, 11);

  const map = finishTexture(c.canvas, true, 8);
  const normalMap = finishTexture(normalFromHeight(hc.canvas, 1.5, false) || hc.canvas, false, 8);
  // The unwrap is exactly 0..1 over one face, so any wrap other than clamp
  // lets the side walls sample a mirrored copy of the glyphs.
  for (const t of [map, normalMap]) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
  }
  const set = { map, normalMap };
  PLATE_TEXTURES.set(key, set);
  return set;
}

/* ----------------------------------------------------------------- liveries */

const SPONSORS = [
  'MICRO', 'NITRO 9', 'TOYBOX', 'OCTA', 'VOLT', 'PISTON', 'GRIP-X', 'CARBO',
  'APEX FUEL', 'K-DRIVE', 'HALO OIL', 'TIN CAN', 'SPARK', 'RIVET', 'ZED',
  'BOLT & CO', 'DIECAST', 'FLUX', 'ATLAS', 'NINE', 'CRUMB', 'SOLDER',
];

function hexStr(c) {
  return '#' + new THREE.Color(c).getHexString();
}
function shade(c, amt) {
  const col = new THREE.Color(c);
  if (amt >= 0) col.lerp(new THREE.Color(0xffffff), amt);
  else col.lerp(new THREE.Color(0x000000), -amt);
  return '#' + col.getHexString();
}

// The nose panel is a solid full-height column of body colour at the extreme
// +U end of the atlas, so it is the one place guaranteed to be opaque and
// on-palette no matter which livery is playing. Every painted part that is not
// the lofted shell collapses onto a single texel of it (see makeCollector).
// V is taken mid-flank so the wear shader keys off a sensible height rather
// than the sill, where it would scuff and dirty the trim on its own schedule.
function flatPaintUV(bands) {
  return [0.989, (bands[0] + bands[2]) * 0.5];
}

/**
 * Paint one car's albedo and normal map.
 *
 * The canvas is a full ring unwrap: X runs tail-to-nose, Y is the band around
 * the section. The band boundaries come from the geometry, so the flank
 * artwork lands on the flank on every one of the eight bodies without a single
 * per-model magic number.
 *
 * The alpha channel is load-bearing: the window openings are punched out of it
 * so the shell has real holes and the glazing has something to be transparent
 * *over*. That is the whole difference between a car with glass and a car with
 * a dark rectangle painted where glass should be.
 */
export function makeLiveryTextures(chassis, livery, opts = {}) {
  const W = opts.size || 1024;
  const H = W >> 1;
  const c = canvas2d(W, H);
  const hc = canvas2d(W >> 1, H >> 1);
  if (!c || !hc) return { map: null, normalMap: null };
  const { g } = c;
  const gh = hc.g;
  const rng = makeRng(`livery:${chassis.id}:${livery.name}`);

  const b = chassis.uv.bands;         // [b0..b5, 1]
  const zMin = chassis.uv.zMin;
  const zSpan = Math.max(0.01, chassis.uv.zMax - zMin);
  const ux = (z) => ((z - zMin) / zSpan) * W;

  const flankH = (b[2] - b[0]) * H;
  const roofH = (b[3] - b[2]) * H;

  const base = hexStr(livery.base);
  const second = hexStr(livery.secondary ?? livery.base);
  const accent = hexStr(livery.accent ?? 0xf2f4f7);

  /* --- ground colour ---------------------------------------------------- */
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  gh.fillStyle = '#808080';
  gh.fillRect(0, 0, hc.w, hc.h);

  // The underside is never body colour on a real toy: it is the base plate.
  // The floor band is V in [b5, 1], which lands at the very top of the canvas.
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, W, (1 - b[5]) * H);

  /* --- band transforms --------------------------------------------------- */
  const enterFlank = (side) => {
    g.save();
    gh.save();
    if (side === 'right') {
      g.setTransform(1, 0, 0, 1, 0, (1 - b[2]) * H);
      gh.setTransform(0.5, 0, 0, 0.5, 0, (1 - b[2]) * H * 0.5);
    } else {
      g.setTransform(1, 0, 0, -1, 0, (1 - b[3]) * H);
      gh.setTransform(0.5, 0, 0, -0.5, 0, (1 - b[3]) * H * 0.5);
    }
  };
  const enterRoof = () => {
    g.save();
    gh.save();
    g.setTransform(1, 0, 0, -1, 0, (1 - b[2]) * H);
    gh.setTransform(0.5, 0, 0, -0.5, 0, (1 - b[2]) * H * 0.5);
  };
  const leave = () => { g.restore(); gh.restore(); g.setTransform(1, 0, 0, 1, 0, 0); gh.setTransform(1, 0, 0, 1, 0, 0); };

  /** Text that reads correctly from outside the car on whichever flank it is on. */
  const flankText = (side, str, x, y, px, fill, weight = '900', font = HEADLINE_FONT) => {
    g.save();
    g.translate(x, y);
    if (side === 'right') g.scale(-1, 1);
    g.font = `${weight} ${px}px ${font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = fill;
    g.fillText(str, 0, 0);
    g.restore();
  };

  const cab = chassis.cabin;
  const noseU = ux(chassis.uv.zMax);
  const tailU = ux(chassis.uv.zMin);

  /* --- window openings ---------------------------------------------------
   * Collected as they are drawn and punched out of the alpha channel in one
   * pass at the very end, after the noise wash — anything drawn over a hole
   * would fill it back in. `chassis.uv.glass` is the pane's real extent, taken
   * from the glazing geometry rather than from the cabin table, so an opening
   * can never end up somewhere the pane does not cover. No pane, no holes. */
  const gz = chassis.uv.glass;
  const punches = [];
  const seal = Math.max(2.5, flankH * 0.045);
  /** Clamp a z range into the pane and convert to canvas X. */
  const glassSpanU = (z0, z1) => {
    if (!gz) return null;
    const a = Math.max(z0, gz.z0);
    const b2 = Math.min(z1, gz.z1);
    if (b2 - a < 0.12) return null;
    return [ux(a), ux(b2)];
  };

  /* --- flank artwork ----------------------------------------------------- */
  const paintFlank = (side) => {
    enterFlank(side);
    const hF = flankH;

    // Two-tone / lower-body split.
    if (livery.pattern === 'twoTone' || livery.pattern === 'halves') {
      const split = livery.pattern === 'halves' ? hF * 0.5 : hF * (livery.split ?? 0.58);
      g.fillStyle = second;
      g.fillRect(0, split, W, hF - split);
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(0, split - 1.5, W, 2.5);
      gh.fillStyle = '#5c5c5c';
      gh.fillRect(0, split - 1, W, 2);
    }

    // Longitudinal stripes.
    if (livery.pattern === 'stripes' || livery.pattern === 'racing') {
      const cy = hF * (livery.stripeY ?? 0.40);
      const th = hF * (livery.stripeW ?? 0.16);
      g.fillStyle = second;
      g.fillRect(0, cy - th * 0.5, W, th);
      g.fillStyle = accent;
      g.fillRect(0, cy - th * 0.5 - th * 0.22, W, th * 0.20);
      g.fillRect(0, cy + th * 0.5 + th * 0.02, W, th * 0.20);
    }

    if (livery.pattern === 'rally') {
      // A swept wedge from the sill up over the rear haunch.
      g.beginPath();
      g.moveTo(0, hF);
      g.lineTo(W * 0.52, hF);
      g.lineTo(W * 0.30, hF * 0.42);
      g.lineTo(0, hF * 0.50);
      g.closePath();
      g.fillStyle = second;
      g.fill();
      g.beginPath();
      g.moveTo(W * 0.30, hF * 0.42);
      g.lineTo(W * 0.52, hF);
      g.lineTo(W * 0.60, hF);
      g.lineTo(W * 0.38, hF * 0.40);
      g.closePath();
      g.fillStyle = accent;
      g.fill();
    }

    if (livery.pattern === 'flame') {
      g.fillStyle = second;
      for (let i = 0; i < 7; i++) {
        const x0 = W * (0.58 + i * 0.055);
        const amp = hF * (0.20 + rng.next() * 0.26);
        g.beginPath();
        g.moveTo(x0, hF);
        g.quadraticCurveTo(x0 - W * 0.16, hF - amp, x0 - W * 0.34, hF - amp * 0.55);
        g.quadraticCurveTo(x0 - W * 0.16, hF - amp * 0.22, x0 - W * 0.02, hF);
        g.closePath();
        g.fill();
      }
      g.fillStyle = accent;
      g.globalAlpha = 0.55;
      for (let i = 0; i < 4; i++) {
        const x0 = W * (0.60 + i * 0.075);
        const amp = hF * (0.14 + rng.next() * 0.16);
        g.beginPath();
        g.moveTo(x0, hF);
        g.quadraticCurveTo(x0 - W * 0.12, hF - amp, x0 - W * 0.26, hF - amp * 0.5);
        g.quadraticCurveTo(x0 - W * 0.10, hF - amp * 0.2, x0, hF);
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;
    }

    if (livery.pattern === 'checker') {
      const n = 16;
      const cw = W / n;
      const ch = hF * 0.18;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 2; k++) {
          if ((i + k) % 2) continue;
          g.fillStyle = second;
          g.fillRect(i * cw, hF - ch * (2 - k), cw, ch);
        }
      }
    }

    // Side glazing. The door glass is cut clean out of the body — the alpha
    // punch below — so what is painted here is only what surrounds it: the
    // black rubber weatherstrip and the pillar shadow. A die-cast's window is
    // a hole with a tinted insert in it, and until now this was a rectangle of
    // #0b0d10 with a gradient over it, which is exactly what "painted-on
    // glass" means.
    if (cab && cab.glassZ) {
      let gy0 = hF * (1 - (cab.beltFrac ?? 0.62));
      const x0 = ux(cab.glassZ[0]);
      const x1 = ux(cab.glassZ[1]);
      g.fillStyle = '#0b0d10';
      g.fillRect(x0, 0, x1 - x0, gy0);
      const grd = g.createLinearGradient(0, 0, 0, gy0);
      grd.addColorStop(0, 'rgba(96,116,140,0.42)');
      grd.addColorStop(0.55, 'rgba(20,26,34,0.10)');
      grd.addColorStop(1, 'rgba(8,10,14,0.55)');
      g.fillStyle = grd;
      g.fillRect(x0, 0, x1 - x0, gy0);
      // Window surround, in trim black — every die-cast has one.
      g.strokeStyle = 'rgba(14,15,18,0.9)';
      g.lineWidth = Math.max(2, hF * 0.035);
      g.strokeRect(x0, -2, x1 - x0, gy0 + 2);

      const span = glassSpanU(cab.glassZ[0], cab.glassZ[1]);
      if (span) {
        // The daylight opening also has to stay inside the pane in V. The belt
        // line is authored as a fraction of the flank, the pane's lower edge
        // is a ring index; whichever sits higher wins, plus a seal's width.
        const vFloor = gz.vLo + (b[2] - b[0]) * 0.02;
        gy0 = Math.min(gy0, Math.max(0, (b[2] - vFloor) * H));
        // Top edge stops a seal short of the roof corner, which is the roof
        // rail; bottom edge stops a seal short of the belt line.
        const top = seal * 0.6;
        const h = gy0 - seal - top;
        if (h > seal) {
          punches.push({ band: side, x: span[0] + seal, y: top, w: span[1] - span[0] - seal * 2, h, r: seal * 1.6 });
        }
      }
    }

    // Number roundel.
    if (livery.number != null) {
      const nx = ux(chassis.numberZ ?? (chassis.axleZ.rear + chassis.axleZ.front) * 0.5);
      const ny = hF * (livery.numberY ?? 0.46);
      const rad = hF * (livery.numberR ?? 0.30);
      if (livery.numberStyle !== 'plain') {
        g.beginPath();
        g.arc(nx, ny, rad, 0, TAU);
        g.fillStyle = livery.numberPlate ? hexStr(livery.numberPlate) : '#f4f5f7';
        g.fill();
        g.lineWidth = rad * 0.11;
        g.strokeStyle = 'rgba(20,22,26,0.75)';
        g.stroke();
        gh.beginPath();
        gh.arc(nx * 0.5, ny * 0.5, rad * 0.5, 0, TAU);
        gh.fillStyle = '#9c9c9c';
        gh.fill();
      }
      flankText(side, String(livery.number), nx, ny + rad * 0.04, rad * 1.32,
        livery.numberStyle !== 'plain' ? '#15171b' : accent);
    }

    // Sponsor marks. Small, low-contrast, placed where a real one would go.
    const sp = livery.sponsors || [];
    for (let i = 0; i < sp.length; i++) {
      const px = ux(lerp(chassis.axleZ.rear + 0.6, chassis.axleZ.front - 0.4, (i + 0.5) / Math.max(1, sp.length)));
      const py = hF * (0.80 - (i % 2) * 0.05);
      flankText(side, sp[i], px, py, hF * 0.115, livery.sponsorColor ? hexStr(livery.sponsorColor) : shade(livery.base, -0.55), '800', PLATE_FONT);
    }

    // Door and panel shuts, in the albedo and in the height field.
    const shuts = chassis.shutZ || [];
    for (const sz of shuts) {
      const x = ux(sz);
      g.fillStyle = 'rgba(0,0,0,0.30)';
      g.fillRect(x - 0.75, hF * 0.06, 1.5, hF * 0.86);
      gh.fillStyle = '#5a5a5a';
      gh.fillRect(x - 0.5, hF * 0.06, 1, hF * 0.86);
    }

    // The mould's parting line: the seam where the cast body meets the plate.
    g.fillStyle = 'rgba(0,0,0,0.34)';
    g.fillRect(0, hF - Math.max(1.5, hF * 0.028), W, Math.max(1.5, hF * 0.028));
    gh.fillStyle = '#585858';
    gh.fillRect(0, hF - Math.max(1, hF * 0.02), W, Math.max(1, hF * 0.02));

    // A little grime up from the sill: it grounds the paint.
    const dirt = g.createLinearGradient(0, hF, 0, hF * 0.60);
    dirt.addColorStop(0, 'rgba(46,38,28,0.34)');
    dirt.addColorStop(1, 'rgba(46,38,28,0)');
    g.fillStyle = dirt;
    g.fillRect(0, hF * 0.60, W, hF * 0.40);

    leave();
  };

  paintFlank('right');
  paintFlank('left');

  /* --- roof / plan view -------------------------------------------------- */
  enterRoof();
  const hR = roofH;
  if (livery.pattern === 'twoTone' && livery.roofSecondary !== false) {
    g.fillStyle = second;
    g.fillRect(0, 0, W, hR);
  }
  if (livery.pattern === 'stripes' || livery.pattern === 'racing') {
    const cw = hR * (livery.roofStripeW ?? 0.22);
    g.fillStyle = second;
    g.fillRect(0, hR * 0.5 - cw, W, cw * 2);
    g.fillStyle = accent;
    g.fillRect(0, hR * 0.5 - cw - cw * 0.26, W, cw * 0.24);
    g.fillRect(0, hR * 0.5 + cw + cw * 0.02, W, cw * 0.24);
  }
  if (cab && cab.glassZ) {
    // Windscreen and backlight. Same story as the flanks: what stays painted
    // is the frame, the aperture itself is cut out below.
    const wz = cab.screenZ || [cab.glassZ[1] - 0.3, cab.glassZ[1] + 1.1];
    const bz = cab.backlightZ || [cab.glassZ[0] - 1.0, cab.glassZ[0] + 0.3];
    g.fillStyle = '#0a0c0f';
    g.fillRect(ux(wz[0]), hR * 0.10, ux(wz[1]) - ux(wz[0]), hR * 0.80);
    if (cab.backlightZ !== null) g.fillRect(ux(bz[0]), hR * 0.12, ux(bz[1]) - ux(bz[0]), hR * 0.76);
    const gr = g.createLinearGradient(ux(wz[0]), 0, ux(wz[1]), 0);
    gr.addColorStop(0, 'rgba(150,175,205,0.10)');
    gr.addColorStop(1, 'rgba(150,175,205,0.46)');
    g.fillStyle = gr;
    g.fillRect(ux(wz[0]), hR * 0.10, ux(wz[1]) - ux(wz[0]), hR * 0.80);

    const ws = glassSpanU(wz[0], wz[1]);
    if (ws) punches.push({ band: 'roof', x: ws[0] + seal, y: hR * 0.10 + seal, w: ws[1] - ws[0] - seal * 2, h: hR * 0.80 - seal * 2, r: seal * 1.4 });
    const bs = cab.backlightZ === null ? null : glassSpanU(bz[0], bz[1]);
    if (bs) punches.push({ band: 'roof', x: bs[0] + seal, y: hR * 0.12 + seal, w: bs[1] - bs[0] - seal * 2, h: hR * 0.76 - seal * 2, r: seal * 1.4 });
  }
  // Bonnet and boot shuts, seen from above.
  for (const sz of (chassis.hoodZ || [])) {
    const x = ux(sz);
    g.fillStyle = 'rgba(0,0,0,0.26)';
    g.fillRect(x - 0.75, 0, 1.5, hR);
    gh.fillStyle = '#5c5c5c';
    gh.fillRect(x - 0.5, 0, 1, hR);
  }
  // The centreline mould seam, running the length of the roof.
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, hR * 0.5 - 0.6, W, 1.2);
  leave();

  /* --- nose and tail panels --------------------------------------------- */
  // Both end caps fan their UVs across the full V range at the extreme U, so a
  // full-height column at each end of the canvas dresses them.
  const noseW = Math.max(6, W * 0.022);
  g.fillStyle = livery.nose ? hexStr(livery.nose) : shade(livery.base, -0.10);
  g.fillRect(noseU - noseW, 0, noseW, H);
  g.fillStyle = livery.tail ? hexStr(livery.tail) : shade(livery.base, -0.16);
  g.fillRect(tailU, 0, noseW, H);
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(noseU - noseW, (1 - b[2]) * H, noseW, flankH * 0.30);
  g.fillRect(tailU, (1 - b[2]) * H, noseW, flankH * 0.24);

  noiseWash(g, W, H, rng, 0.035, 14);

  // The one texel every non-shell painted part samples. Drawn last so nothing
  // can overwrite it, inside the nose column so it is invisible on the car.
  const flat = flatPaintUV(b);
  g.fillStyle = livery.nose ? hexStr(livery.nose) : shade(livery.base, -0.10);
  g.fillRect(flat[0] * W - 3, (1 - flat[1]) * H - 3, 6, 6);

  /* --- cut the daylight openings ----------------------------------------
   * destination-out, so the alpha goes to zero and the paint material's alpha
   * test drops those fragments. Last pass: a hole is only a hole until
   * something paints over it. */
  for (const p of punches) {
    if (!(p.w > 1 && p.h > 1)) continue;
    if (p.band === 'roof') enterRoof(); else enterFlank(p.band);
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    roundRectPath(g, p.x, p.y, p.w, p.h, Math.min(p.r, p.w * 0.45, p.h * 0.45));
    g.fill();
    g.globalCompositeOperation = 'source-over';
    leave();
  }

  const map = finishTexture(c.canvas, true, opts.anisotropy ?? 8);
  const normalMap = finishTexture(normalFromHeight(hc.canvas, 1.35, false) || hc.canvas, false, opts.anisotropy ?? 8);
  return { map, normalMap, hasAperture: punches.length > 0 };
}

/* ==========================================================================
 * 4. The body builder
 *
 * Cross-sections are six-sided — sill, maximum beam, roof edge and their
 * mirrors — with an independent fillet radius on every vertex. Six vertices is
 * the fewest that can express the three things that actually define a car's
 * cross-section: how far it tucks under at the rocker, where its widest point
 * sits, and how much tumblehome the greenhouse has.
 * ========================================================================== */

const CORNER_STEPS = 4;
const EDGE_STEPS = 3;                       // odd, so the ring has an exact
const RING_PER = CORNER_STEPS + 1 + EDGE_STEPS;   // top-centre sample to mirror about
const RING_N = RING_PER * 6;
const RING_TOP = RING_PER * 2 + CORNER_STEPS + (EDGE_STEPS + 1) / 2;

/** Catmull-Rom through the key stations, clamped so a width can never overshoot. */
function sampleKeys(keys, z, field) {
  const n = keys.length;
  if (z <= keys[0].z) return keys[0][field];
  if (z >= keys[n - 1].z) return keys[n - 1][field];
  let i = 0;
  while (i < n - 2 && keys[i + 1].z < z) i++;
  const p1 = keys[i];
  const p2 = keys[i + 1];
  const p0 = keys[Math.max(0, i - 1)];
  const p3 = keys[Math.min(n - 1, i + 2)];
  const h = Math.max(1e-5, p2.z - p1.z);
  const t = (z - p1.z) / h;
  const v0 = p0[field]; const v1 = p1[field]; const v2 = p2[field]; const v3 = p3[field];
  const m1 = (v2 - v0) / Math.max(1e-5, p2.z - p0.z) * h;
  const m2 = (v3 - v1) / Math.max(1e-5, p3.z - p1.z) * h;
  const t2 = t * t;
  const t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * v1 + (t3 - 2 * t2 + t) * m1
    + (-2 * t3 + 3 * t2) * v2 + (t3 - t2) * m2;
  const lo = Math.min(v1, v2);
  const hi = Math.max(v1, v2);
  const pad = (hi - lo) * 0.35 + 1e-4;
  return clamp(v, lo - pad, hi + pad);
}

/**
 * Build every cross-section of one body and the loft that runs through them.
 * @returns {{ slices, vTable, bands, section(z), zMin, zMax, geometry }}
 */
function buildBodyShell(cfg) {
  const keys = cfg.keys.slice().sort((a, b) => a.z - b.z);
  for (const k of keys) {
    if (k.sill === undefined) k.sill = k.wide * 0.90;
    if (k.mid === undefined) k.mid = cfg.floorY + (k.top - cfg.floorY) * 0.46;
    if (k.rTop === undefined) k.rTop = cfg.rTop ?? 0.34;
    if (k.rMid === undefined) k.rMid = cfg.rMid ?? 0.30;
    if (k.rSill === undefined) k.rSill = cfg.rSill ?? 0.22;
  }

  const zTail = keys[0].z;
  const zNose = keys[keys.length - 1].z;
  const arches = cfg.arches || [];

  /* --- how much of each end is cap, and why it is not what was authored ---
   *
   * A cap is an INSET OF ONE STATION'S RING, not a sampled section: whatever
   * cross-section the first (or last) station happens to have is frozen into
   * the whole cap. Take that station inside a wheel arch and the arch's raised
   * floor is what the entire end of the car is made of.
   *
   * That is what the muscle's tail was. Its rear axle sits at z = -3.245 with a
   * 1.29 arch radius, so the arch lifts the floor as far back as z = -4.535;
   * the body ends at -4.75 and capTail 0.34 put the last station at -4.41,
   * still 0.125 u inside the arch. Measured, the rearmost 0.34 u of a 9.5 u car
   * was a 3.14 x 0.30 lip 1.5 u off the ground with open air below it, and the
   * tail lamps, the reversing lamps, the valance, the plate and the exhausts
   * all hung in that air with no bodywork behind any of them. The pickup was
   * the same at 0.29, the rally at 0.45.
   *
   * Pulling the cap back until its station clears the arch gives those cars
   * their rear panel back — 0.30 u of lip becomes 1.5 u of body — and costs
   * only roll radius on the corner. The floor keeps a real roll even on a
   * short overhang that can never clear its arch (the rally hatch has 0.006 u
   * of room), because a razor edge is the defect the roll was added to fix.
   * Nothing here moves zMin or zMax: the cap always ends at the key station, so
   * the livery's z parameterisation is untouched.
   */
  const CAP_MIN = 0.12;
  // Landing the station exactly on the arch edge is not clear of it: there the
  // arch has lowered the opening to hub height but not yet let the floor go, so
  // the section is still a metre of car short. Measured on the muscle, exact
  // gave a 0.72 u rear face and 0.02 u past it gave 1.49. The arch wall is
  // vertical, so the margin only has to beat rounding.
  const ARCH_MARGIN = 0.02;
  const capRoom = (zEnd, dir) => {
    let room = Infinity;
    for (const a of arches) {
      const d = (dir < 0 ? (a.z - a.r) - zEnd : zEnd - (a.z + a.r)) - ARCH_MARGIN;
      if (d < room) room = d;
    }
    return room;
  };
  const capN0 = cfg.capNose ?? 0.36;
  const capT0 = cfg.capTail ?? 0.30;
  const capN = clamp(Math.min(capN0, capRoom(zNose, 1)), Math.min(CAP_MIN, capN0), capN0);
  const capT = clamp(Math.min(capT0, capRoom(zTail, -1)), Math.min(CAP_MIN, capT0), capT0);
  const zA = zTail + capT;
  const zB = zNose - capN;

  const floorAt = (z) => {
    let y = cfg.floorY;
    for (const a of arches) {
      const d = Math.abs(z - a.z);
      if (d < a.r) y = Math.max(y, a.hub + Math.sqrt(Math.max(0, a.r * a.r - d * d)));
    }
    return y;
  };

  /** Cross-section parameters at z, already made self-consistent. */
  const section = (z) => {
    const y0 = floorAt(z);
    let y1 = sampleKeys(keys, z, 'top');
    if (y1 < y0 + 0.10) y1 = y0 + 0.10;
    const span = y1 - y0;
    const wide = Math.max(0.06, sampleKeys(keys, z, 'wide'));
    let sill = Math.max(0.03, sampleKeys(keys, z, 'sill'));
    let roof = Math.max(0.03, sampleKeys(keys, z, 'roof'));
    let mid = sampleKeys(keys, z, 'mid');
    // A section squeezed thin by an arch has to keep its shape: blend the sill
    // and roof widths toward the beam so it becomes a lens, not a spike.
    const thin = saturate(span / 0.85);
    sill = lerp(wide * 0.985, Math.min(sill, wide), thin);
    roof = lerp(wide * 0.975, Math.min(roof, wide * 0.995), thin);
    mid = clamp(mid, y0 + span * 0.16, y1 - span * 0.16);
    return {
      y0, y1, mid, wide, sill, roof,
      rTop: sampleKeys(keys, z, 'rTop'),
      rMid: sampleKeys(keys, z, 'rMid'),
      rSill: sampleKeys(keys, z, 'rSill'),
    };
  };

  const ringAt = (z) => {
    const s = section(z);
    const poly = [
      [s.sill, s.y0], [s.wide, s.mid], [s.roof, s.y1],
      [-s.roof, s.y1], [-s.wide, s.mid], [-s.sill, s.y0],
    ];
    const radii = [s.rSill, s.rMid, s.rTop, s.rTop, s.rMid, s.rSill];
    return roundPolygon(poly, radii, CORNER_STEPS, EDGE_STEPS);
  };

  /* --- where to put the stations --------------------------------------- */
  const zs = new Set();
  const base = cfg.stations ?? 22;
  for (let i = 0; i <= base; i++) zs.add(zA + (zB - zA) * (i / base));
  for (const k of keys) if (k.z > zA && k.z < zB) zs.add(k.z);
  // The arch wall is nearly vertical; without dense sampling right at its lip
  // the loft turns it into a ramp and the wheel looks half swallowed.
  for (const a of arches) {
    for (const f of [0.9995, 0.998, 0.992, 0.978, 0.95, 0.90, 0.82, 0.70, 0.55, 0.36, 0.16, 0]) {
      for (const s of [-1, 1]) {
        const z = a.z + s * a.r * f;
        if (z > zA && z < zB) zs.add(z);
      }
    }
  }
  const stations = Array.from(zs).sort((x, y) => x - y);

  const slices = stations.map((z) => ({ z, ring: ringAt(z) }));

  /* --- rounded end caps ------------------------------------------------- */
  // Three steps over a 0.3-0.4 u radius is a chamfer, not a roll: the tail of a
  // 9.5 u car came out as a flat n-gon with three faceted rings around it and a
  // razor crease at every ring boundary — which is exactly what the macro
  // camera looks straight at from behind. Eight steps costs ten extra rings of
  // 49 vertices per body (about 960 triangles, once, at build time) and turns
  // the crease into a continuous bullnose that carries a highlight around it.
  const capSteps = 8;
  const head = [];
  for (let k = capSteps; k >= 1; k--) {
    const a = (k / capSteps) * (Math.PI * 0.5);
    head.push({ z: zA - capT * Math.sin(a), ring: insetRing(slices[0].ring, capT * (1 - Math.cos(a))) });
  }
  const tail = [];
  for (let k = 1; k <= capSteps; k++) {
    const a = (k / capSteps) * (Math.PI * 0.5);
    tail.push({ z: zB + capN * Math.sin(a), ring: insetRing(slices[slices.length - 1].ring, capN * (1 - Math.cos(a))) });
  }
  const all = head.concat(slices, tail);

  // The V parameterisation is taken once from the widest section, so a stripe
  // stays at a constant height instead of wandering with the local girth.
  //
  // "Widest" has to mean widest *full-height* section. The widest raw `wide`
  // key on most of these bodies sits directly over an axle, and directly over
  // an axle the arch has lifted the floor line to within 0.1 u of the roof, so
  // the reference ring is a 4.3 x 0.1 lens. Measured on the muscle car, that
  // gave a V table where the entire right flank occupied 1.6% of the ring —
  // eight texels of a 512-tall atlas for the stripes, the number roundel, the
  // sponsor text and the whole window surround, stretched over a third of the
  // car. Requiring 70% of the tallest span picks a real cross-section and the
  // flank comes back to ~23%, which is roughly its share of the perimeter.
  // Maximising the flank's own share of the ring perimeter is exactly the
  // quantity the choice is for, and it excludes the collapsed sections by
  // construction — a lens has almost no flank.
  let ref = slices[0];
  let bestFlank = -1;
  for (const s of slices) {
    const flank = arcTable(s.ring)[RING_PER * 2];
    if (flank > bestFlank) { bestFlank = flank; ref = s; }
  }
  const vTable = arcTable(ref.ring);
  const bands = [];
  for (let k = 0; k < 6; k++) bands.push(vTable[k * RING_PER]);
  bands.push(1);

  const zMin = all[0].z;
  const zMax = all[all.length - 1].z;
  const geometry = loftShell(all, { vTable, zMin, zMax, capFront: true, capBack: true });

  return { slices: all, body: slices, vTable, bands, section, ringAt, zMin, zMax, geometry, floorAt };
}

/**
 * Glazing: a band of the body surface pushed proud, feathered to nothing at
 * its ends so it melts into the paint instead of showing a lip.
 *
 * `cfg.low` is the ring index the band starts at, measured up from the
 * maximum-beam corner. Every model's was authored at 4-5, which puts the
 * pane's lower edge on the car's shoulder — invisible while the pane was
 * failing the depth test, and a hard glossy seam halfway down the flank the
 * moment it started drawing. 6-7 lands it on the belt line, where the livery
 * paints its window surround and the edge disappears into the trim.
 */
function buildGlazing(shell, cfg) {
  const z0 = cfg.z[0];
  const z1 = cfg.z[1];
  const lift = cfg.lift ?? 0.055;
  const gi = cfg.low ?? CORNER_STEPS;
  const j0 = RING_PER + gi;
  const j1 = 2 * RING_TOP - j0;

  const src = shell.body.filter((s) => s.z >= z0 - 0.4 && s.z <= z1 + 0.4);
  if (src.length < 3) return null;
  const zs = [];
  const n = Math.max(8, cfg.steps ?? 12);
  for (let i = 0; i <= n; i++) zs.push(lerp(z0, z1, i / n));

  const slices = zs.map((z) => {
    const ring = shell.ringAt(z);
    // The feather used to run over 14% of the cabin at each end. Now that the
    // lift is actually applied (see insetRing), that is a third of the pane
    // sitting too close to the paint to be trusted with an aperture behind it,
    // and the windscreen on most of these bodies runs right to the front edge
    // of the band. 4.5% still hides the lip and leaves the openings room.
    const t = saturate(Math.min(z - z0, z1 - z) / Math.max(0.05, (z1 - z0) * GLASS_FEATHER));
    const d = -lift * smoothstep(0, 1, t);
    return { z, ring: insetRing(ring, d) };
  });
  return loftStrip(slices, j0, j1, { vTable: shell.vTable, zMin: shell.zMin, zMax: shell.zMax });
}

// Fraction of the cabin length over which the glazing ramps up to full lift,
// and the extra margin an alpha aperture keeps clear of that ramp.
const GLASS_FEATHER = 0.045;
const GLASS_APERTURE_PAD = 0.075;

/** Base plate: the die-cast tell. A flat metal pan set a hair inside the sill
 *  so the gap between it and the body reads as a real parting line. */
function buildBasePlate(shell, cfg) {
  const z0 = cfg.z0;
  const z1 = cfg.z1;
  const inset = cfg.inset ?? 0.10;
  const drop = cfg.drop ?? 0.02;
  const n = 16;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const z = lerp(z0, z1, i / n);
    const s = shell.section(z);
    pts.push([z, Math.max(0.05, s.sill - inset), s.y0 - drop]);
  }
  const verts = [];
  const uvs = [];
  for (const [z, w, y] of pts) {
    verts.push(-w, y, z, w, y, z);
    uvs.push(0, (z - z0) / Math.max(0.01, z1 - z0), 1, (z - z0) / Math.max(0.01, z1 - z0));
  }
  const idx = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Faces down.
  const nrm = g.attributes.normal;
  for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, -1, 0);
  return g;
}

/** Wheel-arch lip: a swept bead following the arch opening. */
function buildArchLip(arch, x, o = {}) {
  const from = o.from ?? -14 * DEG;
  const to = o.to ?? (180 + 14) * DEG;
  const steps = o.steps ?? 16;
  const r = arch.r + (o.out ?? 0.02);
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const a = lerp(from, to, i / steps);
    path.push([x, arch.hub + Math.sin(a) * r, arch.z + Math.cos(a) * r]);
  }
  const prof = rectProfile(o.thick ?? 0.16, o.tall ?? 0.13, 0.07, 2);
  return sweep(path, prof, { up: [1, 0, 0] });
}

/* ==========================================================================
 * 5. Shared part factories
 * ========================================================================== */

/** A chrome bar bumper that hugs the nose or tail contour. */
function makeBumper(shell, z, o = {}) {
  const half = o.half ?? 1.0;
  const y = o.y;
  const sweepZ = o.depth ?? 0.55;
  const steps = 13;
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = lerp(-1, 1, t);
    const s = shell.section(z);
    const x = a * s.wide * half;
    const dz = -Math.pow(Math.abs(a), 2.0) * sweepZ * (o.dir ?? 1);
    path.push([x, y + (o.rise ?? 0) * (1 - Math.abs(a)), z + dz]);
  }
  const prof = rectProfile(o.thick ?? 0.20, o.tall ?? 0.30, 0.12, 3);
  return sweep(path, prof, { up: [0, 1, 0] });
}

/** Round headlamp: chrome bucket, glass lens, and a reflector behind it. */
function makeRoundLamp(r, depth) {
  const bucket = revolveX([
    [r * 0.20, -depth],
    [r * 0.96, -depth * 0.15],
    [r * 1.00, 0],
    [r * 0.92, depth * 0.10],
  ], 18);
  const lens = revolveX([
    [0.001, depth * 0.24],
    [r * 0.55, depth * 0.20],
    [r * 0.86, depth * 0.06],
    [r * 0.92, -depth * 0.02],
  ], 18);
  return { bucket, lens };
}

/** Flush lamp lens: an extruded rounded rectangle with a bevelled face. */
function makeBarLamp(w, h, d, r = 0.10) {
  return extrudePlate(roundRectShape(w, h, r), d, Math.min(0.05, d * 0.4), 10);
}

/**
 * A plated bezel ring for a lens — the thing that gives rear hardware a read
 * that does not depend on catching a highlight.
 *
 * A lens on its own is one value: the emissive tint, which at the 0.2-0.3
 * intensity a parked car runs is barely above the paint it is set into, so the
 * whole tail collapses into one slab. A ring of plated metal around it is a
 * different *substance* — it returns the environment instead of a diffuse
 * albedo — so the lamp keeps an outline whether or not the sun is on that face.
 *
 * Two details that are not cosmetic:
 *   - The hole is drawn `lap` smaller than the lens so the two solids OVERLAP.
 *     Sizing the hole to the lens exactly would leave the ring's inner wall and
 *     the lens's outer wall coplanar over their whole rim, which z-fights at
 *     precisely the grazing angle the macro camera holds.
 *   - The depth is chosen so the ring's front face lands level with the tip of
 *     the lens's own bevel, which puts the flat of the ring about 0.03 u proud
 *     of the flat of the lens. A bezel standing proud of its glass is the read;
 *     a bezel flush with it is a painted outline.
 *
 * @param {number} w      the lens width this ring wraps
 * @param {number} h      the lens height
 * @param {number} d      the lens depth (before its bevel)
 * @param {number} r      the lens corner radius
 * @param {number} width  visible band of chrome, per side
 */
function makeLampBezel(w, h, d, r = 0.08, width = 0.06) {
  const bev = 0.02;
  const lap = 0.028;
  const iw = Math.max(0.06, w - lap * 2);
  const ih = Math.max(0.06, h - lap * 2);
  const ir = Math.max(0.012, Math.min(r, Math.min(iw, ih) * 0.45));
  const shape = roundRectShape(iw + width * 2, ih + width * 2, ir + width);
  shape.holes.push(roundRectShape(iw, ih, ir));
  const depth = Math.max(0.05, d + 2 * (Math.min(0.05, d * 0.4) - bev));
  // Six segments per corner curve, not the usual ten: this is a ring, so the
  // count is paid twice over, and a 0.12 u corner arc at six is already inside
  // a pixel at the game camera and two at the macro one.
  return extrudePlate(shape, depth, bev, 6);
}

/**
 * Rear valance: a recessed matt-black panel with vertical strakes across it.
 *
 * The band of bodywork under the plate is the largest single area of the tail
 * and on two of the three roster cars it was bare paint — which is precisely
 * the "blank painted slab" read, because paint is the one substance on a car
 * that has no edges of its own. A valance fixes it with two substances at once:
 * an unlit black panel that reads as a hole in the bodywork, and strakes across
 * it in plated metal that return the environment. Neither depends on the sun
 * being on that face — the panel is dark whatever happens to it, and the
 * strakes are bright whatever happens to them, so the contrast between them
 * survives being in full shadow.
 *
 * Returns the two roles separately because they are different materials; the
 * caller places both with the same matrix.
 *
 * @param {object} o { w, h, d, r, strakes, finW, finD, margin }
 */
const VALANCE_BEV = 0.03;

function makeValance(o) {
  const w = o.w;
  const h = o.h;
  const d = o.d ?? 0.16;
  const panel = extrudePlate(roundRectShape(w, h, o.r ?? Math.min(0.08, h * 0.3)), d, VALANCE_BEV, 8);
  const n = Math.max(2, Math.round(o.strakes ?? 5));
  const finW = o.finW ?? 0.085;
  const finD = o.finD ?? 0.11;
  const margin = o.margin ?? 0.16;
  const fin = bevelBox(finW, h * 0.84, finD, finW * 0.34, 2);
  const fins = [];
  const span = w * (1 - margin * 2);
  for (let i = 0; i < n; i++) {
    const x = -span * 0.5 + span * (i / (n - 1));
    // The strakes stand proud of the panel's own back face (-Z is outward on
    // the tail), not of its front: an inset strake is a shadow line, and a
    // shadow line is exactly the read that vanishes when the panel is already
    // in shadow.
    fins.push({ geometry: fin, matrix: xform(x, 0, -(d * 0.5 + VALANCE_BEV) - finD * 0.28) });
  }
  return { panel, fins: mergeGeoms(fins) };
}

/** Exhaust: a swept pipe with a flared, polished tip. */
function makeExhaust(path, r, o = {}) {
  const prof = circleProfile(r, o.segments ?? 10);
  return sweep(path, prof, {
    up: [0, 1, 0],
    scale: (t) => [1 + (o.flare ?? 0.25) * smoothstep(0.80, 1, t), 1 + (o.flare ?? 0.25) * smoothstep(0.80, 1, t)],
  });
}

/**
 * The dark bore of a pipe: a funnel set into the outlet.
 *
 * `sweep` caps both ends of every path it runs, so an exhaust is a closed
 * chrome rod — and four closed chrome rods under a tail are what the modelling
 * critic read as legs. What separates a pipe from a rod is one thing: a black
 * hole with a lit rim around it. This builds that hole as a cone whose mouth
 * sits a hair proud of the chrome cap (never coplanar with it, so the two can
 * never z-fight) and whose apex is well inside the pipe, wound so the surface
 * you see is the inside of the funnel.
 *
 * @param {number[][]} path  the same path the pipe was swept along
 * @param {number} r         the same radius
 * @param {object} o         { flare, bore, boreDepth, segments } — flare must
 *                           match the pipe's or the bore will not fit the tip
 */
function pipeBore(path, r, o = {}) {
  const n = path.length;
  if (n < 2) return null;
  const tip = path[n - 1];
  const prev = path[n - 2];
  let tx = tip[0] - prev[0];
  let ty = tip[1] - prev[1];
  let tz = tip[2] - prev[2];
  const tl = Math.hypot(tx, ty, tz);
  if (!(tl > 1e-6)) return null;
  tx /= tl; ty /= tl; tz /= tl;

  // Any two axes across the tangent. The reference only has to be non-parallel.
  let ax = 0; let ay = 1; let az = 0;
  if (Math.abs(ty) > 0.9) { ax = 1; ay = 0; az = 0; }
  let ux = ay * tz - az * ty;
  let uy = az * tx - ax * tz;
  let uz = ax * ty - ay * tx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ty * uz - tz * uy;
  const vy = tz * ux - tx * uz;
  const vz = tx * uy - ty * ux;

  const rTip = r * (1 + (o.flare ?? 0.25));
  const rm = rTip * (o.bore ?? 0.76);
  const depth = rTip * (o.boreDepth ?? 2.0);
  const seg = Math.max(6, o.segments ?? 10);
  const lip = 0.006;

  const pos = [];
  const uvs = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    pos.push(
      tip[0] + tx * lip + (ux * cs + vx * sn) * rm,
      tip[1] + ty * lip + (uy * cs + vy * sn) * rm,
      tip[2] + tz * lip + (uz * cs + vz * sn) * rm,
    );
    uvs.push(i / seg, 1);
  }
  pos.push(tip[0] - tx * depth, tip[1] - ty * depth, tip[2] - tz * depth);
  uvs.push(0.5, 0);

  const apex = seg;
  const idx = [];
  for (let i = 0; i < seg; i++) idx.push(apex, i, (i + 1) % seg);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A wing: an aerofoil plate on two end plates and two pylons. */
function makeWing(o) {
  const span = o.span;
  const chord = o.chord;
  const thick = o.thick ?? 0.13;
  const y = o.y;
  const z = o.z;
  const parts = [];
  // Aerofoil section: flat under, cambered over, rounded leading edge.
  //
  // The sweep frame for a spanwise path puts profile.x on world Y and profile.y
  // on world Z, so the section is authored as (thickness, chord) — and the
  // angle of attack is baked into the section rather than applied with
  // geometry.rotateX(), which would swing the whole wing about the car's origin
  // instead of about its own leading edge.
  const sec = [];
  const n = 12;
  const ca = Math.cos(o.aoa ?? -6 * DEG);
  const sa = Math.sin(o.aoa ?? -6 * DEG);
  const put = (thickY, chordZ) => sec.push([thickY * ca - chordZ * sa, thickY * sa + chordZ * ca]);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    put(Math.sin(Math.PI * t) * thick * 0.72, lerp(chord * 0.5, -chord * 0.5, t));
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    put(-Math.sin(Math.PI * t) * thick * 0.30, lerp(chord * 0.5, -chord * 0.5, t));
  }
  const path = [[-span * 0.5, y, z], [0, y + (o.arch ?? 0), z], [span * 0.5, y, z]];
  parts.push({ geometry: sweep(path, sec, { up: [0, 0, 1] }) });
  if (o.endPlates !== false) {
    const plate = extrudePlate(roundRectShape(chord * 1.24, o.plateH ?? chord * 0.62, 0.10), 0.10, 0.04, 8);
    for (const s of [-1, 1]) {
      parts.push({ geometry: plate, matrix: xform(s * span * 0.5, y + (o.plateY ?? 0.05), z, 0, Math.PI / 2, 0) });
    }
  }
  for (const s of (o.pylons || [])) {
    const py = sweep([[s, y - (o.pylonH ?? 0.7), z + (o.pylonZ ?? 0.1)], [s, y, z]],
      rectProfile(0.10, 0.22, 0.05, 2), { up: [0, 0, 1] });
    parts.push({ geometry: py });
  }
  return mergeGeoms(parts);
}

/** Tube frame segment set — roll cages, buggy hoops, monster-truck links. */
function makeTubes(segments, r, o = {}) {
  const parts = [];
  const prof = circleProfile(r, o.segments ?? 8);
  for (const seg of segments) {
    if (seg.length < 2) continue;
    parts.push({ geometry: sweep(seg, prof, { up: o.up || [0, 1, 0] }) });
  }
  return mergeGeoms(parts);
}

/** Driver: helmet, visor, shoulders. Only ever seen in an open cockpit, and
 *  its absence there is instantly obvious. */
function makeDriver(o = {}) {
  const s = o.scale ?? 1;
  const helmet = new THREE.SphereGeometry(0.52 * s, 16, 12);
  helmet.scale(1, 0.94, 1.06);
  const visor = new THREE.SphereGeometry(0.525 * s, 14, 8, -0.9, 1.8, 0.85, 0.72);
  visor.scale(1, 0.94, 1.06);
  const shoulders = bevelBox(1.55 * s, 0.62 * s, 0.85 * s, 0.24 * s, 3);
  return {
    helmet: mergeGeoms([{ geometry: helmet, matrix: xform(0, o.y ?? 0, o.z ?? 0) }]),
    visor: mergeGeoms([{ geometry: visor, matrix: xform(0, (o.y ?? 0) + 0.02, (o.z ?? 0) + 0.02) }]),
    shoulders: mergeGeoms([{ geometry: shoulders, matrix: xform(0, (o.y ?? 0) - 0.66 * s, (o.z ?? 0) - 0.18 * s) }]),
  };
}

/**
 * Interior tub: the shell inside the glass that gives the cabin depth.
 *
 * With the window openings cut out of the paint this is no longer decoration —
 * it is the surface you look at through the glazing, so it needs enough recess
 * to read as a cabin rather than as a dent. The authored insets (0.18-0.30)
 * are a couple of millimetres on a 9 cm car and vanish under the pane; 1.75x
 * of that puts a visible step behind the aperture without letting a narrow
 * greenhouse turn itself inside out.
 */
function makeInterior(shell, z0, z1, o = {}) {
  const parts = [];
  const n = 10;
  const slices = [];
  const inset = Math.min((o.inset ?? 0.30) * 1.75, 0.62);
  for (let i = 0; i <= n; i++) {
    const z = lerp(z0, z1, i / n);
    slices.push({ z, ring: insetRing(shell.ringAt(z), inset) });
  }
  parts.push({ geometry: loftStrip(slices, RING_PER + CORNER_STEPS, 2 * RING_TOP - RING_PER - CORNER_STEPS, { vTable: shell.vTable, zMin: shell.zMin, zMax: shell.zMax }) });
  if (o.seats !== false) {
    const seat = bevelBox(0.86, 0.92, 0.30, 0.14, 3);
    const cushion = bevelBox(0.86, 0.22, 0.78, 0.10, 2);
    for (const s of (o.seatX ?? [-0.72, 0.72])) {
      parts.push({ geometry: seat, matrix: xform(s, (o.seatY ?? 0.9) + 0.34, (o.seatZ ?? 0) - 0.42) });
      parts.push({ geometry: cushion, matrix: xform(s, o.seatY ?? 0.9, o.seatZ ?? 0) });
    }
    // Something to see through the windscreen other than an empty tub. A
    // die-cast has exactly this much interior: a scuttle and a wheel boss.
    const zd = lerp(z0, z1, 0.84);
    const sw = shell.section(zd).wide;
    parts.push({ geometry: bevelBox(sw * 1.44, 0.30, 0.46, 0.10, 2), matrix: xform(0, (o.seatY ?? 0.9) + 0.46, zd) });
    parts.push({
      geometry: bevelBox(0.62, 0.10, 0.60, 0.05, 2),
      matrix: xform((o.seatX ?? [-0.72, 0.72])[1] * 0.62, (o.seatY ?? 0.9) + 0.56, lerp(z0, z1, 0.66), -0.5),
    });
  }
  return mergeGeoms(parts);
}

/* ==========================================================================
 * 6. Part collection
 * ========================================================================== */

/** Mirror a geometry across X, reversing winding so it still faces outward. */
function mirrorGeom(g) {
  const out = g.clone();
  const p = out.attributes.position;
  const n = out.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    p.setX(i, -p.getX(i));
    if (n) n.setX(i, -n.getX(i));
  }
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  const idx = out.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    idx.needsUpdate = true;
  }
  return out;
}

/**
 * @param {number[]} [flatUV] the atlas texel every painted part that is *not*
 *        the lofted shell should collapse onto. Only the shell has UVs in the
 *        livery's coordinate system; every other painted part — arch lips,
 *        bonnet bulges, boot lips — is a sweep or a bevel box carrying its own
 *        0..1 unwrap, so it maps the whole canvas onto itself and comes out
 *        wearing a smeared copy of the livery. One solid texel is both the
 *        correct read (they are body-coloured trim) and what makes it safe for
 *        the livery to punch its window openings out of the alpha channel: the
 *        openings can only ever cut the shell.
 */
function makeCollector(flatUV) {
  const byRole = new Map();
  let shellGeom = null;
  const uvcFor = (role, geometry) => (
    flatUV && role === 'paint' && geometry !== shellGeom ? flatUV : null
  );
  return {
    /** The lofted body: the one painted part whose UVs address the atlas. */
    addShell(geometry) {
      shellGeom = geometry;
      this.add('paint', geometry);
    },
    add(role, geometry, matrix) {
      if (!geometry) return;
      let a = byRole.get(role);
      if (!a) { a = []; byRole.set(role, a); }
      a.push({ geometry, matrix: matrix || null, uvConst: uvcFor(role, geometry) });
    },
    /** Add a part and its mirror image on the other side of the car. */
    pair(role, geometry, matrix) {
      // `add` already tolerates a null part; `mirrorGeom` below does not, and a
      // factory that declines to build something (pipeBore on a degenerate
      // path) would otherwise take the whole car's extras down with it — they
      // are built inside one try/catch, so one throw costs every part after it.
      if (!geometry) return;
      this.add(role, geometry, matrix);
      const m = matrix ? matrix.clone() : new THREE.Matrix4();
      const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
      const g2 = mirrorGeom(geometry);
      // The mirror of (M applied to g) is F*M*F applied to mirror(g).
      this.add(role, g2, flip.clone().multiply(m).multiply(flip));
    },
    finish() {
      const out = [];
      for (const [role, items] of byRole) {
        const g = mergeGeoms(items);
        g.computeBoundingSphere();
        out.push({ role, geometry: g });
      }
      return out;
    },
  };
}

/* ==========================================================================
 * 7. Generic dressing
 * ========================================================================== */

function dressChassis(env, d) {
  const { out, shell } = env;

  if (d.archLips !== false && env.arches.length) {
    for (const a of env.arches) {
      const s = shell.section(a.z);
      const x = (d.archLipX ?? 0.99) * s.wide;
      const lip = buildArchLip(a, x, d.archLip || {});
      out.pair(d.archLipRole || 'paint', lip);
    }
  }

  if (d.bumperFront) {
    const b = d.bumperFront;
    out.add(b.role || 'chrome', makeBumper(shell, b.z, { ...b, dir: 1 }));
  }
  if (d.bumperRear) {
    const b = d.bumperRear;
    out.add(b.role || 'chrome', makeBumper(shell, b.z, { ...b, dir: -1 }));
  }

  const lights = { head: [], brake: [], reverse: [] };

  // The nose is authored against the key stations exactly as the tail was, and
  // has the same problem for the same reason — the shell runs a cap radius past
  // its last station. Seated here rather than by hand so the numbers survive a
  // retune. A lamp raked into a wedge nose keeps its authored z: pitching it
  // means its face is no longer the plate's own +Z and none of this applies.
  for (const l of (d.headlamps || [])) {
    if (l.type === 'round') {
      const depth = l.depth ?? 0.34;
      const lz = roundLampZ(shell, l, depth, 1, 0.03);
      const { bucket, lens } = makeRoundLamp(l.r, depth);
      // revolveX leaves the lens on +X; -90 degrees about Y swings it to +Z.
      const m = xform(l.x, l.y, lz, 0, -Math.PI / 2, 0);
      out.pair('chrome', bucket, m);
      out.pair('lampClear', lens, m);
      lights.head.push({ x: l.x, y: l.y, z: lz });
      if (l.x !== 0) lights.head.push({ x: -l.x, y: l.y, z: lz });
      continue;
    }
    const depth = l.d ?? 0.22;
    const lz = (l.pitch || l.roll) ? l.z : lampZ(shell, l, depth, 1, 0.04);
    const g = makeBarLamp(l.w, l.h, depth, l.r ?? 0.09);
    out.pair('lampClear', g, xform(l.x, l.y, lz, l.pitch ?? 0, 0, l.roll ?? 0));
    if (l.surround !== false) {
      const s = makeLampBezel(l.w, l.h, depth, l.r ?? 0.09, l.bezel ?? 0.06);
      out.pair('chrome', s, xform(l.x, l.y, lz, l.pitch ?? 0, 0, l.roll ?? 0));
    }
    lights.head.push({ x: l.x, y: l.y, z: lz });
    if (l.x !== 0) lights.head.push({ x: -l.x, y: l.y, z: lz });
  }

  // The tail is what the macro camera points straight at, and every one of
  // these was authored against the body's last key station rather than against
  // the end cap that runs a third of a unit past it. lampZ pushes each plate
  // out to the real surface and refuses to pull any of them in, so a lamp that
  // was already proud is left exactly where it was.
  for (const l of (d.taillamps || [])) {
    const depth = l.d ?? 0.20;
    const lz = (l.pitch || l.roll) ? l.z : lampZ(shell, l, depth, -1, 0.05);
    const g = makeBarLamp(l.w, l.h, depth, l.r ?? 0.08);
    out.pair('lampRed', g, xform(l.x, l.y, lz, l.pitch ?? 0, 0, l.roll ?? 0));
    if (l.surround !== false) {
      // Was a black plastic slab *behind* the lens: it added an outline only
      // where the paint behind it happened to be lighter, which on a dark
      // livery is nowhere. A plated ring around the lens instead.
      const s = makeLampBezel(l.w, l.h, depth, l.r ?? 0.08, l.bezel ?? 0.06);
      out.pair('chrome', s, xform(l.x, l.y, lz, l.pitch ?? 0, 0, l.roll ?? 0));
    }
    lights.brake.push({ x: l.x, y: l.y, z: lz });
    if (l.x !== 0) lights.brake.push({ x: -l.x, y: l.y, z: lz });
  }

  for (const l of (d.reverselamps || [])) {
    const depth = l.d ?? 0.16;
    const lz = lampZ(shell, l, depth, -1, 0.04);
    const g = makeBarLamp(l.w, l.h, depth, l.r ?? 0.06);
    out.pair('lampAmber', g, xform(l.x, l.y, lz));
    if (l.surround !== false) {
      out.pair('chrome', makeLampBezel(l.w, l.h, depth, l.r ?? 0.06, l.bezel ?? 0.05),
        xform(l.x, l.y, lz));
    }
    lights.reverse.push({ x: l.x, y: l.y, z: lz });
    if (l.x !== 0) lights.reverse.push({ x: -l.x, y: l.y, z: lz });
  }

  if (d.grille) {
    const gr = d.grille;
    const shape = roundRectShape(gr.w, gr.h, gr.r ?? 0.14);
    out.add('grille', extrudePlate(shape, gr.d ?? 0.18, 0.05, 8), xform(gr.x ?? 0, gr.y, gr.z, gr.pitch ?? 0, 0, 0));
    // Slats: a grille that is a flat black rectangle is a placeholder.
    const bars = gr.bars ?? 6;
    const bar = bevelBox(gr.w * 0.94, gr.h / bars * 0.34, 0.16, 0.03, 2);
    for (let i = 0; i < bars; i++) {
      const y = gr.y - gr.h * 0.5 + gr.h * ((i + 0.5) / bars);
      out.add('chrome', bar, xform(gr.x ?? 0, y, (gr.z ?? 0) + (gr.d ?? 0.18) * 0.5, gr.pitch ?? 0, 0, 0));
    }
  }

  for (const m of (d.mirrors || [])) {
    // A door mirror head is about 16 x 10 x 7 cm. At this project's die-cast
    // scale — 9.5 u for a 4.8 m car, so 0.0198 u per real cm — that is
    // 0.32 x 0.20 x 0.14 u. The pod was 0.34 x 0.30 x 0.52 with a 0.13 fillet:
    // right in lateral extent, two to four times over in the other two axes,
    // and filleted hard enough on all three that it read as a sphere. On a
    // 4.15-wide car a pair of those are ping-pong balls, and they were the
    // brightest thing on the flank as well, because only the wedge and the
    // rally set `role` — everything else fell through to 'accent', which is
    // near-white on most liveries. The stalk already defaulted to 'trim'; the
    // pod now agrees with it.
    const pod = bevelBox(0.30, 0.21, 0.17, 0.07, 3);
    const stalk = sweep([[m.x * 0.72, m.y - 0.22, m.z - 0.10], [m.x, m.y, m.z]],
      circleProfile(0.055, 6), { up: [0, 1, 0] });
    out.pair(m.role || 'trim', stalk);
    out.pair(m.role || 'trim', pod, xform(m.x, m.y, m.z));
    // The reflective face belongs on the rearward side of the head, not the
    // outboard one: +Z is the nose, so the face sits a hair proud at -Z. It is
    // chrome rather than glazing: the glass material is a dark tint at 0.30
    // opacity with depthWrite off, which on a 0.24 u plate laid over a now-dark
    // trim pod returns a dark rectangle on a dark blob. A mirror is the one
    // place on a car where a hard specular glint is the correct read, and it is
    // what tells you the pod is a mirror and not a lump.
    out.pair('chrome', bevelBox(0.24, 0.15, 0.05, 0.02, 2), xform(m.x + 0.01, m.y, m.z - 0.08));
  }

  for (const e of (d.exhausts || [])) {
    const er = e.r ?? 0.16;
    out.pair('chrome', makeExhaust(e.path, er, e));
    // A capped chrome cylinder is a rod. Below about 0.12 u the bore is under
    // a pixel at any distance the game shows the car at, and all it would buy
    // is a dark speck on the tip.
    if (er >= 0.12) {
      const bore = pipeBore(e.path, er, e);
      if (bore) out.pair('grille', bore);
    }
  }

  // Rear valance. Seated against the shell exactly as the plate is, and for the
  // same reason: it is authored by height and width alone, so a hand-guessed z
  // is what would float it or bury it.
  for (const v of (d.valance ? (Array.isArray(d.valance) ? d.valance : [d.valance]) : [])) {
    const vw = v.w ?? 2.4;
    const vh = v.h ?? 0.48;
    const vd = v.d ?? 0.16;
    let reach = null;
    const hw = vw * 0.5 * 0.86;
    const hh = vh * 0.5 * 0.86;
    for (const px of [(v.x ?? 0) - hw, v.x ?? 0, (v.x ?? 0) + hw]) {
      for (const py of [v.y - hh, v.y, v.y + hh]) {
        const z = endSurfaceZ(shell, px, py, -1);
        if (z === null) continue;
        reach = reach === null ? z : Math.min(reach, z);
      }
    }
    // The panel's outward face is its -Z cap, and standing it a hair proud is
    // the only option available: a genuinely recessed valance needs a hole in
    // the paint, and the shell is one closed loft with no opening down there.
    // If the sample march found no body at all (the band is below the floor
    // line) fall back to just behind the tailmost point of the whole shell.
    // VALANCE_BEV is makeValance's own bevel, and it is part of the reach: the
    // extruder grows the solid by the bevel at both caps, so the face is half a
    // depth *plus* a bevel out from the centre.
    const vhalf = vd * 0.5 + VALANCE_BEV;
    const vz = v.z !== undefined ? v.z
      : (reach === null ? shell.zMin - 0.02 + vhalf
        : reach - (v.proud ?? 0.03) + vhalf);
    const parts = makeValance({ ...v, w: vw, h: vh, d: vd });
    const m = xform(v.x ?? 0, v.y, vz);
    if (v.x) {
      out.pair(v.role || 'grille', parts.panel, m);
      out.pair(v.finRole || 'chrome', parts.fins, m);
    } else {
      out.add(v.role || 'grille', parts.panel, m);
      out.add(v.finRole || 'chrome', parts.fins, m);
    }
  }

  // The number plate. Not `d.plate` — that one is the die-cast base pan under
  // the car, which unfortunately got the name first.
  //
  // This is three substances in one assembly, which is the whole point: a
  // plated surround, a pressed blank in its own near-white material, and the
  // shadow line between them. A tail whose only materials are paint and black
  // plastic reads as a painted slab no matter how much geometry is on it.
  if (d.rearPlate) {
    const p = d.rearPlate;
    const w = p.w ?? 1.08;
    const h = p.h ?? 0.24;
    const blank = p.d ?? 0.05;
    const bev = 0.012;
    // Seated by the same march lampZ uses, but without its never-pull-in rule:
    // this part is authored by height alone, so it has no hand-tuned z to
    // defend, and clamping it to an authored guess is what would float it.
    let reach = null;
    const hw = w * 0.5 * 0.92;
    const hh = h * 0.5 * 0.92;
    for (const px of [0, hw]) {
      for (const py of [p.y - hh, p.y, p.y + hh]) {
        const z = endSurfaceZ(shell, px, py, -1);
        if (z === null) continue;
        reach = reach === null ? z : Math.min(reach, z);
      }
    }
    const lz = p.z !== undefined ? p.z
      : (reach === null ? shell.zMin - blank * 0.5 - bev
        : reach - (p.proud ?? 0.03) + blank * 0.5 + bev);
    // planarUV before placement: the blank is the one part of the car whose
    // texture has to land square on it, and the extruder hands out shape
    // coordinates as UVs.
    out.add('plate', planarUV(extrudePlate(roundRectShape(w, h, p.r ?? 0.03), blank, bev, 6), w, h, true),
      xform(0, p.y, lz));
    // A hair deeper than the blank so the frame stands proud of it and casts
    // the line that separates the two.
    out.add('chrome', makeLampBezel(w, h, blank + 0.03, p.r ?? 0.03, p.bezel ?? 0.055),
      xform(0, p.y, lz));
  }

  if (d.plate !== false) {
    const p = d.plate || {};
    out.add('base', buildBasePlate(shell, {
      z0: p.z0 ?? (env.shell.zMin + 0.5),
      z1: p.z1 ?? (env.shell.zMax - 0.5),
      inset: p.inset ?? 0.12,
      drop: p.drop ?? 0.03,
    }));
  }

  if (d.glass) {
    const g = buildGlazing(shell, d.glass);
    if (g) out.add('glass', g);
    // Hand the livery painter the exact extent of the pane. Every window
    // opening it punches has to sit strictly inside this, in V *and* in Z, or
    // the car ends up with a hole in it that nothing covers.
    const j0 = RING_PER + (d.glass.low ?? CORNER_STEPS);
    const pad = Math.max(0.10, (d.glass.z[1] - d.glass.z[0]) * GLASS_APERTURE_PAD);
    env.glass = {
      vLo: shell.vTable[j0],
      vHi: shell.vTable[2 * RING_TOP - j0],
      z0: d.glass.z[0] + pad,
      z1: d.glass.z[1] - pad,
    };
  }

  if (d.interior) {
    out.add('interior', makeInterior(shell, d.interior.z0, d.interior.z1, d.interior));
  }

  if (d.driver) {
    const dr = makeDriver(d.driver);
    out.add('accent', dr.helmet);
    out.add('glass', dr.visor);
    out.add('interior', dr.shoulders);
  }

  return lights;
}

/* ==========================================================================
 * 8. The eight cars
 * ========================================================================== */

const K = (z, top, wide, roof, mid, sill) => ({ z, top, wide, roof, mid, sill });

export const CAR_MODELS = {

  /* ---------------------------------------------------------- 60s muscle */
  muscle: {
    id: 'muscle',
    name: 'STAMPEDE 440',
    blurb: 'Big-block brawler. All torque, no manners.',
    drive: 'rwd',
    topSpeed: 99,
    gears: [3.35, 2.05, 1.48, 1.16, 0.96],
    reverseRatio: 3.5,
    length: 9.5, width: 4.15, height: 2.92,
    physics: {
      mass: 1.14, cgHeight: 1.24, cgBias: 0.55, wheelbase: 5.9,
      trackWidth: 3.55, wheelRadius: 1.16, suspRest: 1.30,
      enginePeakTorque: 13.4, redlineRpm: 7200, gripRear: 0.925,
      arbRear: 116, diffLock: 0.38, driftThrust: 28,
    },
    tires: { muLat: 0.585, muLong: 0.675 },
    stats: { speed: 0.72, accel: 0.86, grip: 0.58, handling: 0.52, toughness: 0.80 },
    body: {
      // capTail was raised to 0.48 here and then put back. Growing it does not
      // shrink the flat rear face: the cap insets the ring at zTail + capTail,
      // so a bigger radius also starts from a bigger section and the two very
      // nearly cancel — measured across 0.30 to 1.00 the muscle's flat face
      // only narrows from 1.37 u tall to 1.00, while the fold that insetRing
      // puts in the final ring at the corners (where the offset exceeds the
      // fillet radius) grows from 0.025 u to 0.166. All cost, almost no gain.
      // The tail was fixed by capSteps and by putting hardware on it instead.
      floorY: 0.42, capNose: 0.40, capTail: 0.34, rTop: 0.36, rMid: 0.34, rSill: 0.22,
      keys: [
        K(-4.75, 2.24, 1.58, 1.30, 1.24, 1.36),
        K(-4.25, 2.38, 1.90, 1.58, 1.28, 1.62),
        K(-3.55, 2.44, 2.05, 1.72, 1.44, 1.72),
        K(-3.24, 2.46, 2.16, 1.74, 1.56, 1.74),
        K(-2.62, 2.60, 2.02, 1.56, 1.36, 1.76),
        K(-1.90, 2.90, 1.96, 1.30, 1.30, 1.78),
        K(-0.40, 2.92, 1.94, 1.28, 1.28, 1.78),
        K(0.32, 2.86, 1.95, 1.32, 1.28, 1.78),
        K(0.98, 2.30, 1.98, 1.72, 1.30, 1.78),
        K(1.70, 2.24, 2.00, 1.82, 1.32, 1.76),
        K(2.66, 2.22, 2.16, 1.86, 1.56, 1.74),
        K(3.60, 2.16, 1.98, 1.80, 1.32, 1.70),
        K(4.32, 2.04, 1.82, 1.58, 1.20, 1.54),
        K(4.75, 1.92, 1.56, 1.32, 1.10, 1.32),
      ],
    },
    cabin: { glassZ: [-2.55, 0.98], screenZ: [0.30, 0.98], backlightZ: [-2.58, -1.88], beltFrac: 0.60 },
    glassLow: 4, glassLift: 0.06,
    numberZ: -0.95,
    shutZ: [-2.62, 0.62],
    hoodZ: [0.95, 3.85, -2.66, -4.20],
    wheel: { style: 'taper', spokes: 5, rimR: 0.63, halfW: 0.46, band: 0.14, hubR: 0.26, inset: 0.34, tread: 'road', bolts: 5 },
    build(env) {
      const { out, shell } = env;
      const lights = dressChassis(env, {
        archLip: { thick: 0.15, tall: 0.12 },
        bumperFront: { z: 4.42, y: 1.22, half: 0.99, depth: 0.62, thick: 0.22, tall: 0.34, rise: 0.05 },
        // The rear bumper was authored when the tail had no bodywork below the
        // boot line to be authored against — see the cap/arch note in
        // buildBodyShell. With the rear panel back, a bar at z -4.42 lies
        // entirely inside the paint; at -4.61 its face stands 0.08 proud of the
        // panel, and 1.02 drops it clear of the tail lamps above.
        bumperRear: { z: -4.61, y: 1.02, half: 0.99, depth: 0.52, thick: 0.22, tall: 0.34, rise: 0.05 },
        headlamps: [
          { type: 'round', x: 0.72, y: 1.70, z: 4.56, r: 0.34 },
          { type: 'round', x: 1.36, y: 1.70, z: 4.50, r: 0.34 },
        ],
        taillamps: [{ x: 1.02, y: 1.64, z: -4.58, w: 1.10, h: 0.40 }],
        reverselamps: [{ x: 0.30, y: 1.50, z: -4.56, w: 0.36, h: 0.24 }],
        grille: { y: 1.72, z: 4.52, w: 2.30, h: 0.62, bars: 5 },
        mirrors: [{ x: 1.86, y: 2.32, z: 0.62 }],
        // The tips used to stop at z -4.72, which was 0.03 u short of the rear
        // panel — so with the panel restored the outlets were inside the car.
        // 0.11 u proud puts the bore where it can be seen and the tips below
        // the bumper, which is where a quad-tip system exits.
        exhausts: [
          { path: [[1.02, 0.44, -3.4], [1.10, 0.42, -4.2], [1.14, 0.46, -4.86]], r: 0.155, flare: 0.30 },
          { path: [[1.42, 0.44, -3.4], [1.48, 0.42, -4.2], [1.50, 0.46, -4.86]], r: 0.155, flare: 0.30 },
        ],
        glass: { z: [-2.55, 0.98], lift: 0.06, low: 6, steps: 14 },
        interior: { z0: -2.5, z1: 0.9, inset: 0.30, seatY: 1.52, seatZ: -1.2, seatX: [-0.68, 0.68] },
        // Recessed into the rear bumper's own face, which is where a 60s coupe
        // carries it. The z is authored rather than seated because it hangs off
        // the bumper, not off the bodywork the seating march can see.
        rearPlate: { y: 1.07, z: -4.875, w: 1.10, h: 0.22 },
        // Between the quad tips, under the bumper blade. Narrow enough to clear
        // the inboard pipes at x 1.02.
        valance: { y: 0.60, w: 1.72, h: 0.34, d: 0.14, strakes: 5, finW: 0.075, finD: 0.10 },
        plate: { z0: -4.30, z1: 4.30, inset: 0.13 },
      });
      // Bonnet scoop and a raised power bulge — the whole point of the car.
      out.add('accent', bevelBox(1.42, 0.30, 1.55, 0.13, 3), xform(0, 2.30, 2.30, -3 * DEG, 0, 0));
      out.add('grille', bevelBox(1.05, 0.12, 0.55, 0.05, 2), xform(0, 2.44, 2.92));
      out.add('paint', bevelBox(2.55, 0.16, 2.90, 0.28, 3), xform(0, 2.20, 1.95));
      // Rocker side pipes. They have to stop at the arch openings: the wheel
      // arches are cut into the loft as a rising floor line, so between
      // z = 1.37 and 3.95 (and -1.96 to -4.54) there is no body at rocker
      // height at all, and the previous path ran from 1.70 to -2.55 — both
      // ends inside an arch, both ends inside the tyre. What you saw was a
      // chrome capsule apparently floating beside the sills with its tips
      // buried in the wheels.
      const sidePipe = [[1.78, 0.74, 1.30], [1.83, 0.70, -0.30], [1.80, 0.74, -1.92]];
      out.pair('chrome', makeExhaust(sidePipe, 0.19, { flare: 0.10 }));
      out.pair('grille', pipeBore(sidePipe, 0.19, { flare: 0.10 }));
      // Boot lip.
      out.add('paint', bevelBox(3.20, 0.16, 0.55, 0.10, 2), xform(0, 2.50, -4.02, 4 * DEG, 0, 0));
      // The rest of the rear panel furniture is declared above, in the
      // dressChassis block: lamps, the bumper blade, the plate standing off the
      // bumper's own face where a 60s coupe carries it, and the strake valance
      // under all of it for the quad tips to exit beside.
      return lights;
    },
  },

  /* ------------------------------------------------------- 80s wedge GT */
  wedge: {
    id: 'wedge',
    name: 'STILETTO S1',
    blurb: 'A folded sheet of paper doing 180. Mid-engined, unforgiving.',
    drive: 'rwd',
    topSpeed: 107,
    gears: [3.05, 2.08, 1.60, 1.28, 1.06, 0.90],
    reverseRatio: 3.2,
    length: 9.3, width: 4.35, height: 2.56,
    physics: {
      mass: 1.00, cgHeight: 1.06, cgBias: 0.44, wheelbase: 5.7,
      trackWidth: 3.85, wheelRadius: 1.02, suspRest: 1.05,
      enginePeakTorque: 11.6, redlineRpm: 8800, gripFront: 1.04, gripRear: 1.02,
      springRate: 210, damperBump: 11, damperRebound: 16, arbFront: 178, arbRear: 158,
      downforceCoef: 0.0140, inertiaYaw: 0.60,
    },
    tires: { muLat: 0.625, muLong: 0.665 },
    stats: { speed: 0.92, accel: 0.82, grip: 0.80, handling: 0.78, toughness: 0.40 },
    body: {
      floorY: 0.30, capNose: 0.34, capTail: 0.30, rTop: 0.24, rMid: 0.26, rSill: 0.18,
      keys: [
        K(-4.65, 2.06, 1.72, 1.52, 1.22, 1.52),
        K(-4.10, 2.18, 2.05, 1.86, 1.28, 1.78),
        K(-3.35, 2.24, 2.175, 1.94, 1.40, 1.90),
        K(-2.51, 2.30, 2.32, 1.92, 1.52, 1.92),
        K(-1.85, 2.42, 2.10, 1.60, 1.42, 1.90),
        K(-1.05, 2.56, 1.94, 1.22, 1.36, 1.84),
        K(-0.10, 2.54, 1.90, 1.18, 1.32, 1.82),
        K(0.75, 2.32, 1.92, 1.42, 1.28, 1.80),
        K(1.55, 1.96, 1.96, 1.66, 1.20, 1.78),
        K(2.40, 1.78, 2.00, 1.76, 1.16, 1.74),
        K(3.19, 1.70, 2.30, 1.82, 1.30, 1.70),
        K(3.95, 1.56, 1.94, 1.72, 1.06, 1.58),
        K(4.65, 1.30, 1.62, 1.42, 0.86, 1.30),
      ],
    },
    cabin: { glassZ: [-1.60, 1.05], screenZ: [-0.05, 1.05], backlightZ: [-1.65, -1.05], beltFrac: 0.66 },
    glassLow: 5, glassLift: 0.05,
    numberZ: -0.30,
    shutZ: [-1.72, 1.12],
    hoodZ: [1.20, 3.60, -1.80, -3.90],
    wheel: { style: 'round', spokes: 10, rimR: 0.66, halfW: 0.46, band: 0.10, hubR: 0.30, inset: 0.22, tread: 'road', bolts: 5 },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLip: { thick: 0.18, tall: 0.10 }, archLipX: 1.005,
        headlamps: [{ x: 1.02, y: 1.34, z: 4.32, w: 0.92, h: 0.26, d: 0.20, pitch: -22 * DEG }],
        taillamps: [{ x: 1.05, y: 1.86, z: -4.52, w: 1.36, h: 0.30 }],
        reverselamps: [{ x: 0.34, y: 1.58, z: -4.50, w: 0.34, h: 0.20 }],
        mirrors: [{ x: 1.98, y: 2.16, z: 0.55, role: 'trim' }],
        exhausts: [{ path: [[0.55, 0.62, -3.9], [0.58, 0.60, -4.45], [0.60, 0.62, -4.80]], r: 0.19, flare: 0.35 }],
        glass: { z: [-1.62, 1.06], lift: 0.05, low: 7, steps: 14 },
        interior: { z0: -1.55, z1: 1.0, inset: 0.26, seatY: 1.30, seatZ: -0.55, seatX: [-0.62, 0.62] },
        rearPlate: { y: 1.18, w: 1.06, h: 0.22 },
        // Twin engine-bay extracts flanking the plate, in the one band of the
        // tail that nothing else claims: above the plate's top edge at 1.29,
        // below the lamp bezels at 1.65, and outboard of the plate in x so the
        // two never meet. The outer edge stops at 1.65, inside the 1.73 the
        // tail lamps already prove the bodywork reaches.
        valance: { x: 1.15, y: 1.38, w: 1.00, h: 0.44, d: 0.14, strakes: 4, finW: 0.075, finD: 0.10 },
        plate: { z0: -4.20, z1: 4.15, inset: 0.14 },
      });
      // Full-width rear wing on two pylons — the silhouette everyone remembers.
      out.add('accent', makeWing({
        span: 3.90, chord: 0.95, thick: 0.16, y: 2.92, z: -4.05,
        pylons: [-1.35, 1.35], pylonH: 0.72, aoa: -9 * DEG, plateH: 0.72,
      }));
      // Side intake scoops feeding the mid engine.
      out.pair('grille', bevelBox(0.34, 0.52, 1.45, 0.12, 3), xform(1.92, 1.62, -1.95));
      out.pair('trim', bevelBox(0.16, 0.66, 1.75, 0.14, 3), xform(2.02, 1.66, -1.95));
      // NACA duct on the bonnet, front splitter, engine louvres over the deck.
      out.add('grille', bevelBox(0.72, 0.08, 1.10, 0.05, 2), xform(0, 1.76, 2.55));
      out.add('trim', bevelBox(3.50, 0.12, 0.72, 0.06, 2), xform(0, 0.66, 4.36, -6 * DEG, 0, 0));
      for (let i = 0; i < 5; i++) {
        out.add('trim', bevelBox(2.30, 0.07, 0.16, 0.03, 2), xform(0, 2.28 + i * 0.008, -2.55 - i * 0.30, -10 * DEG, 0, 0));
      }
      return lights;
    },
  },

  /* ------------------------------------------------------- rally hatch */
  rally: {
    id: 'rally',
    name: 'PIKE RS',
    blurb: 'Four driven wheels and no respect for the surface.',
    drive: 'awd',
    topSpeed: 96,
    gears: [3.20, 2.15, 1.60, 1.25, 1.00],
    reverseRatio: 3.3,
    length: 8.6, width: 4.20, height: 3.18,
    physics: {
      mass: 1.02, cgHeight: 1.36, cgBias: 0.56, wheelbase: 5.4,
      trackWidth: 3.70, wheelRadius: 1.14, suspRest: 1.78,
      enginePeakTorque: 10.8, redlineRpm: 8000, diffLock: 0.74,
      springRate: 136, damperBump: 8.2, damperRebound: 12.6, handbrakeGrip: 0.46,
      driftThrust: 27, assistYaw: 3.8,
    },
    tires: { muLat: 0.60, muLong: 0.665 },
    stats: { speed: 0.66, accel: 0.74, grip: 0.86, handling: 0.88, toughness: 0.74 },
    body: {
      floorY: 0.66, capNose: 0.36, capTail: 0.34, rTop: 0.30, rMid: 0.30, rSill: 0.22,
      keys: [
        K(-4.30, 2.72, 1.68, 1.46, 1.60, 1.44),
        K(-3.90, 2.96, 1.94, 1.66, 1.62, 1.66),
        K(-3.40, 3.06, 2.06, 1.72, 1.68, 1.76),
        K(-3.02, 3.10, 2.10, 1.72, 1.72, 1.78),
        K(-2.40, 3.16, 2.02, 1.64, 1.66, 1.78),
        K(-1.55, 3.18, 1.96, 1.52, 1.62, 1.78),
        K(-0.35, 3.18, 1.94, 1.48, 1.60, 1.78),
        K(0.55, 3.10, 1.94, 1.46, 1.58, 1.78),
        K(1.20, 2.48, 1.98, 1.72, 1.52, 1.78),
        K(1.85, 2.40, 2.02, 1.80, 1.50, 1.76),
        K(2.38, 2.36, 2.10, 1.84, 1.66, 1.74),
        K(3.10, 2.30, 2.02, 1.80, 1.48, 1.70),
        K(3.86, 2.16, 1.86, 1.62, 1.30, 1.54),
        K(4.30, 1.98, 1.60, 1.36, 1.16, 1.30),
      ],
    },
    cabin: { glassZ: [-2.95, 1.22], screenZ: [0.52, 1.22], backlightZ: [-3.00, -2.30], beltFrac: 0.55 },
    glassLow: 4, glassLift: 0.055,
    numberZ: -0.60,
    shutZ: [-2.30, -0.55, 1.30],
    hoodZ: [1.24, 3.40, -3.02],
    wheel: { style: 'taper', spokes: 8, rimR: 0.60, halfW: 0.44, band: 0.11, hubR: 0.26, inset: 0.26, tread: 'rally', bolts: 5, apertureIn: 0.20, apertureOut: 0.30 },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLip: { thick: 0.26, tall: 0.20 }, archLipX: 1.02,
        headlamps: [{ x: 1.10, y: 2.06, z: 4.16, w: 0.98, h: 0.42, d: 0.24, pitch: -8 * DEG }],
        taillamps: [{ x: 1.42, y: 2.32, z: -4.20, w: 0.60, h: 0.86 }],
        reverselamps: [{ x: 0.55, y: 1.56, z: -4.16, w: 0.42, h: 0.22 }],
        grille: { y: 1.64, z: 4.20, w: 2.20, h: 0.52, bars: 3, pitch: -6 * DEG },
        mirrors: [{ x: 2.06, y: 2.62, z: 0.95, role: 'accent' }],
        exhausts: [{ path: [[1.05, 0.86, -3.5], [1.14, 0.84, -4.2], [1.18, 0.90, -4.55]], r: 0.18, flare: 0.40 }],
        glass: { z: [-2.95, 1.24], lift: 0.055, low: 6, steps: 16 },
        interior: { z0: -2.85, z1: 1.15, inset: 0.28, seatY: 1.80, seatZ: -0.55, seatX: [-0.70, 0.70] },
        rearPlate: { y: 1.24, w: 1.02, h: 0.22 },
        // Lower valance, between the plate's bottom edge at 1.13 and the floor
        // line at 0.66, and narrow enough to stop inboard of the tips at 0.93.
        valance: { y: 0.88, w: 1.66, h: 0.38, d: 0.14, strakes: 5, finW: 0.08, finD: 0.10 },
        plate: { z0: -3.95, z1: 3.90, inset: 0.14 },
      });
      // Roof spoiler with a gurney, bonnet vents, a rally light pod, mud flaps.
      out.add('accent', makeWing({
        span: 2.90, chord: 0.72, thick: 0.11, y: 3.34, z: -3.62,
        pylons: [-1.05, 1.05], pylonH: 0.34, aoa: -12 * DEG, plateH: 0.44,
      }));
      out.pair('grille', bevelBox(0.62, 0.09, 0.72, 0.05, 2), xform(0.85, 2.42, 2.85, -5 * DEG, 0, 0));
      const podBar = bevelBox(2.60, 0.16, 0.20, 0.07, 2);
      out.add('trim', podBar, xform(0, 2.02, 4.34));
      for (const x of [-0.86, -0.30, 0.30, 0.86]) {
        const { bucket, lens } = makeRoundLamp(0.27, 0.26);
        const m = xform(x, 2.24, 4.40, 0, -Math.PI / 2, 0);
        out.add('trim', bucket, m);
        out.add('lampClear', lens, m);
        out.add('trim', bevelBox(0.09, 0.34, 0.09, 0.03, 2), xform(x, 2.08, 4.36));
      }
      out.pair('trim', bevelBox(0.10, 0.62, 0.72, 0.06, 2), xform(1.92, 0.62, -3.30, 8 * DEG, 0, 0));
      out.pair('trim', bevelBox(0.10, 0.62, 0.72, 0.06, 2), xform(1.92, 0.62, 1.75, 8 * DEG, 0, 0));
      // Sill protector bars.
      out.pair('trim', bevelBox(0.16, 0.20, 3.10, 0.07, 2), xform(1.86, 0.86, -0.70));
      return lights;
    },
  },

  /* ---------------------------------------------------- hot rod pickup */
  pickup: {
    id: 'pickup',
    name: 'ROADHOG R/T',
    blurb: 'Blown small-block in a farm truck. Nobody asked for it.',
    drive: 'awd',
    topSpeed: 93,
    gears: [3.60, 2.30, 1.62, 1.20, 0.98],
    reverseRatio: 3.7,
    length: 9.7, width: 4.30, height: 3.40,
    physics: {
      mass: 1.20, cgHeight: 1.54, cgBias: 0.56, wheelbase: 6.1,
      trackWidth: 3.80, wheelRadius: 1.28, suspRest: 1.72,
      enginePeakTorque: 13.0, redlineRpm: 6500, diffLock: 0.76,
      springRate: 152, damperBump: 9.6, damperRebound: 14.6,
      inertiaYaw: 0.90, inertiaRoll: 2.05, steerMaxLow: 31 * DEG,
    },
    tires: { muLat: 0.575, muLong: 0.655 },
    stats: { speed: 0.60, accel: 0.80, grip: 0.62, handling: 0.50, toughness: 0.94 },
    body: {
      floorY: 0.68, capNose: 0.34, capTail: 0.30, rTop: 0.26, rMid: 0.30, rSill: 0.22,
      keys: [
        K(-4.85, 2.74, 1.72, 1.58, 1.62, 1.52),
        K(-4.45, 2.86, 2.02, 1.86, 1.66, 1.76),
        K(-3.90, 2.90, 2.13, 1.96, 1.74, 1.86),
        K(-3.42, 2.92, 2.28, 1.98, 1.82, 1.88),
        K(-2.60, 2.92, 2.13, 1.96, 1.74, 1.88),
        K(-1.60, 2.94, 2.10, 1.94, 1.72, 1.86),
        K(-1.05, 3.34, 2.06, 1.70, 1.72, 1.84),
        K(-0.20, 3.40, 2.02, 1.60, 1.70, 1.82),
        K(0.62, 3.36, 2.02, 1.62, 1.70, 1.82),
        K(1.30, 2.72, 2.04, 1.82, 1.66, 1.80),
        K(2.10, 2.64, 2.08, 1.88, 1.64, 1.78),
        K(2.68, 2.60, 2.28, 1.92, 1.78, 1.76),
        K(3.60, 2.56, 2.06, 1.86, 1.60, 1.72),
        K(4.42, 2.42, 1.92, 1.70, 1.42, 1.56),
        K(4.85, 2.20, 1.64, 1.42, 1.24, 1.32),
      ],
    },
    cabin: { glassZ: [-1.05, 0.78], screenZ: [0.10, 0.78], backlightZ: [-1.10, -0.62], beltFrac: 0.50 },
    glassLow: 4, glassLift: 0.06,
    numberZ: -0.20,
    shutZ: [-1.12, 0.85],
    hoodZ: [0.92, 3.45, -1.30],
    wheel: { style: 'round', spokes: 6, rimR: 0.58, halfW: 0.46, band: 0.16, hubR: 0.32, inset: 0.30, tread: 'rally', bolts: 6 },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLip: { thick: 0.24, tall: 0.18 }, archLipX: 1.01,
        bumperFront: { z: 4.62, y: 1.42, half: 0.98, depth: 0.42, thick: 0.24, tall: 0.38 },
        bumperRear: { z: -4.78, y: 1.42, half: 0.96, depth: 0.30, thick: 0.24, tall: 0.34 },
        headlamps: [
          { type: 'round', x: 1.32, y: 2.22, z: 4.68, r: 0.38 },
        ],
        taillamps: [{ x: 1.62, y: 2.10, z: -4.86, w: 0.52, h: 0.72 }],
        reverselamps: [{ x: 0.70, y: 1.62, z: -4.84, w: 0.44, h: 0.22 }],
        grille: { y: 2.18, z: 4.66, w: 2.20, h: 0.92, bars: 7 },
        mirrors: [{ x: 2.16, y: 2.94, z: 0.72 }],
        glass: { z: [-1.05, 0.80], lift: 0.06, low: 6, steps: 10 },
        interior: { z0: -1.0, z1: 0.72, inset: 0.30, seatY: 2.02, seatZ: -0.35, seatX: [-0.74, 0.74] },
        plate: { z0: -4.40, z1: 4.40, inset: 0.16 },
      });
      // Open load bed with a ribbed floor and a tailgate.
      out.add('interior', bevelBox(3.55, 0.14, 3.20, 0.06, 2), xform(0, 2.86, -3.05));
      for (let i = 0; i < 6; i++) {
        out.add('interior', bevelBox(0.16, 0.10, 3.10, 0.04, 2), xform(-1.50 + i * 0.60, 2.94, -3.05));
      }
      out.add('paint', bevelBox(3.90, 0.66, 0.22, 0.09, 2), xform(0, 3.10, -4.66));
      out.pair('trim', bevelBox(0.12, 0.30, 3.20, 0.05, 2), xform(2.04, 3.14, -3.05));
      // Blown V8 through the bonnet: scoop, blower case, drive belt, headers.
      out.add('trim', bevelBox(1.75, 0.72, 1.90, 0.16, 3), xform(0, 3.62, 1.55));
      out.add('chrome', bevelBox(1.35, 0.42, 1.35, 0.15, 3), xform(0, 4.06, 1.55));
      out.add('chrome', revolveX([[0.001, -0.10], [0.44, -0.10], [0.50, 0.02], [0.44, 0.12], [0.001, 0.12]], 16),
        xform(0, 4.30, 1.55, 0, 0, Math.PI / 2));
      out.add('trim', bevelBox(0.22, 1.00, 0.24, 0.05, 2), xform(0.92, 3.70, 2.45));
      // Headers down the outside of the bonnet, then a collector along the
      // rocker. Both are routed around the wheels rather than through them:
      // the front tyre occupies z 1.4-3.97 out to x 2.36, and the rear starts
      // at z -2.01, so the headers stay inboard of x 1.42 until they are clear
      // in z and the collector stops short of the rear arch opening.
      for (let i = 0; i < 4; i++) {
        out.pair('chrome', makeExhaust([
          [1.20, 3.10 - i * 0.05, 2.30 - i * 0.42],
          [1.28, 2.46, 1.95 - i * 0.30],
          [2.00, 1.74, 1.10 - i * 0.24],
        ], 0.125, { flare: 0 }));
      }
      const collector = [[2.04, 1.62, 0.90], [2.06, 1.46, -0.70], [2.04, 1.44, -1.96]];
      out.pair('chrome', makeExhaust(collector, 0.20, { flare: 0.30 }));
      out.pair('grille', pipeBore(collector, 0.20, { flare: 0.30 }));
      return lights;
    },
  },

  /* --------------------------------------------------- Group C prototype */
  gt: {
    id: 'gt',
    name: 'NOCTURNE C9',
    blurb: 'Ground effect and a closed canopy. Built for the long night.',
    drive: 'rwd',
    topSpeed: 109,
    gears: [3.10, 2.12, 1.66, 1.34, 1.10, 0.94],
    reverseRatio: 3.2,
    length: 9.9, width: 4.45, height: 2.52,
    physics: {
      mass: 0.98, cgHeight: 1.00, cgBias: 0.45, wheelbase: 6.1,
      trackWidth: 3.95, wheelRadius: 1.06, suspRest: 1.00,
      enginePeakTorque: 11.5, redlineRpm: 9000, gripFront: 1.08, gripRear: 1.06,
      springRate: 240, damperBump: 12.5, damperRebound: 18, arbFront: 200, arbRear: 178,
      downforceCoef: 0.0195, aeroBalance: 0.46, diffLock: 0.66, inertiaYaw: 0.56,
    },
    tires: { muLat: 0.655, muLong: 0.695 },
    stats: { speed: 1.00, accel: 0.90, grip: 0.96, handling: 0.86, toughness: 0.34 },
    body: {
      floorY: 0.26, capNose: 0.30, capTail: 0.28, rTop: 0.22, rMid: 0.26, rSill: 0.16,
      keys: [
        K(-4.95, 1.72, 1.46, 1.30, 1.02, 1.30),
        K(-4.35, 1.92, 1.96, 1.76, 1.10, 1.72),
        K(-3.60, 2.06, 2.18, 1.96, 1.24, 1.90),
        K(-2.75, 2.16, 2.38, 1.98, 1.42, 1.95),
        K(-2.05, 2.30, 2.18, 1.82, 1.36, 1.94),
        K(-1.30, 2.48, 2.06, 1.36, 1.28, 1.90),
        K(-0.50, 2.52, 2.00, 1.18, 1.22, 1.86),
        K(0.35, 2.40, 1.98, 1.24, 1.16, 1.84),
        K(1.10, 2.02, 2.02, 1.62, 1.08, 1.82),
        K(2.00, 1.72, 2.08, 1.80, 1.02, 1.78),
        K(3.36, 1.60, 2.36, 1.94, 1.16, 1.74),
        K(4.20, 1.42, 2.02, 1.76, 0.94, 1.56),
        K(4.95, 1.10, 1.62, 1.40, 0.76, 1.24),
      ],
    },
    cabin: { glassZ: [-1.85, 1.15], screenZ: [-0.25, 1.15], backlightZ: [-1.90, -1.25], beltFrac: 0.70 },
    glassLow: 5, glassLift: 0.05,
    numberZ: -0.20,
    shutZ: [-2.05, 1.28],
    hoodZ: [1.30, 3.70, -2.15, -4.10],
    wheel: { style: 'round', spokes: 12, rimR: 0.68, halfW: 0.48, band: 0.09, hubR: 0.32, inset: 0.18, tread: 'slick', bolts: 1, boltR: 0.0 },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLip: { thick: 0.14, tall: 0.08 }, archLipX: 1.0,
        headlamps: [{ x: 1.12, y: 1.30, z: 4.55, w: 1.00, h: 0.24, d: 0.18, pitch: -18 * DEG }],
        taillamps: [{ x: 1.10, y: 1.62, z: -4.82, w: 1.30, h: 0.26 }],
        reverselamps: [{ x: 0.30, y: 1.36, z: -4.80, w: 0.30, h: 0.18 }],
        mirrors: [{ x: 2.02, y: 2.14, z: 0.60, role: 'trim' }],
        exhausts: [{ path: [[0.85, 0.86, -4.10], [0.88, 0.88, -4.70], [0.90, 0.90, -5.00]], r: 0.17, flare: 0.30 }],
        glass: { z: [-1.88, 1.16], lift: 0.05, low: 7, steps: 16 },
        interior: { z0: -1.80, z1: 1.10, inset: 0.24, seatY: 1.14, seatZ: -0.45, seatX: [-0.66, 0.66] },
        plate: { z0: -4.55, z1: 4.55, inset: 0.10, drop: 0.02 },
      });
      // Full-width biplane wing on twin pylons, splitter, dive planes, sidepod ducts.
      out.add('accent', makeWing({
        span: 4.05, chord: 1.05, thick: 0.15, y: 2.86, z: -4.42,
        pylons: [-1.55, 1.55], pylonH: 0.92, aoa: -11 * DEG, plateH: 0.86,
      }));
      out.add('trim', extrudePlate(roundRectShape(4.10, 1.40, 0.30), 0.10, 0.04, 10),
        xform(0, 0.42, 4.28, Math.PI / 2, 0, 0));
      out.pair('accent', extrudePlate(roundRectShape(0.90, 0.32, 0.10), 0.09, 0.03, 8),
        xform(1.86, 1.10, 3.85, 0, 0, -14 * DEG));
      out.pair('grille', bevelBox(0.30, 0.44, 1.55, 0.14, 3), xform(2.00, 1.42, -1.70));
      // Engine cover louvres and the roof intake that feeds it.
      out.add('trim', bevelBox(0.62, 0.34, 0.95, 0.14, 3), xform(0, 2.62, -1.10));
      for (let i = 0; i < 6; i++) {
        out.add('trim', bevelBox(1.85, 0.06, 0.14, 0.03, 2), xform(0, 2.24 - i * 0.02, -2.35 - i * 0.26, -8 * DEG, 0, 0));
      }
      return lights;
    },
  },

  /* ------------------------------------------------------- beach buggy */
  buggy: {
    id: 'buggy',
    name: 'DUNE FLEA',
    blurb: 'Half a floor pan, a cage, and an enormous grin.',
    drive: 'awd',
    topSpeed: 94,
    gears: [3.25, 2.20, 1.62, 1.24, 1.00],
    reverseRatio: 3.4,
    length: 7.9, width: 4.45, height: 3.05,
    physics: {
      mass: 0.94, cgHeight: 1.32, cgBias: 0.44, wheelbase: 5.0,
      trackWidth: 4.00, wheelRadius: 1.34, suspRest: 2.15,
      enginePeakTorque: 10.2, redlineRpm: 8800, diffLock: 0.80,
      springRate: 116, damperBump: 7.4, damperRebound: 11.5,
      airPitch: 3.6, airRoll: 4.2, downforceCoef: 0.005,
    },
    tires: { muLat: 0.585, muLong: 0.66 },
    stats: { speed: 0.62, accel: 0.72, grip: 0.70, handling: 0.90, toughness: 0.66 },
    openWheel: true,
    arms: { role: 'trim', radius: 0.095, levels: [{ y: 0.42, x: 0.34, z: 0.24 }, { y: -0.34, x: 0.30, z: -0.22 }], shock: { x: 0.50, y: 1.30, r: 0.13 } },
    body: {
      floorY: 0.90, capNose: 0.34, capTail: 0.32, rTop: 0.34, rMid: 0.34, rSill: 0.26,
      keys: [
        K(-3.95, 1.96, 1.05, 0.86, 1.42, 0.94),
        K(-3.35, 2.30, 1.32, 1.10, 1.60, 1.16),
        K(-2.60, 2.42, 1.44, 1.20, 1.70, 1.28),
        K(-1.70, 2.30, 1.45, 1.26, 1.66, 1.32),
        K(-0.70, 2.16, 1.45, 1.30, 1.60, 1.34),
        K(0.30, 2.14, 1.45, 1.30, 1.58, 1.34),
        K(1.20, 2.24, 1.44, 1.24, 1.62, 1.30),
        K(2.10, 2.16, 1.40, 1.16, 1.60, 1.22),
        K(2.95, 1.94, 1.30, 1.06, 1.48, 1.10),
        K(3.60, 1.70, 1.10, 0.88, 1.34, 0.92),
        K(3.95, 1.52, 0.86, 0.70, 1.24, 0.72),
      ],
    },
    cabin: { glassZ: [-0.70, 1.30], screenZ: [0.70, 1.30], backlightZ: null, beltFrac: 0.30 },
    numberZ: -0.10,
    shutZ: [],
    hoodZ: [1.35, -1.85],
    wheel: { style: 'taper', spokes: 3, rimR: 0.52, halfW: 0.52, band: 0.13, hubR: 0.34, inset: 0.20, tread: 'knobbly', bolts: 5, apertureIn: 0.24, apertureOut: 0.42, lugs: { rows: 2, count: 14 } },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLips: false,
        headlamps: [{ type: 'round', x: 1.00, y: 2.10, z: 3.62, r: 0.32 }],
        taillamps: [{ x: 0.80, y: 2.08, z: -3.86, w: 0.44, h: 0.34 }],
        reverselamps: [{ x: 0.30, y: 1.78, z: -3.86, w: 0.30, h: 0.18 }],
        interior: { z0: -1.30, z1: 1.30, inset: 0.22, seatY: 1.66, seatZ: -0.30, seatX: [-0.58, 0.58] },
        plate: { z0: -3.50, z1: 3.50, inset: 0.10 },
        driver: { y: 2.72, z: -0.20, scale: 0.92 },
        glass: null,
      });
      // Cycle fenders over each wheel — the buggy's whole visual signature.
      const fender = (zc, r, x) => {
        const path = [];
        for (let i = 0; i <= 14; i++) {
          const a = lerp(10 * DEG, 170 * DEG, i / 14);
          path.push([x, env.hubY + Math.sin(a) * r, zc + Math.cos(a) * r]);
        }
        return sweep(path, rectProfile(0.62, 0.09, 0.06, 2), { up: [1, 0, 0] });
      };
      for (const a of [{ z: env.axleZ.front }, { z: env.axleZ.rear }]) {
        out.pair('accent', fender(a.z, env.R + 0.32, env.halfTrack));
        out.pair('trim', sweep(
          [[env.halfTrack * 0.42, 1.60, a.z], [env.halfTrack - 0.24, env.hubY + env.R + 0.28, a.z]],
          circleProfile(0.09, 6), { up: [0, 1, 0] }
        ));
      }
      // Roll cage.
      const cageR = 0.115;
      const hoop = (z, w, h) => {
        const p = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const a = lerp(-Math.PI * 0.5, Math.PI * 0.5, t);
          p.push([Math.sin(a) * w, lerp(1.90, h, Math.cos(a * 0.92)), z]);
        }
        return p;
      };
      out.add('trim', makeTubes([
        hoop(-0.85, 1.36, 3.72),
        hoop(1.28, 1.24, 3.10),
        [[-1.30, 3.62, -0.85], [-1.18, 3.02, 1.28]],
        [[1.30, 3.62, -0.85], [1.18, 3.02, 1.28]],
        [[-1.34, 3.55, -0.90], [-1.16, 2.10, -2.95]],
        [[1.34, 3.55, -0.90], [1.16, 2.10, -2.95]],
        [[-1.30, 2.02, 1.40], [-1.28, 1.98, 2.60]],
        [[1.30, 2.02, 1.40], [1.28, 1.98, 2.60]],
      ], cageR));
      // Exposed rear engine, air-cooled fan housing, upswept pipes.
      out.add('trim', bevelBox(1.85, 0.85, 1.30, 0.24, 3), xform(0, 2.34, -2.75));
      out.add('chrome', revolveX([[0.001, -0.16], [0.52, -0.16], [0.58, 0], [0.52, 0.16], [0.001, 0.16]], 16),
        xform(0, 2.86, -2.75, 0, 0, Math.PI / 2));
      const upsweep = [[0.62, 2.10, -3.15], [1.10, 1.90, -3.60], [1.28, 2.36, -3.86]];
      out.pair('chrome', makeExhaust(upsweep, 0.135, { flare: 0.42 }));
      out.pair('grille', pipeBore(upsweep, 0.135, { flare: 0.42 }));
      // Windscreen frame only — no glass, it is a beach car.
      out.add('trim', makeTubes([
        [[-1.28, 2.20, 1.34], [-1.16, 3.02, 1.24]],
        [[1.28, 2.20, 1.34], [1.16, 3.02, 1.24]],
        [[-1.18, 3.04, 1.25], [1.18, 3.04, 1.25]],
      ], 0.10));
      out.add('glass', extrudePlate(roundRectShape(2.30, 0.86, 0.10), 0.05, 0.02, 8),
        xform(0, 2.62, 1.29, 8 * DEG, 0, 0));
      return lights;
    },
  },

  /* ------------------------------------------------------ monster truck */
  monster: {
    id: 'monster',
    name: 'CRUSHER 4X4',
    blurb: 'Two metres of tyre under a shoebox. Physics is a suggestion.',
    drive: 'awd',
    topSpeed: 90,
    gears: [3.70, 2.35, 1.66, 1.22, 0.98],
    reverseRatio: 3.8,
    length: 9.0, width: 5.40, height: 5.30,
    physics: {
      mass: 1.26, cgHeight: 2.50, cgBias: 0.52, wheelbase: 5.7,
      trackWidth: 5.00, wheelRadius: 2.00, suspRest: 2.60,
      enginePeakTorque: 13.6, redlineRpm: 6200, diffLock: 0.86,
      springRate: 128, damperBump: 8.8, damperRebound: 13.5,
      inertiaYaw: 0.98, inertiaRoll: 2.35,
      steerMaxLow: 30 * DEG, downforceCoef: 0.004, arbFront: 108, arbRear: 100,
    },
    tires: { muLat: 0.555, muLong: 0.645 },
    stats: { speed: 0.52, accel: 0.72, grip: 0.56, handling: 0.44, toughness: 1.00 },
    openWheel: true,
    liveAxle: { r: 0.30, diff: 0.52, role: 'trim' },
    arms: { role: 'trim', radius: 0.14, levels: [{ y: 0.55, x: 0.30, z: 0.85 }, { y: -0.30, x: 0.34, z: -0.35 }], shock: { x: 0.62, y: 1.95, r: 0.17 } },
    body: {
      floorY: 2.30, capNose: 0.34, capTail: 0.30, rTop: 0.30, rMid: 0.30, rSill: 0.22,
      keys: [
        K(-4.50, 3.52, 1.36, 1.22, 2.86, 1.20),
        K(-4.05, 3.66, 1.62, 1.46, 2.92, 1.44),
        K(-3.30, 3.72, 1.66, 1.52, 3.00, 1.52),
        K(-2.20, 3.74, 1.68, 1.54, 3.02, 1.54),
        K(-1.30, 3.76, 1.66, 1.52, 3.00, 1.52),
        K(-0.85, 5.16, 1.68, 1.30, 3.30, 1.54),
        K(0.10, 5.30, 1.66, 1.22, 3.32, 1.52),
        K(0.95, 5.22, 1.66, 1.26, 3.30, 1.52),
        K(1.55, 4.10, 1.68, 1.46, 3.10, 1.54),
        K(2.60, 4.02, 1.66, 1.48, 3.06, 1.52),
        K(3.55, 3.94, 1.68, 1.48, 3.00, 1.52),
        K(4.20, 3.76, 1.52, 1.32, 2.90, 1.36),
        K(4.50, 3.52, 1.24, 1.06, 2.80, 1.10),
      ],
    },
    cabin: { glassZ: [-0.85, 1.10], screenZ: [0.35, 1.10], backlightZ: [-0.90, -0.45], beltFrac: 0.46 },
    glassLow: 4, glassLift: 0.06,
    numberZ: -0.10,
    shutZ: [-0.95, 1.18],
    hoodZ: [1.25, 3.30, -1.20],
    wheel: { style: 'taper', spokes: 6, rimR: 0.46, halfW: 0.74, band: 0.16, hubR: 0.34, inset: 0.24, tread: 'knobbly', bolts: 8, apertureIn: 0.22, apertureOut: 0.36, lugs: { rows: 3, count: 16, lugH: 0.24 } },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLips: false,
        bumperFront: { z: 4.40, y: 3.05, half: 1.05, depth: 0.24, thick: 0.24, tall: 0.34, role: 'chrome' },
        headlamps: [{ type: 'round', x: 1.05, y: 3.66, z: 4.42, r: 0.34 }],
        taillamps: [{ x: 1.10, y: 3.30, z: -4.52, w: 0.46, h: 0.62 }],
        reverselamps: [{ x: 0.42, y: 2.90, z: -4.50, w: 0.36, h: 0.20 }],
        grille: { y: 3.42, z: 4.40, w: 1.85, h: 0.72, bars: 5 },
        mirrors: [{ x: 1.84, y: 4.70, z: 1.00 }],
        glass: { z: [-0.85, 1.12], lift: 0.06, low: 6, steps: 10 },
        interior: { z0: -0.80, z1: 1.05, inset: 0.28, seatY: 3.92, seatZ: -0.20, seatX: [-0.60, 0.60] },
        plate: false,
      });
      // Ladder chassis: two rails, cross members, live axles, coilovers.
      const rail = bevelBox(0.34, 0.46, 8.10, 0.10, 2);
      out.pair('base', rail, xform(0.92, 2.02, -0.10));
      for (const z of [-3.6, -1.4, 0.8, 3.2]) {
        out.add('base', bevelBox(2.10, 0.26, 0.34, 0.08, 2), xform(0, 2.02, z));
      }
      // The live axles are NOT built here: with 2.6 u of suspension travel a
      // static axle would tear straight through the wheels. VehicleVisual
      // assembles them per frame from `liveAxle` and the real hub positions.
      out.add('base', bevelBox(1.10, 0.70, 1.30, 0.20, 3), xform(0, 2.10, -0.20));
      // Stacks. These point up, and every camera in the game looks down, so
      // the bore is the part of them anything ever sees.
      const stack = [[1.15, 3.10, -1.30], [1.35, 4.20, -1.45], [1.42, 5.35, -1.50]];
      out.pair('chrome', makeExhaust(stack, 0.17, { flare: 0.28 }));
      out.pair('grille', pipeBore(stack, 0.17, { flare: 0.28 }));
      return lights;
    },
  },

  /* --------------------------------------------------------- classic F1 */
  formula: {
    id: 'formula',
    name: 'SILVERBOLT 66',
    blurb: 'A cigar, four wheels and no seatbelt worth the name.',
    drive: 'rwd',
    topSpeed: 112,
    gears: [2.90, 2.10, 1.68, 1.40, 1.20, 1.04],
    reverseRatio: 3.0,
    length: 9.5, width: 4.30, height: 2.30,
    physics: {
      mass: 0.88, cgHeight: 0.92, cgBias: 0.46, wheelbase: 6.2,
      trackWidth: 3.55, wheelRadius: 1.10, suspRest: 0.95,
      enginePeakTorque: 9.8, redlineRpm: 11500, gripFront: 1.16, gripRear: 1.14,
      springRate: 285, damperBump: 13, damperRebound: 19,
      arbFront: 245, arbRear: 228, inertiaYaw: 0.50,
      downforceCoef: 0.0190, aeroBalance: 0.47, diffLock: 0.70,
      driftThrust: 12, handbrakeGrip: 0.66,
    },
    tires: { muLat: 0.66, muLong: 0.70 },
    stats: { speed: 1.00, accel: 0.94, grip: 0.94, handling: 0.96, toughness: 0.22 },
    openWheel: true,
    arms: { role: 'trim', radius: 0.075, levels: [{ y: 0.36, x: 0.36, z: 0.30 }, { y: -0.26, x: 0.30, z: -0.28 }, { y: 0.10, x: 0.42, z: 0.55 }] },
    body: {
      floorY: 0.34, capNose: 0.28, capTail: 0.26, rTop: 0.24, rMid: 0.24, rSill: 0.18,
      keys: [
        K(-4.75, 1.06, 0.42, 0.34, 0.70, 0.36),
        K(-4.20, 1.28, 0.66, 0.54, 0.78, 0.58),
        K(-3.55, 1.62, 0.86, 0.70, 0.92, 0.76),
        K(-2.60, 1.86, 0.95, 0.76, 1.02, 0.84),
        K(-1.70, 1.90, 0.96, 0.78, 1.04, 0.86),
        K(-0.90, 2.02, 0.94, 0.72, 1.06, 0.84),
        K(-0.20, 2.30, 0.90, 0.62, 1.08, 0.80),
        K(0.55, 2.14, 0.88, 0.62, 1.06, 0.78),
        K(1.30, 1.76, 0.90, 0.72, 1.00, 0.80),
        K(2.30, 1.60, 0.92, 0.76, 0.94, 0.82),
        K(3.15, 1.42, 0.86, 0.72, 0.86, 0.76),
        K(4.10, 1.16, 0.66, 0.54, 0.74, 0.58),
        K(4.75, 0.94, 0.40, 0.32, 0.64, 0.34),
      ],
    },
    cabin: { glassZ: [-0.85, 0.55], screenZ: [0.20, 0.55], backlightZ: null, beltFrac: 0.22 },
    numberZ: 0.80,
    shutZ: [],
    hoodZ: [1.05, -1.10],
    wheelVisual: { front: 0.90, rear: 1.16 },
    wheel: { style: 'taper', spokes: 4, rimR: 0.62, halfW: 0.48, band: 0.12, hubR: 0.34, inset: 0.16, tread: 'slick', bolts: 1, boltR: 0 },
    wheelRear: { halfW: 0.68, style: 'taper', spokes: 4, rimR: 0.56, band: 0.12, hubR: 0.32, inset: 0.16, tread: 'slick', bolts: 1, boltR: 0 },
    build(env) {
      const { out } = env;
      const lights = dressChassis(env, {
        archLips: false,
        taillamps: [{ x: 0.0, y: 1.10, z: -4.86, w: 0.34, h: 0.22, surround: false }],
        plate: { z0: -3.90, z1: 3.90, inset: 0.06 },
        driver: { y: 2.68, z: -0.20, scale: 0.90 },
        interior: { z0: -0.90, z1: 0.60, inset: 0.18, seats: false },
      });
      lights.head.length = 0;
      // Roll hoop, headrest fairing, mirrors on stalks.
      out.add('trim', makeTubes([[
        [-0.62, 2.06, -0.92], [-0.50, 2.86, -0.98], [0, 3.04, -1.00], [0.50, 2.86, -0.98], [0.62, 2.06, -0.92],
      ]], 0.13));
      out.add('accent', bevelBox(0.86, 0.52, 1.35, 0.22, 3), xform(0, 2.44, -1.55));
      out.pair('trim', sweep([[0.72, 2.18, 0.30], [1.02, 2.34, 0.34]], circleProfile(0.06, 6), { up: [0, 1, 0] }));
      out.pair('chrome', bevelBox(0.09, 0.20, 0.30, 0.05, 2), xform(1.08, 2.36, 0.34));
      // Exposed engine with individual exhaust trumpets over the gearbox.
      out.add('trim', bevelBox(1.30, 0.86, 1.70, 0.22, 3), xform(0, 1.86, -2.35));
      for (let i = 0; i < 4; i++) {
        out.pair('chrome', makeExhaust([
          [0.34, 2.24, -1.85 - i * 0.28],
          [0.72, 2.10, -2.90 - i * 0.18],
          [0.62, 1.60, -4.30 - i * 0.12],
          [0.58, 1.52, -4.95],
        ], 0.075, { flare: 0.35, segments: 8 }));
      }
      out.add('trim', bevelBox(0.90, 0.62, 1.15, 0.20, 3), xform(0, 1.36, -3.70));
      // Slim nose wing and a ducktail — enough to read as a racing car.
      out.add('accent', makeWing({
        span: 2.70, chord: 0.62, thick: 0.09, y: 1.12, z: 4.10,
        pylons: [], aoa: 6 * DEG, plateH: 0.42, plateY: 0.02,
      }));
      out.add('accent', extrudePlate(roundRectShape(1.70, 0.60, 0.14), 0.09, 0.03, 8),
        xform(0, 1.30, -4.55, 68 * DEG, 0, 0));
      // Radiator intake in the nose.
      out.add('grille', extrudePlate(roundRectShape(1.05, 0.42, 0.12), 0.14, 0.04, 8), xform(0, 1.04, 4.66));
      return lights;
    },
  },
};

export const CAR_MODEL_IDS = Object.keys(CAR_MODELS);

/** Look up a model definition, tolerating an unknown id. */
export function carModel(id) {
  return CAR_MODELS[id] || CAR_MODELS[CAR_MODEL_IDS[0]];
}

/* ==========================================================================
 * 9. Liveries
 * ========================================================================== */

const L = (name, base, secondary, accent, pattern, number, extra) => ({
  name, base, secondary, accent, pattern, number, ...(extra || {}),
});

export const LIVERIES = {
  muscle: [
    L('Hemi Orange', 0xd85a1c, 0x141519, 0xf3f4f6, 'stripes', 44, { preset: 'metallic', flake: 0.62, rim: 'chrome', stripeY: 0.30, stripeW: 0.17, sponsors: ['NITRO 9', 'PISTON'] }),
    L('Petrol Blue', 0x18468c, 0xf1f3f6, 0xd6202a, 'racing', 7, { preset: 'metallic', flake: 0.55, rim: 'chrome', stripeY: 0.34, stripeW: 0.20, sponsors: ['MICRO', 'ATLAS'] }),
    L('Bare Primer', 0x6d6f74, 0x2a2c31, 0xd0521e, 'flame', 13, { preset: 'matte', flake: 0.10, rim: 'dark', sponsors: ['SOLDER', 'RIVET'] }),
    L('Candy Plum', 0x6a1d5c, 0x100f16, 0xf0c24a, 'twoTone', 21, { preset: 'candy', flake: 0.80, rim: 'gold', split: 0.62, sponsors: ['VOLT'] }),
    L('Sunburst', 0xe8a410, 0x1b1c20, 0xffffff, 'checker', 3, { preset: 'pearl', flake: 0.42, rim: 'chrome', sponsors: ['HALO OIL', 'CRUMB'] }),
  ],
  wedge: [
    L('Arrest Me Red', 0xc21520, 0x101216, 0xf5f6f8, 'solid', 9, { preset: 'candy', flake: 0.72, rim: 'gold', sponsors: ['APEX FUEL'] }),
    L('Bianco', 0xeceef1, 0x1b1d22, 0xd0202c, 'racing', 5, { preset: 'solid', flake: 0.18, rim: 'dark', stripeY: 0.30, stripeW: 0.13, sponsors: ['MICRO', 'FLUX'] }),
    L('Verde Acido', 0x8fce1c, 0x14161a, 0x101216, 'twoTone', 12, { preset: 'metallic', flake: 0.60, rim: 'dark', split: 0.70, sponsors: ['ZED'] }),
    L('Nero Opaco', 0x1c1e24, 0x3a3d46, 0xd8a01c, 'stripes', 27, { preset: 'matte', flake: 0.14, rim: 'gold', stripeY: 0.26, stripeW: 0.10, sponsors: ['OCTA', 'K-DRIVE'] }),
    L('Azzurro', 0x2a7fd4, 0xf2f4f7, 0xe8b418, 'halves', 33, { preset: 'pearl', flake: 0.48, rim: 'white', sponsors: ['SPARK'] }),
  ],
  rally: [
    L('Works Blue', 0x1546a8, 0xf2f4f7, 0xd8232e, 'rally', 11, { preset: 'solid', flake: 0.20, rim: 'gold', sponsors: ['MICRO', 'GRIP-X'] }),
    L('Martini Snow', 0xf0f2f5, 0x1b3f8f, 0xd0202c, 'stripes', 2, { preset: 'solid', flake: 0.16, rim: 'gold', stripeY: 0.26, stripeW: 0.12, sponsors: ['NINE', 'ATLAS'] }),
    L('Forest Green', 0x1d5a34, 0xe9ecef, 0xe8b418, 'twoTone', 18, { preset: 'metallic', flake: 0.50, rim: 'white', split: 0.66, sponsors: ['CARBO'] }),
    L('Rally Orange', 0xe06414, 0x16181c, 0xffffff, 'rally', 24, { preset: 'metallic', flake: 0.52, rim: 'dark', sponsors: ['TIN CAN', 'VOLT'] }),
    L('Night Stage', 0x22252c, 0x6a707a, 0x54d0f0, 'racing', 6, { preset: 'metallic', flake: 0.44, rim: 'dark', stripeY: 0.32, stripeW: 0.14, sponsors: ['FLUX'] }),
  ],
  pickup: [
    L('Barn Red', 0x9c2018, 0xe4e0d4, 0xd7a02c, 'twoTone', 8, { preset: 'metallic', flake: 0.46, rim: 'chrome', split: 0.60, sponsors: ['BOLT & CO'] }),
    L('Copper Flake', 0xa8571e, 0x1a1a1e, 0xf0e2c0, 'flame', 66, { preset: 'candy', flake: 0.85, rim: 'chrome', sponsors: ['PISTON', 'SOLDER'] }),
    L('Highway Cream', 0xe4dcc2, 0x2f4a2a, 0xb02a20, 'stripes', 15, { preset: 'solid', flake: 0.18, rim: 'chrome', stripeY: 0.44, stripeW: 0.14, sponsors: ['CRUMB'] }),
    L('Gunmetal', 0x3c4048, 0x14161a, 0xe06a18, 'racing', 4, { preset: 'metallic', flake: 0.58, rim: 'dark', stripeY: 0.30, stripeW: 0.12, sponsors: ['NITRO 9', 'RIVET'] }),
    L('Sky Fade', 0x6fb0d8, 0xf4f5f7, 0x1b3d6a, 'halves', 29, { preset: 'pearl', flake: 0.40, rim: 'white', sponsors: ['HALO OIL'] }),
  ],
  gt: [
    L('Night Silver', 0xb8bcc4, 0x15171c, 0x2c8fd8, 'racing', 61, { preset: 'metallic', flake: 0.66, rim: 'dark', stripeY: 0.34, stripeW: 0.15, sponsors: ['MICRO', 'OCTA'] }),
    L('Midnight', 0x12141a, 0x2c3038, 0xe8b418, 'stripes', 1, { preset: 'metallic', flake: 0.52, rim: 'gold', stripeY: 0.28, stripeW: 0.11, sponsors: ['APEX FUEL', 'ZED'] }),
    L('Rothman White', 0xf0f2f6, 0x1d4fa0, 0xd8232e, 'twoTone', 17, { preset: 'solid', flake: 0.22, rim: 'white', split: 0.55, sponsors: ['NINE'] }),
    L('Jaeger Purple', 0x4a2a86, 0xf2f0f6, 0x54e0c0, 'racing', 38, { preset: 'candy', flake: 0.78, rim: 'dark', stripeY: 0.36, stripeW: 0.18, sponsors: ['FLUX', 'K-DRIVE'] }),
    L('Papaya', 0xf06a10, 0x16181c, 0xffffff, 'solid', 5, { preset: 'metallic', flake: 0.58, rim: 'dark', sponsors: ['SPARK', 'CARBO'] }),
  ],
  buggy: [
    L('Surf Yellow', 0xf0c018, 0x1a1c20, 0x1888c8, 'twoTone', 9, { preset: 'solid', flake: 0.22, rim: 'chrome', split: 0.70, sponsors: ['TOYBOX'] }),
    L('Lagoon', 0x18a0a8, 0xf2f4f6, 0xf05a18, 'stripes', 42, { preset: 'metallic', flake: 0.48, rim: 'white', stripeY: 0.36, stripeW: 0.20, sponsors: ['SPARK'] }),
    L('Sand Camo', 0xc4a874, 0x6a6244, 0x2c2a24, 'rally', 23, { preset: 'matte', flake: 0.10, rim: 'dark', sponsors: ['GRIP-X'] }),
    L('Hot Pink', 0xe0348c, 0x18181c, 0xf0f0a0, 'flame', 77, { preset: 'candy', flake: 0.82, rim: 'chrome', sponsors: ['NINE', 'VOLT'] }),
    L('Beach Bug', 0xf2f4f6, 0x2088d0, 0xe03020, 'checker', 14, { preset: 'solid', flake: 0.16, rim: 'chrome', sponsors: ['CRUMB'] }),
  ],
  monster: [
    L('Mud Crusher', 0x6a3018, 0x1c1a18, 0xe0a018, 'flame', 88, { preset: 'metallic', flake: 0.44, rim: 'chrome', sponsors: ['PISTON', 'TIN CAN'] }),
    L('Toxic Lime', 0x86d018, 0x18181c, 0xd02020, 'racing', 3, { preset: 'candy', flake: 0.76, rim: 'chrome', stripeY: 0.32, stripeW: 0.16, sponsors: ['NITRO 9'] }),
    L('Patriot', 0xf2f4f6, 0x1a3d8c, 0xc41c26, 'stripes', 76, { preset: 'solid', flake: 0.20, rim: 'chrome', stripeY: 0.34, stripeW: 0.16, sponsors: ['ATLAS', 'BOLT & CO'] }),
    L('Purple Haze', 0x5c2a9c, 0x1a1620, 0xf0d020, 'twoTone', 31, { preset: 'candy', flake: 0.80, rim: 'gold', split: 0.62, sponsors: ['VOLT'] }),
    L('Rust Bucket', 0x8a5a3a, 0x3a2a20, 0xd8c8a0, 'rally', 12, { preset: 'matte', flake: 0.12, rim: 'dark', sponsors: ['SOLDER', 'RIVET'] }),
  ],
  formula: [
    L('Silver Arrow', 0xc8ccd2, 0x1a1c20, 0xd0202c, 'stripes', 1, { preset: 'metallic', flake: 0.62, rim: 'chrome', stripeY: 0.28, stripeW: 0.12, sponsors: ['MICRO'] }),
    L('British Green', 0x0f4a2c, 0xe8e4d4, 0xf0d020, 'solid', 5, { preset: 'metallic', flake: 0.40, rim: 'chrome', sponsors: ['ATLAS'] }),
    L('Rosso Corsa', 0xc4141e, 0xf0f2f6, 0x1a1c20, 'racing', 27, { preset: 'candy', flake: 0.70, rim: 'chrome', stripeY: 0.30, stripeW: 0.10, sponsors: ['APEX FUEL'] }),
    L('French Blue', 0x1a52b0, 0xf2f4f7, 0xd0202c, 'stripes', 16, { preset: 'metallic', flake: 0.52, rim: 'white', stripeY: 0.30, stripeW: 0.13, sponsors: ['NINE'] }),
    L('Gold Leaf', 0xf0e0c0, 0xc42a1e, 0xd8a418, 'twoTone', 8, { preset: 'pearl', flake: 0.46, rim: 'gold', split: 0.52, sponsors: ['HALO OIL', 'ZED'] }),
  ],
};

/**
 * The promoted roster — the only chassis the field is built from.
 *
 * Eight chassis are authored below and all eight still work; this is a scope
 * decision, not a deletion. Finishing one car to a die-cast standard — bevels
 * that catch a highlight, glazing with real depth, a livery that survives a
 * macro shot — is most of a wave's work, and three is what can be carried to
 * that bar. The three are chosen for silhouette separation, so a glance at a
 * pack reads as three different cars and not three palettes of one: a long
 * bonnet and a fastback (muscle), a doorstop with a high tail (wedge), and a
 * short, tall, boxy hatch on visible suspension travel (rally).
 *
 * Field assignment is `roster[i % 3]` with `livery: i`, and with five liveries
 * per chassis that yields eight distinct (chassis, livery) pairs across a
 * default grid — no two cars on track are the same object.
 */
export const ROSTER = ['muscle', 'wedge', 'rally'];

/** Resolve a livery for a model, wrapping the index. */
export function liveryFor(modelId, index = 0) {
  const set = LIVERIES[modelId] || LIVERIES.muscle;
  const i = ((Math.round(Number(index) || 0) % set.length) + set.length) % set.length;
  return set[i];
}

/* ==========================================================================
 * 10. Chassis assembly
 * ========================================================================== */

const CHASSIS_CACHE = new Map();
const LIVERY_TEX_CACHE = new Map();

/**
 * Build (or fetch) the complete geometry set for one model.
 * Geometry is shared by every car of that model — eight bodies exist in the
 * whole game no matter how many cars are on the grid.
 */
export function buildChassis(id, opts = {}) {
  const key = `${id}|${opts.quality || 'high'}`;
  const hit = CHASSIS_CACHE.get(key);
  if (hit) return hit;

  const def = carModel(id);
  const p = def.physics || {};
  const cgHeight = p.cgHeight ?? 1.25;
  const R = p.wheelRadius ?? 1.15;
  const wheelbase = p.wheelbase ?? 5.6;
  const cgBias = p.cgBias ?? 0.5;
  const halfTrack = (p.trackWidth ?? 3.6) * 0.5;
  const axleZ = { front: wheelbase * (1 - cgBias), rear: -wheelbase * cgBias };

  const archClear = def.body.archClear ?? 0.13;
  const arches = def.openWheel ? [] : [
    { z: axleZ.front, hub: R, r: R + archClear },
    { z: axleZ.rear, hub: R, r: R + archClear },
  ];

  const shell = buildBodyShell({ ...def.body, arches });
  const out = makeCollector(flatPaintUV(shell.bands));
  out.addShell(shell.geometry);

  const env = {
    id: def.id, def, out, shell, arches, axleZ,
    R, hubY: R, halfTrack, cgHeight,
    L: def.length, Wd: def.width, Ht: def.height,
    rng: makeRng(`chassis:${def.id}`),
  };

  let lights = { head: [], brake: [], reverse: [] };
  try {
    lights = def.build(env) || lights;
  } catch (err) {
    console.warn(`[CarModels] extras failed for "${def.id}"`, err);
  }

  const parts = out.finish();
  // Author with the ground at y = 0, ship with the origin at the centre of mass.
  for (const part of parts) {
    part.geometry.translate(0, -cgHeight, 0);
    part.geometry.computeBoundingSphere();
  }
  for (const arr of [lights.head, lights.brake, lights.reverse]) {
    for (const l of arr) l.y -= cgHeight;
  }

  /* --- wheels ----------------------------------------------------------- */
  const vis = def.wheelVisual || {};
  const mkWheel = (cfg, scale) => {
    const rr = R * (scale ?? 1);
    return buildWheelSet({
      ...cfg,
      R: rr,
      halfW: cfg.halfW ?? 0.46,
      rimR: rr * clamp(cfg.rimR ?? 0.62, 0.34, 0.72),
      segments: opts.quality === 'low' ? 20 : 30,
      lugs: cfg.lugs ? { ...cfg.lugs, lugH: cfg.lugs.lugH ?? rr * 0.13 } : null,
    });
  };
  const front = mkWheel(def.wheel, vis.front ?? 1);
  const rear = def.wheelRear || (vis.rear !== undefined && vis.rear !== vis.front)
    ? mkWheel(def.wheelRear || def.wheel, vis.rear ?? 1)
    : front;
  front.hubLift = front.radius - R;
  rear.hubLift = rear.radius - R;
  front.tread = def.wheel.tread || 'road';
  rear.tread = (def.wheelRear || def.wheel).tread || front.tread;

  const chassis = {
    id: def.id,
    def,
    parts,
    wheels: { front, rear },
    lights,
    axleZ,
    cabin: def.cabin || null,
    numberZ: def.numberZ ?? 0,
    shutZ: def.shutZ || [],
    hoodZ: def.hoodZ || [],
    openWheel: !!def.openWheel,
    arms: def.arms || null,
    liveAxle: def.liveAxle || null,
    stats: def.stats || null,
    uv: { zMin: shell.zMin, zMax: shell.zMax, bands: shell.bands, glass: env.glass || null },
    footprint: { length: def.length * 0.96, width: Math.max(def.width, halfTrack * 2 + front.halfWidth * 2) * 0.92 },
    cgHeight,
    halfTrack,
    R,
    dispose() {
      for (const part of parts) part.geometry.dispose();
      for (const w of [front, rear]) {
        if (!w) continue;
        for (const k of ['tyre', 'rim', 'rimTrim', 'disc', 'caliper']) w[k]?.dispose?.();
      }
      CHASSIS_CACHE.delete(key);
    },
  };

  CHASSIS_CACHE.set(key, chassis);
  return chassis;
}

/** Livery textures for one (model, livery) pair. Shared across cars. */
export function chassisLivery(chassis, liveryIndex, opts = {}) {
  const livery = liveryFor(chassis.id, liveryIndex);
  const key = `${chassis.id}|${livery.name}|${opts.size || 1024}`;
  let hit = LIVERY_TEX_CACHE.get(key);
  if (!hit) {
    let tex = { map: null, normalMap: null };
    try {
      tex = makeLiveryTextures(chassis, livery, opts);
    } catch (err) {
      console.warn('[CarModels] livery paint failed', err);
    }
    hit = { livery, ...tex };
    LIVERY_TEX_CACHE.set(key, hit);
  }
  return hit;
}

/** Tyre textures for a wheel set, sized to its own tread band. */
export function wheelTexture(wheelSet, opts = {}) {
  return tyreTexture(wheelSet.tread || 'road', wheelSet.tyre.userData.treadV || [0.35, 0.65], opts.size || 1024);
}

/** Free every cached geometry and texture. */
export function disposeCarModels() {
  for (const c of Array.from(CHASSIS_CACHE.values())) c.dispose();
  CHASSIS_CACHE.clear();
  for (const t of LIVERY_TEX_CACHE.values()) {
    t.map?.dispose?.();
    t.normalMap?.dispose?.();
  }
  LIVERY_TEX_CACHE.clear();
  for (const t of TYRE_TEXTURES.values()) {
    t.map?.dispose?.();
    t.normalMap?.dispose?.();
  }
  TYRE_TEXTURES.clear();
  for (const t of PLATE_TEXTURES.values()) {
    t.map?.dispose?.();
    t.normalMap?.dispose?.();
  }
  PLATE_TEXTURES.clear();
}

export default CAR_MODELS;
