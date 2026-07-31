// game/Director.js — the camera, treated as cinematography rather than plumbing.
//
// The shot is a high-angle three-quarter chase on a long lens: pitch inside the
// 48-62 degree band, fov 30-36, framing the player with lookahead along the
// direction they are actually travelling — not along the nose, which is what
// makes a drift read as a drift instead of as a bug.
//
// EVERY MOTION IS CRITICALLY DAMPED. Not lerped, not sprung: a proper
// second-order critically damped solve (Game Programming Gems 4's SmoothDamp),
// which has no oscillation by construction and is frame-rate independent. What
// gets damped is the *pose parameters* — focus point, yaw, pitch, distance,
// fov, roll — and the camera position is then derived analytically from them.
// Damping the final position instead is the classic mistake: it lags behind on
// a straight and cuts the corner on a turn.
//
// The camera also drives the tilt-shift band. PostFX will track ctx.player on
// its own, but the Director knows which car is actually being framed (spectate,
// replay, results), so it projects that car itself and hands PostFX the
// screen-space Y through setFocusBand(centre, width, falloff).
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
const _focusWant = new THREE.Vector3();
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

// Smoothing times in seconds — the time to close ~63% of the remaining error.
// Focus is tight (the car must stay put in frame); yaw is slack (so a drift
// swings the camera lazily instead of whipping it).
const TAU = Object.freeze({
  focus: 0.11,
  yaw: 0.30,
  pitch: 0.45,
  dist: 0.34,
  fov: 0.28,
  roll: 0.24,
  intro: 0.55,
});

const RIVAL_RADIUS = 115;      // u — rivals further out than this are not framed
const MAX_LOOKAHEAD = 26;      // u — about three car lengths
const MAX_ROLL = 3.6 * DEG;
const SHAKE_POS = 2.4;         // u of translation at full trauma
const SHAKE_ROT = 1.15 * DEG;  // rotational shake at full trauma
const SHAKE_FREQ = 13.5;       // Hz-ish; fast enough to read as an impact
const INTRO_SWEEP = 2.35;      // radians of orbit across the establishing shot
const INTRO_BLEND = 1.7;       // seconds of cross-fade into the race pose

/* ------------------------------------------------------------------ helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
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

/**
 * One critically damped scalar. No overshoot, no ringing, and frame-rate
 * independent — the exp approximation is the standard rational fit, accurate to
 * well under a pixel across any dt this game will ever see.
 */
class Damped {
  constructor(value = 0) {
    this.value = value;
    this.vel = 0;
  }

  to(target, smoothTime, dt) {
    if (!(dt > 0)) return this.value;
    const st = Math.max(1e-4, smoothTime);
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
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

  set(v) { this.value = v; this.vel = 0; return v; }
}

/** Same solve, but on the shortest angular path so ±π never causes a spin. */
class DampedAngle extends Damped {
  to(target, smoothTime, dt) {
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
    this.baseFov = Number.isFinite(cam.fov) ? cam.fov : 33;
    this.basePitch = Number.isFinite(cam.pitch) ? cam.pitch : 55;
    this.baseDistance = Number.isFinite(cam.distance) ? cam.distance : 46;
    this.minHeight = Number.isFinite(cam.height) ? cam.height * 0.55 : 14;
    this.lookaheadGain = Number.isFinite(cam.lookahead) ? cam.lookahead : 0.35;
    this.fovBoostKick = Number.isFinite(cam.fovBoostKick) ? cam.fovBoostKick : 4;

    this.focusTarget = ctx?.player || null;
    this.aspect = 16 / 9;

    /* --- damped pose ----------------------------------------------------- */
    this.focus = new THREE.Vector3();
    this._focusVel = new THREE.Vector3();
    this.yaw = new DampedAngle(0);
    this.pitch = new Damped(this.basePitch);
    this.distance = new Damped(this.baseDistance);
    this.fov = new Damped(this.baseFov);
    this.roll = new Damped(0);
    this.introBlend = new Damped(0);

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

    /* --- intro / results / replay ---------------------------------------- */
    this.introDuration = 8.6;
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
    if (Number.isFinite(cam.fov)) this.baseFov = cam.fov;
    if (Number.isFinite(cam.pitch)) this.basePitch = cam.pitch;
    if (Number.isFinite(cam.distance)) this.baseDistance = cam.distance;
    if (Number.isFinite(cam.height)) this.minHeight = cam.height * 0.55;
    if (Number.isFinite(cam.lookahead)) this.lookaheadGain = cam.lookahead;
    if (Number.isFinite(cam.fovBoostKick)) this.fovBoostKick = cam.fovBoostKick;
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
      this.introBlend.set(0);
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
   * widest framing the chase camera will ever choose. Race measures "a screen
   * ahead" with this rather than guessing at a number.
   */
  screenSpan() {
    const tanHalf = Math.tan(clamp(this.fov.value || this.baseFov, 10, 80) * 0.5 * DEG);
    const pitchRad = clamp(this.pitch.value || this.basePitch, 10, 85) * DEG;
    const widest = this.baseDistance * 1.75;
    return (2 * widest * tanHalf) / Math.max(0.15, Math.sin(pitchRad));
  }

  /** Ground width of the frame at the current pose. Handy for the minimap. */
  groundSpan() {
    return this.screenSpan() * this.aspect;
  }

  /* ------------------------------------------------------------------- loop */

  lateUpdate(dt, ctx) {
    if (ctx) this.ctx = ctx;
    const camera = this.ctx?.camera;
    if (!camera || !this.enabled) return;

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
    this.focus.copy(v.position);
    this.focus.y += 2.2;
    this._focusVel.set(0, 0, 0);
    _fwd.set(0, 0, 1);
    if (v.forward) _fwd.set(v.forward.x, 0, v.forward.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    this.yaw.set(Math.atan2(_fwd.x, _fwd.z));
    this.pitch.set(this.basePitch);
    this.distance.set(this.baseDistance);
    this.fov.set(this.baseFov);
    this.roll.set(0);
  }

  /* ------------------------------------------------------------- race camera */

  _race(dt, v) {
    const speed = Math.max(0, v.speed || 0);
    const top = Math.max(50, v.topSpeed || 100);
    const sn = clamp(speed / top, 0, 1);
    const boost = clamp(v.boostAmount ?? (v.boosting ? 1 : 0), 0, 1);
    const air = v.isAirborne ? 1 : 0;

    /* --- direction of travel --------------------------------------------- */
    // The camera sits behind where the car is GOING, not behind its nose. In a
    // drift those differ by the slip angle, and the difference is the shot.
    _fwd.set(v.forward?.x ?? 0, 0, v.forward?.z ?? 1);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();

    _dir.set(v.velocity?.x ?? 0, 0, v.velocity?.z ?? 0);
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

    /* --- focus point ------------------------------------------------------ */
    const lookahead = Math.min(MAX_LOOKAHEAD, this.lookaheadGain * speed * 0.34);
    _focusWant.copy(v.position).addScaledVector(_travel, lookahead);
    _focusWant.y += 2.2;
    this._dampVec(this.focus, _focusWant, this._focusVel, TAU.focus, dt);

    /* --- yaw -------------------------------------------------------------- */
    this.yaw.to(Math.atan2(_travel.x, _travel.z), TAU.yaw, dt);

    /* --- pitch ------------------------------------------------------------ */
    // Higher and more top-down when crawling (you need to see the corner);
    // flatter at speed (the horizon does the work). Always inside 48-62.
    this.pitch.to(clamp(this.basePitch + 3 - sn * 6, 48, 62), TAU.pitch, dt);

    /* --- distance: fit the fight, punch in on boost ----------------------- */
    let rival = 0;
    const vehicles = this.ctx?.vehicles;
    if (Array.isArray(vehicles)) {
      for (let i = 0; i < vehicles.length; i++) {
        const o = vehicles[i];
        if (!o || o === v || !o.position) continue;
        if (o.eliminated || (o.group && o.group.visible === false)) continue;
        const dx = o.position.x - v.position.x;
        const dz = o.position.z - v.position.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < RIVAL_RADIUS && d > rival) rival = d;
      }
    }
    // Solve the distance that puts the furthest nearby rival inside the frame:
    // the ground half-span along the view axis is d*tan(fov/2)/sin(pitch), so
    // invert it. 0.62 keeps them comfortably inboard of the edge, not on it.
    const tanHalf = Math.tan(this.fov.value * 0.5 * DEG);
    const sinPitch = Math.max(0.15, Math.sin(this.pitch.value * DEG));
    const needed = (rival * 0.62 * sinPitch) / Math.max(0.05, tanHalf);
    let distWant = clamp(Math.max(this.baseDistance, needed), this.baseDistance, this.baseDistance * 1.75);
    distWant *= (1 + sn * 0.16) * (1 - boost * 0.11) * (1 + air * 0.07);
    this.distance.to(clamp(distWant, this.baseDistance * 0.82, this.baseDistance * 2), TAU.dist, dt);

    /* --- fov -------------------------------------------------------------- */
    this.fov.to(clamp(this.baseFov + sn * 1.8 + boost * this.fovBoostKick, 28, 40), TAU.fov, dt);

    /* --- roll: bank into the slide ---------------------------------------- */
    // lateralSpeed is signed towards the car's left, which is the only slip
    // signal on Vehicle with a documented sign. Tipping the horizon the same
    // way the car is sliding reads as weight; the opposite reads as a bug.
    const lat = clamp((v.lateralSpeed || 0) / 34, -1, 1);
    const steer = clamp(v.steerPos || 0, -1, 1) * 0.3 * sn;
    this.roll.to(-(lat * 0.85 + steer) * MAX_ROLL, TAU.roll, dt);

    /* --- pose ------------------------------------------------------------- */
    this._fovOut = this.fov.value;
    this._rollOut = this.roll.value;
    this._poseFromParams(_camWant, _lookWant);
  }

  /** Build camera position and look target from the damped parameters. */
  _poseFromParams(outPos, outLook) {
    const yaw = this.yaw.value;
    const pitchRad = this.pitch.value * DEG;
    const dist = this.distance.value;
    const horiz = dist * Math.cos(pitchRad);
    const height = dist * Math.sin(pitchRad);

    outPos.set(
      this.focus.x - Math.sin(yaw) * horiz,
      this.focus.y + height,
      this.focus.z - Math.cos(yaw) * horiz
    );
    outLook.copy(this.focus);

    // Never let the camera drop into the table. The track's height field is
    // analytic, so this costs nothing.
    const track = this.ctx?.track;
    if (track?.heightAt) {
      try {
        const gy = track.heightAt(outPos.x, outPos.z);
        if (Number.isFinite(gy) && outPos.y < gy + this.minHeight) outPos.y = gy + this.minHeight;
      } catch (_) { /* a stub track is allowed to not answer */ }
    }
  }

  /* ------------------------------------------------------------ intro camera */

  /**
   * Slow orbit that establishes the circuit and then dissolves into the race
   * pose, so the cut to 'race' is invisible. The race parameters keep damping
   * underneath throughout, which is why they are already settled at the join.
   */
  _intro(dt, v) {
    // Keep the chase solve alive underneath the orbit.
    this._race(dt, v);

    const track = this.ctx?.track;
    const centre = track?.center || _origin;
    const radius = Math.max(80, Number(track?.radius) || 180);

    const p = clamp(this.modeTime / Math.max(0.5, this.introDuration), 0, 1);
    const ease = smoothstep(0, 1, p);
    const ang = this.introAngle + p * INTRO_SWEEP;

    const orbitR = lerp(radius * 1.55, radius * 0.82, ease);
    const orbitH = lerp(radius * 0.98, radius * 0.40, ease);

    _introPos.set(
      centre.x + Math.sin(ang) * orbitR,
      (centre.y || 0) + orbitH,
      centre.z + Math.cos(ang) * orbitR
    );
    // The look target walks from the whole circuit down onto the grid.
    _introLook.copy(centre).lerp(this.focus, ease * 0.85);

    const blend = smoothstep(this.introDuration - INTRO_BLEND, this.introDuration, this.modeTime);
    this.introBlend.to(blend, TAU.intro, dt);
    const b = this.introBlend.value;

    // _race() already filled _camWant / _lookWant with the chase pose.
    _camWant.lerp(_introPos, 1 - b);
    _lookWant.lerp(_introLook, 1 - b);
    // Wider lens for the establishing shot, easing onto the racing lens. The
    // damper itself is left alone so the chase solve stays continuous.
    this._fovOut = lerp(36, this.fov.value, b * b);
    this._rollOut = this.roll.value * b;

    if (p >= 1 && this.autoIntroToRace) this.setMode('race');
  }

  /** Intro orbit with nothing to chase: circuit only, no chase blend. */
  _orbitOnly(dt, camera) {
    const track = this.ctx?.track;
    const centre = track?.center || _origin;
    const radius = Math.max(80, Number(track?.radius) || 180);
    const p = clamp(this.modeTime / Math.max(0.5, this.introDuration), 0, 1);
    const ease = smoothstep(0, 1, p);
    const ang = this.introAngle + p * INTRO_SWEEP;

    _camWant.set(
      centre.x + Math.sin(ang) * lerp(radius * 1.55, radius * 0.9, ease),
      (centre.y || 0) + lerp(radius * 0.98, radius * 0.5, ease),
      centre.z + Math.cos(ang) * lerp(radius * 1.55, radius * 0.9, ease)
    );
    _lookWant.copy(centre);
    this.focus.copy(centre);
    this._fovOut = lerp(36, this.baseFov, ease);
    this._rollOut = 0;
    this._applyPose(camera, dt, null);
  }

  /* ---------------------------------------------------------- results camera */

  _results(dt, v) {
    const hero = this._resultsSubject() || v;
    this._resultsAngle += dt * 0.34;

    _focusWant.copy(hero.position);
    _focusWant.y += 1.6;
    this._dampVec(this.focus, _focusWant, this._focusVel, 0.25, dt);

    // Low, close, long: the hero shot. Deliberately outside the racing pitch
    // band because this is not a racing camera.
    this.pitch.to(23, 0.8, dt);
    this.distance.to(31, 0.8, dt);
    this.fov.to(30, 0.8, dt);
    this.roll.to(0, 0.6, dt);
    this.yaw.to(wrapPi(this._resultsAngle), 0.9, dt);

    this._fovOut = this.fov.value;
    this._rollOut = this.roll.value;
    this._poseFromParams(_camWant, _lookWant);
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
      const carT = Number.isFinite(v.trackT) ? v.trackT : 0;
      const passed = this._replayHold <= 0
        || this._replayAnchor.distanceToSquared(v.position) > 210 * 210;
      if (passed) {
        this._replaySide = -this._replaySide;
        this._replayT = carT + 0.052;
        try {
          const s = track.sampleAt(this._replayT);
          const lateral = (s.halfWidth + 30) * this._replaySide;
          track.surfacePoint(s.t, lateral, this._replayAnchor);
          this._replayAnchor.y += 19;
        } catch (_) {
          this._replayAnchor.copy(v.position).add(_v.set(40 * this._replaySide, 22, 40));
        }
        this._replayHold = 4.2;
      }
    } else {
      this._replayAnchor.copy(v.position).add(_v.set(46, 26, 46));
      this._replayHold = 4.2;
    }

    _focusWant.copy(v.position);
    _focusWant.y += 1.4;
    this._dampVec(this.focus, _focusWant, this._focusVel, 0.16, dt);

    this.fov.to(27, 0.5, dt);
    this.roll.to(0, 0.5, dt);

    this._fovOut = this.fov.value;
    this._rollOut = this.roll.value;
    _camWant.copy(this._replayAnchor);
    _lookWant.copy(this.focus);
  }

  /* ------------------------------------------------------------------- pose */

  _applyPose(camera, dt, v) {
    /* --- shake ------------------------------------------------------------ */
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - this._traumaDecay * dt);
      if (this.trauma <= 0) this._traumaDecay = 2.5;
    }
    const scale = this.ctx?.settings?.gameplay?.cameraShake ?? 1;
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
      const f = clamp(this._fovOut, 20, 60);
      if (Math.abs(camera.fov - f) > 1e-3) {
        camera.fov = f;
        camera.updateProjectionMatrix();
      }
    }
    camera.updateMatrixWorld(true);

    this._feedFocusBand(camera, v);
  }

  /**
   * Hand PostFX the screen-space Y of the framed car so the tilt-shift band
   * sits on the subject instead of on a fixed line through the frame.
   *
   * The renderer refreshes matrixWorldInverse inside render(), which is after
   * lateUpdate, so the projection has to be done from matrixWorld by hand.
   */
  _feedFocusBand(camera, v) {
    const postfx = this.ctx?.postfx;
    if (!postfx?.setFocusBand) return;

    const params = this.ctx?.settings?.post?.params;
    const baseBand = Number.isFinite(params?.tiltShiftBand) ? params.tiltShiftBand : 0.22;
    const baseFall = Number.isFinite(params?.tiltShiftFalloff) ? params.tiltShiftFalloff : 2;

    const speed = Math.max(0, v?.speed || 0);
    const top = Math.max(50, v?.topSpeed || 100);
    const sn = clamp(speed / top, 0, 1);
    // Narrower band with speed: more of the frame goes soft, the miniature
    // illusion strengthens exactly when the action is most legible anyway.
    // The intro wants the opposite — an establishing shot has to be readable.
    const band = this.mode === 'intro'
      ? baseBand * lerp(2.1, 1.0, this.introBlend.value)
      : baseBand * (1 - sn * 0.22);

    let centre = null;
    // With no car to frame (a track-only capture) the orbit's look target is
    // the next best subject; a null centre would leave PostFX guessing.
    const pos = v?.position || (this.mode === 'intro' ? this.focus : null);
    if (pos) {
      _mInv.copy(camera.matrixWorld).invert();
      _proj.copy(pos).applyMatrix4(_mInv).applyMatrix4(camera.projectionMatrix);
      if (Number.isFinite(_proj.y) && _proj.z < 1 && _proj.z > -1) {
        centre = clamp(_proj.y * 0.5 + 0.5, 0.13, 0.87);
      }
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
      if (d > RIVAL_RADIUS) return;
      weight = 0.35 * (1 - d / RIVAL_RADIUS);
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
    const track = this.ctx?.track;
    const centre = track?.center;
    const v = this._target();
    if (!centre || !v?.position) return 0;
    return Math.atan2(v.position.x - centre.x, v.position.z - centre.z) - INTRO_SWEEP * 0.5;
  }

  /* ----------------------------------------------------------------- helpers */

  _dampVec(cur, target, vel, smoothTime, dt) {
    if (!(dt > 0)) return cur;
    const st = Math.max(1e-4, smoothTime);
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    // Inline per axis: three Damped instances would be three more objects and
    // this runs every frame.
    cur.x = dampAxis(cur, vel, target.x, 'x', omega, dt, exp);
    cur.y = dampAxis(cur, vel, target.y, 'y', omega, dt, exp);
    cur.z = dampAxis(cur, vel, target.z, 'z', omega, dt, exp);
    return cur;
  }

  /** Compact snapshot for the debug overlay. */
  snapshot() {
    return {
      mode: this.mode,
      target: this.focusTarget?.id ?? '—',
      pitch: +this.pitch.value.toFixed(1),
      dist: +this.distance.value.toFixed(1),
      fov: +this.fov.value.toFixed(1),
      roll: +(this.roll.value / DEG).toFixed(2),
      trauma: +this.trauma.toFixed(2),
      span: +this.screenSpan().toFixed(0),
    };
  }

  dispose() {
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    return this;
  }
}

function dampAxis(cur, vel, target, key, omega, dt, exp) {
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
