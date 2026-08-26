// Does the ramp's lip put energy into the cars? Counted, per step, per car.
//
// D19 says it does: five one-step speed gains of 12-15 u/s within a unit of
// kitchen's butterJump lip, on cars whose chassis was roughly 2 u INSIDE the
// ramp. The suspension finds ground by intersecting the strut with the tangent
// plane through a sampled point. At the lip the surface is not a plane, it is a
// cliff, and a sample that lands past the step describes a plane metres below
// where the wheel actually is.
//
// The detector does not need to know where the lip is, and the threshold is not
// a taste judgement. `speed` is |velocity|, the engine is a fixed 120 Hz step,
// and this project's gravity is a deliberate 260 u/s^2 (Settings.physics), so
// per step the honest ceilings are:
//
//   free fall            260 / 120       = 2.17 u/s
//   peak tyre traction   mu*g ~ 338 / 120 = 2.8  u/s
//
// A 12 u/s threshold is therefore about four times the largest change the game
// itself can produce in one step, and the only remaining source is the
// suspension pushing along a contact normal it should never have found. Where
// it happened is REPORTED rather than assumed, so "it is the lip" is
// falsifiable rather than decorative.
//
//   const m = await import('/tools/lip-probe.js'); await m.lipProbe({ seconds: 60 });
//
// Run it per seed, because the whole point is that this is intermittent:
//   /?track=kitchen&skipmenu=1&mute=1&seed=771
//
// TWO THINGS THIS FILE LEARNED THE HARD WAY, both of which made earlier
// versions of it useless:
//
// 1. A RESPAWN IS A ONE-STEP SPEED CHANGE OF EXACTLY THIS SHAPE. The first run
//    counted nine of them as injections -- car 0 jumping "from 2.1 to 17.8",
//    five times, always to the same 17.8, four wheels down, upright, on flat
//    ground. That is the recovery system doing its job. The signal that a
//    respawn happened is `_respawnCooldown` going UP: respawn() sets it to 0.6
//    unconditionally and nothing else ever raises it. `_lastRespawnAt` is not
//    the signal -- respawn() only writes it when it is allowed to escalate.
//
// 2. IN A BACKGROUNDED PANE A LONG SYNCHRONOUS LOOP IS INDISTINGUISHABLE FROM A
//    HANG. 7200 stepOnce() calls with no yields block the main thread past
//    every tool timeout, and the only way out is a reload. So it yields, and it
//    publishes progress on window.__lipProbe so a caller can poll instead of
//    waiting on a promise it cannot see. The yield is a MessageChannel and not
//    setTimeout(0): a backgrounded tab clamps timers hard -- measured here, a
//    setTimeout(0) yield cost about 13 SECONDS of wall clock, which turned a
//    7200-step run into ten minutes of nothing. MessageChannel is a macrotask
//    the throttle does not touch, so it hands the event loop back (tool calls
//    get served, progress is pollable) without paying for it.
//
// Reported:
//   injections  one-step speed gains over the threshold, with position
//   flips       cars that went inverted (up.y < 0) -- the visible consequence
//   nearLip     how many injections landed within `lipRadius` of a ramp exit,
//               which is the number that makes it D19 rather than something else
//   worst       the biggest single-step gain seen, whatever its size
//   skipped     steps not judged because a car was inside its respawn window

const STEP_HZ = 120;

export async function lipProbe(opts = {}) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const e = MG.engine, ctx = MG.ctx;
  const track = ctx?.track;
  const cars = [...(ctx?.vehicles || [])];
  if (!track || !cars.length) return { refused: 'no track or no cars yet' };

  const seconds = opts.seconds ?? 60;
  const threshold = opts.threshold ?? 12;      // u/s in ONE fixed step
  const lipRadius = opts.lipRadius ?? 3;       // world units from the ramp exit
  const yieldEvery = opts.yieldEvery ?? 240;   // steps between macrotask yields
  const steps = Math.round(seconds * STEP_HZ);

  // Where every ramp ENDS, in track parameter. Track.buildHazards already
  // resolves the span into t0/t1, so the exit is h.t1 and does not need
  // re-deriving from `length` here.
  const ramps = (track.hazards || [])
    .filter((h) => h.type === 'ramp')
    .map((h) => ({ id: h.id, t: +h.t.toFixed(4), exitT: +h.t1.toFixed(4), height: h.height }));
  const L = track.length || 1;

  const dir = ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('lip-probe');

  const prev = cars.map((c) => c.speed ?? 0);
  const wasUp = cars.map(() => true);
  const prevCool = cars.map((c) => c._respawnCooldown ?? 0);
  // A fix for the lip must not flatten the jump. Count every airborne
  // excursion and where it started, so "the injection is gone" can be told
  // apart from "the ramp stopped working".
  const wasAir = cars.map(() => false);
  const airborne = [];
  const injections = [];
  const flips = [];
  const respawns = [];
  let worst = 0, worstAt = null, skipped = 0;

  const progress = (window.__lipProbe = { running: true, step: 0, steps, injections: 0, respawns: 0 });

  try {
    for (let s = 0; s < steps; s++) {
      e.stepOnce?.();
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const sp = c.speed ?? 0;
        const gain = sp - prev[i];
        const cool = c._respawnCooldown ?? 0;
        const fired = cool > prevCool[i] + 1e-9;
        const inWindow = cool > 0;
        prevCool[i] = cool;
        if (fired) respawns.push({ step: s, car: i, trackT: fin(c.trackT, 4) });
        prev[i] = sp;
        // Judge nothing inside the respawn window: the teleport itself is a
        // step change, and the 0.6 s of grace after it is not normal driving.
        if (inWindow) { skipped++; continue; }

        if (gain > worst) { worst = gain; worstAt = { step: s, car: i, trackT: fin(c.trackT, 4) }; }
        if (gain >= threshold) {
          // Nearest ramp exit, measured along the track rather than assumed.
          // `trackT`, NOT `t`. The first version read `c.t`, which does not
          // exist on a vehicle, so every injection reported an identical
          // 465.5 u from the lip -- a constant dressed as a measurement, and
          // the giveaway that the geometry half of this probe was dead.
          let near = null, nearDist = Infinity, signed = null;
          const ct = c.trackT;
          if (Number.isFinite(ct)) {
            for (const r of ramps) {
              const dt = ((ct - r.exitT + 1.5) % 1) - 0.5;   // signed, +ve past the lip
              const d = Math.abs(dt) * L;
              if (d < nearDist) { nearDist = d; near = r.id; signed = +(dt * L).toFixed(1); }
            }
          }
          injections.push({
            step: s, car: i, gain: +gain.toFixed(2),
            to: +sp.toFixed(1),
            trackT: fin(ct, 4),
            y: fin(c.position?.y, 2),
            surfaceY: safeHeight(track, c.position),
            upY: fin(c.up?.y, 3),
            airborne: !!c.isAirborne,
            grounded: (c.wheelContacts || []).filter(Boolean).length,
            nearestRamp: near,
            distToLip: Number.isFinite(nearDist) ? +nearDist.toFixed(1) : null,
            pastLipU: signed,
          });
        }
        const air = !!c.isAirborne;
        if (air && !wasAir[i]) {
          let near = null, nd = Infinity;
          const at = c.trackT;
          if (Number.isFinite(at)) {
            for (const r of ramps) {
              const d = Math.abs(((at - r.exitT + 1.5) % 1) - 0.5) * L;
              if (d < nd) { nd = d; near = r.id; }
            }
          }
          airborne.push({ step: s, car: i, trackT: fin(at, 4), nearestRamp: near, distToLip: Number.isFinite(nd) ? +nd.toFixed(1) : null });
        }
        wasAir[i] = air;

        // A flip is counted once per excursion, not once per step it stays over.
        const up = (c.up?.y ?? 1) >= 0;
        if (wasUp[i] && !up) flips.push({ step: s, car: i, y: fin(c.position?.y, 2), trackT: fin(c.trackT, 4) });
        wasUp[i] = up;
      }
      if (s % yieldEvery === 0) {
        progress.step = s;
        progress.injections = injections.length;
        progress.respawns = respawns.length;
        await yieldToEventLoop();
      }
    }
  } finally {
    if (!wasPaused) e.resume?.('lip-probe');
    if (dir) dir.enabled = dirWas;
  }

  const nearLip = injections.filter((x) => x.distToLip !== null && x.distToLip <= lipRadius);
  const out = {
    seed: ctx?.seed ?? ctx?.rng?.seed ?? new URLSearchParams(location.search).get('seed'),
    track: track.id ?? null,
    seconds, steps, threshold, lipRadius,
    cars: cars.length,
    trackLengthU: +L.toFixed(1),
    ramps,
    injections: injections.length,
    nearLip: nearLip.length,
    flips: flips.length,
    respawns: respawns.length,
    respawnStepsSkipped: skipped,
    airborneExcursions: airborne.length,
    airborneAtLip: airborne.filter((a) => a.distToLip !== null && a.distToLip <= lipRadius * 4).length,
    worstStepGain: +worst.toFixed(2),
    worstAt,
    sample: injections.slice(0, 12),
    respawnSample: respawns.slice(0, 12),
    airborneSample: airborne.slice(0, 10),
    flipSample: flips.slice(0, 8),
  };
  progress.running = false;
  progress.result = out;
  return out;
}

// A macrotask yield that a background tab does not clamp. See the note above.
function yieldToEventLoop() {
  return new Promise((resolve) => {
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    } catch (err) {
      setTimeout(resolve, 0);
    }
  });
}

function fin(v, d) { return Number.isFinite(v) ? +v.toFixed(d) : null; }

function safeHeight(track, p) {
  try { return +track.heightAt(p.x, p.z).toFixed(2); }
  catch (err) { return null; }
}
