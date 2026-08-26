// What shape does butterJump have to be to actually be a jump?
//
// D19's fix stopped the strut believing a tangent plane that had fallen off the
// ramp's lip, and that plane was what had been throwing cars into the air. With
// it gone the ramp launches nothing, which is what its geometry always said it
// should do: 6.5 u of climb over 30 u is a 10 degree exit.
//
// So the question stops being a defect and becomes a design one, and a design
// question deserves a table rather than an opinion. This sweeps candidate
// geometries and reports what each one actually does to a car at race pace.
//
//   const m = await import('/tools/jump-shape.js'); await m.jumpShape();
//
// HOW IT CHEATS, AND WHAT THAT COSTS.
//
// It mutates the resolved hazard record in place — height, length, and the t
// span derived from length — so every candidate is measured on ONE boot with
// nothing else different. The physics reads those fields through heightAt every
// step, so the car feels the new ramp immediately.
//
// The MESH DOES NOT FOLLOW. The road was triangulated at build time and is
// still the old shape on screen. That makes this instrument fine for numbers
// and worthless for pictures: never screenshot from it. To LOOK at a candidate,
// reload with `?hazardGeom=butterJump:height=14,length=24`, which reshapes it
// before the mesh is built.
//
// The approach is 90 u at full throttle, so entry speed converges: every run
// arrives at the toe doing about 60 regardless of where it started. That is a
// realistic arrival speed, and it is the only one this measures.

const STEP_HZ = 120;

export async function jumpShape(opts = {}) {
  const MG = window.MG;
  const ctx = MG?.ctx;
  const track = ctx?.track;
  const cars = [...(ctx?.vehicles || [])];
  if (!track || !cars.length) return { refused: 'no track or no cars yet' };

  const rampId = opts.ramp || 'butterJump';
  const ramp = (track.hazards || []).find((h) => h.type === 'ramp' && h.id === rampId);
  if (!ramp) return { refused: 'no such ramp', want: rampId, track: track.id };

  const L = track.length || 1;
  const v = cars[opts.car ?? 0];
  const approachU = opts.approachU ?? 90;
  const steps = opts.steps ?? 480;
  // How far past the lip still counts as the jump. Beyond this the run is a
  // straight-line car heading for a corner it will not take.
  const windowU = opts.windowU ?? 60;

  // Candidates. `height` is the climb, `length` the run it climbs over; the
  // exit slope the car leaves on is 0.82 * height / length (the 0.82 is the
  // linear part of hazardHeight's toe-then-climb profile).
  const shapes = opts.shapes ?? [
    { height: 6.5, length: 30 },   // shipping
    { height: 6.5, length: 18 },
    { height: 6.5, length: 12 },
    { height: 10, length: 24 },
    { height: 14, length: 30 },
    { height: 14, length: 22 },
    { height: 20, length: 30 },
  ];

  const e = MG.engine;
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('jump-shape');
  const dir = ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;

  // A fresh page sits in ATTRACT with the whole field held, and a held car does
  // not integrate. The first version of this file did not notice: every run came
  // back with `toeSpeed: null`, `airSeconds: 0` and `worstStepGain: 0` for every
  // candidate, which reads exactly like "no shape jumps" and is instead "the
  // car never moved". Start the race, and unfreeze the one on test explicitly
  // rather than trusting the state it was found in.
  const startedRace = ctx?.race?.state === 'attract';
  if (startedRace) { try { ctx.race.start({ skipCountdown: true, autopilot: true }); } catch (_) { /* keep going */ } }

  // Same isolation as jump-arc: car 0 is the player, so the input system
  // overwrites any throttle an outside caller sets. Block the setter, drive
  // through the captured real one, freeze everybody else.
  const realSetControls = v.setControls.bind(v);
  v.setControls = function blocked() { return this; };
  const frozenWas = cars.map((c) => c.frozen);
  for (let i = 0; i < cars.length; i++) cars[i].frozen = cars[i] !== v;

  const orig = { height: ramp.height, length: ramp.length, halfSpanT: ramp.halfSpanT, t0: ramp.t0, t1: ramp.t1 };
  const rows = [];
  try {
    for (const shape of shapes) {
      reshape(ramp, shape, L);
      rows.push({ ...shape, exitDeg: exitDeg(shape), ...launch(), });
    }
  } finally {
    Object.assign(ramp, orig);
    delete v.setControls;
    for (let i = 0; i < cars.length; i++) cars[i].frozen = frozenWas[i];
    if (dir) dir.enabled = dirWas;
    if (!wasPaused) e.resume?.('jump-shape');
  }

  return {
    track: track.id,
    ramp: ramp.id,
    shipping: { height: orig.height, length: orig.length, exitDeg: exitDeg(orig) },
    approachU,
    startedRace,
    meshFollowed: false,
    note: 'numbers only — the road mesh is still the shipping shape. Reload with '
        + '?hazardGeom=' + rampId + ':height=H,length=N to look at one.',
    rows,
  };

  /** One full-throttle crossing of whatever shape the ramp currently is. */
  function launch() {
    // REPAIR BETWEEN CANDIDATES. A shape that flips the car damages it, and a
    // damaged car climbs the NEXT ramp slower: the same 14 x 30 measured 54.4
    // u/s at the toe in one sequence and 51.5 in another, purely because of what
    // preceded it. Repeated back to back the runs agree to three decimals, so
    // the variation was carried in, not noise. Race does the same thing between
    // heats for the same reason.
    try { v.repair?.(); } catch (_) { /* a build without repair() still measures */ }
    const startT = wrap01(ramp.t1 - approachU / L);
    v.respawn(startT, { lateral: 0, keepSpeed: 0, minSpeed: 0, silent: true, noEscalate: true });
    v.velocity.copy(v.forward).multiplyScalar(60);
    v.speed = 60;
    v.forwardSpeed = 60;

    // RE-ANCHOR THE STUCK WATCHDOGS. Each run teleports the car ~150 u
    // BACKWARDS along the lap, and `_checkNoProgress` measures net forward
    // advance against an anchor that respawn() does not clear — so the car has
    // to re-cover all 150 u before it counts as having gone anywhere, and if
    // that takes longer than `stuckProgressDelay` the game recovers a car that
    // is driving perfectly well. Measured: the third candidate in a sweep came
    // back recovered 30 u BEFORE the ramp, with null speeds, which would read
    // as "this shape produced no air".
    // `_progressT = NaN` is the documented "anchor me fresh next step" value.
    v._progressT = NaN;
    v._noProgress = 0;
    v._offTrackDwell = 0;

    let armed = -1, wasAir = true, airStart = -1, airEnd = -1;
    let apex = 0, apexAt = null, toeSpeed = null, exitSpeed = null;
    let maxGain = 0, prevSpeed = 60, minUpY = 1;
    // `_respawnCooldown` is set to 0.6 unconditionally inside respawn() and only
    // ever decays, so a RISE in it is the one reliable "this car was recovered"
    // signal. `_lastRespawnAt` is not written on the escalating path and
    // `_respawnClock` ticks every step whether or not anything happened.
    let prevCool = v._respawnCooldown ?? 0;
    let recovered = false, recoveredAtU = null;

    for (let s = 0; s < steps; s++) {
      realSetControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0, boost: 0 });
      e.stepOnce?.();
      const pastLip = signedU(v.trackT, ramp.t1, L);

      // respawn() drops the car in from above, so it is airborne for the first
      // several steps of every run. Arming on the approach is what keeps that
      // drop out of the arc.
      if (armed < 0) {
        if (pastLip > -(approachU - 20) && !v.isAirborne) {
          armed = s; wasAir = false; prevSpeed = v.speed ?? 0; prevCool = v._respawnCooldown ?? 0;
        }
        continue;
      }

      // STOP THE MOMENT THE CAR IS RECOVERED, and stop before the corner.
      //
      // Full throttle with no steering means the car leaves the road a few
      // seconds past the ramp and gets respawned — and respawn drops it in from
      // above, which registers as an airborne excursion. Measured before this
      // was noticed: the 6.5 x 12 candidate reported 0.083 s of air with its
      // apex 46 u PAST the lip, which is not a jump, it is the recovery. That
      // 2.53 u apex is the same number jump-arc's first version reported for
      // all three of its entry speeds; it is the signature of the drop.
      const cool = v._respawnCooldown ?? 0;
      if (cool > prevCool + 1e-9) { recovered = true; recoveredAtU = +pastLip.toFixed(1); break; }
      prevCool = cool;

      // Past the landing zone and back on the ground: nothing after this belongs
      // to the jump.
      if (pastLip > windowU && !v.isAirborne) break;

      const gain = (v.speed ?? 0) - prevSpeed;
      if (gain > maxGain) maxGain = gain;
      prevSpeed = v.speed ?? 0;

      if (toeSpeed === null && pastLip >= -ramp.length) toeSpeed = +(v.speed ?? 0).toFixed(1);
      if (exitSpeed === null && pastLip >= 0) exitSpeed = +(v.speed ?? 0).toFixed(1);

      const air = !!v.isAirborne;
      if (air && !wasAir && airStart < 0) airStart = s;
      if (!air && wasAir && airEnd < 0 && airStart >= 0) airEnd = s;
      wasAir = air;

      if (air) {
        let ground = 0;
        try { ground = track.heightAt(v.position.x, v.position.z); } catch (_) { ground = 0; }
        const h = v.position.y - ground;
        if (h > apex) { apex = h; apexAt = +pastLip.toFixed(1); }
      }
      // Landing attitude: up.y is 1 upright, 0 on its side, -1 inverted.
      if (airStart >= 0 && v.up && v.up.y < minUpY) minUpY = v.up.y;

      if (airEnd >= 0 && s > airEnd + 60) break;
    }

    const airSteps = airStart >= 0 ? (airEnd >= 0 ? airEnd - airStart : steps - airStart) : 0;
    return {
      // A run the car did not complete cleanly is VOID, not a zero. Reporting
      // it as 0 s of air is how an instrument talks itself into a conclusion.
      void: armed < 0 || (recovered && recoveredAtU !== null && recoveredAtU < 0) || exitSpeed === null,
      // A null armedAtStep means the car never reached the approach on its
      // wheels, which is a BROKEN RUN, not a jump that produced no air.
      armedAtStep: armed < 0 ? null : armed,
      toeSpeed,
      exitSpeed,
      airSeconds: +(airSteps / STEP_HZ).toFixed(3),
      apexU: +apex.toFixed(2),
      apexAtU: apexAt,
      landedAtU: airEnd >= 0 ? +signedU(v.trackT, ramp.t1, L).toFixed(1) : null,
      worstStepGain: +maxGain.toFixed(2),
      minUpY: +minUpY.toFixed(3),
      recovered,
      recoveredAtU,
    };
  }
}

/** Height, length and every field buildHazards derived from length. */
function reshape(ramp, shape, L) {
  ramp.height = shape.height;
  ramp.length = shape.length;
  ramp.halfSpanT = (shape.length * 0.5) / L;
  ramp.t0 = wrap01(ramp.t - ramp.halfSpanT);
  ramp.t1 = wrap01(ramp.t + ramp.halfSpanT);
}

/** The angle the road leaves at, in degrees. See hazardHeight. */
function exitDeg(shape) {
  return +(Math.atan2(0.82 * shape.height, shape.length) * 180 / Math.PI).toFixed(1);
}

function wrap01(x) { const y = x % 1; return y < 0 ? y + 1 : y; }
function signedU(t, ref, L) { return (((t - ref + 1.5) % 1) - 0.5) * L; }
