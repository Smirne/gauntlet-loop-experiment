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

  /**
   * Let the frame-level effects catch up with a camera that just teleported.
   *
   * `MG.capture()` pauses the engine and calls `renderFrame()` directly, so
   * nothing's `update()` ever sees the new camera — every screen-space effect
   * keeps whatever value the last LIVE frame left it holding. That is how a
   * locked-off establishing shot ended up wearing the chase camera's
   * full-screen speed lines: fx:overlay alone was lifting the far wall from
   * 125 to 176 of 255 in a static wide.
   *
   * Stepping with rendering suppressed costs nothing and lets the damped terms
   * decay to what this shot actually warrants. It does mean each frame is a
   * few tenths of a second after the previous one rather than the same instant
   * — which is the right trade, because these are four different cameras and
   * were never one moment to a viewer anyway.
   */
  const settle = (steps = 48) => {
    const eng = window.MG.engine;
    const real = eng?.renderFrame;
    if (eng) eng.renderFrame = () => {};
    try {
      for (let i = 0; i < steps; i++) eng?.stepOnce?.();
    } finally {
      if (eng) {
        delete eng.renderFrame;
        if (eng.renderFrame !== real) eng.renderFrame = real;
      }
    }
  };

  // 1. the director's own race camera, exactly as a player sees it
  shots.push(await window.MG.capture('crit-1-gameplay' + tag, 1920, 1080));

  // From here we drive the camera by hand, so the director has to let go of it.
  const lead = ctx.vehicles[0];
  if (ctx.director) ctx.director.enabled = false;
  const cam = ctx.camera;

  // SETTLE FIRST, THEN AIM. Settling advances the simulation, so a camera posed
  // from the car's position and then settled is aiming where the car USED to be
  // — which put the macro shot on an empty stretch of road with no car in it at
  // all, on the one frame whose entire job is to show the car. Read the subject
  // AFTER the sim has moved, never before.
  const subject = () => lead.group.position;

  // 2. tight chase on the leader
  settle();
  {
    const c = subject();
    const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(lead.quaternion);
    cam.fov = 34;
    cam.position.set(c.x - fw.x * 46 + 6, c.y + 26, c.z - fw.z * 46 + 6);
    cam.lookAt(c.x, c.y + 2, c.z);
    cam.updateProjectionMatrix();
    ctx.postfx?.notifyCameraCut?.();
  }
  shots.push(await window.MG.capture('crit-2-chase' + tag, 1920, 1080));

  // 3. macro detail: car body against the table surface
  settle();
  {
    const c = subject();
    cam.fov = 26;
    cam.position.set(c.x + 17, c.y + 9, c.z + 21);
    cam.lookAt(c.x, c.y + 1.4, c.z);
    cam.updateProjectionMatrix();
    ctx.postfx?.notifyCameraCut?.();
  }
  shots.push(await window.MG.capture('crit-3-macro' + tag, 1920, 1080));

  // 4. wide establishing shot of the whole circuit
  //
  // RE-POSED after round 3, and the reason is worth keeping. The old pose put
  // the camera at ctr + (0.42d, 0.80d, 0.62d) — elevation 46.9 degrees — which
  // is ABOVE AND INSIDE all four table edges. The near and left edges ran off
  // frame, the far edges showed only their top surface ending in a one-pixel
  // line, and the far corner clipped dead against y = 0 with no headroom. So a
  // stranger saw a wooden board floating in grey: a diorama, not a kitchen.
  //
  // The critic's phrasing is the part to remember — everything built to make
  // the table read as furniture (a 10 u board, a moulded rim, four legs down to
  // the room floor, a floor and walls behind it) "contributes exactly zero
  // pixels to this review set". The work was fine; the camera never looked at
  // it. A review frame that cannot see the thing being reviewed is a broken
  // instrument, not a verdict.
  //
  // Dropping to ~32 degrees and pulling back puts a NEAR CORNER in shot, with
  // the rim, a leg and the floor behind it, and keeps the whole circuit legible
  // — which is still the hard constraint this frame must satisfy.
  //
  // This breaks A/B comparability with rounds 1-3 by design. Do not read a
  // difference across that boundary as a rendering change.
  settle();
  const b = ctx.track.bounds;
  const ctr = b.getCenter(new THREE.Vector3());
  const sz = b.getSize(new THREE.Vector3());
  const d = Math.max(sz.x, sz.z) * 1.28;
  cam.fov = 35;
  cam.position.set(ctr.x + d * 0.50, ctr.y + d * 0.47, ctr.z + d * 0.66);
  cam.lookAt(ctr.x, ctr.y - sz.y * 0.35, ctr.z);
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
