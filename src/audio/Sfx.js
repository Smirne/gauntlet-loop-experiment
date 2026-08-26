// audio/Sfx.js — everything that is not the engine and not the music.
//
// Two halves that share a voice budget.
//
// CONTINUOUS. One tyre voice per audible car, pooled the same way the engine
// voices are. Each one carries the rolling noise, the surface grain, the squeal
// and the boost hiss for that car, all driven straight off the per-wheel state
// vehicle/Tires.js publishes — `w.squeal`, `w.lateralSlipSpeed`, `w.load`,
// `w.surface`. Nothing here guesses at what the tyres are doing; it reads it.
//
// The surface metadata in textures/Surfaces.js is the whole design. Every named
// surface carries `{ rollGain, rollFilter, rollGrain, skidGain, skidFilter,
// impact }`, and those six numbers are what make felt, gravel and varnished oak
// three completely different experiences rather than one hiss with the tone
// control moved. Baize barely whispers and cannot squeal; gravel is almost all
// grain and no tone; a varnished tabletop is quiet to roll on and screams under
// a locked wheel. That is not a mixing decision, it is in the data.
//
// ONE-SHOTS. A ring of 64 records, each holding the nodes for one sound and the
// audio-clock time it finishes. A sweep in update() disconnects anything that
// has finished, so nothing depends on `onended` firing (it does not, reliably,
// across a suspend/resume cycle) and the voice count can never drift.
//
// Positioning for one-shots is a distance gain, a stereo pan derived from the
// listener's own right vector and — beyond 120 units — an air-absorption
// lowpass. That is three cheap nodes instead of an HRTF convolution per hit,
// and for a 40 ms transient it is indistinguishable.

import { makeRng, clamp, saturate } from '../core/Random.js';
import * as SurfacesMod from '../textures/Surfaces.js';

/* ================================================================ constants */

/** Impulse that counts as maximum violence. Matches fx/Impacts.js and Director. */
const MAX_IMPULSE = 460;
const MIN_IMPULSE = 5;

const FALLBACK_AUDIO = {
  timbre: 'hard', rollGain: 0.5, rollFilter: 0.6, rollGrain: 0.15,
  skidGain: 0.9, skidFilter: 0.7, impact: 'tap',
};

const _surfCache = new Map();

/** Audio metadata for a surface. Never throws, never returns null. */
function surfaceAudio(name) {
  const key = typeof name === 'string' && name ? name : 'concrete';
  let a = _surfCache.get(key);
  if (a) return a;
  try {
    const d = SurfacesMod.surfaceDef ? SurfacesMod.surfaceDef(key)
      : SurfacesMod.SURFACE_DEFS?.[key];
    a = d?.audio ? { ...FALLBACK_AUDIO, ...d.audio, category: d.category || 'hard' } : FALLBACK_AUDIO;
  } catch (_) {
    a = FALLBACK_AUDIO;
  }
  _surfCache.set(key, a);
  return a;
}

/**
 * Ambient beds. Each circuit gets a two-layer noise floor plus sparse detail —
 * the detail is what stops a static bed reading as tape hiss.
 *
 * THE AIR LAYER WAS A HISS GENERATOR, AND THE COMMENT ABOVE WAS WRONG.
 *
 * `air` was a HIGHPASS on white noise, so it passed everything from airHz to
 * Nyquist. White noise carries equal energy per hertz, so a 3.4 kHz highpass
 * hands you the entire 3.4 k–20 k band — about eight times the bandwidth of
 * everything below it — and that band dominates. Measured on the menu with the
 * shipped values, tapping the buses with an analyser at master gain 0:
 *
 *     bus        flatness   centroid   85% rolloff   rms
 *     ambience     0.750     10096 Hz     16869 Hz   3.54e-5
 *     music        0.003       545 Hz       879 Hz   1.81e-5
 *
 * Flatness is the Wiener entropy — 1.0 is white noise, 0 is a pure tone. The
 * bed measured 0.75 with its energy centred at 10 kHz, running at roughly twice
 * the level of the music it was sitting on top of. No amount of sparse `detail`
 * rescues that; the detail fires once every 8–22 s and the hiss is continuous.
 *
 * Two changes. `air` is now a BAND (see AIR_TOP_MULT) rather than a highpass,
 * which removes the 6 k–20 k tail that owned the spectrum, and the gains below
 * are cut hard. The bed stays: it is the part that reads as a room.
 */
const AMBIENCE = {
  kitchen: { bedHz: 250, bedQ: 0.8, bed: 0.055, airHz: 3400, air: 0.008, detail: 'clink', every: [6, 17] },
  garden: { bedHz: 520, bedQ: 0.6, bed: 0.070, airHz: 5200, air: 0.013, detail: 'bird', every: [3, 9] },
  workbench: { bedHz: 130, bedQ: 1.0, bed: 0.075, airHz: 2600, air: 0.009, detail: 'clank', every: [7, 19] },
  pool: { bedHz: 170, bedQ: 0.9, bed: 0.050, airHz: 2100, air: 0.006, detail: 'murmur', every: [6, 16] },
  bedroom: { bedHz: 95, bedQ: 1.1, bed: 0.045, airHz: 1500, air: 0.005, detail: 'house', every: [9, 24] },
  menu: { bedHz: 200, bedQ: 0.8, bed: 0.026, airHz: 2800, air: 0.004, detail: 'clink', every: [8, 22] },
};

/** Ceiling of the air band, as a multiple of airHz. About 1.3 octaves. */
const AIR_TOP_MULT = 2.5;

/**
 * Extra ducking while the player is in the menu.
 *
 * The menu is where a bed is most exposed — no engines, no tyres, nothing else
 * competing — and it is the first thing anyone hears. It is also where a player
 * sits reading, rather than racing for ninety seconds.
 */
const MENU_AMBIENCE_DUCK = 0.45;

/** Scratch for reading the pooled physics contact event. Never escapes. */
const _pt = { x: 0, y: 0, z: 0 };

/* ============================================================== a tyre voice */

class TyreVoice {
  constructor(sfx, isPlayer) {
    const audio = sfx.audio;
    const ac = audio.ac;
    this.sfx = sfx;
    this.audio = audio;
    this.ac = ac;
    this.isPlayer = !!isPlayer;
    this.vehicle = null;
    this.rng = makeRng(0x7C0D + sfx._serial++);
    this._vib = this.rng.next() * 6.28;
    this._boostWas = false;
    this._bottom = [0, 0, 0, 0];
    this._started = false;

    this.out = ac.createGain();
    this.out.gain.value = 1;
    if (isPlayer) {
      this.panner = null;
      this.out.connect(audio.buses.sfx);
    } else {
      this.panner = audio.makePanner();
      this.out.connect(this.panner);
      this.panner.connect(audio.buses.sfx);
    }

    /* --- shared noise source ------------------------------------------- */

    this.noise = ac.createBufferSource();
    this.noise.buffer = audio.noise;
    this.noise.loop = true;

    /* --- rolling ------------------------------------------------------- */

    this.rollLp = ac.createBiquadFilter();
    this.rollLp.type = 'lowpass';
    this.rollLp.frequency.value = 900;
    this.rollLp.Q.value = 0.9;
    this.rollGain = ac.createGain();
    this.rollGain.gain.value = 0;
    this.noise.connect(this.rollLp);
    this.rollLp.connect(this.rollGain);
    this.rollGain.connect(this.out);

    /* --- surface grain: gravel, crumbs, sawdust ------------------------ */

    this.grainSrc = ac.createBufferSource();
    this.grainSrc.buffer = audio.grain;
    this.grainSrc.loop = true;
    this.grainBp = ac.createBiquadFilter();
    this.grainBp.type = 'bandpass';
    this.grainBp.frequency.value = 1400;
    this.grainBp.Q.value = 0.7;
    this.grainGain = ac.createGain();
    this.grainGain.gain.value = 0;
    this.grainSrc.connect(this.grainBp);
    this.grainBp.connect(this.grainGain);
    this.grainGain.connect(this.out);

    /* --- squeal: a nasal tonal pair plus a resonant noise band ---------- */

    this.sqBp = ac.createBiquadFilter();
    this.sqBp.type = 'bandpass';
    this.sqBp.frequency.value = 700;
    this.sqBp.Q.value = 5;
    this.sqGain = ac.createGain();
    this.sqGain.gain.value = 0;
    this.sqBp.connect(this.sqGain);
    this.sqGain.connect(this.out);

    this.sqA = ac.createOscillator();
    this.sqA.type = 'sawtooth';
    this.sqA.frequency.value = 350;
    this.sqA.connect(this.sqBp);
    this.sqB = ac.createOscillator();
    this.sqB.type = 'sawtooth';
    this.sqB.frequency.value = 352;
    this.sqB.connect(this.sqBp);

    this.screechBp = ac.createBiquadFilter();
    this.screechBp.type = 'bandpass';
    this.screechBp.frequency.value = 1100;
    this.screechBp.Q.value = 12;
    this.screechGain = ac.createGain();
    this.screechGain.gain.value = 0;
    this.noise.connect(this.screechBp);
    this.screechBp.connect(this.screechGain);
    this.screechGain.connect(this.out);

    /* --- boost --------------------------------------------------------- */

    this.boostBp = ac.createBiquadFilter();
    this.boostBp.type = 'bandpass';
    this.boostBp.frequency.value = 2200;
    this.boostBp.Q.value = 0.7;
    this.boostGain = ac.createGain();
    this.boostGain.gain.value = 0;
    this.noise.connect(this.boostBp);
    this.boostBp.connect(this.boostGain);
    this.boostGain.connect(this.out);
  }

  start(now) {
    if (this._started) return;
    this._started = true;
    const d = this.audio.noise.duration;
    try { this.noise.start(now, this.rng.next() * Math.max(0.01, d - 0.05)); } catch (_) { /* ignore */ }
    try { this.grainSrc.start(now, this.rng.next() * Math.max(0.01, this.audio.grain.duration - 0.05)); } catch (_) { /* ignore */ }
    try { this.sqA.start(now); } catch (_) { /* ignore */ }
    try { this.sqB.start(now); } catch (_) { /* ignore */ }
  }

  assign(vehicle, now) {
    if (this.vehicle === vehicle) return;
    this.vehicle = vehicle;
    const D = this.audio.dsp;
    D.jump(this.rollGain.gain, 0, now);
    D.jump(this.grainGain.gain, 0, now);
    D.jump(this.sqGain.gain, 0, now);
    D.jump(this.screechGain.gain, 0, now);
    D.jump(this.boostGain.gain, 0, now);
    this._bottom[0] = this._bottom[1] = this._bottom[2] = this._bottom[3] = 0;
    this._boostWas = false;
    if (this.panner && vehicle) {
      this.audio.setPannerPosition(this.panner, vehicle.position.x, vehicle.position.y, vehicle.position.z, now, 0);
    }
  }

  release(now) {
    if (!this.vehicle) return;
    this.vehicle = null;
    const D = this.audio.dsp;
    D.jump(this.rollGain.gain, 0, now);
    D.jump(this.grainGain.gain, 0, now);
    D.jump(this.sqGain.gain, 0, now);
    D.jump(this.screechGain.gain, 0, now);
    D.jump(this.boostGain.gain, 0, now);
  }

  update(dt, now) {
    const v = this.vehicle;
    if (!v) return;
    const D = this.audio.dsp;
    const wheels = v.wheels;
    const speed = Math.abs(v.speed || 0);
    const top = Math.max(30, v.topSpeed || 100);
    const speedN = saturate(speed / top);

    /* --- aggregate the four contact patches ---------------------------- */

    let squeal = 0;
    let lateral = 0;
    let load = 0;
    let contacts = 0;
    let surface = v.surface || 'concrete';
    if (Array.isArray(wheels)) {
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w) continue;
        if (w.grounded) {
          contacts++;
          if (w.squeal > squeal) squeal = w.squeal;
          const ls = Math.abs(w.lateralSlipSpeed || 0);
          if (ls > lateral) lateral = ls;
          load += w.load || 0;
          if (i === 2 && typeof w.surface === 'string') surface = w.surface;
        }
        // Bump stop: the spring is out of travel and the chassis is on the
        // rubber. Half a second of hysteresis so a rough surface does not
        // machine-gun it.
        this._bottom[i] = Math.max(0, this._bottom[i] - dt);
        if (w.grounded && w.compressionN > 0.93 && this._bottom[i] <= 0 && speed > 6) {
          this._bottom[i] = 0.24;
          this.sfx.bottomOut(v, saturate((w.compressionN - 0.93) / 0.07) * saturate(speed / 60));
        }
      }
    }
    const contactFrac = contacts / 4;
    const meta = surfaceAudio(surface);

    /* --- rolling ------------------------------------------------------- */

    const rollCut = clamp(240 + Math.pow(meta.rollFilter, 1.4) * 6200 * (0.5 + 0.5 * speedN), 120, 16000);
    D.set(this.rollLp.frequency, rollCut, now, 0.05);
    const rollLvl = meta.rollGain * Math.pow(speedN, 0.75) * contactFrac * (this.isPlayer ? 0.18 : 0.13);
    D.set(this.rollGain.gain, rollLvl, now, 0.06);

    /* --- grain --------------------------------------------------------- */

    if (meta.rollGrain > 0.02) {
      // Crunch rate is wheel speed, not a fixed LFO — this is why gravel gets
      // faster and finer as the car speeds up instead of just getting louder.
      this.grainSrc.playbackRate.value = clamp(0.30 + speedN * 2.6, 0.25, 4);
      D.set(this.grainBp.frequency, clamp(380 + meta.rollFilter * 4600, 150, 14000), now, 0.06);
      D.set(this.grainGain.gain, meta.rollGrain * Math.pow(speedN, 0.6) * contactFrac * 0.30, now, 0.06);
    } else {
      D.set(this.grainGain.gain, 0, now, 0.08);
    }

    /* --- squeal -------------------------------------------------------- */

    const slipN = saturate(lateral / 55);
    const loadN = saturate(load / Math.max(1, 4 * 260 * 0.25));
    const sq = saturate(squeal) * meta.skidGain;
    if (sq > 0.005) {
      this._vib += dt * (9 + 8 * slipN);
      const vib = 1 + 0.028 * Math.sin(this._vib) + 0.012 * Math.sin(this._vib * 2.7);
      // Squeal rises with how hard the patch is being scrubbed and how loaded
      // it is: a light car sliding gently squeaks, a loaded one screams.
      const f = clamp((410 + 520 * slipN + 190 * loadN) * vib * (0.85 + meta.skidFilter * 0.35), 220, 3200);
      this.sqA.frequency.setTargetAtTime(f * 0.5, now, 0.02);
      this.sqB.frequency.setTargetAtTime(f * 0.5 * 1.0075, now, 0.02);
      D.set(this.sqBp.frequency, f, now, 0.02);
      D.set(this.sqBp.Q, 4 + meta.skidFilter * 7, now, 0.06);
      D.set(this.screechBp.frequency, f * 1.45, now, 0.03);
      D.set(this.sqGain.gain, sq * (this.isPlayer ? 0.15 : 0.11), now, 0.03);
      D.set(this.screechGain.gain, sq * (this.isPlayer ? 0.13 : 0.10) * (0.4 + meta.skidFilter * 0.8), now, 0.03);
    } else {
      D.set(this.sqGain.gain, 0, now, 0.05);
      D.set(this.screechGain.gain, 0, now, 0.05);
    }

    /* --- boost --------------------------------------------------------- */

    const boost = saturate(v.boostAmount || 0);
    if (boost > 0.01 || this._boostWas) {
      D.set(this.boostBp.frequency, 1500 + boost * 3200, now, 0.05);
      D.set(this.boostGain.gain, boost * (this.isPlayer ? 0.11 : 0.07), now, 0.05);
    }
    const boosting = !!v.boosting;
    if (boosting && !this._boostWas) this.sfx.boostWhoosh(v);
    this._boostWas = boosting;

    /* --- spatial ------------------------------------------------------- */

    if (this.panner) {
      this.audio.setPannerPosition(this.panner, v.position.x, v.position.y, v.position.z, now, 0.05);
    }
  }

  dispose() {
    const stop = (n) => { try { n.stop(); } catch (_) { /* ignore */ } try { n.disconnect(); } catch (_) { /* ignore */ } };
    stop(this.noise); stop(this.grainSrc); stop(this.sqA); stop(this.sqB);
    for (const n of [this.rollLp, this.rollGain, this.grainBp, this.grainGain, this.sqBp,
      this.sqGain, this.screechBp, this.screechGain, this.boostBp, this.boostGain,
      this.out, this.panner]) {
      try { n?.disconnect?.(); } catch (_) { /* ignore */ }
    }
    this.vehicle = null;
  }
}

/* ================================================================== the system */

export class Sfx {
  constructor(audio) {
    this.audio = audio;
    this.ac = audio.ac;
    this.bus = audio.buses.sfx;
    this.rng = makeRng(0x5FC0);
    this.theme = 'menu';
    this.enabled = true;
    this.activeCount = 0;
    this._serial = 0;
    // Starts true: the game boots into attract, so the very first bed anyone
    // hears is the ducked one. Race states clear it via setMenu(false).
    this._inMenu = true;

    this.playerTyres = null;
    this.rivalTyres = [];

    // One-shot bookkeeping. A fixed ring: no allocation once it has warmed up.
    this._rec = [];
    for (let i = 0; i < 64; i++) this._rec.push({ end: -1, n: [] });
    this._cursor = 0;

    this._lastContact = -1;
    this._lastContactImpulse = 0;
    this._lastImpactAt = -1;
    this._lastBottomAt = -1;
    this._wrongWay = false;
    this._wrongWayNext = 0;
    this._ambienceNext = 0;
    this._started = false;
    this._scrape = null;
    this._scrapeLevel = 0;
    this._scrapeStarted = false;
  }

  init() {
    const audio = this.audio;
    if (!audio?.ac) return this;
    this.playerTyres = new TyreVoice(this, true);
    const n = clamp(audio.maxEngineVoices - 1, 2, 6);
    for (let i = 0; i < n; i++) this.rivalTyres.push(new TyreVoice(this, false));
    this._buildAmbience();
    this._buildScrape();
    return this;
  }

  setTheme(theme) {
    this.theme = AMBIENCE[theme] ? theme : 'menu';
    this._applyAmbience();
    return this;
  }

  applySettings() { return this; }
  setEnabled(on) { this.enabled = !!on; return this; }

  start() {
    if (this._started || !this.audio.running) return this;
    this._started = true;
    const now = this.audio.now;
    this.playerTyres?.start(now);
    for (const t of this.rivalTyres) t.start(now);
    this._startAmbience(now);
    return this;
  }

  /* --------------------------------------------------------------- ambience */

  _buildAmbience() {
    const ac = this.ac;
    const audio = this.audio;
    this.ambSrc = ac.createBufferSource();
    this.ambSrc.buffer = audio.noise;
    this.ambSrc.loop = true;

    this.ambBedLp = ac.createBiquadFilter();
    this.ambBedLp.type = 'lowpass';
    this.ambBedLp.frequency.value = 250;
    this.ambBedLp.Q.value = 0.8;
    this.ambBedGain = ac.createGain();
    this.ambBedGain.gain.value = 0.05;
    this.ambSrc.connect(this.ambBedLp);
    this.ambBedLp.connect(this.ambBedGain);
    this.ambBedGain.connect(audio.buses.ambience);

    // Air is a BAND, not a highpass. A highpass on white noise passes airHz to
    // Nyquist, and that tail is what measured as 0.75 flatness centred at
    // 10 kHz — see the note on AMBIENCE. The lowpass is the whole fix.
    this.ambAirHp = ac.createBiquadFilter();
    this.ambAirHp.type = 'highpass';
    this.ambAirHp.frequency.value = 3000;
    this.ambAirLp = ac.createBiquadFilter();
    this.ambAirLp.type = 'lowpass';
    this.ambAirLp.frequency.value = 3000 * AIR_TOP_MULT;
    this.ambAirGain = ac.createGain();
    this.ambAirGain.gain.value = 0.008;
    this.ambSrc.connect(this.ambAirHp);
    this.ambAirHp.connect(this.ambAirLp);
    this.ambAirLp.connect(this.ambAirGain);
    this.ambAirGain.connect(audio.buses.ambience);

    // A very slow breathing modulation. Without it the bed reads as tape hiss
    // within about ten seconds.
    this.ambLfo = ac.createOscillator();
    this.ambLfo.type = 'sine';
    this.ambLfo.frequency.value = 0.055;
    this.ambLfoGain = ac.createGain();
    this.ambLfoGain.gain.value = 0.018;
    this.ambLfo.connect(this.ambLfoGain);
    this.ambLfoGain.connect(this.ambBedGain.gain);
  }

  _applyAmbience() {
    if (!this.ambBedGain) return;
    const a = AMBIENCE[this.theme] || AMBIENCE.menu;
    const now = this.audio.now;
    const D = this.audio.dsp;
    // In the menu nothing else is playing, so the bed is fully exposed and is
    // the first thing anyone hears. Duck it there.
    const duck = this._inMenu ? MENU_AMBIENCE_DUCK : 1;
    D.set(this.ambBedLp.frequency, a.bedHz, now, 0.4);
    D.set(this.ambBedLp.Q, a.bedQ, now, 0.4);
    D.set(this.ambBedGain.gain, a.bed * duck, now, 0.6);
    D.set(this.ambAirHp.frequency, a.airHz, now, 0.4);
    D.set(this.ambAirLp.frequency, a.airHz * AIR_TOP_MULT, now, 0.4);
    D.set(this.ambAirGain.gain, a.air * duck, now, 0.6);
    D.set(this.ambLfoGain.gain, a.bed * duck * 0.35, now, 0.6);
  }

  /**
   * Menu or not. Drives the duck above.
   *
   * Note this does NOT switch to the `menu` bed. AMBIENCE.menu is all but dead
   * code: `theme` comes from the loaded track, and a track is always loaded, so
   * the menu has always played the circuit's own bed. That is arguably the
   * nicer behaviour — you hear the kitchen while looking at the kitchen — so it
   * stays, and `menu` remains the fallback for a boot with no track.
   */
  setMenu(on) {
    const next = !!on;
    if (next === this._inMenu) return this;
    this._inMenu = next;
    this._applyAmbience();
    return this;
  }

  _startAmbience(now) {
    try { this.ambSrc.start(now, this.rng.next() * 2); } catch (_) { /* ignore */ }
    try { this.ambLfo.start(now); } catch (_) { /* ignore */ }
    this._applyAmbience();
    const a = AMBIENCE[this.theme] || AMBIENCE.menu;
    this._ambienceNext = now + a.every[0] + this.rng.next() * (a.every[1] - a.every[0]);
  }

  _ambienceDetail(now) {
    const a = AMBIENCE[this.theme] || AMBIENCE.menu;
    const dest = this.audio.buses.ambience;
    const rec = this._take(now + 1.6);
    if (!rec) return;
    const t = now + 0.01;
    switch (a.detail) {
      case 'bird': {
        // Two-note chirp with a fast upward bend — reads as a garden instantly.
        const f = 2400 + this.rng.next() * 1600;
        this._tone(rec, dest, t, { f0: f * 0.8, f1: f * 1.25, type: 'sine', dur: 0.055, gain: 0.055, bend: 0.04 });
        this._tone(rec, dest, t + 0.085, { f0: f * 1.15, f1: f * 0.92, type: 'sine', dur: 0.07, gain: 0.045, bend: 0.05 });
        break;
      }
      case 'clank':
        this._partials(rec, dest, t, [610, 1490, 2360, 3910], 0.55, 0.055);
        break;
      case 'clink':
        this._partials(rec, dest, t, [2180, 3320, 5210], 0.32, 0.038);
        break;
      case 'murmur':
        this._noise(rec, dest, t, { f0: 320, f1: 220, q: 1.1, dur: 1.1, gain: 0.05, atk: 0.35 });
        break;
      default:
        this._tone(rec, dest, t, { f0: 96, f1: 68, type: 'sine', dur: 0.4, gain: 0.05, bend: 0.3 });
        this._noise(rec, dest, t, { f0: 700, f1: 300, q: 0.9, dur: 0.22, gain: 0.02, atk: 0.004 });
        break;
    }
    this._ambienceNext = now + a.every[0] + this.rng.next() * (a.every[1] - a.every[0]);
  }

  /* ---------------------------------------------------------------- scrape */

  _buildScrape() {
    const ac = this.ac;
    this._scrape = {
      src: ac.createBufferSource(),
      bp: ac.createBiquadFilter(),
      bp2: ac.createBiquadFilter(),
      gain: ac.createGain(),
      pan: ac.createStereoPanner ? ac.createStereoPanner() : null,
    };
    const s = this._scrape;
    s.src.buffer = this.audio.noise;
    s.src.loop = true;
    s.bp.type = 'bandpass';
    s.bp.frequency.value = 1800;
    s.bp.Q.value = 5;
    s.bp2.type = 'peaking';
    s.bp2.frequency.value = 3600;
    s.bp2.Q.value = 6;
    s.bp2.gain.value = 8;
    s.gain.gain.value = 0;
    s.src.connect(s.bp);
    s.bp.connect(s.bp2);
    if (s.pan) { s.bp2.connect(s.gain); s.gain.connect(s.pan); s.pan.connect(this.bus); }
    else { s.bp2.connect(s.gain); s.gain.connect(this.bus); }
  }

  /* ------------------------------------------------------------ voice ring */

  /** Claim a record for a sound that finishes at `end`. Null when over budget. */
  _take(end) {
    const cap = Math.min(this._rec.length, this.audio.maxVoices);
    for (let i = 0; i < cap; i++) {
      const idx = (this._cursor + i) % cap;
      const r = this._rec[idx];
      if (r.end < 0) {
        this._cursor = (idx + 1) % cap;
        r.end = end;
        r.n.length = 0;
        return r;
      }
    }
    return null;
  }

  _sweep(now) {
    let active = 0;
    for (let i = 0; i < this._rec.length; i++) {
      const r = this._rec[i];
      if (r.end < 0) continue;
      if (r.end <= now) {
        for (let k = 0; k < r.n.length; k++) {
          const node = r.n[k];
          try { node.stop?.(); } catch (_) { /* already stopped */ }
          try { node.disconnect(); } catch (_) { /* ignore */ }
        }
        r.n.length = 0;
        r.end = -1;
      } else {
        active++;
      }
    }
    this.activeCount = active;
  }

  /* --------------------------------------------------------- synth helpers */

  /** Percussive attack/decay on a gain param, scheduled at absolute time `t`. */
  _ar(param, t, peak, atk, dec) {
    const p = Math.max(0.0004, peak);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(p, t + Math.max(0.0006, atk));
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(0.0006, atk) + Math.max(0.005, dec));
  }

  _tone(rec, dest, t, o) {
    const ac = this.ac;
    const osc = ac.createOscillator();
    osc.type = o.type || 'sine';
    const g = ac.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(dest);
    const f0 = Math.max(18, o.f0);
    const f1 = Math.max(18, o.f1 ?? f0);
    osc.frequency.setValueAtTime(f0, t);
    if (Math.abs(f1 - f0) > 0.5) osc.frequency.exponentialRampToValueAtTime(f1, t + (o.bend ?? o.dur));
    const atk = o.atk ?? 0.002;
    this._ar(g.gain, t, o.gain, atk, o.dur);
    osc.start(t);
    osc.stop(t + atk + o.dur + 0.06);
    rec.n.push(osc, g);
    return g;
  }

  _noise(rec, dest, t, o) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.audio.noise;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.Q.value = o.q ?? 1;
    const f0 = clamp(o.f0, 30, 20000);
    const f1 = clamp(o.f1 ?? f0, 30, 20000);
    f.frequency.setValueAtTime(f0, t);
    if (Math.abs(f1 - f0) > 1) f.frequency.exponentialRampToValueAtTime(f1, t + o.dur);
    const g = ac.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    const atk = o.atk ?? 0.0015;
    this._ar(g.gain, t, o.gain, atk, o.dur);
    const dur = this.audio.noise.duration;
    src.start(t, this.rng.next() * Math.max(0.01, dur - 0.05));
    src.stop(t + atk + o.dur + 0.06);
    rec.n.push(src, f, g);
    return g;
  }

  /**
   * A ring of inharmonic partials. This is what makes metal sound like metal:
   * a struck plate has modes at irrational ratios, not at 2x and 3x.
   */
  _partials(rec, dest, t, freqs, dur, gain, decayFall = 0.62) {
    const ac = this.ac;
    for (let i = 0; i < freqs.length; i++) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = clamp(freqs[i], 20, 18000);
      const g = ac.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(dest);
      const d = dur * Math.pow(decayFall, i);
      this._ar(g.gain, t, gain * Math.pow(0.72, i), 0.0012, d);
      osc.start(t);
      osc.stop(t + d + 0.06);
      rec.n.push(osc, g);
    }
  }

  /** A burst of discrete clicks — gravel scattering, crumbs, debris. */
  _clicks(rec, dest, t, density, spread, f, gain) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.audio.grain;
    src.loop = true;
    // The grain buffer is a fixed density, so rate does double duty: it sets
    // both how many clicks land in the window and how bright each one is.
    src.playbackRate.value = clamp((f / 1400) * (density / 12), 0.35, 3.6);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = clamp(f, 200, 14000);
    bp.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.value = 0;
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0006, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + spread);
    src.start(t, this.rng.next() * Math.max(0.01, this.audio.grain.duration - 0.05));
    src.stop(t + spread + 0.06);
    rec.n.push(src, bp, g);
  }

  /**
   * Distance gain, stereo pan from the listener's right vector, and an
   * air-absorption lowpass past 120 units. Returns the node to feed.
   */
  _place(rec, pos, scale = 1) {
    if (!pos) return this.bus;
    const ac = this.ac;
    const L = this.audio.listener;
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const ref = 30;
    const att = clamp(ref / (ref + 1.1 * Math.max(0, dist - ref)), 0.015, 1) * scale;

    const g = ac.createGain();
    g.gain.value = att;
    rec.n.push(g);

    let tail = g;
    if (dist > 120) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(19000 * Math.exp(-(dist - 120) / 620), 800, 19000);
      lp.Q.value = 0.7;
      g.connect(lp);
      rec.n.push(lp);
      tail = lp;
    }

    if (ac.createStereoPanner) {
      // right = forward x up, in the listener's own frame.
      const rx = L.fy * L.uz - L.fz * L.uy;
      const ry = L.fz * L.ux - L.fx * L.uz;
      const rz = L.fx * L.uy - L.fy * L.ux;
      const sp = ac.createStereoPanner();
      sp.pan.value = clamp((dx * rx + dy * ry + dz * rz) / dist, -1, 1) * 0.85;
      tail.connect(sp);
      sp.connect(this.bus);
      rec.n.push(sp);
    } else {
      tail.connect(this.bus);
    }
    return g;
  }

  /* ------------------------------------------------------------------ tick */

  update(dt, listener) {
    const audio = this.audio;
    if (!audio.running || !this.enabled) return;
    const now = audio.now;
    this._sweep(now);
    this.start();

    /* --- tyre voices ---------------------------------------------------- */

    // Audio ranked the field this frame; both subsystems use the same list so
    // the engine and the tyres of a given car are never voiced separately.
    const audible = audio.audible;
    if (this.playerTyres) {
      if (audible.player) { this.playerTyres.assign(audible.player, now); this.playerTyres.update(dt, now); }
      else this.playerTyres.release(now);
    }
    for (let i = 0; i < this.rivalTyres.length; i++) {
      const t = this.rivalTyres[i];
      const v = i < audible.count ? audible.rivals[i] : null;
      if (v) { t.assign(v, now); t.update(dt, now); }
      else t.release(now);
    }

    /* --- scrape decay --------------------------------------------------- */

    // The scrape is one sustained voice that contact events keep topping up;
    // between events it bleeds away, which is what a car peeling off a wall
    // actually does.
    if (this._scrape && this._scrapeLevel > 0) {
      this._scrapeLevel = Math.max(0, this._scrapeLevel - dt * 3.4);
      audio.dsp.set(this._scrape.gain.gain, this._scrapeLevel * 0.18, now, 0.03);
    }

    /* --- ambience detail ------------------------------------------------ */

    if (this._ambienceNext > 0 && now >= this._ambienceNext) this._ambienceDetail(now);

    /* --- wrong-way warning ---------------------------------------------- */

    if (this._wrongWay && now >= this._wrongWayNext) {
      this._wrongWayNext = now + 0.95;
      const rec = this._take(now + 0.5);
      if (rec) {
        this._tone(rec, this.bus, now + 0.01, { f0: 700, type: 'square', dur: 0.09, gain: 0.10 });
        this._tone(rec, this.bus, now + 0.16, { f0: 540, type: 'square', dur: 0.11, gain: 0.10 });
      }
    }

    void listener;
  }

  /* ============================================================== one-shots */

  /* --- collisions ------------------------------------------------------- */

  /**
   * physics/World.js hands us a POOLED event object. Everything we need is read
   * out of it synchronously here and the reference is never kept.
   */
  contact(ev) {
    if (!ev || !this.enabled) return;
    const impulse = Math.abs(ev.impulse || 0);
    if (impulse < MIN_IMPULSE) return;
    const p = ev.point;
    _pt.x = p?.x ?? 0; _pt.y = p?.y ?? 0; _pt.z = p?.z ?? 0;
    const kind = ev.kind || 'car-prop';
    const surface = ev.surface || 'concrete';
    this._lastContact = this.audio.now;
    this._lastContactImpulse = impulse;
    this._impact(impulse, kind, surface, _pt, ev.tangentSpeed || 0);
  }

  /**
   * The Vehicle-level event. Fires for both bodies in a physics contact, so it
   * is deduplicated against the authoritative physics event above.
   */
  vehicleImpact(p) {
    const impulse = Math.abs(p?.impulse || 0);
    if (impulse < MIN_IMPULSE || !this.enabled) return;
    const now = this.audio.now;
    if (now - this._lastContact < 0.06 && Math.abs(impulse - this._lastContactImpulse) < 1.5) return;
    const v = p.vehicle;
    _pt.x = v?.position?.x ?? 0; _pt.y = v?.position?.y ?? 0; _pt.z = v?.position?.z ?? 0;
    this._impact(impulse, p.kind || 'car-prop', v?.surface || 'concrete', _pt, 0);
  }

  _impact(impulse, kind, surface, pos, tangent) {
    const now = this.audio.now;
    // Two hits inside 35 ms are one hit as far as the ear is concerned, and
    // firing both just doubles the level.
    if (now - this._lastImpactAt < 0.035) return;
    this._lastImpactAt = now;

    const u = saturate(impulse / MAX_IMPULSE);
    const meta = surfaceAudio(surface);
    // A car hitting a car is die-cast on die-cast whatever the ground is made
    // of; a car hitting the world takes the world's timbre.
    const family = kind === 'car-car' ? 'diecast' : (meta.impact || 'tap');

    const rec = this._take(now + 1.4);
    if (!rec) return;
    const dest = this._place(rec, pos, 1);
    const t = now + 0.005;
    const g = 0.30 + 0.85 * u;
    this._impactBody(rec, dest, t, family, u, g);

    if (u > 0.35) this.audio.duck(0.14 * u, 0.12);
    if (tangent > 30) this.scrapeAt(pos, saturate(tangent / 90) * 0.7, surface);
  }

  _impactBody(rec, dest, t, family, u, g) {
    const R = this.rng;
    const jit = 0.9 + R.next() * 0.22;
    switch (family) {
      case 'diecast':
        // Zamak on zamak: a dense body thud with a bright, short metallic tink
        // sitting on top. Toy cars do not boom, they clack.
        this._tone(rec, dest, t, { f0: 170 * jit, f1: 96, type: 'triangle', dur: 0.09 + u * 0.11, gain: g * 0.55, bend: 0.05 });
        this._partials(rec, dest, t, [1480 * jit, 2360 * jit, 3970 * jit], 0.16 + u * 0.14, g * 0.22, 0.55);
        this._noise(rec, dest, t, { f0: 2600, f1: 900, q: 0.9, dur: 0.05, gain: g * 0.30 });
        break;
      case 'clang':
        this._partials(rec, dest, t, [430 * jit, 1180 * jit, 1970 * jit, 3310 * jit, 4890 * jit], 0.85 + u * 0.9, g * 0.34, 0.62);
        this._noise(rec, dest, t, { f0: 5200, f1: 1400, q: 0.7, dur: 0.06, gain: g * 0.34 });
        break;
      case 'knock':
        // Wood: a low body mode plus one clear overtone, gone in 120 ms.
        this._tone(rec, dest, t, { f0: 232 * jit, f1: 188 * jit, type: 'triangle', dur: 0.11, gain: g * 0.60, bend: 0.07 });
        this._partials(rec, dest, t, [640 * jit, 1720 * jit], 0.10, g * 0.20, 0.6);
        this._noise(rec, dest, t, { f0: 1700, f1: 620, q: 1.0, dur: 0.035, gain: g * 0.26 });
        break;
      case 'chink':
        this._partials(rec, dest, t, [2450 * jit, 3980 * jit, 6120 * jit], 0.26, g * 0.30, 0.55);
        this._noise(rec, dest, t, { f0: 7000, f1: 2600, q: 0.8, dur: 0.03, gain: g * 0.24 });
        break;
      case 'crack':
        this._noise(rec, dest, t, { f0: 3400, f1: 700, q: 0.7, dur: 0.09, gain: g * 0.52 });
        this._tone(rec, dest, t, { f0: 320 * jit, f1: 150, type: 'triangle', dur: 0.07, gain: g * 0.36, bend: 0.04 });
        break;
      case 'thud':
        this._tone(rec, dest, t, { f0: 118 * jit, f1: 62, type: 'sine', dur: 0.13 + u * 0.1, gain: g * 0.70, bend: 0.07 });
        this._noise(rec, dest, t, { f0: 620, f1: 200, q: 0.8, dur: 0.05, gain: g * 0.20 });
        break;
      case 'soft':
        this._noise(rec, dest, t, { f0: 520, f1: 180, q: 0.6, dur: 0.10, gain: g * 0.44, atk: 0.004 });
        this._tone(rec, dest, t, { f0: 96 * jit, f1: 58, type: 'sine', dur: 0.09, gain: g * 0.28, bend: 0.06 });
        break;
      case 'scatter':
        this._clicks(rec, dest, t, 14, 0.16 + u * 0.18, 2200 * jit, g * 0.50);
        this._noise(rec, dest, t, { f0: 900, f1: 360, q: 0.7, dur: 0.05, gain: g * 0.22 });
        break;
      case 'rustle':
        this._noise(rec, dest, t, { f0: 3200, f1: 1500, q: 0.5, dur: 0.16, gain: g * 0.34, atk: 0.01 });
        this._clicks(rec, dest, t, 8, 0.12, 4200, g * 0.18);
        break;
      case 'splash':
        // Bright to dark in 200 ms is what water does; the little bubble tone
        // underneath is the "plop".
        this._noise(rec, dest, t, { f0: 5600, f1: 700, q: 0.6, dur: 0.20 + u * 0.15, gain: g * 0.46, atk: 0.006 });
        this._tone(rec, dest, t + 0.02, { f0: 380 * jit, f1: 900 * jit, type: 'sine', dur: 0.08, gain: g * 0.18, bend: 0.07 });
        break;
      case 'tick':
        this._noise(rec, dest, t, { f0: 4200, f1: 2200, q: 1.4, dur: 0.022, gain: g * 0.40 });
        this._tone(rec, dest, t, { f0: 1150 * jit, f1: 820, type: 'square', dur: 0.02, gain: g * 0.16 });
        break;
      default:
        this._noise(rec, dest, t, { f0: 2400, f1: 800, q: 0.9, dur: 0.045, gain: g * 0.40 });
        this._tone(rec, dest, t, { f0: 260 * jit, f1: 150, type: 'triangle', dur: 0.06, gain: g * 0.30, bend: 0.04 });
        break;
    }
  }

  /** Wall scrape. One sustained voice that events keep alive. */
  scrape(ev) {
    if (!ev || !this._scrape) return;
    const p = ev.point;
    _pt.x = p?.x ?? 0; _pt.y = p?.y ?? 0; _pt.z = p?.z ?? 0;
    this.scrapeAt(_pt, saturate((ev.tangentSpeed || 0) / 80), ev.surface || 'concrete');
  }

  scrapeAt(pos, intensity, surface) {
    const s = this._scrape;
    if (!s || !(intensity > 0.02)) return;
    const now = this.audio.now;
    const D = this.audio.dsp;
    const meta = surfaceAudio(surface);
    if (!this._scrapeStarted) {
      this._scrapeStarted = true;
      try { s.src.start(now, this.rng.next() * 2); } catch (_) { /* ignore */ }
    }
    this._scrapeLevel = Math.max(this._scrapeLevel, saturate(intensity));
    D.set(s.bp.frequency, clamp(700 + meta.skidFilter * 3400, 200, 12000), now, 0.05);
    D.set(s.bp.Q, 3 + meta.skidFilter * 8, now, 0.08);
    D.set(s.gain.gain, this._scrapeLevel * 0.18, now, 0.01);
    if (s.pan) {
      const L = this.audio.listener;
      const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const rx = L.fy * L.uz - L.fz * L.uy;
      const ry = L.fz * L.ux - L.fx * L.uz;
      const rz = L.fx * L.uy - L.fy * L.ux;
      D.set(s.pan.pan, clamp((dx * rx + dy * ry + dz * rz) / dist, -1, 1) * 0.8, now, 0.05);
    }
  }

  /* --- chassis ---------------------------------------------------------- */

  bottomOut(vehicle, force) {
    const now = this.audio.now;
    if (now - this._lastBottomAt < 0.09) return;
    this._lastBottomAt = now;
    const rec = this._take(now + 0.6);
    if (!rec) return;
    const dest = this._place(rec, vehicle?.position, 1);
    const t = now + 0.004;
    const g = 0.16 + 0.5 * saturate(force);
    // Rubber bump stop, then the spring seat ringing.
    this._tone(rec, dest, t, { f0: 88, f1: 52, type: 'sine', dur: 0.11, gain: g * 0.7, bend: 0.06 });
    this._noise(rec, dest, t, { f0: 900, f1: 320, q: 1.2, dur: 0.045, gain: g * 0.4 });
    this._partials(rec, dest, t, [1240, 2180], 0.07, g * 0.14);
  }

  land(vehicle, airTime, speed) {
    const now = this.audio.now;
    const rec = this._take(now + 1.2);
    if (!rec) return;
    const dest = this._place(rec, vehicle?.position, 1);
    const t = now + 0.004;
    const hard = saturate(airTime / 1.1) * 0.6 + saturate(speed / 110) * 0.4;
    const meta = surfaceAudio(vehicle?.surface || 'concrete');
    const g = 0.22 + 0.62 * hard;
    this._tone(rec, dest, t, { f0: 128, f1: 58, type: 'sine', dur: 0.16, gain: g * 0.75, bend: 0.08 });
    this._noise(rec, dest, t, { f0: 1500 * (0.4 + meta.rollFilter), f1: 380, q: 0.8, dur: 0.09, gain: g * 0.42 });
    // Four tyres do not land at once, and the chirp is what sells the weight.
    if (meta.skidGain > 0.5) {
      this._tone(rec, dest, t + 0.012, { f0: 620, f1: 430, type: 'sawtooth', dur: 0.10, gain: g * 0.18, bend: 0.09 });
      this._tone(rec, dest, t + 0.045, { f0: 560, f1: 400, type: 'sawtooth', dur: 0.08, gain: g * 0.12, bend: 0.07 });
    }
    if (meta.rollGrain > 0.3) this._clicks(rec, dest, t, 12, 0.2, 1800, g * 0.34);
    if (hard > 0.55) this.audio.duck(0.12, 0.1);
  }

  shift(vehicle, up) {
    const now = this.audio.now;
    const rec = this._take(now + 0.5);
    if (!rec) return;
    const dest = this._place(rec, vehicle?.position, 0.8);
    const t = now + 0.003;
    // Selector fork and dog ring: a small dry mechanical clack.
    this._noise(rec, dest, t, { f0: up ? 2600 : 2100, f1: 900, q: 1.6, dur: 0.028, gain: 0.16 });
    this._tone(rec, dest, t, { f0: up ? 240 : 200, f1: 150, type: 'triangle', dur: 0.045, gain: 0.13, bend: 0.03 });
    // Turbo cars dump the charge pipe on every upshift.
    const prof = vehicle?.spec?.archetype;
    if (up && (prof === 'rally' || prof === 'hatch' || prof === 'truck' || prof === 'van' || prof === 'buggy')) {
      this._noise(rec, dest, t + 0.02, { f0: 4200, f1: 1200, q: 0.6, dur: 0.19, gain: 0.14, atk: 0.008 });
    }
  }

  boostWhoosh(vehicle) {
    const now = this.audio.now;
    const rec = this._take(now + 1.0);
    if (!rec) return;
    const dest = this._place(rec, vehicle?.position, 1);
    const t = now + 0.004;
    this._noise(rec, dest, t, { f0: 320, f1: 5200, q: 0.9, dur: 0.30, gain: 0.30, atk: 0.02 });
    this._tone(rec, dest, t, { f0: 140, f1: 720, type: 'sawtooth', dur: 0.26, gain: 0.12, bend: 0.24 });
  }

  respawn(vehicle) {
    const now = this.audio.now;
    const rec = this._take(now + 1.0);
    if (!rec) return;
    const dest = this._place(rec, vehicle?.position, 1);
    const t = now + 0.004;
    // A reverse-ish swell into a set-down clunk: reads as "picked up and placed".
    this._noise(rec, dest, t, { f0: 5000, f1: 900, q: 0.7, dur: 0.34, gain: 0.16, atk: 0.22 });
    this._tone(rec, dest, t + 0.30, { f0: 210, f1: 120, type: 'triangle', dur: 0.09, gain: 0.24, bend: 0.05 });
  }

  /* --- race furniture --------------------------------------------------- */

  countdown(value) {
    const now = this.audio.now;
    const rec = this._take(now + 0.6);
    if (!rec) return;
    const t = now + 0.005;
    // Rising pitch as the lights go out — A4, C#5, E5 — so the klaxon on GO
    // lands as the resolution of a major triad rather than a fourth beep.
    const table = [659.25, 554.37, 440];
    const f = table[clamp(value | 0, 1, 3) - 1];
    this._tone(rec, this.bus, t, { f0: f, type: 'square', dur: 0.16, gain: 0.22, atk: 0.004 });
    this._tone(rec, this.bus, t, { f0: f * 2, type: 'sine', dur: 0.12, gain: 0.09, atk: 0.004 });
    this._noise(rec, this.bus, t, { f0: 3200, f1: 1800, q: 2, dur: 0.02, gain: 0.06 });
  }

  klaxon() {
    const now = this.audio.now;
    const rec = this._take(now + 1.6);
    if (!rec) return;
    const t = now + 0.005;
    // Two detuned saws through the same envelope: an air horn, not a sine.
    this._tone(rec, this.bus, t, { f0: 372, f1: 356, type: 'sawtooth', dur: 0.85, gain: 0.20, atk: 0.012, bend: 0.8 });
    this._tone(rec, this.bus, t, { f0: 279, f1: 267, type: 'sawtooth', dur: 0.85, gain: 0.16, atk: 0.012, bend: 0.8 });
    this._tone(rec, this.bus, t, { f0: 744, type: 'square', dur: 0.55, gain: 0.06, atk: 0.012 });
    this._noise(rec, this.bus, t, { f0: 1800, f1: 700, q: 0.7, dur: 0.30, gain: 0.09, atk: 0.02 });
  }

  lapChime(best) {
    const now = this.audio.now;
    const rec = this._take(now + 2.2);
    if (!rec) return;
    const t = now + 0.005;
    const base = best ? 784 : 659;   // G5 for a personal best, E5 otherwise
    this._partials(rec, this.bus, t, [base, base * 2.76, base * 5.4, base * 8.93], 1.15, 0.13, 0.58);
    if (best) {
      this._tone(rec, this.bus, t + 0.10, { f0: base * 1.5, type: 'triangle', dur: 0.5, gain: 0.07, atk: 0.006 });
      this._tone(rec, this.bus, t + 0.22, { f0: base * 2, type: 'triangle', dur: 0.6, gain: 0.06, atk: 0.006 });
    }
  }

  positionStinger(dir) {
    const now = this.audio.now;
    const rec = this._take(now + 0.9);
    if (!rec) return;
    const t = now + 0.005;
    // Up: a bright rising triad. Down: the same shape inverted and darkened.
    const seq = dir > 0 ? [523, 659, 880] : [523, 415, 330];
    for (let i = 0; i < seq.length; i++) {
      this._tone(rec, this.bus, t + i * 0.055, {
        f0: seq[i], type: dir > 0 ? 'square' : 'triangle',
        dur: 0.13, gain: dir > 0 ? 0.10 : 0.09, atk: 0.003,
      });
    }
    this._noise(rec, this.bus, t, { f0: dir > 0 ? 6000 : 2200, f1: dir > 0 ? 3000 : 900, q: 1.2, dur: 0.06, gain: 0.05 });
  }

  fanfare(position) {
    const now = this.audio.now;
    const rec = this._take(now + 3.0);
    if (!rec) return;
    const t = now + 0.01;
    const win = (position | 0) <= 3;
    // Major arpeggio into a held triad for a podium, a flatter minor shape if
    // the player came home outside the points.
    const root = win ? 523.25 : 440;
    const steps = win ? [1, 1.26, 1.5, 2] : [1, 1.19, 1.5, 1.78];
    for (let i = 0; i < steps.length; i++) {
      const tt = t + i * 0.11;
      this._tone(rec, this.bus, tt, { f0: root * steps[i], type: 'square', dur: 0.22, gain: 0.13, atk: 0.004 });
      this._tone(rec, this.bus, tt, { f0: root * steps[i] * 0.5, type: 'sawtooth', dur: 0.22, gain: 0.07, atk: 0.004 });
    }
    const hold = t + steps.length * 0.11;
    for (const m of (win ? [1, 1.26, 1.5, 2] : [1, 1.19, 1.5])) {
      this._tone(rec, this.bus, hold, { f0: root * m, type: 'square', dur: 1.0, gain: 0.10, atk: 0.01 });
    }
    this._noise(rec, this.bus, hold, { f0: 7000, f1: 2000, q: 0.6, dur: 0.7, gain: 0.07, atk: 0.02 });
  }

  setWrongWay(on) {
    this._wrongWay = !!on;
    if (!on) this._wrongWayNext = 0;
    else this._wrongWayNext = this.audio.now;
    return this;
  }

  /* --- front end -------------------------------------------------------- */

  ui(kind) {
    const now = this.audio.now;
    const rec = this._take(now + 0.8);
    if (!rec) return;
    const t = now + 0.004;
    switch (kind) {
      case 'confirm':
        this._tone(rec, this.bus, t, { f0: 660, type: 'square', dur: 0.06, gain: 0.10 });
        this._tone(rec, this.bus, t + 0.055, { f0: 990, type: 'square', dur: 0.11, gain: 0.10 });
        break;
      case 'back':
        this._tone(rec, this.bus, t, { f0: 520, type: 'square', dur: 0.06, gain: 0.09 });
        this._tone(rec, this.bus, t + 0.05, { f0: 350, type: 'square', dur: 0.10, gain: 0.09 });
        break;
      case 'page':
        this._noise(rec, this.bus, t, { f0: 900, f1: 4200, q: 0.8, dur: 0.11, gain: 0.10, atk: 0.006 });
        this._tone(rec, this.bus, t, { f0: 300, f1: 700, type: 'triangle', dur: 0.10, gain: 0.06, bend: 0.09 });
        break;
      case 'move':
      default:
        this._tone(rec, this.bus, t, { f0: 880, type: 'square', dur: 0.035, gain: 0.075 });
        this._noise(rec, this.bus, t, { f0: 5200, f1: 3200, q: 2, dur: 0.018, gain: 0.035 });
        break;
    }
  }

  /* --- generic dispatch -------------------------------------------------- */

  play(id, opts = {}) {
    if (!id || !this.enabled) return null;
    if (id.startsWith('ui.')) return this.ui(id.slice(3));
    const now = this.audio.now;
    switch (id) {
      case 'race.klaxon': return this.klaxon();
      case 'race.countdown': return this.countdown(opts.value ?? 3);
      case 'race.lap': return this.lapChime(!!opts.best);
      case 'race.fanfare': return this.fanfare(opts.position ?? 1);
      case 'race.whiteFlag': {
        const rec = this._take(now + 1.4);
        if (!rec) return null;
        // Two rising bells: the white flag is information, not celebration.
        this._partials(rec, this.bus, now + 0.005, [880, 2430, 4750], 0.55, 0.10, 0.6);
        this._partials(rec, this.bus, now + 0.17, [1175, 3240, 6330], 0.65, 0.09, 0.6);
        return null;
      }
      case 'race.record': {
        const rec = this._take(now + 1.6);
        if (!rec) return null;
        const seq = [1046, 1318, 1568, 2093, 2637];
        for (let i = 0; i < seq.length; i++) {
          this._tone(rec, this.bus, now + 0.005 + i * 0.05, { f0: seq[i], type: 'square', dur: 0.14, gain: 0.075 });
        }
        return null;
      }
      case 'race.beep': return this.countdown(1);
      default:
        return null;
    }
  }

  /* ----------------------------------------------------------------- teardown */

  dispose() {
    this.playerTyres?.dispose();
    for (const t of this.rivalTyres) t.dispose();
    this.rivalTyres.length = 0;
    this.playerTyres = null;
    for (const r of this._rec) {
      for (const n of r.n) {
        try { n.stop?.(); } catch (_) { /* ignore */ }
        try { n.disconnect(); } catch (_) { /* ignore */ }
      }
      r.n.length = 0;
      r.end = -1;
    }
    for (const n of [this.ambSrc, this.ambLfo, this._scrape?.src]) {
      try { n?.stop?.(); } catch (_) { /* ignore */ }
      try { n?.disconnect?.(); } catch (_) { /* ignore */ }
    }
    for (const n of [this.ambBedLp, this.ambBedGain, this.ambAirHp, this.ambAirLp, this.ambAirGain,
      this.ambLfoGain, this._scrape?.bp, this._scrape?.bp2, this._scrape?.gain, this._scrape?.pan]) {
      try { n?.disconnect?.(); } catch (_) { /* ignore */ }
    }
    return this;
  }
}

export default Sfx;
