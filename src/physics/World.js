// physics/World.js — broadphase, contact resolution, raycasts.
//
// The world is deliberately *not* a general rigid-body engine. It is exactly
// the solver this game needs and nothing more:
//
//   * Cars are simulated by vehicle/Vehicle.js, which owns their integration.
//     This module only ever writes impulses into their velocity and angular
//     velocity — which are the same THREE objects the vehicle integrates, so
//     there is no copy step and no state to desynchronise — plus positional
//     corrections for penetration.
//   * Props are simulated here, in full, with a real inertia tensor, so a
//     knocked cereal box tumbles instead of sliding.
//   * Track walls and the track height field are static geometry raised
//     directly from the data world/TrackBuilder.js publishes.
//
// ------------------------------------------------------------------- ordering
//
// main.js registers this system BEFORE the vehicles, so one tick reads:
//
//   physics.fixedUpdate   detect against last tick's transforms, solve, write
//                         impulses into vehicle velocities
//   driver.update         AI reads the settled state
//   vehicle.fixedUpdate   consumes deferred impulses, integrates
//
// That "detect, then respond, then integrate" order is what makes the shunt
// land on the same frame the cars touched.
//
// ---------------------------------------------------------------- no tunnelling
//
// Two independent mechanisms, either of which is sufficient:
//
//   1. Speculative contacts (see Collision.prepareManifold). Contacts are
//      generated before the surfaces touch, carrying a positive separation, and
//      the solver caps the closing speed at separation/dt. A body physically
//      cannot travel further than the gap it was given. This is the primary
//      mechanism and it holds at any speed against any thickness.
//   2. A segment sweep of every car's centre of mass from its previous position
//      to its current one against static geometry, which catches the one case
//      speculation cannot: a pair the broadphase never produced.
//
// At the shipped 120 Hz a 112 u/s car moves 0.93 u per tick against a 2.4 u
// barrier, so there is a wide margin before either mechanism is even stressed.

import * as THREE from 'three';
import { clamp, saturate } from '../core/Random.js';
import { Settings } from '../core/Settings.js';
import {
  SHAPE,
  Manifold,
  ContactPoint,
  CONTACT_TUNING,
  collide,
  rayBox,
  raySphere,
  rayTriangle,
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
  manifoldImpulse,
  manifoldCentroid,
} from './Collision.js';

/* ==========================================================================
 * Tuning
 * ========================================================================== */

/** Broadphase cell, in world units. Slightly wider than a car is long (9 u),
 *  which keeps a car in one or two cells and a wall segment in exactly one. */
const CELL = 26;
const INV_CELL = 1 / CELL;
const TABLE = 1 << 13;
const TABLE_MASK = TABLE - 1;

/** Contact skin: contacts are generated this far before the surfaces meet. */
const SKIN = 0.28;
/** Ceiling on the speculative margin, so a mad dt cannot blow the pair count. */
const MAX_MARGIN = 6;
/** Largest positional correction applied in one tick, per body. */
const MAX_CORRECTION = 5;
/** Largest rotational correction applied in one tick, in radians. */
const MAX_SPIN_CORRECTION = 0.25;

const PROP_LINEAR_DAMP = 0.55;
const PROP_ANGULAR_DAMP = 0.9;
const SLEEP_LINEAR = 2.2;      // u/s
const SLEEP_ANGULAR = 0.9;     // rad/s
const SLEEP_TIME = 0.5;        // s below both thresholds before sleeping

const MAX_PAIRS = 4096;
const RAY_CELL_LIMIT = 512;

/* ==========================================================================
 * Module scratch
 * ========================================================================== */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _scaleOne = new THREE.Vector3(1, 1, 1);

// Corner offsets of a unit box, used for height-field sampling.
const CORNER = [
  [-1, -1, -1], [1, -1, -1], [-1, -1, 1], [1, -1, 1],
  [-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1],
];

// Warm-start snapshot of the previous tick's contact points.
const _oldPoints = [];
for (let i = 0; i < 4; i++) _oldPoints.push(new ContactPoint());

const _filter = {
  exclude: null,
  excludeB: null,
  predicate: null,
  layers: 0xffffffff,
  staticOnly: false,
  skipTerrain: false,
  skipVehicles: false,
};

/* ==========================================================================
 * Hash grid
 *
 * Unbounded by construction: cells are hashed rather than indexed off a fixed
 * origin, so a track that spills past the nominal 460 x 340 playfield costs
 * nothing and cannot fall out of the world.
 * ========================================================================== */

function cellHash(ix, iz) {
  return (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) & TABLE_MASK;
}

class HashGrid {
  constructor(capacity = 4096) {
    this.head = new Int32Array(TABLE).fill(-1);
    this.next = new Int32Array(capacity);
    this.item = new Int32Array(capacity);
    this.count = 0;
    this.overflow = false;
  }

  clear() {
    this.head.fill(-1);
    this.count = 0;
    this.overflow = false;
  }

  _grow() {
    const cap = this.next.length * 2;
    const n = new Int32Array(cap);
    const it = new Int32Array(cap);
    n.set(this.next);
    it.set(this.item);
    this.next = n;
    this.item = it;
  }

  /** Insert one body index under every cell its XZ footprint touches. */
  insert(index, minX, minZ, maxX, maxZ) {
    let x0 = Math.floor(minX * INV_CELL);
    let x1 = Math.floor(maxX * INV_CELL);
    let z0 = Math.floor(minZ * INV_CELL);
    let z1 = Math.floor(maxZ * INV_CELL);
    // A body spanning an absurd number of cells is a data error, not a reason
    // to spend a millisecond in the broadphase.
    if (x1 - x0 > 63) x1 = x0 + 63;
    if (z1 - z0 > 63) z1 = z0 + 63;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        if (this.count >= this.next.length) this._grow();
        const h = cellHash(ix, iz);
        const slot = this.count++;
        this.item[slot] = index;
        this.next[slot] = this.head[h];
        this.head[h] = slot;
      }
    }
  }
}

/* ==========================================================================
 * Ray hit
 * ========================================================================== */

class RayHit {
  constructor(world) {
    this._world = world;
    this.hit = false;
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.distance = Infinity;
    this.body = null;
    this.proxy = null;
    this.isTerrain = false;
    this._surface = null;
  }

  reset() {
    this.hit = false;
    this.distance = Infinity;
    this.body = null;
    this.proxy = null;
    this.isTerrain = false;
    this._surface = null;
    return this;
  }

  /**
   * Named surface under the hit. Resolved lazily, because the terrain answer
   * costs a spline projection and most callers (the suspension, notably) only
   * read it when the physics hit beat the track's own height query.
   */
  get surface() {
    if (this._surface === null) {
      this._surface = this._world ? this._world._surfaceForHit(this) : 'concrete';
    }
    return this._surface;
  }

  set surface(v) { this._surface = v; }
}

/* ==========================================================================
 * Contact event payload, pooled
 * ========================================================================== */

class ContactEvent {
  constructor() {
    this.a = null;
    this.b = null;
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.impulse = 0;
    this.relativeSpeed = 0;
    this.tangentSpeed = 0;
    this.kind = 'hit';
    this.surface = 'concrete';
    this.vehicleA = null;
    this.vehicleB = null;
  }
}

/* ==========================================================================
 * PhysicsWorld
 * ========================================================================== */

let _proxySerial = 0;

export class PhysicsWorld {
  name = 'physics';

  constructor(ctx = {}) {
    this.ctx = ctx;

    /** @type {object[]} internal proxies, index-stable while a body lives */
    this.proxies = [];
    this._byBody = new Map();
    this._free = [];

    this._staticGrid = new HashGrid(4096);
    this._dynGrid = new HashGrid(1024);
    this._staticDirty = true;
    /** Bodies too large for the grid (mesh soups, the height field). */
    this._oversized = [];

    this._manifolds = new Map();
    this._pairA = new Int32Array(MAX_PAIRS);
    this._pairB = new Int32Array(MAX_PAIRS);
    this._pairCount = 0;

    this._hits = [];
    for (let i = 0; i < 16; i++) this._hits.push(new RayHit(this));
    this._hitCursor = 0;

    this._events = [];
    for (let i = 0; i < 12; i++) this._events.push(new ContactEvent());
    this._eventCursor = 0;
    this._listeners = [];

    this._tick = 0;
    this._stamp = 1;
    this._rayStamp = 1;

    this.track = null;
    this._wallBodies = [];
    this._terrain = null;
    this._wallsBuilt = false;
    this._wallCheckTimer = 0;
    this._handedOverWalls = [];

    // Running sum of the ground normals sampled under one body, so a terrain
    // manifold gets a normal that follows the banking instead of pointing
    // straight up. Must exist before the first _terrainPoint().
    this._terrainNormalSum = new THREE.Vector3();
    /** Triangle visit stamps for mesh colliders, shared by contacts and rays. */
    this._meshSeen = new Map();

    this._propModels = null;
    this._loadPropModels();

    this.stats = {
      bodies: 0, vehicles: 0, props: 0, statics: 0,
      pairs: 0, manifolds: 0, contacts: 0, awake: 0, events: 0,
      solveMs: 0,
    };

    this.enabled = true;
  }

  async init() {
    this._syncTrack();
    return this;
  }

  /* ======================================================================
   * Bodies
   * ====================================================================== */

  /**
   * Register a collider.
   *
   * Accepts the two body shapes the game already produces — vehicle/Vehicle.js
   * publishes `{ type:'box', isVehicle, halfExtents, centreOffsetY, ... }` and
   * world/Props.js publishes `{ type:'prop', shape, halfExtents, centreOffset,
   * radius, height, ... }` — plus anything else that carries a position, an
   * orientation and one of the supported shape names.
   *
   * @returns {object} the body, so a caller can chain; never throws.
   */
  addBody(body) {
    if (!body || typeof body !== 'object') return body;
    if (this._byBody.has(body)) return body;
    let p = null;
    try {
      p = this._makeProxy(body);
    } catch (err) {
      console.warn('[Physics] rejecting a malformed body', err);
      return body;
    }
    if (!p) return body;

    const slot = this._free.length ? this._free.pop() : this.proxies.length;
    p.index = slot;
    this.proxies[slot] = p;
    this._byBody.set(body, p);
    if (p.isStatic) this._staticDirty = true;
    if (p.oversized) this._oversized.push(slot);
    this._countBodies();

    // The vehicle publishes a soft barrier constraint of its own and documents
    // `tuning.wallContain = 0` as the handshake for giving it up. Once real
    // wall colliders exist we take the job.
    if (p.isVehicle && this._wallsBuilt) this._takeOverWallContainment(p);
    return body;
  }

  /** Unregister a collider. Safe to call for a body that was never added. */
  removeBody(body) {
    const p = body && this._byBody.get(body);
    if (!p) return false;
    this._byBody.delete(body);
    this.proxies[p.index] = null;
    this._free.push(p.index);
    const o = this._oversized.indexOf(p.index);
    if (o >= 0) this._oversized.splice(o, 1);
    if (p.isStatic) this._staticDirty = true;
    // Drop every manifold that referenced it, or the solver would dereference
    // a dead proxy next tick.
    for (const [key, mf] of this._manifolds) {
      if (mf.a === p || mf.b === p) this._manifolds.delete(key);
    }
    this._countBodies();
    return true;
  }

  hasBody(body) { return this._byBody.has(body); }

  /** Wake a sleeping body (props only; vehicles never sleep). */
  wake(body) {
    const p = this._byBody.get(body);
    if (p) { p.sleeping = false; p.sleepTimer = 0; }
    return this;
  }

  /**
   * Subscribe to contacts.
   * cb({ a, b, point, normal, impulse, relativeSpeed, tangentSpeed, kind })
   * @returns {function} unsubscribe
   */
  onContact(cb) {
    if (typeof cb !== 'function') return () => {};
    this._listeners.push(cb);
    return () => {
      const i = this._listeners.indexOf(cb);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  _countBodies() {
    let n = 0; let v = 0; let pr = 0; let st = 0;
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p) continue;
      n++;
      if (p.isVehicle) v++;
      else if (p.isStatic) st++;
      else pr++;
    }
    this.stats.bodies = n;
    this.stats.vehicles = v;
    this.stats.props = pr;
    this.stats.statics = st;
  }

  /* ---------------------------------------------------------------- proxies */

  _makeProxy(body) {
    const shapeName = String(body.shape || body.type || 'box').toLowerCase();
    let shape = SHAPE.BOX;
    let roundXZ = false;
    if (shapeName === 'sphere' || shapeName === 'ball') shape = SHAPE.SPHERE;
    else if (shapeName === 'cylinder' || shapeName === 'capsule' || shapeName === 'tube') roundXZ = true;
    else if (shapeName === 'heightfield' || shapeName === 'terrain') shape = SHAPE.HEIGHTFIELD;
    else if (shapeName === 'mesh' || shapeName === 'trimesh') shape = SHAPE.MESH;

    const isVehicle = !!(body.isVehicle || body.vehicle);
    const half = new THREE.Vector3(1, 1, 1);
    let radius = Number.isFinite(body.radius) ? body.radius : 1;

    if (shape === SHAPE.SPHERE) {
      if (!Number.isFinite(body.radius) && body.halfExtents) {
        radius = Math.max(body.halfExtents.x, body.halfExtents.y, body.halfExtents.z);
      }
      half.set(radius, radius, radius);
    } else if (roundXZ) {
      // A cylinder travels as the box that circumscribes it; Collision.js
      // rounds the manifold off afterwards. See roundCylinder().
      const h = Number.isFinite(body.height) ? body.height
        : body.halfExtents ? body.halfExtents.y * 2 : radius * 2;
      if (!Number.isFinite(body.radius) && body.halfExtents) {
        radius = Math.max(body.halfExtents.x, body.halfExtents.z);
      }
      half.set(radius, Math.max(0.05, h * 0.5), radius);
    } else if (body.halfExtents) {
      half.copy(body.halfExtents);
    } else if (body.size) {
      half.set(body.size.x * 0.5, body.size.y * 0.5, body.size.z * 0.5);
    }
    half.x = Math.max(0.02, Math.abs(half.x));
    half.y = Math.max(0.02, Math.abs(half.y));
    half.z = Math.max(0.02, Math.abs(half.z));

    const mass = Number.isFinite(body.mass) ? body.mass : (isVehicle ? 1 : 0);
    const isStatic = body.static === true || !(mass > 0)
      || shape === SHAPE.HEIGHTFIELD || shape === SHAPE.MESH;

    const p = {
      id: _proxySerial++,
      index: -1,
      body,
      shape,
      roundXZ,
      isVehicle,
      isWall: !!body.isWall,
      isStatic,
      oversized: shape === SHAPE.HEIGHTFIELD || shape === SHAPE.MESH,
      layer: Number.isFinite(body.layer) ? body.layer : 0xffffffff,

      centre: new THREE.Vector3(),
      com: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      axX: new THREE.Vector3(1, 0, 0),
      axY: new THREE.Vector3(0, 1, 0),
      axZ: new THREE.Vector3(0, 0, 1),
      half,
      radius,
      centreOffset: new THREE.Vector3(),
      boundRadius: half.length(),

      mass: isStatic ? 0 : mass,
      invMass: isStatic ? 0 : 1 / Math.max(1e-4, mass),
      invI: new THREE.Vector3(),
      velocity: isVehicle && body.velocity ? body.velocity : new THREE.Vector3(),
      angularVelocity: isVehicle && body.angularVelocity ? body.angularVelocity : new THREE.Vector3(),
      pseudoV: new THREE.Vector3(),
      pseudoW: new THREE.Vector3(),
      prevPos: new THREE.Vector3(),

      restitution: Number.isFinite(body.restitution) ? body.restitution : CONTACT_TUNING.defaultRestitution,
      friction: Number.isFinite(body.friction) ? body.friction : CONTACT_TUNING.defaultFriction,
      surface: typeof body.surface === 'string' ? body.surface : null,
      topSpeed: isVehicle ? (body.vehicle?.topSpeed ?? 100) : 0,

      // Last `Vehicle.teleportStamp` this proxy has seen; -1 so the first tick
      // after registration always counts as a teleport and seeds prevPos.
      teleportStamp: -1,

      sleeping: !isVehicle && !isStatic,
      sleepTimer: 0,
      stamp: 0,
      rayStamp: 0,

      minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,

      // Static props that a car ought to be able to knock over are promoted to
      // dynamic the first time one is actually hit — see _tryPromote().
      promotable: false,
      promoted: false,
      visual: null,
      mesh: null,
    };

    if (body.centreOffset && Number.isFinite(body.centreOffset.y)) {
      p.centreOffset.copy(body.centreOffset);
    } else if (isVehicle && Number.isFinite(body.centreOffsetY)) {
      // Vehicle.js publishes centreOffsetY = cgHeight - bodyHeight/2, i.e. how
      // far the CENTRE OF MASS sits BELOW the chassis box's geometric centre.
      // The box centre is therefore the CoM minus that offset.
      p.centreOffset.set(0, -body.centreOffsetY, 0);
    }

    if (shape === SHAPE.MESH) this._buildMeshData(p, body);
    if (!isStatic) this._deriveInertia(p);
    if (isStatic && !isVehicle && !p.isWall && shape === SHAPE.BOX) p.promotable = true;
    if (roundXZ && isStatic) p.promotable = true;

    this._refreshProxy(p, 0);
    p.prevPos.copy(p.com);
    if (!isStatic && !isVehicle) this._bindPropVisual(p);
    return p;
  }

  /** Diagonal inverse inertia in local axes. */
  _deriveInertia(p) {
    const v = p.body.vehicle;
    if (p.isVehicle && v && v._invInertia && Number.isFinite(v._invInertia.x)) {
      // Use the car's own tensor so spin transfer agrees exactly with the way
      // Vehicle.js integrates rotation. Anything else and a shunt would spin
      // the car by a different amount than its own dynamics expect.
      p.invI.copy(v._invInertia);
      return p;
    }
    const m = Math.max(1e-4, p.mass);
    let ix; let iy; let iz;
    if (p.shape === SHAPE.SPHERE) {
      const i = 0.4 * m * p.radius * p.radius;
      ix = iy = iz = i;
    } else {
      const x = p.half.x * 2;
      const y = p.half.y * 2;
      const z = p.half.z * 2;
      ix = (m / 12) * (y * y + z * z);
      iy = (m / 12) * (x * x + z * z);
      iz = (m / 12) * (x * x + y * y);
    }
    p.invI.set(1 / Math.max(1e-6, ix), 1 / Math.max(1e-6, iy), 1 / Math.max(1e-6, iz));
    return p;
  }

  /** Refresh a proxy's world transform, bounds and (for cars) live mass. */
  _refreshProxy(p, dt) {
    const body = p.body;
    if (body.quaternion) p.quat.copy(body.quaternion);
    refreshAxes(p);

    if (p.shape === SHAPE.HEIGHTFIELD) return p;

    if (body.position) p.com.copy(body.position);
    if (p.isVehicle) {
      // body.position IS the centre of mass; the collision box sits above it.
      p.centre.copy(p.com).addScaledVector(p.axY, p.centreOffset.y);
      const v = body.vehicle;
      if (v) {
        p.mass = Math.max(1e-4, body.mass || v.tuning?.mass || 1);
        p.invMass = 1 / p.mass;
        p.topSpeed = v.topSpeed || p.topSpeed;
        if (v._invInertia && Number.isFinite(v._invInertia.x)) p.invI.copy(v._invInertia);
      }
    } else {
      // Prop bodies publish the FOOT of the object as `position` and the offset
      // to its centroid as `centreOffset`.
      p.centre.copy(p.com)
        .addScaledVector(p.axX, p.centreOffset.x)
        .addScaledVector(p.axY, p.centreOffset.y)
        .addScaledVector(p.axZ, p.centreOffset.z);
      p.com.copy(p.centre);
    }

    this._updateAabb(p, dt);
    return p;
  }

  _updateAabb(p, dt) {
    if (p.shape === SHAPE.MESH && p.tris) {
      p.minX = p.meshMin.x; p.minY = p.meshMin.y; p.minZ = p.meshMin.z;
      p.maxX = p.meshMax.x; p.maxY = p.meshMax.y; p.maxZ = p.meshMax.z;
      return p;
    }
    const ex = Math.abs(p.axX.x) * p.half.x + Math.abs(p.axY.x) * p.half.y + Math.abs(p.axZ.x) * p.half.z;
    const ey = Math.abs(p.axX.y) * p.half.x + Math.abs(p.axY.y) * p.half.y + Math.abs(p.axZ.y) * p.half.z;
    const ez = Math.abs(p.axX.z) * p.half.x + Math.abs(p.axY.z) * p.half.y + Math.abs(p.axZ.z) * p.half.z;

    // Sweep the bounds through this tick's motion, plus the contact skin. This
    // is the half of the anti-tunnelling guarantee that lives in the broadphase:
    // if the pair would touch during the step, the swept boxes overlap now.
    let sx = 0; let sy = 0; let sz = 0;
    if (!p.isStatic && dt > 0) {
      sx = Math.abs(p.velocity.x) * dt;
      sy = Math.abs(p.velocity.y) * dt;
      sz = Math.abs(p.velocity.z) * dt;
    }
    p.minX = p.centre.x - ex - sx - SKIN;
    p.maxX = p.centre.x + ex + sx + SKIN;
    p.minY = p.centre.y - ey - sy - SKIN;
    p.maxY = p.centre.y + ey + sy + SKIN;
    p.minZ = p.centre.z - ez - sz - SKIN;
    p.maxZ = p.centre.z + ez + sz + SKIN;
    return p;
  }

  /* ======================================================================
   * Track geometry
   * ====================================================================== */

  /** Adopt ctx.track and raise its static colliders. Idempotent. */
  _syncTrack() {
    const track = this.ctx?.track || null;
    if (track !== this.track) {
      this._releaseWalls();
      this._unregisterTerrain();
      this.track = track;
      this._wallsBuilt = false;
      this._terrain = track ? this._registerTerrain() : null;
    }
    if (!track || this._wallsBuilt) return;
    // TrackBuilder fills track.walls during its async build; poll cheaply until
    // it lands rather than assuming an ordering across agents.
    if (Array.isArray(track.walls) && track.walls.length) this._buildWalls();
  }

  _makeTerrain() {
    return {
      id: _proxySerial++,
      index: -1,
      body: { type: 'heightfield', isTerrain: true, static: true },
      shape: SHAPE.HEIGHTFIELD,
      roundXZ: false,
      isVehicle: false,
      isWall: false,
      isStatic: true,
      oversized: true,
      layer: 0xffffffff,
      centre: new THREE.Vector3(),
      com: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      axX: new THREE.Vector3(1, 0, 0),
      axY: new THREE.Vector3(0, 1, 0),
      axZ: new THREE.Vector3(0, 0, 1),
      half: new THREE.Vector3(1, 1, 1),
      radius: 1,
      centreOffset: new THREE.Vector3(),
      mass: 0,
      invMass: 0,
      invI: new THREE.Vector3(),
      // Its own vectors, not the shared zero scratch: the terrain is a real
      // solver participant now, and every writer guards on invMass, but an
      // aliased accumulator is not a thing to leave lying in a solver.
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      pseudoV: new THREE.Vector3(),
      pseudoW: new THREE.Vector3(),
      prevPos: new THREE.Vector3(),
      restitution: 0.1,
      friction: 0.9,
      surface: null,
      topSpeed: 0,
      sleeping: false,
      sleepTimer: 0,
      stamp: 0,
      rayStamp: 0,
      minX: -1e6, minY: -1e6, minZ: -1e6, maxX: 1e6, maxY: 1e6, maxZ: 1e6,
      promotable: false,
      promoted: false,
      visual: null,
      mesh: null,
    };
  }

  /**
   * Give the height field a slot in `proxies` and a place in `_oversized`.
   *
   * Without this it was a proxy nobody could reach: `_oversized` is the only
   * route into the broadphase for a body with no finite footprint, and it is
   * filled by addBody(), which the terrain never goes through. The result was
   * that `_terrainContacts` — the code that rests a flipped car on the road and
   * stops a knocked prop falling through the table — never ran once.
   */
  _registerTerrain() {
    const p = this._makeTerrain();
    const slot = this._free.length ? this._free.pop() : this.proxies.length;
    p.index = slot;
    this.proxies[slot] = p;
    this._oversized.push(slot);
    this._countBodies();
    return p;
  }

  /** Drop the height field proxy and every manifold that referenced it. */
  _unregisterTerrain() {
    const p = this._terrain;
    this._terrain = null;
    if (!p || p.index < 0) return;
    if (this.proxies[p.index] === p) {
      this.proxies[p.index] = null;
      this._free.push(p.index);
    }
    const o = this._oversized.indexOf(p.index);
    if (o >= 0) this._oversized.splice(o, 1);
    for (const [key, mf] of this._manifolds) {
      if (mf.a === p || mf.b === p) this._manifolds.delete(key);
    }
    p.index = -1;
    this._countBodies();
  }

  /**
   * Raise oriented-box colliders along every barrier TrackBuilder reported.
   *
   * The wall record it publishes is `{ from, to, side, height, thickness,
   * offset }` with the inner face at |lateral| = halfWidth + offset. Sweeping
   * one box per ~9 u of run (a car length) follows the curve closely enough
   * that a car never catches a corner, and cheaply enough that a 2400 u lap
   * with barriers on half of it costs about 130 static boxes.
   */
  _buildWalls() {
    const track = this.track;
    if (!track || !Array.isArray(track.walls)) return;
    this._releaseWalls();

    const L = track.length || 1;
    let raised = 0;
    for (const wall of track.walls) {
      if (!wall) continue;
      const height = Math.max(0.6, wall.height ?? 4.2);
      const thick = Math.max(0.6, wall.thickness ?? 2.4);
      const offset = wall.offset ?? 5.5;
      const sides = wall.side === 0 ? [-1, 1] : [wall.side === -1 ? -1 : 1];
      const from = wrap01(wall.from ?? 0);
      const to = wrap01(wall.to ?? 1);
      let spanT = to - from;
      if (spanT <= 0) spanT += 1;
      const runLength = spanT * L;
      if (runLength < 4) continue;
      const segments = clamp(Math.round(runLength / 9), 2, 220);

      for (const side of sides) {
        for (let i = 0; i < segments; i++) {
          const u = (i + 0.5) / segments;
          const t = wrap01(from + u * spanT);
          // TrackBuilder tapers the barrier in over the first and last tenth of
          // the run; matching it keeps the collider off the road where the mesh
          // has faded to nothing.
          const taper = smooth01(u / 0.10) * (1 - smooth01((u - 0.90) / 0.10));
          const h = height * Math.max(0.12, taper);
          let halfWidth = 13;
          try { halfWidth = track.widthAt(t) * 0.5; } catch (_) { /* default */ }
          const lateral = side * (halfWidth + offset + thick * 0.5);

          let base = null;
          try { base = track.surfacePoint(t, lateral, _v0); } catch (_) { base = null; }
          if (!base || !Number.isFinite(base.x + base.y + base.z)) continue;

          let tangent = _v1.set(0, 0, 1);
          let up = _v2.set(0, 1, 0);
          try {
            const s = track.sampleAt(t);
            tangent.copy(s.tangent).normalize();
            up.copy(s.normal).normalize();
          } catch (_) { /* flat fallback */ }
          // Orthonormalise: the track frame is banked, so `up` is not exactly
          // perpendicular to the tangent after interpolation.
          _v3.crossVectors(up, tangent);
          if (_v3.lengthSq() < 1e-8) continue;
          _v3.normalize();
          _v4.crossVectors(tangent, _v3).normalize();
          _m0.makeBasis(_v3, _v4, tangent);
          _q0.setFromRotationMatrix(_m0);

          const segLen = (runLength / segments) * 0.62;
          const body = {
            type: 'box',
            isWall: true,
            static: true,
            mass: 0,
            restitution: CONTACT_TUNING.carWallRestitution,
            friction: CONTACT_TUNING.carWallFriction,
            surface: 'plasticGloss',
            position: new THREE.Vector3(base.x, base.y + h * 0.5, base.z),
            quaternion: _q0.clone(),
            halfExtents: new THREE.Vector3(thick * 0.5, h * 0.5, Math.max(2.2, segLen)),
          };
          this.addBody(body);
          this._wallBodies.push(body);
          raised++;
        }
      }
    }

    this._wallsBuilt = raised > 0;
    if (this._wallsBuilt) {
      this._staticDirty = true;
      for (let i = 0; i < this.proxies.length; i++) {
        const p = this.proxies[i];
        if (p && p.isVehicle) this._takeOverWallContainment(p);
      }
    }
  }

  _releaseWalls() {
    for (const b of this._wallBodies) this.removeBody(b);
    this._wallBodies.length = 0;
    this._wallsBuilt = false;
    this._restoreWallContainment();
  }

  /**
   * Vehicle.js runs a soft lateral spring against `track.walls` so the game is
   * playable before this module exists, and documents `tuning.wallContain = 0`
   * as the way to hand it over. Running both would double the barrier's
   * stiffness and lose the deflection behaviour, so we take it.
   */
  _takeOverWallContainment(p) {
    const v = p.body?.vehicle;
    if (!v?.tuning || v.tuning.wallContain === 0) return;
    this._handedOverWalls.push({ vehicle: v, value: v.tuning.wallContain });
    v.tuning.wallContain = 0;
  }

  _restoreWallContainment() {
    for (const rec of this._handedOverWalls) {
      if (rec.vehicle?.tuning && rec.vehicle.tuning.wallContain === 0) {
        rec.vehicle.tuning.wallContain = rec.value;
      }
    }
    this._handedOverWalls.length = 0;
  }

  /* ---------------------------------------------------------------- terrain */

  _groundHeight(x, z) {
    const track = this.track;
    if (!track) return 0;
    try {
      const h = track.heightAt(x, z);
      return Number.isFinite(h) ? h : 0;
    } catch (_) { return 0; }
  }

  _groundNormal(x, z, out) {
    const track = this.track;
    out.set(0, 1, 0);
    if (!track?.normalAt) return out;
    try {
      const n = track.normalAt(x, z, out);
      if (n && Number.isFinite(n.x + n.y + n.z) && n.y > 0.05) return out.copy(n).normalize();
    } catch (_) { /* flat fallback */ }
    return out.set(0, 1, 0);
  }

  /* ======================================================================
   * Mesh colliders
   * ====================================================================== */

  /**
   * Bake a static triangle soup into flat arrays plus an XZ bucket index.
   * Nothing in the shipped game registers one — TrackBuilder publishes wall
   * spans instead, which make far better colliders — but the contract calls
   * for static mesh support and a track author dropping a `{ shape:'mesh',
   * mesh }` body into the world should just work.
   */
  _buildMeshData(p, body) {
    const src = body.mesh || body.object || body.geometry || null;
    let geo = null;
    let matrix = null;
    if (src && src.isBufferGeometry) geo = src;
    else if (src && src.isMesh) { geo = src.geometry; src.updateMatrixWorld?.(true); matrix = src.matrixWorld; }
    if (!geo?.attributes?.position) return null;

    const pos = geo.attributes.position;
    const idx = geo.index;
    const triCount = (idx ? idx.count : pos.count) / 3 | 0;
    if (triCount < 1 || triCount > 200000) return null;

    const verts = new Float32Array(triCount * 9);
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        _v0.fromBufferAttribute(pos, vi);
        if (matrix) _v0.applyMatrix4(matrix);
        verts[t * 9 + k * 3 + 0] = _v0.x;
        verts[t * 9 + k * 3 + 1] = _v0.y;
        verts[t * 9 + k * 3 + 2] = _v0.z;
        min.min(_v0);
        max.max(_v0);
      }
    }

    // Bucket triangles by XZ cell so a ray or a prop only ever tests a handful.
    const buckets = new Map();
    for (let t = 0; t < triCount; t++) {
      let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const x = verts[t * 9 + k * 3];
        const z = verts[t * 9 + k * 3 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const ix0 = Math.floor(x0 * INV_CELL);
      const ix1 = Math.floor(x1 * INV_CELL);
      const iz0 = Math.floor(z0 * INV_CELL);
      const iz1 = Math.floor(z1 * INV_CELL);
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const key = cellHash(ix, iz);
          let list = buckets.get(key);
          if (!list) { list = []; buckets.set(key, list); }
          list.push(t);
        }
      }
    }

    p.tris = verts;
    p.triCount = triCount;
    p.triBuckets = buckets;
    p.meshMin = min;
    p.meshMax = max;
    return p;
  }

  /* ======================================================================
   * Fixed step
   * ====================================================================== */

  fixedUpdate(fdt, ctx) {
    if (!this.enabled || !(fdt > 0) || !Number.isFinite(fdt)) return;
    if (ctx) this.ctx = ctx;
    this._tick++;

    const cfg = (this.ctx?.settings ?? Settings)?.physics ?? {};
    const substeps = clamp(Math.round(cfg.substeps ?? 1), 1, 4);
    const sub = fdt / substeps;

    if ((this._tick & 15) === 0 || !this._wallsBuilt) this._syncTrack();

    for (let s = 0; s < substeps; s++) this._step(sub, cfg);
  }

  _step(dt, cfg) {
    const gravity = cfg.gravity ?? 260;
    const velIters = clamp(Math.round(cfg.contactIterations ?? 6), 1, 20);
    const posIters = clamp(Math.round(cfg.positionIterations ?? 3), 0, 8);

    this._stamp++;
    this._pairCount = 0;
    this.stats.contacts = 0;
    this.stats.events = 0;

    /* --- 1. refresh transforms, integrate prop velocities ----------------- */
    let awake = 0;
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p) continue;
      p.pseudoV.set(0, 0, 0);
      p.pseudoW.set(0, 0, 0);
      if (p.isStatic) {
        // A static body can still be moved by whoever owns it (Props re-seats
        // its own knockables), so its transform is refreshed but not integrated.
        this._refreshProxy(p, 0);
        continue;
      }
      if (!p.isVehicle && !p.sleeping) {
        p.velocity.y -= gravity * dt;
        const ld = Math.max(0, 1 - PROP_LINEAR_DAMP * dt);
        const ad = Math.max(0, 1 - PROP_ANGULAR_DAMP * dt);
        p.velocity.multiplyScalar(ld);
        p.angularVelocity.multiplyScalar(ad);
      }
      this._refreshProxy(p, dt);
      if (!p.sleeping) awake++;
    }
    this.stats.awake = awake;

    /* --- 2. the swept guard ---------------------------------------------- */
    this._sweepGuard(dt);

    /* --- 3. broadphase ---------------------------------------------------- */
    this._broadphase();

    /* --- 4. narrowphase --------------------------------------------------- */
    this._narrowphase(dt);

    /* --- 5. solve --------------------------------------------------------- */
    let contacts = 0;
    for (const mf of this._manifolds.values()) {
      if (mf.stamp !== this._tick || !mf.count) continue;
      prepareManifold(mf, dt, false);
      warmStart(mf);
      contacts += mf.count;
    }
    for (let it = 0; it < velIters; it++) {
      for (const mf of this._manifolds.values()) {
        if (mf.stamp !== this._tick || !mf.count) continue;
        solveVelocity(mf);
      }
    }
    this.stats.contacts = contacts;

    /* --- 6. arcade response and contact events ---------------------------- */
    for (const mf of this._manifolds.values()) {
      if (mf.stamp !== this._tick || !mf.count) continue;
      this._respond(mf, dt);
    }

    /* --- 7. integrate props ------------------------------------------------ */
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p || p.isStatic || p.isVehicle || p.sleeping) continue;
      this._integrateProp(p, dt);
    }

    /* --- 8. positional correction ------------------------------------------ */
    for (let it = 0; it < posIters; it++) {
      for (const mf of this._manifolds.values()) {
        if (mf.stamp !== this._tick || !mf.count) continue;
        solvePosition(mf);
      }
    }
    this._applyCorrections();

    /* --- 9. sleeping, telemetry, visual writeback -------------------------- */
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p) continue;
      if (p.isVehicle) {
        p.prevPos.copy(p.com);
        const v = p.body.vehicle;
        if (v && v.shunt > 0) {
          v.shuntTime = (v.shuntTime || 0) + dt;
          v.shunt = Math.max(0, v.shunt - dt * 2.6);
        }
        continue;
      }
      if (p.isStatic) continue;
      this._updateSleep(p, dt);
      this._writeBackProp(p);
    }

    this._pruneManifolds();
  }

  /* ---------------------------------------------------------- swept guard */

  /**
   * Segment sweep from each car's previous centre of mass to its current one.
   *
   * Speculative contacts already make tunnelling impossible for any pair the
   * broadphase produced. This closes the only remaining hole — a pair that was
   * never produced at all — and it is cheap: one short raycast per car per tick.
   */
  _sweepGuard(dt) {
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p || !p.isVehicle) continue;
      // A TELEPORT ANNOUNCES ITSELF. It is not something to infer from distance.
      //
      // The threshold below used to be the only teleport test, and it was wrong
      // in the one case that matters most: pressing RETRY moves each car from
      // wherever the last race left it back to its grid slot, which measured
      // 190-330 units on the kitchen circuit -- comfortably UNDER 400. So the
      // guard treated a grid placement as ordinary travel, cast a ray along
      // those 250 units, hit the table edge on the way, and dragged the car
      // back to it. Six of eight cars, one frame after the restart, some of
      // them left sinking off the table at y = -0.9. The player reported it as
      // "sometime the race starts up fine, sometime my car is in strange
      // places", and it is intermittent only because it depends on where each
      // car happened to die.
      //
      // Vehicle bumps `teleportStamp` whenever it MOVES a car rather than
      // driving it. That cannot be confused with fast travel at any distance.
      const veh = p.body.vehicle;
      if (veh && veh.teleportStamp !== p.teleportStamp) {
        p.teleportStamp = veh.teleportStamp;
        p.prevPos.copy(p.com);
        this._forgetContacts(p);
        continue;
      }

      _v0.subVectors(p.com, p.prevPos);
      const dist = _v0.length();
      // Below a quarter unit nothing can have been missed, and the ray would
      // just be noise. The 400 stays as a backstop for anything that moves a
      // body without stamping it.
      if (dist < 0.25 || dist > 400) { p.prevPos.copy(p.com); continue; }
      _v0.multiplyScalar(1 / dist);
      const hit = this.raycast(p.prevPos, _v0, dist + 0.6, {
        exclude: p.body, staticOnly: true, skipTerrain: true,
      });
      if (!hit.hit || hit.distance < 0.05 || hit.distance >= dist) continue;

      const back = Math.max(0, hit.distance - 0.45);
      p.body.position.copy(p.prevPos).addScaledVector(_v0, back);
      const vn = p.velocity.dot(hit.normal);
      if (vn < 0) p.velocity.addScaledVector(hit.normal, -vn);
      this._refreshProxy(p, dt);
    }
  }

  /* ------------------------------------------------------------ broadphase */

  _broadphase() {
    if (this._staticDirty) {
      this._staticGrid.clear();
      for (let i = 0; i < this.proxies.length; i++) {
        const p = this.proxies[i];
        if (!p || !p.isStatic || p.oversized) continue;
        this._staticGrid.insert(i, p.minX, p.minZ, p.maxX, p.maxZ);
      }
      this._staticDirty = false;
    }

    this._dynGrid.clear();
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p || p.isStatic) continue;
      this._dynGrid.insert(i, p.minX, p.minZ, p.maxX, p.maxZ);
    }

    // Only awake dynamic bodies drive the query. A sleeping prop is still found
    // — it lives in the dynamic grid — so a car arriving wakes it, but it never
    // costs a query of its own.
    for (let i = 0; i < this.proxies.length; i++) {
      const a = this.proxies[i];
      if (!a || a.isStatic || a.sleeping) continue;
      this._stamp++;
      a.stamp = this._stamp;
      this._queryGrid(a, i, this._dynGrid, true);
      this._queryGrid(a, i, this._staticGrid, false);
      for (let k = 0; k < this._oversized.length; k++) {
        const j = this._oversized[k];
        const b = this.proxies[j];
        if (!b || b.stamp === this._stamp) continue;
        b.stamp = this._stamp;
        if (aabbOverlap(a, b)) this._addPair(i, j);
      }
    }
    this.stats.pairs = this._pairCount;
  }

  _queryGrid(a, ai, grid, dynamic) {
    const x0 = Math.floor(a.minX * INV_CELL);
    const x1 = Math.floor(a.maxX * INV_CELL);
    const z0 = Math.floor(a.minZ * INV_CELL);
    const z1 = Math.floor(a.maxZ * INV_CELL);
    const head = grid.head;
    const next = grid.next;
    const item = grid.item;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        let s = head[cellHash(ix, iz)];
        while (s !== -1) {
          const bi = item[s];
          s = next[s];
          if (bi === ai) continue;
          const b = this.proxies[bi];
          if (!b || b.stamp === this._stamp) continue;
          b.stamp = this._stamp;
          // Two awake dynamic bodies both query the grid and would each find
          // the other, so the pair is emitted once, by the lower index. A
          // SLEEPING body never queries at all — the loop above skips it — so
          // there is no second chance to dedupe against and the awake side
          // must claim it whatever the indices are. Without this a sleeping
          // prop with a lower index than the car (which is every knockable
          // prop, since Props is built before the vehicles) was paired by
          // nobody: it could not be found, so it never woke, so it never
          // became findable.
          if (dynamic && bi < ai && !b.sleeping) continue;
          if (!aabbOverlap(a, b)) continue;
          this._addPair(ai, bi);
        }
      }
    }
  }

  /**
   * Drop every manifold this proxy is part of.
   *
   * A teleported body's cached contacts describe geometry it is no longer
   * anywhere near, and warm-starting from them applies last frame's impulses at
   * this frame's position — which is how a car that has just been placed on the
   * grid gets shoved by a wall it left two hundred units ago.
   */
  _forgetContacts(p) {
    if (!p || !this._manifolds.size) return;
    for (const key of this._manifolds.keys()) {
      const a = Math.floor(key / 1048576);
      const b = key % 1048576;
      if (a === p.id || b === p.id) this._manifolds.delete(key);
    }
  }

  _addPair(i, j) {
    if (this._pairCount >= MAX_PAIRS) return;
    this._pairA[this._pairCount] = i;
    this._pairB[this._pairCount] = j;
    this._pairCount++;
  }

  /* ------------------------------------------------------------ narrowphase */

  _narrowphase(dt) {
    for (let k = 0; k < this._pairCount; k++) {
      let a = this.proxies[this._pairA[k]];
      let b = this.proxies[this._pairB[k]];
      if (!a || !b) continue;

      // Keep the pair key stable regardless of which side drove the query.
      if (a.id > b.id) { const t = a; a = b; b = t; }

      // A car blinking back in from a respawn cannot be touched by another car.
      //
      // CARS ONLY. The grace must never reach the track, the walls or a prop —
      // a respawned car that stopped colliding with the world would fall
      // through the table, which is the failure the respawn exists to fix.
      //
      // Telling the vehicle its contact was skipped is what lets the window end
      // when the car is CLEAR instead of on a stopwatch: grace expiring while
      // two cars overlap hands the solver a deep penetration out of nowhere and
      // it throws them apart, which is worse than the hit. See
      // Vehicle.holdRespawnGrace.
      if (a.isVehicle && b.isVehicle) {
        const va = a.body?.vehicle;
        const vb = b.body?.vehicle;
        const ga = va?.respawnGrace === true;
        const gb = vb?.respawnGrace === true;
        if (ga || gb) {
          if (ga) va.holdRespawnGrace?.();
          if (gb) vb.holdRespawnGrace?.();
          this._manifolds.delete(a.id * 1048576 + b.id);
          continue;
        }
      }

      if (a.isVehicle && b.promotable && !b.promoted) this._tryPromote(b, a);
      else if (b.isVehicle && a.promotable && !a.promoted) this._tryPromote(a, b);

      const key = a.id * 1048576 + b.id;
      let mf = this._manifolds.get(key);
      if (!mf) {
        mf = new Manifold();
        this._manifolds.set(key, mf);
      }

      const prevCount = mf.stamp === this._tick - 1 ? mf.count : 0;
      for (let i = 0; i < prevCount; i++) {
        _oldPoints[i].point.copy(mf.points[i].point);
        _oldPoints[i].normalImpulse = mf.points[i].normalImpulse;
        _oldPoints[i].tangentImpulse1 = mf.points[i].tangentImpulse1;
        _oldPoints[i].tangentImpulse2 = mf.points[i].tangentImpulse2;
      }

      const margin = this._marginFor(a, b, dt);
      let hit = false;
      if (a.shape === SHAPE.HEIGHTFIELD || b.shape === SHAPE.HEIGHTFIELD) {
        hit = this._terrainContacts(a, b, mf, margin);
      } else if (a.shape === SHAPE.MESH || b.shape === SHAPE.MESH) {
        hit = this._meshContacts(a, b, mf, margin);
      } else {
        hit = collide(a, b, mf, margin);
      }

      if (!hit) { mf.count = 0; mf.stamp = this._tick; continue; }
      transferImpulses(_oldPoints, prevCount, mf);
      mf.stamp = this._tick;

      // Any real contact wakes a sleeping prop, but only if the other body is
      // actually doing something — otherwise a resting stack wakes itself.
      if (a.sleeping && (!b.sleeping || b.isVehicle) && b.velocity.lengthSq() > 4) {
        a.sleeping = false; a.sleepTimer = 0;
      }
      if (b.sleeping && (!a.sleeping || a.isVehicle) && a.velocity.lengthSq() > 4) {
        b.sleeping = false; b.sleepTimer = 0;
      }
    }
    this.stats.manifolds = this._manifolds.size;
  }

  /**
   * Speculative margin for a pair: enough to cover this tick's closing motion,
   * plus the skin. This number IS the anti-tunnelling guarantee — see the
   * header note and Collision.prepareManifold.
   */
  _marginFor(a, b, dt) {
    _v0.subVectors(a.velocity, b.velocity);
    return Math.min(MAX_MARGIN, _v0.length() * dt + SKIN);
  }

  /**
   * A static prop light enough for a car to move is promoted the first time a
   * car actually reaches it. Doing it lazily means the scenery never twitches
   * on lap one and the cost is a map lookup on the tick of the impact.
   */
  _tryPromote(prop, car) {
    prop.promotable = false;         // one attempt, whatever the outcome
    const models = this._propModels;
    const kind = prop.body?.kind;
    const def = models && kind ? models[kind] : null;
    const mass = def && Number.isFinite(def.mass) ? def.mass : 0;
    if (!(mass > 0)) return false;
    if (mass > car.mass * CONTACT_TUNING.carPropTopplePropRatio) return false;
    // Anything with a footprint this large is furniture, whatever it weighs.
    if (Math.max(prop.half.x, prop.half.z) > 26 || prop.half.y > 30) return false;
    if (!this._bindPropVisual(prop)) return false;

    prop.isStatic = false;
    prop.promoted = true;
    prop.mass = mass;
    prop.invMass = 1 / mass;
    prop.sleeping = false;
    prop.sleepTimer = 0;
    prop.velocity = new THREE.Vector3();
    prop.angularVelocity = new THREE.Vector3();
    prop.body.mass = mass;
    prop.body.dynamic = true;
    // Stops world/Props.js from also stepping it, which would fight us.
    prop.body.externallySimulated = true;
    prop.body.velocity = prop.velocity;
    prop.body.angularVelocity = prop.angularVelocity;
    this._deriveInertia(prop);
    this._staticDirty = true;
    this._countBodies();
    return true;
  }

  /* -------------------------------------------------------- terrain contacts */

  /**
   * Contacts against the track height field.
   *
   * Cars are excluded while they are upright: their four raycast suspension
   * struts already hold them off the ground, and a second set of constraints
   * doing the same job would fight them. The exception is a car on its roof or
   * its side, where the struts point away from the road and find nothing — that
   * car must rest on the geometry and slide to a halt, not fall through it.
   */
  _terrainContacts(a, b, mf, margin) {
    const hf = a.shape === SHAPE.HEIGHTFIELD ? a : b;
    const solid = hf === a ? b : a;
    mf.reset(a, b);
    if (solid.shape === SHAPE.HEIGHTFIELD) return false;
    if (solid.isVehicle && solid.axY.y > 0.4) return false;
    if (solid.sleeping) return false;

    // Normal points A -> B; the terrain pushes upward, away from itself.
    const upSign = hf === a ? 1 : -1;
    mf.normal.set(0, upSign, 0);

    let n = 0;
    if (solid.shape === SHAPE.SPHERE) {
      _v1.copy(solid.centre);
      _v1.y -= solid.radius;
      n += this._terrainPoint(mf, _v1, solid.radius, margin, upSign) ? 1 : 0;
    } else {
      // The four bottom corners, then the four top ones if the body is
      // inverted — which is exactly the case a car on its roof needs.
      const limit = solid.isVehicle && solid.axY.y < 0 ? 8 : 4;
      for (let i = 0; i < limit && mf.count < 4; i++) {
        const c = CORNER[i];
        _v1.copy(solid.centre)
          .addScaledVector(solid.axX, c[0] * solid.half.x)
          .addScaledVector(solid.axY, c[1] * solid.half.y)
          .addScaledVector(solid.axZ, c[2] * solid.half.z);
        if (this._terrainPoint(mf, _v1, 0, margin, upSign)) n++;
      }
    }
    if (!n) return false;

    // Average the sampled normals into the manifold normal so a car resting on
    // a banked corner is pushed along the banking, not straight up.
    if (this._terrainNormalSum.lengthSq() > 1e-6) {
      this._terrainNormalSum.normalize().multiplyScalar(upSign);
      mf.normal.copy(this._terrainNormalSum);
    }
    mf.a = a;
    mf.b = b;
    mf.restitution = solid.isVehicle ? CONTACT_TUNING.carGroundRestitution : solid.restitution;
    mf.friction = solid.isVehicle ? CONTACT_TUNING.carGroundFriction
      : Math.max(CONTACT_TUNING.propGroundFriction, solid.friction);
    mf.kind = solid.isVehicle ? 'car-ground' : 'prop-ground';
    return true;
  }

  _terrainPoint(mf, point, radius, margin, upSign) {
    const h = this._groundHeight(point.x, point.z);
    const gap = point.y - radius - h;
    if (gap > margin) return false;
    this._groundNormal(point.x, point.z, _v2);
    if (mf.count === 0) this._terrainNormalSum.set(0, 0, 0);
    this._terrainNormalSum.add(_v2);
    const cp = mf.add();
    if (!cp) return false;
    // Separation measured along the surface normal, not straight down: on a
    // 15-degree ramp the vertical gap over-reports the real clearance.
    cp.separation = gap * Math.max(0.35, _v2.y);
    cp.point.set(point.x, h + (gap * 0.5), point.z);
    void upSign;
    return true;
  }

  /* ----------------------------------------------------------- mesh contacts */

  _meshContacts(a, b, mf, margin) {
    const mesh = a.shape === SHAPE.MESH ? a : b;
    const solid = mesh === a ? b : a;
    mf.reset(a, b);
    if (!mesh.tris || solid.shape === SHAPE.MESH) return false;
    if (solid.sleeping) return false;
    if (solid.isVehicle && solid.axY.y > 0.4 && mesh.body?.isGround) return false;

    const sign = mesh === a ? 1 : -1;
    const ix0 = Math.floor(solid.minX * INV_CELL);
    const ix1 = Math.floor(solid.maxX * INV_CELL);
    const iz0 = Math.floor(solid.minZ * INV_CELL);
    const iz1 = Math.floor(solid.maxZ * INV_CELL);

    let bestDepth = Infinity;
    let found = false;
    this._rayStamp++;
    const stamp = this._rayStamp;
    const seen = this._meshSeen;

    for (let iz = iz0; iz <= iz1 && mf.count < 4; iz++) {
      for (let ix = ix0; ix <= ix1 && mf.count < 4; ix++) {
        const list = mesh.triBuckets.get(cellHash(ix, iz));
        if (!list) continue;
        for (let n = 0; n < list.length && mf.count < 4; n++) {
          const t = list[n];
          if (seen.get(t) === stamp) continue;
          seen.set(t, stamp);
          const o = t * 9;
          _v1.set(mesh.tris[o], mesh.tris[o + 1], mesh.tris[o + 2]);
          _v2.set(mesh.tris[o + 3], mesh.tris[o + 4], mesh.tris[o + 5]);
          _v3.set(mesh.tris[o + 6], mesh.tris[o + 7], mesh.tris[o + 8]);

          if (solid.shape === SHAPE.SPHERE) {
            closestPointOnTriangle(solid.centre, _v1, _v2, _v3, _v4);
            _v5.subVectors(solid.centre, _v4);
            const d = _v5.length();
            const sep = d - solid.radius;
            if (sep > margin) continue;
            if (d < 1e-5) continue;
            _v5.multiplyScalar(1 / d);
            const cp = mf.add();
            if (!cp) break;
            cp.point.copy(_v4);
            cp.separation = sep;
            if (sep < bestDepth) { bestDepth = sep; mf.normal.copy(_v5).multiplyScalar(sign); }
            found = true;
          } else {
            // Box against triangle, approximated by the closest point on the
            // triangle to the box: enough for a prop tumbling over static
            // scenery, and it can never produce a normal that points inward.
            _v4.copy(solid.centre);
            closestPointOnTriangle(_v4, _v1, _v2, _v3, _v5);
            closestPointOnBox(solid, _v5, _v0);
            _v4.subVectors(_v5, _v0);
            const d = _v4.length();
            _v2.sub(_v1);
            _v3.sub(_v1);
            _v1.crossVectors(_v2, _v3);
            if (_v1.lengthSq() < 1e-10) continue;
            _v1.normalize();
            if (_v1.dot(_v4) > 0) _v1.negate();       // face the box
            const sep = d * (_v4.dot(_v1) > 0 ? 1 : -1);
            if (sep > margin) continue;
            const cp = mf.add();
            if (!cp) break;
            cp.point.copy(_v5);
            cp.separation = sep;
            if (sep < bestDepth) { bestDepth = sep; mf.normal.copy(_v1).multiplyScalar(-sign); }
            found = true;
          }
        }
      }
    }
    if (!found) return false;
    mf.a = a;
    mf.b = b;
    mf.restitution = solid.isVehicle ? CONTACT_TUNING.carGroundRestitution : solid.restitution;
    mf.friction = solid.isVehicle ? CONTACT_TUNING.carGroundFriction : solid.friction;
    mf.kind = solid.isVehicle ? 'car-ground' : 'prop-ground';
    return true;
  }

  /* --------------------------------------------------------------- response */

  _respond(mf, dt) {
    let impulse = manifoldImpulse(mf);
    if (mf.kind === 'car-car') impulse = applyCarCarResponse(mf, dt);
    else if (mf.kind === 'car-wall') impulse = applyCarWallResponse(mf, dt);
    else if (mf.kind === 'car-prop') impulse = applyCarPropResponse(mf, dt);
    mf.totalImpulse = impulse;

    if (mf.eventCooldown > 0) mf.eventCooldown -= dt;
    if (impulse < CONTACT_TUNING.eventImpulse) return;
    if (mf.eventCooldown > 0) return;
    mf.eventCooldown = CONTACT_TUNING.eventCooldown;
    this._emitContact(mf, impulse);
  }

  _emitContact(mf, impulse) {
    const ev = this._events[this._eventCursor];
    this._eventCursor = (this._eventCursor + 1) % this._events.length;

    ev.a = mf.a.body;
    ev.b = mf.b.body;
    manifoldCentroid(mf, ev.point);
    ev.normal.copy(mf.normal);
    ev.impulse = impulse;
    ev.relativeSpeed = mf.approachSpeed;
    ev.tangentSpeed = mf.tangentSpeed;
    ev.kind = mf.kind;
    ev.vehicleA = mf.a.body?.vehicle || null;
    ev.vehicleB = mf.b.body?.vehicle || null;
    ev.surface = mf.a.surface || mf.b.surface
      || (mf.kind.endsWith('ground') ? this._surfaceAtPoint(ev.point) : 'plasticMatte');
    this.stats.events++;

    // The bodies themselves first: Vehicle.onContact() is what accrues damage
    // and scuff and fires 'vehicle:impact'.
    try { mf.a.body.onContact?.({ impulse, kind: mf.kind, other: mf.b.body, point: ev.point, normal: ev.normal }); } catch (_) { /* a listener must not stop the solve */ }
    try { mf.b.body.onContact?.({ impulse, kind: mf.kind, other: mf.a.body, point: ev.point, normal: ev.normal }); } catch (_) { /* ditto */ }

    for (let i = 0; i < this._listeners.length; i++) {
      try { this._listeners[i](ev); } catch (_) { /* ditto */ }
    }
    try { this.ctx?.bus?.emit?.('physics:contact', ev); } catch (_) { /* ditto */ }
    try { this.ctx?.fx?.impacts?.onContact?.(ev); } catch (_) { /* ditto */ }
    if (mf.tangentSpeed > CONTACT_TUNING.scrapeSpeed && mf.kind === 'car-wall') {
      try { this.ctx?.bus?.emit?.('physics:scrape', ev); } catch (_) { /* ditto */ }
    }
  }

  /* -------------------------------------------------------------- integration */

  _integrateProp(p, dt) {
    const v = p.velocity;
    if (!Number.isFinite(v.lengthSq())) v.set(0, 0, 0);
    const vmax = 900;
    if (v.lengthSq() > vmax * vmax) v.setLength(vmax);
    const w = p.angularVelocity;
    if (!Number.isFinite(w.lengthSq())) w.set(0, 0, 0);
    if (w.lengthSq() > 900) w.setLength(30);

    p.com.addScaledVector(v, dt);

    const ang = w.length();
    if (ang > 1e-5) {
      _v0.copy(w).multiplyScalar(1 / ang);
      _q0.setFromAxisAngle(_v0, ang * dt);
      p.quat.premultiply(_q0).normalize();
      refreshAxes(p);
    }

    // Anything that leaves the playfield is parked rather than integrated for
    // the rest of the race.
    const bounds = this.track?.bounds;
    if (bounds) {
      const pad = 120;
      if (p.com.x < bounds.min.x - pad || p.com.x > bounds.max.x + pad
        || p.com.z < bounds.min.z - pad || p.com.z > bounds.max.z + pad
        || p.com.y < (this.track.groundY ?? 0) - 300) {
        p.velocity.set(0, 0, 0);
        p.angularVelocity.set(0, 0, 0);
        p.sleeping = true;
      }
    }
  }

  _applyCorrections() {
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i];
      if (!p || p.invMass === 0) continue;
      const lin = p.pseudoV.length();
      if (lin > 1e-6) {
        if (lin > MAX_CORRECTION) p.pseudoV.multiplyScalar(MAX_CORRECTION / lin);
        p.com.add(p.pseudoV);
        if (p.isVehicle) p.body.position.copy(p.com);
      }
      const ang = p.pseudoW.length();
      if (ang > 1e-6) {
        const a = Math.min(ang, MAX_SPIN_CORRECTION);
        _v0.copy(p.pseudoW).multiplyScalar(1 / ang);
        _q0.setFromAxisAngle(_v0, a);
        p.quat.premultiply(_q0).normalize();
        if (p.isVehicle) p.body.quaternion.copy(p.quat);
        refreshAxes(p);
      }
      p.pseudoV.set(0, 0, 0);
      p.pseudoW.set(0, 0, 0);
    }
  }

  _updateSleep(p, dt) {
    if (p.sleeping) return;
    const still = p.velocity.lengthSq() < SLEEP_LINEAR * SLEEP_LINEAR
      && p.angularVelocity.lengthSq() < SLEEP_ANGULAR * SLEEP_ANGULAR;
    if (!still) { p.sleepTimer = 0; return; }
    p.sleepTimer += dt;
    if (p.sleepTimer < SLEEP_TIME) return;
    p.sleeping = true;
    p.velocity.set(0, 0, 0);
    p.angularVelocity.set(0, 0, 0);
  }

  /* --------------------------------------------------------- prop visuals */

  /**
   * Find the instanced mesh slot a prop collider draws into.
   *
   * world/Props.js hands ownership of a knockable prop to us the moment we
   * accept its body (it sets `externallySimulated` and stops stepping it), so
   * from that point the instance matrix is ours to write or the prop collides
   * invisibly. `byModel` is the published model -> { meshes, placements } map.
   */
  _bindPropVisual(p) {
    if (p.visual) return p.visual;
    const props = this.ctx?.props;
    const body = p.body;
    const kind = body?.kind;
    const index = body?.instance;
    if (!props?.byModel?.get || typeof kind !== 'string' || !Number.isFinite(index)) return null;
    let entry = null;
    try { entry = props.byModel.get(kind); } catch (_) { return null; }
    const meshes = entry?.meshes;
    if (!Array.isArray(meshes) || !meshes.length) return null;
    const placement = entry.placements?.[index] || null;
    p.visual = {
      meshes,
      index,
      scale: placement?.scale ? placement.scale.clone() : _scaleOne.clone(),
    };
    return p.visual;
  }

  _writeBackProp(p) {
    const body = p.body;
    // Publish the collider's transform in the same convention Props authored
    // it: `position` is the foot of the object, `centreOffset` gets to the CoM.
    _v0.copy(p.com)
      .addScaledVector(p.axX, -p.centreOffset.x)
      .addScaledVector(p.axY, -p.centreOffset.y)
      .addScaledVector(p.axZ, -p.centreOffset.z);
    body.position.copy(_v0);
    if (body.quaternion) body.quaternion.copy(p.quat);

    const vis = p.visual || this._bindPropVisual(p);
    if (!vis || p.sleeping) return;
    _m0.compose(_v0, p.quat, vis.scale);
    for (let i = 0; i < vis.meshes.length; i++) {
      const mesh = vis.meshes[i];
      if (!mesh?.instanceMatrix) continue;
      mesh.setMatrixAt(vis.index, _m0);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _pruneManifolds() {
    // Manifolds are cheap to keep for a few ticks (warm starting wants them)
    // but must not accumulate for pairs that have long since separated.
    if ((this._tick & 63) !== 0) return;
    const cutoff = this._tick - 90;
    for (const [key, mf] of this._manifolds) {
      if (mf.stamp < cutoff) this._manifolds.delete(key);
    }
  }

  /* ======================================================================
   * Raycast
   * ====================================================================== */

  /**
   * Cast a ray and return the nearest hit.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir  need not be normalised
   * @param {number} maxDist
   * @param {object|number|function} [mask] a body to exclude (what
   *   vehicle/Vehicle.js passes — its own chassis), a layer bitmask, a
   *   predicate, or an options object
   *   `{ exclude, layers, filter, staticOnly, skipTerrain, skipVehicles }`
   * @returns {{hit, point, normal, distance, surface, body}} SHARED — a ring of
   *   16 results is rotated, so copy anything you intend to keep across calls.
   *   `surface` resolves lazily; reading it on a terrain hit costs a spline
   *   projection, so do not read it unless you need it.
   */
  raycast(origin, dir, maxDist = 1000, mask = null) {
    const hit = this._hits[this._hitCursor];
    this._hitCursor = (this._hitCursor + 1) % this._hits.length;
    hit.reset();
    if (!origin || !dir) return hit;

    _rayOrigin.copy(origin);
    _rayDir.copy(dir);
    const len = _rayDir.length();
    if (!(len > 1e-8) || !Number.isFinite(maxDist) || maxDist <= 0) return hit;
    _rayDir.multiplyScalar(1 / len);

    const f = resolveFilter(mask, _filter);
    let best = maxDist;

    this._rayStamp++;
    const stamp = this._rayStamp;

    /* --- oversized bodies: mesh soups, tested directly ------------------- */
    for (let k = 0; k < this._oversized.length; k++) {
      const p = this.proxies[this._oversized[k]];
      if (!p || p.rayStamp === stamp) continue;
      p.rayStamp = stamp;
      if (!passesFilter(p, f)) continue;
      const d = this._rayShape(p, best);
      if (d >= 0 && d < best) { best = d; this._writeHit(hit, p, d); }
    }

    /* --- grid traversal --------------------------------------------------- */
    const ox = _rayOrigin.x;
    const oz = _rayOrigin.z;
    const dx = _rayDir.x;
    const dz = _rayDir.z;
    let ix = Math.floor(ox * INV_CELL);
    let iz = Math.floor(oz * INV_CELL);
    const stepX = dx > 1e-9 ? 1 : dx < -1e-9 ? -1 : 0;
    const stepZ = dz > 1e-9 ? 1 : dz < -1e-9 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(CELL / dz) : Infinity;
    let tMaxX = stepX !== 0 ? (((stepX > 0 ? ix + 1 : ix) * CELL) - ox) / dx : Infinity;
    let tMaxZ = stepZ !== 0 ? (((stepZ > 0 ? iz + 1 : iz) * CELL) - oz) / dz : Infinity;
    if (tMaxX < 0) tMaxX = Infinity;
    if (tMaxZ < 0) tMaxZ = Infinity;

    for (let guard = 0; guard < RAY_CELL_LIMIT; guard++) {
      const h = cellHash(ix, iz);
      best = this._raySearchCell(this._staticGrid, h, stamp, f, best, hit);
      best = this._raySearchCell(this._dynGrid, h, stamp, f, best, hit);

      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      // Everything remaining is further away than the hit we already have.
      if (tNext > best || tNext > maxDist || !Number.isFinite(tNext)) break;
      if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
      else { iz += stepZ; tMaxZ += tDeltaZ; }
    }

    /* --- the track height field ------------------------------------------- */
    if (!f.skipTerrain && this.track) {
      const d = this._rayTerrain(best);
      if (d >= 0 && d < best) {
        best = d;
        hit.hit = true;
        hit.distance = d;
        hit.point.copy(_rayOrigin).addScaledVector(_rayDir, d);
        this._groundNormal(hit.point.x, hit.point.z, hit.normal);
        hit.body = this._terrain?.body || null;
        hit.proxy = this._terrain;
        hit.isTerrain = true;
        hit._surface = null;
      }
    }

    return hit;
  }

  _raySearchCell(grid, h, stamp, f, best, hit) {
    let s = grid.head[h];
    while (s !== -1) {
      const bi = grid.item[s];
      s = grid.next[s];
      const p = this.proxies[bi];
      if (!p || p.rayStamp === stamp) continue;
      p.rayStamp = stamp;
      if (!passesFilter(p, f)) continue;
      const d = this._rayShape(p, best);
      if (d >= 0 && d < best) { best = d; this._writeHit(hit, p, d); }
    }
    return best;
  }

  _rayShape(p, best) {
    if (p.shape === SHAPE.SPHERE) {
      return raySphere(_rayOrigin, _rayDir, p.centre, p.radius, best, _v5);
    }
    if (p.shape === SHAPE.MESH) return this._rayMesh(p, best);
    if (p.shape === SHAPE.HEIGHTFIELD) return -1;
    return rayBox(_rayOrigin, _rayDir, p, best, _v5);
  }

  _rayMesh(p, best) {
    if (!p.tris) return -1;
    let found = -1;
    // Walk the same XZ buckets the triangles were sorted into.
    const ox = _rayOrigin.x;
    const oz = _rayOrigin.z;
    const dx = _rayDir.x;
    const dz = _rayDir.z;
    let ix = Math.floor(ox * INV_CELL);
    let iz = Math.floor(oz * INV_CELL);
    const stepX = dx > 1e-9 ? 1 : dx < -1e-9 ? -1 : 0;
    const stepZ = dz > 1e-9 ? 1 : dz < -1e-9 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(CELL / dz) : Infinity;
    let tMaxX = stepX !== 0 ? (((stepX > 0 ? ix + 1 : ix) * CELL) - ox) / dx : Infinity;
    let tMaxZ = stepZ !== 0 ? (((stepZ > 0 ? iz + 1 : iz) * CELL) - oz) / dz : Infinity;
    if (tMaxX < 0) tMaxX = Infinity;
    if (tMaxZ < 0) tMaxZ = Infinity;

    this._rayStamp++;
    const stamp = this._rayStamp;
    let limit = best;

    for (let guard = 0; guard < 256; guard++) {
      const list = p.triBuckets.get(cellHash(ix, iz));
      if (list) {
        for (let n = 0; n < list.length; n++) {
          const t = list[n];
          if (this._meshSeen.get(t) === stamp) continue;
          this._meshSeen.set(t, stamp);
          const o = t * 9;
          _v1.set(p.tris[o], p.tris[o + 1], p.tris[o + 2]);
          _v2.set(p.tris[o + 3], p.tris[o + 4], p.tris[o + 5]);
          _v3.set(p.tris[o + 6], p.tris[o + 7], p.tris[o + 8]);
          const d = rayTriangle(_rayOrigin, _rayDir, _v1, _v2, _v3, limit, _v4);
          if (d >= 0 && d < limit) { limit = d; found = d; _v5.copy(_v4); }
        }
      }
      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tNext > limit || !Number.isFinite(tNext)) break;
      if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
      else { iz += stepZ; tMaxZ += tDeltaZ; }
    }
    return found;
  }

  /**
   * Intersect the ray with the analytic height field.
   *
   * A descending ray converges in two plane-refinement steps, which is the same
   * trick vehicle/Vehicle.js uses for its suspension and is exact on any slope
   * gentle enough to drive on. Anything else marches and bisects.
   */
  _rayTerrain(maxDist) {
    const dy = _rayDir.y;
    const oy = _rayOrigin.y;

    if (dy < -0.15) {
      let t = 0;
      for (let i = 0; i < 3; i++) {
        const x = _rayOrigin.x + _rayDir.x * t;
        const z = _rayOrigin.z + _rayDir.z * t;
        const h = this._groundHeight(x, z);
        const y = oy + dy * t;
        const step = (y - h) / -dy;
        if (!Number.isFinite(step)) return -1;
        t += step;
        if (t < 0) return -1;
        if (Math.abs(step) < 0.01) break;
      }
      if (t < 0 || t > maxDist) return -1;
      return t;
    }

    // Marching fallback for level and climbing rays.
    const step = Math.max(2, Math.min(12, maxDist / 24));
    let prevT = 0;
    let prevGap = oy - this._groundHeight(_rayOrigin.x, _rayOrigin.z);
    if (prevGap <= 0) return 0;
    for (let t = step; t <= maxDist; t += step) {
      const x = _rayOrigin.x + _rayDir.x * t;
      const z = _rayOrigin.z + _rayDir.z * t;
      const gap = (oy + dy * t) - this._groundHeight(x, z);
      if (gap <= 0) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          const g = (oy + dy * mid)
            - this._groundHeight(_rayOrigin.x + _rayDir.x * mid, _rayOrigin.z + _rayDir.z * mid);
          if (g > 0) lo = mid; else hi = mid;
        }
        return (lo + hi) * 0.5;
      }
      prevT = t;
      prevGap = gap;
    }
    void prevGap;
    return -1;
  }

  _writeHit(hit, p, d) {
    hit.hit = true;
    hit.distance = d;
    hit.point.copy(_rayOrigin).addScaledVector(_rayDir, d);
    hit.normal.copy(_v5);
    if (hit.normal.lengthSq() < 1e-8) hit.normal.set(0, 1, 0);
    hit.body = p.body;
    hit.proxy = p;
    hit.isTerrain = false;
    hit._surface = null;
    return hit;
  }

  _surfaceForHit(hit) {
    if (!hit.hit) return 'concrete';
    const p = hit.proxy;
    if (p && typeof p.surface === 'string' && p.surface) return p.surface;
    const b = hit.body;
    if (b && typeof b.surface === 'string' && b.surface) return b.surface;
    return this._surfaceAtPoint(hit.point);
  }

  _surfaceAtPoint(point) {
    const track = this.track;
    if (!track?.surfaceAt) return 'concrete';
    try {
      const s = track.surfaceAt(point);
      return typeof s === 'string' && s ? s : 'concrete';
    } catch (_) { return 'concrete'; }
  }

  /* ======================================================================
   * Queries
   * ====================================================================== */

  /**
   * Every body whose bounds touch the sphere. Written for AI avoidance and fx;
   * `out` is reused by the caller, and the returned entries are the external
   * body objects, not proxies.
   */
  overlapSphere(centre, radius, out = []) {
    out.length = 0;
    if (!centre || !(radius > 0)) return out;
    this._rayStamp++;
    const stamp = this._rayStamp;
    const x0 = Math.floor((centre.x - radius) * INV_CELL);
    const x1 = Math.floor((centre.x + radius) * INV_CELL);
    const z0 = Math.floor((centre.z - radius) * INV_CELL);
    const z1 = Math.floor((centre.z + radius) * INV_CELL);
    const r2 = radius * radius;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const h = cellHash(ix, iz);
        for (const grid of [this._staticGrid, this._dynGrid]) {
          let s = grid.head[h];
          while (s !== -1) {
            const p = this.proxies[grid.item[s]];
            s = grid.next[s];
            if (!p || p.rayStamp === stamp) continue;
            p.rayStamp = stamp;
            const dx = Math.max(p.minX - centre.x, 0, centre.x - p.maxX);
            const dy = Math.max(p.minY - centre.y, 0, centre.y - p.maxY);
            const dz = Math.max(p.minZ - centre.z, 0, centre.z - p.maxZ);
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(p.body);
          }
        }
      }
    }
    return out;
  }

  /** Ground height under (x, z), including ramps, gaps and props. */
  groundHeightAt(x, z) { return this._groundHeight(x, z); }

  /* ======================================================================
   * Lifecycle
   * ====================================================================== */

  async _loadPropModels() {
    // Fire-and-forget, exactly as vehicle/Tires.js does for Surfaces: a static
    // import would chain this module to ProcTex at evaluation time, and one
    // throw in a texture generator would take the physics world with it.
    try {
      const mod = await import('../world/Props.js');
      if (mod?.PROP_MODELS) this._propModels = mod.PROP_MODELS;
    } catch (_) { /* static props simply stay immovable */ }
  }

  /** Live snapshot for core/Debug.js. */
  telemetry() {
    return {
      bodies: this.stats.bodies,
      vehicles: this.stats.vehicles,
      props: this.stats.props,
      statics: this.stats.statics,
      awake: this.stats.awake,
      pairs: this.stats.pairs,
      manifolds: this.stats.manifolds,
      contacts: this.stats.contacts,
      walls: this._wallBodies.length,
      track: this.track?.id || null,
    };
  }

  dispose() {
    this._restoreWallContainment();
    this._manifolds.clear();
    this._byBody.clear();
    this.proxies.length = 0;
    this._free.length = 0;
    this._oversized.length = 0;
    this._wallBodies.length = 0;
    this._listeners.length = 0;
    this.track = null;
    this._terrain = null;
  }
}

/* ==========================================================================
 * Free functions
 * ========================================================================== */

function aabbOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function wrap01(t) {
  if (!Number.isFinite(t)) return 0;
  const f = t - Math.floor(t);
  return f < 0 ? f + 1 : f;
}

function smooth01(x) {
  const t = saturate(x);
  return t * t * (3 - 2 * t);
}

/**
 * Normalise whatever a caller passed as `mask`.
 *
 * vehicle/Vehicle.js passes its own body object, which is the common case and
 * means "everything except me". A number is a layer mask, a function is a
 * predicate, and an object carrying any of the option keys is an options bag.
 */
function resolveFilter(mask, out) {
  out.exclude = null;
  out.excludeB = null;
  out.predicate = null;
  out.layers = 0xffffffff;
  out.staticOnly = false;
  out.skipTerrain = false;
  out.skipVehicles = false;
  if (mask == null) return out;
  if (typeof mask === 'number') { out.layers = mask >>> 0; return out; }
  if (typeof mask === 'function') { out.predicate = mask; return out; }
  if (typeof mask !== 'object') return out;

  const isOptions = 'exclude' in mask || 'layers' in mask || 'filter' in mask
    || 'staticOnly' in mask || 'skipTerrain' in mask || 'skipVehicles' in mask;
  if (!isOptions) { out.exclude = mask; return out; }

  out.exclude = mask.exclude || null;
  out.excludeB = mask.exclude2 || null;
  out.predicate = typeof mask.filter === 'function' ? mask.filter : null;
  if (Number.isFinite(mask.layers)) out.layers = mask.layers >>> 0;
  out.staticOnly = !!mask.staticOnly;
  out.skipTerrain = !!mask.skipTerrain;
  out.skipVehicles = !!mask.skipVehicles;
  return out;
}

function passesFilter(p, f) {
  if (p.body === f.exclude || p.body === f.excludeB) return false;
  if (f.staticOnly && !p.isStatic) return false;
  if (f.skipVehicles && p.isVehicle) return false;
  if ((p.layer & f.layers) === 0) return false;
  if (f.predicate && !f.predicate(p.body, p)) return false;
  return true;
}

export const World = PhysicsWorld;
export default PhysicsWorld;
