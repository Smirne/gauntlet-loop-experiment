// game/Director.js — the camera, treated as cinematography rather than plumbing.
//
// The shot is a high-angle three-quarter chase on a long lens. Two numbers are
// contractual (ARCHITECTURE section 6): the elevation of the camera above the
// car is 48-62 degrees, and the lens is 30-36 degrees of vertical fov. Both are
// enforced here rather than hoped for, and _frameCheck() measures what the rig
// actually produced from the final camera transform every frame so a violation
// is loud instead of invisible.
//
// COMPOSITION IS SOLVED IN SCREEN SPACE, NOT IN WORLD UNITS. That is the whole
// change from the revision that was reviewed. The old rig damped a *focus point*
// that sat 'lookahead' world units ahead of the car, put the camera behind that
// point, and aimed at it — so the car itself was pushed backwards out of the
// shot by an amount nobody was measuring. At the shipped pose (pitch 55,
// distance 46, fov 33) and a lookahead of 0.35 * 88 * 0.34 = 10.472 u:
//
//     the car sits 10.472 u behind the aim point along travel
//     image-plane drop  = 10.472 * sin(55) = 8.578 u
//     depth at the car  = 46 - 10.472 * cos(55) = 39.994 u
//     angle below axis  = atan(8.578 / 39.994) = 12.100 deg
//     half-fov          = 16.5 deg
//     ndc_y             = -tan(12.100) / tan(16.5) = -0.724
//
// i.e. the player is 13.8% up from the bottom edge at a merely brisk 88 u/s,
// and at the 112 u/s top speed of the open-wheeler it solves to ndc_y = -0.961
// — more than half the car below the bottom of the frame. MAX_LOOKAHEAD was
// 26 u, which is ndc_y = -2.313: entirely off screen. Nothing in the frame told
// you this was happening because the camera still pointed at the road.
//
// So: the boom is anchored on the CAR, and the aim point is solved backwards
// from where the car is wanted in frame. 'lead' is derived from a target ndc_y,
// which makes the subject's position a bounded quantity by construction — no
// speed, no lookahead gain and no track can push it out of shot. Distance is
// solved the same way, from how much of the frame height the car should occupy,
// which is what "auto-zoom" actually means and what keeps the 8% floor honest.
// The reviewed frame showed a 35 x 62 u patch of table: no context, no props,
// no table edge, so a 9 u die-cast read as a full-size car on tarmac. The
// framing solve now opens that to roughly 53 x 80 u parked and 78 x 110 u flat
// out, which is where the toybox actually becomes visible.
//
// EVERY MOTION IS CRITICALLY DAMPED. Not lerped, not sprung: a proper
// second-order critically damped solve (Game Programming Gems 4's SmoothDamp),
// which has no oscillation by construction and is frame-rate independent. What
// gets damped is the *pose parameters* — anchor, yaw, pitch, distance, fov,
// roll, and the two screen-space framing offsets — and the camera position is
// then derived analytically from them. Damping the final position instead is
// the classic mistake: it lags behind on a straight and cuts the corner on a
// turn.
//
// The camera also drives the tilt-shift band. PostFX will track ctx.player on
// its own, but the Director knows which car is actually being framed (spectate,
// replay, results) and has already projected it for _frameCheck, so it hands
// PostFX that screen-space Y through setFocusBand(centre, width, falloff) —
// the real signature in render/PostFX.js, where centre is uv.y or null, width
// is the band half-height in uv.y, and falloff is the ramp EXPONENT.
//
// Modes: race | intro | results | replay | free.

import * as THREE from 'three';
import { makeRng, simplex2D } from '../core/Random.js';

/* ------------------------------------------------------------------- scratch */
// Preallocated at module scope: nothing in lateUpdate is allowed to allocate.

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _travel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _anchorWant = new THREE.Vector3();
const _camWant = new THREE.Vector3();
const _lookWant = new THREE.Vector3();
const _introPos = new THREE.Vector3();
const _introLook = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);
const _origin = new THREE.Vector3();

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------- tuning */

const MODES = Object.freeze(['race', 'intro', 'results', 'replay', 'free']);

/* --- the two contractual bands (ARCHITECTURE section 6) --------------------- */
const PITCH_MIN = 48;
const PITCH_MAX = 62;
const FOV_MIN = 30;
const FOV_MAX = 36;

/* --- composition ----------------------------------------------------------- */
//
// Subject height as a fraction of frame height. Parked, the car is a hero
// object and can afford a fifth of the frame; flat out the shot has to buy road
// and table, so it shrinks. SUBJECT_FLOOR is the hard limit from the brief and
// is what caps the auto-zoom, not the other way round.
const SUBJECT_REST = 0.200;
const SUBJECT_FAST = 0.145;
const SUBJECT_FLOOR = 0.085;

// Where the car sits vertically, in ndc (-1 bottom, +1 top). Near centre when
// crawling — there is nothing ahead worth looking at — and on the lower third
// at speed, which is what opens up the road. This IS the lookahead: it is
// converted to a world-space aim distance along the velocity vector in
// _composeLook, and being defined in screen space is precisely what stops it
// walking the subject off the bottom edge the way world units did.
const FRAME_Y_REST = -0.06;
const FRAME_Y_FAST = -0.34;
// Lateral swing from a slide, in ndc. Small: enough to open the frame in the
// direction the car is actually travelling, not enough to decentre the subject.
const FRAME_X_SWING = 0.15;
// How close to the frame edge the auto-zoom is willing to let a rival sit.
const FRAME_EDGE = 0.84;

const RIVAL_RADIUS = 52;       // u — about six car lengths; who is in the fight
const RIVAL_ZOOM_MAX = 1.5;    // widest the rival fit may pull past the framing solve
const ANCHOR_LIFT = 1.1;       // u — pivot the boom around the body, not the floor
const MAX_ROLL = 3.6 * DEG;
const SHAKE_POS = 2.4;         // u of translation at full trauma
const SHAKE_ROT = 1.15 * DEG;  // rotational shake at full trauma
const SHAKE_FREQ = 13.5;       // Hz-ish; fast enough to read as an impact

/* --- intro ----------------------------------------------------------------- */
const INTRO_SWEEP = 1.55;      // radians of orbit across the establishing shot
const INTRO_BLEND = 2.2;       // seconds of dissolve into the race pose
const INTRO_PITCH_A = 62;      // opens near-plan, so the circuit reads as a shape
const INTRO_PITCH_B = 47;      // settles to a dramatic angle over the grid
const INTRO_FIT_A = 1.12;      // multiples of track radius that must fit at the top
const INTRO_FIT_B = 0.30;      // ... and at the end of the push-in

// Reference distance the shipped Settings.camera.distance corresponds to. That
// value is a trim on the framing solve, not an absolute: the solve owns the
// composition, the setting lets the tuning panel push it around it.
const DISTANCE_REF = 46;

// Smoothing times in seconds — the time to close ~63% of the remaining error.
// The anchor is tight in XZ (the car must stay put in frame) and slack in Y so
// suspension bob never reaches the lens; yaw is slack so a drift swings the
// camera lazily instead of whipping it; distance is the slackest of all,
// because a fast auto-zoom reads as the camera pumping.
const TAU = Object.freeze({
  anchorXZ: 0.10,
  anchorY: 0.30,
  yaw: 0.26,
  pitch: 0.45,
  dist: 0.42,
  fov: 0.30,
  roll: 0.24,
  frameY: 0.30,
  frameX: 0.28,
});

/* ------------------------------------------------------------------ helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function num(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
function wrapPi(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** The standard rational fit to exp(-omega*dt); accurate to well under a pixel. */
function expCoef(smoothTime, dt) {
  const x = (2 / Math.max(1e-4, smoothTime)) * dt;
  return 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
}

/**
 * One critically damped scalar. No overshoot, no ringing, and frame-rate
 * independent.
 */
class Damped {
  constructor(value = 0) {
    this.value = value;
    this.vel = 0;
  }

  to(target, smoothTime, dt) {
    if (!(dt > 0) || !Number.isFinite(target)) return this.value;
    const st = Math.max(1e-4, smoothTime);
    const omega = 2 / st;
    const exp = expCoef(st, dt);
    const change = this.value - target;
    const temp = (this.vel + omega * change) * dt;
    this.vel = (this.vel - omega * temp) * exp;
    let out = target + (change + temp) * exp;
    // Snap the last thousandth away. Without this the camera never truly comes
    // to rest and a parked car shimmers under the tilt-shift.
    if (Math.abs(out - target) < 1e-4 && Math.abs(this.vel) < 1e-3) {
      out = target;
      this.vel = 0;
    }
    this.value = out;
    return out;
  }

  set(v) { this.value = Number.isFinite(v) ? v : 0; this.vel = 0; return this.value; }
}

/** Same solve, but on the shortest angular path so ±π never causes a spin. */
class DampedAngle extends Damped {
  to(target, smoothTime, dt) {
    if (!Number.isFinite(target)) return this.value;
    this.value = target + wrapPi(this.value - target);
    const out = super.to(target, smoothTime, dt);
    this.value = wrapPi(out);
    return this.value;
  }
}

/* ----------------------------------------------------------------- Director */

export class Director {
  name = 'director';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.mode = 'race';
    this.previousMode = null;
    this.enabled = true;
    this.time = 0;
    this.modeTime = 0;

    const cam = ctx?.settings?.camera || {};
    // Both bands are clamped on the way in. The tuning panel is allowed a wider
    // range than the contract; the contract wins.
    this.baseFov = clamp(num(cam.fov, 33), FOV_MIN, FOV_MAX);
    this.basePitch = clamp(num(cam.pitch, 55), PITCH_MIN, PITCH_MAX);
    this.distanceTrim = clamp(num(cam.distance, DISTANCE_REF) / DISTANCE_REF, 0.7, 1.5);
    this.minHeight = num(cam.height, 26) * 0.55;
    this.lookaheadGain = clamp(num(cam.lookahead, 0.35), 0, 1.5);
    // Kept small on purpose: the whole boost kick has to fit inside the 30-36
    // band alongside the speed term, and it is a punch, not a zoom.
    this.fovBoostKick = clamp(num(cam.fovBoostKick, 1.8), 0, 3);

    this.focusTarget = ctx?.player || null;
    this.aspect = 16 / 9;

    /* --- damped pose ----------------------------------------------------- */
    this.anchor = new THREE.Vector3();
    this._anchorVel = new THREE.Vector3();
    this.yaw = new DampedAngle(0);
    this.pitch = new Damped(this.basePitch);
    this.distance = new Damped(this._nominalDistance());
    this.fov = new Damped(this.baseFov);
    this.roll = new Damped(0);
    this.frameY = new Damped(FRAME_Y_REST);
    this.frameX = new Damped(0);

    /* --- boom scratch (written by _boom, read by _composeLook) ------------ */
    this._boomPitch = this.basePitch * DEG;
    this._boomHoriz = 0;
    this._boomHeight = 0;
    this._lead = 0;
    this._distCap = this.distance.value;

    /* --- shake ----------------------------------------------------------- */
    this.trauma = 0;
    this._traumaDecay = 2.5;
    // Seeded so a captured frame is reproducible: the same seed shakes the same.
    const rng = makeRng((ctx?.seed ?? 20260730) ^ 0x5ca3e);
    this._noiseSeed = Math.floor(rng.next() * 65536);

    /** Per-mode outputs. Modes write these instead of mutating the dampers,
     *  which would corrupt the solver's state the next time it runs. */
    this._fovOut = this.baseFov;
    this._rollOut = 0;

    /* --- measured framing, refilled every frame, never reallocated -------- */
    this._check = {
      pitch: this.basePitch,
      distance: this.distance.value,
      fov: this.baseFov,
      subjectFrac: SUBJECT_REST,
      ndcX: 0,
      ndcY: FRAME_Y_REST,
      inFront: true,
      onScreen: true,
      inBand: true,
    };
    this._bandWarned = false;
    this._fracWarned = false;

    /* --- intro / results / replay ---------------------------------------- */
    this.introDuration = 9.0;
    this.introAngle = 0;
    this.autoIntroToRace = true;
    this._resultsAngle = 0;
    this._replayAnchor = new THREE.Vector3();
    this._replaySide = 1;
    this._replayT = 0;
    this._replayHold = 0;

    this._needSnap = true;
    this._offBus = [];
  }

  /* ------------------------------------------------------------------ setup */

  async init() {
    const ctx = this.ctx;
    const bus = ctx?.bus;

    this.focusTarget = ctx?.player || ctx?.vehicles?.[0] || null;
    this._seedPose();

    // Race is built before us and sits in 'attract' silently, so there is no
    // event to react to — read the state directly and open on the orbit.
    if (ctx?.race?.state === 'attract') this.setMode('intro', { auto: false });

    if (bus?.on) {
      this._offBus.push(bus.on('vehicle:impact', (p) => this._onImpact(p)));
      this._offBus.push(bus.on('impact', (p) => this._onImpact(p)));
      this._offBus.push(bus.on('collision', (p) => this._onImpact(p)));
      this._offBus.push(bus.on('shake', (p) => this.shake(p?.amount ?? p?.strength ?? 0.3, p?.duration ?? 0.35)));
      this._offBus.push(bus.on('vehicle:land', (p) => this._onLand(p)));
      this._offBus.push(bus.on('race:state', (p) => this._onRaceState(p)));
      this._offBus.push(bus.on('race:countdown', (p) => { if (p?.value === 0) this.shake(0.22, 0.4); }));
      this._offBus.push(bus.on('race:eliminated', (p) => { if (p?.isPlayer) this.shake(0.35, 0.5); }));
      this._offBus.push(bus.on('input:camera', () => this._cycleMode()));
    }
    return this;
  }

  applySettings(settings) {
    const cam = settings?.camera || this.ctx?.settings?.camera;
    if (!cam) return this;
    if (Number.isFinite(cam.fov)) this.baseFov = clamp(cam.fov, FOV_MIN, FOV_MAX);
    if (Number.isFinite(cam.pitch)) this.basePitch = clamp(cam.pitch, PITCH_MIN, PITCH_MAX);
    if (Number.isFinite(cam.distance)) this.distanceTrim = clamp(cam.distance / DISTANCE_REF, 0.7, 1.5);
    if (Number.isFinite(cam.height)) this.minHeight = cam.height * 0.55;
    if (Number.isFinite(cam.lookahead)) this.lookaheadGain = clamp(cam.lookahead, 0, 1.5);
    if (Number.isFinite(cam.fovBoostKick)) this.fovBoostKick = clamp(cam.fovBoostKick, 0, 3);
    return this;
  }

  onResize(w, h) {
    if (w > 0 && h > 0) this.aspect = w / h;
    return this;
  }

  /* --------------------------------------------------------------- contract */

  setMode(mode, opts = {}) {
    const m = MODES.indexOf(mode) >= 0 ? mode : 'race';
    if (m === this.mode) return this;
    this.previousMode = this.mode;
    this.mode = m;
    this.modeTime = 0;
    if (m === 'intro') {
      this.introAngle = this._gridAngle();
      if (opts.duration > 0) this.introDuration = opts.duration;
      this.autoIntroToRace = opts.auto !== false;
    }
    if (m === 'results') this._resultsAngle = 0;
    if (m === 'replay') this._replayHold = 0;
    if (opts.snap) this._needSnap = true;
    this.ctx?.bus?.emit?.('camera:mode', { mode: m, from: this.previousMode });
    return this;
  }

  /**
   * Add camera shake.
   * @param {number} amount 0..1; multiple calls accumulate as trauma
   * @param {number} duration seconds for this contribution to decay away
   */
  shake(amount, duration = 0.4) {
    const a = clamp(Number(amount) || 0, 0, 1);
    if (a <= 0) return this;
    this.trauma = clamp(this.trauma + a, 0, 1);
    // Decay is the slowest currently-pending decay: a big hit's tail is not
    // cut short by a small one landing after it.
    this._traumaDecay = Math.min(this._traumaDecay, 1 / Math.max(0.08, duration));
    return this;
  }

  /** Frame a different car. A long jump cuts; a short one is damped. */
  focusOn(vehicle, opts = {}) {
    if (!vehicle) return this;
    const prev = this.focusTarget;
    this.focusTarget = vehicle;
    if (opts.snap === true) { this._needSnap = true; return this; }
    if (opts.snap === false) return this;
    if (prev?.position && vehicle.position) {
      // A sweep across half the playfield is nauseating; cut instead.
      if (prev.position.distanceToSquared(vehicle.position) > 130 * 130) this._needSnap = true;
    } else {
      this._needSnap = true;
    }
    return this;
  }

  /**
   * Depth of visible ground along the view direction, in world units, at the
   * widest framing the chase camera will currently choose. Race measures "a
   * screen ahead" with this rather than guessing at a number.
   */
  screenSpan() {
    const tanHalf = Math.tan(clamp(num(this._fovOut, this.baseFov), 10, 80) * 0.5 * DEG);
    const sinPitch = Math.max(0.15, Math.sin(clamp(num(this.pitch.value, this.basePitch), 5, 89) * DEG));
    const widest = Math.max(num(this.distance.value, 0), num(this._distCap, 0), 20);
    const span = (2 * widest * tanHalf) / sinPitch;
    return Number.isFinite(span) && span > 0 ? span : 96;
  }

  /** Ground width of the frame at the current pose. Handy for the minimap. */
  groundSpan() {
    return this.screenSpan() * this.aspect * Math.max(0.15, Math.sin(clamp(num(this.pitch.value, this.basePitch), 5, 89) * DEG));
  }

  /**
   * What the rig ACTUALLY produced last frame, measured from the final camera
   * transform rather than from the parameters that were supposed to produce it.
   * 'pitch' is the elevation of the camera above the framed car in degrees and
   * is the number the 48-62 contract is written against.
   */
  frameCheck() { return this._check; }

  /* ------------------------------------------------------------------- loop */

  lateUpdate(dt, ctx) {
    if (ctx) this.ctx = ctx;
    const camera = this.ctx?.camera;
    if (!camera || !this.enabled) return;

    // Keep the aspect honest even if nobody forwarded a resize to us: a stale
    // aspect would silently bias every screen-space solve below.
    if (camera.isPerspectiveCamera && camera.aspect > 0.1) this.aspect = camera.aspect;

    // core/Debug.js owns the camera while free-cam is on; stay out of its way
    // and cut cleanly when it hands back.
    if (this.ctx?.debug?.freeCam) {
      this._needSnap = true;
      this.ctx?.postfx?.setFocusBand?.(null);
      return;
    }

    const d = clamp(dt, 0, 0.05);
    this.time += d;
    this.modeTime += d;

    if (this.mode === 'free') {
      this.ctx?.postfx?.setFocusBand?.(null);
      return;
    }

    const v = this._target();
    if (!v || !v.position) {
      // No cars at all (the vehicle module failed, or a track-only capture).
      // The establishing orbit still makes a composed frame, so run it.
      if (this.mode === 'intro') this._orbitOnly(d, camera);
      return;
    }

    if (this._needSnap) {
      this._seedPose();
      this._needSnap = false;
    }

    switch (this.mode) {
      case 'intro':   this._intro(d, v); break;
      case 'results': this._results(d, v); break;
      case 'replay':  this._replay(d, v); break;
      case 'race':
      default:        this._race(d, v); break;
    }

    this._applyPose(camera, d, v);
  }

  _target() {
    const ctx = this.ctx;
    if (this.focusTarget && this.focusTarget.position) return this.focusTarget;
    if (ctx?.player?.position) { this.focusTarget = ctx.player; return ctx.player; }
    const first = ctx?.vehicles?.[0];
    if (first?.position) { this.focusTarget = first; return first; }
    return null;
  }

  /** Settle every damped value on the current desired pose. */
  _seedPose() {
    const v = this._target();
    if (!v?.position) return;
    this.anchor.copy(v.position);
    this.anchor.y += ANCHOR_LIFT;
    this._anchorVel.set(0, 0, 0);
    _fwd.set(0, 0, 1);
    if (v.forward) _fwd.set(v.forward.x, 0, v.forward.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    this.yaw.set(Math.atan2(_fwd.x, _fwd.z));
    this.pitch.set(clamp(this.basePitch, PITCH_MIN, PITCH_MAX));
    this.fov.set(this.baseFov);
    this.distance.set(this._nominalDistance(v));
    this.roll.set(0);
    this.frameY.set(FRAME_Y_REST * this._leadGain());
    this.frameX.set(0);
  }

  /* ------------------------------------------------- the framing arithmetic */

  /**
   * Vertical extent the car occupies in the image plane, in world units. The
   * body lies flat, so its length is foreshortened by sin(pitch) while its
   * height projects by cos(pitch); at 55 degrees a 9.0 x 2.8 u die-cast gives
   * 9.0*0.819 + 2.8*0.574 = 8.98 u.
   */
  _subjectExtent(v, pitchRad) {
    const L = num(v?.spec?.bodyLength, 9);
    const H = num(v?.spec?.bodyHeight, 2.8);
    return Math.abs(L * Math.sin(pitchRad)) + Math.abs(H * Math.cos(pitchRad));
  }

  /** Distance at which the subject fills 'frac' of the frame height. */
  _distanceForFrac(v, pitchRad, fovDeg, frac) {
    const tanHalf = Math.tan(clamp(fovDeg, 10, 80) * 0.5 * DEG);
    const extent = this._subjectExtent(v, pitchRad);
    return extent / Math.max(1e-4, 2 * clamp(frac, 0.01, 0.9) * tanHalf);
  }

  /** Resting framing distance, used to seed the damper before any car exists. */
  _nominalDistance(v = null) {
    const d = this._distanceForFrac(v, clamp(this.basePitch, PITCH_MIN, PITCH_MAX) * DEG, this.baseFov, SUBJECT_REST);
    return clamp(d * this.distanceTrim, 24, 400);
  }

  /** The tuning panel's 'camera.lookahead' as a multiplier on the framing lead. */
  _leadGain() { return clamp(this.lookaheadGain / 0.35, 0.4, 1.6); }

  /* ------------------------------------------------------------- race camera */

  _race(dt, v) {
    const speed = Math.max(0, num(v.speed, 0));
    const top = Math.max(50, num(v.topSpeed, 100));
    const sn = clamp(speed / top, 0, 1);
    const boost = clamp(num(v.boostAmount, v.boosting ? 1 : 0), 0, 1);
    const air = v.isAirborne ? 1 : 0;

    /* --- direction of travel --------------------------------------------- */
    // The camera sits behind where the car is GOING, not behind its nose. In a
    // drift those differ by the slip angle, and the difference is the shot.
    _fwd.set(num(v.forward?.x, 0), 0, num(v.forward?.z, 1));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();

    _dir.set(num(v.velocity?.x, 0), 0, num(v.velocity?.z, 0));
    const planar = _dir.length();
    if (planar > 1e-4) _dir.divideScalar(planar);
    else _dir.copy(_fwd);

    // Below walking pace the velocity direction is noise; above it, blend in.
    // Reversing keeps the nose-based framing — swinging round behind a car that
    // is backing out of a wall would be disorienting.
    const facing = _dir.dot(_fwd);
    const blend = facing < -0.2 ? 0 : smoothstep(3, 22, planar);
    _travel.copy(_fwd).lerp(_dir, blend);
    if (_travel.lengthSq() < 1e-6) _travel.copy(_fwd);
    _travel.normalize();

    /* --- anchor: the car itself, never a point ahead of it ---------------- */
    _anchorWant.copy(v.position);
    _anchorWant.y += ANCHOR_LIFT;
    this._dampAnchor(_anchorWant, TAU.anchorXZ, TAU.anchorY, dt);

    /* --- yaw -------------------------------------------------------------- */
    this.yaw.to(Math.atan2(_travel.x, _travel.z), TAU.yaw, dt);

    /* --- pitch ------------------------------------------------------------ */
    // Higher and more top-down when crawling (you need to see the corner);
    // flatter at speed (there is more road to show). 55 + 3 = 58 parked, 52 at
    // top speed, and the clamp makes the band unconditional.
    this.pitch.to(clamp(this.basePitch + 3 - sn * 6, PITCH_MIN, PITCH_MAX), TAU.pitch, dt);

    /* --- fov: long lens, and it stays long -------------------------------- */
    // Contract band is 30-36. 33 + 1.2 + 1.8 = 36.0 at the absolute limit, so
    // the clamp is a guarantee rather than a rescue.
    this.fov.to(clamp(this.baseFov + sn * 1.2 + boost * this.fovBoostKick, FOV_MIN, FOV_MAX), TAU.fov, dt);
    this._fovOut = this.fov.value;

    /* --- distance: frame the car, then widen for the fight ---------------- */
    this._solveDistance(v, sn, boost, air, dt);

    /* --- screen-space framing offsets ------------------------------------- */
    // Vertical: the lookahead, expressed where it can be bounded.
    this.frameY.to(lerp(FRAME_Y_REST, FRAME_Y_FAST, sn) * this._leadGain(), TAU.frameY, dt);
    // Lateral: sliding to the car's left puts the car on the right of frame, so
    // the picture opens in the direction it is actually travelling.
    const lat = clamp(num(v.lateralSpeed, 0) / 32, -1, 1);
    const steerBias = clamp(num(v.steerPos, 0), -1, 1) * 0.35 * sn;
    this.frameX.to(clamp(lat * 0.8 + steerBias, -1, 1) * FRAME_X_SWING, TAU.frameX, dt);

    /* --- roll: bank into the slide ---------------------------------------- */
    // lateralSpeed is signed towards the car's left, which is the only slip
    // signal on Vehicle with a documented sign. Tipping the horizon the same
    // way the car is sliding reads as weight; the opposite reads as a bug.
    this.roll.to(-(lat * 0.85 + steerBias) * MAX_ROLL, TAU.roll, dt);
    this._rollOut = this.roll.value;

    /* --- pose ------------------------------------------------------------- */
    const D = this._boom(this.pitch.value, this.distance.value, _camWant);
    this._composeLook(D, this.frameY.value, this.frameX.value, _lookWant);
  }

  /**
   * Auto-zoom. Three terms, in priority order:
   *   1. the framing solve — the distance at which the car occupies the wanted
   *      fraction of frame height;
   *   2. the rival fit — far enough back that anyone in the fight is inside the
   *      frame, solved per rival from where they land in ndc;
   *   3. the floor — the car may never drop below SUBJECT_FLOOR of the frame,
   *      which caps 2 rather than being traded against it.
   */
  _solveDistance(v, sn, boost, air, dt) {
    const pitchRad = this.pitch.value * DEG;
    const fovDeg = this.fov.value;
    const tanHalf = Math.tan(clamp(fovDeg, 10, 80) * 0.5 * DEG);
    const sinPitch = Math.max(0.2, Math.sin(pitchRad));

    const frame = this._distanceForFrac(v, pitchRad, fovDeg, lerp(SUBJECT_REST, SUBJECT_FAST, sn)) * this.distanceTrim;
    const floor = this._distanceForFrac(v, pitchRad, fovDeg, SUBJECT_FLOOR);

    /* --- rivals ---------------------------------------------------------- */
    // How far back the camera must be for a rival at (s along travel, u
    // lateral) to land inside FRAME_EDGE. A ground offset of s along travel
    // displaces the image by s*sin(pitch); a lateral offset u displaces it by u,
    // and ndc_x is additionally divided by the aspect ratio.
    let need = 0;
    const vehicles = this.ctx?.vehicles;
    if (Array.isArray(vehicles)) {
      const ndcY = this.frameY.value;
      const px = v.position.x;
      const pz = v.position.z;
      for (let i = 0; i < vehicles.length; i++) {
        const o = vehicles[i];
        if (!o || o === v || !o.position) continue;
        if (o.eliminated || (o.group && o.group.visible === false)) continue;
        const dx = o.position.x - px;
        const dz = o.position.z - pz;
        if (dx * dx + dz * dz > RIVAL_RADIUS * RIVAL_RADIUS) continue;
        const s = dx * _travel.x + dz * _travel.z;               // along travel
        const u = dx * -_travel.z + dz * _travel.x;              // screen right
        const roomY = Math.max(0.25, s >= 0 ? FRAME_EDGE - ndcY : FRAME_EDGE + ndcY);
        const needY = (Math.abs(s) * sinPitch) / (roomY * tanHalf);
        const needX = Math.abs(u) / (FRAME_EDGE * tanHalf * this.aspect);
        const n = Math.max(needY, needX);
        if (n > need) need = n;
      }
    }

    let want = Math.max(frame, Math.min(need, frame * RIVAL_ZOOM_MAX));
    // Punch in on boost, ease out slightly in the air so a jump reads as height.
    want *= (1 - boost * 0.10) * (1 + air * 0.06);
    // The floor is the last word: nothing above may shrink the car past it.
    this._distCap = Math.min(frame * RIVAL_ZOOM_MAX, floor);
    this.distance.to(clamp(want, frame * 0.85, Math.max(frame * 0.85, this._distCap)), TAU.dist, dt);
  }

  /**
   * Put the camera on the boom at 'pitchDeg' above the anchor and return the
   * resulting camera-to-anchor distance. The elevation of the returned position
   * above the anchor is exactly 'pitchDeg' — that identity is what makes the
   * 48-62 band a property of the rig rather than of the tuning.
   */
  _boom(pitchDeg, dist, outPos) {
    const pitchRad = clamp(num(pitchDeg, this.basePitch), 5, 88) * DEG;
    const yaw = this.yaw.value;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const d = Math.max(6, num(dist, this._nominalDistance()));
    let horiz = d * Math.cos(pitchRad);
    let height = d * Math.sin(pitchRad);

    // Never let the camera drop into the table. Raising Y alone would steepen
    // the shot straight out of the contract band, so the boom is extended along
    // its own axis instead: same angle, further out.
    const track = this.ctx?.track;
    if (track?.heightAt) {
      try {
        const gy = track.heightAt(this.anchor.x - sy * horiz, this.anchor.z - cy * horiz);
        if (Number.isFinite(gy)) {
          const need = gy + this.minHeight - this.anchor.y;
          if (need > height) {
            height = Math.min(need, height * 2.2);
            horiz = height / Math.max(0.05, Math.tan(pitchRad));
          }
        }
      } catch (_) { /* a stub track is allowed to not answer */ }
    }

    outPos.set(this.anchor.x - sy * horiz, this.anchor.y + height, this.anchor.z - cy * horiz);
    this._boomPitch = pitchRad;
    this._boomHoriz = horiz;
    this._boomHeight = height;
    return Math.sqrt(horiz * horiz + height * height);
  }

  /**
   * Solve the aim point from where the subject is wanted in frame.
   *
   * For a pinhole camera a point at angle a from the optical axis lands at
   * ndc = tan(a)/tan(fov/2). The anchor sits on the boom axis, so aiming at a
   * point 'lead' further along travel raises the axis by
   *
   *     a = atan( lead*sin(pitch) / (D + lead*cos(pitch)) )
   *
   * and drops the subject to ndc_y = -tan(a)/tan(fov/2). Inverting for lead
   * with k = -ndc_y * tan(fov/2):
   *
   *     lead = k*D / ( sin(pitch) - k*cos(pitch) )
   *
   * At D = 80, pitch 55, fov 33 and ndc_y = -0.34 that is 10.6 u of lead along
   * the velocity vector — genuine lookahead, just expressed where it can be
   * bounded. The denominator cannot approach zero: the widest the tuning panel
   * can drive this is ndc_y = -0.544 at fov 36, i.e. k = 0.177, against
   * sin(48) = 0.743 and k*cos(48) = 0.118, so denom >= 0.625. The Math.max
   * below covers anything a future caller invents. Both lead and the resulting
   * screen position are clamped, so no combination of speed, gain or dt can
   * walk the subject out of the frame the way world-unit lookahead did.
   */
  _composeLook(D, ndcY, ndcX, out) {
    const pitchRad = this._boomPitch;
    const tanHalf = Math.tan(clamp(num(this._fovOut, this.baseFov), 12, 60) * 0.5 * DEG);
    const yaw = this.yaw.value;
    const tx = Math.sin(yaw);
    const tz = Math.cos(yaw);
    // Screen right for a camera looking along (tx,0,tz) with world up: f x up.
    const rx = -tz;
    const rz = tx;

    const k = clamp(-num(ndcY, 0), -0.15, 0.75) * tanHalf;
    const denom = Math.max(0.12, Math.sin(pitchRad) - k * Math.cos(pitchRad));
    const lead = clamp((k * D) / denom, -D * 0.35, D * 0.8);
    const axial = Math.max(1, D + lead * Math.cos(pitchRad));
    const side = -clamp(num(ndcX, 0), -0.4, 0.4) * tanHalf * this.aspect * axial;

    out.set(
      this.anchor.x + tx * lead + rx * side,
      this.anchor.y,
      this.anchor.z + tz * lead + rz * side
    );
    this._lead = lead;
    return out;
  }

  /* ------------------------------------------------------------ intro camera */

  /**
   * Slow cinematic orbit that establishes the circuit, then dissolves into the
   * race pose so the cut to 'race' is invisible. The orbit distance is SOLVED
   * from the track radius and the lens rather than guessed: at each moment the
   * shot is exactly far enough back that 'fit' multiples of the circuit radius
   * are inside the frame in both axes, so a big track opens wide and a small one
   * does not sit lost in the middle of the table.
   */
  _intro(dt, v) {
    // Keep the chase solve alive underneath the orbit so it is already settled
    // when the dissolve reaches it.
    this._race(dt, v);

    const centre = this._trackCentre();
    const radius = this._trackRadius();

    const p = clamp(this.modeTime / Math.max(0.5, this.introDuration), 0, 1);
    const ease = smoothstep(0, 1, p);
    const ang = this.introAngle + p * INTRO_SWEEP;

    const pitchDeg = lerp(INTRO_PITCH_A, INTRO_PITCH_B, ease);
    const fit = lerp(INTRO_FIT_A, INTRO_FIT_B, ease);
    const dist = this._introFit(pitchDeg, radius * fit);
    const pitchRad = pitchDeg * DEG;

    _introPos.set(
      centre.x + Math.sin(ang) * dist * Math.cos(pitchRad),
      centre.y + dist * Math.sin(pitchRad),
      centre.z + Math.cos(ang) * dist * Math.cos(pitchRad)
    );
    // The look target walks from the whole circuit down onto the grid.
    _introLook.copy(centre).lerp(this.anchor, ease * 0.85);

    // Used raw, not damped: smoothstep is already C1, and running it through a
    // second-order filter as well left the blend at ~0.88 when p hit 1, which
    // is a visible pop on the cut to 'race'.
    const b = smoothstep(this.introDuration - INTRO_BLEND, this.introDuration, this.modeTime);

    // _race() already filled _camWant / _lookWant with the chase pose.
    _camWant.lerp(_introPos, 1 - b);
    _lookWant.lerp(_introLook, 1 - b);
    // Widest lens the contract allows for the establishing shot, easing onto the
    // racing lens. The damper itself is left alone so the chase solve stays
    // continuous underneath.
    this._fovOut = lerp(FOV_MAX, this.fov.value, b * b);
    this._rollOut = this.roll.value * b;

    if (p >= 1 && this.autoIntroToRace) this.setMode('race');
  }

  /** Intro orbit with nothing to chase: circuit only, no chase blend. */
  _orbitOnly(dt, camera) {
    const centre = this._trackCentre();
    const radius = this._trackRadius();
    const p = clamp(this.modeTime / Math.max(0.5, this.introDuration), 0, 1);
    const ease = smoothstep(0, 1, p);
    const ang = this.introAngle + p * INTRO_SWEEP;

    const pitchDeg = lerp(INTRO_PITCH_A, INTRO_PITCH_B, ease);
    const dist = this._introFit(pitchDeg, radius * lerp(INTRO_FIT_A, INTRO_FIT_B * 2.2, ease));
    const pitchRad = pitchDeg * DEG;

    this.anchor.copy(centre);
    _camWant.set(
      centre.x + Math.sin(ang) * dist * Math.cos(pitchRad),
      centre.y + dist * Math.sin(pitchRad),
      centre.z + Math.cos(ang) * dist * Math.cos(pitchRad)
    );
    _lookWant.copy(centre);
    this._fovOut = lerp(FOV_MAX, this.baseFov, ease);
    this._rollOut = 0;
    this._applyPose(camera, dt, null);
  }

  /**
   * Distance at which a disc of radius 'want' centred on the look target fits
   * inside the frame in both axes. Vertically the ground is foreshortened by
   * sin(pitch), which is why the two terms differ.
   */
  _introFit(pitchDeg, want) {
    const tanHalf = Math.tan(FOV_MAX * 0.5 * DEG);
    const sinPitch = Math.max(0.2, Math.sin(clamp(pitchDeg, 5, 88) * DEG));
    const r = Math.max(20, num(want, 200));
    const dVert = (r * sinPitch) / tanHalf;
    const dHorz = r / (tanHalf * Math.max(0.5, this.aspect));
    return clamp(Math.max(dVert, dHorz), 90, 1800);
  }

  _trackCentre() {
    const c = this.ctx?.track?.center;
    return (c && Number.isFinite(c.x)) ? c : _origin;
  }

  _trackRadius() {
    const track = this.ctx?.track;
    let r = num(track?.radius, 0);
    if (!(r > 0) && track?.bounds?.min && track?.bounds?.max) {
      const b = track.bounds;
      r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5;
    }
    return clamp(r > 0 ? r : 180, 60, 900);
  }

  /* ---------------------------------------------------------- results camera */

  _results(dt, v) {
    const hero = this._resultsSubject() || v;
    this._resultsAngle += dt * 0.30;

    _anchorWant.copy(hero.position);
    _anchorWant.y += 1.6;
    this._dampAnchor(_anchorWant, 0.22, 0.30, dt);

    // Low, close, long: the hero shot. Deliberately outside the racing pitch
    // band because this is not a racing camera — _frameCheck only asserts the
    // band in 'race'.
    this.pitch.to(23, 0.8, dt);
    this.distance.to(this._distanceForFrac(hero, 23 * DEG, 30, 0.42), 0.8, dt);
    this.fov.to(FOV_MIN, 0.8, dt);
    this.roll.to(0, 0.6, dt);
    this.yaw.to(wrapPi(this._resultsAngle), 0.9, dt);
    this.frameY.to(0, 0.6, dt);
    this.frameX.to(0, 0.6, dt);

    this._fovOut = this.fov.value;
    this._rollOut = this.roll.value;
    const D = this._boom(this.pitch.value, this.distance.value, _camWant);
    this._composeLook(D, this.frameY.value, this.frameX.value, _lookWant);
  }

  _resultsSubject() {
    const standings = this.ctx?.race?.standings;
    if (Array.isArray(standings) && standings.length) {
      const winner = standings[0]?.vehicle;
      if (winner?.position) return winner;
    }
    return null;
  }

  /* ----------------------------------------------------------- replay camera */

  /**
   * A trackside television camera: plant it outside the circuit ahead of the
   * subject, hold the shot as they come past, then cut to the next one. Cutting
   * rather than gliding is what makes it read as broadcast coverage.
   */
  _replay(dt, v) {
    const track = this.ctx?.track;
    this._replayHold -= dt;

    if (track?.sampleAt && track?.surfacePoint) {
      const carT = num(v.trackT, 0);
      const passed = this._replayHold <= 0
        || this._replayAnchor.distanceToSquared(v.position) > 210 * 210;
      if (passed) {
        this._replaySide = -this._replaySide;
        this._replayT = carT + 0.052;
        try {
          const s = track.sampleAt(this._replayT);
          const lateral = (num(s?.halfWidth, 14) + 34) * this._replaySide;
          track.surfacePoint(s.t, lateral, this._replayAnchor);
          this._replayAnchor.y += 26;
        } catch (_) {
          this._replayAnchor.copy(v.position).add(_v.set(46 * this._replaySide, 28, 46));
        }
        this._replayHold = 4.2;
      }
    } else {
      this._replayAnchor.copy(v.position).add(_v.set(46, 28, 46));
      this._replayHold = 4.2;
    }

    _anchorWant.copy(v.position);
    _anchorWant.y += 1.4;
    this._dampAnchor(_anchorWant, 0.14, 0.20, dt);

    this.fov.to(FOV_MIN, 0.5, dt);
    this.roll.to(0, 0.5, dt);

    this._fovOut = this.fov.value;
    this._rollOut = this.roll.value;
    _camWant.copy(this._replayAnchor);
    _lookWant.copy(this.anchor);
  }

  /* ------------------------------------------------------------------- pose */

  _applyPose(camera, dt, v) {
    /* --- shake ------------------------------------------------------------ */
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - this._traumaDecay * dt);
      if (this.trauma <= 0) this._traumaDecay = 2.5;
    }
    const scale = num(this.ctx?.settings?.gameplay?.cameraShake, 1);
    // Squaring trauma is the classic trick: a small hit is a nudge, a big one
    // is violent, and the tail always decays gracefully rather than stopping.
    const s = this.trauma * this.trauma * scale;
    let shakeRoll = 0;
    if (s > 1e-4) {
      const t = this.time * SHAKE_FREQ;
      const sd = this._noiseSeed;
      _v.set(
        simplex2D(t, 0.0, sd),
        simplex2D(t, 11.3, sd),
        simplex2D(t, 23.7, sd)
      ).multiplyScalar(s * SHAKE_POS);
      _camWant.add(_v);
      // Move the look target by a fraction of the same noise so the shake is a
      // handheld wobble, not a pure translation of a rigidly aimed camera.
      _lookWant.addScaledVector(_v, 0.25);
      shakeRoll = simplex2D(t, 37.1, sd) * s * SHAKE_ROT;
    }

    /* --- write ------------------------------------------------------------ */
    if (!Number.isFinite(_camWant.x) || !Number.isFinite(_camWant.y) || !Number.isFinite(_camWant.z)) return;
    camera.position.copy(_camWant);

    _v2.copy(_lookWant).sub(_camWant);
    if (_v2.lengthSq() < 1e-6) _v2.set(0, -1, -0.001);
    _v.copy(_camWant).add(_v2);
    _m4.lookAt(_camWant, _v, _up);
    _q.setFromRotationMatrix(_m4);
    const roll = this._rollOut + shakeRoll;
    if (Math.abs(roll) > 1e-5) {
      _qRoll.setFromAxisAngle(_axisZ, roll);
      _q.multiply(_qRoll);
    }
    camera.quaternion.copy(_q);

    if (camera.isPerspectiveCamera) {
      // Absolute guard, two degrees outside the contract band on each side so a
      // mode transition can pass through without being visibly clipped.
      const f = clamp(num(this._fovOut, this.baseFov), FOV_MIN - 2, FOV_MAX + 2);
      if (Math.abs(camera.fov - f) > 1e-3) {
        camera.fov = f;
        camera.updateProjectionMatrix();
      }
    }
    camera.updateMatrixWorld(true);

    this._frameCheck(camera, v);
    this._feedFocusBand();
  }

  /**
   * Measure what the rig actually produced, from the final camera transform and
   * the framed car's world position — not from the parameters that were meant
   * to produce them. This is the assertion the contract is written against.
   *
   * The renderer refreshes matrixWorldInverse inside render(), which is after
   * lateUpdate, so the projection has to be done from matrixWorld by hand.
   */
  _frameCheck(camera, v) {
    const c = this._check;
    const pos = v?.position || this.anchor;

    const dx = camera.position.x - pos.x;
    const dy = camera.position.y - pos.y;
    const dz = camera.position.z - pos.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const dist = Math.sqrt(horiz * horiz + dy * dy);

    c.pitch = Math.atan2(dy, Math.max(1e-4, horiz)) / DEG;
    c.distance = dist;
    c.fov = camera.isPerspectiveCamera ? camera.fov : num(this._fovOut, this.baseFov);

    const tanHalf = Math.tan(clamp(c.fov, 5, 100) * 0.5 * DEG);
    c.subjectFrac = v
      ? this._subjectExtent(v, c.pitch * DEG) / Math.max(1e-3, 2 * dist * tanHalf)
      : 0;

    _mInv.copy(camera.matrixWorld).invert();
    _proj.copy(pos).applyMatrix4(_mInv);
    // View space: three's cameras look down -Z, so anything in front is z < 0.
    // Checking here rather than after the projection avoids the sign flip that
    // makes a point behind the camera project to a plausible-looking ndc.
    c.inFront = _proj.z < -0.01;
    _proj.applyMatrix4(camera.projectionMatrix);
    c.ndcX = Number.isFinite(_proj.x) ? _proj.x : 0;
    c.ndcY = Number.isFinite(_proj.y) ? _proj.y : 0;
    c.onScreen = c.inFront && Math.abs(c.ndcX) <= 1 && Math.abs(c.ndcY) <= 1;
    c.inBand = c.pitch >= PITCH_MIN - 0.5 && c.pitch <= PITCH_MAX + 0.5;

    // Warn once per session rather than per frame: a camera fault that spams
    // the console at 60 Hz is a camera fault nobody reads.
    if (this.mode === 'race' && this.modeTime > 1 && v) {
      if (!c.inBand && !this._bandWarned) {
        this._bandWarned = true;
        console.warn('[Director] chase elevation left the 48-62 contract band:', c.pitch.toFixed(2), 'deg');
      }
      if (c.subjectFrac < SUBJECT_FLOOR * 0.94 && !this._fracWarned) {
        this._fracWarned = true;
        console.warn('[Director] subject below the framing floor:', (c.subjectFrac * 100).toFixed(1), '% of frame height');
      }
    }
    return c;
  }

  /**
   * Hand PostFX the screen-space Y of the framed car so the tilt-shift band
   * sits on the subject instead of on a fixed line through the frame.
   *
   * Signature, read from render/PostFX.js: setFocusBand(centre, width, falloff)
   *   centre  uv.y of the band, or null to let PostFX track ctx.player itself
   *   width   half-height of the sharp band in uv.y, clamped there to [0.04, 0.21]
   *   falloff the ramp EXPONENT (Settings ships 2 = quadratic), NOT a distance
   */
  _feedFocusBand() {
    const postfx = this.ctx?.postfx;
    if (!postfx?.setFocusBand) return;

    const params = this.ctx?.settings?.post?.params;
    const baseBand = num(params?.tiltShiftBand, 0.22);
    const baseFall = num(params?.tiltShiftFalloff, 2);

    const v = this._target();
    const speed = Math.max(0, num(v?.speed, 0));
    const top = Math.max(50, num(v?.topSpeed, 100));
    const sn = clamp(speed / top, 0, 1);
    // Narrower band with speed: more of the frame goes soft, the miniature
    // illusion strengthens exactly when the action is most legible anyway.
    // The intro wants the opposite — an establishing shot has to be readable.
    const band = this.mode === 'intro'
      ? baseBand * 2.1
      : baseBand * (1 - sn * 0.22);

    const c = this._check;
    let centre = null;
    if (c.inFront) {
      // Bias the band a little above the subject so the road it is about to
      // drive into stays sharp; below it is already past and may go soft.
      centre = clamp(c.ndcY * 0.5 + 0.5 + 0.045, 0.13, 0.87);
    }
    postfx.setFocusBand(centre, band, baseFall);
  }

  /* ------------------------------------------------------------------ events */

  _onImpact(p) {
    const v = p?.vehicle || p?.a || null;
    const subject = this._target();
    if (!v || !subject) return;
    const mag = Math.abs(p?.impulse ?? p?.force ?? p?.relativeSpeed ?? 0);
    if (!(mag > 0)) return;
    // Somebody else's shunt still registers, but only if it happens on camera.
    let weight = 1;
    if (v !== subject) {
      if (!v.position || !subject.position) return;
      const d = v.position.distanceTo(subject.position);
      if (d > RIVAL_RADIUS * 2) return;
      weight = 0.35 * (1 - d / (RIVAL_RADIUS * 2));
    }
    this.shake(clamp(mag / 460, 0, 1) * 0.85 * weight, 0.3 + clamp(mag / 900, 0, 1) * 0.35);
  }

  _onLand(p) {
    const v = p?.vehicle;
    if (!v || v !== this._target()) return;
    const air = Math.max(0, p?.airTime || 0);
    if (air < 0.25) return;
    this.shake(clamp(air * 0.5, 0, 0.55), 0.28);
  }

  _onRaceState(p) {
    const to = p?.to;
    switch (to) {
      case 'attract':
        this.setMode('intro', { auto: false });
        break;
      case 'grid':
      case 'countdown':
      case 'racing':
        if (this.mode !== 'race') this.setMode('race');
        break;
      case 'results':
        this.setMode('results');
        break;
      default:
        break;
    }
  }

  /** The camera key cycles the shots a player is allowed to choose. */
  _cycleMode() {
    const order = ['race', 'replay'];
    const i = order.indexOf(this.mode);
    this.setMode(order[(i + 1) % order.length]);
  }

  /** Where the grid sits, so the intro orbit ends looking at the right place. */
  _gridAngle() {
    const centre = this.ctx?.track?.center;
    const v = this._target();
    if (!centre || !v?.position) return 0;
    return Math.atan2(v.position.x - centre.x, v.position.z - centre.z) - INTRO_SWEEP * 0.5;
  }

  /* ----------------------------------------------------------------- helpers */

  /**
   * Critically damped anchor. XZ and Y get separate smoothing times: the car
   * must stay put in frame laterally, but suspension bob must never reach the
   * lens, and one shared time cannot do both.
   */
  _dampAnchor(target, tauXZ, tauY, dt) {
    if (!(dt > 0)) return this.anchor;
    const cur = this.anchor;
    const vel = this._anchorVel;
    const oXZ = 2 / Math.max(1e-4, tauXZ);
    const oY = 2 / Math.max(1e-4, tauY);
    const eXZ = expCoef(tauXZ, dt);
    const eY = expCoef(tauY, dt);
    cur.x = dampAxis(cur, vel, target.x, 'x', oXZ, dt, eXZ);
    cur.y = dampAxis(cur, vel, target.y, 'y', oY, dt, eY);
    cur.z = dampAxis(cur, vel, target.z, 'z', oXZ, dt, eXZ);
    return cur;
  }

  /** Compact snapshot for the debug overlay. */
  snapshot() {
    const c = this._check;
    return {
      mode: this.mode,
      target: this.focusTarget?.id ?? '—',
      pitch: +c.pitch.toFixed(1),          // MEASURED, not requested
      dist: +c.distance.toFixed(1),
      fov: +c.fov.toFixed(1),
      carPct: +(c.subjectFrac * 100).toFixed(1),
      ndcY: +c.ndcY.toFixed(2),
      lead: +this._lead.toFixed(1),
      roll: +(this._rollOut / DEG).toFixed(2),
      trauma: +this.trauma.toFixed(2),
      span: +this.screenSpan().toFixed(0),
      inBand: c.inBand,
    };
  }

  dispose() {
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    return this;
  }
}

function dampAxis(cur, vel, target, key, omega, dt, exp) {
  if (!Number.isFinite(target)) return cur[key];
  const change = cur[key] - target;
  const temp = (vel[key] + omega * change) * dt;
  vel[key] = (vel[key] - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if (Math.abs(out - target) < 1e-4 && Math.abs(vel[key]) < 1e-3) {
    out = target;
    vel[key] = 0;
  }
  return out;
}

export function makeDirector(ctx) { return new Director(ctx); }

export default Director;
