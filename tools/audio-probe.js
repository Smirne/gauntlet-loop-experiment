// Measure what the menu actually sounds like, without making a sound.
//
// "There is a lot of white noise in the menu" is a report about a spectrum, and
// a spectrum is measurable. This taps the real buses with AnalyserNodes while
// the master gain is pinned to zero, so the graph under test is the shipped one
// and nothing reaches the speakers.
//
// SAFETY: refuses to run unless master gain reads 0. Every audio session on
// this project so far has ended with someone hearing something they did not
// ask for, and an instrument that can make noise is not one worth having.
//
//   const m = await import('/tools/audio-probe.js'); await m.probe(4);
//
// Reported per bus:
//   rms       - level. Compare buses to each other, not to an absolute.
//   flatness  - Wiener entropy: geometric mean / arithmetic mean of the power
//               spectrum. 1.0 is white noise, ~0 is a pure tone. THIS is the
//               number that answers "is this hiss or is this music".
//   centroid  - spectral centre of mass in Hz: where the energy sits.
//   rolloff85 - Hz below which 85% of the energy lies.

function stats(mag, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  let sum = 0, logSum = 0, weighted = 0, n = 0;
  const EPS = 1e-12;
  // Below this mean bin power the bus is silence, not signal. Sits well above
  // EPS so the epsilon floor can never be what is being measured.
  const SILENT = 1e-14;
  // Skip bin 0 (DC) and anything above 20 kHz — neither is audible content and
  // both distort the flatness badly.
  const hi = Math.min(mag.length, Math.floor(20000 / binHz));
  for (let i = 1; i < hi; i++) {
    const p = mag[i] * mag[i];
    sum += p;
    logSum += Math.log(p + EPS);
    weighted += p * (i * binHz);
    n++;
  }
  // A bus can be genuinely silent — nothing is scheduled on it at this moment.
  // Reporting flatness there is not a small error, it is a loud one: with every
  // bin below EPS the epsilon floor becomes the whole arithmetic mean and the
  // ratio runs away (a music bus at 1e-8 rms once reported flatness 6420, which
  // is not a number the Wiener entropy can produce). Say `silent` instead.
  const arith = sum / n;
  if (!n || sum <= 0 || arith < SILENT) {
    return { flatness: null, centroid: 0, rolloff85: 0, silent: true };
  }
  const geo = Math.exp(logSum / n);
  let acc = 0, roll = 0;
  for (let i = 1; i < hi; i++) {
    acc += mag[i] * mag[i];
    if (acc >= sum * 0.85) { roll = i * binHz; break; }
  }
  return {
    flatness: +(geo / arith).toFixed(4),
    centroid: Math.round(weighted / sum),
    rolloff85: Math.round(roll),
  };
}

export async function probe(seconds = 4, opts = {}) {
  const audio = window.MG?.ctx?.audio;
  if (!audio?.ac || !audio.buses) return { refused: 'audio not built yet' };

  const masterGain = audio.master?.gain?.value;
  if (!opts.iAcceptSound && !(masterGain === 0)) {
    return {
      refused: 'master gain is not 0 — this probe will not run where it could make noise',
      masterGain,
      fix: 'mute in Options (or set audio.master.gain.value = 0) and probe again',
    };
  }
  if (audio.ac.state !== 'running') {
    return { refused: 'AudioContext is not running; nothing to measure', state: audio.ac.state };
  }

  const ac = audio.ac;
  const FFT = 8192;
  const taps = {};
  for (const [name, node] of Object.entries(audio.buses)) {
    const an = ac.createAnalyser();
    an.fftSize = FFT;
    an.smoothingTimeConstant = 0;
    node.connect(an);          // a tap, not an insert: the bus keeps its path
    taps[name] = { an, node, mag: new Float32Array(an.frequencyBinCount),
                   acc: null, peak: 0, frames: 0 };
  }

  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 50));
    for (const t of Object.values(taps)) {
      t.an.getFloatFrequencyData(t.mag);            // dBFS per bin
      if (!t.acc) t.acc = new Float64Array(t.mag.length);
      for (let i = 0; i < t.mag.length; i++) {
        const lin = Math.pow(10, t.mag[i] / 20);
        t.acc[i] += lin;
        if (lin > t.peak) t.peak = lin;
      }
      t.frames++;
    }
  }

  const out = {};
  for (const [name, t] of Object.entries(taps)) {
    const avg = new Float32Array(t.acc.length);
    let sq = 0;
    for (let i = 0; i < avg.length; i++) { avg[i] = t.acc[i] / t.frames; sq += avg[i] * avg[i]; }
    out[name] = {
      rms: +Math.sqrt(sq / avg.length).toExponential(3),
      ...stats(avg, ac.sampleRate, FFT),
    };
    t.node.disconnect(t.an);
  }
  return { seconds, sampleRate: ac.sampleRate, masterGain, buses: out,
           theme: audio.theme, musicState: audio._musicState };
}
