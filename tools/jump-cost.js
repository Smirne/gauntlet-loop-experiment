// What does a given jump shape COST over a real race?
//
// jump-shape.js measures one car's arc. This measures the thing that actually
// decided the ramp's height once already (D38): how many recoveries a full
// eight-car field pays at the jump over a race. The ramp was cut 8.5 -> 6.5 on
// that number alone, so a proposal to make it taller has to be answered in the
// same currency.
//
// It runs in CHUNKS on purpose. A 60 s race is 7200 steps and physics costs
// about 31 ms a step in this pane, so one call would block for minutes and be
// indistinguishable from a hang. Drive it as:
//
//   const m = await import('/tools/jump-cost.js');
//   m.begin({ height: 14, length: 30 });
//   m.run(900);   // repeat until done() says so
//   m.end();      // restores the shipping geometry, returns the report
//
// THE MESH DOES NOT FOLLOW the reshape — see jump-shape.js. That is fine here:
// nothing in this measurement looks at the road, the AI included, and the
// physics reads the hazard record every step.
//
// A respawn is counted at the jump when it fires within `nearT` of the ramp's
// centre. `_respawnCooldown` is the signal: respawn() sets it to 0.6
// unconditionally and it only ever decays, so a RISE is a recovery.
// `_respawnClock` ticks every step regardless and `_lastRespawnAt` is not
// written on the escalating path; both have misled this project before.

const STEP_HZ = 120;

let S = null;

export function begin(opts = {}) {
  const MG = window.MG;
  const ctx = MG?.ctx;
  const track = ctx?.track;
  const cars = [...(ctx?.vehicles || [])];
  if (!track || !cars.length) return { refused: 'no track or no cars yet' };

  const rampId = opts.ramp || 'butterJump';
  const ramp = (track.hazards || []).find((h) => h.type === 'ramp' && h.id === rampId);
  if (!ramp) return { refused: 'no such ramp', want: rampId, track: track.id };

  if (S) end();

  const L = track.length || 1;
  const orig = { height: ramp.height, length: ramp.length, halfSpanT: ramp.halfSpanT, t0: ramp.t0, t1: ramp.t1 };
  const height = opts.height ?? orig.height;
  const length = opts.length ?? orig.length;

  ramp.height = height;
  ramp.length = length;
  ramp.halfSpanT = (length * 0.5) / L;
  ramp.t0 = wrap01(ramp.t - ramp.halfSpanT);
  ramp.t1 = wrap01(ramp.t + ramp.halfSpanT);

  const e = MG.engine;
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('jump-cost');

  try { ctx.race?.start?.({ skipCountdown: true, autopilot: true }); } catch (_) { /* measure what there is */ }

  S = {
    MG, ctx, track, cars, ramp, orig, L, wasPaused,
    height, length,
    // Half-window, in lap fraction, that counts as "at the jump". 0.02 of this
    // circuit is about 18 u either side of the ramp centre — the ramp itself
    // plus its landing zone, and narrow enough that the milk sheet at t 0.322
    // cannot leak into it.
    nearT: opts.nearT ?? 0.02,
    totalSteps: Math.round((opts.seconds ?? 60) * STEP_HZ),
    done: 0,
    cool: cars.map((c) => c._respawnCooldown ?? 0),
    respawns: [],
    flips: [],
    wasFlipped: cars.map(() => false),
  };
  return { height, length, exitDeg: exitDeg(height, length), totalSteps: S.totalSteps, cars: cars.length };
}

/** Advance `n` steps. Returns progress; call until `remaining` is 0. */
export function run(n = 900) {
  if (!S) return { refused: 'call begin() first' };
  const { MG, track, cars, ramp, L } = S;
  const e = MG.engine;
  const limit = Math.min(n, S.totalSteps - S.done);
  for (let k = 0; k < limit; k++) {
    e.stepOnce?.();
    S.done++;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const cool = c._respawnCooldown ?? 0;
      if (cool > S.cool[i] + 1e-9) {
        const d = Math.abs(cyclic(c.trackT, ramp.t));
        S.respawns.push({ step: S.done, car: i, dT: +d.toFixed(4), atJump: d <= S.nearT });
      }
      S.cool[i] = cool;

      // A flip is counted once per excursion, not once per step.
      const flipped = !!(c.up && c.up.y < 0.2);
      if (flipped && !S.wasFlipped[i]) {
        const d = Math.abs(cyclic(c.trackT, ramp.t));
        S.flips.push({ step: S.done, car: i, dT: +d.toFixed(4), atJump: d <= S.nearT });
      }
      S.wasFlipped[i] = flipped;
    }
  }
  return { done: S.done, remaining: S.totalSteps - S.done, respawns: S.respawns.length, flips: S.flips.length };
}

/** Restore the shipping geometry and report. Safe to call twice. */
export function end() {
  if (!S) return { refused: 'nothing running' };
  const { MG, ramp, orig, wasPaused } = S;
  Object.assign(ramp, orig);
  if (!wasPaused) MG.engine.resume?.('jump-cost');
  const out = {
    height: S.height,
    length: S.length,
    exitDeg: exitDeg(S.height, S.length),
    seconds: +(S.done / STEP_HZ).toFixed(1),
    steps: S.done,
    complete: S.done >= S.totalSteps,
    cars: S.cars.length,
    respawnsTotal: S.respawns.length,
    respawnsAtJump: S.respawns.filter((r) => r.atJump).length,
    flipsTotal: S.flips.length,
    flipsAtJump: S.flips.filter((f) => f.atJump).length,
    atJump: S.respawns.filter((r) => r.atJump),
  };
  S = null;
  return out;
}

export function state() {
  return S ? { done: S.done, remaining: S.totalSteps - S.done, height: S.height, length: S.length } : null;
}

function exitDeg(height, length) {
  return +(Math.atan2(0.82 * height, length) * 180 / Math.PI).toFixed(1);
}
function wrap01(x) { const y = x % 1; return y < 0 ? y + 1 : y; }
function cyclic(a, b) { let d = (a - b) % 1; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return d; }
