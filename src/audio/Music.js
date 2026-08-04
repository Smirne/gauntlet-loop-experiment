// audio/Music.js — the generative score.
//
// Chiptune soul, modern mix. The voices are the four an NES had — two pulse
// channels, a bass, and noise for percussion — because that constraint is what
// makes the writing sound like a racing game from 1993. Everything around them
// is not: a detuned three-oscillator saw bass, a resonant filter envelope on
// every bass note, a real delay send with damped repeats, bus compression, and
// the kick sidechaining the tonal layers. Retro design language, current
// production.
//
// WHY IT DOES NOT GET BORING
//
// A generative score that picks random notes is unlistenable inside ninety
// seconds; a fixed loop is unlistenable inside five minutes. So this composes
// exactly once per circuit, from that circuit's own seed:
//
//   * a MOTIF — a one-bar rhythm mask and a contour of scale-degree offsets,
//     generated with beat-weighted onset probabilities so it lands where a
//     human would put notes;
//   * a four-bar chord progression, fixed per circuit;
//   * a bass pattern, one of a small hand-written set.
//
// and then plays that motif *through* the harmony: the contour is offset by the
// current chord's scale degree, so the same recognisable shape comes back over
// each chord sounding different every time. Bars 4, 8 and 16 of a phrase get
// ornaments, octave displacement and a fill. That is how a chip composer wrote
// four minutes of music out of eight bars, and it is why you can loop it.
//
// SCHEDULING
//
// Nothing is fired from the frame loop. update() runs a 180 ms lookahead
// scheduler that writes note events onto the audio clock, which is the only way
// to get a groove that does not wobble with the frame rate. Swing is applied as
// a delay on odd sixteenths at schedule time, so it never accumulates.

import { makeRng, clamp, saturate } from '../core/Random.js';

/* ================================================================== theory */

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/**
 * One score per circuit. Key and tempo are chosen against the *place*: the
 * kitchen is bright and fast, the pool hall is slow and smoky in harmonic
 * minor, the workbench is phrygian and industrial, the bedroom is lydian
 * because a lydian #4 is the sound of a toy.
 */
export const CIRCUIT_SCORES = {
  kitchen: {
    label: 'BREAKFAST RUSH', root: 57, scale: 'minor', bpm: 152,
    prog: [0, 5, 3, 4], swing: 0.11, seed: 1337, leadDuty: 0.30, bassPattern: 0,
  },
  garden: {
    label: 'GREENHOUSE GP', root: 52, scale: 'dorian', bpm: 140,
    prog: [0, 3, 5, 4], swing: 0.15, seed: 20771, leadDuty: 0.42, bassPattern: 1,
  },
  workbench: {
    label: 'SHOP FLOOR', root: 54, scale: 'phrygian', bpm: 166,
    prog: [0, 1, 0, 6], swing: 0.03, seed: 88123, leadDuty: 0.18, bassPattern: 2,
  },
  pool: {
    label: 'FELT SPEEDWAY', root: 48, scale: 'harmonicMinor', bpm: 128,
    prog: [0, 5, 1, 4], swing: 0.19, seed: 40615, leadDuty: 0.24, bassPattern: 1,
  },
  bedroom: {
    label: 'CARPET CHAOS', root: 50, scale: 'lydian', bpm: 146,
    prog: [0, 4, 5, 3], swing: 0.08, seed: 61207, leadDuty: 0.36, bassPattern: 0,
  },
  menu: {
    label: 'ATTRACT', root: 55, scale: 'minor', bpm: 116,
    prog: [0, 5, 3, 4], swing: 0.13, seed: 7771, leadDuty: 0.46, bassPattern: 1,
  },
};

/** Semitone offsets from the chord root, played on eighths. */
const BASS_PATTERNS = [
  [0, 0, 0, 12, 0, 0, 7, 0],
  [0, 0, 12, 0, 0, 7, 0, -5],
  [0, 12, 0, 7, 0, 12, 3, 7],
];

/**
 * Onset probability per sixteenth of a bar. Downbeats are near-certain, the
 * "and" of each beat is likely, the sixteenths between are sparse — which is
 * the difference between a melody and a sequencer accident.
 */
const ONSET_W = [
  1.00, 0.10, 0.44, 0.20,
  0.80, 0.12, 0.40, 0.24,
  0.92, 0.10, 0.46, 0.18,
  0.72, 0.30, 0.52, 0.34,
];

const LOOKAHEAD = 0.18;
const STEPS_PER_BAR = 16;

function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** Scale degree (may be negative or past an octave) to a MIDI note. */
function degToMidi(scale, root, deg) {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return root + scale[idx] + oct * 12;
}

/* ================================================================== the score */

export class Music {
  constructor(audio) {
    this.audio = audio;
    this.ac = audio.ac;
    this.enabled = true;
    this.playing = false;
    this.paused = false;

    this.theme = 'menu';
    this.score = CIRCUIT_SCORES.menu;
    this.scale = SCALES.minor;
    this.bpm = 116;
    this.stepDur = 60 / this.bpm / 4;
    this.swing = 0.12;

    this.state = 'menu';
    this._wantState = 'menu';
    this.intensity = 0.3;
    this._tension = 0;
    this._riserAt = -1;

    this._step = 0;
    this._nextTime = 0;
    this._pwmPhase = 0;
    this._pwmIndex = -1;
    this._padChord = -1;

    this.motif = null;
    this.wanted = false;
    this.rng = makeRng(7771);

    // Percussion is per-hit, so it gets the same fixed ring the Sfx module
    // uses: sweep by end time, never rely on onended.
    this._perc = [];
    for (let i = 0; i < 56; i++) this._perc.push({ end: -1, n: [] });
    this._percCursor = 0;
  }

  get running() {
    return !!(this.enabled && this.audio.running && this.ac);
  }

  /* ------------------------------------------------------------------ build */

  init() {
    const ac = this.ac;
    if (!ac) return this;
    const audio = this.audio;
    const D = audio.dsp;

    /* --- master chain --------------------------------------------------- */

    // Bus glue, not a limiter. Measured offline: at a -18 threshold and 3.2:1
    // the arrangement sat 15 dB into the compressor and cutting the fader by
    // a quarter moved the output by 2%, which is the signature of a bus that
    // is being levelled rather than glued — and it pumps.
    this.comp = ac.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 2.6;
    this.comp.attack.value = 0.008;
    this.comp.release.value = 0.14;
    this.comp.connect(audio.buses.music);

    this.tone = ac.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 14000;
    this.tone.Q.value = 0.5;
    this.tone.connect(this.comp);

    this.mix = ac.createGain();
    this.mix.gain.value = 0.40;
    this.mix.connect(this.tone);

    // Drums bypass the sidechain, everything tonal goes through it.
    this.mixDrums = ac.createGain();
    this.mixDrums.gain.value = 1;
    this.mixDrums.connect(this.mix);

    this.duck = ac.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.mix);

    this.mixTonal = ac.createGain();
    this.mixTonal.gain.value = 1;
    this.mixTonal.connect(this.duck);

    /* --- stereo placement ------------------------------------------------ */

    // Bass, kick and lead stay dead centre; the ornamental voices are pushed
    // out either side. Without this the whole score is a mono block sitting on
    // top of a mix whose engines and impacts are genuinely positional, and it
    // sounds pasted on.
    const pan = (amount, dest) => {
      if (!ac.createStereoPanner) return dest;
      const p = ac.createStereoPanner();
      p.pan.value = amount;
      p.connect(dest);
      return p;
    };

    /* --- delay send ----------------------------------------------------- */

    this.delay = ac.createDelay(1.5);
    this.delay.delayTime.value = this.stepDur * 3;   // dotted eighth
    this.delayFb = ac.createGain();
    this.delayFb.gain.value = 0.34;
    this.delayLp = ac.createBiquadFilter();
    this.delayLp.type = 'lowpass';
    this.delayLp.frequency.value = 2600;
    this.delaySend = ac.createGain();
    this.delaySend.gain.value = 0.30;
    this.delayOut = ac.createGain();
    this.delayOut.gain.value = 0.42;
    this.delaySend.connect(this.delay);
    this.delay.connect(this.delayLp);
    this.delayLp.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayLp.connect(this.delayOut);
    // Repeats sit opposite the arp, which is what turns a dotted-eighth delay
    // into a stereo image rather than a thicker mono signal.
    this.delayOut.connect(pan(-0.42, this.mix));

    /* --- pulse wave table ----------------------------------------------- */

    this.pulseWaves = [];
    for (let i = 0; i < 12; i++) this.pulseWaves.push(D.pulseWave(ac, 0.06 + i * 0.04, 40));

    /* --- lead ----------------------------------------------------------- */

    // Every instrument's `*Level` node is its fader in the mix and never moves
    // except on an arrangement change; the per-note envelopes below run 0..1
    // inside it. Keeping those two jobs on separate nodes is what makes the
    // balance legible instead of a pile of multiplied magic numbers.
    this.leadLevel = ac.createGain();
    this.leadLevel.gain.value = 0;
    this.leadLevel.connect(this.mixTonal);
    this.leadLevel.connect(this.delaySend);

    this.leadFilter = ac.createBiquadFilter();
    this.leadFilter.type = 'lowpass';
    this.leadFilter.frequency.value = 5200;
    this.leadFilter.Q.value = 3;
    this.leadFilter.connect(this.leadLevel);

    this.leadGain = ac.createGain();
    this.leadGain.gain.value = 0;
    this.leadGain.connect(this.leadFilter);

    this.leadOsc = ac.createOscillator();
    this.leadOsc.setPeriodicWave(this.pulseWaves[6]);
    this.leadOsc.frequency.value = 440;
    this.leadOsc.connect(this.leadGain);

    /* --- counter lead (a harmony line, only at high intensity) ---------- */

    this.counterLevel = ac.createGain();
    this.counterLevel.gain.value = 0.0;
    this.counterLevel.connect(pan(-0.30, this.mixTonal));
    this.counterGain = ac.createGain();
    this.counterGain.gain.value = 0;
    this.counterGain.connect(this.counterLevel);
    this.counterOsc = ac.createOscillator();
    this.counterOsc.setPeriodicWave(this.pulseWaves[3]);
    this.counterOsc.frequency.value = 440;
    this.counterOsc.connect(this.counterGain);

    /* --- bass ----------------------------------------------------------- */

    this.bassLevel = ac.createGain();
    this.bassLevel.gain.value = 0;
    this.bassLevel.connect(this.mixTonal);

    this.bassFilter = ac.createBiquadFilter();
    this.bassFilter.type = 'lowpass';
    this.bassFilter.frequency.value = 700;
    this.bassFilter.Q.value = 7;
    this.bassFilter.connect(this.bassLevel);

    this.bassGain = ac.createGain();
    this.bassGain.gain.value = 0;
    this.bassGain.connect(this.bassFilter);

    this.bassOscs = [];
    // Two saws either side of pitch plus a square an octave down. The detune is
    // what makes it fat; the sub is what makes it audible on a laptop.
    for (const d of [-9, 9]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = d;
      o.connect(this.bassGain);
      this.bassOscs.push(o);
    }
    this.bassSub = ac.createOscillator();
    this.bassSub.type = 'square';
    this.bassSubGain = ac.createGain();
    this.bassSubGain.gain.value = 0.55;
    this.bassSub.connect(this.bassSubGain);
    this.bassSubGain.connect(this.bassGain);

    /* --- arpeggio -------------------------------------------------------- */

    this.arpLevel = ac.createGain();
    this.arpLevel.gain.value = 0;
    this.arpLevel.connect(pan(0.34, this.mixTonal));
    this.arpLevel.connect(this.delaySend);

    this.arpFilter = ac.createBiquadFilter();
    this.arpFilter.type = 'bandpass';
    this.arpFilter.frequency.value = 2200;
    this.arpFilter.Q.value = 1.1;
    this.arpFilter.connect(this.arpLevel);

    this.arpGain = ac.createGain();
    this.arpGain.gain.value = 0;
    this.arpGain.connect(this.arpFilter);

    this.arpOsc = ac.createOscillator();
    this.arpOsc.setPeriodicWave(this.pulseWaves[4]);
    this.arpOsc.frequency.value = 880;
    this.arpOsc.connect(this.arpGain);

    /* --- pad ------------------------------------------------------------- */

    this.padLevel = ac.createGain();
    this.padLevel.gain.value = 0;
    this.padLevel.connect(this.mixTonal);

    // Two filters rather than one so the two halves of the voicing can be hard
    // panned and still be one instrument. Both track the same LFO.
    this.padFilters = [];
    for (let side = 0; side < 2; side++) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1400;
      f.Q.value = 1.4;
      f.connect(pan(side === 0 ? -0.55 : 0.55, this.padLevel));
      this.padFilters.push(f);
    }

    this.padOscs = [];
    for (let i = 0; i < 6; i++) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = (i % 2 === 0 ? -7 : 7) + (i - 2.5) * 2;
      o.frequency.value = 220;
      const g = ac.createGain();
      g.gain.value = 0.16;
      o.connect(g);
      g.connect(this.padFilters[i % 2]);
      this.padOscs.push({ osc: o, gain: g });
    }
    this.padLfo = ac.createOscillator();
    this.padLfo.type = 'sine';
    this.padLfo.frequency.value = 0.08;
    this.padLfoGain = ac.createGain();
    this.padLfoGain.gain.value = 520;
    this.padLfo.connect(this.padLfoGain);
    this.padLfoGain.connect(this.padFilters[0].frequency);
    this.padLfoGain.connect(this.padFilters[1].frequency);

    /* --- riser ----------------------------------------------------------- */

    this.riserBp = ac.createBiquadFilter();
    this.riserBp.type = 'bandpass';
    this.riserBp.frequency.value = 400;
    this.riserBp.Q.value = 4;
    this.riserGain = ac.createGain();
    this.riserGain.gain.value = 0;
    this.riserSrc = ac.createBufferSource();
    this.riserSrc.buffer = audio.noise;
    this.riserSrc.loop = true;
    this.riserSrc.connect(this.riserBp);
    this.riserBp.connect(this.riserGain);
    this.riserGain.connect(this.mix);

    this.riserOsc = ac.createOscillator();
    this.riserOsc.type = 'sawtooth';
    this.riserOsc.frequency.value = 110;
    this.riserOscGain = ac.createGain();
    this.riserOscGain.gain.value = 0;
    this.riserOsc.connect(this.riserOscGain);
    this.riserOscGain.connect(this.mix);

    return this;
  }

  /* ------------------------------------------------------------- composition */

  setTheme(theme) {
    const key = CIRCUIT_SCORES[theme] ? theme : 'menu';
    if (key === this.theme && this.motif) return this;
    this.theme = key;
    this.score = CIRCUIT_SCORES[key];
    this.scale = SCALES[this.score.scale] || SCALES.minor;
    this.bpm = this.score.bpm;
    this.swing = this.score.swing;
    this.stepDur = 60 / this.bpm / 4;
    this.rng = makeRng(this.score.seed);
    this.motif = this._compose(makeRng(this.score.seed));
    this._padChord = -1;
    if (this.delay) this.delay.delayTime.value = this.stepDur * 3;
    return this;
  }

  /**
   * The one-bar motif every phrase is built from: where the notes fall, how
   * long they are, and how the contour moves through the scale.
   */
  _compose(rng) {
    const rhythm = new Uint8Array(STEPS_PER_BAR);
    const length = new Uint8Array(STEPS_PER_BAR);
    const pitch = new Int8Array(STEPS_PER_BAR);
    const accent = new Uint8Array(STEPS_PER_BAR);

    rhythm[0] = 1;
    for (let i = 1; i < STEPS_PER_BAR; i++) {
      rhythm[i] = rng.next() < ONSET_W[i] * 0.68 ? 1 : 0;
    }
    // Guarantee a note in the second half; a motif that dies after beat two
    // reads as broken rather than as space.
    let second = 0;
    for (let i = 8; i < STEPS_PER_BAR; i++) second += rhythm[i];
    if (!second) rhythm[8] = 1;

    // Contour: a random walk over scale degrees. The step distribution is
    // symmetric so the line does not drift off the top of the register, steps
    // of a second are the most likely (that is what makes it singable), and the
    // last note of the bar is snapped onto a chord tone so the phrase resolves
    // instead of just stopping.
    let last = 0;
    for (let i = 0; i < STEPS_PER_BAR; i++) if (rhythm[i]) last = i;

    let deg = rng.pick([0, 2, 4]);
    for (let i = 0; i < STEPS_PER_BAR; i++) {
      if (!rhythm[i]) continue;
      deg += rng.weighted([-4, -3, -2, -1, 0, 1, 2, 3, 4], [2, 4, 8, 12, 5, 12, 8, 4, 2]);
      // Gravity toward the middle of the register, so a run of same-sign steps
      // cannot walk the melody into the ceiling.
      if (deg > 7) deg -= 7;
      else if (deg < -4) deg += 7;
      else if (Math.abs(deg) > 4 && rng.chance(0.45)) deg = Math.round(deg * 0.5);
      if (i === last) {
        // Nearest chord tone: root, third or fifth, in either octave.
        const tones = [-7, -5, -3, 0, 2, 4, 7];
        let best = tones[0];
        for (const c of tones) if (Math.abs(c - deg) < Math.abs(best - deg)) best = c;
        deg = best;
      }
      pitch[i] = deg;
      accent[i] = ONSET_W[i] > 0.7 || rng.chance(0.22) ? 1 : 0;
      // Note length runs to the next onset, capped at a half note.
      let n = 1;
      while (i + n < STEPS_PER_BAR && !rhythm[i + n] && n < 8) n++;
      length[i] = rng.chance(0.28) ? 1 : n;   // some notes are deliberately short
    }

    return {
      rhythm, pitch, length, accent,
      bass: BASS_PATTERNS[this.score.bassPattern % BASS_PATTERNS.length],
      // Which bars of an eight-bar phrase get the octave lift and the fill.
      lift: rng.pick([[2, 6], [3, 7], [1, 5]]),
    };
  }

  /* ----------------------------------------------------------------- control */

  setState(name) {
    this._wantState = name;
    if (!this.playing) { this.state = name; this._applyArrangement(this.audio.now); }
    return this;
  }

  setIntensity(x) { this.intensity = saturate(x); return this; }

  setPaused(p) {
    this.paused = !!p;
    if (!this.running) return this;
    const now = this.audio.now;
    this.audio.dsp.set(this.tone.frequency, p ? 900 : this._toneTarget(), now, 0.12);
    this.audio.dsp.set(this.mix.gain, p ? 0.16 : 0.40, now, 0.12);
    return this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on && this.playing) this.stop();
    else if (on && !this.playing) this.start();
    return this;
  }

  applySettings() { return this; }

  /** Last lap: raise the tension for good and fire a riser into the next bar. */
  finalLap() {
    this._tension = 1;
    if (!this.running) return this;
    this._riserAt = this._barStartTime();
    return this;
  }

  start() {
    // Remember the intent even if the graph is still locked: update() retries
    // as soon as the first gesture opens the context.
    this.wanted = true;
    if (!this.running || this.playing) return this;
    const ac = this.ac;
    const now = ac.currentTime;
    const startNodes = [
      this.leadOsc, this.counterOsc, this.arpOsc, this.bassSub,
      this.padLfo, this.riserOsc, this.riserSrc,
    ];
    for (const o of this.bassOscs) startNodes.push(o);
    for (const p of this.padOscs) startNodes.push(p.osc);
    for (const n of startNodes) {
      try { n.start(now); } catch (_) { /* already started */ }
    }
    this._step = 0;
    this._nextTime = now + 0.09;
    this.playing = true;
    this.state = this._wantState;
    this._applyArrangement(now);
    return this;
  }

  stop() {
    this.wanted = false;
    this.playing = false;
    if (!this.ac) return this;
    const now = this.audio.now;
    const D = this.audio.dsp;
    D.set(this.mix.gain, 0, now, 0.12);
    D.jump(this.leadGain.gain, 0, now);
    D.jump(this.bassGain.gain, 0, now);
    D.jump(this.arpGain.gain, 0, now);
    D.jump(this.counterGain.gain, 0, now);
    return this;
  }

  /* -------------------------------------------------------------- scheduling */

  update(dt) {
    if (!this.running) return;
    if (this.wanted && !this.playing) this.start();
    const now = this.ac.currentTime;
    this._sweepPerc(now);
    this._pwm(dt);
    if (!this.playing || this.paused) return;

    // A tab that was hidden for ten seconds must not try to play ten seconds of
    // music in one frame.
    if (this._nextTime < now - 0.4) this._nextTime = now + 0.05;

    let guard = 0;
    while (this._nextTime < now + LOOKAHEAD && guard++ < 96) {
      this._scheduleStep(this._step, this._nextTime);
      this._nextTime += this.stepDur;
      this._step++;
    }

    if (this._riserAt >= 0 && now + LOOKAHEAD >= this._riserAt) {
      const at = Math.max(now + 0.02, this._riserAt);
      this._riser(at, this.stepDur * STEPS_PER_BAR * 2);
      this._riserAt = -1;
    }
  }

  /** Audio time of the next bar line. */
  _barStartTime() {
    const into = this._step % STEPS_PER_BAR;
    return this._nextTime + (STEPS_PER_BAR - into) * this.stepDur;
  }

  /**
   * Duty-cycle modulation. Swapping the lead's PeriodicWave from the frame loop
   * is real PWM — the classic chiptune move — and because a wave swap does not
   * reset oscillator phase it is completely seamless.
   */
  _pwm(dt) {
    this._pwmPhase += dt * (0.28 + this.intensity * 0.55);
    const base = this.score.leadDuty;
    const d = clamp(base + Math.sin(this._pwmPhase) * 0.16 + Math.sin(this._pwmPhase * 0.37) * 0.06, 0.06, 0.5);
    const idx = clamp(Math.round((d - 0.06) / 0.04), 0, this.pulseWaves.length - 1);
    if (idx !== this._pwmIndex) {
      this._pwmIndex = idx;
      this.leadOsc.setPeriodicWave(this.pulseWaves[idx]);
    }
  }

  _scheduleStep(step, timeIn) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const i = step % STEPS_PER_BAR;

    // Arrangement changes land on bar lines. Anything else sounds like a bug.
    if (i === 0) {
      if (this._wantState !== this.state) this.state = this._wantState;
      this._applyArrangement(timeIn);
    }

    const t = timeIn + ((i & 1) ? this.swing * this.stepDur : 0);
    const m = this.motif;
    if (!m) return;

    const prog = this.score.prog;
    const chordDeg = prog[bar % prog.length];
    const phraseBar = bar % 8;
    const arr = this._arrangement;
    if (!arr) return;

    if (i === 0 && this._padChord !== chordDeg) {
      this._padChord = chordDeg;
      this._pad(timeIn, chordDeg);
    }

    /* --- drums ---------------------------------------------------------- */

    if (arr.drums) this._drums(t, i, phraseBar, arr);

    /* --- bass ----------------------------------------------------------- */

    if (arr.bass && (i & 1) === 0) {
      const bi = i >> 1;
      const off = m.bass[bi % m.bass.length];
      const rootMidi = degToMidi(this.scale, this.score.root - 12, chordDeg);
      // A rest on the last eighth of the fourth bar, so the phrase breathes.
      if (!(phraseBar % 4 === 3 && bi === 7)) {
        this._bassNote(t, rootMidi + off, this.stepDur * (bi === 7 ? 1.4 : 1.7), arr.bassGain);
      }
    }

    /* --- lead ----------------------------------------------------------- */

    if (arr.lead && m.rhythm[i]) {
      const lift = m.lift.indexOf(phraseBar) >= 0 ? 12 : 0;
      const deg = chordDeg + m.pitch[i];
      let midi = degToMidi(this.scale, this.score.root + 12, deg) + lift;
      // The last bar of each phrase answers an octave down — call and response
      // with itself, which is what stops the loop feeling like a loop.
      if (phraseBar === 7) midi -= 12;
      const dur = this.stepDur * m.length[i] * 0.92;
      const g = arr.leadGain * (m.accent[i] ? 1 : 0.72);
      this._leadNote(t, midi, dur, g);
      if (arr.counter) {
        // A third above, inside the scale — never a parallel semitone.
        this._counterNote(t, degToMidi(this.scale, this.score.root + 12, deg + 2) + lift, dur, arr.counterGain);
      }
    }

    /* --- arpeggio -------------------------------------------------------- */

    if (arr.arp) {
      const tones = [0, 2, 4, 6, 4, 2];
      const k = step % tones.length;
      const oct = Math.floor((step % (tones.length * 2)) / tones.length) * 12;
      const midi = degToMidi(this.scale, this.score.root + 24, chordDeg + tones[k]) + oct;
      this._arpNote(t, midi, this.stepDur * 0.8, arr.arpGain);
    }
  }

  /* ------------------------------------------------------------- arrangement */

  _toneTarget() {
    const base = { menu: 3400, grid: 2200, countdown: 3000, race: 16000, results: 6000 };
    const b = base[this.state] ?? 12000;
    return clamp(b * (0.75 + this.intensity * 0.5) * (1 + this._tension * 0.35), 500, 20000);
  }

  _applyArrangement(t) {
    const s = this.state;
    const I = this.intensity;
    const tense = this._tension;

    const arr = this._arrangement || (this._arrangement = {});
    arr.drums = (s === 'race' || (s === 'results' && I > 0.2)) && I > 0.10;
    arr.hats = arr.drums && I > 0.22;
    arr.hats16 = arr.drums && (I > 0.62 || tense > 0.5);
    arr.bass = s === 'race' || s === 'menu' || s === 'countdown' || s === 'results';
    arr.lead = (s === 'race' && I > 0.16) || s === 'menu' || s === 'results';
    arr.counter = s === 'race' && (I > 0.66 || tense > 0.5);
    arr.arp = s === 'race' && (I > 0.34 || tense > 0.4);
    arr.pad = s !== 'race' || I > 0.5;
    arr.fills = s === 'race';

    // Note-envelope peaks, 0..1 — dynamics, not balance.
    arr.leadGain = s === 'menu' ? 0.62 : clamp(0.60 + I * 0.40, 0, 1);
    arr.counterGain = 0.72;
    arr.bassGain = s === 'menu' ? 0.72 : 0.92;
    arr.arpGain = clamp(0.55 + I * 0.45, 0, 1);
    arr.kickGain = 0.42 * (0.80 + I * 0.30);
    arr.snareGain = 0.26 * (0.75 + I * 0.40);
    arr.hatGain = 0.085 * (0.70 + I * 0.60);

    const D = this.audio.dsp;
    const now = Math.max(t, this.audio.now);
    D.set(this.tone.frequency, this._toneTarget(), now, 0.25);
    D.set(this.padLevel.gain, arr.pad ? (s === 'race' ? 0.075 : 0.13) : 0, now, 0.4);
    D.set(this.arpLevel.gain, arr.arp ? 0.10 : 0, now, 0.25);
    D.set(this.counterLevel.gain, arr.counter ? 0.085 : 0, now, 0.3);
    D.set(this.leadLevel.gain, arr.lead ? 0.16 : 0, now, 0.25);
    D.set(this.bassLevel.gain, arr.bass ? 0.075 : 0, now, 0.25);
    D.set(this.mix.gain, this.paused ? 0.16 : 0.40, now, 0.2);
    D.set(this.delayOut.gain, s === 'race' ? 0.30 : 0.46, now, 0.3);
    D.set(this.leadFilter.frequency, clamp(2600 + I * 6000 + tense * 3000, 800, 18000), now, 0.3);
  }

  /* ------------------------------------------------------------------ voices */

  _leadNote(t, midi, dur, gain) {
    const f = mtof(clamp(midi, 24, 108));
    this.leadOsc.frequency.setValueAtTime(f, t);
    const g = this.leadGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0005, gain), t + 0.006);
    g.exponentialRampToValueAtTime(Math.max(0.0004, gain * 0.62), t + dur * 0.55);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _counterNote(t, midi, dur, gain) {
    const f = mtof(clamp(midi, 24, 108));
    this.counterOsc.frequency.setValueAtTime(f, t);
    const g = this.counterGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0005, gain), t + 0.012);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _arpNote(t, midi, dur, gain) {
    const f = mtof(clamp(midi, 24, 110));
    this.arpOsc.frequency.setValueAtTime(f, t);
    this.arpFilter.frequency.setValueAtTime(clamp(f * 2.2, 300, 12000), t);
    const g = this.arpGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0005, gain), t + 0.004);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _bassNote(t, midi, dur, gain) {
    const f = mtof(clamp(midi, 24, 72));
    for (const o of this.bassOscs) o.frequency.setValueAtTime(f, t);
    this.bassSub.frequency.setValueAtTime(f * 0.5, t);
    // The filter envelope is the whole sound: a fast sweep from four times the
    // fundamental down to just above it, with enough Q to whistle.
    const fc = this.bassFilter.frequency;
    fc.cancelScheduledValues(t);
    fc.setValueAtTime(clamp(f * 6.5, 90, 6000), t);
    fc.exponentialRampToValueAtTime(clamp(f * 1.9, 70, 4000), t + Math.min(0.16, dur));
    const g = this.bassGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0006, gain), t + 0.006);
    g.exponentialRampToValueAtTime(Math.max(0.0004, gain * 0.55), t + dur * 0.7);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _pad(t, chordDeg) {
    const notes = [
      degToMidi(this.scale, this.score.root, chordDeg),
      degToMidi(this.scale, this.score.root, chordDeg + 2),
      degToMidi(this.scale, this.score.root, chordDeg + 4),
    ];
    for (let i = 0; i < this.padOscs.length; i++) {
      const n = notes[i % notes.length] + (i >= notes.length ? 12 : 0);
      // Glide rather than jump: the pad is the one voice allowed to smear
      // across a chord change.
      // Alternating sides get different inversions, so the pad opens outward
      // instead of both channels playing the same three notes.
      const bump = (i % 2 === 1 && i >= 2) ? 12 : 0;
      this.padOscs[i].osc.frequency.setTargetAtTime(mtof(clamp(n + bump, 24, 96)), t, 0.06);
    }
  }

  /* -------------------------------------------------------------- percussion */

  _takePerc(end) {
    for (let i = 0; i < this._perc.length; i++) {
      const idx = (this._percCursor + i) % this._perc.length;
      const r = this._perc[idx];
      if (r.end < 0) {
        this._percCursor = (idx + 1) % this._perc.length;
        r.end = end;
        r.n.length = 0;
        return r;
      }
    }
    return null;
  }

  _sweepPerc(now) {
    for (let i = 0; i < this._perc.length; i++) {
      const r = this._perc[i];
      if (r.end < 0 || r.end > now) continue;
      for (let k = 0; k < r.n.length; k++) {
        try { r.n[k].stop?.(); } catch (_) { /* already stopped */ }
        try { r.n[k].disconnect(); } catch (_) { /* ignore */ }
      }
      r.n.length = 0;
      r.end = -1;
    }
  }

  _percNoise(rec, t, o) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.audio.noise;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.value = clamp(o.f, 30, 19000);
    f.Q.value = o.q ?? 1;
    const g = ac.createGain();
    g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.mixDrums);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0005, o.gain), t + (o.atk ?? 0.0012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (o.atk ?? 0.0012) + o.dur);
    src.start(t, this.rng.next() * Math.max(0.01, this.audio.noise.duration - 0.05));
    src.stop(t + o.dur + 0.08);
    rec.n.push(src, f, g);
  }

  _kick(t, gain) {
    const rec = this._takePerc(t + 0.7);
    if (!rec) return;
    const ac = this.ac;
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(152, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.085);
    const g = ac.createGain();
    g.gain.value = 0;
    o.connect(g); g.connect(this.mixDrums);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.start(t); o.stop(t + 0.4);
    rec.n.push(o, g);
    this._percNoise(rec, t, { f: 2600, q: 0.8, dur: 0.014, gain: gain * 0.25, type: 'highpass' });
    // Sidechain: the tonal bus dips under every kick. This is the single move
    // that makes a chiptune arrangement sit in a modern mix.
    const d = this.duck.gain;
    d.setValueAtTime(0.66, t);
    d.linearRampToValueAtTime(1, t + 0.18);
  }

  _snare(t, gain) {
    const rec = this._takePerc(t + 0.5);
    if (!rec) return;
    const ac = this.ac;
    this._percNoise(rec, t, { f: 1850, q: 0.9, dur: 0.13, gain: gain });
    this._percNoise(rec, t, { f: 6200, q: 0.6, dur: 0.045, gain: gain * 0.4, type: 'highpass' });
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(196, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const g = ac.createGain();
    g.gain.value = 0;
    o.connect(g); g.connect(this.mixDrums);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0006, gain * 0.5), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.start(t); o.stop(t + 0.2);
    rec.n.push(o, g);
  }

  _hat(t, gain, open) {
    const rec = this._takePerc(t + (open ? 0.5 : 0.2));
    if (!rec) return;
    this._percNoise(rec, t, {
      f: open ? 7400 : 9200, q: 0.7, type: 'highpass',
      dur: open ? 0.17 : 0.028, gain,
    });
  }

  _crash(t, gain) {
    const rec = this._takePerc(t + 2.2);
    if (!rec) return;
    this._percNoise(rec, t, { f: 4200, q: 0.4, type: 'highpass', dur: 1.5, gain, atk: 0.004 });
    this._percNoise(rec, t, { f: 9000, q: 0.6, type: 'highpass', dur: 0.5, gain: gain * 0.6 });
  }

  _drums(t, i, phraseBar, arr) {
    // Kick: downbeat, the "and" of two, and a push into the next bar.
    if (i === 0 || i === 6 || i === 10) this._kick(t, arr.kickGain * (i === 0 ? 1 : 0.82));
    if (i === 14 && phraseBar % 2 === 1) this._kick(t, arr.kickGain * 0.7);
    if (i === 4 || i === 12) this._snare(t, arr.snareGain);

    if (arr.hats) {
      if (arr.hats16) {
        if ((i & 1) === 0 || this.intensity > 0.75) {
          this._hat(t, arr.hatGain * (i % 4 === 0 ? 1.25 : 0.8), i === 14);
        }
      } else if (i % 2 === 0) {
        this._hat(t, arr.hatGain * (i % 8 === 0 ? 1.2 : 0.8), i === 12);
      }
    }

    if (i === 0 && phraseBar === 0) this._crash(t, 0.13 * (0.6 + this.intensity * 0.6));

    // Fills: the last bar of each four-bar block, and a snare roll on the run
    // to the flag.
    if (arr.fills && phraseBar % 4 === 3) {
      if (i >= 12) this._snare(t, arr.snareGain * (0.5 + (i - 12) * 0.16));
    }
    if (this._tension > 0.5 && phraseBar % 2 === 1 && i >= 8) {
      this._snare(t, arr.snareGain * 0.30 * ((i - 8) / 8 + 0.3));
    }
  }

  /* ------------------------------------------------------------------ riser */

  /** Two bars of rising noise and a saw sweep, resolving on the downbeat. */
  _riser(t, dur) {
    const end = t + dur;
    const bp = this.riserBp.frequency;
    bp.cancelScheduledValues(t);
    bp.setValueAtTime(320, t);
    bp.exponentialRampToValueAtTime(9000, end);
    const g = this.riserGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(0.11, end - 0.05);
    g.exponentialRampToValueAtTime(0.0001, end + 0.14);

    const rootF = mtof(degToMidi(this.scale, this.score.root, 0));
    const of = this.riserOsc.frequency;
    of.cancelScheduledValues(t);
    of.setValueAtTime(rootF, t);
    of.exponentialRampToValueAtTime(rootF * 4, end);
    const og = this.riserOscGain.gain;
    og.cancelScheduledValues(t);
    og.setValueAtTime(0.0001, t);
    og.exponentialRampToValueAtTime(0.06, end - 0.05);
    og.exponentialRampToValueAtTime(0.0001, end + 0.1);

    this._crash(end, 0.22);
    // Open the master filter as the riser lands: the last lap should sound
    // like the lid came off.
    this.audio.dsp.set(this.tone.frequency, 19000, end, 0.4);
  }

  /* ---------------------------------------------------------------- teardown */

  dispose() {
    this.playing = false;
    const stop = (n) => {
      try { n?.stop?.(); } catch (_) { /* ignore */ }
      try { n?.disconnect?.(); } catch (_) { /* ignore */ }
    };
    stop(this.leadOsc); stop(this.counterOsc); stop(this.arpOsc);
    stop(this.bassSub); stop(this.padLfo); stop(this.riserOsc); stop(this.riserSrc);
    for (const o of this.bassOscs) stop(o);
    for (const p of this.padOscs) { stop(p.osc); stop(p.gain); }
    for (const r of this._perc) {
      for (const n of r.n) stop(n);
      r.n.length = 0;
      r.end = -1;
    }
    for (const n of [this.leadGain, this.leadFilter, this.leadLevel, this.counterGain,
      this.counterLevel, this.bassGain, this.bassFilter, this.bassLevel, this.bassSubGain,
      this.arpGain, this.arpFilter, this.arpLevel, this.padLevel,
      this.padFilters?.[0], this.padFilters?.[1],
      this.padLfoGain, this.riserBp, this.riserGain, this.riserOscGain,
      this.delay, this.delayFb, this.delayLp, this.delaySend, this.delayOut,
      this.mixTonal, this.mixDrums, this.duck, this.mix, this.tone, this.comp]) {
      try { n?.disconnect?.(); } catch (_) { /* ignore */ }
    }
    return this;
  }
}

export default Music;
