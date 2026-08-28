// Where does a frame's time actually go, and which frame is the one that hurts?
//
// D58 is "the game slows down / gets stuck". Every previous attempt to measure
// it here died on the same objection: this project's only browser runs the game
// in a hidden pane, where rAF is throttled to roughly 0.1 s of race per
// composite, so wall-clock frame pacing is Chrome's background policy and not
// the game's. That objection is real, and it killed the wrong measurement.
//
// It does not kill this one. Throttling changes WHEN a frame runs. It does not
// change how much CPU that frame's work costs once it starts. `_tick` is a
// single synchronous JS task; timing its inside is honest under any scheduler.
// So: stop the engine's rAF, drive `_tick` by hand off a synthetic 60 Hz clock,
// and time each one. Every tick then does exactly one fixed step, which removes
// the catch-up feedback loop and leaves pure per-frame work cost.
//
// What that CAN see: lazy material creation, first-sight shader compiles,
// cascade refits, per-frame allocation cliffs — anything synchronous inside the
// frame. Attribution comes from wrapping the engine's own phase methods, and
// from three's `info.programs.length`, which increments exactly when a shader
// compiles. A compile is the classic several-hundred-millisecond hitch and it
// is the one thing here that names itself.
//
// What that CANNOT see, and this is the honest limit of this tool:
// `requestIdleCallback` never fires while a synchronous loop owns the thread.
// The texture foundry's sharp re-bakes are drained from an idle callback, so a
// hand-driven sweep is blind to them by construction. They are measured
// separately by `bakeCost()` below, which is a straight stopwatch round an
// uninterruptible call and needs no scheduler at all. Do not read a quiet sweep
// as "there are no stalls" — read it as "there are no stalls INSIDE the frame".
//
//   const m = await import('/tools/tick-cost.js');
//   m.bakeCost();            // what one foundry bake costs, with its own floor
//   await m.run({ticks:1800});
//
// Every number below is CPU milliseconds measured with performance.now() around
// synchronous calls. Nothing here reports frame pacing, fps, or wall time
// between frames, because in this pane those would be lies.

const now = () => performance.now();

/* ========================================================================== */
/* One bake                                                                   */
/* ========================================================================== */
//
// The foundry hands out a magnified 256 draft immediately and queues the sharp
// bake for idle time. The sharp bake cannot be interrupted once started — see
// the comment on scheduleIdle in textures/Surfaces.js, which also notes that
// the first bake in a slice is taken before any deadline is consulted, because
// refusing to start would stall the queue forever.
//
// So the cost of one bake is the size of one stall the scheduler is allowed to
// take at any moment. Measure it directly.
//
// FLOOR AND CONTROL, in one call: every kind is baked, then immediately asked
// for again. The second call is the same function, the same timer and the same
// arguments, differing only in that the work is already done. If the repeat is
// not ~0 the stopwatch is measuring something ambient and the run is void.

/**
 * @param {{limit?: number}} [opts]
 * @returns {{floor: object[], bakes: object[], void: boolean}}
 */
export function bakeCost(opts = {}) {
  const S = window.MG?.surfaces;
  if (!S) throw new Error('no Surfaces');
  const limit = opts.limit ?? 6;

  const have = new Set(S.stats().sets.map((x) => x.kind));
  const fresh = (S.KINDS || []).filter((k) => !have.has(k)).slice(0, limit);

  const bakes = [];
  for (const k of fresh) {
    const t0 = now(); const set = S.ensure(k); const bake = now() - t0;
    const t1 = now(); S.ensure(k); const repeat = now() - t1;
    bakes.push({ kind: k, size: set?.size ?? null, bakeMs: +bake.toFixed(1), repeatMs: +repeat.toFixed(2) });
  }

  // A repeat that is not ~0 means the timer is picking up something other than
  // the bake, and every bakeMs beside it is worthless.
  const bad = bakes.filter((b) => b.repeatMs > 1);
  return { bakes, voided: bad.length > 0, voidedBy: bad };
}

/* ========================================================================== */
/* A lap, tick by tick                                                        */
/* ========================================================================== */

/**
 * Drive the engine by hand and record the CPU cost of every tick.
 * @param {{ticks?: number, hz?: number, hitchMs?: number, rw?: number, rh?: number}} [opts]
 */
export async function run(opts = {}) {
  const MG = window.MG;
  const engine = MG.engine;
  const renderer = engine.renderer;
  const hz = opts.hz ?? 60;
  const step = 1000 / hz;
  const maxTicks = opts.ticks ?? 1800;
  const hitchMs = opts.hitchMs ?? 8;

  const wasRunning = engine.running;
  const prevPR = renderer.getPixelRatio();
  const prevW = Math.round(renderer.domElement.width / prevPR);
  const prevH = Math.round(renderer.domElement.height / prevPR);

  // Split the frame by wrapping the engine's own phase methods. The engine
  // already times these, but it stores an EMA of each — and an EMA of a spike
  // is not a spike. A hitch is precisely the sample an EMA is designed to hide,
  // so the raw per-tick number has to be taken here.
  const split = { fixed: 0, update: 0, late: 0, render: 0 };
  const origFixed = engine._runFixed;
  const origPhase = engine._runPhase;
  const origRender = engine.renderFrame;
  engine._runFixed = function (...a) { const t = now(); try { return origFixed.apply(this, a); } finally { split.fixed += now() - t; } };
  engine._runPhase = function (name, ...a) {
    const t = now();
    try { return origPhase.call(this, name, ...a); }
    finally { const d = now() - t; if (name === 'lateUpdate') split.late += d; else split.update += d; }
  };
  engine.renderFrame = function (...a) { const t = now(); try { return origRender.apply(this, a); } finally { split.render += now() - t; } };

  engine.stop();
  if (engine.paused) engine.resume('tickcost');
  renderer.setPixelRatio(1);
  renderer.setSize(opts.rw ?? 1280, opts.rh ?? 720, false);
  engine.onResize?.(opts.rw ?? 1280, opts.rh ?? 720);
  engine.ctx?.postfx?.notifyCameraCut?.();

  const car = MG.ctx.player;
  const info = renderer.info;
  const S = MG.surfaces;

  const samples = [];
  const hitches = [];
  let clock = now();
  let prevPrograms = info.programs ? info.programs.length : 0;
  let prevPending = S?.stats?.().pending ?? 0;

  try {
    for (let i = 0; i < maxTicks; i++) {
      split.fixed = 0; split.update = 0; split.late = 0; split.render = 0;
      clock += step;
      const t0 = now();
      engine._tick(clock);
      const ms = now() - t0;

      const programs = info.programs ? info.programs.length : 0;
      const pending = S?.stats?.().pending ?? 0;
      const s = {
        i,
        ms: +ms.toFixed(2),
        fixed: +split.fixed.toFixed(2),
        update: +split.update.toFixed(2),
        late: +split.late.toFixed(2),
        render: +split.render.toFixed(2),
        t: +(car?.trackT ?? 0).toFixed(4),
        programs,
        dProgram: programs - prevPrograms,
        pending,
        dPending: pending - prevPending,
      };
      samples.push(s);
      if (ms >= hitchMs || s.dProgram !== 0 || s.dPending !== 0) hitches.push(s);
      prevPrograms = programs;
      prevPending = pending;
    }
  } finally {
    engine._runFixed = origFixed;
    engine._runPhase = origPhase;
    engine.renderFrame = origRender;
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevW, prevH, false);
    engine.onResize?.(prevW, prevH);
    engine.ctx?.postfx?.notifyCameraCut?.();
    if (wasRunning) engine.start();
  }

  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const q = (p) => +ms[Math.floor(p * (ms.length - 1))].toFixed(2);
  const sum = (k) => +(samples.reduce((a, s) => a + s[k], 0) / samples.length).toFixed(2);

  return {
    ticks: samples.length,
    cpuMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
    meanSplit: { fixed: sum('fixed'), update: sum('update'), late: sum('late'), render: sum('render') },
    programsStart: samples[0]?.programs ?? null,
    programsEnd: samples[samples.length - 1]?.programs ?? null,
    hitches: hitches.slice(0, 60),
    hitchCount: hitches.length,
    worst: samples.slice().sort((a, b) => b.ms - a.ms).slice(0, 12),
  };
}
