// vehicle/Tires.js — the tyre model. Everything the car feels comes through here.
//
// A Pacejka-flavoured Magic Formula with genuinely separate longitudinal and
// lateral curves, combined through a friction ellipse, scaled by load
// sensitivity and by a per-surface grip multiplier taken from Surfaces.js.
//
// Three things about this file matter more than the equations:
//
// 1. **The tail is the whole game.** A real tyre's lateral force collapses past
//    the peak slip angle; that is why sim racers spin. The Magic Formula's own
//    asymptote is sin(C*pi/2) of the peak — with C = 1.38 that is 83%, which is
//    already a forgiving plateau — and `tailLift` raises it further. A long flat
//    tail is exactly what makes a drift *holdable*: past the peak the car keeps
//    most of its grip, so the slide settles into an equilibrium instead of
//    running away. Every "arcade-instant, always recoverable" requirement in the
//    contract is bought with this one shape parameter.
//
// 2. **Slip is physical, not decorative.** fx/Particles, fx/Trails, audio/Sfx
//    and world/Decals all decide what to emit from `slipRatio`, `slipAngle` and
//    `slipSpeed`. They are computed from real contact-patch kinematics with a
//    relaxation length, so a wheel that reads 30 u/s of slip really is sliding
//    30 u/s across the ground and the smoke, the squeal and the black line all
//    agree with each other without anyone coordinating.
//
// 3. **No allocation.** solve() writes into the wheel state object it is given.
//    Four wheels x eight cars x 120 Hz is 3840 calls a second.
//
// Deliberately free of THREE: this is scalar contact-patch maths in the wheel's
// own frame. Vehicle.js does all the vector work and hands us numbers.

import { clamp, saturate, lerp } from '../core/Random.js';

/* ==========================================================================
 * Surface metadata
 *
 * Surfaces.js is the authority, but importing it statically would chain
 * Vehicle.js to ProcTex.js and Settings.js at module-evaluation time — one
 * throw in a texture generator and no car in the game would construct. So the
 * numbers below are a mirror of the shipped Surfaces.js table (keep them in
 * sync), and the real module is pulled in asynchronously and swapped over the
 * moment it resolves. By then main.js has already imported it, so the swap
 * lands in the same microtask queue as the first frame.
 * ========================================================================== */

// grip: multiplier on peak friction, 1.0 = a good plank table.
// roll:  rolling-resistance coefficient (fraction of normal load).
// off:   leaving the ribbon onto this counts as off-track.
// hard:  0..1 — how much this surface behaves like a hard floor. Drives whether
//        a sliding tyre squeals and leaves a black line (1) or just churns (0).
const SURFACE_FALLBACK = {
  oak: { grip: 1.00, roll: 0.010, off: 0, hard: 1.00, particle: 'dust' },
  pine: { grip: 0.98, roll: 0.011, off: 0, hard: 1.00, particle: 'dust' },
  varnishedWood: { grip: 0.92, roll: 0.008, off: 0, hard: 1.00, particle: 'dust' },
  laminate: { grip: 1.00, roll: 0.009, off: 0, hard: 1.00, particle: 'dust' },
  poolFelt: { grip: 1.14, roll: 0.030, off: 0, hard: 0.42, particle: 'dust' },
  carpet: { grip: 0.90, roll: 0.078, off: 1, hard: 0.42, particle: 'dust' },
  rug: { grip: 0.95, roll: 0.052, off: 0, hard: 0.42, particle: 'dust' },
  sand: { grip: 0.62, roll: 0.110, off: 1, hard: 0.22, particle: 'sand' },
  grass: { grip: 0.72, roll: 0.086, off: 1, hard: 0.22, particle: 'grassClipping' },
  soil: { grip: 0.68, roll: 0.094, off: 1, hard: 0.22, particle: 'dust' },
  gravel: { grip: 0.58, roll: 0.122, off: 1, hard: 0.22, particle: 'debris' },
  concrete: { grip: 1.02, roll: 0.012, off: 0, hard: 1.00, particle: 'dust' },
  ceramicTile: { grip: 0.94, roll: 0.008, off: 0, hard: 1.00, particle: 'dust' },
  linoleum: { grip: 0.97, roll: 0.009, off: 0, hard: 1.00, particle: 'dust' },
  brushedAluminium: { grip: 0.86, roll: 0.008, off: 0, hard: 1.00, particle: 'sparks' },
  galvanisedSteel: { grip: 0.84, roll: 0.008, off: 0, hard: 1.00, particle: 'sparks' },
  chromePlate: { grip: 0.78, roll: 0.007, off: 0, hard: 1.00, particle: 'sparks' },
  plasticMatte: { grip: 0.95, roll: 0.010, off: 0, hard: 0.95, particle: 'dust' },
  plasticGloss: { grip: 0.88, roll: 0.008, off: 0, hard: 0.95, particle: 'dust' },
  rubber: { grip: 1.26, roll: 0.032, off: 0, hard: 0.95, particle: 'tyreSmoke' },
  paper: { grip: 0.80, roll: 0.020, off: 0, hard: 0.70, particle: 'debris' },
  cardboard: { grip: 0.85, roll: 0.024, off: 0, hard: 0.70, particle: 'debris' },
  spilledMilk: { grip: 0.40, roll: 0.030, off: 0, hard: 0.85, particle: 'milkSplash' },
  oilSlick: { grip: 0.22, roll: 0.006, off: 0, hard: 0.85, particle: 'waterSplash' },
  waterPuddle: { grip: 0.46, roll: 0.046, off: 0, hard: 0.85, particle: 'waterSplash' },
  chalkLine: { grip: 0.96, roll: 0.011, off: 0, hard: 1.00, particle: 'dust' },
  gaffaTape: { grip: 1.08, roll: 0.011, off: 0, hard: 1.00, particle: 'dust' },
  crumbs: { grip: 0.80, roll: 0.030, off: 0, hard: 0.50, particle: 'debris' },
  sawdust: { grip: 0.70, roll: 0.042, off: 1, hard: 0.30, particle: 'dust' },
};

const DEFAULT_SURFACE = 'concrete';

// Surfaces.js groups by material family; hardness follows from the family.
const CATEGORY_HARDNESS = {
  hard: 1, wood: 1, metal: 1, marking: 1, plastic: 0.95,
  liquid: 0.85, paper: 0.70, litter: 0.50, cloth: 0.42, loose: 0.22,
};

/** Resolved, cached per-surface physical record. Never null. */
const _surfaceCache = new Map();
let _surfaceMod = null;

function buildSurfaceRecord(name) {
  const fb = SURFACE_FALLBACK[name] || SURFACE_FALLBACK[DEFAULT_SURFACE];
  const rec = {
    name,
    grip: fb.grip,
    rollDrag: fb.roll,
    offTrack: !!fb.off,
    hardness: fb.hard,
    particle: fb.particle,
    particleColor: 0xb9a68c,
    skidTint: 0x1a1a1a,
    category: 'hard',
  };
  const defs = _surfaceMod?.SURFACE_DEFS;
  const d = defs && (defs[name] || null);
  if (d) {
    if (Number.isFinite(d.grip)) rec.grip = d.grip;
    if (Number.isFinite(d.rollDrag)) rec.rollDrag = d.rollDrag;
    rec.offTrack = !!d.offTrack;
    rec.particle = d.particle || rec.particle;
    if (Number.isFinite(d.particleColor)) rec.particleColor = d.particleColor;
    if (Number.isFinite(d.skidTint)) rec.skidTint = d.skidTint;
    rec.category = d.category || rec.category;
    const h = CATEGORY_HARDNESS[rec.category];
    if (Number.isFinite(h)) rec.hardness = h;
  }
  return rec;
}

/** Physical record for a named surface. Unknown names degrade to concrete. */
export function surfaceRecord(name) {
  const key = typeof name === 'string' && name ? name : DEFAULT_SURFACE;
  let rec = _surfaceCache.get(key);
  if (!rec) {
    const known = !!SURFACE_FALLBACK[key] || !!(_surfaceMod && _surfaceMod.SURFACE_DEFS && _surfaceMod.SURFACE_DEFS[key]);
    rec = buildSurfaceRecord(known ? key : DEFAULT_SURFACE);
    _surfaceCache.set(key, rec);
  }
  return rec;
}

/** Peak-friction multiplier for a surface. 1.0 = a good plank table. */
export function surfaceGrip(name) { return surfaceRecord(name).grip; }
/** Rolling-resistance coefficient (fraction of normal load). */
export function surfaceRollDrag(name) { return surfaceRecord(name).rollDrag; }
/** True when being here should count as off the racing surface. */
export function surfaceIsOffTrack(name) { return surfaceRecord(name).offTrack; }
/** 0..1 — how much this behaves like a hard floor (squeals, marks, sparks). */
export function surfaceHardness(name) { return surfaceRecord(name).hardness; }

/** Adopt a Surfaces.js module (or anything exposing SURFACE_DEFS) as authority. */
export function linkSurfaces(mod) {
  if (!mod || !mod.SURFACE_DEFS) return false;
  _surfaceMod = mod;
  _surfaceCache.clear();
  return true;
}

// Fire-and-forget upgrade to the real library. Cannot throw, cannot block, and
// if it never resolves the fallback table above is a complete, correct model.
try {
  import('../textures/Surfaces.js')
    .then((m) => { linkSurfaces(m); })
    .catch(() => { /* fallback table stands */ });
} catch (_) { /* environments without dynamic import */ }

/* ==========================================================================
 * The Magic Formula
 * ========================================================================== */

/**
 * Pacejka shape function, normalised to a peak of exactly 1.
 *
 *   y = sin(C * atan(Bx - E*(Bx - atan(Bx))))
 *
 * B is stiffness (where the peak sits), C is the shape factor (how far the
 * force falls away past the peak — the asymptote is sin(C*pi/2)), E is
 * curvature (how sharp the peak is; negative rounds it off).
 * @param {number} x slip ratio, or slip angle in radians
 */
export function pacejkaShape(x, B, C, E) {
  const bx = B * x;
  const inner = bx - E * (bx - Math.atan(bx));
  return Math.sin(C * Math.atan(inner));
}

/**
 * Slip at which pacejkaShape() peaks, found by bisecting the monotone inner
 * term against tan(pi/(2C)). Exact to float precision and only ever run when a
 * shape parameter changes, so the cost never reaches a frame.
 */
export function pacejkaPeak(B, C, E) {
  const c = clamp(C, 1.02, 1.95);
  const target = Math.tan(Math.PI / (2 * c));
  if (!Number.isFinite(target) || target <= 0) return 1.6 / Math.max(1e-3, B);
  const f = (b) => b - E * (b - Math.atan(b));
  let lo = 0;
  let hi = 1;
  let guard = 0;
  while (f(hi) < target && guard++ < 64) hi *= 2;
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) * 0.5;
    if (f(m) < target) lo = m; else hi = m;
  }
  return ((lo + hi) * 0.5) / Math.max(1e-3, B);
}

/* ==========================================================================
 * Wheel state
 * ========================================================================== */

/**
 * Everything one wheel knows about itself. Owned by the Vehicle, written by
 * this module and by Vehicle.js, read by fx, audio, decals, HUD and AI.
 *
 * The published, physically-meaningful slip channel is:
 *   slipRatio  (-1 locked .. 0 rolling .. +N spinning up)
 *   slipAngle  (radians; positive = the contact patch is sliding to the car's LEFT)
 *   slipSpeed  (u/s, how fast the rubber is actually scrubbing across the ground)
 *   saturation (0..1+ how much of the friction ellipse is being used)
 *
 * @param {number} index 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right
 */
export function makeWheelState(index, opts = {}) {
  return {
    index,
    front: index < 2,
    left: (index & 1) === 0,
    steered: !!opts.steered,
    driven: !!opts.driven,
    radius: opts.radius ?? 1.15,

    /* --- kinematics ------------------------------------------------------ */
    omega: 0,             // rad/s, wheel spin (positive = driving forward)
    spinAngle: 0,         // rad, accumulated for the visual
    steerAngle: 0,        // rad, positive = pointing left (car-local +X)
    vx: 0,                // u/s along the wheel's heading
    vy: 0,                // u/s along the wheel's left
    slipRatio: 0,
    slipAngle: 0,
    slipRatioRaw: 0,      // pre-relaxation, for diagnostics
    slipAngleRaw: 0,
    slipSpeed: 0,         // u/s magnitude of contact-patch scrub
    spinSlipSpeed: 0,     // u/s longitudinal component (wheelspin / lockup)
    lateralSlipSpeed: 0,  // u/s lateral component (the drift)

    /* --- forces ---------------------------------------------------------- */
    driveTorque: 0,       // written by the drivetrain each tick
    staticLoad: 0,        // this corner's share of the car at rest
    localX: 0, localY: 0, localZ: 0, // strut mount in body coordinates
    load: 0,              // N, normal force through the contact patch
    fx: 0,                // longitudinal tyre force (+ = pushes the car forward)
    fy: 0,                // lateral tyre force (+ = pushes the car to its left)
    fxMax: 0,
    fyMax: 0,
    saturation: 0,        // |F| / friction ellipse, 1 = at the limit
    grip: 1,              // surface multiplier currently in effect
    muLat: 0,
    muLong: 0,

    /* --- suspension ------------------------------------------------------ */
    grounded: false,
    compression: 0,       // u, spring travel used
    compressionN: 0,      // 0..1 normalised over restLength
    compressionRate: 0,   // u/s
    suspensionForce: 0,
    contactDistance: 0,   // u, mount to ground along the strut
    surface: DEFAULT_SURFACE,
    surfaceHardness: 1,
    rollDrag: 0.012,
    offTrack: false,

    /* --- world-space, for visuals, fx and decals ------------------------- */
    hubX: 0, hubY: 0, hubZ: 0,
    contactX: 0, contactY: 0, contactZ: 0,
    normalX: 0, normalY: 1, normalZ: 0,

    /* --- effect drivers -------------------------------------------------- */
    heat: 0,              // 0..1 integrated slip work — smoke builds and fades
    smoke: 0,             // 0..1 emit strength for tyreSmoke / surface particles
    squeal: 0,            // 0..1 skid audio gain
    markIntensity: 0,     // 0..1 how black a line to lay down
    locked: false,        // braked past rolling
    spinning: false,      // driven past rolling
    sliding: false,       // scrubbing hard enough to matter
  };
}

/* ==========================================================================
 * TireModel
 *
 * One instance per car so the debug panel can tune a single car or, with
 * "apply to all", the whole field. Every parameter is a plain own number on
 * the instance: core/Debug.js turns exactly those into sliders.
 * ========================================================================== */

export const TIRE_DEFAULTS = {
  /* --- peak friction ---------------------------------------------------- */
  // mu * gravity is the peak acceleration a tyre can produce. At g = 260 the
  // defaults give ~156 u/s2 of lateral and ~172 u/s2 of longitudinal bite on a
  // grip-1.0 surface: a 60 u radius corner goes through at ~97 u/s, a hairpin
  // of 22 u at ~59 u/s, and 100 -> 0 takes 29 u. Roughly three car lengths.
  muLat: 0.60,
  muLong: 0.66,

  /* --- lateral curve ---------------------------------------------------- */
  // B places the peak: 12 rad^-1 with this C/E puts it at 8.9 degrees of slip,
  // which is a sticky road tyre. C sets the asymptote at sin(C*pi/2) = 0.83 of
  // peak — the plateau a drift lives on. E rounds the peak off so the limit
  // arrives as a slur, not a cliff.
  bLat: 12.0,
  cLat: 1.38,
  eLat: -0.40,

  /* --- longitudinal curve ----------------------------------------------- */
  // Peaks at ~13% slip ratio, asymptote 0.79. Slightly sharper than lateral,
  // which is why a locked wheel loses more than a sliding one.
  bLong: 13.5,
  cLong: 1.42,
  eLong: -0.35,

  /* --- forgiveness ------------------------------------------------------ */
  // tailLift blends the far-slip force up towards tailFloor of peak. This is
  // the single dial between "sim" (0) and "a beginner cannot spin" (1). At the
  // default a fully sideways tyre still returns ~86% of peak grip, so a slide
  // decelerates the car and settles rather than accelerating the spin.
  tailLift: 0.60,
  tailFloor: 0.88,
  tailWidth: 2.6,        // multiples of the peak slip over which the lift arrives

  /* --- load sensitivity -------------------------------------------------- */
  // Real tyres get *less* efficient as they are pressed harder. This is the
  // mechanism that makes anti-roll bar balance work: stiffening one axle moves
  // more load onto its outside tyre, which loses that axle grip.
  loadSens: 0.20,
  loadRef: 65,           // N — static load per wheel for a mass-1 car at g = 260
  loadMin: 0.62,         // clamp on the efficiency multiplier
  loadMax: 1.30,

  /* --- combined slip ---------------------------------------------------- */
  // 2 = a true friction ellipse. Above 2 the corners fill out, so a tyre can
  // brake and turn nearer to simultaneously — which is arcade-forgiving.
  ellipse: 2.15,
  camberGain: 0.55,      // lateral force per radian of camber (from body roll)

  /* --- transient -------------------------------------------------------- */
  // Relaxation length: the tyre carcass takes this much rolling distance to
  // build a new slip state. 2.4 u is a quarter of a car length — at 90 u/s that
  // is a 27 ms lag, imperceptible, but it conditions the maths to a standstill.
  relaxLat: 2.4,
  relaxLong: 1.6,
  minSlipSpeed: 6.0,     // u/s floor on the slip denominators

  /* --- effect thresholds ------------------------------------------------- */
  squealStart: 7,        // u/s of scrub before the tyre starts to complain
  squealFull: 46,
  smokeStart: 13,
  smokeFull: 74,
  heatRise: 3.4,         // 1/s toward the instantaneous slip level
  heatFall: 1.35,        // 1/s decay — slower, so smoke billows then dissipates
  heatPowerRef: 5200,    // slip power (force * u/s) that saturates heat
  markLoad: 0.55,        // fraction of static load below which no mark is laid
};

/* ---------------------------------------------------------------- smoke gain */

/**
 * The smoke channel was authored against a slip range this car never reaches.
 *
 * Measured over 13 241 grounded wheel-samples of ordinary racing (8 cars,
 * kitchen, t = 12..25 s): scrub sits below 5 u/s for 56% of samples and below
 * 15 u/s for 87%, while `smokeFull` is 74 — roughly the 99.7th percentile, a
 * once-a-race event. Slip power p95 is 1735 and p99 is 3822, against a
 * `heatPowerRef` of 5200. And the slip term is then multiplied by 0.45, so
 * `w.smoke` is hard-capped below half scale no matter what the driver does.
 * Observed maximum across the whole sample: 0.45, reached once.
 *
 * That matters because `w.smoke` has exactly one consumer — fx/Particles.js —
 * and it multiplies FOUR authored curves by it: emission rate (`smokeRate: 46`,
 * commented "particles/s at full slip"), sprite scale, opacity and lifetime.
 * At the median smoke of 0.05 all four sit on their floor, which is why a car
 * at the limit lays down single-digit particles that nobody can see. The
 * renderer is not at fault: forcing 240 particles at the contact patches draws
 * a full, soft plume.
 *
 * `?smokeGain=N` lerps from the shipped calibration (0) to one scaled against
 * what the game measurably produces (1), so both can be rendered from ONE build
 * at ONE moment (D25). This changes a look, so it stays a dial until a human
 * has seen the frames side by side.
 */
const SMOKE_CAL_TUNED = {
  smokeStart: 11,        // p85 of scrub — a tyre that is genuinely scrubbing
  smokeFull: 34,         // p97 — a hard, committed slide, not a once-a-race event
  heatPowerRef: 1500,    // just above p95 slip power, so a big moment saturates
  slipMix: 1.0,          // was a flat 0.45 cap on the slip pathway
};
const SMOKE_CAL_SHIPPED = {
  smokeStart: 13,
  smokeFull: 74,
  heatPowerRef: 5200,
  slipMix: 0.45,
};
/**
 * 0 = shipped, 1 = fully recalibrated.
 *
 * Shipped at 0.25 after a four-point ladder captured from one build at one
 * pinned moment (t = 20.008, seed 7; the physics is identical in all four
 * because smoke is a pure output channel). 0.25 gives plumes that read as tyre
 * smoke while leaving every car's colour and silhouette intact; 0.50 washes out
 * the two cars behind the leader and 1.00 buries the field in a fog bank.
 *
 * So the answer is NOT 1. A channel finally reaching its authored range is not
 * the same as the authored range being right: `smokeRate: 46` and an opacity
 * curve topping out at 1.2 were written for a full-size car, and this is a
 * miniature seen from two feet up. 0.25 is where the signal clears its floor
 * without the curves above it overreaching. See D40.
 */
const SMOKE_GAIN_DEFAULT = 0.25;

const SMOKE_GAIN = (() => {
  try {
    const v = new URLSearchParams(location.search).get('smokeGain');
    if (v === null || v === '') return SMOKE_GAIN_DEFAULT;
    if (v === 'off') return 0;
    const n = Number(v);
    // `Number(null)` and `Number('')` are both 0 and would read as "off"
    // through a >= 0 guard. Both are handled above, deliberately: that exact
    // hole switched the fog off on every normal boot once.
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : SMOKE_GAIN_DEFAULT;
  } catch (_) { return SMOKE_GAIN_DEFAULT; }
})();

/** The calibration this session is running, blended by the dial. */
export const SMOKE_CAL = {
  smokeStart: lerp(SMOKE_CAL_SHIPPED.smokeStart, SMOKE_CAL_TUNED.smokeStart, SMOKE_GAIN),
  smokeFull: lerp(SMOKE_CAL_SHIPPED.smokeFull, SMOKE_CAL_TUNED.smokeFull, SMOKE_GAIN),
  heatPowerRef: lerp(SMOKE_CAL_SHIPPED.heatPowerRef, SMOKE_CAL_TUNED.heatPowerRef, SMOKE_GAIN),
  slipMix: lerp(SMOKE_CAL_SHIPPED.slipMix, SMOKE_CAL_TUNED.slipMix, SMOKE_GAIN),
  gain: SMOKE_GAIN,
};

export class TireModel {
  constructor(cfg = {}) {
    // Flat own numbers: core/Debug.js builds a slider for each of these.
    for (const k in TIRE_DEFAULTS) this[k] = TIRE_DEFAULTS[k];
    // The smoke channel's calibration is dialled per-session; see SMOKE_CAL.
    this.smokeStart = SMOKE_CAL.smokeStart;
    this.smokeFull = SMOKE_CAL.smokeFull;
    this.heatPowerRef = SMOKE_CAL.heatPowerRef;
    this.smokeSlipMix = SMOKE_CAL.slipMix;
    for (const k in cfg) if (typeof cfg[k] === 'number' && Number.isFinite(cfg[k])) this[k] = cfg[k];

    this._peakLat = 0;
    this._peakLong = 0;
    this._floorLat = 0;
    this._floorLong = 0;
    this._sig = '';
    this.refresh();
  }

  /**
   * Recompute the cached peak locations and asymptotes. Called automatically
   * whenever a shape parameter has changed since the last solve, so dragging a
   * slider in the debug panel takes effect on the very next tick.
   */
  refresh() {
    this.cLat = clamp(this.cLat, 1.02, 1.95);
    this.cLong = clamp(this.cLong, 1.02, 1.95);
    this.bLat = Math.max(0.5, this.bLat);
    this.bLong = Math.max(0.5, this.bLong);
    this._peakLat = pacejkaPeak(this.bLat, this.cLat, this.eLat);
    this._peakLong = pacejkaPeak(this.bLong, this.cLong, this.eLong);
    this._floorLat = Math.sin(this.cLat * Math.PI * 0.5);
    this._floorLong = Math.sin(this.cLong * Math.PI * 0.5);
    this._sig = `${this.bLat},${this.cLat},${this.eLat},${this.bLong},${this.cLong},${this.eLong}`;
    return this;
  }

  _checkSig() {
    const s = `${this.bLat},${this.cLat},${this.eLat},${this.bLong},${this.cLong},${this.eLong}`;
    if (s !== this._sig) this.refresh();
  }

  /** Peak slip angle in radians — where the lateral curve maxes out. */
  get peakSlipAngle() { return this._peakLat; }
  /** Peak slip ratio — where the longitudinal curve maxes out. */
  get peakSlipRatio() { return this._peakLong; }

  /**
   * Normalised lateral shape, signed, peak 1, with the forgiveness tail.
   * @param {number} alpha slip angle in radians
   */
  shapeLat(alpha) {
    const a = Math.abs(alpha);
    let p = pacejkaShape(a, this.bLat, this.cLat, this.eLat);
    p = this._tail(p, a, this._peakLat, this._floorLat);
    return alpha < 0 ? -p : p;
  }

  /**
   * Normalised longitudinal shape, signed, peak 1, with the forgiveness tail.
   * @param {number} kappa slip ratio
   */
  shapeLong(kappa) {
    const k = Math.abs(kappa);
    let p = pacejkaShape(k, this.bLong, this.cLong, this.eLong);
    p = this._tail(p, k, this._peakLong, this._floorLong);
    return kappa < 0 ? -p : p;
  }

  /** Blend the post-peak force up toward `tailFloor`; see the header note. */
  _tail(p, x, peak, natural) {
    if (this.tailLift <= 0 || x <= peak) return p;
    const span = Math.max(1e-4, peak * this.tailWidth);
    // Exponential approach, so the lift arrives smoothly and never kinks.
    const w = 1 - Math.exp(-(x - peak) / span);
    const target = Math.max(p, Math.max(natural, this.tailFloor));
    return p + (target - p) * w * saturate(this.tailLift);
  }

  /** Efficiency multiplier from vertical load — heavier tyres work worse. */
  loadFactor(load) {
    const r = load / Math.max(1e-3, this.loadRef);
    return clamp(1 - this.loadSens * (r - 1), this.loadMin, this.loadMax);
  }

  /** Peak lateral force available at this load and surface grip. */
  peakLateral(load, grip = 1, scale = 1) {
    return this.muLat * grip * scale * this.loadFactor(load) * load;
  }

  /** Peak longitudinal force available at this load and surface grip. */
  peakLongitudinal(load, grip = 1, scale = 1) {
    return this.muLong * grip * scale * this.loadFactor(load) * load;
  }

  /**
   * Lateral acceleration a car of this mass could sustain, ignoring transfer.
   * Vehicle.js uses it to size the speed-sensitive steering ratio, and AI uses
   * it for its speed-for-curvature solve, so all three agree on "the limit".
   */
  cornerLimit(gravity, grip = 1, downforceRatio = 1) {
    const load = gravity * 0.25 * downforceRatio;
    return this.muLat * grip * this.loadFactor(load) * gravity * downforceRatio;
  }

  /**
   * Advance one wheel's slip state and resolve its contact forces.
   *
   * @param {object} w  wheel state from makeWheelState()
   * @param {number} vx contact-patch velocity along the wheel heading (u/s)
   * @param {number} vy contact-patch velocity along the wheel's left (u/s)
   * @param {number} load normal force through the patch
   * @param {number} dt fixed timestep
   * @param {object} o per-wheel modifiers:
   *        grip        surface multiplier
   *        latScale    extra lateral mu multiplier (handbrake, drift, spin catch)
   *        longScale   extra longitudinal mu multiplier
   *        camber      radians of camber (positive leans the top of the wheel left)
   *        hardness    0..1 surface hardness, gates squeal and skid marks
   */
  solve(w, vx, vy, load, dt, o) {
    this._checkSig();

    const grip = o?.grip ?? 1;
    const latScale = o?.latScale ?? 1;
    const longScale = o?.longScale ?? 1;
    const camber = o?.camber ?? 0;
    const hardness = o?.hardness ?? 1;

    w.vx = vx;
    w.vy = vy;
    w.load = load;
    w.grip = grip;

    if (load <= 1e-4) {
      // Airborne: no force, and the slip state bleeds off so a landing does not
      // arrive with a stale 40-degree slip angle already loaded.
      w.fx = 0; w.fy = 0; w.fxMax = 0; w.fyMax = 0;
      w.saturation = 0;
      const decay = Math.exp(-dt * 8);
      w.slipAngle *= decay;
      w.slipRatio *= decay;
      w.slipSpeed = 0;
      w.spinSlipSpeed = 0;
      w.lateralSlipSpeed = 0;
      w.sliding = false;
      w.locked = false;
      w.spinning = false;
      this._effects(w, 0, dt, hardness);
      return w;
    }

    /* --- slip, with a relaxation length ---------------------------------- */

    const av = Math.abs(vx);
    const den = Math.max(av, this.minSlipSpeed);
    const roll = w.omega * w.radius;

    const kappaRaw = clamp((roll - vx) / den, -6, 6);
    const alphaRaw = Math.atan2(vy, den);
    w.slipRatioRaw = kappaRaw;
    w.slipAngleRaw = alphaRaw;

    // Relaxation is expressed in rolling distance, which is what a carcass
    // actually responds to. Clamped to 1 so a standstill snaps rather than
    // integrating a divide-by-zero.
    const travel = Math.max(av, Math.abs(roll)) * dt;
    const kLat = saturate(travel / Math.max(0.05, this.relaxLat));
    const kLong = saturate(travel / Math.max(0.05, this.relaxLong));
    // Below the relaxation floor the tyre is effectively static: converge fast
    // so parked cars settle instead of shivering.
    const settle = saturate(1 - av / this.minSlipSpeed);
    w.slipAngle += (alphaRaw - w.slipAngle) * Math.max(kLat, settle * 0.35);
    w.slipRatio += (kappaRaw - w.slipRatio) * Math.max(kLong, settle * 0.5);

    /* --- pure-slip forces -------------------------------------------------- */

    const eff = this.loadFactor(load);
    const muY = this.muLat * grip * latScale * eff;
    const muX = this.muLong * grip * longScale * eff;
    const fyMax = muY * load;
    const fxMax = muX * load;

    // Camber thrust acts in the direction the wheel leans. Body roll leans the
    // wheels *away* from the corner, so this subtracts from cornering force —
    // which is precisely why a soft, rolly car has less grip than a stiff one,
    // and why the anti-roll bars are worth having.
    const camberForce = camber * this.camberGain * fyMax;

    let fx0 = this.shapeLong(w.slipRatio) * fxMax;
    let fy0 = -this.shapeLat(w.slipAngle) * fyMax + camberForce;

    /* --- friction ellipse -------------------------------------------------- */

    const p = Math.max(1.2, this.ellipse);
    const ux = fxMax > 1e-6 ? Math.abs(fx0) / fxMax : 0;
    const uy = fyMax > 1e-6 ? Math.abs(fy0) / fyMax : 0;
    const u = Math.pow(Math.pow(ux, p) + Math.pow(uy, p), 1 / p);
    if (u > 1) {
      const s = 1 / u;
      fx0 *= s;
      fy0 *= s;
    }

    w.fx = fx0;
    w.fy = fy0;
    w.fxMax = fxMax;
    w.fyMax = fyMax;
    w.muLat = muY;
    w.muLong = muX;
    w.saturation = u;

    /* --- scrub, the signal every other system reads ------------------------ */

    const spinSlip = roll - vx;             // u/s the tread is dragged along the patch
    w.spinSlipSpeed = spinSlip;
    w.lateralSlipSpeed = vy;
    w.slipSpeed = Math.hypot(spinSlip, vy);
    w.locked = w.slipRatio < -0.55 && av > 4;
    w.spinning = w.slipRatio > 0.35;
    w.sliding = w.saturation > 0.985 && w.slipSpeed > this.squealStart * 0.6;

    const slipPower = Math.abs(fx0 * spinSlip) + Math.abs(fy0 * vy);
    this._effects(w, slipPower, dt, hardness);
    return w;
  }

  /**
   * Turn slip into the smooth 0..1 channels fx and audio consume. Heat is a
   * first-order filter with a fast rise and a slow fall, which is what makes
   * smoke build through a long drift and hang after it ends instead of popping
   * on and off with the slip signal.
   */
  _effects(w, slipPower, dt, hardness) {
    const target = saturate(slipPower / Math.max(1, this.heatPowerRef));
    const rate = target > w.heat ? this.heatRise : this.heatFall;
    w.heat += (target - w.heat) * saturate(dt * rate);
    w.surfaceHardness = hardness;

    const scrub = w.slipSpeed;
    const squeal = saturate((scrub - this.squealStart) / Math.max(1, this.squealFull - this.squealStart));
    const smoke = saturate((scrub - this.smokeStart) / Math.max(1, this.smokeFull - this.smokeStart));

    // A loose surface neither squeals nor blackens — it throws material, which
    // is Particles' job, keyed off w.surface. Hardness gates the rubber cues.
    w.squeal = w.grounded ? squeal * hardness * saturate(w.load / this.loadRef) : 0;
    w.smoke = w.grounded ? Math.max(smoke * this.smokeSlipMix, w.heat) * lerp(0.35, 1, hardness) : w.smoke * Math.exp(-dt * 2.2);
    w.markIntensity = w.grounded && w.load > this.loadRef * this.markLoad
      ? squeal * hardness * hardness
      : 0;
  }

  /** Human-readable snapshot for the debug overlay. */
  describe() {
    this._checkSig();
    return {
      peakSlipAngleDeg: +(this._peakLat * 57.29578).toFixed(2),
      peakSlipRatio: +this._peakLong.toFixed(3),
      lateralTail: +Math.max(this._floorLat, this.tailLift > 0 ? this.tailFloor : this._floorLat).toFixed(3),
      longitudinalTail: +Math.max(this._floorLong, this.tailLift > 0 ? this.tailFloor : this._floorLong).toFixed(3),
      muLat: this.muLat,
      muLong: this.muLong,
    };
  }
}

/**
 * Sample the lateral curve across a slip sweep. Not used at runtime — it exists
 * so the shape can be verified from the console without guessing:
 *   MG.ctx.player.tires.curve('lat')
 */
TireModel.prototype.curve = function curve(which = 'lat', steps = 24, span = 6) {
  this._checkSig();
  const peak = which === 'long' ? this._peakLong : this._peakLat;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * peak * span;
    out.push([
      +x.toFixed(4),
      +(which === 'long' ? this.shapeLong(x) : this.shapeLat(x)).toFixed(4),
    ]);
  }
  return out;
};

export default TireModel;
