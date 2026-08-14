// Deterministic critic capture set.
//
// The blind A/B in REVIEW.md only means anything if round N and round N+1 are
// shot from the *same* camera. Round 1 was captured from an inline snippet,
// which is exactly the thing that drifts between sessions — so it lives here
// now, verbatim, and every later round calls this file.
//
// Load and run:
//   const m = await import('/tools/capture-set.js'); await m.captureSet('r2');
//
// Boot with the matching URL or the sim state won't line up. `autopilot=1` is
// NOT optional — see the guard below:
//   /?track=kitchen&skipmenu=1&t=16&quality=ultra&autopilot=1
//
// t=16 puts the leaders around 55% of the opening lap with the field strung
// out, which is what a review frame should show. Rounds 1 and 2 used t=6, but
// that was before D10 was found: the fast-forward stepped no systems at all, so
// t=6 really meant "the field has barely left the grid and no physics has run".
// Do not compare frames across that boundary and read the difference as a
// rendering change.
//
// Pass a suffix to namespace a round: captureSet('r2') writes
// shots/crit-1-gameplay-r2.png etc. No suffix overwrites the round-1 names.

/**
 * Liveness: measure motion, never trust `race.state`.
 *
 * Rounds 1 and 2 were both scored on frames of a race that had already
 * stopped, and the state flag is not sufficient to catch it. Two boots of the
 * identical URL failed in opposite directions:
 *
 *   Boot A — collapsed to `results` at t=9.7. Nobody drives car0 without
 *   `autopilot=1`, so it sat on the grid, trailed the field by a screen and was
 *   eliminated (correctly — that is what the rule is for). But
 *   `Race._checkRaceOver` reads an eliminated player as "player done", goes to
 *   FINISHED, and after the AI grace period DNFs the rest and closes the books.
 *   Leader was 8.6% around lap 0 with seven of eight cars flagged finished.
 *
 *   Boot B — every car finished or eliminated, `running === 0`, and the state
 *   sat at `racing` for 66 s with the clock still ticking. Both branches of
 *   `_checkRaceOver` that should have ended it did not fire.
 *
 * So `state === 'racing'` spans everything from a real race to eight parked
 * cars, and `state !== 'racing'` would have rejected boot A but waved boot B
 * straight through. The only trustworthy signal is that the field is actually
 * moving: sample leader progress twice and require it to advance.
 *
 * Deliberately not a fix to Race.js. The state machine is unreliable in at
 * least two directions and that is its own investigation; this is the capture
 * harness refusing to produce evidence it cannot stand behind.
 */
function assertMoving(steps = 60) {
  const race = window.MG.ctx?.race;
  const engine = window.MG.engine;

  const lead = () => {
    let best = -1;
    for (const e of race?.entries ?? []) {
      if (e.finished || e.eliminated) continue;
      best = Math.max(best, (e.lap ?? 0) + (e.t ?? 0));
    }
    return best;
  };

  const before = lead();
  if (before < 0) {
    return { moving: false, why: 'no car is still running — every entry is finished or eliminated' };
  }

  // DRIVE the simulation, do not observe it.
  //
  // Waiting on wall-clock and sampling twice does not work here: Engine pauses
  // itself on `visibilitychange` when document.hidden, and an agent-driven
  // browser pane is hidden almost all the time, so a sampled progress delta is
  // always zero and the guard rejects every race including healthy ones. (That
  // same pause is why two boots of one seeded URL looked non-deterministic —
  // the pane had been hidden for different amounts of wall-clock.)
  //
  // Stepping the loop directly sidesteps visibility entirely and is what the
  // fast-forward path already does. Half a second of simulation, rendering
  // suppressed so it costs nothing.
  const real = engine?.renderFrame;
  if (engine) engine.renderFrame = () => {};
  try {
    for (let i = 0; i < steps; i++) engine?.stepOnce?.();
  } finally {
    if (engine) {
      delete engine.renderFrame;
      if (engine.renderFrame !== real) engine.renderFrame = real;
    }
  }

  const after = lead();
  if (after - before < 1e-4) {
    return {
      moving: false,
      why: `leader progress did not advance across ${steps} simulation steps (${after.toFixed(4)})`,
      state: race?.state,
    };
  }
  return { moving: true, advanced: +(after - before).toFixed(5), steps };
}

export async function captureSet(suffix = '', opts = {}) {
  const s = window.MG?.status;
  if (!s) return { booting: true, msg: document.querySelector('#boot .boot-msg')?.textContent };

  const live = assertMoving();
  if (!live.moving && !opts.force) {
    const race = window.MG.ctx?.race;
    return {
      refused: 'the field is not moving — these frames would not show a race',
      why: live.why,
      state: race?.state,
      raceTime: race?.raceTime,
      running: race?.entries?.filter((e) => !e.finished && !e.eliminated).length,
      fix: 'reboot with &autopilot=1, or pass { force: true } if you meant it',
    };
  }

  const THREE = window.MG.THREE;
  const ctx = window.MG.ctx;
  const tag = suffix ? '-' + suffix : '';
  const shots = [];

  // 1. the director's own race camera, exactly as a player sees it
  shots.push(await window.MG.capture('crit-1-gameplay' + tag, 1920, 1080));

  // From here we drive the camera by hand, so the director has to let go of it.
  const lead = ctx.vehicles[0];
  if (ctx.director) ctx.director.enabled = false;
  const cam = ctx.camera;
  const c = lead.group.position;

  // 2. tight chase on the leader
  const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(lead.quaternion);
  cam.fov = 34;
  cam.position.set(c.x - fw.x * 46 + 6, c.y + 26, c.z - fw.z * 46 + 6);
  cam.lookAt(c.x, c.y + 2, c.z);
  cam.updateProjectionMatrix();
  ctx.postfx?.notifyCameraCut?.();
  shots.push(await window.MG.capture('crit-2-chase' + tag, 1920, 1080));

  // 3. macro detail: car body against the table surface
  cam.fov = 26;
  cam.position.set(c.x + 17, c.y + 9, c.z + 21);
  cam.lookAt(c.x, c.y + 1.4, c.z);
  cam.updateProjectionMatrix();
  ctx.postfx?.notifyCameraCut?.();
  shots.push(await window.MG.capture('crit-3-macro' + tag, 1920, 1080));

  // 4. wide establishing shot of the whole circuit
  const b = ctx.track.bounds;
  const ctr = b.getCenter(new THREE.Vector3());
  const sz = b.getSize(new THREE.Vector3());
  const d = Math.max(sz.x, sz.z) * 0.95;
  cam.fov = 38;
  cam.position.set(ctr.x + d * 0.42, ctr.y + d * 0.80, ctr.z + d * 0.62);
  cam.lookAt(ctr.x, ctr.y, ctr.z);
  cam.updateProjectionMatrix();
  ctx.postfx?.notifyCameraCut?.();
  shots.push(await window.MG.capture('crit-4-establishing' + tag, 1920, 1080));

  return {
    shots,
    live,
    race: ctx.race?.state,
    running: ctx.race?.entries?.filter((e) => !e.finished && !e.eliminated).length,
    cars: ctx.vehicles.length,
    // The HUD is DOM, not canvas — it can never appear in these captures.
    // Critiquing it needs a separate DOM-reading pass.
    hudNodes: document.querySelector('#ui-root')?.children.length ?? 0,
  };
}
