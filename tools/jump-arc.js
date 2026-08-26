// Does the jump still jump?
//
// D19's fix stops the strut believing a tangent plane that has fallen off a
// cliff, and part of what that plane was doing was launching cars. Removing a
// fault that was ALSO doing something the game wanted is not automatically an
// improvement, and counting airborne excursions over a stochastic race does not
// settle it: a 25 s race gives each car about one crossing, and the count moved
// 7 to 1 between the two builds, which is either "the jump is gone" or "eight
// samples of a noisy thing".
//
// So this measures the arc directly, one car, one launch, no AI:
//
//   put the car on the approach, hold the throttle, step it over the lip, and
//   record how high it got, how long it was in the air, and how far past the
//   lip it landed.
//
// It takes a couple of seconds and it is deterministic, so the same run on
// ?rawSuspension=1 and without is a real A/B of one build.
//
//   const m = await import('/tools/jump-arc.js'); await m.jumpArc();
//
// CAVEAT, and it limits what the `speeds` option is worth: the approach is 90 u
// at full throttle, which is long enough that every entry speed from 30 to 90
// arrives at the lip doing 59-62. The sweep therefore measures one arrival
// speed several times over. That arrival speed is a realistic one, so "no air
// at race pace" is a fair reading of it; "no air at any speed" is not. Shorten
// `approachU` if the slow crossings are what matters.

const STEP_HZ = 120;

export async function jumpArc(opts = {}) {
  const MG = window.MG;
  const ctx = MG?.ctx;
  const track = ctx?.track;
  const cars = [...(ctx?.vehicles || [])];
  if (!track || !cars.length) return { refused: 'no track or no cars yet' };

  const ramp = (track.hazards || []).find((h) => h.type === 'ramp' && (!opts.ramp || h.id === opts.ramp));
  if (!ramp) return { refused: 'no ramp to jump', track: track.id };

  const L = track.length || 1;
  const v = cars[opts.car ?? 0];
  const approachU = opts.approachU ?? 90;      // start this far before the lip
  const steps = opts.steps ?? 420;
  const speeds = opts.speeds ?? [40, 55, 70];

  const e = MG.engine;
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('jump-arc');
  const dir = ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;

  // TAKE THE CONTROLS AWAY FROM EVERYONE ELSE.
  //
  // Car 0 is the player, so the input system writes its controls every step and
  // an outside caller setting throttle before stepOnce() is simply overwritten.
  // Measured before this was noticed: the car entered at 55 u/s, was down to
  // 14.6 by step 40 and 10.8 by step 160, and never reached the ramp — a
  // full-throttle run in which the throttle was never applied.
  //
  // So the setter is blocked for the duration and driven from here through the
  // real one. Every OTHER car is frozen, so nothing can touch the one on test.
  const realSetControls = v.setControls.bind(v);
  v.setControls = function blocked() { return this; };
  const frozenWas = cars.map((c) => c.frozen);
  for (let i = 0; i < cars.length; i++) if (cars[i] !== v) cars[i].frozen = true;

  const runs = [];
  try {
    for (const speed of speeds) {
      const startT = wrap01(ramp.t1 - approachU / L);
      v.respawn(startT, { lateral: 0, keepSpeed: 0, minSpeed: 0, silent: true, noEscalate: true });
      // respawn() launches at a fraction of top speed; overwrite with the exact
      // entry speed this run is about, so the three runs differ by one thing.
      v.velocity.copy(v.forward).multiplyScalar(speed);
      v.speed = speed;
      v.forwardSpeed = speed;

      let airStart = -1, airEnd = -1, apex = 0, apexAt = null, launchT = null;
      let wasAir = true, exitSpeed = null, maxGain = 0, armedAt = -1;
      let prevSpeed = speed;
      for (let s = 0; s < steps; s++) {
        realSetControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0, boost: 0 });
        e.stepOnce?.();
        const gain = (v.speed ?? 0) - prevSpeed;
        const pastLip = signedU(v.trackT, ramp.t1, L);

        // ARM ONLY ONCE THE CAR IS ACTUALLY ON THE APPROACH. respawn() drops the
        // car in from above, so it is airborne for the first ten steps of every
        // run; the first version of this file recorded that drop as the jump,
        // reported an identical 2.53 u "apex" at -90 u for all three entry
        // speeds, and then broke out of the loop 30 steps later without ever
        // reaching the ramp. Three impossible-looking identical numbers are how
        // it announced itself.
        if (armedAt < 0) {
          if (pastLip > -20 && !v.isAirborne) { armedAt = s; wasAir = false; prevSpeed = v.speed ?? 0; }
          continue;
        }

        if (gain > maxGain) maxGain = gain;
        prevSpeed = v.speed ?? 0;
        if (exitSpeed === null && pastLip >= 0) exitSpeed = +(v.speed ?? 0).toFixed(1);

        const air = !!v.isAirborne;
        if (air && !wasAir && airStart < 0) { airStart = s; launchT = +pastLip.toFixed(1); }
        if (!air && wasAir && airEnd < 0 && airStart >= 0) airEnd = s;
        wasAir = air;

        if (air) {
          let ground = 0;
          try { ground = track.heightAt(v.position.x, v.position.z); } catch (_) { ground = 0; }
          const h = v.position.y - ground;
          if (h > apex) { apex = h; apexAt = +pastLip.toFixed(1); }
        }
        if (airEnd >= 0 && s > airEnd + 30) break;
      }
      runs.push({
        entrySpeed: speed,
        exitSpeed,
        launchedAtU: launchT,
        apexU: +apex.toFixed(2),
        apexAtU: apexAt,
        armedAtStep: armedAt,
        airSteps: airStart >= 0 ? (airEnd >= 0 ? airEnd - airStart : steps - airStart) : 0,
        airSeconds: +((airStart >= 0 ? (airEnd >= 0 ? airEnd - airStart : steps - airStart) : 0) / STEP_HZ).toFixed(3),
        landedAtU: airEnd >= 0 ? +signedU(v.trackT, ramp.t1, L).toFixed(1) : null,
        worstStepGain: +maxGain.toFixed(2),
      });
    }
  } finally {
    delete v.setControls;
    for (let i = 0; i < cars.length; i++) cars[i].frozen = frozenWas[i];
    if (dir) dir.enabled = dirWas;
    if (!wasPaused) e.resume?.('jump-arc');
  }

  return {
    track: track.id,
    ramp: ramp.id, rampHeight: ramp.height, lipT: +ramp.t1.toFixed(5),
    rawSuspension: new URLSearchParams(location.search).get('rawSuspension') === '1',
    approachU, steps,
    runs,
  };
}

function wrap01(x) { const y = x % 1; return y < 0 ? y + 1 : y; }
function signedU(t, ref, L) { return (((t - ref + 1.5) % 1) - 0.5) * L; }
