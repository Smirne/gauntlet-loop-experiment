// vehicle/Vehicle.js — chassis dynamics. This file owns how the game feels.
//
// A rigid body with four raycast suspension struts, a real engine and gearbox,
// aero, and the tyre model in Tires.js under every corner. It is a simulation
// in structure and an arcade racer in tuning: everything a sim does to make a
// car believable is here — weight transfer, load-sensitive tyres, anti-roll
// bars, a friction ellipse — and then every constant is set so the car is
// grippy, instantly responsive, and impossible to lose permanently.
//
// ---------------------------------------------------------------- conventions
//
// UNITS      1 world unit = 1 cm. Y up. Gravity = Settings.physics.gravity
//            (260 u/s2 — the deliberate lie in ARCHITECTURE section 2).
//            Mass is normalised near 1, so a force number *is* an acceleration.
//
// AXES       Local +Z is FORWARD, +Y is UP, +X is the car's LEFT. That is not
//            arbitrary: world/Track.js basisFromFrame() builds spawn rotations
//            as makeBasis(cross(normal, tangent), normal, tangent), which puts
//            forward on +Z and left on +X. Every sign in this file follows it.
//
// STEER      setControls({ steer }) is -1 full LEFT .. +1 full RIGHT, matching a
//            gamepad X axis. Internally steerAngle is positive-left (it is a
//            rotation about +Y), so steerAngle = -steerPos * steerMax.
//
// WHEELS     0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
//
// POSITION   `position` is the centre of mass, sitting `cgHeight` above the
//            contact patch when the car is at rest. VehicleVisual should model
//            the body with its origin there; `wheels[i].hubX/Y/Z` gives the
//            exact world hub centre for each wheel, already suspension-aware.
//
// ------------------------------------------------------------------ the drift
//
// The drift is not a special mode. Handbrake locks the rear wheels and drops
// their lateral friction multiplier; the tail steps out; the weight that
// transfers laterally loads the outside tyres, and because Tires.js is
// load-sensitive that costs the car grip exactly where a real one would lose
// it. What keeps the slide alive is the tyre model's plateau — past the peak
// slip angle the rear still returns ~86% of peak grip, so the slide finds an
// equilibrium instead of running away. Counter-steering points the front tyres
// down the velocity vector, which is a real yaw moment against the rotation,
// so it recovers the car through physics rather than through a scripted catch.
// The assists on top of that (yaw damping, spin catch) only ever *add* recovery
// authority; they are never required for the car to be controllable.

import * as THREE from 'three';
import { clamp, saturate, lerp, smoothstep } from '../core/Random.js';
import { Settings } from '../core/Settings.js';
import {
  TireModel,
  makeWheelState,
  surfaceRecord,
} from './Tires.js';

const RPM_PER_RADS = 60 / (Math.PI * 2);
const RADS_PER_RPM = 1 / RPM_PER_RADS;
const DEG = Math.PI / 180;

/* ==========================================================================
 * Module scratch. Never allocate inside a physics tick.
 * ========================================================================== */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
// Dedicated to _roadPitchAt so it can be called from inside the recovery path
// without clobbering the scratch respawn() is using two frames later.
const _pitchA = new THREE.Vector3();
const _pitchB = new THREE.Vector3();
const _ground = {
  y: 0, nx: 0, ny: 1, nz: 0, surface: 'concrete', hit: false, gap: false,
};

/* ==========================================================================
 * TUNING — the documented constants block.
 *
 * These are the shipped defaults; every chassis in CHASSIS below patches a
 * handful of them. They are copied onto each Vehicle as `vehicle.tuning`,
 * which core/Debug.js turns into live sliders (with "apply to all cars"), so
 * the whole handling model can be dialled in from inside a running race.
 *
 * The ordering matters: Debug caps the inspector at 48 controls, so the knobs
 * that actually get turned during tuning come first.
 * ========================================================================== */

export const VEHICLE_TUNING = {
  /* --- grip ------------------------------------------------------------- */
  // Per-axle multipliers on the tyre model's peak friction. Their RATIO is the
  // car's balance: rear < front understeers, rear > front oversteers. Keep the
  // rear a touch under the front — a mildly loose car is fun, a loose car with
  // a loose front is uncontrollable.
  gripFront: 1.00,
  gripRear: 0.965,

  /* --- engine ----------------------------------------------------------- */
  // Peak crank torque. In first gear this reaches roughly 1.8x the traction
  // limit, so the car will light up the rears off the line — which is the
  // point. Top speed is NOT set here: it is set by `topSpeed` on the chassis
  // and the drag coefficient is solved backwards from it in _calibrate().
  enginePeakTorque: 11.0,
  torquePeakFrac: 0.62,      // where on the rev range peak torque falls
  idleRpm: 1050,
  redlineRpm: 8300,
  finalDrive: 9.0,           // recomputed by _calibrate() to honour topSpeed
  driveEfficiency: 0.94,
  engineBrake: 2.4,          // crank torque of overrun at redline — lift-off feel
  shiftUpFrac: 0.94,         // upshift at this fraction of redline
  shiftDownFrac: 0.52,
  shiftTime: 0.11,           // s of torque interruption
  limiterCut: 0.055,         // s of fuel cut when the limiter bounces
  diffLock: 0.55,            // 0 open .. 1 spool. High = stable, low = spinny

  /* --- brakes ----------------------------------------------------------- */
  brakeTorque: 300,          // total, split by bias. 100 -> 0 in about 29 u
  brakeBias: 0.62,           // fraction to the front axle
  handbrakeTorque: 900,      // enough to lock the rears inside one tick
  handbrakeGrip: 0.58,       // rear lateral mu multiplier while held — the drift
  handbrakeDecay: 0.34,      // s the grip drop lingers after release
  absSlip: 0.30,             // brake modulation starts past this slip ratio
  tractionControl: 0.16,     // driven slip ratio the throttle is trimmed to

  /* --- steering --------------------------------------------------------- */
  // The ratio is speed-sensitive by construction, not by a lookup table: the
  // available lock is the angle that would just saturate the front tyres at
  // the current speed, times steerAuthority. Above 1 you can deliberately
  // overdrive the front and provoke a slide; the value below is generous.
  // "Steering is too steep", reported three times. The first two passes softened
  // the INPUT curve, which was not wrong but was not the cause. Measured yaw rate
  // at full lock, and the response has a cliff in it rather than a slope:
  //
  //   42 u/s   20.8 deg/s   radius 116 u   12 car lengths
  //   49 u/s  104.3 deg/s   radius  27 u  2.8 car lengths   <- five times sharper
  //   65 u/s    3.2 deg/s   radius 1157 u  122 car lengths  <- thirty times duller
  //   82 u/s    1.6 deg/s   radius 2855 u  300 car lengths
  //
  // Seven u/s takes the car from a wide turn to a spin, and sixteen more takes it
  // to no turn at all. Both halves come from the same place. `kinematic` is
  // atan(latCap * wheelbase / v^2), a 1/v-squared curve, so it holds at the
  // steerMaxLow ceiling and then falls off a cliff — and `steerAuthority` above
  // 1.0 deliberately lets the commanded angle EXCEED what the front tyres can
  // hold, which is what turns the 49 u/s case into a snap spin rather than a
  // turn.
  //
  // So: no overdrive by default (authority 1.0), a ceiling low enough that full
  // lock at walking pace is not a pirouette, and a floor high enough that a fast
  // corner is still steerable instead of a straight line. The drift is still
  // available — it is what the handbrake is for, and handbrakeGrip drops the rear
  // mu to 0.42-0.66 per chassis — it just is not what happens by accident at one
  // particular speed.
  steerMaxLow: 30 * DEG,     // full lock, standing still
  steerMinHigh: 8.5 * DEG,   // floor at top speed — never zero
  steerAuthority: 1.02,
  steerRate: 7.2,            // rad/s of lock the input can command
  steerReturn: 11.0,         // rad/s of self-centring with no input
  counterSteerGrip: 1.14,    // front grip bonus while counter-steering

  /* --- suspension ------------------------------------------------------- */
  // Heave frequency lands near 4 Hz with damping ratio 0.7 bump / 1.05 rebound:
  // it settles inside one bounce, which is what stops an arcade car floating.
  springRate: 170,           // force per u of compression, per corner
  damperBump: 9.0,
  damperRebound: 14.0,
  suspRest: 1.30,            // u of travel from full droop to fully bottomed
  bumpStopRate: 1400,        // force per u past 88% travel
  arbFront: 150,             // force per u of left/right compression difference
  arbRear: 132,              // rear < front biases the car toward neutral
  loadTransferBoost: 0.30,   // 0..1 feed-forward on top of the suspension's own

  /* --- drift ------------------------------------------------------------ */
  driftEnter: 0.20,          // rad of body slip that counts as a drift (11.5 deg)
  driftHold: 0.62,           // rad at which driftFactor reaches 1
  driftThrust: 22,           // forward push while drifting, so it stays viable
  driftGripRear: 0.94,       // rear grip trim once committed — sustains the slide

  /* --- assists (see _assists) ------------------------------------------- */
  assistYaw: 3.4,            // yaw-rate damping gain
  assistYawBand: 0.55,       // rad/s of yaw error tolerated before damping bites
  spinCatch: 0.85,           // rad of body slip where the safety net engages
  spinCatchGrip: 0.85,       // rear grip added at full spin risk

  /* --- aero ------------------------------------------------------------- */
  dragCoef: 0.0074,          // solved by _calibrate() from the chassis top speed
  downforceCoef: 0.0105,     // ~40% of weight in extra load at 100 u/s
  aeroBalance: 0.44,         // fraction of downforce on the front axle
  rollingDrag: 1.0,          // multiplier on the surface's rolling resistance

  /* --- airborne --------------------------------------------------------- */
  airPitch: 2.9,             // rad/s2 of player pitch authority
  airRoll: 3.4,
  airYaw: 1.5,
  airLevel: 7.0,             // auto-levelling gain, ramped in with air time
  airLevelDelay: 0.22,       // s of pure ballistics before levelling starts

  /* --- boost ------------------------------------------------------------ */
  boostForce: 27,            // flat thrust — this is what raises top speed
  boostTorque: 1.55,         // engine torque multiplier — this is the punch
  boostDrain: 0.42,          // fuel per second while held
  boostRefill: 0.055,        // passive regeneration per second
  boostDriftCharge: 0.30,    // extra regeneration per second of full drift

  /* --- body ------------------------------------------------------------- */
  mass: 1.0,
  cgHeight: 1.25,            // u above the contact patch — sets weight transfer
  cgBias: 0.50,              // fraction of static weight on the front axle
  wheelbase: 5.6,
  trackWidth: 3.6,
  wheelRadius: 1.15,
  wheelInertia: 0.30,        // deliberately heavy: keeps the slip solve stable
  inertiaYaw: 0.68,          // scale on the box tensor — low = agile
  inertiaRoll: 1.70,
  inertiaPitch: 1.00,
  angularDampRoll: 2.2,      // 1/s, kills residual body oscillation
  angularDampPitch: 1.8,
  airAngularDamp: 0.22,      // 1/s in flight — momentum is meant to be preserved

  /* --- recovery & damage ------------------------------------------------ */
  wallContain: 1,            // 0 disables the built-in barrier constraint
  wallStiffness: 260,
  respawnDelay: 0.85,        // s of falling before the car is put back
  respawnFallDepth: 42,      // u below the ground plane that counts as fallen
  respawnKeepSpeed: 0.42,    // fraction of speed restored, so it is not a stop
  // Wedged-on-a-barrier recovery. See _checkNoProgress: the older beached test
  // gates on speed, and a car grinding against a wall keeps ~5 u/s, so it never
  // fires. These two gate on ADVANCE ALONG THE TRACK instead. 0.04 u per tick at
  // 120 Hz is 4.8 u/s of genuine progress — an order of magnitude below anything
  // a driving car does, so it only catches a car that is truly going nowhere.
  stuckProgressPerTick: 0.04,
  stuckProgressDelay: 2.2,   // s of no progress before the car is put back
  // Ground shallow enough to pull away from. A ramp is exactly where cars come
  // off, so without this the remembered "last good place" is very often ON the
  // ramp and the recovery drops the player back onto the slope they just fell
  // off, facing uphill from a standstill. 9 degrees passes ordinary road camber
  // and banking while rejecting a launch ramp.
  respawnMaxPitch: 9 * DEG,
  // Minimum speed a recovery hands back, as a fraction of top. respawnKeepSpeed
  // scales the speed the car HAD, which after a flip or a wall-stick is zero —
  // so the car was being put back stationary and then had to drag itself away.
  // A gentle roll is enough to get the tyres working and reads as a push rather
  // than as a teleport.
  respawnMinSpeed: 0.18,
  damageScale: 0.0055,       // damage per unit of impact impulse past threshold
  damageThreshold: 26,
  damagePowerLoss: 0.18,     // fraction of power lost at damage = 1
};

/* ==========================================================================
 * CHASSIS ARCHETYPES
 *
 * vehicle/CarModels.js [A7] owns the *look* of the eight cars; this table owns
 * how they drive. Ids are matched loosely (case and punctuation are ignored,
 * and a broad alias list covers the obvious names), and anything unrecognised
 * is hashed onto one of the archetypes — so a car model this file has never
 * heard of still gets a distinct, deliberate handling character rather than a
 * generic default. If CarModels exposes a `physics` or `handling` block on its
 * model definition, that is merged on top.
 * ========================================================================== */

const ARCHETYPES = {
  muscle: {
    label: 'Muscle', drive: 'rwd', topSpeed: 99, mass: 1.14,
    tuning: {
      enginePeakTorque: 13.2, torquePeakFrac: 0.52, redlineRpm: 7200,
      gripFront: 1.02, gripRear: 0.93, cgBias: 0.55, cgHeight: 1.32,
      arbFront: 158, arbRear: 118, diffLock: 0.40, handbrakeGrip: 0.52,
      driftThrust: 27, inertiaYaw: 0.78, downforceCoef: 0.0075,
    },
    gears: [3.35, 2.05, 1.48, 1.16, 0.96],
  },
  kart: {
    label: 'Kart', drive: 'rwd', topSpeed: 88, mass: 0.86,
    tuning: {
      enginePeakTorque: 7.4, torquePeakFrac: 0.72, redlineRpm: 10200,
      gripFront: 1.14, gripRear: 1.11, cgBias: 0.44, cgHeight: 0.92,
      springRate: 260, damperBump: 12, damperRebound: 17,
      arbFront: 210, arbRear: 196, inertiaYaw: 0.48, wheelbase: 4.6,
      steerMaxLow: 38 * DEG, steerRate: 9.0, diffLock: 0.85,
      downforceCoef: 0.006, driftThrust: 14,
    },
    gears: [2.7, 1.75, 1.28, 1.0],
  },
  rally: {
    label: 'Rally', drive: 'awd', topSpeed: 96, mass: 1.02,
    tuning: {
      enginePeakTorque: 10.6, torquePeakFrac: 0.58, redlineRpm: 8000,
      gripFront: 1.03, gripRear: 1.01, cgBias: 0.52, cgHeight: 1.30,
      springRate: 138, damperBump: 8.2, damperRebound: 12.5, suspRest: 1.7,
      arbFront: 122, arbRear: 128, diffLock: 0.72, handbrakeGrip: 0.48,
      driftThrust: 26, assistYaw: 3.8,
    },
    gears: [3.2, 2.15, 1.6, 1.25, 1.0],
  },
  gt: {
    label: 'GT', drive: 'rwd', topSpeed: 106, mass: 1.0,
    tuning: {
      enginePeakTorque: 11.4, torquePeakFrac: 0.66, redlineRpm: 8600,
      gripFront: 1.05, gripRear: 1.02, cgBias: 0.47, cgHeight: 1.12,
      springRate: 196, damperBump: 10.5, damperRebound: 15.5,
      arbFront: 172, arbRear: 150, diffLock: 0.62, downforceCoef: 0.0135,
    },
    gears: [3.1, 2.1, 1.62, 1.3, 1.08, 0.92],
  },
  hotrod: {
    label: 'Hot rod', drive: 'rwd', topSpeed: 101, mass: 1.08,
    tuning: {
      enginePeakTorque: 12.6, torquePeakFrac: 0.5, redlineRpm: 7000,
      gripFront: 1.0, gripRear: 0.90, cgBias: 0.57, cgHeight: 1.36,
      arbFront: 150, arbRear: 108, diffLock: 0.35, handbrakeGrip: 0.46,
      driftThrust: 30, driftGripRear: 0.90, inertiaYaw: 0.72,
      downforceCoef: 0.006,
    },
    gears: [3.5, 1.95, 1.36, 1.02],
  },
  truck: {
    label: 'Pickup', drive: 'awd', topSpeed: 92, mass: 1.22,
    tuning: {
      enginePeakTorque: 12.8, torquePeakFrac: 0.46, redlineRpm: 6400,
      gripFront: 0.96, gripRear: 0.96, cgBias: 0.54, cgHeight: 1.62,
      springRate: 150, damperBump: 9.5, damperRebound: 14.5, suspRest: 1.85,
      arbFront: 118, arbRear: 110, inertiaYaw: 0.92, inertiaRoll: 2.1,
      trackWidth: 3.9, wheelRadius: 1.32, diffLock: 0.78,
      steerMaxLow: 31 * DEG, downforceCoef: 0.005,
    },
    gears: [3.6, 2.3, 1.62, 1.2, 0.98],
  },
  formula: {
    label: 'Open wheel', drive: 'rwd', topSpeed: 112, mass: 0.9,
    tuning: {
      enginePeakTorque: 9.6, torquePeakFrac: 0.78, redlineRpm: 11500,
      gripFront: 1.16, gripRear: 1.13, cgBias: 0.45, cgHeight: 0.86,
      springRate: 285, damperBump: 13, damperRebound: 19, suspRest: 0.95,
      arbFront: 245, arbRear: 228, inertiaYaw: 0.52, wheelbase: 6.1,
      downforceCoef: 0.0215, aeroBalance: 0.47, diffLock: 0.70,
      driftThrust: 12, handbrakeGrip: 0.66,
    },
    gears: [2.9, 2.1, 1.68, 1.4, 1.2, 1.04, 0.92],
  },
  buggy: {
    label: 'Buggy', drive: 'awd', topSpeed: 94, mass: 0.95,
    tuning: {
      enginePeakTorque: 10.0, torquePeakFrac: 0.6, redlineRpm: 8800,
      gripFront: 1.0, gripRear: 1.0, cgBias: 0.46, cgHeight: 1.42,
      springRate: 118, damperBump: 7.4, damperRebound: 11.5, suspRest: 2.15,
      arbFront: 96, arbRear: 104, trackWidth: 4.0, wheelRadius: 1.34,
      diffLock: 0.80, airPitch: 3.6, airRoll: 4.2, downforceCoef: 0.005,
    },
    gears: [3.25, 2.2, 1.62, 1.24, 1.0],
  },
  hatch: {
    label: 'Hot hatch', drive: 'fwd', topSpeed: 95, mass: 0.94,
    tuning: {
      enginePeakTorque: 8.8, torquePeakFrac: 0.68, redlineRpm: 8400,
      gripFront: 1.06, gripRear: 0.99, cgBias: 0.61, cgHeight: 1.16,
      springRate: 182, damperBump: 10, damperRebound: 15,
      arbFront: 140, arbRear: 178, diffLock: 0.50, handbrakeGrip: 0.42,
      driftThrust: 10, wheelbase: 5.2,
    },
    gears: [3.3, 2.1, 1.55, 1.2, 0.98],
  },
  van: {
    label: 'Van', drive: 'fwd', topSpeed: 90, mass: 1.18,
    tuning: {
      enginePeakTorque: 11.0, torquePeakFrac: 0.44, redlineRpm: 6200,
      gripFront: 0.99, gripRear: 0.93, cgBias: 0.60, cgHeight: 1.70,
      springRate: 146, damperBump: 9, damperRebound: 14,
      arbFront: 112, arbRear: 152, inertiaRoll: 2.3, inertiaYaw: 0.95,
      diffLock: 0.45, steerMaxLow: 30 * DEG, downforceCoef: 0.004,
    },
    gears: [3.55, 2.2, 1.5, 1.12, 0.94],
  },
};

const ARCHETYPE_IDS = Object.keys(ARCHETYPES);

// Loose aliasing: A7 can call its cars anything and still get a sane character.
const ALIASES = {
  muscle: 'muscle', stang: 'muscle', charger: 'muscle', bruiser: 'muscle', v8: 'muscle',
  kart: 'kart', gokart: 'kart', mini: 'kart', pod: 'kart', bug: 'kart',
  rally: 'rally', wrc: 'rally', 'group b': 'rally', groupb: 'rally', gravel: 'rally',
  gt: 'gt', sports: 'gt', supercar: 'gt', coupe: 'gt', racer: 'gt', wedge: 'gt',
  hotrod: 'hotrod', rod: 'hotrod', drifter: 'hotrod', drift: 'hotrod', roadster: 'hotrod',
  truck: 'truck', pickup: 'truck', ute: 'truck', monster: 'truck', lorry: 'truck',
  formula: 'formula', f1: 'formula', openwheel: 'formula', single: 'formula', indy: 'formula',
  buggy: 'buggy', dune: 'buggy', offroad: 'buggy', sand: 'buggy', baja: 'buggy',
  hatch: 'hatch', hothatch: 'hatch', compact: 'hatch', shopping: 'hatch',
  van: 'van', bus: 'van', camper: 'van', icecream: 'van', delivery: 'van',
};

function normaliseId(id) {
  return String(id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Stable string hash, so an unknown model id always maps to the same car. */
function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

/**
 * Resolve any model id to a chassis archetype. Never returns null.
 * @param {string} id
 */
export function chassisArchetype(id) {
  const key = normaliseId(id);
  if (ARCHETYPES[key]) return { name: key, ...ARCHETYPES[key] };
  const alias = ALIASES[key];
  if (alias && ARCHETYPES[alias]) return { name: alias, ...ARCHETYPES[alias] };
  // Substring match before falling back to the hash — 'redMuscleCar' should be
  // a muscle car, not a coin toss.
  for (const a in ALIASES) {
    if (a.length >= 3 && key.includes(a)) return { name: ALIASES[a], ...ARCHETYPES[ALIASES[a]] };
  }
  const pick = ARCHETYPE_IDS[hashId(key || 'muscle') % ARCHETYPE_IDS.length];
  return { name: pick, ...ARCHETYPES[pick] };
}

/** Every archetype id, for car-select UIs that want to enumerate handling. */
export const CHASSIS = ARCHETYPES;

/* ==========================================================================
 * Vehicle
 * ========================================================================== */

let _vehicleSerial = 0;

export class Vehicle {
  /**
   * @param {object} ctx shared context
   * @param {object} opts { model, livery, isPlayer, driverName, gridIndex }
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx || {};
    this.opts = opts;
    this.id = opts.id ?? `car${_vehicleSerial}`;
    this.index = opts.gridIndex ?? _vehicleSerial;
    this.name = `vehicle${_vehicleSerial}`;
    _vehicleSerial++;

    this.isPlayer = !!opts.isPlayer;
    this.driverName = opts.driverName || (this.isPlayer ? 'YOU' : `CPU ${this.index}`);
    this.modelId = opts.model ?? 'muscle';
    this.livery = opts.livery ?? this.index;

    /* --- spec & tuning ------------------------------------------------- */

    const arch = chassisArchetype(this.modelId);
    const modelDef = this._modelDefinition(ctx, this.modelId);

    /** Non-numeric chassis metadata. Handling numbers live in `tuning`. */
    this.spec = {
      archetype: arch.name,
      label: modelDef?.name || arch.label,
      drive: (modelDef?.drive || modelDef?.drivetrain || arch.drive || 'rwd').toLowerCase(),
      topSpeed: Number(modelDef?.topSpeed) || arch.topSpeed,
      gears: Array.isArray(modelDef?.gears) && modelDef.gears.length
        ? modelDef.gears.slice()
        : arch.gears.slice(),
      reverseRatio: modelDef?.reverseRatio ?? (arch.gears[0] * 1.05),
      bodyLength: modelDef?.length ?? 9.0,
      bodyWidth: modelDef?.width ?? 4.0,
      bodyHeight: modelDef?.height ?? 2.8,
    };

    /** Flat numeric handling constants. Live-tunable from core/Debug.js. */
    this.tuning = { ...VEHICLE_TUNING, ...arch.tuning, mass: arch.mass ?? VEHICLE_TUNING.mass };
    // A model definition may override handling directly; it wins over the archetype.
    const over = modelDef?.physics || modelDef?.handling || modelDef?.tuning;
    if (over && typeof over === 'object') {
      for (const k in over) {
        if (k in this.tuning && typeof over[k] === 'number' && Number.isFinite(over[k])) {
          this.tuning[k] = over[k];
        }
      }
    }

    this.tires = new TireModel(modelDef?.tires || {});

    /* --- authoritative state ------------------------------------------- */

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();

    // Body basis, refreshed from the quaternion at the top of every tick.
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.left = new THREE.Vector3(1, 0, 0);

    /* --- published telemetry ------------------------------------------- */

    this.speed = 0;               // u/s, magnitude
    this.forwardSpeed = 0;        // u/s along the nose (signed)
    this.lateralSpeed = 0;        // u/s to the car's left (signed)
    this.rpm = this.tuning.idleRpm;
    this.gear = 1;                // -1 reverse, 0 shifting/neutral, 1..N
    this.gearLabel = '1';
    this.slipAngle = 0;           // rad, body slip: velocity vs nose
    this.driftAngle = 0;          // alias, same value — fx reads either
    this.driftFactor = 0;         // 0..1 how committed the slide is
    this.isDrifting = false;
    this.isAirborne = false;
    this.airTime = 0;
    this.wheelContacts = [false, false, false, false];
    this.lateralG = 0;            // in units of gravity
    this.longitudinalG = 0;
    this.engineLoad = 0;          // 0..1 for the engine synth
    this.limiterActive = false;
    this.shifting = false;
    this.wheelSpin = 0;           // 0..1 worst driven-wheel slip
    this.brakeLight = 0;          // 0..1 for VehicleVisual
    this.reverseLight = 0;
    this.surface = 'concrete';
    this.offTrack = false;
    this.trackT = 0;
    this.trackLateral = 0;
    this.lapDistance = 0;

    /* --- boost, damage, condition -------------------------------------- */

    this.boostFuel = 1;
    this.boostAmount = 0;         // 0..1 smoothed, for fx/audio/camera
    this.boosting = false;
    this.damage = 0;              // 0..1, read by VehicleVisual and Race
    this.scuff = 0;               // 0..1 paint scraped off by walls
    this.dirt = 0;                // 0..1 picked up off-track
    this.lastImpact = 0;          // impulse magnitude of the most recent hit
    this.impactAge = 99;
    this.respawnFlash = 0;        // 1 immediately after a respawn, decays

    /* --- controls -------------------------------------------------------- */

    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0 };
    this.throttle = 0;
    this.brake = 0;
    this.steerInput = 0;
    this.handbrake = 0;
    this.boostInput = 0;
    this.steerPos = 0;            // -1..1 smoothed lock position
    this.steerAngle = 0;          // rad, positive = left
    this.frozen = false;          // Race can hold the field on the grid
    this.autoPollInput = true;    // Input.js may take this over

    /* --- wheels ---------------------------------------------------------- */

    const drive = this.spec.drive;
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      this.wheels.push(makeWheelState(i, {
        steered: front,
        driven: drive === 'awd' || (drive === 'fwd' ? front : !front),
        radius: this.tuning.wheelRadius,
      }));
      this.wheels[i].localX = 0;
      this.wheels[i].localY = 0;
      this.wheels[i].localZ = 0;
      this.wheels[i]._surfTick = i; // stagger the surface query across ticks
    }

    /* --- internals ------------------------------------------------------- */

    this._force = new THREE.Vector3();
    this._torque = new THREE.Vector3();
    this._inertia = new THREE.Vector3(1, 1, 1);
    this._invInertia = new THREE.Vector3(1, 1, 1);
    this._angMom = new THREE.Vector3();
    this._prevVelocity = new THREE.Vector3();
    this._pendingImpulse = new THREE.Vector3();
    this._pendingTorqueImpulse = new THREE.Vector3();
    this._shiftTimer = 0;
    this._pendingGear = 0;
    this._limiterTimer = 0;
    this._handbrakeMemory = 0;
    this._reverseHold = 0;
    this._fallTimer = 0;
    this._stuckTimer = 0;
    this._noProgress = 0;      // seconds without advancing along the track
    this._progressT = NaN;     // previous trackT; NaN until the first sample
    this._respawnCooldown = 0;
    this._lastGoodT = 0;
    this._lastGoodLateral = 0;
    this._freeRevRpm = this.tuning.idleRpm;
    this._tick = 0;
    this._controlStamp = -1;
    this._surfaceRec = surfaceRecord('concrete');
    this._trackWarned = false;
    this._physCastBroken = false;
    this._trackHalfWidth = 13;
    this._drivenOmega = 0;
    this._crankTorque = 0;
    this._tyreFx = 0;
    this._tyreFy = 0;
    this._staticComp = 0.3;
    this._mountY = 0;
    this._maxRay = 3;
    this._geoSig = '';
    this.spinRisk = 0;
    this.counterSteer = 0;
    this.yawRate = 0;
    this.yawError = 0;
    this.steerMax = this.tuning.steerMaxLow;
    this.downforce = 0;
    this.topSpeed = this.spec.topSpeed;

    this._calibrate();

    /* --- scene anchor ---------------------------------------------------- */

    // A transform anchor other systems can hang things off (fx emitters,
    // positional audio, the visual). Kept in sync every rendered frame.
    this.group = new THREE.Group();
    this.group.name = `car:${this.id}`;
    this.group.userData.vehicle = this;
    this.visual = null;
    this.visualRoot = null;
    this._visualOwnsTransform = false;

    /* --- physics body ---------------------------------------------------- */

    // Aliases the vehicle's own vectors, so whatever physics/World.js writes is
    // immediately the truth here and vice versa. No copy step, no drift.
    this.body = {
      type: 'box',
      isVehicle: true,
      vehicle: this,
      id: this.id,
      position: this.position,
      quaternion: this.quaternion,
      velocity: this.velocity,
      angularVelocity: this.angularVelocity,
      halfExtents: new THREE.Vector3(
        this.spec.bodyWidth * 0.5,
        this.spec.bodyHeight * 0.5,
        this.spec.bodyLength * 0.5
      ),
      centreOffsetY: this.tuning.cgHeight - this.spec.bodyHeight * 0.5,
      mass: this.tuning.mass,
      invMass: 1 / Math.max(1e-4, this.tuning.mass),
      restitution: 0.32,
      friction: 0.55,
      applyImpulse: (imp, at) => this.applyImpulse(imp, at),
      onContact: (info) => this.onContact(info),
    };

    this._placeOnGrid();
  }

  /* ======================================================================
   * Setup
   * ====================================================================== */

  /** Pull the model definition out of whatever shape CarModels.js exports. */
  _modelDefinition(ctx, id) {
    try {
      const models = ctx?.carModels;
      if (!models) return null;
      if (Array.isArray(models)) {
        return models.find((m) => m && (m.id === id || m.name === id)) || null;
      }
      if (typeof models === 'object') return models[id] || null;
    } catch (_) { /* a malformed model table must not stop a car existing */ }
    return null;
  }

  /**
   * Derive the numbers that are consequences rather than choices.
   *
   * The final drive is solved so the chassis reaches its declared top speed at
   * `shiftUpFrac` of redline in top gear, and the drag coefficient is then
   * solved so that speed is exactly where thrust and drag balance. Change
   * `topSpeed` and the whole drivetrain re-gears itself around it.
   */
  _calibrate() {
    const t = this.tuning;
    const g = this._gravity();
    const gears = this.spec.gears;
    const topGear = gears[gears.length - 1] || 1;
    const top = Math.max(20, this.spec.topSpeed);
    const radius = Math.max(0.2, t.wheelRadius);

    const wheelOmegaTop = top / radius;
    const targetRpm = t.redlineRpm * clamp(t.shiftUpFrac, 0.6, 1.0);
    t.finalDrive = clamp(
      (targetRpm * RADS_PER_RPM) / Math.max(1e-3, wheelOmegaTop * topGear),
      1.5, 40
    );

    const totalTop = topGear * t.finalDrive;
    const forceTop = this._torqueAt(targetRpm) * t.enginePeakTorque * totalTop * t.driveEfficiency / radius;
    const rolling = t.rollingDrag * 0.012 * t.mass * g;
    t.dragCoef = clamp((forceTop - rolling) / (top * top), 0.0008, 0.25);

    // Diagonal inertia of the body box, scaled per axis. Local X is lateral
    // (pitch), Y is up (yaw), Z is forward (roll).
    const m = t.mass;
    const w = this.spec.bodyWidth;
    const h = this.spec.bodyHeight;
    const l = this.spec.bodyLength;
    this._inertia.set(
      (m / 12) * (h * h + l * l) * t.inertiaPitch,
      (m / 12) * (w * w + l * l) * t.inertiaYaw,
      (m / 12) * (w * w + h * h) * t.inertiaRoll
    );
    this._invInertia.set(1 / this._inertia.x, 1 / this._inertia.y, 1 / this._inertia.z);

    // The tyre model's reference load must match this car, or load sensitivity
    // reads every corner as overloaded.
    this.tires.loadRef = (m * g) / 4;

    // Suspension mount height, chosen so the static ride height puts the hubs
    // exactly one wheel radius off the ground. Derived, never authored.
    const staticLoad = (m * g) / 4;
    const staticComp = clamp(staticLoad / Math.max(1, t.springRate), 0.05, t.suspRest * 0.75);
    this._staticComp = staticComp;
    this._mountY = t.wheelRadius + (t.suspRest - staticComp) - t.cgHeight;
    this._maxRay = t.suspRest + t.wheelRadius + 0.6;

    const ht = t.trackWidth * 0.5;
    // cgBias shifts the axles fore/aft about the centre of mass so the static
    // load split is honest — that is what makes a nose-heavy car understeer.
    // Moment balance about the CoM gives a_front / a_rear = F_rear / F_front,
    // so the *lighter* axle sits further out.
    const frontArm = t.wheelbase * (1 - t.cgBias);
    const rearArm = t.wheelbase * t.cgBias;
    const spread = [frontArm, frontArm, -rearArm, -rearArm];
    for (let i = 0; i < 4; i++) {
      const w4 = this.wheels[i];
      w4.localX = (i & 1) === 0 ? ht : -ht;   // even index = left (+X)
      w4.localY = this._mountY;
      w4.localZ = spread[i];
      w4.radius = t.wheelRadius;
      w4.staticLoad = staticLoad * 2 * (w4.front ? t.cgBias : 1 - t.cgBias);
    }

    if (this.body) {
      this.body.mass = t.mass;
      this.body.invMass = 1 / Math.max(1e-4, t.mass);
      this.body.centreOffsetY = t.cgHeight - this.spec.bodyHeight * 0.5;
      this.body.halfExtents.set(
        this.spec.bodyWidth * 0.5, this.spec.bodyHeight * 0.5, this.spec.bodyLength * 0.5
      );
    }
    this.topSpeed = top;
    this._geoSig = this._geometrySignature();
    return this;
  }

  /** Values whose change requires re-deriving gearing, inertia and geometry. */
  _geometrySignature() {
    const t = this.tuning;
    return `${t.mass}|${t.wheelbase}|${t.trackWidth}|${t.wheelRadius}|${t.cgHeight}`
      + `|${t.cgBias}|${t.springRate}|${t.suspRest}|${t.inertiaYaw}|${t.inertiaRoll}`
      + `|${t.inertiaPitch}|${t.redlineRpm}|${t.shiftUpFrac}|${t.enginePeakTorque}`;
  }

  _gravity() {
    return this.ctx?.settings?.physics?.gravity ?? Settings?.physics?.gravity ?? 260;
  }

  /** Normalised engine torque at an rpm. Broad plateau, gentle top-end fade. */
  _torqueAt(rpm) {
    const t = this.tuning;
    const r = clamp(rpm / Math.max(500, t.redlineRpm), 0, 1.12);
    const d = r - clamp(t.torquePeakFrac, 0.2, 0.95);
    const fall = d < 0 ? 1.15 : 1.55;
    return clamp(1 - fall * d * d, 0.28, 1);
  }

  /** Drop the car onto its grid slot (or a sane default if there is no track). */
  _placeOnGrid() {
    const track = this.ctx?.track;
    const slots = track?.spawnPoints;
    if (Array.isArray(slots) && slots.length) {
      const s = slots[this.index % slots.length];
      this.position.copy(s.position);
      this.quaternion.copy(s.quaternion || s.rotation || this.quaternion);
      this._lastGoodT = s.t ?? 0;
      this._lastGoodLateral = s.lateral ?? 0;
    } else {
      this.position.set(this.index * 7 - 24, this.tuning.cgHeight + 0.4, 0);
      this.quaternion.identity();
    }
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this._syncBasis();
    for (const w of this.wheels) {
      w.omega = 0;
      w.compression = this._staticComp;
      w.grounded = true;
    }
    return this;
  }

  /* ======================================================================
   * Lifecycle
   * ====================================================================== */

  async init() {
    const ctx = this.ctx;
    try {
      if (ctx?.scene && !this.group.parent) ctx.scene.add(this.group);
    } catch (_) { /* headless */ }

    this._placeOnGrid();
    this._syncGroup();

    // Register with physics if it exists. Everything is optional-chained: the
    // car must be fully drivable with no physics module at all.
    try { ctx?.physics?.addBody?.(this.body); } catch (err) {
      console.warn('[Vehicle] physics.addBody failed', err);
    }

    await this._buildVisual();
    return this;
  }

  /**
   * Construct this car's mesh from vehicle/VehicleVisual.js [A7].
   *
   * main.js loads that module into ctx.vehicleVisualMod but never constructs
   * it, so the vehicle owns its own visual. Every step is feature-detected and
   * guarded — a missing or throwing visual module costs the car its body, not
   * the game its boot.
   */
  async _buildVisual() {
    const ctx = this.ctx;
    const mod = ctx?.vehicleVisualMod;
    if (!mod) return null;
    const Ctor = mod.VehicleVisual || mod.CarVisual || mod.default || mod.createVehicleVisual || mod.build;
    if (typeof Ctor !== 'function') return null;

    let visual = null;
    try {
      const args = [ctx, this, {
        model: this.modelId,
        livery: this.livery,
        isPlayer: this.isPlayer,
        parent: this.group,
        spec: this.spec,
      }];
      visual = /^\s*class\s/.test(Ctor.toString()) ? new Ctor(...args) : Ctor(...args);
      if (visual && typeof visual.then === 'function') visual = await visual;
      if (visual?.init) await visual.init(ctx, this);
    } catch (err) {
      console.warn(`[Vehicle:${this.id}] visual construction failed`, err);
      return null;
    }
    if (!visual) return null;
    this.visual = visual;

    try {
      if (typeof visual.attach === 'function') {
        visual.attach(this.group);
      } else {
        const root = visual.object3D || visual.group || visual.root || visual.mesh
          || (visual.isObject3D ? visual : null);
        if (root && root.isObject3D) {
          this.visualRoot = root;
          // If the visual publishes an update() it owns its own transform; we
          // must not fight it. Otherwise we parent it and drive it ourselves.
          this._visualOwnsTransform = typeof visual.update === 'function'
            || typeof visual.lateUpdate === 'function';
          if (!root.parent) {
            if (this._visualOwnsTransform) ctx?.scene?.add(root);
            else {
              root.position.set(0, 0, 0);
              root.quaternion.identity();
              this.group.add(root);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Vehicle:${this.id}] visual attach failed`, err);
    }
    return visual;
  }

  /* ======================================================================
   * Controls
   * ====================================================================== */

  /**
   * Set the driver's inputs. Called by ai/Driver.js and by game/Input.js.
   * @param {{throttle?:number, brake?:number, steer?:number, handbrake?:number, boost?:number}} c
   */
  setControls(c) {
    if (!c) return this;
    const t = this.controls;
    if (c.throttle !== undefined) t.throttle = clamp(+c.throttle || 0, 0, 1);
    if (c.brake !== undefined) t.brake = clamp(+c.brake || 0, 0, 1);
    if (c.steer !== undefined) t.steer = clamp(+c.steer || 0, -1, 1);
    if (c.handbrake !== undefined) t.handbrake = clamp(+c.handbrake || 0, 0, 1);
    if (c.boost !== undefined) t.boost = clamp(+c.boost || 0, 0, 1);
    this._controlStamp = this.ctx?.time?.frame ?? this._tick;
    return this;
  }

  /**
   * Read the player's inputs straight off game/Input.js when nothing else has.
   * Input.js's shape is not pinned down by the contract, so several plausible
   * ones are probed; setting `vehicle.autoPollInput = false` hands control back.
   */
  _pollInput() {
    if (!this.isPlayer || !this.autoPollInput) return;
    const frame = this.ctx?.time?.frame ?? this._tick;
    if (this._controlStamp === frame) return; // something already drove us
    const input = this.ctx?.input;
    if (!input) return;
    let s = null;
    try {
      s = (typeof input.getControls === 'function' && input.getControls())
        || (typeof input.getState === 'function' && input.getState())
        || input.controls || input.state || input.axes || null;
    } catch (_) { return; }
    if (!s || typeof s !== 'object') return;

    const num = (...keys) => {
      for (const k of keys) {
        const v = s[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
      }
      return null;
    };
    const throttle = num('throttle', 'accelerate', 'gas', 'accel');
    const brake = num('brake', 'decelerate');
    const steer = num('steer', 'steering', 'x', 'lx', 'turn');
    const handbrake = num('handbrake', 'drift', 'ebrake');
    const boost = num('boost', 'nitro', 'turbo');
    const c = {};
    if (throttle !== null) c.throttle = throttle;
    if (brake !== null) c.brake = brake;
    if (steer !== null) c.steer = steer;
    if (handbrake !== null) c.handbrake = handbrake;
    if (boost !== null) c.boost = boost;
    if (Object.keys(c).length) this.setControls(c);
  }

  /* ======================================================================
   * Fixed-step simulation
   * ====================================================================== */

  fixedUpdate(fdt, ctx) {
    if (!(fdt > 0) || !Number.isFinite(fdt)) return;
    this.ctx = ctx || this.ctx;
    this._tick++;

    const t = this.tuning;
    const g = this._gravity();

    this._syncBasis();
    this._applyPendingImpulses();
    this._latchControls(fdt);

    this._force.set(0, 0, 0);
    this._torque.set(0, 0, 0);

    // Gravity acts on the centre of mass and so contributes no torque.
    this._force.y -= g * t.mass;

    this._updateSteering(fdt, g);
    this._probeWheels();
    this._updateTrackState();
    this._suspension(fdt, g);
    this._drivetrain(fdt);
    this._wheelForces(fdt);
    this._aero();
    this._assists(g);
    if (this.isAirborne) this._airControl();
    if (t.wallContain > 0) this._wallContain(fdt);
    this._integrate(fdt, g);
    this._postState(fdt);

    // Live tuning: if a geometry or drivetrain constant was edited from the
    // debug panel, re-derive everything that depends on it. Checked on a slow
    // cadence because the comparison is a string build.
    if ((this._tick & 31) === 0 && this._geometrySignature() !== this._geoSig) this._calibrate();
  }

  /** Refresh the cached body basis from the orientation quaternion. */
  _syncBasis() {
    const q = this.quaternion;
    if (!Number.isFinite(q.x + q.y + q.z + q.w) || q.lengthSq() < 1e-8) q.identity();
    else if (Math.abs(q.lengthSq() - 1) > 1e-4) q.normalize();
    this.left.set(1, 0, 0).applyQuaternion(q);
    this.up.set(0, 1, 0).applyQuaternion(q);
    this.forward.set(0, 0, 1).applyQuaternion(q);
    return this;
  }

  /** Smooth the raw controls into applied values. Fast enough to feel direct. */
  _latchControls(fdt) {
    const c = this.controls;
    if (this.frozen) {
      this.throttle = 0;
      this.brake = Math.max(this.brake, 0.35);
      this.handbrake = 1;
      this.boostInput = 0;
      this.steerInput = 0;
      return;
    }
    // 30/s: two ticks to full. Imperceptible as lag, but it keeps the torque
    // trace continuous, which the engine synth and the tyre solve both prefer.
    const k = saturate(fdt * 30);

    // REVERSE SWAPS THE PEDALS, and without this the car cannot reverse at all.
    //
    // Playtest: "retro (going backward) does not work". Reverse GEAR engaged
    // correctly — hold brake at a standstill for 0.28 s and `gear` goes to -1,
    // measured. But the car never moved, because the same key is still the
    // brake: engine torque needs throttle, the player is holding brake, so the
    // drivetrain had reverse selected and nothing driving it while the pads
    // clamped the wheels. Measured over 300 steps in reverse gear: speed stayed
    // between -0.34 and +0.19.
    //
    // And there was no other key that could work. `_drivetrain` shifts back to
    // first the moment throttle passes 0.5, so pressing forward in reverse gear
    // just cancels reverse. Neither pedal could ever drive the car backwards.
    //
    // In reverse the pedals swap, which is what every arcade racer does and
    // what a player already expects: the key that selected reverse drives it,
    // and the forward key becomes the brake. The swap happens here, on the
    // resolved inputs, so everything downstream — torque, ABS, brake lights,
    // the engine synth, the AI — sees one consistent story and needs no
    // special case of its own.
    let inThrottle = c.throttle;
    let inBrake = c.brake;
    if (this.gear === -1) {
      inThrottle = c.brake;
      inBrake = c.throttle;
    }
    this.throttle += (inThrottle - this.throttle) * k;
    this.brake += (inBrake - this.brake) * k;
    this.handbrake += (c.handbrake - this.handbrake) * saturate(fdt * 45);
    this.boostInput = c.boost;
    this.steerInput = c.steer;
  }

  /* ---------------------------------------------------------------- steering */

  /**
   * Speed-sensitive ratio without a lookup table.
   *
   * The available lock is the steering angle that would just saturate the
   * front tyres at the current speed (Ackermann against the grip-limited corner
   * radius), scaled by `steerAuthority`. Below ~42 u/s that exceeds full lock,
   * so the car has all of it; above that the lock tapers exactly as fast as the
   * physics needs it to. It is impossible to spin the car with steering input
   * alone, and it never feels like the game took the wheel away.
   */
  _updateSteering(fdt, g) {
    const t = this.tuning;
    const v = Math.max(1, Math.abs(this.forwardSpeed));
    const latCap = this.tires.cornerLimit(g, this._surfaceRec.grip, 1 + t.downforceCoef * this.speed * this.speed / Math.max(1, g * t.mass));
    const kinematic = Math.atan((latCap * t.wheelbase) / (v * v));
    const maxLock = clamp(
      Math.min(t.steerMaxLow, kinematic * t.steerAuthority),
      t.steerMinHigh, t.steerMaxLow
    );
    this.steerMax = maxLock;

    const target = this.steerInput;
    const towardsZero = Math.abs(target) < 0.06 || (target * this.steerPos < 0);
    // Self-centring is faster than application: the car settles straight the
    // moment the stick is released, which is most of what "responsive" means.
    const rate = (towardsZero ? t.steerReturn : t.steerRate) / Math.max(0.08, maxLock);
    const step = rate * fdt;
    const d = target - this.steerPos;
    this.steerPos += clamp(d, -step, step);
    this.steerPos = clamp(this.steerPos, -1, 1);

    // Positive steerAngle is a rotation about +Y, which points the wheels LEFT.
    this.steerAngle = -this.steerPos * maxLock;
    const inner = this.steerAngle;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.steered) { w.steerAngle = 0; continue; }
      // Ackermann: the inside wheel turns further. Subtle at these angles but
      // it stops the front axle scrubbing in slow hairpins.
      const isInside = (inner > 0) === (w.localX > 0);
      w.steerAngle = inner * (isInside ? 1.09 : 0.93);
    }
  }

  /* ------------------------------------------------------------- suspension */

  /**
   * Cast each strut at the ground and record the contact.
   *
   * The cast is a plane intersection against the analytic height field, not a
   * vertical sample: world/Track.js gives an exact height and normal at any
   * (x, z), and intersecting the strut axis with that tangent plane is both
   * cheaper and more correct on ramps and banking than dropping a plumb line.
   * Two refinement iterations converge well inside a millimetre.
   */
  _probeWheels() {
    const t = this.tuning;
    let anyContact = false;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];

      // Strut mount in world space.
      _pt.set(w.localX, w.localY, w.localZ).applyQuaternion(this.quaternion).add(this.position);
      const mx = _pt.x;
      const my = _pt.y;
      const mz = _pt.z;

      // Down the strut, which is the body's -up.
      const dx = -this.up.x;
      const dy = -this.up.y;
      const dz = -this.up.z;

      let hitDist = this._maxRay + 1;
      let gx = mx;
      let gz = mz;
      for (let it = 0; it < 2; it++) {
        this._sampleGround(gx, gz, w, it === 0);
        const denom = dx * _ground.nx + dy * _ground.ny + dz * _ground.nz;
        if (denom > -0.12) {
          // Strut nearly parallel to the surface: fall back to a plumb drop so
          // an inverted or violently pitched car still finds the floor.
          hitDist = dy < -0.05 ? (my - _ground.y) / -dy : this._maxRay + 1;
          break;
        }
        // Intersect the strut with the tangent plane through the sampled point:
        //   t = dot(n, P - origin) / dot(n, dir)
        const px = gx - mx;
        const py = _ground.y - my;
        const pz = gz - mz;
        const d = (_ground.nx * px + _ground.ny * py + _ground.nz * pz) / denom;
        if (!Number.isFinite(d)) { hitDist = this._maxRay + 1; break; }
        hitDist = clamp(d, -2, this._maxRay + 4);
        const ngx = mx + dx * hitDist;
        const ngz = mz + dz * hitDist;
        // A second pass only earns its keep when the first moved the sample
        // point appreciably — on flat ground the strut is vertical and the
        // first hit is already exact.
        const moved = Math.abs(ngx - gx) + Math.abs(ngz - gz);
        gx = ngx;
        gz = ngz;
        if (moved < 0.2) break;
      }

      // Props and track furniture, if a physics world is up. Nearest wins, and
      // only then does its normal replace the track's.
      const phys = this._physicsCast(mx, my, mz, dx, dy, dz, hitDist);
      if (phys > 0 && phys < hitDist) hitDist = phys;

      const reach = t.suspRest + w.radius;
      const compression = reach - hitDist;
      w.contactDistance = hitDist;

      if (compression > 0 && hitDist < this._maxRay) {
        w.compression = Math.min(compression, t.suspRest * 1.22);
        w.compressionN = saturate(w.compression / Math.max(0.05, t.suspRest));
        w.grounded = true;
        anyContact = true;
        // Contact patch and hub, published for fx, decals and the visual.
        w.contactX = mx + dx * hitDist;
        w.contactY = my + dy * hitDist;
        w.contactZ = mz + dz * hitDist;
        w.hubX = mx + dx * (hitDist - w.radius);
        w.hubY = my + dy * (hitDist - w.radius);
        w.hubZ = mz + dz * (hitDist - w.radius);
        w.normalX = _ground.nx;
        w.normalY = _ground.ny;
        w.normalZ = _ground.nz;
      } else {
        w.compression = 0;
        w.compressionN = 0;
        w.grounded = false;
        const droop = t.suspRest;
        w.hubX = mx + dx * droop;
        w.hubY = my + dy * droop;
        w.hubZ = mz + dz * droop;
        w.contactX = w.hubX;
        w.contactY = w.hubY - w.radius;
        w.contactZ = w.hubZ;
        w.normalX = 0; w.normalY = 1; w.normalZ = 0;
      }
      this.wheelContacts[i] = w.grounded;
    }

    this.isAirborne = !anyContact;
  }

  /**
   * Ground height, normal and surface at (x, z), written into _ground.
   * The surface name is refreshed on a 4-tick stagger per wheel: it changes
   * far more slowly than the geometry and costs a spline projection.
   */
  _sampleGround(x, z, w, refreshSurface) {
    const track = this.ctx?.track;
    _ground.hit = false;
    if (!track) {
      _ground.y = 0;
      _ground.nx = 0; _ground.ny = 1; _ground.nz = 0;
      _ground.surface = w.surface || 'concrete';
      return _ground;
    }
    try {
      _ground.y = track.heightAt(x, z);
      if (!Number.isFinite(_ground.y)) _ground.y = 0;
      const n = track.normalAt(x, z, _nrm);
      if (n && Number.isFinite(n.x + n.y + n.z) && n.y > 0.05) {
        _ground.nx = n.x; _ground.ny = n.y; _ground.nz = n.z;
      } else {
        _ground.nx = 0; _ground.ny = 1; _ground.nz = 0;
      }
      _ground.hit = true;
    } catch (err) {
      if (!this._trackWarned) {
        this._trackWarned = true;
        console.warn('[Vehicle] track height query failed; driving on a flat plane', err);
      }
      _ground.y = 0;
      _ground.nx = 0; _ground.ny = 1; _ground.nz = 0;
    }

    if (refreshSurface && (this._tick + w._surfTick) % 4 === 0) {
      try {
        _v4.set(x, _ground.y, z);
        const s = track.surfaceAt(_v4);
        if (typeof s === 'string' && s) w.surface = s;
      } catch (_) { /* keep the last known surface */ }
    }
    _ground.surface = w.surface;
    return _ground;
  }

  /** Optional cast against physics props. Disables itself if the peer throws. */
  _physicsCast(ox, oy, oz, dx, dy, dz, best) {
    const phys = this.ctx?.physics;
    if (!phys || typeof phys.raycast !== 'function' || this._physCastBroken) return -1;
    try {
      _v.set(ox, oy, oz);
      _v2.set(dx, dy, dz);
      const hit = phys.raycast(_v, _v2, this._maxRay, this.body);
      if (hit && hit.hit && Number.isFinite(hit.distance) && hit.distance >= 0 && hit.distance < best) {
        if (hit.normal && Number.isFinite(hit.normal.y) && hit.normal.y > 0.2) {
          _ground.nx = hit.normal.x; _ground.ny = hit.normal.y; _ground.nz = hit.normal.z;
        }
        if (typeof hit.surface === 'string' && hit.surface) _ground.surface = hit.surface;
        return hit.distance;
      }
    } catch (err) {
      this._physCastBroken = true;
      console.warn('[Vehicle] physics.raycast unavailable; using the track height field only', err);
    }
    return -1;
  }

  /**
   * Spring, damper, anti-roll bars and bump stops.
   *
   * Suspension force acts along the ground normal and is applied at the contact
   * patch, which is what generates the pitch and roll moments the whole weight
   * transfer story depends on. The anti-roll bars are a force proportional to
   * the compression difference across an axle; their difference front-to-rear
   * is the strongest single balance knob in the car.
   */
  _suspension(fdt, g) {
    const t = this.tuning;
    const arb = [t.arbFront, t.arbFront, t.arbRear, t.arbRear];
    const bumpTravel = t.suspRest * 0.88;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) { w.suspensionForce = 0; w.load = 0; continue; }

      _nrm.set(w.normalX, w.normalY, w.normalZ);
      _pt.set(w.contactX, w.contactY, w.contactZ);

      // Compression rate measured along the contact normal, from the true
      // velocity of the material point at the patch.
      this._pointVelocity(_pt, _v3);
      const rate = -_v3.dot(_nrm);
      w.compressionRate = rate;

      let force = t.springRate * w.compression;
      force += (rate > 0 ? t.damperBump : t.damperRebound) * rate;

      // Anti-roll bar: the paired wheel on the same axle.
      const other = this.wheels[i ^ 1];
      const diff = w.compression - (other.grounded ? other.compression : 0);
      force += arb[i] * diff;

      // Progressive bump stop — the chassis must never punch through the road.
      if (w.compression > bumpTravel) {
        force += t.bumpStopRate * (w.compression - bumpTravel) * (w.compression - bumpTravel) * 3;
      }

      force = clamp(force, 0, t.mass * g * 8);
      w.suspensionForce = force;

      _v.copy(_nrm).multiplyScalar(force);
      this._addForceAt(_v, _pt);
    }

    // Feed-forward load transfer. The suspension already produces the real
    // thing; this adds a fraction of the geometric instantaneous transfer so
    // the tyres feel it on the same tick the driver asked for it rather than
    // one spring period later. Purely a crispness dial — set it to 0 and the
    // car still transfers weight correctly, just softer.
    const boost = clamp(t.loadTransferBoost, 0, 1);
    const axLong = this.longitudinalG * g;
    const axLat = this.lateralG * g;
    const dLong = boost * t.mass * axLong * t.cgHeight / Math.max(0.5, t.wheelbase);
    const dLat = boost * t.mass * axLat * t.cgHeight / Math.max(0.5, t.trackWidth);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) { w.load = 0; continue; }
      // Accelerating (+axLong) squats the rear and lifts the nose. Cornering
      // left (+axLat, acceleration towards the car's left) loads the OUTSIDE of
      // the corner, which is the right-hand pair — hence the inverted sign on
      // the left-hand wheels (localX > 0).
      const longTerm = (w.front ? -dLong : dLong) * 0.5;
      const latTerm = (w.localX > 0 ? -dLat : dLat) * 0.5;
      w.load = clamp(w.suspensionForce + longTerm + latTerm, 0, t.mass * g * 8);
    }
  }

  /* ------------------------------------------------------------ drivetrain */

  /**
   * Engine, gearbox and differential.
   *
   * rpm follows the driven wheels through the gearing, with a clutch that
   * blends to a free-revving engine below walking pace so the car never stalls
   * and a standing start has something to launch off. Shifts cut torque for
   * `shiftTime`; the limiter chops fuel in short bursts so the engine synth has
   * a real bounce to reproduce rather than a flat ceiling.
   */
  _drivetrain(fdt, g) {
    const t = this.tuning;
    const gears = this.spec.gears;
    const nGears = gears.length;

    /* --- reverse -------------------------------------------------------- */
    // Both tests read the RAW controls, not the latched ones. In reverse
    // `_latchControls` swaps the pedals, so `this.throttle` is the brake key
    // and testing it here would shift straight back out of reverse the instant
    // the player pressed the key that is supposed to drive them backwards.
    const rawThrottle = this.controls.throttle;
    const rawBrake = this.controls.brake;
    if (this.gear >= 0 && Math.abs(this.forwardSpeed) < 3 && rawBrake > 0.55 && rawThrottle < 0.15) {
      this._reverseHold += fdt;
      if (this._reverseHold > 0.28) { this.gear = -1; this._shiftTimer = 0; }
    } else if (this.gear === -1 && rawThrottle > 0.5 && this.forwardSpeed > -1.5) {
      this.gear = 1;
      this._reverseHold = 0;
    } else {
      this._reverseHold = 0;
    }

    /* --- gear selection ------------------------------------------------- */
    if (this._shiftTimer > 0) {
      this._shiftTimer -= fdt;
      if (this._shiftTimer <= 0) {
        this.gear = this._pendingGear;
        this._shiftTimer = 0;
      }
    } else if (this.gear > 0) {
      const up = t.redlineRpm * clamp(t.shiftUpFrac, 0.6, 1);
      const down = t.redlineRpm * clamp(t.shiftDownFrac, 0.2, 0.85);
      if (this.gear < nGears && this.rpm > up && this.throttle > 0.12) {
        this._pendingGear = this.gear + 1;
        this._shiftTimer = t.shiftTime;
        this.ctx?.bus?.emit?.('vehicle:shift', { vehicle: this, gear: this._pendingGear, up: true });
      } else if (this.gear > 1 && this.rpm < down) {
        // Only drop down if the lower gear will not immediately bounce off the
        // limiter — otherwise a trailing throttle causes a shift oscillation.
        const ratioUp = gears[this.gear - 2] / gears[this.gear - 1];
        if (this.rpm * ratioUp < t.redlineRpm * 0.97) {
          this._pendingGear = this.gear - 1;
          this._shiftTimer = t.shiftTime * 0.75;
          this.ctx?.bus?.emit?.('vehicle:shift', { vehicle: this, gear: this._pendingGear, up: false });
        }
      }
    }
    this.shifting = this._shiftTimer > 0;
    this.gearLabel = this.gear === -1 ? 'R' : this.shifting ? '-' : String(this.gear);

    /* --- rpm ------------------------------------------------------------ */
    const ratio = this._gearRatio();
    let drivenOmega = 0;
    let drivenCount = 0;
    for (let i = 0; i < 4; i++) {
      if (this.wheels[i].driven) { drivenOmega += this.wheels[i].omega; drivenCount++; }
    }
    if (drivenCount) drivenOmega /= drivenCount;
    this._drivenOmega = drivenOmega;

    const wheelRpm = Math.abs(drivenOmega * ratio) * RPM_PER_RADS;
    // Free-rev target: what the engine would do with the clutch out.
    const revTarget = lerp(t.idleRpm, t.redlineRpm * 0.94, this.throttle);
    this._freeRevRpm += (revTarget - this._freeRevRpm) * saturate(fdt * (this.throttle > 0.05 ? 6.5 : 3.2));
    const clutchLock = this.shifting ? 0 : smoothstep(1.2, 9, Math.abs(this.forwardSpeed));
    const target = clamp(lerp(this._freeRevRpm, Math.max(wheelRpm, t.idleRpm), clutchLock),
      t.idleRpm, t.redlineRpm * 1.05);
    const follow = saturate(fdt * (target > this.rpm ? 16 : 11));
    this.rpm += (target - this.rpm) * follow;

    /* --- limiter -------------------------------------------------------- */
    if (this._limiterTimer > 0) this._limiterTimer -= fdt;
    if (this.rpm >= t.redlineRpm && this._limiterTimer <= 0) this._limiterTimer = t.limiterCut;
    this.limiterActive = this._limiterTimer > 0;

    /* --- torque --------------------------------------------------------- */
    let crank = this._torqueAt(this.rpm) * t.enginePeakTorque * this.throttle;
    if (this.limiterActive || this.shifting || this.gear === 0) crank = 0;

    // Boost multiplies torque (the punch) and adds a flat force later (the top
    // end). Drift charges it back, which is the loop that makes drifting pay.
    this.boosting = this.boostInput > 0.5 && this.boostFuel > 0.02 && !this.frozen;
    if (this.boosting) {
      crank *= t.boostTorque;
      this.boostFuel = Math.max(0, this.boostFuel - t.boostDrain * fdt);
    } else {
      this.boostFuel = Math.min(1, this.boostFuel
        + (t.boostRefill + t.boostDriftCharge * this.driftFactor) * fdt);
    }
    this.boostAmount += ((this.boosting ? 1 : 0) - this.boostAmount) * saturate(fdt * 9);

    if (Settings?.gameplay?.damage !== false) {
      crank *= 1 - t.damagePowerLoss * this.damage;
    }

    /* --- traction control ------------------------------------------------ */
    let worstSlip = 0;
    for (let i = 0; i < 4; i++) {
      if (this.wheels[i].driven) worstSlip = Math.max(worstSlip, this.wheels[i].slipRatio);
    }
    this.wheelSpin = saturate(worstSlip / 0.6);
    const tcStrength = this._assistLevel() > 0.6 ? 0.72 : 0.24;
    if (worstSlip > t.tractionControl && this.throttle > 0.1 && !this.isAirborne) {
      crank *= 1 - saturate((worstSlip - t.tractionControl) / 0.3) * tcStrength;
    }
    // Airborne wheels have nothing to hold them: cut drive so a jump does not
    // land with the rears at 200 rad/s and instantly spin the car.
    if (this.isAirborne) crank *= 0.25;

    /* --- overrun -------------------------------------------------------- */
    const overrun = -t.engineBrake * (this.rpm / Math.max(500, t.redlineRpm))
      * (1 - this.throttle) * (this.gear === 0 ? 0 : 1);

    const shaft = (crank + overrun) * ratio * t.driveEfficiency;
    this._crankTorque = crank;
    this.engineLoad = saturate(this.throttle * 0.75 + this.wheelSpin * 0.25);

    // Split across the driven wheels; the LSD term is applied per wheel later.
    const share = drivenCount > 0 ? shaft / drivenCount : 0;
    for (let i = 0; i < 4; i++) {
      this.wheels[i].driveTorque = this.wheels[i].driven ? share : 0;
    }
  }

  _gearRatio() {
    const t = this.tuning;
    const gears = this.spec.gears;
    if (this.gear === -1) return -this.spec.reverseRatio * t.finalDrive;
    if (this.gear <= 0) return gears[0] * t.finalDrive;
    return gears[clamp(this.gear - 1, 0, gears.length - 1)] * t.finalDrive;
  }

  /* --------------------------------------------------------- tyre contacts */

  /**
   * Resolve every wheel: build its contact frame, feed the slip state through
   * Tires.js, integrate the wheel's own spin, and apply the result to the body
   * at the contact patch.
   */
  _wheelForces(fdt, g) {
    const t = this.tuning;
    const assist = this._assistLevel();

    /* --- drift state, computed before the tyres so it can modulate them --- */
    const vf = this.forwardSpeed;
    const vl = this.lateralSpeed;
    const drift = Math.abs(vf) > 3 || Math.abs(vl) > 3
      ? Math.atan2(vl, Math.max(0.6, Math.abs(vf))) * (vf < 0 ? -1 : 1)
      : 0;
    this.slipAngle = drift;
    this.driftAngle = drift;
    const driftAbs = Math.abs(drift);
    this.driftFactor = saturate((driftAbs - t.driftEnter) / Math.max(0.02, t.driftHold - t.driftEnter));

    // Handbrake memory: the grip drop lingers so the slide does not snap back
    // the instant the button is released. This is the difference between a
    // drift you can steer and a switch you can flip.
    this._handbrakeMemory = Math.max(
      this.handbrake,
      this._handbrakeMemory - fdt / Math.max(0.02, t.handbrakeDecay)
    );

    // Spin risk drives the safety net. It only ever adds rear grip, so it can
    // save a beginner without ever taking a slide away from someone holding one.
    const spinRisk = saturate((driftAbs - t.spinCatch) / Math.max(0.05, 1.35 - t.spinCatch));
    this.spinRisk = spinRisk;

    // Counter-steering: front wheels pointed down the velocity vector.
    const countering = this.steerPos * drift < -0.02 && driftAbs > t.driftEnter;
    this.counterSteer = countering ? saturate(Math.abs(this.steerPos)) : 0;

    const rearLat =
      lerp(1, t.handbrakeGrip, saturate(this._handbrakeMemory))
      * lerp(1, t.driftGripRear, this.driftFactor)
      * (1 + spinRisk * t.spinCatchGrip * lerp(0.45, 1, assist));
    const frontLat = countering
      ? lerp(1, t.counterSteerGrip, this.counterSteer * lerp(0.4, 1, assist))
      : 1;

    /* --- brake torques --------------------------------------------------- */
    const brakeF = this.brake * t.brakeTorque * t.brakeBias * 0.5;
    const brakeR = this.brake * t.brakeTorque * (1 - t.brakeBias) * 0.5;
    const hand = this._handbrakeMemory * t.handbrakeTorque * 0.5;

    let sumFx = 0;
    let sumFy = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const rec = surfaceRecord(w.surface);
      w.rollDrag = rec.rollDrag;
      w.offTrack = rec.offTrack;

      if (!w.grounded) {
        // Free-spinning: only drive and brake torque act.
        const tau = w.driveTorque - this._brakeTorqueFor(w, brakeF, brakeR, hand, fdt);
        w.omega += (tau * fdt) / Math.max(0.01, t.wheelInertia);
        w.omega = clamp(w.omega, -600, 600);
        this.tires.solve(w, 0, 0, 0, fdt, { grip: rec.grip, hardness: rec.hardness });
        continue;
      }

      /* --- contact frame ------------------------------------------------ */
      _nrm.set(w.normalX, w.normalY, w.normalZ);
      const cs = Math.cos(w.steerAngle);
      const sn = Math.sin(w.steerAngle);
      _fwd.copy(this.forward).multiplyScalar(cs).addScaledVector(this.left, sn);
      _fwd.addScaledVector(_nrm, -_fwd.dot(_nrm));
      if (_fwd.lengthSq() < 1e-8) _fwd.copy(this.forward);
      _fwd.normalize();
      // n x forward gives the car's LEFT, matching the +X convention.
      _lat.crossVectors(_nrm, _fwd).normalize();

      _pt.set(w.contactX, w.contactY, w.contactZ);
      this._pointVelocity(_pt, _v3);
      const vx = _v3.dot(_fwd);
      const vy = _v3.dot(_lat);

      /* --- tyre --------------------------------------------------------- */
      // Camber from body roll. dot(bodyUp, contactLeft) is the sine of the roll
      // angle relative to the road, and the sign convention matches Tires.js:
      // positive means the top of the wheel has leaned to the car's left. The
      // 0.7 stands in for the camber gain a real suspension would recover.
      const camber = Math.asin(clamp(this.up.dot(_lat), -1, 1)) * 0.7;
      const gripAxle = (w.front ? t.gripFront : t.gripRear) * rec.grip;
      const latScale = w.front ? frontLat : rearLat;
      const longScale = w.front ? 1 : lerp(1, 0.86, saturate(this._handbrakeMemory));

      this.tires.solve(w, vx, vy, w.load, fdt, {
        grip: gripAxle,
        latScale,
        longScale,
        camber,
        hardness: rec.hardness,
      });

      /* --- wheel spin, solved semi-implicitly ---------------------------- */
      // Explicit integration of a stiff tyre against a light wheel explodes at
      // 120 Hz. Linearising Fx about the current slip and folding the resulting
      // damping into the update is unconditionally stable and costs one divide.
      const I = Math.max(0.01, t.wheelInertia);
      const cKappa = this.tires.bLong * this.tires.cLong * w.fxMax;
      const kw = (cKappa * w.radius * w.radius) / Math.max(this.tires.minSlipSpeed, Math.abs(vx));
      let tau = w.driveTorque - w.fx * w.radius;
      tau -= this._brakeTorqueFor(w, brakeF, brakeR, hand, fdt);
      // LSD: viscous coupling to the paired wheel keeps an axle from tramping.
      if (w.driven) {
        const other = this.wheels[i ^ 1];
        if (other.driven) tau += t.diffLock * 0.85 * (other.omega - w.omega);
      }
      const dOmega = (tau * fdt / I) / (1 + kw * fdt / I);
      w.omega = clamp(w.omega + dOmega, -700, 700);

      /* --- rolling resistance ------------------------------------------- */
      const roll = -Math.sign(vx) * Math.min(
        w.rollDrag * t.rollingDrag * w.load,
        Math.abs(vx) * w.load * 0.5
      );

      /* --- apply -------------------------------------------------------- */
      _v.copy(_fwd).multiplyScalar(w.fx + roll).addScaledVector(_lat, w.fy);
      this._addForceAt(_v, _pt);
      sumFx += w.fx;
      sumFy += w.fy;
      w.spinAngle += w.omega * fdt;
    }

    this._tyreFx = sumFx;
    this._tyreFy = sumFy;

    /* --- drift thrust ---------------------------------------------------- */
    // A drift that only ever costs speed is a punishment, not a technique.
    if (this.driftFactor > 0 && !this.isAirborne && this.throttle > 0.2) {
      _v.copy(this.forward).multiplyScalar(
        t.driftThrust * this.driftFactor * this.throttle * t.mass
      );
      this._force.add(_v);
    }

    this.isDrifting = this.driftFactor > 0.25 && this.speed > 16 && !this.isAirborne;
  }

  /** Brake torque for one wheel, clamped so it can never reverse the spin. */
  _brakeTorqueFor(w, brakeF, brakeR, hand, fdt) {
    const t = this.tuning;
    let torque = w.front ? brakeF : brakeR;
    if (!w.front) torque += hand;
    if (torque <= 0) return 0;

    // ABS: back off a wheel that has passed the lockup slip. Not available on
    // the handbrake — locking the rears on demand is the point of it.
    if (w.front || hand < 0.05) {
      const lock = -w.slipRatio;
      if (lock > t.absSlip && Math.abs(w.vx) > 6) {
        const cut = this._assistLevel() > 0.6 ? 0.85 : 0.45;
        torque *= 1 - saturate((lock - t.absSlip) / 0.35) * cut;
      }
    }
    const stopping = Math.abs(w.omega) * Math.max(0.01, t.wheelInertia) / Math.max(1e-4, fdt);
    return Math.sign(w.omega || 1) * Math.min(torque, stopping + Math.abs(w.fx * w.radius));
  }

  /* -------------------------------------------------------------------- aero */

  /**
   * Quadratic drag plus speed-squared downforce, split across the axles so it
   * loads them the way a real wing would rather than just pressing on the
   * centre of mass.
   */
  _aero() {
    const t = this.tuning;
    const v = this.speed;
    if (v > 0.05) {
      _v.copy(this.velocity).multiplyScalar(-t.dragCoef * v);
      this._force.add(_v);
    }

    // Only push down when the car is the right way up: an inverted car should
    // fall, not be sucked onto the ceiling.
    const upright = saturate(this.up.y);
    const down = t.downforceCoef * v * v * upright;
    if (down > 0.01) {
      const front = down * clamp(t.aeroBalance, 0.1, 0.9);
      const rear = down - front;
      _v.copy(this.up).multiplyScalar(-front);
      _pt.copy(this.position).addScaledVector(this.forward, t.wheelbase * 0.5);
      this._addForceAt(_v, _pt);
      _v.copy(this.up).multiplyScalar(-rear);
      _pt.copy(this.position).addScaledVector(this.forward, -t.wheelbase * 0.5);
      this._addForceAt(_v, _pt);
      this.downforce = down;
    } else {
      this.downforce = 0;
    }
  }

  /* ----------------------------------------------------------------- assists */

  /** 1 with assists on, 0.35 with them off — never 0. The contract requires the
   *  car to be recoverable at all times; assists change how much help, not
   *  whether there is any. */
  _assistLevel() {
    const on = this.ctx?.settings?.gameplay?.assists ?? Settings?.gameplay?.assists ?? true;
    return on ? 1 : 0.35;
  }

  /**
   * Yaw stabilisation.
   *
   * The reference is the kinematic yaw rate the current steering angle implies.
   * Rotating faster than that means the car is oversteering; the assist damps
   * the excess, but only past a deadband wide enough that an intentional drift
   * passes straight through it, and with a gain that climbs steeply as the car
   * approaches a genuine spin. A skilled player never feels it; a beginner
   * never spins.
   */
  _assists(fdt, g) {
    if (this.isAirborne) return;
    const t = this.tuning;
    const assist = this._assistLevel();
    const yawRate = this.angularVelocity.dot(this.up);
    const vf = this.forwardSpeed;
    const yawTarget = (vf * Math.tan(this.steerAngle)) / Math.max(0.5, t.wheelbase);
    const err = yawRate - yawTarget;
    this.yawRate = yawRate;
    this.yawError = err;

    const band = t.assistYawBand * lerp(1.8, 1, assist);
    const excess = Math.abs(err) - band;
    if (excess > 0 && this.speed > 8) {
      // Gain climbs with spin risk and with counter-steer input: helping the
      // player's own correction is far less intrusive than overriding it.
      const gain = t.assistYaw * assist
        * (1 + this.spinRisk * 3.2)
        * (1 + this.counterSteer * 0.9)
        * smoothstep(8, 26, this.speed);
      const torque = -Math.sign(err) * excess * gain * this._inertia.y;
      // Capped at a fraction of what the tyres themselves can generate, so the
      // assist can never be the dominant term in the yaw balance.
      const cap = t.mass * g * t.wheelbase * 0.4;
      _v.copy(this.up).multiplyScalar(clamp(torque, -cap, cap));
      this._torque.add(_v);
    }

    // Low-speed parking damping: without it a stationary car jitters on its
    // springs as the tyre solve fights rounding noise.
    if (this.speed < 3) {
      _v.copy(this.angularVelocity).multiplyScalar(-2.5 * this._inertia.y * saturate(1 - this.speed / 3));
      this._torque.add(_v);
    }

    // Explicit roll and pitch damping in the body frame. The dampers already do
    // most of this; these terms guarantee the body never rings.
    _v.copy(this.angularVelocity);
    const rollRate = _v.dot(this.forward);
    const pitchRate = _v.dot(this.left);
    _v2.copy(this.forward).multiplyScalar(-rollRate * t.angularDampRoll * this._inertia.z);
    this._torque.add(_v2);
    _v2.copy(this.left).multiplyScalar(-pitchRate * t.angularDampPitch * this._inertia.x);
    this._torque.add(_v2);
    void fdt;
  }

  /**
   * Airborne behaviour.
   *
   * Angular momentum is preserved by the integrator (see _integrate), so a car
   * launched with a spin keeps it. On top of that the player gets a small,
   * deliberately limited amount of pitch, roll and yaw authority — enough to
   * straighten a landing, never enough to fly. After `airLevelDelay` an
   * auto-leveller fades in and rotates the car towards the surface below, which
   * is what stops a long jump from ending on the roof.
   */
  _airControl(fdt) {
    const t = this.tuning;
    const assist = this._assistLevel();

    // Player authority. Pitch on throttle/brake, roll on steering — the arcade
    // convention, and the one that reads instantly without a tutorial.
    const pitch = (this.brake - this.throttle) * t.airPitch;
    const roll = -this.steerInput * t.airRoll;
    const yaw = -this.steerInput * t.airYaw;
    _v.copy(this.left).multiplyScalar(pitch * this._inertia.x);
    this._torque.add(_v);
    _v.copy(this.forward).multiplyScalar(roll * this._inertia.z);
    this._torque.add(_v);
    _v.copy(this.up).multiplyScalar(yaw * this._inertia.y);
    this._torque.add(_v);

    // Light damping only — the point of the airborne case is that momentum is
    // conserved, so this must stay small enough to read as air resistance.
    _v.copy(this.angularVelocity).multiplyScalar(-t.airAngularDamp);
    _v.x *= this._inertia.x; _v.y *= this._inertia.y; _v.z *= this._inertia.z;
    this._torque.add(_v);

    // Auto-level, ramping in with air time.
    const ramp = smoothstep(t.airLevelDelay, t.airLevelDelay + 0.7, this.airTime);
    if (ramp > 0.001) {
      _nrm.set(0, 1, 0);
      const track = this.ctx?.track;
      if (track?.normalAt) {
        try {
          const n = track.normalAt(this.position.x, this.position.z, _v4);
          if (n && n.y > 0.1) _nrm.copy(n);
        } catch (_) { /* flat fallback */ }
      }
      // Torque along the axis that rotates `up` onto the surface normal.
      _v.crossVectors(this.up, _nrm);
      const sin = _v.length();
      if (sin > 1e-4) {
        const angle = Math.asin(clamp(sin, -1, 1));
        const dir = this.up.dot(_nrm) < 0 ? Math.PI - angle : angle;
        _v.multiplyScalar(dir / sin);
        const gain = t.airLevel * ramp * lerp(0.55, 1, assist);
        _v.multiplyScalar(gain);
        // Critically damped: subtract the component of spin already correcting.
        _v2.copy(this.angularVelocity).multiplyScalar(-2 * Math.sqrt(Math.max(0.01, gain)) * 0.7);
        _v.add(_v2);
        _v.x *= this._inertia.x; _v.y *= this._inertia.y; _v.z *= this._inertia.z;
        this._torque.add(_v);
      }
    }
    void fdt;
  }

  /* ------------------------------------------------------------------ walls */

  /**
   * Keep the car inside the barriers TrackBuilder raised.
   *
   * physics/World.js [A8] owns real collision; this is a soft constraint so the
   * game is playable and the walls are solid even before that module lands.
   * Set `tuning.wallContain = 0` to hand the job over.
   */
  _wallContain(fdt) {
    const track = this.ctx?.track;
    const walls = track?.walls;
    if (!Array.isArray(walls) || !walls.length || !track.sampleAt) return;

    const t = this.trackT;
    const lateral = this.trackLateral;
    const half = this._trackHalfWidth;
    const side = lateral >= 0 ? 1 : -1;

    let limit = Infinity;
    for (let i = 0; i < walls.length; i++) {
      const wl = walls[i];
      if (wl.side !== 0 && wl.side !== side) continue;
      if (!withinSpan(t, wl.from, wl.to)) continue;
      const off = half + (wl.offset ?? 5.5) - this.spec.bodyWidth * 0.45;
      if (off < limit) limit = off;
    }
    if (!Number.isFinite(limit)) return;

    const over = Math.abs(lateral) - limit;
    if (over <= 0) return;

    try {
      const s = track.sampleAt(this.trackT);
      const hl = Math.hypot(s.right.x, s.right.z) || 1;
      _v2.set(s.right.x / hl, 0, s.right.z / hl).multiplyScalar(-side);
      const closing = -this.velocity.dot(_v2);
      const push = this.tuning.wallStiffness * over * this.tuning.mass
        + Math.max(0, closing) * 12 * this.tuning.mass;
      _v.copy(_v2).multiplyScalar(push);
      this._force.add(_v);
      // Scraping a barrier takes the paint off. Fast on impact, slow on a rub.
      const rub = Math.abs(this.velocity.dot(_v2.set(s.tangent.x, 0, s.tangent.z).normalize()));
      this.scuff = Math.min(1, this.scuff + (rub * 0.00016 + Math.max(0, closing) * 0.0009) * fdt * 60);
      if (closing > 26) this.onContact({ impulse: closing * 0.35 * this.tuning.mass, kind: 'wall' });
    } catch (_) { /* a malformed wall record must not stop the car */ }
  }

  /* -------------------------------------------------------------- integrate */

  /**
   * Semi-implicit Euler for the linear state, and an angular-momentum update
   * for the rotation.
   *
   * The angular step is deliberately not `omega += Iinv * torque * dt`. It
   * converts to world-space angular momentum, integrates *that*, and converts
   * back through the *new* orientation. With zero torque this conserves L
   * exactly, which is what the contract means by "airborne cars keep angular
   * momentum" — including the free precession of a tumbling body, for free.
   */
  _integrate(fdt, g) {
    const t = this.tuning;
    const invMass = 1 / Math.max(1e-4, t.mass);

    this._prevVelocity.copy(this.velocity);

    this.velocity.addScaledVector(this._force, invMass * fdt);
    if (!Number.isFinite(this.velocity.lengthSq())) this.velocity.set(0, 0, 0);
    // A hard ceiling well above any legitimate speed. Purely a guard against a
    // pathological contact; it is never reached in play.
    const vmax = this.topSpeed * 2.2 + 60;
    if (this.velocity.lengthSq() > vmax * vmax) this.velocity.setLength(vmax);
    this.position.addScaledVector(this.velocity, fdt);

    // L = I_world * omega, in the CURRENT orientation.
    this._worldInertiaMul(this.angularVelocity, this._angMom, false);
    this._angMom.addScaledVector(this._torque, fdt);

    // Integrate the orientation with the current spin.
    const w = this.angularVelocity;
    const q = this.quaternion;
    const hx = w.x * 0.5 * fdt;
    const hy = w.y * 0.5 * fdt;
    const hz = w.z * 0.5 * fdt;
    const nx = q.x + (hx * q.w + hy * q.z - hz * q.y);
    const ny = q.y + (hy * q.w + hz * q.x - hx * q.z);
    const nz = q.z + (hz * q.w + hx * q.y - hy * q.x);
    const nw = q.w - (hx * q.x + hy * q.y + hz * q.z);
    q.set(nx, ny, nz, nw);
    if (!Number.isFinite(q.lengthSq()) || q.lengthSq() < 1e-9) q.identity();
    else q.normalize();

    // omega = I_world(new)^-1 * L.
    this._worldInertiaMul(this._angMom, this.angularVelocity, true);
    const amax = 26;
    if (this.angularVelocity.lengthSq() > amax * amax) this.angularVelocity.setLength(amax);
    if (!Number.isFinite(this.angularVelocity.lengthSq())) this.angularVelocity.set(0, 0, 0);

    this._syncBasis();

    // Accelerations, published in units of gravity, and fed back into the
    // load-transfer feed-forward on the next tick.
    _v.subVectors(this.velocity, this._prevVelocity).multiplyScalar(1 / Math.max(1e-5, fdt));
    _v.y += g;
    this.longitudinalG = _v.dot(this.forward) / g;
    this.lateralG = _v.dot(this.left) / g;

    this.speed = this.velocity.length();
    this.forwardSpeed = this.velocity.dot(this.forward);
    this.lateralSpeed = this.velocity.dot(this.left);
  }

  /**
   * out = I_world^(+/-1) * v, using the diagonal local tensor.
   * @param {boolean} inverse true for the inverse tensor
   */
  _worldInertiaMul(v, out, inverse) {
    _q2.copy(this.quaternion).conjugate();
    out.copy(v).applyQuaternion(_q2);
    const I = inverse ? this._invInertia : this._inertia;
    out.x *= I.x; out.y *= I.y; out.z *= I.z;
    out.applyQuaternion(this.quaternion);
    return out;
  }

  /** Velocity of the material point at a world position. */
  _pointVelocity(point, out) {
    _v2.subVectors(point, this.position);
    out.crossVectors(this.angularVelocity, _v2).add(this.velocity);
    return out;
  }

  /** Accumulate a world-space force acting at a world-space point. */
  _addForceAt(force, point) {
    this._force.add(force);
    _v2.subVectors(point, this.position);
    _v3.crossVectors(_v2, force);
    this._torque.add(_v3);
    return this;
  }

  /* ---------------------------------------------------------- track & state */

  /** Where we are on the circuit — cached once per tick for everyone. */
  _updateTrackState() {
    const track = this.ctx?.track;
    if (!track) return;
    try {
      if (typeof track.projectXZ === 'function') {
        const p = track.projectXZ(this.position.x, this.position.z);
        this.trackT = p.t;
        this.trackLateral = p.lateral;
        this._trackHalfWidth = p.halfWidth;
        this.lapDistance = p.distance;
      } else {
        this.trackT = track.nearestT?.(this.position) ?? 0;
        this.trackLateral = track.lateralOf?.(this.position) ?? 0;
        this._trackHalfWidth = (track.widthAt?.(this.trackT) ?? 26) * 0.5;
        this.lapDistance = this.trackT * (track.length || 1);
      }
    } catch (_) {
      this._trackHalfWidth = this._trackHalfWidth || 13;
    }

    // The reference surface, used by the steering-limit solve. Takes the best
    // of the four contact patches so a car half on the grass still steers.
    let best = null;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const rec = surfaceRecord(w.surface);
      if (!best || rec.grip > best.grip) best = rec;
    }
    if (best) {
      this._surfaceRec = best;
      this.surface = best.name;
    }
    this.offTrack = Math.abs(this.trackLateral) > this._trackHalfWidth;
  }

  /**
   * Post-integration bookkeeping: drift and air timers, dirt and damage, and
   * the fall/flip detection that puts a lost car back on the road.
   */
  _postState(fdt, g) {
    const t = this.tuning;

    if (this.isAirborne) this.airTime += fdt;
    else if (this.airTime > 0) {
      if (this.airTime > 0.22) {
        this.ctx?.bus?.emit?.('vehicle:land', {
          vehicle: this, airTime: this.airTime, speed: this.speed,
        });
      }
      this.airTime = 0;
    }

    if (this.impactAge < 99) this.impactAge += fdt;
    if (this.respawnFlash > 0) this.respawnFlash = Math.max(0, this.respawnFlash - fdt * 1.6);
    if (this._respawnCooldown > 0) this._respawnCooldown -= fdt;

    // Dirt: picked up on loose ground, worn off on hard ground under load.
    let loose = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (w.grounded && w.offTrack) loose++;
    }
    if (loose) this.dirt = Math.min(1, this.dirt + loose * 0.09 * fdt);
    else if (!this.isAirborne) this.dirt = Math.max(0, this.dirt - 0.035 * fdt);

    this.brakeLight = Math.max(this.brake, this._handbrakeMemory * 0.8);
    this.reverseLight = this.gear === -1 ? 1 : 0;

    // Remember the last place the car was unambiguously on the road, so a
    // respawn puts it somewhere it can actually drive away from.
    //
    // "Drive away from" has to include the GRADIENT, and it did not. Playtest:
    // a car flipped on a ramp, the recovery put it back in the middle of that
    // same ramp, and it then had to pull away uphill from a standing start —
    // slower than the crash it was rescuing the player from. A ramp is exactly
    // where cars come off, so the last on-road point before a fall is very
    // often ON the ramp, which made the worst case the most likely one.
    //
    // Requiring shallow ground here means the remembered point walks back to
    // the flat road before the ramp on its own, with no extra search.
    if (!this.isAirborne && !this.offTrack && this.speed > 2 && this.up.y > 0.6
        && Math.abs(this._roadPitchAt(this.trackT, this.trackLateral)) < this.tuning.respawnMaxPitch) {
      this._lastGoodT = this.trackT;
      this._lastGoodLateral = clamp(this.trackLateral, -this._trackHalfWidth * 0.55, this._trackHalfWidth * 0.55);
    }

    this._checkRecovery(fdt, g);
  }

  /**
   * Climb angle of the road at `t`, in radians. Positive is uphill.
   *
   * Sampled over 6 u of arc rather than differentiated, because the surface
   * function carries ramps and kerbs as real geometry and a point derivative
   * would read the lip of a ramp as vertical.
   */
  _roadPitchAt(t, lateral = 0) {
    const track = this.ctx?.track;
    if (!track?.surfacePoint || !(track.length > 0) || !Number.isFinite(t)) return 0;
    const dt = 6 / track.length;
    try {
      track.surfacePoint(t, lateral, _pitchA);
      track.surfacePoint((t + dt) % 1, lateral, _pitchB);
    } catch (_) {
      return 0;
    }
    const dy = _pitchB.y - _pitchA.y;
    const flat = Math.hypot(_pitchB.x - _pitchA.x, _pitchB.z - _pitchA.z);
    return flat > 1e-4 ? Math.atan2(dy, flat) : 0;
  }

  /** Fall, flip and out-of-bounds detection. */
  _checkRecovery(fdt) {
    if (this._respawnCooldown > 0) return;
    const t = this.tuning;
    const track = this.ctx?.track;
    const groundY = track?.groundY ?? 0;

    let fallen = this.position.y < groundY - t.respawnFallDepth;
    if (!fallen && track?.bounds) {
      const b = track.bounds;
      const pad = 90;
      fallen = this.position.x < b.min.x - pad || this.position.x > b.max.x + pad
        || this.position.z < b.min.z - pad || this.position.z > b.max.z + pad;
    }
    if (fallen) { this.respawn(this._lastGoodT); return; }

    // Falling into a gap: airborne, descending, and already below the road.
    if (this.isAirborne && this.velocity.y < -12 && this.position.y < groundY - 6) {
      this._fallTimer += fdt;
      if (this._fallTimer > t.respawnDelay) { this.respawn(this._lastGoodT); return; }
    } else if (this.airTime < 0.05) {
      this._fallTimer = 0;
    }

    // Beached: upside down or wedged, and going nowhere.
    if (this.speed < 6 && (this.up.y < 0.25 || (this.offTrack && this.speed < 2.5))) {
      this._stuckTimer += fdt;
      if (this._stuckTimer > (this.up.y < 0.25 ? 1.9 : 4.2)) this.respawn(this._lastGoodT);
    } else {
      this._stuckTimer = 0;
    }

    this._checkNoProgress(fdt);
  }

  /**
   * Wedged against a barrier from the outside, which the beached test cannot see.
   *
   * Playtest: "I often find myself in a position like this, and accelerating or
   * turning does not allow me to continue. The only solution seems to be reverse
   * and restart, but that takes a lot of time." The screenshot was a car OUTSIDE
   * the barrier, nose-on, with the wall between it and the road.
   *
   * Reproduced: placed outside the barrier facing back at it, full throttle and
   * full steer for 7.5 seconds — the car moved 0.9 u total and sat at a steady
   * -5 u/s, grinding. The beached test above never fires there, and the reason
   * is the same mistake this project has made three times now in other places:
   * IT MEASURES A PROXY INSTEAD OF THE THING. A car pinned on a wall keeps about
   * 5 u/s of wheel speed, comfortably above the `speed < 2.5` gate, so by that
   * test it is driving. It is not driving. It is going nowhere.
   *
   * So measure what actually matters: progress ALONG THE TRACK. `trackT` is the
   * spline parameter, so the wrap has to be removed before differencing or the
   * start line reads as a full lap of progress in one tick. A car that has not
   * advanced a car length in this many seconds is stuck no matter what its
   * wheels are doing.
   *
   * Deliberately generous on time and strict on distance: respawning a player
   * who was about to recover is worse than two extra seconds of trying, but a
   * car that has genuinely covered nothing should not have to reverse out.
   */
  _checkNoProgress(fdt) {
    const t = this.tuning;

    // Never while held on the grid, mid-respawn, or legitimately stationary
    // before the flag — the clock only runs once the car is meant to be racing.
    if (this.frozen || this._respawnCooldown > 0) { this._noProgress = 0; return; }
    if (!Number.isFinite(this.trackT)) { this._noProgress = 0; return; }

    const prev = this._progressT;
    this._progressT = this.trackT;
    if (!Number.isFinite(prev)) { this._noProgress = 0; return; }

    // Shortest signed distance around the loop, so the seam is not a jump.
    let d = this.trackT - prev;
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;
    const advanced = Math.abs(d) * (this.ctx?.track?.length || 1800);

    // A car doing anything useful covers far more than this per tick; the
    // threshold only has to exclude numerical jitter while it is pinned.
    if (advanced > t.stuckProgressPerTick) { this._noProgress = 0; return; }

    this._noProgress += fdt;
    if (this._noProgress > t.stuckProgressDelay) {
      this._noProgress = 0;
      this.respawn(this._lastGoodT);
    }
  }

  /* ======================================================================
   * Per-frame (render rate)
   * ====================================================================== */

  update(dt, ctx) {
    this.ctx = ctx || this.ctx;
    this._pollInput();
    this._syncGroup();
    if (this.visual) {
      try { this.visual.update?.(dt, ctx, this); } catch (err) {
        this.visual = null;
        console.warn(`[Vehicle:${this.id}] visual update failed; visual detached`, err);
      }
    }
  }

  lateUpdate(dt, ctx) {
    if (this.visual?.lateUpdate) {
      try { this.visual.lateUpdate(dt, ctx, this); } catch (_) { /* already warned */ }
    }
  }

  /** Keep the scene anchor (and a self-transforming visual) on the body. */
  _syncGroup() {
    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quaternion);
    this.group.updateMatrix();
    if (this.visualRoot && this._visualOwnsTransform === false && this.visualRoot.parent !== this.group) {
      this.visualRoot.position.copy(this.position);
      this.visualRoot.quaternion.copy(this.quaternion);
    }
  }

  /* ======================================================================
   * Public API
   * ====================================================================== */

  /**
   * Contract API: an impulse at a world point. Deferred to the next fixed step
   * so a collision resolved mid-frame lands in the integrator rather than
   * mutating state that the current tick has already read.
   * @param {THREE.Vector3} impulse
   * @param {THREE.Vector3} [atPoint] world-space; defaults to the centre of mass
   */
  applyImpulse(impulse, atPoint) {
    if (!impulse || !Number.isFinite(impulse.x + impulse.y + impulse.z)) return this;
    this._pendingImpulse.add(impulse);
    if (atPoint) {
      _v2.subVectors(atPoint, this.position);
      _v3.crossVectors(_v2, impulse);
      this._pendingTorqueImpulse.add(_v3);
    }
    const mag = impulse.length();
    if (mag > this.tuning.damageThreshold) this.onContact({ impulse: mag });
    return this;
  }

  _applyPendingImpulses() {
    if (this._pendingImpulse.lengthSq() > 1e-10) {
      this.velocity.addScaledVector(this._pendingImpulse, 1 / Math.max(1e-4, this.tuning.mass));
      this._pendingImpulse.set(0, 0, 0);
    }
    if (this._pendingTorqueImpulse.lengthSq() > 1e-10) {
      this._worldInertiaMul(this._pendingTorqueImpulse, _v3, true);
      this.angularVelocity.add(_v3);
      this._pendingTorqueImpulse.set(0, 0, 0);
    }
  }

  /**
   * Record a collision. physics/World.js can call this directly from its
   * contact callback; applyImpulse() calls it for anything hard enough.
   * @param {{impulse?:number, kind?:string, other?:object}} info
   */
  onContact(info) {
    const mag = Math.abs(info?.impulse ?? 0);
    if (!(mag > 0)) return this;
    this.lastImpact = mag;
    this.impactAge = 0;
    if (Settings?.gameplay?.damage !== false) {
      const t = this.tuning;
      if (mag > t.damageThreshold) {
        this.damage = Math.min(1, this.damage + (mag - t.damageThreshold) * t.damageScale);
      }
      this.scuff = Math.min(1, this.scuff + mag * 0.0022);
    }
    this.ctx?.bus?.emit?.('vehicle:impact', {
      vehicle: this, impulse: mag, kind: info?.kind || 'hit', other: info?.other || null,
    });
    return this;
  }

  /**
   * Contract API: put the car back on the track at spline parameter t.
   * @param {number} [t] defaults to the last point the car was cleanly on-track
   * @param {{lateral?:number, keepSpeed?:number, silent?:boolean}} [opts]
   */
  respawn(t, opts = {}) {
    const track = this.ctx?.track;
    const target = Number.isFinite(t) ? t : this._lastGoodT;
    const lateral = opts.lateral ?? this._lastGoodLateral ?? 0;
    const keep = opts.keepSpeed ?? this.tuning.respawnKeepSpeed;
    // Floor it: a car recovered from a flip or a wall has no speed to scale, and
    // handing it back stationary is what made the ramp case worse than the crash.
    const speed = Math.max(
      Math.min(this.speed, this.topSpeed) * clamp(keep, 0, 1),
      this.topSpeed * clamp(opts.minSpeed ?? this.tuning.respawnMinSpeed ?? 0, 0, 1)
    );

    if (track?.respawnAt) {
      try {
        const r = track.respawnAt(target, lateral);
        this.position.copy(r.position);
        this.quaternion.copy(r.quaternion);
      } catch (_) { this._placeOnGrid(); }
    } else if (track?.sampleAt && track?.surfacePoint) {
      try {
        const s = track.sampleAt(target);
        track.surfacePoint(s.t, lateral, this.position);
        this.position.y += this.tuning.cgHeight + 0.6;
        _mat.lookAt(_v.set(0, 0, 0), _v2.copy(s.tangent).negate(), s.normal);
        this.quaternion.setFromRotationMatrix(_mat);
      } catch (_) { this._placeOnGrid(); }
    } else {
      this._placeOnGrid();
    }

    this._syncBasis();
    this.position.addScaledVector(this.up, 0.35);
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.angularVelocity.set(0, 0, 0);
    this._angMom.set(0, 0, 0);
    this._pendingImpulse.set(0, 0, 0);
    this._pendingTorqueImpulse.set(0, 0, 0);

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.omega = speed / Math.max(0.2, w.radius);
      w.compression = this._staticComp;
      w.compressionN = saturate(this._staticComp / this.tuning.suspRest);
      w.slipAngle = 0;
      w.slipRatio = 0;
      w.heat = 0;
      w.smoke = 0;
      w.squeal = 0;
      w.markIntensity = 0;
      w.grounded = true;
    }
    this.gear = 1;
    this._shiftTimer = 0;
    this.rpm = this.tuning.idleRpm;
    this.driftFactor = 0;
    this.isDrifting = false;
    this.isAirborne = false;
    this.airTime = 0;
    this._fallTimer = 0;
    this._stuckTimer = 0;
    this._handbrakeMemory = 0;
    this._respawnCooldown = 0.6;
    this.respawnFlash = 1;
    this.speed = speed;
    this.forwardSpeed = speed;
    this.lateralSpeed = 0;

    if (!opts.silent) {
      this.ctx?.bus?.emit?.('vehicle:respawn', { vehicle: this, t: target });
    }
    return this;
  }

  /** Hold the car still (grid, countdown, results). */
  freeze() { this.frozen = true; return this; }
  unfreeze() { this.frozen = false; return this; }

  /** Restore condition. Race calls this between heats. */
  repair() {
    this.damage = 0;
    this.scuff = 0;
    this.dirt = 0;
    this.boostFuel = 1;
    return this;
  }

  /** Re-derive gearing, drag and inertia after tuning has been edited live. */
  retune(patch) {
    if (patch && typeof patch === 'object') {
      for (const k in patch) {
        if (k in this.tuning && typeof patch[k] === 'number' && Number.isFinite(patch[k])) {
          this.tuning[k] = patch[k];
        }
      }
    }
    this._calibrate();
    return this;
  }

  /* ------------------------------------------------------------- telemetry */

  /** Compact live state for HUD, audio, AI and the debug overlay. */
  telemetry() {
    return {
      name: this.driverName,
      model: this.modelId,
      chassis: this.spec.archetype,
      speed: +this.speed.toFixed(1),
      kph: Math.round(this.speed * 0.36 * 10) / 10, // u/s -> a toy-scale readout
      rpm: Math.round(this.rpm),
      rpmFrac: +(this.rpm / this.tuning.redlineRpm).toFixed(3),
      gear: this.gearLabel,
      throttle: +this.throttle.toFixed(2),
      brake: +this.brake.toFixed(2),
      steer: +this.steerPos.toFixed(2),
      steerDeg: +(this.steerAngle / DEG).toFixed(1),
      slipDeg: +(this.slipAngle / DEG).toFixed(1),
      drift: +this.driftFactor.toFixed(2),
      airborne: this.isAirborne,
      airTime: +this.airTime.toFixed(2),
      contacts: this.wheelContacts.slice(),
      surface: this.surface,
      offTrack: this.offTrack,
      latG: +this.lateralG.toFixed(2),
      longG: +this.longitudinalG.toFixed(2),
      boost: +this.boostFuel.toFixed(2),
      damage: +this.damage.toFixed(3),
      scuff: +this.scuff.toFixed(3),
      dirt: +this.dirt.toFixed(3),
      t: +this.trackT.toFixed(4),
      lateral: +this.trackLateral.toFixed(1),
      wheels: this.wheels.map((w) => ({
        slipRatio: +w.slipRatio.toFixed(3),
        slipDeg: +(w.slipAngle / DEG).toFixed(1),
        slipSpeed: +w.slipSpeed.toFixed(1),
        load: +w.load.toFixed(1),
        sat: +w.saturation.toFixed(2),
        smoke: +w.smoke.toFixed(2),
        squeal: +w.squeal.toFixed(2),
        grounded: w.grounded,
        surface: w.surface,
      })),
    };
  }

  /** Static description of this car, for the car-select screen. */
  info() {
    const g = this._gravity();
    return {
      id: this.id,
      model: this.modelId,
      chassis: this.spec.archetype,
      label: this.spec.label,
      drive: this.spec.drive.toUpperCase(),
      topSpeed: this.topSpeed,
      gears: this.spec.gears.length,
      mass: this.tuning.mass,
      cornerG: +(this.tires.cornerLimit(g, 1) / g).toFixed(2),
      grip: +((this.tuning.gripFront + this.tuning.gripRear) * 0.5).toFixed(3),
      power: this.tuning.enginePeakTorque,
      tyre: this.tires.describe(),
    };
  }

  dispose() {
    try { this.ctx?.physics?.removeBody?.(this.body); } catch (_) { /* ignore */ }
    try { this.visual?.dispose?.(); } catch (_) { /* ignore */ }
    this.visual = null;
    if (this.visualRoot?.parent) this.visualRoot.parent.remove(this.visualRoot);
    this.visualRoot = null;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/** Cyclic span test on [0,1) that handles a wrapped span (to < from). */
function withinSpan(t, from, to) {
  if (!(Number.isFinite(from) && Number.isFinite(to))) return false;
  if (to >= from) return t >= from && t <= to;
  return t >= from || t <= to;
}

export default Vehicle;
