// audio/Audio.js — the WebAudio graph, the mixer, and the room.
//
// Everything you hear in this game is computed. There is not one sample file in
// the repository and there never will be, so this module is the foundry: it
// owns the AudioContext, the bus topology, the limiter that guarantees nothing
// clips no matter how many cars pile into a wall at once, the convolution
// reverb whose impulse response is *generated* per circuit, and the listener
// rig that places rival engines in space.
//
// Three things here are worth reading before changing anything.
//
// 1. AUTOPLAY. The context is constructed suspended and stays that way until a
//    real user gesture. Anything scheduled against `ac.currentTime` while the
//    context is suspended lands at whatever time the clock was frozen at, so
//    every submodule gates on `audio.running` and nothing — music scheduler
//    included — writes to the timeline before unlock(). game/Input.js already
//    calls unlock() on the first pointer press; we also install our own
//    capture-phase listener because the front end may swallow that press.
//
// 2. THE DOPPLER LIE. PannerNode's doppler was removed from the spec years ago,
//    so the shift is computed here and applied as a frequency multiplier by
//    EngineSound. The physically correct speed of sound at our scale (1 u = 1 cm
//    means 34300 u/s) would give a passing car a 0.3% pitch shift — completely
//    inaudible. We use 520 u/s for the same reason gravity is 260 rather than
//    981: the miniature is photographed as if it were full size, so it has to
//    *sound* full size too. At 520 a 30 u/s closing rate gives ~6%, which is
//    the "neeeeoowm" everyone expects.
//
// 3. THE ROOM IS PART OF THE ART DIRECTION. A kitchen table is a small bright
//    tiled space; a pool hall is long and dark; a bedroom floor is smothered in
//    soft furnishings and has almost no tail at all. Each circuit gets its own
//    synthesised impulse response — exponentially decaying noise with a
//    time-varying lowpass so the highs die before the lows, plus a handful of
//    discrete early reflections, which is what actually tells the ear how big a
//    room is.

import { makeRng, clamp, saturate } from '../core/Random.js';
import { EngineSound } from './EngineSound.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';

/* ================================================================ constants */

/** World units per second. Deliberately ~66x slower than reality — see header. */
export const SPEED_OF_SOUND = 520;

const DOPPLER_MIN = 0.82;
const DOPPLER_MAX = 1.22;

// Above this, a frame-to-frame camera move is a cut, not motion. The chase cam
// is critically damped and tracks a car that tops out at 112 u/s, so it never
// legitimately exceeds a few hundred units per second.
const CAMERA_CUT_SPEED = 900;

const STORE_KEY = 'microgauntlet.audio.v1';

/** How many rival engines are voiced at once, by quality tier. */
const ENGINE_VOICES = { low: 3, medium: 4, high: 5, ultra: 6 };

const DEFAULT_VOLUMES = {
  master: 0.8, music: 0.5, sfx: 0.9, engine: 0.85, ambience: 0.45, muted: false,
};

/**
 * Impulse-response character per circuit.
 *
 * `hfStart`/`hfEnd` are one-pole lowpass coefficients at the head and tail of
 * the decay: sweeping between them is what makes the reverb darken as it dies,
 * which is the single strongest cue for "this is a real room" versus "this is a
 * noise burst". `decay` is the exponent of the amplitude envelope over the
 * whole buffer, so seconds and decay together set RT60.
 */
export const ROOMS = {
  kitchen: {
    seconds: 1.15, decay: 4.6, hfStart: 0.60, hfEnd: 0.050, predelay: 0.008,
    early: 10, earlyGain: 0.60, earlySpread: 0.011, wet: 0.20, tone: 3200,
  },
  garden: {
    // Outdoors: barely any tail, but a fence and a house wall give two late slaps.
    seconds: 0.72, decay: 7.0, hfStart: 0.44, hfEnd: 0.022, predelay: 0.016,
    early: 4, earlyGain: 0.34, earlySpread: 0.024, wet: 0.12, tone: 2000,
  },
  workbench: {
    // A garage: boxy, dense early reflections off metal and shelving.
    seconds: 1.60, decay: 3.9, hfStart: 0.52, hfEnd: 0.034, predelay: 0.011,
    early: 14, earlyGain: 0.66, earlySpread: 0.009, wet: 0.25, tone: 2600,
  },
  pool: {
    // A long dark hall with a low ceiling and a lot of soft furnishing high up.
    seconds: 2.10, decay: 3.2, hfStart: 0.38, hfEnd: 0.018, predelay: 0.020,
    early: 8, earlyGain: 0.44, earlySpread: 0.017, wet: 0.26, tone: 1700,
  },
  bedroom: {
    // Carpet, curtains, a duvet. Almost anechoic, and that is the point.
    seconds: 0.52, decay: 8.0, hfStart: 0.32, hfEnd: 0.013, predelay: 0.006,
    early: 6, earlyGain: 0.36, earlySpread: 0.008, wet: 0.13, tone: 1400,
  },
  menu: {
    seconds: 1.35, decay: 4.2, hfStart: 0.55, hfEnd: 0.038, predelay: 0.010,
    early: 8, earlyGain: 0.48, earlySpread: 0.012, wet: 0.18, tone: 2800,
  },
};

const ROOM_FALLBACK = 'menu';

/* ====================================================================== DSP
 *
 * Shared synthesis primitives. Handed to the submodules on the Audio instance
 * as `audio.dsp` rather than imported by them, so audio/ has exactly one entry
 * point and no import cycle can form between these four files.
 * ========================================================================== */

export const DSP = {
  /**
   * Smooth a parameter towards a value. Every per-frame parameter write in this
   * subsystem goes through here: `setTargetAtTime` is the only automation curve
   * that is safe to re-issue every frame, because each new event starts from
   * the value the previous one had reached rather than from a stored target.
   */
  set(param, value, now, tau = 0.02) {
    if (!param) return;
    const v = Number.isFinite(value) ? value : 0;
    const cur = param.value;
    if (cur === v) return;
    // Below audibility, and re-issuing costs a timeline event — skip it.
    if (Math.abs(v - cur) < 1e-5) return;
    if (tau <= 0) param.setValueAtTime(v, now);
    else param.setTargetAtTime(v, now, tau);
  },

  /** Hard set with no ramp. Only for voice (re)allocation and note-off. */
  jump(param, value, now) {
    if (!param) return;
    const v = Number.isFinite(value) ? value : 0;
    param.cancelScheduledValues(now);
    param.setValueAtTime(v, now);
  },

  /** Looping white noise. One buffer is shared by every voice in the game. */
  noiseBuffer(ac, seconds, seed) {
    const n = Math.max(1, Math.floor(seconds * ac.sampleRate));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    const rng = makeRng(seed);
    // Match the loop point: the last 512 samples crossfade into the first, so
    // a two-second loop has no periodic tick.
    for (let i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
    const fade = Math.min(512, n >> 2);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[n - fade + i] * (1 - k);
    }
    return buf;
  },

  /**
   * Sparse decaying grains. Looped and pitch-shifted by wheel speed this is
   * what gravel, crumbs and sawdust actually sound like under a tyre — a rate
   * of discrete crunches rather than a filtered hiss.
   */
  grainBuffer(ac, seconds, seed, densityPerSec = 620) {
    const sr = ac.sampleRate;
    const n = Math.max(1, Math.floor(seconds * sr));
    const buf = ac.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const rng = makeRng(seed);
    const count = Math.max(1, Math.floor(seconds * densityPerSec));
    for (let g = 0; g < count; g++) {
      const at = Math.floor(rng.next() * n);
      const len = 4 + Math.floor(rng.next() * 26);
      const amp = 0.25 + rng.next() * 0.75;
      const decay = 1 / len;
      for (let i = 0; i < len; i++) {
        const j = at + i;
        if (j >= n) break;
        d[j] += (rng.next() * 2 - 1) * amp * Math.exp(-i * decay * 3.2);
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) { const k = 0.9 / peak; for (let i = 0; i < n; i++) d[i] *= k; }
    return buf;
  },

  /**
   * A band-limited pulse wave of arbitrary duty cycle. The chiptune lead lives
   * or dies on this: `a_h = (2/(h*pi)) * sin(h*pi*duty)` is the exact Fourier
   * series of a rectangle, so sweeping duty gives real PWM rather than a
   * crossfade between two static timbres.
   */
  pulseWave(ac, duty, harmonics = 48) {
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    const d = clamp(duty, 0.02, 0.98);
    for (let h = 1; h <= harmonics; h++) {
      imag[h] = (2 / (h * Math.PI)) * Math.sin(h * Math.PI * d);
    }
    return ac.createPeriodicWave(real, imag, { disableNormalization: false });
  },

  /**
   * Build a wave from an explicit harmonic amplitude table.
   * `phaseFn(h)` decides how impulsive the result is: coherent phases give a
   * spiky pulse train (an open exhaust), spread phases give a smooth drone.
   */
  harmonicWave(ac, amps, phaseFn) {
    const n = amps.length;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let h = 1; h < n; h++) {
      const a = amps[h];
      if (!(a > 0)) continue;
      const p = phaseFn ? phaseFn(h) : 0;
      real[h] = a * Math.cos(p);
      imag[h] = a * Math.sin(p);
    }
    return ac.createPeriodicWave(real, imag, { disableNormalization: false });
  },

  /**
   * tanh transfer curve. Unity for small signals, asymptotic to +/-1, so the
   * final stage can never produce a sample outside the DAC's range however
   * badly the mix is behaving.
   */
  tanhCurve(n = 2049, drive = 1) {
    const c = new Float32Array(n);
    // The curve is sampled across an input range of +/-3, so a signal that has
    // already gone 3x over full scale still maps inside the DAC's range.
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * 3;
      c[i] = Math.tanh(x * drive);
    }
    return c;
  },
};

/* ========================================================= impulse responses */

/**
 * Synthesise a stereo impulse response.
 *
 * Exponentially decaying noise through a one-pole lowpass whose coefficient
 * sweeps from `hfStart` down to `hfEnd` across the tail, plus a jittered set of
 * discrete early reflections at the head. The two channels run independent
 * noise streams and independent tap times, which is what makes the tail wide
 * instead of a mono blob pinned in the middle of the image.
 */
export function makeImpulseResponse(ac, room, seed = 1) {
  const sr = ac.sampleRate;
  const tail = Math.max(64, Math.ceil(room.seconds * sr));
  const pre = Math.max(0, Math.floor((room.predelay || 0) * sr));
  const len = tail + pre + 8;
  const buf = ac.createBuffer(2, len, sr);
  const ratio = Math.max(1e-4, room.hfEnd / room.hfStart);
  const build = 1 / (sr * 0.0035);   // ~3.5 ms of diffusion ramp-in

  for (let c = 0; c < 2; c++) {
    const rng = makeRng((seed * 7919) ^ (c * 104729) ^ 0x5f3a);
    const d = buf.getChannelData(c);
    let lp = 0;
    let lp2 = 0;
    let dc = 0;
    for (let i = 0; i < tail; i++) {
      const t = i / tail;
      const a = room.hfStart * Math.pow(ratio, t);
      const w = rng.next() * 2 - 1;
      lp += a * (w - lp);
      lp2 += a * (lp - lp2);
      dc += 0.0009 * (lp2 - dc);           // kills the sub-20 Hz wander
      const env = Math.exp(-room.decay * t) * (1 - Math.exp(-i * build));
      d[pre + i] = (lp2 - dc) * env;
    }
    // Early reflections. Alternating sign keeps them from summing into a
    // single fat pre-echo that reads as a delay rather than as a room.
    let at = 0.0035;
    for (let k = 0; k < room.early; k++) {
      at += 0.0025 + rng.next() * room.earlySpread;
      const idx = pre + Math.floor(at * sr);
      if (idx >= len) break;
      const amp = room.earlyGain * Math.pow(0.80, k) * (0.7 + rng.next() * 0.6);
      d[idx] += rng.next() < 0.5 ? -amp : amp;
    }
  }
  return buf;
}

/* ================================================================== the system */

export class Audio {
  name = 'audio';

  constructor(ctx) {
    this.ctx = ctx || {};
    this.settings = this.ctx.settings || null;

    /** The AudioContext. Named `ac` throughout so it never shadows the game ctx. */
    this.ac = null;
    this.ready = false;
    this.unlocked = false;
    this.failed = false;
    // Has a REAL person touched the page yet? Not the same question as "is the
    // AudioContext running" — see unlock().
    this._gestured = false;
    this.theme = 'menu';
    this.dsp = DSP;

    this.volumes = { ...DEFAULT_VOLUMES };
    this.buses = null;
    this.sends = null;

    this.engineSound = null;
    this.sfx = null;
    this.music = null;

    this.maxEngineVoices = 5;
    this.maxVoices = 24;
    this.doppler = true;
    this.hrtf = true;

    /** Listener state, recomputed every frame and handed to the submodules. */
    this.listener = {
      x: 0, y: 60, z: 0,
      vx: 0, vy: 0, vz: 0,
      fx: 0, fy: 0, fz: -1,
      ux: 0, uy: 1, uz: 0,
      valid: false,
    };

    /**
     * Who is close enough to be worth voicing, nearest first. Computed once per
     * frame here so EngineSound and Sfx agree about the field and neither has
     * to sort it again.
     */
    this.audible = { player: null, rivals: new Array(16).fill(null), dists: new Float64Array(16), count: 0 };

    this._prevCam = { x: 0, y: 0, z: 0, has: false };
    this._unsubs = [];
    this._gestureOff = null;
    this._irCache = new Map();
    this._resumeTries = 0;
    this._intensity = 0;
    this._finalLapFired = false;
    this._flagPlayed = false;
    this._musicState = 'menu';
    this._stateTimer = 0;
  }

  /* ------------------------------------------------------------------ boot */

  async init() {
    this._readStoredVolumes();

    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) {
      this.failed = true;
      console.warn('[Audio] WebAudio is unavailable — the game will run silent.');
      return this;
    }

    try {
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      this.failed = true;
      console.warn('[Audio] could not create an AudioContext', err);
      return this;
    }

    this._resolveQuality();
    this._buildGraph();

    // The room the game boots into. Track is built before audio in main.js, so
    // by now the theme is known; if it is not, the menu room is a fair guess.
    const theme = this.ctx?.track?.theme || this.ctx?.params?.get?.('track') || 'menu';
    this.setTheme(theme);

    try {
      this.engineSound = new EngineSound(this);
      this.engineSound.init();
    } catch (err) { console.warn('[Audio] EngineSound failed to start', err); this.engineSound = null; }
    try {
      this.sfx = new Sfx(this);
      this.sfx.init();
    } catch (err) { console.warn('[Audio] Sfx failed to start', err); this.sfx = null; }
    try {
      this.music = new Music(this);
      this.music.init();
      this.music.setTheme(theme);
    } catch (err) { console.warn('[Audio] Music failed to start', err); this.music = null; }
    // setTheme() ran before the submodules existed, so hand them the room now.
    this.sfx?.setTheme?.(this.theme);

    this._bindBus();
    this._installGesture();
    this._installVisibility();

    this.ready = true;
    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.audio = this;
    }
    return this;
  }

  /** True when the graph exists, is unlocked, and the clock is actually moving. */
  get running() {
    return !!(this.ready && this.unlocked && this.ac && this.ac.state === 'running');
  }

  get now() { return this.ac ? this.ac.currentTime : 0; }

  /* ---------------------------------------------------------------- graph */

  _buildGraph() {
    const ac = this.ac;

    // Final stage first, so everything downstream exists before it is wired to.
    this.master = ac.createGain();
    this.master.gain.value = this.volumes.muted ? 0 : this.volumes.master;
    this.master.connect(ac.destination);

    // Belt and braces. The compressor does the musical work; the shaper is the
    // guarantee — a tanh curve simply cannot emit a sample outside +/-1.
    this.clip = ac.createWaveShaper();
    this.clip.curve = DSP.tanhCurve(2049, 1);
    this.clip.oversample = '4x';
    this.clip.connect(this.master);

    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -7;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.16;
    this.limiter.connect(this.clip);

    this.sum = ac.createGain();
    this.sum.gain.value = 1;
    this.sum.connect(this.limiter);

    // Reverb return. One convolver serves every bus; the sends decide how much
    // of each lands in the room.
    this.convolver = ac.createConvolver();
    this.convolver.normalize = true;
    this.reverbTone = ac.createBiquadFilter();
    this.reverbTone.type = 'lowpass';
    this.reverbTone.frequency.value = 2600;
    this.reverbTone.Q.value = 0.6;
    this.reverbHigh = ac.createBiquadFilter();
    this.reverbHigh.type = 'highpass';
    this.reverbHigh.frequency.value = 180;   // keeps the tail out of the bass
    this.reverbReturn = ac.createGain();
    this.reverbReturn.gain.value = 0.2;
    this.convolver.connect(this.reverbTone);
    this.reverbTone.connect(this.reverbHigh);
    this.reverbHigh.connect(this.reverbReturn);
    this.reverbReturn.connect(this.sum);

    const mkBus = (vol, sendAmount) => {
      const g = ac.createGain();
      g.gain.value = vol;
      g.connect(this.sum);
      const s = ac.createGain();
      s.gain.value = sendAmount;
      g.connect(s);
      s.connect(this.convolver);
      return { g, s };
    };

    // Music is ducked as a whole so stingers, the klaxon and big shunts can cut
    // through without the player reaching for the mixer.
    this.musicDuck = ac.createGain();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.sum);
    const musicSend = ac.createGain();
    musicSend.gain.value = 0.10;
    this.musicDuck.connect(musicSend);
    musicSend.connect(this.convolver);

    const musicBus = ac.createGain();
    musicBus.gain.value = this.volumes.music;
    musicBus.connect(this.musicDuck);

    const sfxB = mkBus(this.volumes.sfx, 0.30);
    const engB = mkBus(this.volumes.engine, 0.22);
    const ambB = mkBus(this.volumes.ambience, 0.16);

    this.buses = { music: musicBus, sfx: sfxB.g, engine: engB.g, ambience: ambB.g };
    this.sends = { music: musicSend, sfx: sfxB.s, engine: engB.s, ambience: ambB.s };

    // Shared source material. Every noise voice in the game reads one of these
    // two buffers at a different offset — no per-voice allocation, ever.
    this.noise = DSP.noiseBuffer(ac, 2.5, 0x51DE);
    this.grain = DSP.grainBuffer(ac, 2.0, 0x6A17);
  }

  /* ----------------------------------------------------------------- rooms */

  /**
   * Swap the convolution room. Impulse responses are cached per theme because
   * regenerating a two-second stereo IR is a few million operations.
   */
  setTheme(theme) {
    const key = ROOMS[theme] ? theme : ROOM_FALLBACK;
    this.theme = key;
    if (!this.ac || !this.convolver) return this;
    const room = ROOMS[key];
    let ir = this._irCache.get(key);
    if (!ir) {
      try {
        ir = makeImpulseResponse(this.ac, room, hashTheme(key));
        this._irCache.set(key, ir);
      } catch (err) {
        console.warn('[Audio] impulse response generation failed for', key, err);
        return this;
      }
    }
    this.convolver.buffer = ir;
    const now = this.now;
    DSP.set(this.reverbReturn.gain, room.wet, now, 0.12);
    DSP.set(this.reverbTone.frequency, room.tone, now, 0.12);
    this.music?.setTheme?.(key);
    this.sfx?.setTheme?.(key);
    return this;
  }

  /** True when the browser gave us a working graph. */
  get available() { return !!(this.ready && this.ac && !this.failed); }

  /* ---------------------------------------------------------------- unlock */

  /**
   * Open the graph. Safe to call any number of times, from any gesture.
   * Returns a promise, but callers are not expected to await it.
   *
   * REQUIRES A REAL GESTURE. This used to open the graph whenever it found the
   * AudioContext already running, on the reasonable-sounding assumption that a
   * running context means the browser has already been satisfied that a person
   * is present. That assumption is false in the one place it matters: an
   * itch.io embed carries allow="autoplay", so the context is running from the
   * first millisecond and the browser's own gate — the thing that was actually
   * doing this job — is gone. The result is a page that starts playing at a
   * stranger the moment it finishes loading.
   *
   * So the gate lives here now, where it does not depend on the embedder.
   * `opts.force` is for tooling that has already pinned the master gain to 0.
   */
  unlock(opts = {}) {
    if (this.failed || !this.ac) return Promise.resolve(false);
    if (!this._gestured && !opts.force) return Promise.resolve(false);
    this.unlocked = true;
    this._resumeTries = 0;   // every gesture gets a fresh retry window
    if (this.ac.state === 'running') {
      this._afterUnlock();
      return Promise.resolve(true);
    }
    let p;
    try { p = this.ac.resume(); } catch (_) { p = null; }
    return Promise.resolve(p)
      .then(() => {
        if (this.ac.state === 'running') this._afterUnlock();
        return this.ac.state === 'running';
      })
      .catch(() => false);
  }

  _afterUnlock() {
    if (this._gestureOff) { this._gestureOff(); this._gestureOff = null; }
    if (this._started) return;
    this._started = true;
    try { this.sfx?.start?.(); } catch (err) { console.warn('[Audio] sfx start', err); }
    try { this.music?.start?.(); } catch (err) { console.warn('[Audio] music start', err); }
  }

  _installGesture() {
    if (typeof window === 'undefined') return;
    const types = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
    // isTrusted keeps a synthetic event — a tool driving the page, a script on
    // the embedding site — from counting as somebody deciding to play.
    const handler = (ev) => {
      if (ev && ev.isTrusted === false) return;
      this._gestured = true;
      this.unlock();
    };
    for (const t of types) window.addEventListener(t, handler, { capture: true, passive: true });
    this._gestureOff = () => {
      for (const t of types) window.removeEventListener(t, handler, { capture: true });
    };
  }

  _installVisibility() {
    if (typeof document === 'undefined') return;
    this._onVis = () => {
      if (!this.ac || !this.unlocked) return;
      if (document.hidden) { try { this.ac.suspend(); } catch (_) { /* ignore */ } }
      else { try { this.ac.resume(); } catch (_) { /* ignore */ } }
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  /* --------------------------------------------------------------- volumes */

  _resolveQuality() {
    const s = this.settings;
    const tier = s?.quality || 'high';
    this.maxEngineVoices = ENGINE_VOICES[tier] ?? 5;
    this.maxVoices = clamp(s?.audio?.maxVoices ?? 24, 4, 64);
    this.doppler = s?.audio?.doppler !== false;
    this.hrtf = s?.audio?.hrtf !== false;
  }

  _readStoredVolumes() {
    const a = this.settings?.audio;
    if (a && typeof a.master === 'number') {
      this.volumes = {
        master: clamp(a.master, 0, 1),
        music: clamp(a.music ?? DEFAULT_VOLUMES.music, 0, 1),
        sfx: clamp(a.sfx ?? DEFAULT_VOLUMES.sfx, 0, 1),
        engine: clamp(a.engine ?? DEFAULT_VOLUMES.engine, 0, 1),
        ambience: clamp(a.ambience ?? DEFAULT_VOLUMES.ambience, 0, 1),
        muted: !!a.muted,
      };
      return;
    }
    // Settings is a stub or has never been saved — fall back to our own store.
    try {
      const raw = globalThis.localStorage?.getItem(STORE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object') {
          for (const k of ['master', 'music', 'sfx', 'engine', 'ambience']) {
            if (typeof v[k] === 'number') this.volumes[k] = clamp(v[k], 0, 1);
          }
          this.volumes.muted = !!v.muted;
        }
      }
    } catch (_) { /* private browsing, or no storage at all */ }
  }

  _persistVolumes() {
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(this.volumes));
    } catch (_) { /* ignore */ }
    const s = this.settings;
    if (s?.audio) {
      s.audio.master = this.volumes.master;
      s.audio.music = this.volumes.music;
      s.audio.sfx = this.volumes.sfx;
      s.audio.engine = this.volumes.engine;
      s.audio.ambience = this.volumes.ambience;
      s.audio.muted = this.volumes.muted;
      try { s.save?.(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Apply a set of bus levels. Called by Settings.apply() on every settings
   * change, so it must never write back to Settings or the two would recurse.
   */
  setVolumes(v = {}) {
    for (const k of ['master', 'music', 'sfx', 'engine', 'ambience']) {
      if (typeof v[k] === 'number') this.volumes[k] = clamp(v[k], 0, 1);
    }
    if (typeof v.muted === 'boolean') this.volumes.muted = v.muted;
    this._pushVolumes();
    return this;
  }

  /** Set one bus and remember it. This is the path the options menu wants. */
  setVolume(bus, value, { persist = true } = {}) {
    if (bus === 'muted') this.volumes.muted = !!value;
    else if (bus in this.volumes) this.volumes[bus] = clamp(value, 0, 1);
    else return this;
    this._pushVolumes();
    if (persist) this._persistVolumes();
    return this;
  }

  toggleMute() { return this.setVolume('muted', !this.volumes.muted); }

  _pushVolumes() {
    if (!this.ac || !this.buses) return;
    const now = this.now;
    const v = this.volumes;
    DSP.set(this.master.gain, v.muted ? 0 : v.master, now, 0.03);
    DSP.set(this.buses.music.gain, v.music, now, 0.05);
    DSP.set(this.buses.sfx.gain, v.sfx, now, 0.03);
    DSP.set(this.buses.engine.gain, v.engine, now, 0.03);
    DSP.set(this.buses.ambience.gain, v.ambience, now, 0.2);
  }

  applySettings(settings) {
    if (settings) this.settings = settings;
    this._resolveQuality();
    this.engineSound?.applySettings?.(this.settings);
    this.sfx?.applySettings?.(this.settings);
    this.music?.applySettings?.(this.settings);
    return this;
  }

  /**
   * Duck the music bus. Used by the start klaxon, the chequered flag and any
   * impact hard enough to matter.
   * @param {number} amount 0..1, how far down
   * @param {number} hold seconds at the bottom before it comes back
   */
  duck(amount = 0.45, hold = 0.25) {
    if (!this.running || !this.musicDuck) return this;
    const now = this.now;
    const g = this.musicDuck.gain;
    const to = clamp(1 - amount, 0.05, 1);
    g.cancelScheduledValues(now);
    g.setTargetAtTime(to, now, 0.02);
    g.setTargetAtTime(1, now + Math.max(0.02, hold), 0.22);
    return this;
  }

  /* ----------------------------------------------------------------- frame */

  update(dt, ctx) {
    if (ctx) this.ctx = ctx;
    if (!this.ready || this.failed) return;

    // Nothing may touch the timeline before the first gesture: the clock is
    // frozen and every scheduled event would pile up on the same instant.
    if (!this.running) {
      if (this.unlocked && this.ac.state === 'suspended' && this._resumeTries < 240) {
        this._resumeTries++;
        try { this.ac.resume(); } catch (_) { /* ignore */ }
      }
      return;
    }

    const d = clamp(dt || 0, 0, 0.1);
    this._updateListener(d);
    this._selectAudible();
    this._updateRaceMood(d);

    try { this.engineSound?.update(d, this.listener); } catch (err) { this._moduleError('EngineSound', err); }
    try { this.sfx?.update(d, this.listener); } catch (err) { this._moduleError('Sfx', err); }
    try { this.music?.update(d); } catch (err) { this._moduleError('Music', err); }
  }

  _moduleError(name, err) {
    this._errors = this._errors || {};
    if (this._errors[name]) return;
    this._errors[name] = true;
    console.warn(`[Audio] ${name} threw and has been reported once`, err);
  }

  /**
   * Place the ears. The camera is the listener; its velocity is differenced
   * rather than read from anywhere, because the director's motion is a damped
   * follow and has no published velocity.
   */
  _updateListener(dt) {
    const cam = this.ctx?.camera;
    const L = this.listener;
    if (!cam) { L.valid = false; return; }
    try { cam.updateMatrixWorld(); } catch (_) { /* a stub camera */ }
    const e = cam.matrixWorld?.elements;
    if (!e) { L.valid = false; return; }

    const x = e[12], y = e[13], z = e[14];
    if (this._prevCam.has && dt > 1e-4) {
      const dx = x - this._prevCam.x, dy = y - this._prevCam.y, dz = z - this._prevCam.z;
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
      if (step > CAMERA_CUT_SPEED) {
        // The director cut, or the player respawned. A jump differenced into a
        // velocity is thousands of units per second and pitches every rival
        // engine to the doppler clamp for half a second — a whoop on every cut
        // is a classic amateur tell. Treat it as a teleport, not as motion.
        L.vx = 0; L.vy = 0; L.vz = 0;
      } else {
        const k = saturate(dt * 8);
        L.vx += ((dx / dt) - L.vx) * k;
        L.vy += ((dy / dt) - L.vy) * k;
        L.vz += ((dz / dt) - L.vz) * k;
      }
    }
    this._prevCam.x = x; this._prevCam.y = y; this._prevCam.z = z;
    this._prevCam.has = true;

    L.x = x; L.y = y; L.z = z;
    L.fx = -e[8]; L.fy = -e[9]; L.fz = -e[10];
    L.ux = e[4]; L.uy = e[5]; L.uz = e[6];
    L.valid = true;

    const lis = this.ac.listener;
    const now = this.now;
    if (lis.positionX) {
      DSP.set(lis.positionX, x, now, 0.02);
      DSP.set(lis.positionY, y, now, 0.02);
      DSP.set(lis.positionZ, z, now, 0.02);
      DSP.set(lis.forwardX, L.fx, now, 0.03);
      DSP.set(lis.forwardY, L.fy, now, 0.03);
      DSP.set(lis.forwardZ, L.fz, now, 0.03);
      DSP.set(lis.upX, L.ux, now, 0.03);
      DSP.set(lis.upY, L.uy, now, 0.03);
      DSP.set(lis.upZ, L.uz, now, 0.03);
    } else if (lis.setPosition) {
      lis.setPosition(x, y, z);
      lis.setOrientation(L.fx, L.fy, L.fz, L.ux, L.uy, L.uz);
    }
  }

  /**
   * Doppler multiplier for a source. Positive radial velocity = closing.
   * @param {{x:number,y:number,z:number}} pos world position of the source
   * @param {{x:number,y:number,z:number}} vel world velocity of the source
   */
  dopplerFor(pos, vel) {
    const L = this.listener;
    if (!this.doppler || !L.valid) return 1;
    let dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-3) return 1;
    dx /= dist; dy /= dist; dz /= dist;
    // Component of each velocity along the line from listener to source.
    const vs = vel ? (vel.x * dx + vel.y * dy + vel.z * dz) : 0;
    const vl = L.vx * dx + L.vy * dy + L.vz * dz;
    const f = (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND + vs);
    return clamp(f, DOPPLER_MIN, DOPPLER_MAX);
  }

  /**
   * Rank the field by distance and keep the nearest few.
   *
   * Insertion into a fixed-size array rather than a sort of the whole field:
   * we only ever want the top six of eight, it never allocates, and it runs
   * once for both the engines and the tyres.
   */
  _selectAudible() {
    const a = this.audible;
    a.player = this.ctx?.player || null;
    a.count = 0;
    const vehicles = this.ctx?.vehicles;
    if (!Array.isArray(vehicles)) return;
    const cap = Math.min(a.rivals.length, Math.max(1, this.maxEngineVoices));
    const cull = 1100 * 1100;

    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v || v === a.player || !v.position) continue;
      if (v.group && v.group.visible === false) continue;
      const d = this.distanceSq(v.position);
      if (d > cull) continue;
      if (a.count < cap) {
        let j = a.count++;
        while (j > 0 && a.dists[j - 1] > d) { a.dists[j] = a.dists[j - 1]; a.rivals[j] = a.rivals[j - 1]; j--; }
        a.dists[j] = d;
        a.rivals[j] = v;
      } else if (d < a.dists[cap - 1]) {
        let j = cap - 1;
        while (j > 0 && a.dists[j - 1] > d) { a.dists[j] = a.dists[j - 1]; a.rivals[j] = a.rivals[j - 1]; j--; }
        a.dists[j] = d;
        a.rivals[j] = v;
      }
    }
    for (let i = a.count; i < a.rivals.length; i++) a.rivals[i] = null;
  }

  /** Squared distance from the listener — used everywhere for voice priority. */
  distanceSq(pos) {
    const L = this.listener;
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * A PannerNode configured for our scale. Rival engines, rival tyres and
   * anything that happens at a point in the world goes through one of these.
   */
  makePanner() {
    const ac = this.ac;
    const p = ac.createPanner();
    p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    // refDistance is about three car lengths: inside that the source is at full
    // level, which is where the player's own car and a side-by-side rival sit.
    p.refDistance = 26;
    p.maxDistance = 1400;
    p.rolloffFactor = 1.15;
    p.coneInnerAngle = 360;
    p.coneOuterAngle = 360;
    p.coneOuterGain = 1;
    return p;
  }

  /** Move a panner, using AudioParams where the browser has them. */
  setPannerPosition(p, x, y, z, now, tau = 0.03) {
    if (!p) return;
    if (p.positionX) {
      DSP.set(p.positionX, x, now, tau);
      DSP.set(p.positionY, y, now, tau);
      DSP.set(p.positionZ, z, now, tau);
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
  }

  /* ------------------------------------------------------------- race mood */

  /**
   * Derive the music intensity from what is actually happening in the race:
   * how close the fight is, how fast the player is going, and whether this is
   * the last lap. Nothing else in the game knows or cares about this number.
   */
  _updateRaceMood(dt) {
    const race = this.ctx?.race;
    const player = this.ctx?.player;
    let target = 0.25;

    if (race && player) {
      const state = race.state;
      if (state === 'racing' || state === 'finished') {
        const entry = this._playerEntry(race);
        const gapAhead = Math.abs(entry?.gapToAhead ?? 9);
        const speedN = saturate((player.speed || 0) / Math.max(20, player.topSpeed || 100));
        // A fight is a gap under a second and a half, either way.
        const fight = saturate(1 - gapAhead / 1.8);
        const lapN = race.totalLaps > 0 ? saturate((entry?.lap ?? 0) / race.totalLaps) : 0;
        target = 0.34 + fight * 0.34 + speedN * 0.18 + lapN * 0.14;
        if (this._finalLapFired) target = Math.min(1, target + 0.12);
      } else if (state === 'countdown' || state === 'grid') {
        target = 0.2;
      } else if (state === 'results') {
        target = 0.3;
      }
    }

    this._intensity += (saturate(target) - this._intensity) * saturate(dt * 0.9);
    this.music?.setIntensity?.(this._intensity);
  }

  /** The player's race entry, resolved once and cached — this runs every frame. */
  _playerEntry(race) {
    const list = race?.entries;
    if (!Array.isArray(list)) return null;
    if (this._cachedEntry && list.indexOf(this._cachedEntry) >= 0) return this._cachedEntry;
    this._cachedEntry = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.isPlayer) { this._cachedEntry = list[i]; break; }
    }
    return this._cachedEntry;
  }

  /* --------------------------------------------------------------- events */

  _bindBus() {
    const bus = this.ctx?.bus;
    if (!bus?.on) return;
    const on = (type, fn) => {
      try {
        const off = bus.on(type, (payload) => {
          if (!this.ready || this.failed) return;
          try { fn(payload); } catch (err) { this._moduleError(`event:${type}`, err); }
        }, { scope: this });
        if (typeof off === 'function') this._unsubs.push(off);
      } catch (_) { /* a stub bus */ }
    };

    /* --- race flow ----------------------------------------------------- */

    on('race:state', (p) => {
      const map = {
        attract: 'menu', grid: 'grid', countdown: 'countdown',
        racing: 'race', finished: 'race', results: 'results',
      };
      const next = map[p?.to] || 'menu';
      if (p?.to === 'grid' || p?.to === 'attract') {
        this._finalLapFired = false;
        this._flagPlayed = false;
        if (this.music) this.music._tension = 0;
      }
      this._musicState = next;
      this.music?.setState?.(next);
      // The ambience air band is ducked outside the race. On a menu or a
      // results table there is no engine to mask it, so the same hiss that
      // sits under a race reads as a fault in the build.
      this.sfx?.setMenu?.(next === 'menu' || next === 'results');
    });

    on('race:countdown', (p) => {
      if (!this.running) return;
      if (p?.value > 0) this.sfx?.countdown?.(p.value);
    });

    on('race:start', () => {
      if (!this.running) return;
      this.sfx?.klaxon?.();
      this.duck(0.5, 0.45);
      this.music?.setState?.('race');
    });

    on('race:lap', (p) => {
      if (!this.running || !p?.isPlayer) return;
      this.sfx?.lapChime?.(!!p.personalBest || !!p.raceBest);
    });

    on('race:finalLap', (p) => {
      if (!p?.isPlayer && !p?.leader) return;
      if (this._finalLapFired) return;
      this._finalLapFired = true;
      this.music?.finalLap?.();
      if (this.running && p?.isPlayer) this.sfx?.play?.('race.whiteFlag');
    });

    on('race:position', (p) => {
      if (!this.running || !p?.isPlayer) return;
      const gained = (p.gained | 0);
      if (gained > 0) this.sfx?.positionStinger?.(1);
      else if (gained < 0) this.sfx?.positionStinger?.(-1);
    });

    on('race:record', () => { if (this.running) this.sfx?.play?.('race.record'); });

    // Race emits BOTH 'race:carFinished' and 'race:chequered' for the player at
    // the same instant, and either can be the one that arrives (a player who is
    // eliminated never gets carFinished). One flag, one fanfare.
    const flag = (position) => {
      if (this._flagPlayed || !this.running) return;
      this._flagPlayed = true;
      this.sfx?.fanfare?.(position | 0);
      this.duck(0.55, 1.1);
    };
    on('race:carFinished', (p) => { if (p?.isPlayer) flag(p.position); });
    on('race:chequered', (p) => flag(p?.position ?? 1));

    on('race:eliminated', (p) => {
      if (!this.running || !p?.isPlayer) return;
      this.sfx?.positionStinger?.(-1);
      this.duck(0.3, 0.5);
    });

    on('race:finish', () => { this.music?.setState?.('results'); });

    on('race:wrongway', (p) => {
      if (!p?.isPlayer) return;
      this.sfx?.setWrongWay?.(!!p.on);
    });

    on('race:pause', (p) => {
      if (!this.ac) return;
      const now = this.now;
      DSP.set(this.sum.gain, p?.paused ? 0.25 : 1, now, 0.08);
      this.music?.setPaused?.(!!p?.paused);
    });

    /* --- vehicles ------------------------------------------------------ */

    on('vehicle:shift', (p) => {
      if (!this.running || !p?.vehicle) return;
      this.engineSound?.onShift?.(p.vehicle, !!p.up);
      this.sfx?.shift?.(p.vehicle, !!p.up);
    });

    on('vehicle:land', (p) => {
      if (!this.running || !p?.vehicle) return;
      this.sfx?.land?.(p.vehicle, p.airTime || 0, p.speed || 0);
    });

    on('vehicle:respawn', (p) => {
      if (!this.running || !p?.vehicle) return;
      this.sfx?.respawn?.(p.vehicle);
    });

    on('vehicle:impact', (p) => {
      if (!this.running || !p?.vehicle) return;
      this.sfx?.vehicleImpact?.(p);
    });

    /* --- physics ------------------------------------------------------- */

    // The contact event object is pooled and reused by physics/World.js, so
    // Sfx copies out of it synchronously and never keeps the reference.
    on('physics:contact', (ev) => { if (this.running) this.sfx?.contact?.(ev); });
    on('physics:scrape', (ev) => { if (this.running) this.sfx?.scrape?.(ev); });

    /* --- track / settings ---------------------------------------------- */

    on('track:changed', (p) => { if (p?.theme) this.setTheme(p.theme); });
    on('quality:changed', () => this._resolveQuality());
  }

  /* -------------------------------------------------------------- shorthand */

  /**
   * Fire a named one-shot. This is the generic entry point every other system
   * uses so nothing outside audio/ has to know how a sound is built.
   */
  play(id, opts) {
    if (!this.running || !this.sfx) return null;
    try { return this.sfx.play(id, opts); }
    catch (err) { this._moduleError('Sfx.play', err); return null; }
  }

  /** Front-end blips. Menu.js and Results.js call this directly. */
  ui(kind) {
    if (!this.ready) return this;
    // A menu click is very often the gesture that unlocks the graph, and the
    // resume is asynchronous — so unlock first, then play on the next frame.
    if (!this.running) { this.unlock().then(() => this.sfx?.ui?.(kind)); return this; }
    try { this.sfx?.ui?.(kind); } catch (err) { this._moduleError('Sfx.ui', err); }
    return this;
  }

  setMusicEnabled(on) { this.music?.setEnabled?.(!!on); return this; }

  stats() {
    return {
      state: this.ac?.state ?? 'none',
      unlocked: this.unlocked,
      theme: this.theme,
      sampleRate: this.ac?.sampleRate ?? 0,
      volumes: { ...this.volumes },
      engineVoices: this.engineSound?.activeCount ?? 0,
      sfxVoices: this.sfx?.activeCount ?? 0,
      intensity: +this._intensity.toFixed(2),
      musicState: this._musicState,
      limiterReduction: +(this.limiter?.reduction ?? 0).toFixed(2),
    };
  }

  onResize() { return this; }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch (_) { /* ignore */ } }
    this._unsubs.length = 0;
    if (this._gestureOff) { this._gestureOff(); this._gestureOff = null; }
    if (this._onVis && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVis);
      this._onVis = null;
    }
    try { this.music?.dispose?.(); } catch (_) { /* ignore */ }
    try { this.sfx?.dispose?.(); } catch (_) { /* ignore */ }
    try { this.engineSound?.dispose?.(); } catch (_) { /* ignore */ }
    this._irCache.clear();
    try { this.ac?.close?.(); } catch (_) { /* ignore */ }
    this.ready = false;
    this.ac = null;
    return this;
  }
}

/** Stable seed from a theme name so a circuit's room is identical every run. */
function hashTheme(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

export default Audio;
