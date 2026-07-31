// physics/Collision.js — shapes, manifolds, ray tests and the impulse solver.
//
// This file is deliberately stateless. Everything here operates on a *proxy*:
// a plain record that physics/World.js refreshes once per tick from whatever
// body object an owning system handed it. Keeping the maths free of world state
// is what makes it testable from the console and what stops the narrowphase
// from caring whether a body came from Vehicle.js, Props.js or TrackBuilder.
//
// ------------------------------------------------------------------ the proxy
//
//   shape      'box' | 'sphere' | 'capsule' | 'heightfield' | 'mesh'
//   centre     world centre of the collision volume (Vector3)
//   com        world centre of MASS (Vector3) — not the same thing for a car:
//              the chassis box is centred at bodyHeight/2 but the CoM sits at
//              cgHeight. rA/rB levers must be measured from the CoM or spin
//              transfer comes out wrong.
//   quat       world orientation (Quaternion)
//   axX/axY/axZ world-space unit axes, refreshed from quat
//   half       box half extents (Vector3), local
//   radius     sphere / capsule / cylinder radius
//   halfHeight capsule half length along local Y (0 for a sphere)
//   roundXZ    true when this box is really a cylinder — see roundCylinder()
//   invMass    0 for static
//   invI       diagonal inverse inertia in LOCAL axes (Vector3), 0,0,0 static
//   velocity, angularVelocity   live vectors, written in place by the solver
//   pseudoV, pseudoW            split-impulse accumulators, applied to position
//
// ---------------------------------------------------------------- conventions
//
// A manifold normal always points **from A towards B**. A positive `separation`
// means the shapes are apart (a speculative contact); negative means they
// overlap. Relative velocity is measured as vB(point) - vA(point), so the pair
// is approaching when dot(vRel, n) < 0.
//
// ------------------------------------------------------------ speculation
//
// There are no swept shape casts here and there do not need to be. Every
// narrowphase routine accepts a `margin` and will report a contact that has not
// happened yet, carrying its positive separation. The solver then constrains
// the closing speed to at most `separation / dt`, so a body physically cannot
// travel further than the gap in one step. That is a speculative contact, and
// it is a stronger guarantee than a swept test: it holds for any speed, any
// thickness and any number of simultaneous contacts, and it costs one extra
// term in the velocity bias. World.js adds a segment sweep on top of it purely
// as a belt-and-braces guard for the broadphase.

import * as THREE from 'three';
import { clamp, saturate } from '../core/Random.js';

/* ==========================================================================
 * Constants
 * ========================================================================== */

export const SHAPE = {
  BOX: 'box',
  SPHERE: 'sphere',
  CAPSULE: 'capsule',
  HEIGHTFIELD: 'heightfield',
  MESH: 'mesh',
};

/** Contact points per manifold. Four is enough for a face-on-face box pair. */
export const MAX_CONTACTS = 4;

/** Penetration left unresolved, so resting contacts stop chattering. */
export const SLOP = 0.035;

/** Fraction of the remaining penetration removed per position iteration. */
export const BAUMGARTE = 0.28;

/** Closing speed below which restitution is suppressed — kills micro-bounce. */
export const RESTITUTION_FLOOR = 9;

/** Face axes win ties against edge axes by this much; it keeps manifolds flat. */
const FACE_BIAS_REL = 0.98;
const FACE_BIAS_ABS = 0.02;

const EPS = 1e-6;

/* ==========================================================================
 * Module scratch. Nothing in this file allocates after load.
 * ========================================================================== */

const _a0 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
const _a3 = new THREE.Vector3();
const _a4 = new THREE.Vector3();
const _a5 = new THREE.Vector3();
const _a6 = new THREE.Vector3();
const _a7 = new THREE.Vector3();
const _a8 = new THREE.Vector3();
const _a9 = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();

// SAT working set.
const _C = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
const _absC = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
const _tA = new Float64Array(3);
const _tB = new Float64Array(3);
const _halfA = new Float64Array(3);
const _halfB = new Float64Array(3);
// Filled with references to the bodies' own axis vectors each boxBox() call —
// deliberately not scratch vectors, so nothing downstream can clobber them.
const _axesA = [null, null, null];
const _axesB = [null, null, null];

// Clipping buffers. Eight is the worst case for a quad clipped by four planes.
const _poly0 = [];
const _poly1 = [];
for (let i = 0; i < 12; i++) { _poly0.push(new THREE.Vector3()); _poly1.push(new THREE.Vector3()); }
const _sep0 = new Float64Array(12);
const _sep1 = new Float64Array(12);

/* ==========================================================================
 * Manifold
 * ========================================================================== */

export class ContactPoint {
  constructor() {
    this.point = new THREE.Vector3();      // world, midway between the surfaces
    this.rA = new THREE.Vector3();         // lever from A's centre of mass
    this.rB = new THREE.Vector3();
    this.separation = 0;                   // < 0 overlapping, > 0 speculative
    this.normalImpulse = 0;
    this.tangentImpulse1 = 0;
    this.tangentImpulse2 = 0;
    this.normalMass = 0;
    this.tangentMass1 = 0;
    this.tangentMass2 = 0;
    this.velocityBias = 0;
    this.pseudoImpulse = 0;
    this.matched = false;                  // warm-started from the last tick
  }
}

export class Manifold {
  constructor() {
    this.a = null;
    this.b = null;
    this.normal = new THREE.Vector3(0, 1, 0);
    this.tangent1 = new THREE.Vector3(1, 0, 0);
    this.tangent2 = new THREE.Vector3(0, 0, 1);
    this.points = [];
    for (let i = 0; i < MAX_CONTACTS; i++) this.points.push(new ContactPoint());
    this.count = 0;
    this.restitution = 0.2;
    this.friction = 0.6;
    this.kind = 'generic';
    this.policy = null;
    /** Deepest closing speed seen before the solve — what fx and audio want. */
    this.approachSpeed = 0;
    this.tangentSpeed = 0;
    this.totalImpulse = 0;
    this.stamp = -1;
    this.eventCooldown = 0;
  }

  reset(a, b) {
    this.a = a;
    this.b = b;
    this.count = 0;
    this.totalImpulse = 0;
    this.approachSpeed = 0;
    this.tangentSpeed = 0;
    return this;
  }

  /** Next free contact slot, or null when the manifold is full. */
  add() {
    if (this.count >= MAX_CONTACTS) return null;
    const p = this.points[this.count++];
    p.normalImpulse = 0;
    p.tangentImpulse1 = 0;
    p.tangentImpulse2 = 0;
    p.pseudoImpulse = 0;
    p.matched = false;
    return p;
  }
}

/* ==========================================================================
 * Small vector helpers that keep the rest of the file readable
 * ========================================================================== */

/** out = I_world^-1 * v, using the proxy's diagonal local tensor. */
export function applyInvInertia(p, v, out) {
  const ix = p.invI.x;
  const iy = p.invI.y;
  const iz = p.invI.z;
  if (ix === 0 && iy === 0 && iz === 0) return out.set(0, 0, 0);
  const x = v.x * p.axX.x + v.y * p.axX.y + v.z * p.axX.z;
  const y = v.x * p.axY.x + v.y * p.axY.y + v.z * p.axY.z;
  const z = v.x * p.axZ.x + v.y * p.axZ.y + v.z * p.axZ.z;
  return out
    .set(0, 0, 0)
    .addScaledVector(p.axX, x * ix)
    .addScaledVector(p.axY, y * iy)
    .addScaledVector(p.axZ, z * iz);
}

/** out = velocity of the material point at world offset r from the CoM. */
export function pointVelocity(p, r, out) {
  return out.crossVectors(p.angularVelocity, r).add(p.velocity);
}

/** Refresh the cached world axes of a proxy from its quaternion. */
export function refreshAxes(p) {
  const q = p.quat;
  p.axX.set(1, 0, 0).applyQuaternion(q);
  p.axY.set(0, 1, 0).applyQuaternion(q);
  p.axZ.set(0, 0, 1).applyQuaternion(q);
  return p;
}

/** Two unit vectors perpendicular to n, chosen without a branch-heavy basis. */
export function orthoBasis(n, t1, t2) {
  if (Math.abs(n.x) >= 0.57735) t1.set(n.y, -n.x, 0);
  else t1.set(0, n.z, -n.y);
  t1.normalize();
  t2.crossVectors(n, t1);
  return t1;
}

/* ==========================================================================
 * Narrowphase — box / box
 * ========================================================================== */

/**
 * Oriented box against oriented box, by separating axis with face clipping.
 *
 * Returns true when a manifold was produced. A manifold may be produced with
 * every point still separated (up to `margin`): that is the speculative case
 * and the solver treats it correctly.
 */
export function boxBox(A, B, mf, margin = 0) {
  _axesA[0] = A.axX; _axesA[1] = A.axY; _axesA[2] = A.axZ;
  _axesB[0] = B.axX; _axesB[1] = B.axY; _axesB[2] = B.axZ;
  _halfA[0] = A.half.x; _halfA[1] = A.half.y; _halfA[2] = A.half.z;
  _halfB[0] = B.half.x; _halfB[1] = B.half.y; _halfB[2] = B.half.z;

  _rel.subVectors(B.centre, A.centre);

  for (let i = 0; i < 3; i++) {
    _tA[i] = _rel.dot(_axesA[i]);
    for (let j = 0; j < 3; j++) {
      const c = _axesA[i].dot(_axesB[j]);
      _C[i][j] = c;
      // The epsilon keeps parallel-face pairs from producing a degenerate
      // cross-product axis, which is the classic SAT numerical trap.
      _absC[i][j] = Math.abs(c) + 1e-7;
    }
  }
  for (let j = 0; j < 3; j++) _tB[j] = _rel.dot(_axesB[j]);

  let best = -Infinity;
  let bestKind = 0;      // 0 = face of A, 1 = face of B, 2 = edge pair
  let bestIndex = 0;
  let bestJ = 0;

  // Faces of A.
  for (let i = 0; i < 3; i++) {
    const ra = _halfA[i];
    const rb = _halfB[0] * _absC[i][0] + _halfB[1] * _absC[i][1] + _halfB[2] * _absC[i][2];
    const s = Math.abs(_tA[i]) - (ra + rb);
    if (s > margin) return false;
    if (s > best) { best = s; bestKind = 0; bestIndex = i; }
  }

  // Faces of B.
  for (let j = 0; j < 3; j++) {
    const rb = _halfB[j];
    const ra = _halfA[0] * _absC[0][j] + _halfA[1] * _absC[1][j] + _halfA[2] * _absC[2][j];
    const s = Math.abs(_tB[j]) - (ra + rb);
    if (s > margin) return false;
    if (s > best * FACE_BIAS_REL + FACE_BIAS_ABS) { best = s; bestKind = 1; bestIndex = j; }
  }

  // Edge pairs. Biased against so a near-face contact stays a face contact.
  let edgeBest = -Infinity;
  let edgeI = 0;
  let edgeJ = 0;
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = _halfA[i1] * _absC[i2][j] + _halfA[i2] * _absC[i1][j];
      const rb = _halfB[j1] * _absC[i][j2] + _halfB[j2] * _absC[i][j1];
      const proj = Math.abs(_tA[i2] * _C[i1][j] - _tA[i1] * _C[i2][j]);
      const s = proj - (ra + rb);
      if (s > margin) return false;
      if (s > edgeBest) { edgeBest = s; edgeI = i; edgeJ = j; }
    }
  }
  if (edgeBest > best * FACE_BIAS_REL + FACE_BIAS_ABS) {
    best = edgeBest; bestKind = 2; bestIndex = edgeI; bestJ = edgeJ;
  }

  if (bestKind === 2) return edgeContact(A, B, mf, bestIndex, bestJ, best, margin);

  const ref = bestKind === 0 ? A : B;
  const inc = bestKind === 0 ? B : A;
  const axis = bestIndex;
  // The reference face is the one that looks at the other body. `_t*` is always
  // measured as (B.centre - A.centre), so the sign inverts when the reference
  // face belongs to B.
  const sign = bestKind === 0
    ? (_tA[axis] >= 0 ? 1 : -1)
    : (_tB[axis] >= 0 ? -1 : 1);
  return faceContact(ref, inc, mf, axis, sign, bestKind === 1, margin);
}

/**
 * Reference-face / incident-face clip.
 * @param {boolean} flip true when the reference face belongs to B, in which
 *   case the manifold normal must be inverted to keep the A -> B convention.
 */
function faceContact(ref, inc, mf, axis, sign, flip, margin) {
  const refAxes = axis === 0 ? ref.axX : axis === 1 ? ref.axY : ref.axZ;
  const refHalf = axis === 0 ? ref.half.x : axis === 1 ? ref.half.y : ref.half.z;

  // Outward normal of the reference face.
  _n0.copy(refAxes).multiplyScalar(sign);
  const refD = _n0.dot(ref.centre) + refHalf;

  // Incident face: the face of `inc` most anti-parallel to the reference normal.
  let incAxis = 0;
  let incDot = Infinity;
  let incSign = 1;
  for (let k = 0; k < 3; k++) {
    const ax = k === 0 ? inc.axX : k === 1 ? inc.axY : inc.axZ;
    const d = ax.dot(_n0);
    if (d < incDot) { incDot = d; incAxis = k; incSign = 1; }
    if (-d < incDot) { incDot = -d; incAxis = k; incSign = -1; }
  }
  const incHalf = incAxis === 0 ? inc.half.x : incAxis === 1 ? inc.half.y : inc.half.z;
  const incAx = incAxis === 0 ? inc.axX : incAxis === 1 ? inc.axY : inc.axZ;
  const u = (incAxis + 1) % 3;
  const w = (incAxis + 2) % 3;
  const uAx = u === 0 ? inc.axX : u === 1 ? inc.axY : inc.axZ;
  const wAx = w === 0 ? inc.axX : w === 1 ? inc.axY : inc.axZ;
  const uH = u === 0 ? inc.half.x : u === 1 ? inc.half.y : inc.half.z;
  const wH = w === 0 ? inc.half.x : w === 1 ? inc.half.y : inc.half.z;

  _a6.copy(inc.centre).addScaledVector(incAx, incSign * incHalf);
  _poly0[0].copy(_a6).addScaledVector(uAx, uH).addScaledVector(wAx, wH);
  _poly0[1].copy(_a6).addScaledVector(uAx, -uH).addScaledVector(wAx, wH);
  _poly0[2].copy(_a6).addScaledVector(uAx, -uH).addScaledVector(wAx, -wH);
  _poly0[3].copy(_a6).addScaledVector(uAx, uH).addScaledVector(wAx, -wH);
  let src = _poly0;
  let dst = _poly1;
  let count = 4;

  // Clip against the four side planes of the reference face.
  const s1 = (axis + 1) % 3;
  const s2 = (axis + 2) % 3;
  const sAx1 = s1 === 0 ? ref.axX : s1 === 1 ? ref.axY : ref.axZ;
  const sAx2 = s2 === 0 ? ref.axX : s2 === 1 ? ref.axY : ref.axZ;
  const sH1 = s1 === 0 ? ref.half.x : s1 === 1 ? ref.half.y : ref.half.z;
  const sH2 = s2 === 0 ? ref.half.x : s2 === 1 ? ref.half.y : ref.half.z;

  count = clipToPlane(src, count, dst, sAx1, sAx1.dot(ref.centre) + sH1, 1);
  if (count < 1) return false;
  let tmp = src; src = dst; dst = tmp;
  count = clipToPlane(src, count, dst, sAx1, sAx1.dot(ref.centre) - sH1, -1);
  if (count < 1) return false;
  tmp = src; src = dst; dst = tmp;
  count = clipToPlane(src, count, dst, sAx2, sAx2.dot(ref.centre) + sH2, 1);
  if (count < 1) return false;
  tmp = src; src = dst; dst = tmp;
  count = clipToPlane(src, count, dst, sAx2, sAx2.dot(ref.centre) - sH2, -1);
  if (count < 1) return false;
  src = dst;

  mf.count = 0;
  mf.normal.copy(_n0);
  if (flip) mf.normal.negate();

  // Keep the deepest MAX_CONTACTS points. Sorting four-to-eight entries by
  // hand beats Array.prototype.sort here — sort() allocates a comparator frame.
  for (let i = 0; i < count; i++) _sep0[i] = _n0.dot(src[i]) - refD;

  let added = 0;
  for (let pass = 0; pass < MAX_CONTACTS && added < MAX_CONTACTS; pass++) {
    let bestI = -1;
    let bestS = Infinity;
    for (let i = 0; i < count; i++) {
      if (_sep0[i] > margin) continue;
      if (_sep0[i] < bestS) { bestS = _sep0[i]; bestI = i; }
    }
    if (bestI < 0) break;
    const cp = mf.add();
    if (!cp) break;
    // Place the point midway between the two surfaces: that is where a real
    // contact patch is, and it stops the lever arm biasing towards one body.
    cp.point.copy(src[bestI]).addScaledVector(_n0, -bestS * 0.5);
    cp.separation = bestS;
    _sep0[bestI] = Infinity;
    added++;
  }
  return added > 0;
}

/** Sutherland-Hodgman against one plane. `side` +1 keeps dot(n,p) <= d. */
function clipToPlane(src, count, dst, planeN, planeD, side) {
  let out = 0;
  let prev = src[count - 1];
  let prevD = (planeN.dot(prev) - planeD) * side;
  for (let i = 0; i < count; i++) {
    const cur = src[i];
    const curD = (planeN.dot(cur) - planeD) * side;
    if (curD <= 0) {
      if (prevD > 0) {
        const t = prevD / (prevD - curD);
        dst[out++].copy(prev).lerp(cur, t);
        if (out >= dst.length) break;
      }
      dst[out++].copy(cur);
    } else if (prevD <= 0) {
      const t = prevD / (prevD - curD);
      dst[out++].copy(prev).lerp(cur, t);
    }
    if (out >= dst.length) break;
    prev = cur;
    prevD = curD;
  }
  return out;
}

/** Single-point contact for the edge-edge SAT case. */
function edgeContact(A, B, mf, i, j, separation, margin) {
  const eA = i === 0 ? A.axX : i === 1 ? A.axY : A.axZ;
  const eB = j === 0 ? B.axX : j === 1 ? B.axY : B.axZ;
  _n0.crossVectors(eA, eB);
  const len = _n0.length();
  // Parallel edges have no valid cross-product axis; the face tests already
  // covered that configuration, so bail rather than normalise a zero vector.
  if (len < 1e-5) return false;
  _n0.multiplyScalar(1 / len);
  if (_n0.dot(_rel) < 0) _n0.negate();

  // Support points: walk out along every axis except the edge's own.
  _a6.copy(A.centre);
  _a7.copy(B.centre);
  for (let k = 0; k < 3; k++) {
    const ax = k === 0 ? A.axX : k === 1 ? A.axY : A.axZ;
    const h = k === 0 ? A.half.x : k === 1 ? A.half.y : A.half.z;
    if (k !== i) _a6.addScaledVector(ax, ax.dot(_n0) >= 0 ? h : -h);
    const bx = k === 0 ? B.axX : k === 1 ? B.axY : B.axZ;
    const bh = k === 0 ? B.half.x : k === 1 ? B.half.y : B.half.z;
    if (k !== j) _a7.addScaledVector(bx, bx.dot(_n0) >= 0 ? -bh : bh);
  }

  closestPointsOnLines(_a6, eA, _a7, eB, _a8, _a9);

  mf.count = 0;
  mf.normal.copy(_n0);
  const cp = mf.add();
  if (!cp) return false;
  cp.point.copy(_a8).add(_a9).multiplyScalar(0.5);
  cp.separation = Math.min(separation, margin);
  return true;
}

/** Closest points between two infinite lines. Falls back to the origins. */
export function closestPointsOnLines(p1, d1, p2, d2, out1, out2) {
  _a0.subVectors(p1, p2);
  const a = d1.dot(d1);
  const b = d1.dot(d2);
  const c = d2.dot(d2);
  const d = d1.dot(_a0);
  const e = d2.dot(_a0);
  const den = a * c - b * b;
  let s = 0;
  let t = 0;
  if (Math.abs(den) > 1e-8) {
    s = (b * e - c * d) / den;
    t = (a * e - b * d) / den;
  }
  out1.copy(p1).addScaledVector(d1, s);
  out2.copy(p2).addScaledVector(d2, t);
  return out1;
}

/* ==========================================================================
 * Narrowphase — sphere / capsule against box and each other
 * ========================================================================== */

/** Closest point on an oriented box to a world point, written into `out`. */
export function closestPointOnBox(box, point, out) {
  _a0.subVectors(point, box.centre);
  const x = clamp(_a0.dot(box.axX), -box.half.x, box.half.x);
  const y = clamp(_a0.dot(box.axY), -box.half.y, box.half.y);
  const z = clamp(_a0.dot(box.axZ), -box.half.z, box.half.z);
  return out
    .copy(box.centre)
    .addScaledVector(box.axX, x)
    .addScaledVector(box.axY, y)
    .addScaledVector(box.axZ, z);
}

/**
 * Box against sphere. `flip` swaps the reported normal so the caller can pass
 * the pair in either order and still get an A -> B normal.
 */
export function boxSphere(box, sphere, mf, margin, flip) {
  closestPointOnBox(box, sphere.centre, _a1);
  _a2.subVectors(sphere.centre, _a1);
  let dist = _a2.length();
  let inside = false;

  if (dist < 1e-5) {
    // Centre inside the box: escape along the shallowest face.
    _a0.subVectors(sphere.centre, box.centre);
    const px = _a0.dot(box.axX);
    const py = _a0.dot(box.axY);
    const pz = _a0.dot(box.axZ);
    const dx = box.half.x - Math.abs(px);
    const dy = box.half.y - Math.abs(py);
    const dz = box.half.z - Math.abs(pz);
    if (dx <= dy && dx <= dz) {
      _a2.copy(box.axX).multiplyScalar(px >= 0 ? 1 : -1);
      dist = -dx;
    } else if (dy <= dz) {
      _a2.copy(box.axY).multiplyScalar(py >= 0 ? 1 : -1);
      dist = -dy;
    } else {
      _a2.copy(box.axZ).multiplyScalar(pz >= 0 ? 1 : -1);
      dist = -dz;
    }
    inside = true;
  } else {
    _a2.multiplyScalar(1 / dist);
  }

  const separation = dist - sphere.radius;
  if (!inside && separation > margin) return false;

  mf.count = 0;
  mf.normal.copy(_a2);            // box -> sphere
  if (flip) mf.normal.negate();
  const cp = mf.add();
  if (!cp) return false;
  cp.point.copy(sphere.centre).addScaledVector(_a2, -(sphere.radius + separation * 0.5));
  cp.separation = separation;
  return true;
}

/** Sphere against sphere. Normal points A -> B. */
export function sphereSphere(A, B, mf, margin) {
  _a2.subVectors(B.centre, A.centre);
  const dist = _a2.length();
  const separation = dist - (A.radius + B.radius);
  if (separation > margin) return false;
  if (dist < 1e-5) _a2.set(0, 1, 0); else _a2.multiplyScalar(1 / dist);
  mf.count = 0;
  mf.normal.copy(_a2);
  const cp = mf.add();
  if (!cp) return false;
  cp.point.copy(A.centre).addScaledVector(_a2, A.radius + separation * 0.5);
  cp.separation = separation;
  return true;
}

/* ==========================================================================
 * Cylinders
 *
 * A cylinder collides as the box that circumscribes it (half extents r, h/2,
 * r). That is exact on the flat caps and 41% too fat at the four vertical
 * "corners" of the square cross-section. This pass fixes both errors: the
 * normal is rotated onto the true radial direction, and the separation is
 * corrected by exactly the corner excess r/|cos| - r, which is the analytic
 * difference between the square and the inscribed circle along that direction.
 *
 * The result behaves like a cylinder — a car glances off a paint tin rather
 * than catching a phantom corner — at the cost of one dot product per contact.
 * ========================================================================== */

export function roundCylinder(mf, cyl, isA) {
  const axis = cyl.axY;
  const along = Math.abs(mf.normal.dot(axis));
  if (along > 0.86) return;      // hitting a cap: the box answer is exact

  // Radial direction taken at the contact centroid, so a multi-point manifold
  // stays coherent instead of fanning out.
  _a0.set(0, 0, 0);
  for (let i = 0; i < mf.count; i++) _a0.add(mf.points[i].point);
  if (mf.count > 1) _a0.multiplyScalar(1 / mf.count);
  _a1.subVectors(_a0, cyl.centre);
  _a1.addScaledVector(axis, -_a1.dot(axis));
  const radial = _a1.length();
  if (radial < 1e-4) return;
  _a1.multiplyScalar(1 / radial);

  // Outward from the cylinder is +normal when the cylinder is A, -normal when
  // it is B (the manifold normal always runs A -> B).
  const outward = isA ? 1 : -1;
  const cosTheta = Math.abs(_a1.dot(mf.normal));
  if (cosTheta < 0.2) return;    // degenerate; leave the box answer alone
  const excess = cyl.radius * (1 / Math.max(0.35, cosTheta) - 1);

  mf.normal.copy(_a1).multiplyScalar(outward);
  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    cp.separation += excess;
    // Slide the point onto the true curved surface.
    cp.point.addScaledVector(_a1, outward * excess * 0.5);
  }
}

/* ==========================================================================
 * Ray tests
 * ========================================================================== */

/** Slab test against an oriented box. Returns distance or -1. */
export function rayBox(origin, dir, box, maxDist, outNormal) {
  _a0.subVectors(origin, box.centre);
  const ox = _a0.dot(box.axX);
  const oy = _a0.dot(box.axY);
  const oz = _a0.dot(box.axZ);
  const dx = dir.dot(box.axX);
  const dy = dir.dot(box.axY);
  const dz = dir.dot(box.axZ);

  let tmin = 0;
  let tmax = maxDist;
  let axis = -1;
  let sign = 1;

  // Unrolled by hand: this is the hottest function in the module.
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? ox : i === 1 ? oy : oz;
    const d = i === 0 ? dx : i === 1 ? dy : dz;
    const h = i === 0 ? box.half.x : i === 1 ? box.half.y : box.half.z;
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    let s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (outNormal) {
    if (axis < 0) {
      // Origin started inside the box: report the reverse of the ray.
      outNormal.copy(dir).negate();
    } else {
      const ax = axis === 0 ? box.axX : axis === 1 ? box.axY : box.axZ;
      outNormal.copy(ax).multiplyScalar(sign);
    }
  }
  return tmin;
}

/** Ray against a sphere. Returns distance or -1. */
export function raySphere(origin, dir, centre, radius, maxDist, outNormal) {
  _a0.subVectors(centre, origin);
  const b = _a0.dot(dir);
  const c = _a0.lengthSq() - radius * radius;
  if (c > 0 && b < 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = b - sq;
  if (t < 0) t = b + sq;
  if (t < 0 || t > maxDist) return -1;
  if (outNormal) {
    outNormal.copy(origin).addScaledVector(dir, t).sub(centre);
    const l = outNormal.length();
    if (l > 1e-6) outNormal.multiplyScalar(1 / l); else outNormal.set(0, 1, 0);
  }
  return t;
}

/** Möller–Trumbore, double sided. Returns distance or -1. */
export function rayTriangle(origin, dir, v0, v1, v2, maxDist, outNormal) {
  _a0.subVectors(v1, v0);
  _a1.subVectors(v2, v0);
  _a2.crossVectors(dir, _a1);
  const det = _a0.dot(_a2);
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det;
  _a3.subVectors(origin, v0);
  const u = _a3.dot(_a2) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return -1;
  _a4.crossVectors(_a3, _a0);
  const v = dir.dot(_a4) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
  const t = _a1.dot(_a4) * inv;
  if (t < 0 || t > maxDist) return -1;
  if (outNormal) {
    outNormal.crossVectors(_a0, _a1).normalize();
    if (outNormal.dot(dir) > 0) outNormal.negate();
  }
  return t;
}

/** Ray against an axis-aligned box given as six numbers. Returns t or -1. */
export function rayAabb(ox, oy, oz, idx, idy, idz, minX, minY, minZ, maxX, maxY, maxZ, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  let t1 = (minX - ox) * idx;
  let t2 = (maxX - ox) * idx;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  t1 = (minY - oy) * idy;
  t2 = (maxY - oy) * idy;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  t1 = (minZ - oz) * idz;
  t2 = (maxZ - oz) * idz;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  return tmin;
}

/** Closest point on a triangle to p. Ericson, Real-Time Collision Detection. */
export function closestPointOnTriangle(p, a, b, c, out) {
  _a0.subVectors(b, a);
  _a1.subVectors(c, a);
  _a2.subVectors(p, a);
  const d1 = _a0.dot(_a2);
  const d2 = _a1.dot(_a2);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);

  _a3.subVectors(p, b);
  const d3 = _a0.dot(_a3);
  const d4 = _a1.dot(_a3);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.copy(a).addScaledVector(_a0, v);
  }

  _a4.subVectors(p, c);
  const d5 = _a0.dot(_a4);
  const d6 = _a1.dot(_a4);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.copy(a).addScaledVector(_a1, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(_a5.subVectors(c, b), w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return out.copy(a).addScaledVector(_a0, v).addScaledVector(_a1, w);
}

/* ==========================================================================
 * Contact policy — where the *feel* lives
 *
 * Every number below is a design decision, not a physical constant. They are
 * exported so core/Debug.js can put sliders on them and so a reviewer can find
 * the one line responsible for a shunt feeling wrong.
 * ========================================================================== */

export const CONTACT_TUNING = {
  /* --- car vs car: the signature Micro Machines moment ------------------- */
  // Restitution above the 0.32 a die-cast body would really have: an arcade
  // shunt needs to *pop*. Momentum is still conserved exactly — an impulse pair
  // is equal and opposite whatever its magnitude — this only adds energy.
  carCarRestitution: 0.52,
  carCarFriction: 0.36,
  // Extra separation impulse as a fraction of the solved normal impulse.
  // This is what turns a nudge into a shove.
  carCarShunt: 0.42,
  // Extra yaw applied to the struck car, and removed from the striker, so the
  // pair's total angular momentum about the contact point is unchanged.
  carCarSpin: 0.62,
  // Ceiling on both extras, in units of (mass * top speed), so a three-car
  // sandwich cannot compound into a launch.
  carCarImpulseCap: 0.55,
  // Seconds the shunt reads as "control loss" for fx, audio and the director.
  carCarShakeScale: 0.020,

  /* --- car vs wall: deflect, never stick --------------------------------- */
  carWallRestitution: 0.18,
  // Deliberately slippery. A high-friction wall grabs the car and kills the
  // lap; a barrier you can scrape along at 20 degrees is what a good arcade
  // racer feels like.
  carWallFriction: 0.11,
  // Speed scrubbed from the along-wall component, scaled by how square the
  // hit was. A graze costs almost nothing; a 60-degree hit costs real time.
  carWallScrub: 0.62,
  // Angular impulse that turns the nose parallel to the barrier. This is the
  // single term that stops a car burying itself in a wall at 100 u/s.
  carWallAlign: 0.55,

  /* --- car vs prop ------------------------------------------------------- */
  carPropRestitution: 0.30,
  carPropFriction: 0.45,
  // A prop lighter than this fraction of the car's mass is sent flying and
  // barely slows the car; heavier than this and the car loses the argument.
  carPropTopplePropRatio: 1.25,
  // Extra launch given to a toppled prop, on top of the solved impulse.
  carPropLaunch: 0.85,
  // Upward bias, so a clipped prop cartwheels instead of skidding.
  carPropLift: 0.30,

  /* --- everything else ---------------------------------------------------- */
  carGroundRestitution: 0.06,
  carGroundFriction: 0.85,
  propGroundFriction: 0.75,
  defaultRestitution: 0.25,
  defaultFriction: 0.55,

  /* --- event thresholds --------------------------------------------------- */
  eventImpulse: 1.2,          // below this, no contact event is emitted
  eventCooldown: 0.045,       // s between events for the same pair
  scrapeSpeed: 8,             // u/s of tangential slide that counts as a scrape
};

/**
 * Choose restitution, friction and the arcade response for a pair.
 * Writes into `mf` and returns the kind string.
 */
export function contactPolicy(A, B, mf) {
  const T = CONTACT_TUNING;
  const av = A.isVehicle;
  const bv = B.isVehicle;

  if (av && bv) {
    mf.restitution = T.carCarRestitution;
    mf.friction = T.carCarFriction;
    mf.kind = 'car-car';
    return mf.kind;
  }
  if (av || bv) {
    const other = av ? B : A;
    if (other.isWall) {
      mf.restitution = T.carWallRestitution;
      mf.friction = T.carWallFriction;
      mf.kind = 'car-wall';
      return mf.kind;
    }
    if (other.shape === SHAPE.HEIGHTFIELD || other.shape === SHAPE.MESH) {
      mf.restitution = T.carGroundRestitution;
      mf.friction = T.carGroundFriction;
      mf.kind = 'car-ground';
      return mf.kind;
    }
    mf.restitution = T.carPropRestitution;
    mf.friction = T.carPropFriction;
    mf.kind = 'car-prop';
    return mf.kind;
  }

  const ra = Number.isFinite(A.restitution) ? A.restitution : T.defaultRestitution;
  const rb = Number.isFinite(B.restitution) ? B.restitution : T.defaultRestitution;
  const fa = Number.isFinite(A.friction) ? A.friction : T.defaultFriction;
  const fb = Number.isFinite(B.friction) ? B.friction : T.defaultFriction;
  // Max on restitution (a superball stays bouncy on felt), geometric mean on
  // friction (the standard mixing rule, and the one that reads correctly).
  mf.restitution = Math.max(ra, rb);
  mf.friction = Math.sqrt(Math.max(0, fa) * Math.max(0, fb));
  const ground = A.shape === SHAPE.HEIGHTFIELD || B.shape === SHAPE.HEIGHTFIELD
    || A.shape === SHAPE.MESH || B.shape === SHAPE.MESH;
  if (ground) mf.friction = Math.max(mf.friction, T.propGroundFriction);
  mf.kind = ground ? 'prop-ground' : 'prop-prop';
  return mf.kind;
}

/* ==========================================================================
 * Solver — sequential impulses with split-impulse position correction
 * ========================================================================== */

/**
 * Build the constraint terms for a manifold. Must run once per tick after the
 * manifold has been rebuilt and before any velocity iteration.
 */
export function prepareManifold(mf, dt, speculativeOnly) {
  const A = mf.a;
  const B = mf.b;
  const n = mf.normal;
  orthoBasis(n, mf.tangent1, mf.tangent2);
  const invDt = dt > 1e-8 ? 1 / dt : 0;

  let worstApproach = 0;
  let worstTangent = 0;

  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    cp.rA.subVectors(cp.point, A.com);
    cp.rB.subVectors(cp.point, B.com);

    cp.normalMass = effectiveMass(A, B, cp.rA, cp.rB, n);
    cp.tangentMass1 = effectiveMass(A, B, cp.rA, cp.rB, mf.tangent1);
    cp.tangentMass2 = effectiveMass(A, B, cp.rA, cp.rB, mf.tangent2);

    // Relative velocity at the contact, B relative to A.
    pointVelocity(B, cp.rB, _a6);
    pointVelocity(A, cp.rA, _a7);
    _a8.subVectors(_a6, _a7);
    const vn = _a8.dot(n);
    const vt = Math.hypot(_a8.dot(mf.tangent1), _a8.dot(mf.tangent2));
    if (vn < worstApproach) worstApproach = vn;
    if (vt > worstTangent) worstTangent = vt;

    // The constraint drives the normal velocity to `velocityBias`.
    //
    // Speculative case (separation > 0): the pair is still apart, so the most
    // it may close is exactly the gap, i.e. vn >= -separation/dt. Setting the
    // target to that value is what makes tunnelling impossible — a body doing
    // 112 u/s at a 2.4 u wall is stopped on the tick it would have crossed,
    // no matter how thin the wall is.
    //
    // Touching case (separation <= 0): the ordinary restitution target,
    // vn' = -e * vn, suppressed below RESTITUTION_FLOOR so resting contacts
    // do not buzz.
    let bias = 0;
    if (cp.separation > 0) {
      bias = -cp.separation * invDt;
    } else if (!speculativeOnly && vn < -RESTITUTION_FLOOR) {
      bias = -mf.restitution * vn;
    }
    cp.velocityBias = bias;
  }

  mf.approachSpeed = -worstApproach;
  mf.tangentSpeed = worstTangent;
  return mf;
}

/** 1 / (n^T K n) for a contact between two proxies. */
export function effectiveMass(A, B, rA, rB, dir) {
  let k = A.invMass + B.invMass;
  if (A.invMass > 0 || A.invI.x > 0 || A.invI.y > 0 || A.invI.z > 0) {
    _a0.crossVectors(rA, dir);
    applyInvInertia(A, _a0, _a1);
    _a2.crossVectors(_a1, rA);
    k += _a2.dot(dir);
  }
  if (B.invMass > 0 || B.invI.x > 0 || B.invI.y > 0 || B.invI.z > 0) {
    _a0.crossVectors(rB, dir);
    applyInvInertia(B, _a0, _a1);
    _a2.crossVectors(_a1, rB);
    k += _a2.dot(dir);
  }
  return k > 1e-9 ? 1 / k : 0;
}

/** Apply an impulse pair at a contact: -P to A, +P to B. */
export function applyImpulsePair(A, B, rA, rB, dirX, dirY, dirZ) {
  if (A.invMass > 0) {
    A.velocity.x -= dirX * A.invMass;
    A.velocity.y -= dirY * A.invMass;
    A.velocity.z -= dirZ * A.invMass;
  }
  if (B.invMass > 0) {
    B.velocity.x += dirX * B.invMass;
    B.velocity.y += dirY * B.invMass;
    B.velocity.z += dirZ * B.invMass;
  }
  _a0.set(dirX, dirY, dirZ);
  if (A.invI.x > 0 || A.invI.y > 0 || A.invI.z > 0) {
    _a1.crossVectors(rA, _a0);
    applyInvInertia(A, _a1, _a2);
    A.angularVelocity.sub(_a2);
  }
  if (B.invI.x > 0 || B.invI.y > 0 || B.invI.z > 0) {
    _a1.crossVectors(rB, _a0);
    applyInvInertia(B, _a1, _a2);
    B.angularVelocity.add(_a2);
  }
}

/** Re-apply last tick's accumulated impulses. Cheap, and it stabilises stacks. */
export function warmStart(mf) {
  const A = mf.a;
  const B = mf.b;
  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    if (!cp.matched) continue;
    const x = mf.normal.x * cp.normalImpulse + mf.tangent1.x * cp.tangentImpulse1 + mf.tangent2.x * cp.tangentImpulse2;
    const y = mf.normal.y * cp.normalImpulse + mf.tangent1.y * cp.tangentImpulse1 + mf.tangent2.y * cp.tangentImpulse2;
    const z = mf.normal.z * cp.normalImpulse + mf.tangent1.z * cp.tangentImpulse1 + mf.tangent2.z * cp.tangentImpulse2;
    applyImpulsePair(A, B, cp.rA, cp.rB, x, y, z);
  }
}

/** One relaxation iteration of the velocity constraints. */
export function solveVelocity(mf) {
  const A = mf.a;
  const B = mf.b;
  const n = mf.normal;

  // Friction first, against the previous iteration's normal impulse. Solving in
  // this order is what stops a braking car from creeping through a wall on the
  // first iteration, when the normal impulse is still zero.
  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    const limit = mf.friction * cp.normalImpulse;
    if (limit <= 0) { cp.tangentImpulse1 = 0; cp.tangentImpulse2 = 0; continue; }

    pointVelocity(B, cp.rB, _a6);
    pointVelocity(A, cp.rA, _a7);
    _a8.subVectors(_a6, _a7);

    let l1 = -_a8.dot(mf.tangent1) * cp.tangentMass1;
    let l2 = -_a8.dot(mf.tangent2) * cp.tangentMass2;
    let n1 = cp.tangentImpulse1 + l1;
    let n2 = cp.tangentImpulse2 + l2;
    const mag = Math.hypot(n1, n2);
    if (mag > limit && mag > 1e-9) {
      const s = limit / mag;
      n1 *= s;
      n2 *= s;
    }
    l1 = n1 - cp.tangentImpulse1;
    l2 = n2 - cp.tangentImpulse2;
    cp.tangentImpulse1 = n1;
    cp.tangentImpulse2 = n2;
    applyImpulsePair(
      A, B, cp.rA, cp.rB,
      mf.tangent1.x * l1 + mf.tangent2.x * l2,
      mf.tangent1.y * l1 + mf.tangent2.y * l2,
      mf.tangent1.z * l1 + mf.tangent2.z * l2
    );
  }

  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    pointVelocity(B, cp.rB, _a6);
    pointVelocity(A, cp.rA, _a7);
    _a8.subVectors(_a6, _a7);
    const vn = _a8.dot(n);

    let lambda = -(vn - cp.velocityBias) * cp.normalMass;
    const old = cp.normalImpulse;
    // Accumulated clamp: the *total* impulse must stay repulsive, not each
    // increment. Without this a resting contact oscillates.
    cp.normalImpulse = Math.max(0, old + lambda);
    lambda = cp.normalImpulse - old;
    if (lambda === 0) continue;
    applyImpulsePair(A, B, cp.rA, cp.rB, n.x * lambda, n.y * lambda, n.z * lambda);
  }
}

/**
 * One iteration of the position constraint, using pseudo-velocities.
 *
 * A split impulse: penetration is removed by a separate velocity channel that
 * is integrated into position and then discarded, so pushing bodies apart never
 * injects energy into the real velocity. That is the difference between a car
 * resting against a barrier and a car slowly climbing it.
 */
export function solvePosition(mf) {
  const A = mf.a;
  const B = mf.b;
  const n = mf.normal;
  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    const err = -cp.separation - SLOP;
    if (err <= 0) continue;

    _a6.crossVectors(B.pseudoW, cp.rB).add(B.pseudoV);
    _a7.crossVectors(A.pseudoW, cp.rA).add(A.pseudoV);
    _a8.subVectors(_a6, _a7);
    const vn = _a8.dot(n);

    let lambda = (BAUMGARTE * err - vn) * cp.normalMass;
    const old = cp.pseudoImpulse;
    cp.pseudoImpulse = Math.max(0, old + lambda);
    lambda = cp.pseudoImpulse - old;
    if (lambda === 0) continue;

    const x = n.x * lambda;
    const y = n.y * lambda;
    const z = n.z * lambda;
    if (A.invMass > 0) {
      A.pseudoV.x -= x * A.invMass;
      A.pseudoV.y -= y * A.invMass;
      A.pseudoV.z -= z * A.invMass;
      _a0.set(x, y, z);
      _a1.crossVectors(cp.rA, _a0);
      applyInvInertia(A, _a1, _a2);
      A.pseudoW.sub(_a2);
    }
    if (B.invMass > 0) {
      B.pseudoV.x += x * B.invMass;
      B.pseudoV.y += y * B.invMass;
      B.pseudoV.z += z * B.invMass;
      _a0.set(x, y, z);
      _a1.crossVectors(cp.rB, _a0);
      applyInvInertia(B, _a1, _a2);
      B.pseudoW.add(_a2);
    }
  }
}

/** Sum of the normal impulses across a manifold. */
export function manifoldImpulse(mf) {
  let sum = 0;
  for (let i = 0; i < mf.count; i++) sum += mf.points[i].normalImpulse;
  return sum;
}

/** Contact centroid, written into `out`. */
export function manifoldCentroid(mf, out) {
  out.set(0, 0, 0);
  if (!mf.count) return out;
  for (let i = 0; i < mf.count; i++) out.add(mf.points[i].point);
  return out.multiplyScalar(1 / mf.count);
}

/* ==========================================================================
 * Arcade response — applied once per manifold, after the velocity iterations
 * ========================================================================== */

/**
 * Car against car.
 *
 * Three things happen on top of the ordinary contact solve, and all three are
 * equal-and-opposite impulse pairs applied at the shared contact point, so
 * linear and angular momentum are both conserved exactly:
 *
 *  1. a separation bonus along the normal — the shove;
 *  2. a yaw transfer — the struck car is spun, the striker is counter-spun by
 *     the same angular momentum, which is what "spin transfer" means;
 *  3. nothing else. The control loss the brief asks for is not scripted: it is
 *     the yaw the car is left carrying, which the driver must correct and
 *     which Vehicle.js's own yaw assist will bleed off over ~0.4 s. That makes
 *     it brief, recoverable, and impossible to desync from the physics.
 */
export function applyCarCarResponse(mf, dt) {
  const T = CONTACT_TUNING;
  const A = mf.a;
  const B = mf.b;
  const jn = manifoldImpulse(mf);
  if (jn <= 1e-4) return 0;

  manifoldCentroid(mf, _n1);
  _a3.subVectors(_n1, A.com);
  _a4.subVectors(_n1, B.com);

  const cap = T.carCarImpulseCap * Math.max(A.mass, B.mass) * Math.max(40, A.topSpeed || 100);
  const shove = Math.min(jn * T.carCarShunt, cap);
  if (shove > 0) {
    applyImpulsePair(A, B, _a3, _a4, mf.normal.x * shove, mf.normal.y * shove, mf.normal.z * shove);
  }

  // Yaw transfer. The natural torque from an off-centre hit is r x (n * J);
  // we take its vertical component and amplify it, giving +L to the struck car
  // and -L to the striker so the pair's total angular momentum is unchanged.
  _a5.set(mf.normal.x * jn, mf.normal.y * jn, mf.normal.z * jn);
  _a6.crossVectors(_a4, _a5);
  const up = B.axY.y >= 0 ? 1 : -1;
  const yaw = clamp(_a6.y * T.carCarSpin, -cap * 4, cap * 4) * up;
  if (Math.abs(yaw) > 1e-5) {
    _a7.set(0, yaw, 0);
    applyInvInertia(B, _a7, _a8);
    B.angularVelocity.add(_a8);
    applyInvInertia(A, _a7, _a8);
    A.angularVelocity.sub(_a8);
  }

  const shunt = saturate(jn / Math.max(1e-3, 26 * Math.max(A.mass, B.mass)));
  markShunt(A, shunt, dt);
  markShunt(B, shunt, dt);
  return jn + shove;
}

/** Publish a decaying 0..1 "I just got hit" channel for fx, audio and camera. */
function markShunt(p, amount, dt) {
  const v = p.body && p.body.vehicle;
  if (!v) return;
  v.shunt = Math.max(v.shunt || 0, amount);
  v.shuntTime = 0;
  void dt;
}

/**
 * Car against a barrier: scrub speed and turn along the wall.
 *
 * The normal impulse has already killed the inward velocity. What is left is
 * the along-wall component, and the two things that separate a good arcade
 * wall from a bad one are (a) it costs speed in proportion to how square the
 * hit was, and (b) it rotates the car parallel instead of letting it plough in
 * nose-first. Both are applied here, both capped, and both scale to zero for a
 * glancing touch so a racing line that kisses the barrier is not punished.
 */
export function applyCarWallResponse(mf, dt) {
  const T = CONTACT_TUNING;
  const car = mf.a.isVehicle ? mf.a : mf.b;
  const wallIsB = mf.a.isVehicle;
  const jn = manifoldImpulse(mf);
  if (jn <= 1e-4) return 0;

  // Outward wall normal, pointing at the car.
  _n1.copy(mf.normal);
  if (wallIsB) _n1.negate();

  const v = car.velocity;
  const vn = v.dot(_n1);
  _a3.copy(v).addScaledVector(_n1, -vn);
  const along = _a3.length();
  if (along > 1e-3) {
    // Incidence: 0 for a graze, 1 for a head-on hit.
    const speed = Math.max(1e-3, v.length());
    const incidence = saturate(Math.abs(vn) / speed);
    const scrub = saturate(T.carWallScrub * incidence * saturate(jn / Math.max(1e-3, car.mass * 22)));
    if (scrub > 0) v.addScaledVector(_a3, -scrub / along * Math.min(along, speed));
  }

  // Align the nose with the barrier. The target is whichever of +forward or
  // -forward is closer to the wall tangent, so reversing into a wall aligns the
  // same way rather than spinning the car 180 degrees.
  _a4.copy(car.axZ).addScaledVector(_n1, -car.axZ.dot(_n1));
  if (_a4.lengthSq() > 1e-6) {
    _a4.normalize();
    _a5.copy(car.velocity);
    _a5.y = 0;
    if (_a5.lengthSq() > 4 && _a5.dot(_a4) < 0) _a4.negate();
    _a6.crossVectors(car.axZ, _a4);
    const sin = _a6.y;
    const gain = T.carWallAlign * saturate(jn / Math.max(1e-3, car.mass * 16));
    const target = sin * gain * 26;
    // Blend rather than set: this must read as the wall guiding the car, not
    // as the game taking the wheel.
    car.angularVelocity.y += (target - car.angularVelocity.y) * saturate(gain * 0.8);
  }

  markShunt(car, saturate(jn / Math.max(1e-3, 34 * car.mass)) * 0.7, dt);
  return jn;
}

/**
 * Car against a prop.
 *
 * `topple` is decided by the mass ratio in World.js. A toppled prop gets a
 * launch bonus with an upward bias so it cartwheels; the car keeps almost all
 * of its momentum, because a 0.05-mass sugar cube must not slow a 1.0-mass car
 * in any perceptible way. A prop too heavy to move is just a wall.
 */
export function applyCarPropResponse(mf, dt) {
  const T = CONTACT_TUNING;
  const car = mf.a.isVehicle ? mf.a : mf.b;
  const prop = mf.a.isVehicle ? mf.b : mf.a;
  const jn = manifoldImpulse(mf);
  if (jn <= 1e-4) return 0;

  if (prop.invMass > 0) {
    manifoldCentroid(mf, _n1);
    // Car -> prop, plus lift so a clipped prop cartwheels instead of skidding.
    _a3.copy(mf.normal);
    if (!mf.a.isVehicle) _a3.negate();
    _a3.y += T.carPropLift;
    if (_a3.lengthSq() < 1e-8) _a3.set(0, 1, 0);
    _a3.normalize();

    const launch = jn * T.carPropLaunch;
    prop.velocity.addScaledVector(_a3, launch * prop.invMass);
    _a4.subVectors(_n1, prop.com);
    _a5.crossVectors(_a4, _a3).multiplyScalar(launch);
    applyInvInertia(prop, _a5, _a6);
    prop.angularVelocity.add(_a6);
    prop.sleeping = false;
    prop.sleepTimer = 0;
  }

  markShunt(car, saturate(jn / Math.max(1e-3, 30 * car.mass)) * 0.55, dt);
  return jn;
}

/* ==========================================================================
 * Warm-start matching
 * ========================================================================== */

/** Squared distance under which a rebuilt contact inherits its old impulses. */
export const WARM_TOLERANCE_SQ = 2.25;

/**
 * Copy accumulated impulses from the previous tick's manifold onto a freshly
 * built one, matching points by proximity. Feature ids would be exact, but at
 * 120 Hz a contact moves less than a millimetre between ticks and proximity is
 * both simpler and immune to the id churn that box clipping produces.
 */
export function transferImpulses(prevPoints, prevCount, mf) {
  for (let i = 0; i < mf.count; i++) {
    const cp = mf.points[i];
    for (let j = 0; j < prevCount; j++) {
      const old = prevPoints[j];
      if (cp.point.distanceToSquared(old.point) > WARM_TOLERANCE_SQ) continue;
      cp.normalImpulse = old.normalImpulse;
      cp.tangentImpulse1 = old.tangentImpulse1;
      cp.tangentImpulse2 = old.tangentImpulse2;
      cp.matched = true;
      break;
    }
  }
  return mf;
}

/* ==========================================================================
 * Dispatch
 * ========================================================================== */

/**
 * Build a manifold for a convex pair. Heightfield and mesh contacts are
 * generated by World.js, which owns the sampling strategy for them.
 * @returns {boolean} true when at least one contact point was produced.
 */
export function collide(A, B, mf, margin) {
  mf.reset(A, B);
  const sa = A.shape;
  const sb = B.shape;
  let hit = false;

  if (sa === SHAPE.SPHERE && sb === SHAPE.SPHERE) {
    hit = sphereSphere(A, B, mf, margin);
  } else if (sa === SHAPE.SPHERE) {
    hit = boxSphere(B, A, mf, margin, true);      // normal comes out B -> A, flip
  } else if (sb === SHAPE.SPHERE) {
    hit = boxSphere(A, B, mf, margin, false);
  } else {
    hit = boxBox(A, B, mf, margin);
    if (hit) {
      // Cylinders travel as boxes and are rounded off afterwards. Only one of
      // the pair may claim the normal; the deeper-radius one wins, which for a
      // car against a paint tin is always the tin.
      if (A.roundXZ && (!B.roundXZ || A.radius <= B.radius)) roundCylinder(mf, A, true);
      else if (B.roundXZ) roundCylinder(mf, B, false);
    }
  }
  if (hit) {
    mf.a = A;
    mf.b = B;
    contactPolicy(A, B, mf);
  }
  return hit;
}

export default {
  SHAPE,
  Manifold,
  ContactPoint,
  CONTACT_TUNING,
  collide,
  boxBox,
  boxSphere,
  sphereSphere,
  rayBox,
  raySphere,
  rayTriangle,
  rayAabb,
  closestPointOnBox,
  closestPointOnTriangle,
  prepareManifold,
  warmStart,
  solveVelocity,
  solvePosition,
  applyCarCarResponse,
  applyCarWallResponse,
  applyCarPropResponse,
  transferImpulses,
  refreshAxes,
  applyInvInertia,
  pointVelocity,
  manifoldImpulse,
  manifoldCentroid,
};
