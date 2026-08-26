// Where does the suspension think the ground is, near the lip of a ramp?
//
// D19 says the ramp's lip injects energy, and names a mechanism: the strut
// finds ground by intersecting its axis with the TANGENT PLANE through a
// sampled (x, z). That is exact on anything locally planar and wrong at a
// cliff, and Track.hazardHeight builds a ramp with a cliff on purpose --
// `dy += h.height * toe * (0.18 + 0.82 * x) * w` for x in 0..1, cut abruptly to
// zero past the span. On kitchen's butterJump that step is 6.5 u.
//
// lip-probe.js answers "does it still happen over a race" and costs about a
// quarter of an hour per seed, because 7200 physics steps in a backgrounded
// pane run at roughly eight a second. This answers the different and more
// useful question -- "is the mechanism real, and where in the configuration
// space does it bite" -- in about a tenth of a second, and it does it without
// any driving at all:
//
//   put the car at a chosen place AND ATTITUDE, ask _probeWheels() where the
//   ground is, then ask the track how high the ground actually is AT THE POINT
//   THE SUSPENSION PICKED.
//
// If the solver is right those two agree and the contact patch lies on the
// surface. Every unit they disagree by is spring travel the game invented.
//
// THE ATTITUDE SWEEP IS THE POINT, and leaving it out is how the first version
// of this file concluded, wrongly, that there was nothing here. A car settled
// flat on the track has its struts nearly normal to the surface, which is the
// case the tangent-plane solve handles perfectly -- 940 samples across the lip,
// worst error 0.000. A car AT a lip is not that car: it is pitched nose-up,
// often rolled, often already off the ground, with its struts raking obliquely
// at a surface that has just fallen away behind it. That is the case the
// approximation is bad at, and it only appears if you put the car in it.
//
//   const m = await import('/tools/lip-solve.js'); m.lipSolve();
//
// The floor is measured in the same run, with the same grid, on quiet track --
// a tangent-plane solve is an approximation everywhere, not only at a lip, and
// a number with no floor under it is how this project nearly filed a wrong
// cause for D49.

export function lipSolve(opts = {}) {
  const MG = window.MG;
  const ctx = MG?.ctx;
  const track = ctx?.track;
  const cars = [...(ctx?.vehicles || [])];
  if (!track || !cars.length) return { refused: 'no track or no cars yet' };

  const v = cars[opts.car ?? 0];
  const t = v.tuning;
  const L = track.length || 1;
  const G = ctx.settings?.physics?.gravity ?? 260;
  const bumpTravel = t.suspRest * 0.88;
  const reach = t.suspRest + v.wheels[0].radius;
  const staticComp = v._staticComp ?? t.suspRest * 0.35;

  const samples = opts.samples ?? 80;
  const spanU = opts.spanU ?? 60;
  const laterals = opts.laterals ?? [0];
  const pitches = opts.pitches ?? [-25, -15, -5, 0, 5, 15, 25];
  const rolls = opts.rolls ?? [0, 12];
  const lifts = opts.lifts ?? [0, 1, 3, 6];

  const ramps = (track.hazards || []).filter((h) => h.type === 'ramp');
  if (!ramps.length) return { refused: 'this track has no ramps', track: track.id };

  const THREE = MG.THREE;
  const _m = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _ax = new THREE.Vector3();

  const e = MG.engine;
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('lip-solve');
  const home = { p: v.position.clone(), q: v.quaternion.clone(), vel: v.velocity.clone() };

  /** One placement. Returns the per-wheel rows it produced, or null. */
  function sample(tt, lateral, pitchDeg, rollDeg, lift, ref) {
    try {
      v.respawn(tt, { lateral, keepSpeed: 0, minSpeed: 0, silent: true, noEscalate: true });
    } catch (err) { return null; }
    v.velocity.set(0, 0, 0);
    v.angularVelocity.set(0, 0, 0);
    // Respawn HOVERS the car (cgHeight + 0.6, then another 0.35 along up),
    // which is right for dropping a car back into a race and useless as a
    // starting attitude. Settle it onto its springs first, then tilt and lift
    // from there, so every configuration is measured relative to a real ride
    // height rather than to an arbitrary drop point.
    if (!settle(v, reach, staticComp)) return null;

    if (pitchDeg || rollDeg) {
      // Pitch about the car's own lateral axis, roll about its own forward, so
      // the attitude means the same thing wherever on the lap it is applied.
      // The basis is (left, up, forward) -- there is no `right`.
      if (pitchDeg) {
        _ax.copy(v.left);
        v.quaternion.premultiply(_q.setFromAxisAngle(_ax.normalize(), pitchDeg * Math.PI / 180));
      }
      if (rollDeg) {
        _ax.copy(v.forward);
        v.quaternion.premultiply(_q.setFromAxisAngle(_ax.normalize(), rollDeg * Math.PI / 180));
      }
      v._syncBasis?.();
    }
    if (lift) v.position.addScaledVector(v.up, lift);

    try { v._probeWheels(); } catch (err) { return null; }

    const rows = [];
    for (let wi = 0; wi < 4; wi++) {
      const w = v.wheels[wi];
      // VALIDATE THE PLACEMENT BEFORE BELIEVING THE PROBE. If the mount is
      // already under the ground the strut is being asked an unfair question,
      // and any error it reports belongs to the placement. An early version of
      // this file reported a 1.17 u "solver error" that was entirely this.
      _m.set(w.localX, w.localY, w.localZ).applyQuaternion(v.quaternion).add(v.position);
      let mountGround;
      try { mountGround = track.heightAt(_m.x, _m.z); } catch (err) { continue; }
      if (!Number.isFinite(mountGround)) continue;
      const clearance = _m.y - mountGround;
      if (clearance <= 0) { ref.buried++; continue; }
      if (!w.grounded) { ref.ungrounded++; continue; }

      let truth;
      try { truth = track.heightAt(w.contactX, w.contactZ); } catch (err) { continue; }
      if (!Number.isFinite(truth)) continue;
      // Negative error = the patch is BELOW the ground it is meant to rest on,
      // i.e. inside the ramp, which is the direction that fakes compression.
      const err = w.contactY - truth;
      // The force the game would actually apply, by the game's own formula
      // (Vehicle._suspension): spring plus bump stop, same ceiling. The damper
      // is omitted because this is a static placement, so the rate is zero.
      let force = t.springRate * w.compression;
      if (w.compression > bumpTravel) {
        const over = w.compression - bumpTravel;
        force += t.bumpStopRate * over * over * 3;
      }
      force = Math.min(force, t.mass * G * 8);
      rows.push({
        pastLipU: +signedU(tt, ref.lipT, L).toFixed(1),
        lateral, pitch: pitchDeg, roll: rollDeg, lift, wheel: wi,
        err: +err.toFixed(3),
        clearance: +clearance.toFixed(2),
        contactDist: +w.contactDistance.toFixed(3),
        clamped: w.contactDistance <= -2 + 1e-6,
        compression: +w.compression.toFixed(3),
        dvPerStep: +((force / t.mass) / 120).toFixed(2),
      });
    }
    return rows;
  }

  /** The whole grid, centred on `centreT`. */
  function sweep(centreT, lipT) {
    const ref = { buried: 0, ungrounded: 0, unsettled: 0, lipT };
    const rows = [];
    const dT = (spanU * 0.5) / L;
    for (let i = 0; i <= samples; i++) {
      const tt = wrap01(centreT - dT + (i / samples) * dT * 2);
      for (const lateral of laterals) {
        for (const pitchDeg of pitches) {
          for (const rollDeg of rolls) {
            for (const lift of lifts) {
              const r = sample(tt, lateral, pitchDeg, rollDeg, lift, ref);
              if (r === null) { ref.unsettled++; continue; }
              for (const row of r) rows.push(row);
            }
          }
        }
      }
    }
    rows.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
    const clamped = rows.filter((r) => r.clamped);
    return {
      placements: (samples + 1) * laterals.length * pitches.length * rolls.length * lifts.length,
      samplesJudged: rows.length,
      ungrounded: ref.ungrounded, buried: ref.buried, unsettled: ref.unsettled,
      worstErr: rows.length ? rows[0].err : null,
      medianAbsErr: rows.length ? +Math.abs(rows[Math.floor(rows.length / 2)].err).toFixed(3) : null,
      overHalfUnit: rows.filter((r) => Math.abs(r.err) > 0.5).length,
      overOneUnit: rows.filter((r) => Math.abs(r.err) > 1).length,
      clampedSamples: clamped.length,
      worstDvPerStep: rows.length ? Math.max(...rows.map((r) => r.dvPerStep)) : 0,
      top: rows.slice(0, 10),
    };
  }

  const out = [];
  let baseline = null;
  let quietT = null;
  try {
    for (const h of ramps) out.push({ ramp: h.id, height: h.height, lipT: +h.t1.toFixed(5), ...sweep(h.t1, h.t1) });

    // The floor: the same grid on quiet track. The chosen t has to be one the
    // car can actually be placed on, so candidates are tried furthest-first
    // until one settles rather than trusting the first guess -- the previous
    // version picked t = 0.743 blind and every one of its 903 placements failed
    // to find ground, leaving the claim with no floor at all.
    for (const cand of quietCandidates(ramps.map((h) => h.t))) {
      const probe = sample(cand, laterals[0], 0, 0, 0, { buried: 0, ungrounded: 0, unsettled: 0, lipT: cand });
      if (probe && probe.length) { quietT = cand; break; }
    }
    if (quietT !== null) baseline = { atT: +quietT.toFixed(5), ...sweep(quietT, quietT) };
  } finally {
    v.position.copy(home.p);
    v.quaternion.copy(home.q);
    v.velocity.copy(home.vel);
    v._syncBasis?.();
    if (!wasPaused) e.resume?.('lip-solve');
  }

  return {
    track: track.id, car: opts.car ?? 0,
    springRate: t.springRate, bumpStopRate: t.bumpStopRate, mass: t.mass,
    suspRest: t.suspRest, gravity: G,
    grid: { samples, spanU, laterals, pitches, rolls, lifts },
    baseline,
    ramps: out,
  };
}

/**
 * Lower (or raise) the car along its own up until the mean strut carries the
 * static load. Returns false if the struts cannot find ground at all, so the
 * caller drops the sample instead of measuring a car in mid-air.
 */
function settle(v, reach, staticComp) {
  const target = reach - staticComp;
  for (let k = 0; k < 6; k++) {
    try { v._probeWheels(); } catch (err) { return false; }
    let sum = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      const d = v.wheels[i].contactDistance;
      if (Number.isFinite(d) && d < v._maxRay) { sum += d; n++; }
    }
    if (!n) return false;
    const drop = sum / n - target;
    if (Math.abs(drop) < 0.01) return true;
    v.position.addScaledVector(v.up, -Math.max(-8, Math.min(8, drop)));
  }
  return true;
}

/** Lap fractions ordered by how far they are from every listed hazard centre. */
function quietCandidates(ts) {
  const out = [];
  for (let i = 0; i < 180; i++) {
    const t = i / 180;
    let gap = 1;
    for (const o of ts) {
      const d = Math.abs(((t - o + 1.5) % 1) - 0.5);
      if (d < gap) gap = d;
    }
    out.push({ t, gap });
  }
  out.sort((a, b) => b.gap - a.gap);
  return out.map((x) => x.t);
}

function wrap01(x) { const y = x % 1; return y < 0 ? y + 1 : y; }
function signedU(t, ref, L) { return (((t - ref + 1.5) % 1) - 0.5) * L; }
