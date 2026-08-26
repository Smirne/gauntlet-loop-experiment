// What does a jump shape LOOK like? Three frames, at three events, on the
// game's own chase camera.
//
// jump-shape.js and jump-cost.js answer "what does it do" in numbers. This
// answers "what does it look like", which is the half of a design decision that
// no table settles. It is a separate file from those two because they reshape
// the ramp at runtime and the ROAD MESH DOES NOT FOLLOW — a screenshot from
// them would show the shipping ramp under a car driving a different one.
//
// So this one changes nothing. Reload the page with the shape baked in and
// point it at whatever is there:
//
//   http://localhost:8791/?track=kitchen&seed=771&mute=1&hazardGeom=butterJump:height=14
//   const m = await import('/tools/ramp-shot.js'); await m.rampShot('jump-h14');
//
// PINNED BY EVENT, NOT BY STEP. The geometries take different numbers of steps
// to cross the ramp, so a fixed step count photographs a different place on the
// road for each one. The car is placed identically, driven at full throttle,
// and the shutter fires at the toe, at the highest point of the crossing, and
// at the lip.
//
// Finding the highest point needs a DRY RUN FIRST. The obvious version shot
// "25 steps past the lip" and came back with three frames of a car sitting flat
// on the road at every height, because on this profile the car goes light on
// the TOE and is down again before the lip — the very thing the numbers say and
// the frames were supposed to show. The run is deterministic to three decimals
// when the car is repaired first, so replaying it and shooting at the recorded
// step lands on exactly the moment that was measured.
//
// The camera is the DIRECTOR'S. It is left enabled on purpose — the chase is
// what a player sees, and a hand-placed camera would be answering a question
// nobody asked. Film grain is zeroed, because it reseeds every frame and these
// frames are meant to be compared with each other.

export async function rampShot(name = 'ramp', opts = {}) {
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
  const entrySpeed = opts.entrySpeed ?? 60;
  const w = opts.w ?? 1280;
  const h = opts.h ?? 720;

  const e = MG.engine;
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('ramp-shot');

  if (ctx.race?.state === 'attract') {
    try { ctx.race.start({ skipCountdown: true, autopilot: true }); } catch (_) { /* shoot what there is */ }
  }

  const grain = ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;

  const realSetControls = v.setControls.bind(v);
  v.setControls = function blocked() { return this; };
  const frozenWas = cars.map((c) => c.frozen);
  for (let i = 0; i < cars.length; i++) cars[i].frozen = cars[i] !== v;

  const shots = [];
  try {
    place();

    const maxSteps = opts.steps ?? 420;
    // Pass 1: no shutter. Record which step is the toe, which is the highest
    // point of the crossing, and which is the lip.
    const dry = crossing(maxSteps);
    place();
    // Pass 2: the same run again, shooting at the steps pass 1 named.
    const marks = new Map();
    if (dry.toeStep >= 0) marks.set(dry.toeStep, 'toe');
    if (dry.highStep >= 0) marks.set(dry.highStep, 'high');
    if (dry.lipStep >= 0) marks.set(dry.lipStep, 'lip');
    let armed = false;
    for (let s = 0; s < maxSteps && marks.size; s++) {
      realSetControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0, boost: 0 });
      e.stepOnce?.();
      const pastLip = signedU(v.trackT, ramp.t1, L);
      if (!armed) {
        if (pastLip > -(approachU - 20) && !v.isAirborne) armed = true;
        continue;
      }
      const label = marks.get(s);
      if (!label) continue;
      marks.delete(s);
      // capture() pauses, settles the texture foundry and syncs every system to
      // the camera it is about to render with, so nothing here has to.
      const shot = await MG.capture(`${name}-${label}`, w, h, opts.ss ?? 1);
      shots.push({
        at: label,
        step: s,
        pastLipU: +pastLip.toFixed(1),
        aboveRoadU: +heightAbove().toFixed(2),
        speed: +(v.speed ?? 0).toFixed(1),
        upY: +(v.up?.y ?? 1).toFixed(3),
        airborne: !!v.isAirborne,
        file: shot?.file ?? shot?.name ?? null,
        ok: shot?.ok !== false,
      });
    }
    shots.sort((a, b) => a.step - b.step);
    shots.unshift({ dryRun: dry });

    /** Put the car back on the approach, identically, for another crossing. */
    function place() {
      try { v.repair?.(); } catch (_) { /* nothing to repair */ }
      v.respawn(wrap01(ramp.t1 - approachU / L), { lateral: 0, keepSpeed: 0, minSpeed: 0, silent: true, noEscalate: true });
      v.velocity.copy(v.forward).multiplyScalar(entrySpeed);
      v.speed = entrySpeed;
      v.forwardSpeed = entrySpeed;
      // The stuck watchdog anchors on lap progress and respawn() does not clear
      // it; a placement that moves the car backwards otherwise reads as a car
      // going nowhere. See jump-shape.js.
      v._progressT = NaN;
      v._noProgress = 0;
      v._offTrackDwell = 0;
    }

    /** Chassis height above the road directly under it. */
    function heightAbove() {
      let ground = 0;
      try { ground = track.heightAt(v.position.x, v.position.z); } catch (_) { return 0; }
      return Number.isFinite(ground) ? v.position.y - ground : 0;
    }

    /** One crossing with no shutter, reporting the steps worth photographing. */
    function crossing(limit) {
      let armedAt = -1, toeStep = -1, lipStep = -1, highStep = -1, high = -Infinity;
      for (let s = 0; s < limit; s++) {
        realSetControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0, boost: 0 });
        e.stepOnce?.();
        const pastLip = signedU(v.trackT, ramp.t1, L);
        if (armedAt < 0) {
          if (pastLip > -(approachU - 20) && !v.isAirborne) armedAt = s;
          continue;
        }
        if (toeStep < 0 && pastLip >= -ramp.length) toeStep = s;
        if (lipStep < 0 && pastLip >= 0) lipStep = s;
        if (toeStep >= 0) {
          const above = heightAbove();
          if (above > high) { high = above; highStep = s; }
        }
        if (lipStep >= 0 && pastLip > 25) break;
      }
      return { armedAt, toeStep, lipStep, highStep, highestAboveRoadU: +high.toFixed(2) };
    }
  } finally {
    delete v.setControls;
    for (let i = 0; i < cars.length; i++) cars[i].frozen = frozenWas[i];
    if (grain) grain.value = grainWas;
    if (!wasPaused) e.resume?.('ramp-shot');
  }

  return {
    track: track.id,
    ramp: ramp.id,
    height: ramp.height,
    length: ramp.length,
    exitDeg: +(Math.atan2(0.82 * ramp.height, ramp.length) * 180 / Math.PI).toFixed(1),
    hazardGeom: new URLSearchParams(location.search).get('hazardGeom'),
    entrySpeed,
    shots,
  };
}

function wrap01(x) { const y = x % 1; return y < 0 ? y + 1 : y; }
function signedU(t, ref, L) { return (((t - ref + 1.5) % 1) - 0.5) * L; }
