// How much brightness range does one lap of the bedroom actually contain, and
// how much of it is the exposure?
//
// D57 shipped `nightLamp.exposure` 1.20 -> 1.95 on a ladder the user judged from
// stills at ONE pose (t = 0.152, the first ramp — the darkest place measured).
// It is marked shipped-but-unverified for exactly the reason this tool exists: a
// still at one pose cannot say whether the rest of the lap is now too bright, and
// a chooser that only ever showed the dark end cannot have answered that.
//
// So two measurements, both from one boot:
//
//   range()      the whole lap at the SHIPPED exposure. 24 evenly spaced points,
//                frame luma and road-band luma at each, plus the percentiles that
//                say whether the frame is crushing or clipping. This is the
//                "bright images vs dark parts" question, in numbers.
//
//   exposures()  one pose, the exposure ramp around what ships, with a floor.
//                Run it at the lap's darkest t and at its brightest and the
//                trade is visible: an exposure that rescues the trough is the
//                same exposure that blows the peak.
//
// D57's original numbers — road-ahead luma 37..172 round the lap — were taken at
// exposure 1.20. They do not describe the build any more. These do.
//
// Same discipline as tools/shadow-ladder.js: driven by hand off a synthetic 60 Hz
// clock with a borrowed Driver (Input writes all-zero controls otherwise and the
// car crawls), director left on so the camera is the real one, film grain zeroed
// and texture drafts settled so a floor can come back clean.
//
//   const m = await import('/tools/night-range.js');
//   await m.range();
//   await m.exposures({ t: 0.15 });
//
// Nothing here changes the game.

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------------ */
/* shared setup                                                        */
/* ------------------------------------------------------------------ */

async function stage() {
  const MG = window.MG;
  const engine = MG.engine;
  const renderer = engine.renderer;
  const canvas = renderer.domElement;
  const car = MG.ctx.player;

  engine.stop();
  if (engine.paused) engine.resume('nightrange');
  MG.ctx.race.start();

  const { Driver } = await import('/src/ai/Driver.js');
  const already = (MG.ctx.drivers || []).some((d) => d.vehicle === car);
  const borrowed = already ? null : new Driver(MG.ctx, car, {
    skill: 0.84, aggression: 0.35, consistency: 0.9, seed: 4242,
  });
  const autoPollWas = car.autoPollInput;
  const inputWas = MG.ctx.input?.enabled;
  if (borrowed) {
    car.autoPollInput = false;
    if (MG.ctx.input) MG.ctx.input.enabled = false;
  }

  const grain = engine.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;
  const drafts = engine.ctx?.surfaces?.settle?.() ?? [];

  let clock = performance.now();
  const tick = () => {
    clock += 1000 / 60;
    if (borrowed) { try { borrowed.update(1 / 60, MG.ctx); } catch (_) { /* keep going */ } }
    engine._tick(clock);
  };

  const restore = () => {
    if (grain) grain.value = grainWas;
    if (borrowed) {
      try { borrowed.dispose?.(); } catch (_) { /* nothing owns it but us */ }
      car.autoPollInput = autoPollWas;
      if (inputWas !== undefined && MG.ctx.input) MG.ctx.input.enabled = inputWas;
    }
    engine.start();
  };

  return { MG, engine, renderer, canvas, car, tick, restore, drafts: drafts.length ?? 0 };
}

/**
 * Luma statistics for whatever is on the canvas right now.
 *
 * The percentiles are the point. A mean cannot tell "evenly lit at 140" from
 * "half the frame crushed and half of it clipped, averaging 140", and those are
 * completely different answers to a question about contrast.
 */
function reader(canvas) {
  const W = 160, H = 90;
  const oc = new OffscreenCanvas(W, H);
  const g = oc.getContext('2d', { willReadFrequently: true });
  const BAND = [0.30, 0.42, 0.70, 0.86];   // the ground the car sits on

  const stats = (sx, sy, sw, sh) => {
    g.drawImage(canvas, sx, sy, sw, sh, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const hist = new Uint32Array(256);
    let sum = 0;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const l = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) | 0;
      hist[l > 255 ? 255 : l]++;
      sum += l;
    }
    const q = (p) => {
      let c = 0;
      for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= n * p) return i; }
      return 255;
    };
    let dark = 0, hot = 0, clip = 0;
    for (let i = 0; i < 32; i++) dark += hist[i];
    for (let i = 224; i < 256; i++) hot += hist[i];
    for (let i = 250; i < 256; i++) clip += hist[i];
    return {
      mean: +(sum / n).toFixed(1),
      p5: q(0.05), median: q(0.5), p95: q(0.95),
      crushed: +(100 * dark / n).toFixed(2),
      hot: +(100 * hot / n).toFixed(2),
      clipped: +(100 * clip / n).toFixed(2),
    };
  };

  return {
    frame: () => stats(0, 0, canvas.width, canvas.height),
    ground: () => {
      const cw = canvas.width, ch = canvas.height;
      return stats(
        Math.round(BAND[0] * cw), Math.round(BAND[1] * ch),
        Math.max(1, Math.round((BAND[2] - BAND[0]) * cw)),
        Math.max(1, Math.round((BAND[3] - BAND[1]) * ch)),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. the whole lap, at the shipped exposure                           */
/* ------------------------------------------------------------------ */

/**
 * Sample the lap at evenly spaced track positions and record what the frame is
 * doing at each. No preset is touched — this is the build exactly as it ships.
 * @param {{samples?: number, maxTicks?: number, shots?: number}} [opts]
 */
export async function range(opts = {}) {
  const N = opts.samples ?? 24;
  const maxTicks = opts.maxTicks ?? 20000;
  const S = await stage();
  const read = reader(S.canvas);

  const want = Array.from({ length: N }, (_, i) => i / N);
  const rows = [];
  let next = 0;
  let ticks = 0;

  try {
    // Let the field settle off the grid before sampling, or the first few points
    // are a start-line camera rather than a racing one.
    for (let i = 0; i < 180; i++) { S.tick(); ticks++; }

    while (next < N && ticks < maxTicks) {
      S.tick(); ticks++;
      const t = S.car.trackT ?? 0;
      // trackT wraps; take a sample the first time we are past each boundary.
      if (t >= want[next] || (next > 0 && t < want[next - 1] - 0.5)) {
        rows.push({
          t: +t.toFixed(4),
          lap: S.car.lap ?? null,
          frame: read.frame(),
          ground: read.ground(),
        });
        next++;
      }
    }
  } finally {
    S.restore();
  }

  const gm = rows.map((r) => r.ground.mean);
  const fm = rows.map((r) => r.frame.mean);
  const lo = rows[gm.indexOf(Math.min(...gm))];
  const hi = rows[gm.indexOf(Math.max(...gm))];

  return {
    exposure: +(S.renderer.toneMappingExposure ?? -1).toFixed(3),
    ticks,
    samples: rows.length,
    groundLuma: { min: Math.min(...gm), max: Math.max(...gm), span: +(Math.max(...gm) - Math.min(...gm)).toFixed(1) },
    frameLuma: { min: Math.min(...fm), max: Math.max(...fm) },
    // The two ends of the lap, which is what a playthrough would be judging.
    darkest: lo,
    brightest: hi,
    // Places where the frame is losing information at one end or the other.
    crushing: rows.filter((r) => r.frame.crushed > 20).map((r) => ({ t: r.t, crushed: r.frame.crushed, mean: r.frame.mean })),
    clipping: rows.filter((r) => r.frame.clipped > 2).map((r) => ({ t: r.t, clipped: r.frame.clipped, mean: r.frame.mean })),
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* 2. the exposure ramp, at one pose                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {{t?: number, values?: number[], prefix?: string, tol?: number}} [opts]
 */
export async function exposures(opts = {}) {
  const wantT = opts.t ?? 0.15;
  const tol = opts.tol ?? 0.02;
  const values = opts.values ?? [1.20, 1.55, 1.95, 2.35];
  const prefix = opts.prefix ?? 'd57x';

  const S = await stage();
  const read = reader(S.canvas);
  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS.nightLamp;
  const pristine = clone(P);
  const lighting = S.MG.ctx.lighting;

  let arrived = { ok: false, t: null, ticks: 0 };
  for (let i = 0; i < 12000; i++) {
    const t = S.car.trackT ?? 0;
    if (i > 120 && Math.abs(t - wantT) < tol) { arrived = { ok: true, t: +t.toFixed(4), ticks: i }; break; }
    S.tick();
    arrived.ticks = i;
    arrived.t = +(S.car.trackT ?? 0).toFixed(4);
  }
  if (!arrived.ok) { S.restore(); throw new Error(`never reached t=${wantT} (stopped at ${arrived.t})`); }

  // `base` first and last: the floor. Anything that moves between them is the
  // scheduler, not the exposure.
  const plan = [...values, values[0]];
  const rows = [];
  const shots = [];

  for (let i = 0; i < plan.length; i++) {
    const e = plan[i];
    Object.assign(P, clone(pristine));
    P.exposure = e;
    lighting.setPreset('nightLamp', { transition: 0 });
    S.engine.syncSystems?.();
    if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
    for (const c of (lighting.cascades || [])) c.light.shadow.needsUpdate = true;
    S.engine.renderFrame(0);
    S.engine.renderFrame(0);
    rows.push({
      exposure: e,
      isFloor: i === plan.length - 1,
      applied: +(S.renderer.toneMappingExposure ?? -1).toFixed(3),
      frame: read.frame(),
      ground: read.ground(),
    });
    shots.push({ name: `${prefix}-${i === plan.length - 1 ? 'floor' : String(e).replace('.', '')}`, url: S.canvas.toDataURL('image/png') });
  }

  Object.assign(P, clone(pristine));
  lighting.setPreset('nightLamp', { transition: 0 });
  S.engine.syncSystems?.();
  S.restore();

  const written = [];
  for (const s of shots) {
    const res = await fetch('/__shot?name=' + encodeURIComponent(s.name), { method: 'POST', body: s.url });
    written.push((await res.json()).path);
  }

  const first = rows[0], last = rows[rows.length - 1];
  return {
    arrived, rows, written,
    floorDelta: +(last.frame.mean - first.frame.mean).toFixed(2),
  };
}
