// ai/Driver.js — the opposition.
//
// One instance per CPU car. It reads the racing line, the track and the other
// vehicles, and writes nothing but `vehicle.setControls(...)`. Every rival on
// track is driving the same physics the player is: no scripted paths, no speed
// cheats, no invisible grip. If an AI car takes a corner faster than you, it is
// because it braked later and got on the power earlier.
//
// ----------------------------------------------------------------- the driver
//
// SIGHT     The racing line from world/RacingLine.js gives geometry (position,
//           tangent, curvature). The *speed* is not taken from its profile —
//           that profile is solved for a reference car, and eight different
//           chassis with eight different tyre loads and downforce curves would
//           all drive it identically. Instead each driver re-solves its own
//           limit every frame from its own tyres (section "the brake point").
//
// STEERING  Pure pursuit at a speed-proportional lookahead sets the path
//           curvature; a PD trim on cross-track error removes the steady-state
//           offset pure pursuit leaves on a constant-radius corner; a counter-
//           steer term aligns the front wheels with the velocity vector and
//           damps yaw rate against the intended rate. That third term is why an
//           AI car that gets out of shape catches the slide like a player would
//           instead of spinning or snapping instantly straight.
//
// PEDALS    Three phases into every corner, in the order a real driver uses
//           them: still accelerating, then off the throttle coasting (the lift),
//           then on the brake — with pressure bled off as steering lock goes on,
//           because the friction ellipse says the front tyres cannot do both.
//           That bleed is trail braking, and it falls out of the physics rather
//           than being animated.
//
// MISTAKES  Believable means *caused*. A driver who out-brakes himself does not
//           twitch the wheel: he arrives at the apex 4 u/s too fast, the car
//           runs wide because it genuinely has no grip left, and he loses two
//           tenths recovering. Every mistake here is an input to the same
//           control law, never an override of it, and every one is shaped by a
//           smooth envelope. There is no per-frame randomness anywhere in this
//           file except the scheduling of *when* a mistake begins.
//
// -------------------------------------------------------------- sign conventions
//
// Local +Z is forward and local +X is the car's LEFT (see Vehicle.js). Track
// frames put `right` at (-tangent.z, 0, tangent.x), which is the geometric
// right, and `lateral` is measured along it — so a positive lateral offset is
// always "further right as the car sees the road". Curvature is positive
// turning left. Steering *angle* here is positive-left (a rotation about +Y),
// and setControls({steer}) wants -1 left .. +1 right, so the final conversion
// is `steer = -angle / steerMax`.

import * as THREE from 'three';
import { clamp, saturate, lerp, smoothstep, makeRng, value2D } from '../core/Random.js';

/* ---------------------------------------------------------------- constants */

const CAR_HALF_WIDTH = 2.0;      // a car is 4 u wide
const CAR_LENGTH = 9.0;
const EDGE_MARGIN = 1.25;        // clean track left outside the tyre

const PLAN_STEP = 3.2;           // u between speed-plan probes
const PLAN_MIN_HORIZON = 26;
const PLAN_MAX_HORIZON = 220;
const EPS_CURV = 1e-5;

const AVOID_HORIZON = 0.42;      // s of predictive collision check
const AVOID_SAMPLES = 3;
const NEAR_MAX = 6;              // rivals close enough to be worth predicting
const SCAN_RADIUS = 120;

const PROFILE_INTERVAL = 0.5;    // s between difficulty re-reads

/* ------------------------------------------------------------ module scratch
 * Drivers update one at a time on a single thread, and nothing below is held
 * across a call, so a shared scratch set is safe and keeps the per-frame
 * allocation count at zero. */

const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _aimRight = new THREE.Vector3();
const _aimPos = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _probe = new THREE.Vector3();

/* ------------------------------------------------------------------ helpers */

/** Fold any real into [0,1). */
function wrap01(t) {
  if (!Number.isFinite(t)) return 0;
  const x = t - Math.floor(t);
  return x >= 1 ? 0 : x < 0 ? 0 : x;
}

/** Shortest signed difference a-b on the unit circle, in [-0.5, 0.5]. */
function cyclicDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  let d = a - b;
  d -= Math.floor(d);
  return d > 0.5 ? d - 1 : d;
}

function finite(v, fallback) {
  const n = +v;
  return Number.isFinite(n) ? n : fallback;
}

/** Storage matching the frame RacingLine.sampleAt() writes, so we never hold a
 *  reference into its shared ring. */
function makeLineSample() {
  return {
    t: 0,
    distance: 0,
    pos: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    curvature: 0,
    speed: 0,
    lateral: 0,
    trackT: 0,
  };
}

/**
 * A centreline pretending to be a racing line.
 *
 * If world/RacingLine.js failed to solve, or the track is degenerate, the AI
 * still has to drive — a race with eight parked cars is a far worse failure
 * than a race where the AI takes the geometric line. Everything downstream is
 * written against this interface, so there is exactly one code path.
 */
function centrelineAdapter(track) {
  return {
    isFallback: true,
    length: track.length || 1,
    count: track.count || 1,
    frames: null,
    curvatureAt: (t) => finite(track.curvatureAt?.(t), 0),
    lineTAtTrackT: (t) => wrap01(t),
    sampleAt(t, out) {
      const o = out || makeLineSample();
      const s = track.sampleAt(t);
      o.t = s.t;
      o.distance = s.distance;
      o.pos.copy(s.pos);
      o.tangent.copy(s.tangent);
      o.normal.copy(s.normal);
      o.curvature = s.curvature;
      o.speed = 0;
      o.lateral = 0;
      o.trackT = s.t;
      return o;
    },
  };
}

/* ========================================================================== */

export class Driver {
  /**
   * @param {object} ctx shared context
   * @param {object} vehicle the car this driver has the wheel of
   * @param {{skill?:number, aggression?:number, consistency?:number, seed?:number}} opts
   */
  constructor(ctx, vehicle, opts = {}) {
    this.ctx = ctx || {};
    this.vehicle = vehicle || null;
    this.name = `driver:${vehicle?.id ?? 'x'}`;

    /* --- personality ---------------------------------------------------- */

    this.skill = clamp(finite(opts.skill, 0.75), 0, 1);
    this.aggression = clamp(finite(opts.aggression, 0.5), 0, 1);
    this.consistency = clamp(finite(opts.consistency, 0.85), 0, 1);
    this.seed = finite(opts.seed, 1) | 0;
    this.rng = makeRng(this.seed);

    // Fixed quirks, drawn once. These are what make a driver recognisable over
    // a three-lap race: this one always brakes a shade early, that one runs a
    // fraction wide out of every right-hander.
    const sloppy = 1 - this.consistency;
    this.brakeBias = (this.rng.next() - 0.5) * 2 * sloppy * 0.10;
    this.apexBias = (this.rng.next() - 0.5) * 2 * (1 - this.skill) * 1.5;
    this.linePref = (this.rng.next() - 0.5) * 1.1;
    this.overtakeSide = this.rng.sign();
    this.noisePhase = this.rng.range(0, 512);
    this.noisePhase2 = this.rng.range(0, 512);
    this.launchJitter = this.rng.next();

    this.p = {};
    this._deriveProfile();

    /* --- persistent per-driver storage ---------------------------------- */

    this.here = makeLineSample();
    this.aim = makeLineSample();
    this.tmp = makeLineSample();
    this.fwdXZ = new THREE.Vector3(0, 0, 1);
    this.leftXZ = new THREE.Vector3(1, 0, 0);
    this.rightXZ = new THREE.Vector3(-1, 0, 0);
    this.tanXZ = new THREE.Vector3(0, 0, 1);
    this.near = new Array(NEAR_MAX).fill(null);
    this.nearCount = 0;

    /* --- state ----------------------------------------------------------- */

    this.time = 0;
    this.profileClock = 0;
    this.state = 'race';         // 'race' | 'spin' | 'rejoin' | 'reverse'
    this.stateTime = 0;
    this.reactClock = 0;

    this.lineT = 0;
    this.trackT = 0;
    this.halfWidth = 13;
    this.halfAhead = 13;
    this.speed = 0;
    this.fwdSpeed = 0;
    this.crossErr = 0;
    this.crossRate = 0;
    this.err = 0;
    this.errAbs = 0;
    this.iErr = 0;
    this.align = 1;
    this.cornerNoise = 0;
    this.brakeNoise = 0;

    this.vLimit = 40;
    this.cornerV = 40;
    this.cornerD = Infinity;
    this.brakeDist = 0;
    this.toBrake = Infinity;
    this.aLat = 150;
    this.aLong = 165;
    this.aBrake = 170;
    this.aBrakeUse = 150;
    this.thrustCap = 55;
    this.latUse = 0;
    this.ellipse = 1;
    this.band = 1;               // rubber-band multiplier, hard-capped at +/-6%

    this.offset = 0;             // committed lateral offset from the line
    this.offsetTarget = 0;
    this.passOffset = 0;
    this.defendOffset = 0;
    this.avoidOffset = 0;
    this.avoidLift = 0;
    this.mistakeOffset = 0;

    this.pass = { active: false, side: 0, target: null, time: 0, commit: 0, cooldown: 0 };
    this.defendSide = 0;
    this.defendHold = 0;

    this.ahead = null;
    this.behind = null;
    this.aheadGap = Infinity;
    this.behindGap = Infinity;
    this.aheadLat = 0;
    this.behindLat = 0;
    this.myLat = 0;
    this.blockL = false;
    this.blockR = false;

    this.mistake = { type: 'none', time: 0, dur: 1, mag: 0, dir: 1 };
    this.mistakeClock = this.rng.range(4, 16);
    this.brakeLate = 0;
    this.hesitate = 0;
    this.bobble = 0;
    this.bobbleDir = 1;
    this.bobbleMag = 0;
    this.bobbleSteer = 0;
    this.handNoise = 0;

    this.steerOut = 0;
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.handbrakeOut = 0;
    this.boostOut = 0;
    this.hbTimer = 0;
    this.hbCool = 0;

    this.racing = false;
    this.launchTimer = 0;
    this.crawlTimer = 0;
    this.reverseTimer = 0;

    this._warned = false;
  }

  /* ======================================================================
   * Difficulty and personality
   * ====================================================================== */

  /**
   * Turn { skill, aggression, consistency } and the global difficulty into the
   * ~20 numbers the control law actually reads.
   *
   * Difficulty deliberately moves almost everything *except* pace: a hard AI
   * brakes later, looks further ahead, holds a tighter line, catches slides
   * sooner, commits to more moves and makes fewer errors. Only `pace` touches
   * straight-line speed, and it spans 7% — because an opponent that is merely
   * slower on the straights is not an easier opponent, it is a duller one.
   */
  _deriveProfile() {
    const g = this.ctx?.settings?.gameplay;
    const diff = clamp(finite(g?.aiDifficulty, 0.65), 0, 1);
    const d = diff - 0.5;

    const sk = clamp(this.skill + d * 0.45, 0.08, 1);
    const ag = clamp(this.aggression + d * 0.30, 0, 1);
    const co = clamp(this.consistency + d * 0.26, 0.10, 1);

    const p = this.p;
    p.difficulty = diff;
    p.skill = sk;
    p.aggression = ag;
    p.consistency = co;

    // How much of the tyre they are willing to use, and how well they judge it.
    p.gripUse = lerp(0.78, 1.02, sk);
    p.brakeUse = lerp(0.66, 0.99, sk);
    p.brakeMargin = clamp(lerp(1.45, 1.02, sk) * (1 + this.brakeBias), 0.85, 1.9);
    p.exitBold = lerp(0.70, 1.06, sk);
    p.pace = lerp(0.93, 1.0, sk);

    // Eyes and hands.
    p.lookTime = lerp(0.28, 0.44, sk);
    p.kCross = lerp(0.030, 0.058, sk);
    p.kDamp = lerp(0.09, 0.26, sk);
    p.kInt = lerp(0.0012, 0.0042, sk);
    p.counter = lerp(0.28, 1.0, sk);
    p.yawDamp = lerp(0.018, 0.075, sk);
    p.reaction = lerp(0.185, 0.05, sk);
    p.recover = lerp(0.40, 1.0, sk);

    // Temperament.
    p.mistakeRate = (1 - co) * lerp(1.30, 0.42, sk);
    p.reach = lerp(13, 44, ag);            // u of gap that reads as "catchable"
    p.commit = lerp(1.7, 5.0, ag);         // s a move is held before backing out
    p.defend = lerp(0.10, 1.0, ag);
    p.contactTol = lerp(0.12, 1.0, ag);    // 1 = will lean on a rival to get by
    p.boostSense = lerp(0.30, 1.0, sk * 0.55 + ag * 0.45);
    return p;
  }

  /* ======================================================================
   * Frame entry point
   * ====================================================================== */

  update(dt, ctx) {
    if (ctx) this.ctx = ctx;
    const veh = this.vehicle;
    if (!veh || typeof veh.setControls !== 'function') return;

    // Headless review captures pump this at ~30 Hz; a hitching frame can push
    // it much higher. Clamp so no controller term can integrate a huge step.
    const step = clamp(finite(dt, 1 / 60), 1 / 480, 0.12);
    this.time += step;

    try {
      this._tick(step);
    } catch (err) {
      // One driver's bad frame must never take the race down. Fail to a car
      // that coasts in a straight line rather than to a car that stops dead.
      if (!this._warned) {
        this._warned = true;
        console.warn(`[Driver] ${this.name} threw; coasting from here`, err);
      }
      veh.setControls({ throttle: 0.3, brake: 0, steer: 0, handbrake: 0, boost: 0 });
    }
  }

  _tick(dt) {
    const veh = this.vehicle;

    this.profileClock -= dt;
    if (this.profileClock <= 0) {
      this.profileClock = PROFILE_INTERVAL;
      this._deriveProfile();
    }

    if (!this._resolveWorld()) {
      // No track at all. Roll gently forward so the car is not a statue.
      veh.setControls({ throttle: 0.25, brake: 0, steer: 0, handbrake: 0, boost: 0 });
      return;
    }

    if (!this._gate(dt)) return;

    this._sense(dt);
    this._scanRivals();
    this._rubberBand(dt);
    this._mistakes(dt);
    this._plan();
    this._tactics(dt);
    this._recovery(dt);
    this._drive(dt);
  }

  /** Bind (and re-bind) to the track and racing line the context is holding. */
  _resolveWorld() {
    const ctx = this.ctx;
    const track = ctx?.track;
    if (!track || typeof track.sampleAt !== 'function') {
      this.track = null;
      this.line = null;
      return false;
    }
    if (this.track !== track) {
      this.track = track;
      this.line = null;
    }
    if (!this.line) {
      const rl = ctx.racingLine || track.racingLine || null;
      this.line = (rl && rl.count > 0 && typeof rl.sampleAt === 'function')
        ? rl
        : centrelineAdapter(track);
    }
    return true;
  }

  /**
   * Race-state gate and the standing start.
   *
   * Reaction time is a real differentiator on a short circuit: a sharp driver
   * is moving 80 ms after the lights, a nervous one nearly half a second, and
   * the spread across the grid is visible from the first corner.
   */
  _gate(dt) {
    const veh = this.vehicle;
    const race = this.ctx?.race;
    const state = race?.state;
    const racing = state
      ? (state === 'racing' || state === 'finished')
      : !veh.frozen;

    if (racing && !this.racing) {
      const p = this.p;
      this.launchTimer = clamp(
        0.07 + (1 - p.skill) * 0.28 + this.launchJitter * (1 - p.consistency) * 0.30,
        0.02, 0.65
      );
    }
    this.racing = racing;

    if (!racing) {
      // On the grid. The car is frozen by Race anyway; keep our own smoothed
      // outputs at rest so the launch starts from a clean state.
      this.steerOut *= 1 - saturate(dt * 8);
      this.throttleOut *= 1 - saturate(dt * 8);
      this.brakeOut = 0;
      veh.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0 });
      return false;
    }

    if (this.launchTimer > 0) {
      this.launchTimer -= dt;
      // Wheels straight, brake released, waiting. Not asleep — just human.
      veh.setControls({ throttle: 0, brake: 0, steer: this.steerOut, handbrake: 0, boost: 0 });
      return false;
    }
    return true;
  }

  /* ======================================================================
   * Perception
   * ====================================================================== */

  _sense(dt) {
    const veh = this.vehicle;
    const line = this.line;
    const track = this.track;
    const p = this.p;

    this.speed = finite(veh.speed, 0);
    this.fwdSpeed = finite(veh.forwardSpeed, 0);

    // Car basis, flattened. Everything the driver reasons about is horizontal;
    // banking and ramps are the suspension's problem, not the racing line's.
    _fwd.set(veh.forward.x, 0, veh.forward.z);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, 1); else _fwd.normalize();
    this.fwdXZ.copy(_fwd);
    _left.set(veh.left.x, 0, veh.left.z);
    if (_left.lengthSq() < 1e-8) _left.set(1, 0, 0); else _left.normalize();
    this.leftXZ.copy(_left);

    this.trackT = wrap01(finite(veh.trackT, 0));
    this.lineT = wrap01(finite(line.lineTAtTrackT(this.trackT), this.trackT));
    line.sampleAt(this.lineT, this.here);

    _tan.set(this.here.tangent.x, 0, this.here.tangent.z);
    if (_tan.lengthSq() < 1e-8) _tan.set(0, 0, 1); else _tan.normalize();
    this.tanXZ.copy(_tan);
    // Geometric right of the direction of travel. Matches Track's `right`, and
    // therefore matches every `lateral` in the world modules.
    _right.set(-_tan.z, 0, _tan.x);
    this.rightXZ.copy(_right);

    this.align = this.fwdXZ.dot(this.tanXZ);

    // Cross-track error against the line, and its rate. When the car sits
    // exactly on the line, velocity is along the tangent and the rate is zero,
    // so this is a clean derivative with no curvature bias to compensate for.
    _delta.set(veh.position.x - this.here.pos.x, 0, veh.position.z - this.here.pos.z);
    this.crossErr = _delta.dot(this.rightXZ);
    this.myLat = this.crossErr;
    this.crossRate = veh.velocity.x * this.rightXZ.x + veh.velocity.z * this.rightXZ.z;

    this.halfWidth = Math.max(4, finite(track.widthAt?.(this.trackT), 26) * 0.5);

    // Per-corner character. Sampled from position around the lap rather than
    // from time, so a driver is *reliably* a little late at the same hairpin
    // every lap — which reads as a habit, where a per-lap redraw would read as
    // noise.
    this.cornerNoise = value2D(this.trackT * 53, this.noisePhase, this.seed) - 0.5;
    this.brakeNoise = value2D(this.trackT * 41 + 17, this.noisePhase2, this.seed ^ 0x9e37) - 0.5;

    // Aim point: further ahead the faster we go, pulled in through corners so
    // the line is followed rather than cut.
    let look = clamp(7 + this.speed * p.lookTime, 9, 42);
    look *= lerp(1, 0.60, saturate(Math.abs(this.here.curvature) * 130));
    if (this.state === 'rejoin') look = Math.max(look, 18 + this.speed * 0.32);
    this.look = look;

    const L = line.length || 1;
    line.sampleAt(this.lineT + look / L, this.aim);
    this.halfAhead = Math.max(4, finite(track.widthAt?.(this.aim.trackT), 26) * 0.5);

    void dt;
  }

  /**
   * Nearest rival ahead and behind, measured along the lap rather than through
   * the air — at a hairpin the car physically closest is often the one you are
   * about to lap, and steering policy must not confuse the two.
   */
  _scanRivals() {
    this.ahead = null;
    this.behind = null;
    this.aheadGap = Infinity;
    this.behindGap = Infinity;
    this.aheadLat = 0;
    this.behindLat = 0;
    this.blockL = false;
    this.blockR = false;
    this.nearCount = 0;

    const list = this.ctx?.vehicles;
    if (!Array.isArray(list) || list.length < 2) return;

    const veh = this.vehicle;
    const line = this.line;
    // Gaps are measured in *track* parameter, so they scale by the track's own
    // lap length, not the racing line's — the two differ by a percent or two.
    const L = finite(this.track?.length, 0) || line.length || 1;
    const px = veh.position.x;
    const pz = veh.position.z;

    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (!o || o === veh || !o.position) continue;
      if (o.group && o.group.visible === false) continue;  // eliminated, hidden

      const dx = o.position.x - px;
      const dz = o.position.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > SCAN_RADIUS * SCAN_RADIUS) continue;

      const gap = cyclicDelta(wrap01(finite(o.trackT, 0)), this.trackT) * L;

      // Their offset from the racing line, in the same units as ours.
      const olt = wrap01(finite(line.lineTAtTrackT(wrap01(finite(o.trackT, 0))), 0));
      line.sampleAt(olt, this.tmp);
      const rx = -this.tmp.tangent.z;
      const rz = this.tmp.tangent.x;
      const rl = Math.hypot(rx, rz) || 1;
      const lat = ((o.position.x - this.tmp.pos.x) * rx + (o.position.z - this.tmp.pos.z) * rz) / rl;

      if (gap > 0) {
        if (gap < this.aheadGap) { this.ahead = o; this.aheadGap = gap; this.aheadLat = lat; }
      } else if (-gap < this.behindGap) {
        this.behind = o; this.behindGap = -gap; this.behindLat = lat;
      }

      // Side occupancy: is there already a car where a move would put us?
      if (Math.abs(gap) < 13) {
        const rel = lat - this.myLat;
        if (rel > 1.4) this.blockR = true;
        else if (rel < -1.4) this.blockL = true;
      }

      if (d2 < 60 * 60 && this.nearCount < NEAR_MAX) this.near[this.nearCount++] = o;
    }
  }

  /* ======================================================================
   * Rubber banding
   * ====================================================================== */

  /**
   * At most +/-6% of pace, and spread over a three-second time constant so it
   * can only ever express itself across a whole straight. A dead band means
   * cars actually racing each other get none of it at all — the point is to
   * stop a runaway or a lost cause, not to tow anyone onto the player's bumper.
   */
  _rubberBand(dt) {
    const cap = clamp(finite(this.ctx?.settings?.gameplay?.rubberBanding, 0.06), 0, 0.06);
    let want = 1;

    const race = this.ctx?.race;
    const player = this.ctx?.player;
    if (cap > 0 && race && player && typeof race.entryFor === 'function') {
      const me = race.entryFor(this.vehicle);
      const you = race.entryFor(player);
      if (me && you && !me.finished && !me.eliminated) {
        const gap = finite(you.score, 0) - finite(me.score, 0); // + = I am behind
        const x = clamp((Math.abs(gap) - 26) / 210, 0, 1);
        want = 1 + (gap >= 0 ? 1 : -1) * x * cap;
      }
    }
    this.band += (want - this.band) * saturate(dt / 3.0);
  }

  /* ======================================================================
   * The brake point
   * ====================================================================== */

  /**
   * Speed-for-curvature, solved against this car's own tyres.
   *
   *   v_corner = sqrt(a_lat(v_corner) / kappa)          grip limit in the corner
   *   v_allow  = sqrt(v_corner^2 + 2 * a_brake * d)     what may be carried now
   *
   * a_lat comes from Tires.cornerLimit(), so a formula car with 2% downforce
   * genuinely does carry more into a fast sweeper than a pickup does — and
   * because that downforce is itself a function of speed, the corner-speed
   * equation is implicit and is solved rather than evaluated (_cornerSpeed).
   *
   * TWO SEPARATE ANSWERS COME OUT OF THIS, and keeping them apart is the whole
   * point of the method:
   *
   *   vLimit   the fastest this car may legitimately be going *right now*,
   *            including the corner it is already in.
   *   toBrake  metres of road left before the brakes have to come on for a
   *            corner still AHEAD. Infinity when there is no such corner.
   *
   * Folding the corner underneath the car into `toBrake` is the classic way to
   * end up with an AI that coasts through every corner: at the limit there is
   * nothing left to slow down for, and the correct pedal is the one that holds
   * the speed, not zero.
   */
  _plan() {
    const veh = this.vehicle;
    const line = this.line;
    const p = this.p;
    const t = veh.tuning || {};
    const g = finite(this.ctx?.settings?.physics?.gravity, 260);
    const v = Math.max(1, this.speed);
    const mass = Math.max(0.05, finite(t.mass, 1));
    const tires = veh.tires;

    // Frame-constant pieces of this car's grip model, cached for _aLatAt().
    this._g = g;
    this._tires = (tires && typeof tires.cornerLimit === 'function') ? tires : null;
    this._axle = (finite(t.gripFront, 1) + finite(t.gripRear, 1)) * 0.5;
    this._cDf = finite(t.downforceCoef, 0.0105) / Math.max(1, mass * g);
    this._gripUse = p.gripUse;

    const vTop = Math.max(20, finite(veh.topSpeed, 100)) * p.pace * this.band;
    this._vTop = vTop;

    const aLatNow = this._aLatAt(v);
    const muRatio = (tires && tires.muLat > 0 && tires.muLong > 0)
      ? clamp(tires.muLong / tires.muLat, 0.7, 1.6)
      : 1.1;
    const dragAcc = finite(t.dragCoef, 0.0074) * v * v / mass;

    this.aLat = aLatNow;
    this.aLong = aLatNow * muRatio;
    this.aBrake = this.aLong + dragAcc;

    // Full-throttle thrust, taken from the identity Vehicle._calibrate() used
    // to solve the drag coefficient in the first place: at top speed thrust and
    // drag balance, so drag AT top speed *is* what the engine can still make
    // there. Everything below that is geared up roughly as P/v.
    const vTopRaw = Math.max(20, finite(veh.topSpeed, 100));
    this.thrustCap = Math.max(8, finite(t.dragCoef, 0.0074) * vTopRaw * vTopRaw / mass);

    const surfNow = this._lineGrip(this.lineT) * (veh.offTrack ? 0.78 : 1);
    // Personal brake-point variance, per corner and per mistake. `brakeLate`
    // is the out-braking mistake: it shortens the distance the driver *thinks*
    // he needs, so he arrives too fast and has to deal with the consequence.
    const margin = clamp(
      p.brakeMargin * (1 + this.brakeNoise * (1 - p.consistency) * 0.16) * (1 - this.brakeLate),
      0.72, 2.0
    );
    const aBrakeUse = Math.max(20, this.aBrake * p.brakeUse / margin);
    this.aBrakeUse = aBrakeUse;

    let vLimit = vTop;
    let brakeD = Infinity;   // distance to the corner that will need the brakes
    let brakeV = vTop;       // and the speed it has to be taken at

    const L = line.length || 1;
    const horizon = clamp((v * v) / (2 * aBrakeUse) * 1.3 + 34, PLAN_MIN_HORIZON, PLAN_MAX_HORIZON);
    const steps = clamp(Math.round(horizon / PLAN_STEP), 4, 72);
    const dStep = horizon / steps;

    for (let i = 1; i <= steps; i++) {
      const d = i * dStep;
      const lt = this.lineT + d / L;
      const k = Math.abs(line.curvatureAt(lt));
      if (k <= EPS_CURV) continue;
      const vCorner = this._cornerSpeed(k, this._lineGrip(lt));
      if (vCorner >= vTop) continue;
      const allow = Math.sqrt(vCorner * vCorner + 2 * aBrakeUse * d);
      if (allow < vLimit) { vLimit = allow; brakeD = d; brakeV = vCorner; }
    }

    // The corner already underneath the car caps the speed — but it is a limit,
    // not an event. See the header note.
    const kNow = Math.abs(this.here.curvature);
    const vNow = kNow > EPS_CURV ? this._cornerSpeed(kNow, surfNow) : vTop;
    if (vNow < vLimit) vLimit = vNow;

    // Off the road, on milk or on oil there is no argument to be had.
    if (surfNow < 0.9) vLimit = Math.min(vLimit, vTop * lerp(0.55, 1, saturate((surfNow - 0.35) / 0.55)));
    if (this.state === 'rejoin') vLimit = Math.min(vLimit, vTop * 0.66);
    if (this._finished()) vLimit = Math.min(vLimit, vTop * 0.85);

    this.vLimit = clamp(vLimit, 8, vTop);
    this.cornerV = brakeV;
    this.cornerD = brakeD;
    if (brakeD < Infinity) {
      // Deliberately signed. Clamping this at zero would make `toBrake` read as
      // "brake now" for a corner the car is already slow enough for.
      this.brakeDist = (v * v - brakeV * brakeV) / (2 * aBrakeUse);
      this.toBrake = brakeD - this.brakeDist;
    } else {
      this.brakeDist = 0;
      this.toBrake = Infinity;
    }
  }

  /**
   * Lateral acceleration this car would have AT speed v, including the
   * downforce it generates there. Routed through the vehicle's own tyre model
   * so load sensitivity is the real curve rather than a second copy of it.
   */
  _aLatAt(v) {
    const df = 1 + this._cDf * v * v;
    const base = this._tires
      ? this._tires.cornerLimit(this._g, 1, df)
      : 0.6 * this._g * df;
    return Math.max(20, base * this._axle);
  }

  /**
   * Solve v = sqrt(a_lat(v) * grip / kappa).
   *
   * a_lat rises with v (downforce) so the equation is implicit. Starting at the
   * car's top speed and re-substituting gives a monotonically decreasing
   * sequence that converges on the fixed point from above in two or three
   * steps; if the first step does not come back below the top speed, the corner
   * is downforce-unlimited and the honest answer is "flat out".
   */
  _cornerSpeed(k, grip) {
    if (!(k > EPS_CURV)) return this._vTop;
    const use = this._gripUse * (grip > 0 ? grip : 1);
    let vc = this._vTop;
    for (let i = 0; i < 3; i++) {
      const next = Math.sqrt((this._aLatAt(vc) * use) / k);
      if (next >= vc) return this._vTop;
      vc = next;
    }
    return vc;
  }

  /** Surface grip the racing line recorded at a line parameter. */
  _lineGrip(lt) {
    const line = this.line;
    const f = line?.frames;
    if (!f || !f.grip || !line.count) return 1;
    const i = Math.floor(wrap01(lt) * line.count) % line.count;
    const g = f.grip[i];
    return Number.isFinite(g) && g > 0 ? g : 1;
  }

  _finished() {
    const e = this.ctx?.race?.entryFor?.(this.vehicle);
    return !!(e && (e.finished || e.eliminated));
  }

  /* ======================================================================
   * Tactics: where on the road to be
   * ====================================================================== */

  _tactics(dt) {
    const p = this.p;

    this._passLogic(dt);
    this._defendLogic(dt);
    this._avoidLogic(dt);

    // Apex precision. A driver who misses apexes misses them the *same way*
    // every time — consistently a foot early into the left-handers, say. The
    // sign is per-driver and the magnitude is modulated per corner.
    const k = this.aim.curvature;
    const apex = (this.apexBias + this.cornerNoise * (1 - p.skill) * 2.0)
      * -Math.sign(k || 1) * saturate(Math.abs(k) * 170);

    let off = this.linePref * lerp(1.3, 0.3, p.skill)
      + apex
      + this.passOffset
      + this.defendOffset
      + this.avoidOffset;

    if (this.state === 'rejoin') off = 0;   // get back to the line, nothing else

    // Corridor clamp: whatever the tactics wanted, the plan must stay on the
    // road. `aim.lateral` is the line's own offset from the centreline, so the
    // two together are the absolute position the car is being asked to hold.
    const room = Math.max(0.6, this.halfAhead - CAR_HALF_WIDTH - EDGE_MARGIN);
    const lineLat = finite(this.aim.lateral, 0);
    let lo = -room - lineLat;
    let hi = room - lineLat;
    if (lo > hi) { const m = (lo + hi) * 0.5; lo = m; hi = m; }
    this.offsetTarget = clamp(off, lo, hi);

    // A mistake is added OUTSIDE the corridor clamp, because a run wide that
    // politely stops at the white line is not a mistake. Bounded at a little
    // over two metres of kerb so it costs a bobble and some time, never a
    // barrier strike or a car launched into the scenery.
    if (this.mistakeOffset !== 0 && this.state === 'race') {
      this.offsetTarget = clamp(this.offsetTarget + this.mistakeOffset, lo - 2.6, hi + 2.6);
    }

    // Cars change lanes at a rate, not instantly. This is the single biggest
    // difference between AI that looks driven and AI that looks snapped.
    const rate = lerp(8, 20, p.skill) * saturate(this.speed / 35);
    const d = this.offsetTarget - this.offset;
    this.offset += clamp(d, -rate * dt, rate * dt);
  }

  /**
   * Overtaking: see it, pick a side, commit, or back out.
   *
   * The commit is the important half. An AI that re-evaluates every frame
   * dithers alongside a rival for a whole straight; one that commits for a
   * couple of seconds and then honestly gives up if the gap has stopped
   * closing produces the moves — and the aborted moves — that races are made of.
   */
  _passLogic(dt) {
    const p = this.p;
    const pass = this.pass;

    if (pass.cooldown > 0) pass.cooldown -= dt;

    if (pass.active) {
      pass.time += dt;
      const still = pass.target && this.ahead === pass.target;
      const closing = still ? this.speed - finite(this.ahead.speed, 0) : -99;
      const done = !still || this.aheadGap < 1.0;
      const stalled = pass.time > 1.4 && closing < -0.6;
      if (done || stalled || pass.time > pass.commit) {
        pass.active = false;
        pass.target = null;
        pass.side = 0;
        // Backing out costs a beat before the next attempt: aggressive drivers
        // come straight back at it, cautious ones settle and wait for a corner.
        pass.cooldown = lerp(3.0, 0.6, p.aggression);
      }
    }

    if (!pass.active && pass.cooldown <= 0 && this.ahead && this.state === 'race') {
      const rival = this.ahead;
      const gap = this.aheadGap;
      const closing = this.speed - finite(rival.speed, 0);
      const faster = this.vLimit > finite(rival.speed, 0) + 3.5;
      if (gap > 2.5 && gap < p.reach && (closing > 0.7 || faster)) {
        const side = this._chooseSide();
        if (side !== 0) {
          pass.active = true;
          pass.side = side;
          pass.target = rival;
          pass.time = 0;
          pass.commit = p.commit;
        }
      }
    }

    // Aim to sit alongside, offset from where the rival actually is.
    const want = pass.active
      ? this.aheadLat + pass.side * (CAR_HALF_WIDTH * 2 + lerp(1.7, 0.5, p.aggression))
      : 0;
    this.passOffset += (want - this.passOffset) * saturate(dt * lerp(1.3, 3.2, p.skill));
  }

  /**
   * Which side to go down.
   *
   * Room first — a move with nowhere to put the car is not a move — then the
   * inside of the corner the pass would actually be completed in, because that
   * is where a pass sticks. A move into an already-occupied lane scores itself
   * out entirely.
   */
  _chooseSide() {
    const p = this.p;
    const room = Math.max(0.5, this.halfAhead - CAR_HALF_WIDTH - EDGE_MARGIN);
    const lineLat = finite(this.aim.lateral, 0);
    const need = CAR_HALF_WIDTH * 2 + 1.1;
    const rl = this.aheadLat;

    // Space left beyond the rival on each side, in offset units.
    let scoreR = (room - lineLat) - (rl + need);
    let scoreL = (rl - need) - (-room - lineLat);

    // Curvature is positive turning left, so the inside of a left-hander is the
    // negative (left) side.
    const k = this.aim.curvature;
    if (Math.abs(k) > 1 / 260) {
      if (k > 0) scoreL += 3.5 * p.aggression;
      else scoreR += 3.5 * p.aggression;
    }
    if (this.blockR) scoreR -= 50;
    if (this.blockL) scoreL -= 50;

    if (scoreR < 0.4 && scoreL < 0.4) return 0;
    if (Math.abs(scoreR - scoreL) < 0.6) return this.overtakeSide;
    return scoreR > scoreL ? 1 : -1;
  }

  /**
   * Defending: one move, held.
   *
   * Real defence is taking the inside line early and daring the attacker round
   * the outside. Weaving is neither legal nor convincing, so the chosen side is
   * locked for a couple of seconds and only re-picked once that lock expires.
   */
  _defendLogic(dt) {
    const p = this.p;
    if (this.defendHold > 0) this.defendHold -= dt;

    let want = 0;
    const threat = this.behind
      && this.behindGap < lerp(7, 20, p.aggression)
      && !this.pass.active
      && this.state === 'race';

    if (threat) {
      if (this.defendHold <= 0 || this.defendSide === 0) {
        const k = this.aim.curvature;
        let side;
        if (Math.abs(k) > 1 / 260) side = k > 0 ? -1 : 1;             // the inside
        else side = (this.behindLat - this.myLat) >= 0 ? 1 : -1;      // cover them
        this.defendSide = side;
        this.defendHold = lerp(2.0, 4.2, p.consistency);
      }
      want = this.defendSide * this.halfAhead * lerp(0.04, 0.32, p.defend);
    } else if (this.defendHold <= 0) {
      this.defendSide = 0;
    }
    this.defendOffset += (want - this.defendOffset) * saturate(dt * 2.0);
  }

  /**
   * Short-horizon predictive avoidance.
   *
   * Constant-velocity extrapolation over 0.42 s — accurate to well under a car
   * length at these speeds, and short enough that the AI does not flinch at
   * cars it will never actually reach. Aggression buys the right to ignore a
   * near miss: a bold driver will run door-to-door and only lifts for a genuine
   * rear-ender, a cautious one leaves a car's width and gets out of the way.
   */
  _avoidLogic(dt) {
    const veh = this.vehicle;
    const p = this.p;
    let lateral = 0;
    let lift = 0;

    const needF = CAR_LENGTH * 0.95;
    const needL = CAR_HALF_WIDTH * 2 + 0.6;

    for (let i = 0; i < this.nearCount; i++) {
      const o = this.near[i];
      if (!o || !o.position || !o.velocity) continue;

      let worst = 0;
      let worstLat = 0;
      let worstFwd = 0;
      for (let s = 1; s <= AVOID_SAMPLES; s++) {
        const h = (s / AVOID_SAMPLES) * AVOID_HORIZON;
        const dx = (o.position.x + o.velocity.x * h) - (veh.position.x + veh.velocity.x * h);
        const dz = (o.position.z + o.velocity.z * h) - (veh.position.z + veh.velocity.z * h);
        const f = dx * this.fwdXZ.x + dz * this.fwdXZ.z;
        const l = dx * this.leftXZ.x + dz * this.leftXZ.z;   // + = to our left
        if (f < -CAR_LENGTH * 0.7 || f > needF * 2.4) continue;
        const pen = (1 - saturate(Math.abs(f) / needF)) * (1 - saturate(Math.abs(l) / needL));
        if (pen > worst) { worst = pen; worstLat = l; worstFwd = f; }
      }
      if (worst <= 0.002) continue;

      // Go the other way. Roughly aligned with the road, the car's right and
      // the line's right agree, which is all this needs.
      const dir = worstLat >= 0 ? 1 : -1;
      lateral += dir * worst * (CAR_HALF_WIDTH * 2) * lerp(1.0, 0.42, p.contactTol);

      if (worstFwd > 0) {
        const closing = (veh.velocity.x - o.velocity.x) * this.fwdXZ.x
          + (veh.velocity.z - o.velocity.z) * this.fwdXZ.z;
        if (closing > 1.5) {
          lift = Math.max(lift, worst * saturate(closing / 16) * lerp(1.0, 0.30, p.contactTol));
        }
      }
    }

    // Avoidance is a reflex: it moves faster than the tactical offsets do.
    this.avoidOffset += (clamp(lateral, -9, 9) - this.avoidOffset) * saturate(dt * 6);
    this.avoidLift += (saturate(lift) - this.avoidLift) * saturate(dt * 9);
  }

  /* ======================================================================
   * Mistakes
   * ====================================================================== */

  /**
   * Errors are scheduled, then *caused*. Every one of them is an input into the
   * ordinary control law with a smooth half-sine envelope, so what the camera
   * sees is a car that arrived too fast and ran wide, not a car whose steering
   * was jiggled. Pressure from behind raises the rate — which is where "runs
   * wide when you are all over the back of him" comes from.
   */
  _mistakes(dt) {
    const p = this.p;
    const m = this.mistake;

    const pressure = this.behind ? saturate(1 - this.behindGap / 12) : 0;
    const attacking = this.pass.active ? 0.5 : 0;
    const rate = p.mistakeRate * (1 + pressure * 0.9 + attacking * 0.5);

    if (m.type === 'none') {
      this.mistakeClock -= dt * Math.max(0.05, rate);
      if (this.mistakeClock <= 0) {
        this.mistakeClock = this.rng.range(7, 22);
        if (this.state === 'race') this._beginMistake();
      }
    } else {
      m.time -= dt;
      if (m.time <= 0) { m.type = 'none'; m.time = 0; }
    }

    // Envelope: in and out over the life of the mistake, peak in the middle.
    const env = m.type === 'none' ? 0 : Math.sin(Math.PI * saturate(1 - m.time / Math.max(0.05, m.dur)));

    this.brakeLate = m.type === 'lateBrake' ? m.mag * env : 0;
    this.mistakeOffset = m.type === 'wide' ? m.dir * m.mag * env : 0;
    this.hesitate = m.type === 'hesitate' ? m.mag * env : 0;

    this._kerbBobble(dt);

    // Continuous hands. Low frequency and tiny — this is the difference between
    // a car held on rails and a car held by someone, and it must never be
    // large enough to read as a correction.
    const n = value2D(this.time * 0.55, this.noisePhase, this.seed) - 0.5;
    this.handNoise = n * lerp(0.003, 0.020, 1 - p.consistency);
  }

  /** Pick an error that the current situation actually supports. */
  _beginMistake() {
    const m = this.mistake;
    const r = this.rng.next();
    const sloppy = lerp(0.35, 1, 1 - this.p.consistency);
    const approaching = this.toBrake > 0 && this.toBrake < 60;
    const inCorner = Math.abs(this.here.curvature) > 1 / 200;

    if (approaching && r < 0.45) {
      // Out-brakes himself. The consequence is emergent: he arrives over the
      // limit, the tyres are already saturated and the car runs wide on its own.
      m.type = 'lateBrake';
      m.mag = sloppy * this.rng.range(0.10, 0.30);
      m.dur = 2.6;
    } else if (inCorner && r < 0.82) {
      // Runs out of road on the exit. Outside of a left-hander is the right.
      m.type = 'wide';
      m.mag = sloppy * this.rng.range(1.1, 3.2);
      m.dir = this.here.curvature >= 0 ? 1 : -1;
      m.dur = this.rng.range(0.8, 1.6);
    } else {
      m.type = 'hesitate';
      m.mag = sloppy;
      m.dur = this.rng.range(0.16, 0.34);
    }
    m.time = m.dur;
  }

  /**
   * Riding a kerb unsettles the car. The driver takes a moment to gather it —
   * one smooth kick out and back, never a vibration.
   */
  _kerbBobble(dt) {
    const veh = this.vehicle;
    const p = this.p;
    const onEdge = Math.abs(finite(veh.trackLateral, 0)) > this.halfWidth - 1.4;

    if (this.bobble <= 0 && onEdge && this.speed > 28
      && this.rng.next() < (1 - p.consistency) * dt * 3.2) {
      this.bobble = 0.34;
      this.bobbleDir = finite(veh.trackLateral, 0) >= 0 ? 1 : -1;
      this.bobbleMag = lerp(0.04, 0.15, 1 - p.consistency);
    }

    if (this.bobble > 0) {
      this.bobble -= dt;
      const e = Math.sin(Math.PI * saturate(1 - this.bobble / 0.34));
      // Kicked further off the road, then gathered up by the ordinary PD trim.
      this.bobbleSteer = -this.bobbleDir * this.bobbleMag * e;
    } else {
      this.bobbleSteer = 0;
    }
  }

  /* ======================================================================
   * Recovery
   * ====================================================================== */

  /**
   * Spun, off, stuck or backwards. The reaction delay is real: a good driver is
   * already gathering it, a poor one sits there for a third of a second first.
   */
  _recovery(dt) {
    const veh = this.vehicle;
    const p = this.p;
    const slip = Math.abs(finite(veh.slipAngle, 0));
    const offRoad = Math.abs(finite(veh.trackLateral, 0)) > this.halfWidth + 1.5;
    const backwards = this.align < -0.15;

    this.stateTime += dt;

    if (this.speed < 3.2 && !veh.isAirborne) this.crawlTimer += dt;
    else this.crawlTimer = 0;

    const delay = lerp(0.42, 0.06, p.recover);

    switch (this.state) {
      case 'spin':
        if (slip < 0.42 || this.speed < 5) this._setState('race');
        else if (this.stateTime > 3.5) this._setState('race');
        break;

      case 'reverse':
        this.reverseTimer -= dt;
        if (this.reverseTimer <= 0 || (!backwards && this.crawlTimer <= 0)) this._setState('race');
        break;

      case 'rejoin':
        if (!offRoad) {
          this.reactClock += dt;
          if (this.reactClock > 0.35) this._setState('race');
        } else {
          this.reactClock = 0;
          if (this.stateTime > 8) this._setState('race');   // never get stuck here
        }
        break;

      default:
        this.reactClock = (slip > 1.0 || offRoad || backwards || this.crawlTimer > 1.1)
          ? this.reactClock + dt
          : 0;
        if (this.reactClock < delay) break;
        if ((backwards && this.speed < 14) || this.crawlTimer > 1.1 + delay) {
          this._setState('reverse');
          this.reverseTimer = lerp(1.9, 1.1, p.recover);
        } else if (slip > 1.0 && this.speed > 6) {
          this._setState('spin');
        } else if (offRoad) {
          this._setState('rejoin');
        }
        break;
    }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    this.reactClock = 0;
    this.iErr = 0;
    if (s !== 'race') {
      this.pass.active = false;
      this.pass.target = null;
      this.pass.side = 0;
    }
  }

  /**
   * Is the lane we are about to rejoin into occupied? Pulling back on in front
   * of a car doing 90 u/s is the one recovery mistake that is never acceptable.
   */
  _rejoinBlocked() {
    if (!this.behind) return false;
    if (this.behindGap > 26) return false;
    // Only a car that is actually on the road and quicker matters.
    return Math.abs(this.behindLat) < this.halfWidth * 0.8
      && finite(this.behind.speed, 0) > this.speed + 4;
  }

  /* ======================================================================
   * Control
   * ====================================================================== */

  _drive(dt) {
    const veh = this.vehicle;
    const p = this.p;
    const g = finite(this.ctx?.settings?.physics?.gravity, 260);

    /* --- aim point ------------------------------------------------------- */

    _aimRight.set(-this.aim.tangent.z, 0, this.aim.tangent.x);
    if (_aimRight.lengthSq() < 1e-8) _aimRight.copy(this.rightXZ); else _aimRight.normalize();
    _aimPos.copy(this.aim.pos).addScaledVector(_aimRight, this.offset);

    _delta.set(_aimPos.x - veh.position.x, 0, _aimPos.z - veh.position.z);
    const dist = Math.max(2.5, _delta.length());

    /* --- pure pursuit ---------------------------------------------------- */

    // kappa = 2y/L^2 with y the aim point's offset in the car frame. Positive y
    // is to the car's left, and a left turn is positive curvature, so no sign
    // flip is needed anywhere in this block.
    const yLeft = _delta.dot(this.leftXZ);
    const kappaPP = (2 * yLeft) / (dist * dist);
    const wheelbase = Math.max(2, finite(veh.tuning?.wheelbase, 5.6));
    const ppAngle = Math.atan(clamp(kappaPP * wheelbase, -1.3, 1.3));

    /* --- PD trim on cross-track error ------------------------------------ */

    // Pure pursuit alone settles a constant-radius corner with a standing
    // offset proportional to the lookahead squared. This removes it. Gains are
    // scaled down with speed because the same metre of error needs a tenth of
    // the lock at 100 u/s that it needs at 20.
    this.err = this.crossErr - this.offset;
    this.errAbs = Math.abs(this.err);
    const vScale = 22 / (22 + this.speed);
    if (this.state === 'race' && this.errAbs < 6) {
      this.iErr = clamp(this.iErr + this.err * dt, -6, 6);
    } else {
      this.iErr *= 1 - saturate(dt * 3);
    }
    const pidAngle = (p.kCross * this.err + p.kDamp * this.crossRate * 0.35) * vScale
      + p.kInt * this.iErr;

    /* --- counter-steer ---------------------------------------------------- */

    // Two terms, and they do different jobs. The first points the front wheels
    // down the velocity vector — the thing a driver's hands actually do in a
    // slide. The second damps yaw rate against the rate the chosen path calls
    // for, which is what stops the correction from over-rotating the car the
    // other way. Skill scales both: a poor driver catches it late and badly.
    const slip = finite(veh.slipAngle, 0);
    const on = smoothstep(0.09, 0.26, Math.abs(slip));
    const counterAngle = on * p.counter * slip * 0.9;
    const yawErr = clamp(finite(veh.yawRate, 0) - kappaPP * this.fwdSpeed, -7, 7);
    const yawAngle = -p.yawDamp * yawErr * lerp(0.45, 1, on);

    // While genuinely sideways the path terms are backed off: a driver catching
    // a slide is not also trying to hit an apex.
    const blend = 1 - 0.45 * on;

    let angle = ppAngle * blend + pidAngle * blend + counterAngle + yawAngle
      + this.bobbleSteer + this.handNoise;

    /* --- friction ellipse -------------------------------------------------- */

    // How much of the tyre is already spoken for laterally. Take the worse of
    // what the car is measurably doing and what the commanded path demands, so
    // the pedals react on turn-in rather than one beat after it.
    const kCmd = Math.abs(Math.tan(angle) / wheelbase);
    const demand = (this.speed * this.speed * kCmd) / Math.max(1e-3, this.aLat);
    const measured = Math.abs(finite(veh.lateralG, 0)) * g / Math.max(1e-3, this.aLat);
    const latRaw = saturate(Math.max(demand, measured));
    this.latUse += (latRaw - this.latUse) * saturate(dt * 12);
    this.ellipse = Math.sqrt(Math.max(0, 1 - this.latUse * this.latUse));

    /* --- pedals ------------------------------------------------------------ */

    let throttle = 0;
    let brake = 0;

    if (this.state === 'reverse') {
      // Two phases: stop, which is what makes Vehicle select reverse, then
      // back up. Steering inverts, because in reverse the nose goes the other
      // way from the lock.
      if (veh.gear === -1) {
        throttle = 0.55;
        brake = 0;
      } else {
        throttle = 0;
        brake = 1;
      }
      // Point the nose back down the road while reversing away from trouble.
      const target = this._headingError();
      angle = clamp(target, -1.2, 1.2) * (veh.gear === -1 ? -1 : 1);
    } else if (this.state === 'spin') {
      // Off everything, let the counter-steer work, a touch of brake to settle
      // the car and scrub the rotation off.
      throttle = 0;
      brake = 0.3 * lerp(0.5, 1, p.recover);
    } else {
      const v = this.speed;
      const vTop = Math.max(20, finite(veh.topSpeed, 100));
      const err = this.vLimit - v;                 // + = room left to go faster
      const liftBand = Math.max(3, v * lerp(0.10, 0.22, p.skill));

      // The pedal that merely holds the current speed. Available thrust falls
      // as roughly P/v while drag climbs as v^2, so what it takes to sit at a
      // speed grows with it — which is why a fast sweeper is taken nearly flat
      // and a hairpin on a whiff of power. No lookup table anywhere.
      const maintain = clamp((v / vTop) * (v / vTop), 0.08, 1);

      if (this.toBrake <= 0) {
        // On the brakes for the corner ahead. Depth ramps in over the first
        // slice of the zone so the pedal is applied, not stamped on.
        const depth = saturate((-this.toBrake) / Math.max(4, this.brakeDist * 0.35 + 4));
        brake = lerp(0.55, 1, depth);
        throttle = 0;
      } else if (this.toBrake < liftBand) {
        // The lift. Off the power, not yet on the brake — this is the phase
        // that makes an AI car look like it is being driven into a corner
        // rather than switched into one.
        throttle = Math.min(maintain, saturate(this.toBrake / liftBand) * 0.5);
      } else {
        // Hold the limit: feed-forward plus a proportional term on the speed
        // error. On a straight the error is enormous and this saturates at full
        // throttle; mid-corner it settles on exactly the pedal that maintains
        // the cornering speed, which is what gets an AI car back on the power
        // at the apex instead of coasting to the exit.
        throttle = saturate(maintain + err * 0.075);
      }

      // Overspeed for any reason — a mistake, a bad exit, a shove, or simply
      // the corner already underneath the car — outranks the phase logic. A
      // driver lifts long before he brakes, so a small excess is coasted off
      // and only a real one gets the pedal; without that dead band the car
      // would flicker its brake lights all the way down every straight.
      const overTol = 0.8 + this.vLimit * 0.012;
      if (err < -overTol) {
        brake = Math.max(brake, saturate((-err - overTol) / Math.max(5, this.vLimit * 0.12)));
        throttle = 0;
      } else if (err < 0) {
        throttle = Math.min(throttle, maintain * 0.5);
      }

      // Trail braking. As lock goes on, the ellipse takes the pedal away; the
      // taper into the apex is the physics, not an animation curve.
      if (brake > 0) brake = Math.min(brake, this.ellipse + 0.14);

      if (brake > 0.02) {
        throttle = 0;
      } else {
        // Exit traction, as a force balance rather than a fudge. The thrust the
        // engine can make here is roughly P/v; the thrust the tyres will accept
        // is what the friction ellipse has left after cornering. Their ratio is
        // the pedal ceiling — which is why this bites hard out of a hairpin in
        // second gear and barely at all through a fast sweeper, exactly as it
        // does for a real driver. `exitBold` is how far past it the driver is
        // willing to go; the wheelspin trim below is what it costs him.
        const thrust = this.thrustCap * (vTop / Math.max(v, vTop * 0.3));
        const cap = saturate((this.aLong * this.ellipse) / Math.max(1e-3, thrust) * p.exitBold);
        throttle = Math.min(throttle, Math.max(0.10, cap));

        const spin = finite(veh.wheelSpin, 0);
        if (spin > 0.45) {
          throttle *= 1 - saturate((spin - 0.45) / 0.55) * lerp(0.5, 0.85, p.skill);
        }
      }

      // Traffic and errors.
      if (this.avoidLift > 0.01) {
        throttle *= 1 - this.avoidLift * 0.85;
        if (this.avoidLift > 0.55) brake = Math.max(brake, (this.avoidLift - 0.55) * 1.6);
      }
      if (this.hesitate > 0) throttle *= 1 - this.hesitate * 0.85;
      if (this.state === 'rejoin' && this._rejoinBlocked()) {
        // Wait at the edge and let them through. This is the whole of "rejoin
        // safely" and it costs a second, which is the correct price.
        throttle = Math.min(throttle, 0.12);
        brake = Math.max(brake, 0.25);
      }
    }

    /* --- handbrake and boost ----------------------------------------------- */

    const handbrake = this._handbrake(dt);
    const boost = this._boost(throttle);

    /* --- output ------------------------------------------------------------ */

    const steerMax = Math.max(0.02, finite(veh.steerMax, 0.35));
    angle = clamp(angle, -steerMax * 1.2, steerMax * 1.2);
    // steerAngle is positive-left and setControls wants +1 right.
    const steerCmd = clamp(-angle / steerMax, -1, 1);

    // Reaction time. A first-order lag on the outputs, slower for weaker
    // drivers — they are late on the correction as well as late on the brakes.
    const ks = saturate(dt / Math.max(0.016, p.reaction));
    const kp = saturate(dt / 0.075);
    this.steerOut += (steerCmd - this.steerOut) * ks;
    this.throttleOut += (saturate(throttle) - this.throttleOut) * kp;
    this.brakeOut += (saturate(brake) - this.brakeOut) * kp;
    this.handbrakeOut = handbrake;
    this.boostOut = boost;

    veh.setControls({
      throttle: this.throttleOut,
      brake: this.brakeOut,
      steer: this.steerOut,
      handbrake: this.handbrakeOut,
      boost: this.boostOut,
    });
  }

  /** Signed angle from the car's nose to the racing line ahead, positive left. */
  _headingError() {
    const line = this.line;
    const L = line.length || 1;
    line.sampleAt(this.lineT + 16 / L, this.tmp);
    _probe.set(this.tmp.tangent.x, 0, this.tmp.tangent.z);
    if (_probe.lengthSq() < 1e-8) return 0;
    _probe.normalize();
    return Math.atan2(_probe.dot(this.leftXZ), _probe.dot(this.fwdXZ));
  }

  /**
   * The handbrake exists for hairpins the steering cannot reach, and for
   * nothing else. Gated hard: full lock, still missing the line, in the speed
   * band where a flick actually rotates the car, and a three-second cooldown so
   * it stays a technique rather than a tic.
   */
  _handbrake(dt) {
    const p = this.p;
    if (this.hbTimer > 0) { this.hbTimer -= dt; return 1; }
    if (this.hbCool > 0) { this.hbCool -= dt; return 0; }
    if (this.state !== 'race') return 0;
    if (p.aggression < 0.3) return 0;

    const tight = Math.abs(this.aim.curvature) > 1 / 34;
    const saturated = Math.abs(this.steerOut) > 0.93;
    if (tight && saturated && this.errAbs > 2.4 && this.speed > 18 && this.speed < 62) {
      this.hbTimer = lerp(0.16, 0.30, p.aggression);
      this.hbCool = 3.2;
      return 1;
    }
    return 0;
  }

  /** Boost where it pays: open road, throttle already pinned, someone to catch. */
  _boost(throttle) {
    const veh = this.vehicle;
    const p = this.p;
    if (p.boostSense < 0.25) return 0;
    if (this.state !== 'race') return 0;
    if (finite(veh.boostFuel, 0) < 0.25) return 0;
    if (throttle < 0.85) return 0;
    if (this.speed < Math.max(20, finite(veh.topSpeed, 100)) * 0.45) return 0;
    if (this.toBrake < Math.max(28, this.speed * 0.55)) return 0;
    // Never mid-corner: the tyres have nothing spare to turn it into speed and
    // it would only push the car wide.
    if (this.latUse > 0.55) return 0;

    const chasing = this.ahead && this.aheadGap < 32;
    const defending = this.behind && this.behindGap < 14;
    return (chasing || defending || finite(veh.boostFuel, 0) > 0.8) ? 1 : 0;
  }

  /* ======================================================================
   * Introspection
   * ====================================================================== */

  /** Compact state for core/Debug.js. */
  telemetry() {
    return {
      name: this.vehicle?.driverName ?? this.name,
      state: this.state,
      skill: +this.p.skill.toFixed(2),
      aggr: +this.p.aggression.toFixed(2),
      cons: +this.p.consistency.toFixed(2),
      vLimit: +this.vLimit.toFixed(1),
      speed: +this.speed.toFixed(1),
      toBrake: Number.isFinite(this.toBrake) ? +this.toBrake.toFixed(1) : null,
      cornerV: +this.cornerV.toFixed(1),
      latUse: +this.latUse.toFixed(2),
      err: +this.err.toFixed(2),
      offset: +this.offset.toFixed(2),
      band: +this.band.toFixed(3),
      pass: this.pass.active ? (this.pass.side > 0 ? 'right' : 'left') : '',
      defend: this.defendOffset !== 0 ? (this.defendSide > 0 ? 'right' : 'left') : '',
      mistake: this.mistake.type,
      aheadGap: Number.isFinite(this.aheadGap) ? +this.aheadGap.toFixed(1) : null,
      behindGap: Number.isFinite(this.behindGap) ? +this.behindGap.toFixed(1) : null,
      throttle: +this.throttleOut.toFixed(2),
      brake: +this.brakeOut.toFixed(2),
      steer: +this.steerOut.toFixed(2),
    };
  }

  dispose() {
    this.vehicle = null;
    this.track = null;
    this.line = null;
    this.ahead = null;
    this.behind = null;
    this.pass.target = null;
    for (let i = 0; i < this.near.length; i++) this.near[i] = null;
    this.nearCount = 0;
  }
}

export default Driver;
