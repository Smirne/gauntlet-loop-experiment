// audio/EngineSound.js — eight engines, no samples.
//
// This is the sound the player hears for twenty-two minutes of a championship,
// so it gets the most care of anything in audio/. The model is the real one:
//
//   An engine's exhaust note is a pulse train. A four-stroke fires once per two
//   crank revolutions per cylinder, so a V8 produces four pulses per revolution
//   and its fundamental sits at 4 x rpm/60 — 480 Hz at 7200 rpm, which is
//   exactly where a real one sits. Everything characterful lives in the
//   *spectrum* of that pulse train:
//
//     * A cross-plane V8's uneven firing puts real energy on the HALF orders
//       (2 x rpm/60). That, and only that, is the burble. Give a V8 clean
//       quarter-order spacing and it turns into a Ferrari flat-plane instantly.
//     * A 2-stroke single fires once per revolution, so every harmonic of the
//       crank is present — a sawtooth, which is why a kart engine is a buzz.
//     * A V10 fires five times per revolution with no half-order content at
//       all: pure, bright, and an octave-and-a-bit above everything else at the
//       same rpm. That is the scream.
//
// So each chassis is a harmonic amplitude table, and one OscillatorNode driven
// by a PeriodicWave built from that table synthesises the whole stack in a
// single node with perfect band-limiting. Two waves per engine — a rounded
// light-load spectrum and a raspy full-load one — crossfade on engine load,
// which is what makes lifting off audibly different from holding it pinned at
// the same rpm.
//
// On top of that: an induction noise band that opens with throttle, a peaking
// filter standing in for the exhaust pipe's resonance, a load-and-rpm-tracking
// lowpass, scheduled overrun pops, a rev limiter that bounces, and a real
// torque interruption on every gearshift.
//
// PHASE MATTERS. The same amplitude spectrum sounds like an organ with random
// phases and like an exhaust with coherent ones, because coherent phases
// reassemble into the pulse. The full-load wave is nearly coherent (impulsive,
// hard-edged); the light-load wave is Schroeder-phased (flat, smooth, low crest
// factor). That single control is worth more than any filter in the chain.

import { makeRng, clamp, saturate } from '../core/Random.js';

/* ========================================================== chassis profiles */

/**
 * `orders` is the firing frequency expressed as a harmonic of the crank, which
 * is the only number that has to be right. Everything else is voicing.
 *
 *   4-stroke:  orders = cylinders / 2      V8 -> 4,  I4 -> 2,  V6 -> 3,  V10 -> 5
 *   2-stroke:  orders = cylinders          single -> 1
 */
export const ENGINE_PROFILES = {

  // Cross-plane V8. Lazy, enormous, and mostly below 500 Hz.
  muscle: {
    label: 'Cross-plane V8', orders: 4, half: 0.68, crankNoise: 0.20,
    rolloffSoft: 0.58, rolloffHard: 0.76, tiltSoft: 0.90, tiltHard: 1.06,
    spreadSoft: 0.88, spreadHard: 0.18,
    exhaustHz: 148, exhaustQ: 3.4, exhaustDb: 9.5, exhaustTrack: 0.16,
    intakeGain: 0.20, intakeHz: 520, intakeQ: 0.9, intakeTrack: 1.5,
    cutoffIdle: 560, cutoffRev: 2600, cutoffLoad: 2900, resonance: 2.1,
    crackle: 0.95, crackleHz: 1300, crackleQ: 2.2, crackleAmp: 0.30,
    whine: 0, whineHz: 0, turbo: 0,
    level: 1.00, idleFloor: 0.30,
  },

  // Open-pipe hot rod: the same engine with the silencers taken off. More
  // upper harmonics, more crackle, and a resonance an octave up from the pipe.
  hotrod: {
    label: 'Open-pipe V8', orders: 4, half: 0.74, crankNoise: 0.24,
    rolloffSoft: 0.64, rolloffHard: 0.84, tiltSoft: 0.96, tiltHard: 1.14,
    spreadSoft: 0.72, spreadHard: 0.10,
    exhaustHz: 205, exhaustQ: 2.6, exhaustDb: 11, exhaustTrack: 0.20,
    intakeGain: 0.30, intakeHz: 700, intakeQ: 0.8, intakeTrack: 1.7,
    cutoffIdle: 720, cutoffRev: 3600, cutoffLoad: 3800, resonance: 2.4,
    crackle: 1.25, crackleHz: 1750, crackleQ: 1.9, crackleAmp: 0.42,
    whine: 0, whineHz: 0, turbo: 0,
    level: 1.05, idleFloor: 0.32,
  },

  // Turbo flat-four rally car. Boxer beat from the half order, big induction
  // whoosh, and the anti-lag pops that make a rally stage sound like a rally
  // stage.
  rally: {
    label: 'Turbo flat-four', orders: 2, half: 0.52, crankNoise: 0.30,
    rolloffSoft: 0.62, rolloffHard: 0.80, tiltSoft: 0.94, tiltHard: 1.12,
    spreadSoft: 0.80, spreadHard: 0.16,
    exhaustHz: 232, exhaustQ: 2.8, exhaustDb: 8, exhaustTrack: 0.22,
    intakeGain: 0.42, intakeHz: 900, intakeQ: 0.7, intakeTrack: 1.9,
    cutoffIdle: 700, cutoffRev: 4200, cutoffLoad: 3600, resonance: 1.9,
    crackle: 1.40, crackleHz: 2100, crackleQ: 1.6, crackleAmp: 0.46,
    whine: 0.05, whineHz: 26, turbo: 0.55, turboHz: 2600,
    level: 0.98, idleFloor: 0.28,
  },

  // Flat-six GT. Even fire, no half order, thick mid harmonics, and it keeps
  // climbing well past where the V8s have run out of revs.
  gt: {
    label: 'Flat-six', orders: 3, half: 0, crankNoise: 0.14,
    rolloffSoft: 0.66, rolloffHard: 0.84, tiltSoft: 0.98, tiltHard: 1.16,
    spreadSoft: 0.76, spreadHard: 0.14,
    exhaustHz: 320, exhaustQ: 3.0, exhaustDb: 8.5, exhaustTrack: 0.26,
    intakeGain: 0.30, intakeHz: 1150, intakeQ: 0.9, intakeTrack: 2.1,
    cutoffIdle: 820, cutoffRev: 5200, cutoffLoad: 3400, resonance: 1.7,
    crackle: 0.70, crackleHz: 2400, crackleQ: 2.0, crackleAmp: 0.26,
    whine: 0.10, whineHz: 31, turbo: 0,
    level: 0.96, idleFloor: 0.26,
  },

  // Screaming V10. Five orders, almost no low end, and a spectrum that stays
  // bright at every load — an F1 car does not sound soft at part throttle.
  formula: {
    label: 'V10', orders: 5, half: 0, crankNoise: 0.08,
    rolloffSoft: 0.72, rolloffHard: 0.86, tiltSoft: 1.06, tiltHard: 1.24,
    spreadSoft: 0.66, spreadHard: 0.12,
    exhaustHz: 620, exhaustQ: 2.4, exhaustDb: 7, exhaustTrack: 0.34,
    intakeGain: 0.34, intakeHz: 2200, intakeQ: 0.8, intakeTrack: 2.4,
    cutoffIdle: 1400, cutoffRev: 8200, cutoffLoad: 2600, resonance: 1.3,
    crackle: 0.55, crackleHz: 3400, crackleQ: 2.2, crackleAmp: 0.20,
    whine: 0.30, whineHz: 44, turbo: 0,
    level: 0.90, idleFloor: 0.22,
  },

  // 2-stroke kart single: one firing per revolution means every crank harmonic
  // is present. A sawtooth with a resonant expansion chamber on top.
  kart: {
    label: '2-stroke single', orders: 1, half: 0, crankNoise: 0.10,
    rolloffSoft: 0.70, rolloffHard: 0.83, tiltSoft: 1.02, tiltHard: 1.18,
    spreadSoft: 0.70, spreadHard: 0.12,
    exhaustHz: 840, exhaustQ: 5.5, exhaustDb: 12, exhaustTrack: 0.40,
    intakeGain: 0.38, intakeHz: 1800, intakeQ: 0.7, intakeTrack: 2.2,
    cutoffIdle: 1100, cutoffRev: 7000, cutoffLoad: 2200, resonance: 1.5,
    crackle: 0.45, crackleHz: 2800, crackleQ: 2.6, crackleAmp: 0.18,
    whine: 0.12, whineHz: 38, turbo: 0,
    level: 0.86, idleFloor: 0.30,
  },

  // Big-bore V6 pickup. Low, chuggy, and deliberately dull above 2 kHz.
  truck: {
    label: 'V6 pickup', orders: 3, half: 0.22, crankNoise: 0.34,
    rolloffSoft: 0.54, rolloffHard: 0.72, tiltSoft: 0.80, tiltHard: 0.94,
    spreadSoft: 0.92, spreadHard: 0.26,
    exhaustHz: 128, exhaustQ: 3.8, exhaustDb: 10, exhaustTrack: 0.12,
    intakeGain: 0.24, intakeHz: 430, intakeQ: 1.0, intakeTrack: 1.3,
    cutoffIdle: 430, cutoffRev: 1900, cutoffLoad: 2200, resonance: 2.2,
    crackle: 0.55, crackleHz: 900, crackleQ: 2.4, crackleAmp: 0.24,
    whine: 0.06, whineHz: 18, turbo: 0.20, turboHz: 1700,
    level: 1.02, idleFloor: 0.34,
  },

  // Offroad four. Airbox-forward, plenty of mechanical clatter, mid-heavy.
  buggy: {
    label: 'Offroad four', orders: 2, half: 0.30, crankNoise: 0.32,
    rolloffSoft: 0.63, rolloffHard: 0.81, tiltSoft: 0.96, tiltHard: 1.12,
    spreadSoft: 0.82, spreadHard: 0.18,
    exhaustHz: 258, exhaustQ: 2.6, exhaustDb: 8, exhaustTrack: 0.24,
    intakeGain: 0.44, intakeHz: 1000, intakeQ: 0.7, intakeTrack: 2.0,
    cutoffIdle: 760, cutoffRev: 4400, cutoffLoad: 3200, resonance: 1.8,
    crackle: 0.85, crackleHz: 2000, crackleQ: 1.8, crackleAmp: 0.32,
    whine: 0.08, whineHz: 24, turbo: 0.15, turboHz: 2200,
    level: 0.97, idleFloor: 0.30,
  },

  // Little turbo hot hatch: thin, buzzy, and all wastegate.
  hatch: {
    label: 'Turbo four', orders: 2, half: 0.14, crankNoise: 0.22,
    rolloffSoft: 0.60, rolloffHard: 0.79, tiltSoft: 0.98, tiltHard: 1.18,
    spreadSoft: 0.78, spreadHard: 0.16,
    exhaustHz: 290, exhaustQ: 3.2, exhaustDb: 7.5, exhaustTrack: 0.26,
    intakeGain: 0.34, intakeHz: 1250, intakeQ: 0.8, intakeTrack: 2.1,
    cutoffIdle: 840, cutoffRev: 4800, cutoffLoad: 3000, resonance: 1.7,
    crackle: 0.95, crackleHz: 2600, crackleQ: 1.7, crackleAmp: 0.30,
    whine: 0.07, whineHz: 27, turbo: 0.70, turboHz: 3100,
    level: 0.92, idleFloor: 0.26,
  },

  // Diesel van. Clatter on the crank orders, nothing above 3 kHz, low redline.
  van: {
    label: 'Diesel four', orders: 2, half: 0.18, crankNoise: 0.48,
    rolloffSoft: 0.56, rolloffHard: 0.70, tiltSoft: 0.78, tiltHard: 0.90,
    spreadSoft: 0.94, spreadHard: 0.34,
    exhaustHz: 165, exhaustQ: 3.0, exhaustDb: 7, exhaustTrack: 0.10,
    intakeGain: 0.26, intakeHz: 560, intakeQ: 1.1, intakeTrack: 1.2,
    cutoffIdle: 420, cutoffRev: 1700, cutoffLoad: 1900, resonance: 2.0,
    crackle: 0.30, crackleHz: 1050, crackleQ: 3.0, crackleAmp: 0.20,
    whine: 0.05, whineHz: 16, turbo: 0.35, turboHz: 1500,
    level: 1.00, idleFloor: 0.38,
  },
};

const FALLBACK_PROFILE = 'gt';
const N_HARMONICS = 64;

/** Resolve a vehicle to its engine profile. Never returns null. */
export function engineProfileFor(vehicle) {
  const key = vehicle?.spec?.archetype || vehicle?.modelId || '';
  return ENGINE_PROFILES[key] || ENGINE_PROFILES[String(key).toLowerCase()]
    || ENGINE_PROFILES[FALLBACK_PROFILE];
}

/* ============================================================== wave building */

/**
 * Harmonic amplitude table for one load extreme.
 * @param {object} p profile
 * @param {number} rolloff per-firing-order amplitude decay
 * @param {number} tilt >1 leans on the top end, <1 rounds it off
 * @param {object} rng seeded, so a car sounds identical in every session
 */
function buildAmps(p, rolloff, tilt, rng) {
  const amps = new Float32Array(N_HARMONICS + 1);
  const orders = Math.max(1, p.orders);
  const halfOrder = orders % 2 === 0 ? orders / 2 : 0;
  for (let h = 1; h <= N_HARMONICS; h++) {
    const isFire = (h % orders) === 0;
    const isHalf = halfOrder > 0 && (h % halfOrder) === 0 && !isFire;
    let a = 0;
    if (isFire) a = Math.pow(rolloff, h / orders - 1);
    else if (isHalf) a = p.half * Math.pow(rolloff, h / orders);
    else if (h <= orders * 3) a = p.crankNoise / Math.pow(h, 0.7);
    if (!(a > 0)) continue;
    // Spectral tilt is a BOUNDED SHELF, not a second geometric series. Applying
    // it as tilt^order multiplies into the rolloff, and with the values a raspy
    // engine wants (rolloff 0.83, tilt 1.18) the product is 0.98 — a spectrum
    // that is flat to 12 kHz, which is noise, not an engine. Measured offline:
    // a 2-stroke built that way put its loudest partial on the eleventh
    // harmonic and its firing fundamental eleventh in rank. This version
    // reaches full tilt by the sixth firing order and stops.
    const order = h / orders;
    a *= 1 + (tilt - 1) * clamp((order - 1) / 5, 0, 1);
    // A perfectly smooth spectrum reads as synthetic; +/-18% of scatter is
    // enough to break that without disturbing the character.
    a *= 0.82 + rng.next() * 0.36;
    amps[h] = a;
  }
  return amps;
}

/**
 * Schroeder phases, scaled. spread = 0 leaves every harmonic in phase (a hard
 * pulse train, i.e. an open exhaust); spread = 1 gives the flattest possible
 * crest factor (a smooth, distant drone).
 */
function phaseFn(spread, rng) {
  const jitter = new Float32Array(N_HARMONICS + 1);
  for (let h = 1; h <= N_HARMONICS; h++) jitter[h] = (rng.next() - 0.5) * 0.8;
  return (h) => spread * (-Math.PI * h * (h - 1) / N_HARMONICS) + jitter[h] * spread;
}

/* ================================================================ one engine */

class EngineVoice {
  constructor(engineSound, isPlayer) {
    const audio = engineSound.audio;
    const ac = audio.ac;
    this.host = engineSound;
    this.audio = audio;
    this.ac = ac;
    this.isPlayer = !!isPlayer;
    this.vehicle = null;
    this.profile = ENGINE_PROFILES[FALLBACK_PROFILE];
    this.rng = makeRng(isPlayer ? 0x9E37 : 0x1234 + engineSound._serial++);

    const D = audio.dsp;

    /* --- output --------------------------------------------------------- */

    this.out = ac.createGain();
    this.out.gain.value = 1;
    if (isPlayer) {
      // The player's own engine is not a point in the world; it is the room.
      // A narrow stereo spread keeps it wide without smearing the rivals.
      this.panner = null;
      this.spread = ac.createStereoPanner ? ac.createStereoPanner() : null;
      if (this.spread) {
        this.spread.pan.value = 0;
        this.out.connect(this.spread);
        this.spread.connect(audio.buses.engine);
      } else {
        this.out.connect(audio.buses.engine);
      }
    } else {
      this.panner = audio.makePanner();
      this.out.connect(this.panner);
      this.panner.connect(audio.buses.engine);
    }

    /* --- level stages --------------------------------------------------- */

    // `voice` is written every frame; `cut` is written only by scheduled
    // automation (shift interruption, limiter bounce) so the two never fight.
    this.voice = ac.createGain();
    this.voice.gain.value = 0;
    this.voice.connect(this.out);

    this.cut = ac.createGain();
    this.cut.gain.value = 1;
    this.cut.connect(this.voice);

    /* --- tone shaping --------------------------------------------------- */

    this.peak = ac.createBiquadFilter();
    this.peak.type = 'peaking';
    this.peak.frequency.value = this.profile.exhaustHz;
    this.peak.Q.value = this.profile.exhaustQ;
    this.peak.gain.value = 0;
    this.peak.connect(this.cut);

    this.lp = ac.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 900;
    this.lp.Q.value = this.profile.resonance;
    this.lp.connect(this.peak);

    this.hp = ac.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 34;   // sub-audio content is pure headroom loss
    this.hp.Q.value = 0.7;
    this.hp.connect(this.lp);

    this.mix = ac.createGain();
    this.mix.gain.value = 1;
    this.mix.connect(this.hp);

    /* --- the oscillator pair -------------------------------------------- */

    this.gSoft = ac.createGain();
    this.gSoft.gain.value = 1;
    this.gSoft.connect(this.mix);
    this.oscSoft = ac.createOscillator();
    this.oscSoft.frequency.value = 20;
    this.oscSoft.connect(this.gSoft);

    this.gHard = ac.createGain();
    this.gHard.gain.value = 0;
    this.gHard.connect(this.mix);
    this.oscHard = ac.createOscillator();
    this.oscHard.frequency.value = 20;
    this.oscHard.connect(this.gHard);

    /* --- induction ------------------------------------------------------ */

    this.noise = ac.createBufferSource();
    this.noise.buffer = audio.noise;
    this.noise.loop = true;

    this.bpIntake = ac.createBiquadFilter();
    this.bpIntake.type = 'bandpass';
    this.bpIntake.frequency.value = 800;
    this.bpIntake.Q.value = 0.9;
    this.gIntake = ac.createGain();
    this.gIntake.gain.value = 0;
    this.noise.connect(this.bpIntake);
    this.bpIntake.connect(this.gIntake);
    this.gIntake.connect(this.mix);

    /* --- overrun crackle (post-filter: pops are meant to be sharp) ------- */

    this.bpCrackle = ac.createBiquadFilter();
    this.bpCrackle.type = 'bandpass';
    this.bpCrackle.frequency.value = 1600;
    this.bpCrackle.Q.value = 2;
    this.gCrackle = ac.createGain();
    this.gCrackle.gain.value = 0;
    this.noise.connect(this.bpCrackle);
    this.bpCrackle.connect(this.gCrackle);
    this.gCrackle.connect(this.voice);

    /* --- transmission whine and turbo ----------------------------------- */

    this.oscWhine = ac.createOscillator();
    this.oscWhine.type = 'triangle';
    this.oscWhine.frequency.value = 1000;
    this.gWhine = ac.createGain();
    this.gWhine.gain.value = 0;
    this.oscWhine.connect(this.gWhine);
    this.gWhine.connect(this.voice);

    this.oscTurbo = ac.createOscillator();
    this.oscTurbo.type = 'sine';
    this.oscTurbo.frequency.value = 2000;
    this.gTurbo = ac.createGain();
    this.gTurbo.gain.value = 0;
    this.oscTurbo.connect(this.gTurbo);
    this.gTurbo.connect(this.voice);

    /* --- running state -------------------------------------------------- */

    this.load = 0;
    this.rpmNorm = 0;
    this.crank = 20;
    this.level = 0;
    this.dist = 0;
    this._wasShifting = false;
    this._wasLimiting = false;
    this._nextPop = 0;
    this._popBurst = 0;
    this._started = false;
    this._D = D;
  }

  start(now) {
    if (this._started) return;
    this._started = true;
    // Independent read offsets so no two cars share a noise waveform.
    const off = this.rng.next() * (this.audio.noise.duration - 0.05);
    try { this.noise.start(now, off); } catch (_) { /* already started */ }
    try { this.oscSoft.start(now); } catch (_) { /* ignore */ }
    try { this.oscHard.start(now); } catch (_) { /* ignore */ }
    try { this.oscWhine.start(now); } catch (_) { /* ignore */ }
    try { this.oscTurbo.start(now); } catch (_) { /* ignore */ }
  }

  /** Point this voice at a car. Cheap enough to do whenever the field shuffles. */
  assign(vehicle, now) {
    if (this.vehicle === vehicle) return;
    this.vehicle = vehicle;
    const p = engineProfileFor(vehicle);
    this.profile = p;
    const waves = this.host.wavesFor(p);
    this.oscSoft.setPeriodicWave(waves.soft);
    this.oscHard.setPeriodicWave(waves.hard);
    this.peak.frequency.value = p.exhaustHz;
    this.peak.Q.value = p.exhaustQ;
    this.lp.Q.value = p.resonance;
    this.bpIntake.Q.value = p.intakeQ;
    this.bpCrackle.Q.value = p.crackleQ;
    this.oscTurbo.frequency.value = p.turboHz || 2000;
    // Come in from silence: a reassigned voice is by definition a distant car,
    // so nobody hears the fade, and it guarantees no click.
    this._D.jump(this.voice.gain, 0, now);
    this._D.jump(this.cut.gain, 1, now);
    // These two are only written when the profile asks for them, so a swap
    // from a turbo car to a naturally aspirated one has to clear them by hand.
    this._D.jump(this.gTurbo.gain, 0, now);
    this._D.jump(this.gWhine.gain, 0, now);
    this._D.jump(this.gCrackle.gain, 0, now);
    this.load = 0;
    this.level = 0;
    this._wasShifting = false;
    this._wasLimiting = false;
    this._nextPop = 0;
    if (this.panner && vehicle) {
      this.audio.setPannerPosition(this.panner, vehicle.position.x, vehicle.position.y, vehicle.position.z, now, 0);
    }
  }

  release(now) {
    if (!this.vehicle) return;
    this.vehicle = null;
    this._D.jump(this.voice.gain, 0, now);
  }

  /* ------------------------------------------------------------------ tick */

  update(dt, now, listener, gainScale) {
    const v = this.vehicle;
    if (!v) return;
    const p = this.profile;
    const D = this._D;
    const tune = v.tuning || {};
    const idle = tune.idleRpm || 1000;
    const redline = Math.max(idle + 500, tune.redlineRpm || 8000);

    /* --- rpm, load ---------------------------------------------------- */

    const rpm = clamp(v.rpm || idle, idle * 0.6, redline * 1.12);
    this.rpmNorm = saturate((rpm - idle) / (redline - idle));
    // Doppler is a frequency multiplier, not a panner property — the spec
    // dropped PannerNode doppler years ago.
    const dop = this.isPlayer ? 1 : this.audio.dopplerFor(v.position, v.velocity);
    this.crank = (rpm / 60) * dop;

    let loadTarget = saturate(v.engineLoad ?? v.throttle ?? 0);
    // Weight the raw pedal in: engineLoad folds in wheelspin and lags a little,
    // and the ear expects the note to harden the instant the throttle moves.
    loadTarget = saturate(loadTarget * 0.6 + saturate(v.throttle || 0) * 0.4);
    if (v.shifting) loadTarget *= 0.07;
    if (v.limiterActive) loadTarget *= 0.30;
    if (v.isAirborne) loadTarget = Math.max(loadTarget, 0.55); // no load, free revs
    if (v.boostAmount > 0) loadTarget = Math.min(1, loadTarget + v.boostAmount * 0.25);
    // Fast attack, slower release: engines get loud quicker than they get quiet.
    const k = saturate(dt * (loadTarget > this.load ? 26 : 12));
    this.load += (loadTarget - this.load) * k;
    const load = this.load;

    /* --- oscillators --------------------------------------------------- */

    D.set(this.oscSoft.frequency, this.crank, now, 0.012);
    D.set(this.oscHard.frequency, this.crank, now, 0.012);
    // Equal-power crossfade, so the total energy does not dip in the middle.
    const x = load * load * (3 - 2 * load);
    D.set(this.gSoft.gain, Math.cos(x * Math.PI * 0.5), now, 0.03);
    D.set(this.gHard.gain, Math.sin(x * Math.PI * 0.5), now, 0.03);

    /* --- filters ------------------------------------------------------- */

    const damage = saturate(v.damage || 0);
    const cutoff = clamp(
      (p.cutoffIdle + this.rpmNorm * p.cutoffRev + load * p.cutoffLoad) * (1 - damage * 0.25),
      160, 17000
    );
    D.set(this.lp.frequency, cutoff, now, 0.035);
    D.set(this.peak.frequency, p.exhaustHz * (1 + this.rpmNorm * p.exhaustTrack) * dop, now, 0.05);
    D.set(this.peak.gain, p.exhaustDb * (0.35 + 0.65 * load), now, 0.06);

    /* --- induction ----------------------------------------------------- */

    const intakeHz = clamp(p.intakeHz * (1 + this.rpmNorm * p.intakeTrack) * dop, 120, 16000);
    D.set(this.bpIntake.frequency, intakeHz, now, 0.04);
    D.set(this.gIntake.gain, p.intakeGain * load * (0.25 + 0.75 * this.rpmNorm), now, 0.05);

    /* --- turbo and transmission ---------------------------------------- */

    if (p.turbo > 0) {
      const spool = saturate(load * (0.35 + 0.65 * this.rpmNorm));
      D.set(this.oscTurbo.frequency, (p.turboHz || 2400) * (0.55 + 0.75 * this.rpmNorm) * dop, now, 0.09);
      D.set(this.gTurbo.gain, p.turbo * 0.045 * spool * spool, now, 0.08);
    }
    if (p.whine > 0) {
      const spd = Math.abs(v.forwardSpeed || v.speed || 0);
      D.set(this.oscWhine.frequency, clamp(spd * p.whineHz * dop, 60, 15000), now, 0.03);
      D.set(this.gWhine.gain, p.whine * 0.05 * (0.25 + 0.75 * load) * saturate(spd / 30), now, 0.05);
    }

    /* --- level --------------------------------------------------------- */

    // Idle is never silent, and revs are always louder than idle even off the
    // throttle: those two facts are most of what makes a synth engine convince.
    const rev = 0.45 + 0.55 * this.rpmNorm;
    let lvl = p.level * (p.idleFloor + (1 - p.idleFloor) * load) * rev;
    lvl *= this.isPlayer ? 0.24 : 0.19;
    lvl *= gainScale;
    D.set(this.voice.gain, lvl, now, 0.04);
    this.level = lvl;

    /* --- spatial ------------------------------------------------------- */

    if (this.panner) {
      this.audio.setPannerPosition(this.panner, v.position.x, v.position.y, v.position.z, now, 0.04);
    } else if (this.spread) {
      // Lean the player's engine very slightly with the steering, which reads
      // as the car rotating under the camera rather than as a panning effect.
      D.set(this.spread.pan, clamp((v.steerPos || 0) * -0.12, -0.3, 0.3), now, 0.1);
    }

    /* --- transients ---------------------------------------------------- */

    this._transients(now, v, p);
    this._crackle(now, v, p);
  }

  /** Gearshift torque interruption and the rev-limiter bounce. */
  _transients(now, v, p) {
    const shifting = !!v.shifting;
    if (shifting && !this._wasShifting) {
      const g = this.cut.gain;
      const dur = Math.max(0.05, v.tuning?.shiftTime ?? 0.11);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.14, now + 0.014);
      g.linearRampToValueAtTime(0.14, now + dur * 0.72);
      g.linearRampToValueAtTime(1, now + dur + 0.05);
      this._popBurst = 2;
      this._nextPop = now + dur * 0.55;
    }
    this._wasShifting = shifting;

    const limiting = !!v.limiterActive;
    if (limiting && !this._wasLimiting) {
      const g = this.cut.gain;
      const dur = Math.max(0.03, v.tuning?.limiterCut ?? 0.055);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.20, now + 0.005);
      g.linearRampToValueAtTime(1, now + dur);
      this._popBurst = 1;
      this._nextPop = now + dur * 0.4;
    }
    this._wasLimiting = limiting;
  }

  /**
   * Overrun pops. Scheduled ahead on the audio clock rather than fired from
   * the frame loop, because a crackle that lands on a video frame boundary
   * sounds quantised — and it is.
   */
  _crackle(now, v, p) {
    if (p.crackle <= 0) return;
    const rpmN = this.rpmNorm;
    const overrun = (v.throttle || 0) < 0.09 && rpmN > 0.36
      && !v.isAirborne && (v.gear || 0) > 0 && (v.forwardSpeed || 0) > 14;
    const burst = this._popBurst > 0;
    if (!overrun && !burst) { this._nextPop = 0; return; }

    const damage = saturate(v.damage || 0);
    const rate = (overrun ? 8 + rpmN * 30 : 46) * p.crackle * (1 + damage * 0.6);
    if (this._nextPop <= 0) this._nextPop = now + this.rng.next() * 0.05;

    const horizon = now + 0.12;
    let guard = 0;
    while (this._nextPop < horizon && guard++ < 14) {
      const t = Math.max(now, this._nextPop);
      const amp = p.crackleAmp * (0.35 + this.rng.next() * 0.85)
        * (overrun ? 0.55 + rpmN * 0.7 : 1.15);
      const dur = 0.012 + this.rng.next() * 0.035;
      const g = this.gCrackle.gain;
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(Math.max(0.0005, amp), t + 0.0016);
      g.exponentialRampToValueAtTime(0.0001, t + 0.0016 + dur);
      // Retune the band on every pop; a fixed band reads as a machine gun.
      this.bpCrackle.frequency.setValueAtTime(
        clamp(p.crackleHz * (0.6 + this.rng.next() * 1.1), 200, 12000), t
      );
      this._nextPop = t + Math.max(dur + 0.008, (0.4 + this.rng.next() * 1.4) / rate);
      if (burst) { this._popBurst--; if (this._popBurst <= 0) break; }
    }
  }

  dispose() {
    const stop = (n) => { try { n.stop(); } catch (_) { /* not started */ } try { n.disconnect(); } catch (_) { /* ignore */ } };
    stop(this.oscSoft); stop(this.oscHard); stop(this.oscWhine); stop(this.oscTurbo); stop(this.noise);
    for (const n of [this.gSoft, this.gHard, this.gIntake, this.gCrackle, this.gWhine, this.gTurbo,
      this.bpIntake, this.bpCrackle, this.mix, this.hp, this.lp, this.peak, this.cut, this.voice,
      this.out, this.panner, this.spread]) {
      try { n?.disconnect?.(); } catch (_) { /* ignore */ }
    }
    this.vehicle = null;
  }
}

/* ================================================================== manager */

export class EngineSound {
  constructor(audio) {
    this.audio = audio;
    this.enabled = true;
    this.playerVoice = null;
    this.rivals = [];
    this.activeCount = 0;
    this._waveCache = new Map();
    this._serial = 0;
  }

  init() {
    const audio = this.audio;
    if (!audio?.ac) return this;
    this.playerVoice = new EngineVoice(this, true);
    const n = clamp(audio.maxEngineVoices, 1, 8);
    for (let i = 0; i < n; i++) this.rivals.push(new EngineVoice(this, false));
    return this;
  }

  /** Cached PeriodicWave pair for a profile. Two waves per chassis, ever. */
  wavesFor(p) {
    let w = this._waveCache.get(p);
    if (w) return w;
    const ac = this.audio.ac;
    const D = this.audio.dsp;
    // Seeded from the profile's own numbers so the scatter is stable per engine.
    const seed = Math.round(p.orders * 7919 + p.exhaustHz * 13 + p.cutoffRev);
    const softAmps = buildAmps(p, p.rolloffSoft, p.tiltSoft, makeRng(seed));
    const hardAmps = buildAmps(p, p.rolloffHard, p.tiltHard, makeRng(seed + 1));
    w = {
      soft: D.harmonicWave(ac, softAmps, phaseFn(p.spreadSoft, makeRng(seed + 2))),
      hard: D.harmonicWave(ac, hardAmps, phaseFn(p.spreadHard, makeRng(seed + 3))),
    };
    this._waveCache.set(p, w);
    return w;
  }

  applySettings() {
    const want = clamp(this.audio.maxEngineVoices, 1, 8);
    while (this.rivals.length > want) {
      const v = this.rivals.pop();
      v.dispose();
    }
    while (this.rivals.length < want && this.audio.ac) {
      const v = new EngineVoice(this, false);
      v.start(this.audio.now);
      this.rivals.push(v);
    }
    return this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    return this;
  }

  onShift(vehicle, up) {
    // The transient is picked up from vehicle.shifting inside update(); the
    // event exists so the mechanical clunk in Sfx lands on the same frame.
    void vehicle; void up;
  }

  /* ------------------------------------------------------------------ tick */

  update(dt, listener) {
    const audio = this.audio;
    if (!audio?.running || !this.enabled) return;
    const now = audio.now;
    const audible = audio.audible;
    if (!audible.player && audible.count === 0) {
      this._silence(now);
      return;
    }

    this.playerVoice?.start(now);
    for (let i = 0; i < this.rivals.length; i++) this.rivals[i].start(now);

    let active = 0;
    if (this.playerVoice) {
      if (audible.player) {
        this.playerVoice.assign(audible.player, now);
        this.playerVoice.update(dt, now, listener, 1);
        active++;
      } else {
        this.playerVoice.release(now);
      }
    }
    for (let i = 0; i < this.rivals.length; i++) {
      const voice = this.rivals[i];
      const v = i < audible.count ? audible.rivals[i] : null;
      if (v) {
        voice.assign(v, now);
        voice.update(dt, now, listener, 1);
        active++;
      } else {
        voice.release(now);
      }
    }
    this.activeCount = active;
  }

  _silence(now) {
    this.playerVoice?.release(now);
    for (let i = 0; i < this.rivals.length; i++) this.rivals[i].release(now);
    this.activeCount = 0;
  }

  dispose() {
    this.playerVoice?.dispose();
    for (const v of this.rivals) v.dispose();
    this.rivals.length = 0;
    this.playerVoice = null;
    this._waveCache.clear();
    return this;
  }
}

export default EngineSound;
