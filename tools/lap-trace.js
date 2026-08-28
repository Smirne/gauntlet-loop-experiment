// Trace a lap for the two things a player actually complains about: "I can't
// see where I'm going" and "it stutters".
//
// Both are questions about WHERE, and neither has ever been measured on this
// project as a function of position round the circuit. Every lighting number so
// far has come from a single pinned pose, which is exactly the sampling that
// cannot find a dark patch — a probe at one point on the lap says nothing about
// the other 99.
//
// So: ride along. This installs a sampler on the live rAF loop and records, for
// every frame of a real autopiloted lap:
//
//   * ROAD LUMA AHEAD. The mean luminance of a band of screen just in front of
//     the car — not the whole frame, which is dominated by carpet and by the
//     HUD, and not the car itself. This is the part of the picture the player
//     has to read to know where the road goes. Sampled by drawing the canvas
//     into a tiny offscreen canvas, which makes the downscale do the averaging.
//   * FRAME TIME. Wall-clock delta between rAF callbacks, plus the engine's own
//     fixed-step catch-up count, which is what actually shows up as a lurch:
//     a frame that has to run six physics steps has stalled somewhere.
//
// Both are stamped with `trackT` (0..1 round the lap), so a trough or a spike
// can be pointed at a place. bedroom's first ramp is t = 0.148 and its second
// is t = 0.655, from the track file.
//
// Reads back with drawImage + getImageData, both synchronous, inside the rAF
// callback itself. Nothing is awaited, so the sample is of the frame that was
// just presented and not of whatever the scheduler got round to later.
//
//   const m = await import('/tools/lap-trace.js');
//   m.start();                       // then let it drive
//   const r = m.stop();              // { samples, hitches, byT }

let state = null;

const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * @param {{band?: number[], every?: number, hitchMs?: number, w?: number}} [opts]
 *   band    - [x0, y0, x1, y1] in normalised screen coords, the road-ahead
 *             window. Default is a strip above the car and inside the verges.
 *   every   - sample every Nth frame (default 3)
 *   hitchMs - a frame at or over this is recorded as a hitch (default 40, i.e.
 *             anything slower than 25 fps)
 */
export function start(opts = {}) {
  if (state) stop();
  const MG = window.MG;
  if (!MG?.engine) throw new Error('no engine');

  const band = opts.band ?? [0.36, 0.18, 0.64, 0.52];
  const every = Math.max(1, opts.every ?? 3);
  const hitchMs = opts.hitchMs ?? 40;
  const w = opts.w ?? 48, h = opts.h ?? 24;

  const oc = new OffscreenCanvas(w, h);
  const g2 = oc.getContext('2d', { willReadFrequently: true });

  state = {
    samples: [], hitches: [], every, hitchMs, band,
    last: performance.now(), frames: 0, raf: 0, stopped: false,
  };

  const canvas = MG.engine.renderer.domElement;

  const tick = () => {
    if (state.stopped) return;
    state.raf = requestAnimationFrame(tick);

    const now = performance.now();
    const dt = now - state.last;
    state.last = now;
    state.frames++;

    const car = MG.ctx?.player;
    const t = car?.trackT ?? null;
    const steps = MG.engine.time?.steps ?? null;

    if (dt >= state.hitchMs && state.frames > 8) {
      state.hitches.push({
        ms: +dt.toFixed(1), t: t === null ? null : +t.toFixed(4),
        frame: MG.engine.time?.frame ?? null,
        clock: +(MG.ctx?.race?.raceTime ?? 0).toFixed(2),
        steps, speed: +(car?.speed ?? 0).toFixed(0),
      });
    }

    if (state.frames % every !== 0) return;

    // Sample the road-ahead band. drawImage does the downscale, so the average
    // is the browser's and costs nothing here.
    const cw = canvas.width, ch = canvas.height;
    const sx = Math.round(band[0] * cw), sy = Math.round(band[1] * ch);
    const sw = Math.max(1, Math.round((band[2] - band[0]) * cw));
    const sh = Math.max(1, Math.round((band[3] - band[1]) * ch));
    let mean = null, p10 = null;
    try {
      g2.drawImage(canvas, sx, sy, sw, sh, 0, 0, w, h);
      const px = g2.getImageData(0, 0, w, h).data;
      const n = w * h;
      const vals = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const l = LUMA(px[o], px[o + 1], px[o + 2]);
        vals[i] = l; sum += l;
      }
      mean = sum / n;
      const sorted = Array.from(vals).sort((a, b) => a - b);
      p10 = sorted[Math.floor(n * 0.10)];
    } catch (_) { /* canvas not readable this frame */ }

    if (mean === null) return;
    state.samples.push({
      t: t === null ? null : +t.toFixed(4),
      lap: car?.lap ?? null,
      clock: +(MG.ctx?.race?.raceTime ?? 0).toFixed(2),
      luma: +mean.toFixed(2),
      p10: +p10.toFixed(2),
      ms: +dt.toFixed(1),
      speed: +(car?.speed ?? 0).toFixed(0),
    });
  };

  state.raf = requestAnimationFrame(tick);
  return { started: true, band, every, hitchMs };
}

/** Stop sampling and reduce. Returns the raw samples plus a bucket-by-t table. */
export function stop() {
  if (!state) return null;
  state.stopped = true;
  cancelAnimationFrame(state.raf);
  const { samples, hitches, band, hitchMs } = state;
  state = null;

  // 40 buckets round the lap, so a dark stretch is a run of low buckets rather
  // than one unlucky frame.
  const N = 40;
  const buckets = Array.from({ length: N }, () => ({ luma: [], p10: [], ms: [] }));
  for (const s of samples) {
    if (s.t === null) continue;
    const i = Math.min(N - 1, Math.max(0, Math.floor(s.t * N)));
    buckets[i].luma.push(s.luma);
    buckets[i].p10.push(s.p10);
    buckets[i].ms.push(s.ms);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const byT = buckets.map((b, i) => ({
    t: +((i + 0.5) / N).toFixed(3),
    n: b.luma.length,
    luma: b.luma.length ? +avg(b.luma).toFixed(1) : null,
    p10: b.p10.length ? +avg(b.p10).toFixed(1) : null,
    ms: b.ms.length ? +avg(b.ms).toFixed(1) : null,
    msMax: b.ms.length ? +Math.max(...b.ms).toFixed(1) : null,
  }));

  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const q = (p) => (ms.length ? +ms[Math.floor(p * (ms.length - 1))].toFixed(1) : null);

  return {
    frames: samples.length, band, hitchMs,
    frameTime: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
    hitches, byT, samples,
  };
}

/* ========================================================================== */
/* Deterministic lap sweep                                                    */
/* ========================================================================== */
//
// `start()` above rides the real rAF loop, which is the honest way to measure
// frame time — but in a browser pane the loop is throttled to roughly 0.1 s of
// race per composite, so a full lap would take thousands of pokes and never
// finish. For the "where is it too dark" question the rAF is not needed at all:
// what is needed is a car that goes all the way round with the camera following
// it, and `_tick(now)` does exactly that, because the camera director runs in
// lateUpdate which `_tick` calls and `stepOnce` does not (D55).
//
// So: stop the engine so its own rAF cannot double-tick, then drive `_tick`
// by hand with a synthetic clock. Everything advances — physics, AI, director,
// lighting, the lamp ramp — and the render at the end of each tick leaves a
// current frame on the canvas to read back.
//
// The frame-time numbers this produces are meaningless by construction and are
// not reported. This measures light, not speed.

/**
 * Drive one full lap and sample the road-ahead luma round it.
 * @param {{every?: number, maxTicks?: number, hz?: number, ss?: number}} [opts]
 */
export async function sweep(opts = {}) {
  const MG = window.MG;
  const engine = MG.engine, renderer = engine.renderer;
  const every = Math.max(1, opts.every ?? 3);
  const hz = opts.hz ?? 60;
  const maxTicks = opts.maxTicks ?? 9000;
  const band = opts.band ?? [0.36, 0.18, 0.64, 0.52];
  const w = opts.w ?? 48, h = opts.h ?? 24;

  const wasRunning = engine.running;
  const prevPR = renderer.getPixelRatio();
  const prevW = Math.round(renderer.domElement.width / prevPR);
  const prevH = Math.round(renderer.domElement.height / prevPR);

  const oc = new OffscreenCanvas(w, h);
  const g2 = oc.getContext('2d', { willReadFrequently: true });
  const canvas = renderer.domElement;
  const samples = [];

  engine.stop();                       // cancels the rAF and clears `running`,
                                       // so _tick will not re-queue itself
  if (engine.paused) engine.resume('sweep');
  renderer.setPixelRatio(opts.ss ?? 1);   // the sweep is about light, not edges
  renderer.setSize(opts.rw ?? 1280, opts.rh ?? 720, false);
  engine.onResize?.(opts.rw ?? 1280, opts.rh ?? 720);
  engine.ctx?.postfx?.notifyCameraCut?.();

  const car = MG.ctx.player;
  const startLap = car.lap ?? 0;
  let now = performance.now();
  const step = 1000 / hz;
  let ticks = 0, laps = 0;

  try {
    while (ticks < maxTicks) {
      now += step;
      engine._tick(now);
      ticks++;

      if ((car.lap ?? 0) > startLap) { laps = (car.lap ?? 0) - startLap; if (laps >= (opts.laps ?? 1)) break; }
      if (ticks % every !== 0) continue;

      const cw = canvas.width, ch = canvas.height;
      const sx = Math.round(band[0] * cw), sy = Math.round(band[1] * ch);
      const sw = Math.max(1, Math.round((band[2] - band[0]) * cw));
      const sh = Math.max(1, Math.round((band[3] - band[1]) * ch));
      g2.drawImage(canvas, sx, sy, sw, sh, 0, 0, w, h);
      const px = g2.getImageData(0, 0, w, h).data;
      const n = w * h;
      const vals = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const l = LUMA(px[o], px[o + 1], px[o + 2]);
        vals[i] = l; sum += l;
      }
      const sorted = Array.from(vals).sort((a, b) => a - b);
      samples.push({
        t: +(car.trackT ?? 0).toFixed(4),
        luma: +(sum / n).toFixed(2),
        p50: +sorted[n >> 1].toFixed(2),
        p90: +sorted[Math.floor(n * 0.9)].toFixed(2),
        speed: +(car.speed ?? 0).toFixed(0),
      });
    }
  } finally {
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevW, prevH, false);
    engine.onResize?.(prevW, prevH);
    engine.ctx?.postfx?.notifyCameraCut?.();
    if (wasRunning) engine.start();
  }

  const N = 50;
  const buckets = Array.from({ length: N }, () => []);
  for (const s of samples) buckets[Math.min(N - 1, Math.floor(s.t * N))].push(s.luma);
  const byT = buckets.map((b, i) => ({
    t: +((i + 0.5) / N).toFixed(3),
    n: b.length,
    luma: b.length ? +(b.reduce((x, y) => x + y, 0) / b.length).toFixed(1) : null,
    min: b.length ? +Math.min(...b).toFixed(1) : null,
  }));

  return { ticks, laps, samples: samples.length, byT };
}
