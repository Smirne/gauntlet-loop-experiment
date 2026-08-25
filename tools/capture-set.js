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

/**
 * The captured MOMENT has to be pinned, or a blind A/B is not comparing builds.
 *
 * The engine's fast-forward is deterministic — two loads of `?t=16` put car 0 at
 * exactly (-125.997, 1.757, 40.595), byte for byte. What is NOT deterministic is
 * everything after it: the RAF loop keeps stepping the race from the moment the
 * page is ready until somebody calls this function, so the shot lands wherever
 * the operator's typing speed put it. Rounds r20 through r23 were each taken at a
 * different race moment — measured through `assertMoving`'s own leader advance,
 * which came back 0.01895, 0.01945, 0.02316 and 0.01895 across four runs of the
 * identical URL.
 *
 * That is fatal for a blind A/B whose whole premise is that the only difference
 * between two sets is the build. Judges on r22 vs r23 reported four cars in one
 * set and two in the other and scored the difference, which is a fact about when
 * the shutter fell, not about either build.
 *
 * So: pause first, then step to a FIXED race clock. Any drift the RAF introduced
 * is absorbed as long as it is under `TARGET - t`, and every set from every build
 * is then shot at the same instant of the same deterministic race.
 */
const PIN_RACE_TIME = 20.0;

/**
 * Where in the menu orbit to shoot the wide frame, in seconds.
 *
 * Measured room share along the orbit a player really gets:
 *
 *     0.0 s  27.8%    0.9 s  23.3%    1.8 s  13.0%    3.0 s onward  0%
 *
 * 1.2 s is wide enough that the table still reads as a piece of furniture with
 * a room behind it, and late enough that the room is roughly a fifth of frame
 * rather than the 53% the old hand-written pose gave it.
 */
const INTRO_ORBIT_T = 1.2;

function pinMoment(target = PIN_RACE_TIME) {
  const engine = window.MG.engine || window.MG.ctx?.engine;
  const race = window.MG.ctx?.race;
  if (!engine || !race || typeof race.raceTime !== 'number') return { pinned: false, why: 'no engine or race clock' };

  engine.pause?.('capture-pin');
  const before = race.raceTime;
  if (before > target) {
    return { pinned: false, why: `race clock is already ${before.toFixed(3)} s, past the ${target} s pin`,
             fix: 'reload and call captureSet sooner, or raise PIN_RACE_TIME' };
  }
  // Step with rendering suppressed: the frames on the way to the pin are not
  // wanted and rendering them is the expensive part.
  const real = engine.renderFrame;
  engine.renderFrame = () => {};
  let steps = 0;
  try {
    while (race.raceTime < target && steps < 20000) { engine.stepOnce(); steps++; }
  } finally {
    delete engine.renderFrame;
    if (engine.renderFrame !== real) engine.renderFrame = real;
  }
  return { pinned: true, from: +before.toFixed(3), to: +race.raceTime.toFixed(3), steps };
}

export async function captureSet(suffix = '', opts = {}) {
  const s = window.MG?.status;
  if (!s) return { booting: true, msg: document.querySelector('#boot .boot-msg')?.textContent };

  const pin = pinMoment(opts.pinRaceTime ?? PIN_RACE_TIME);
  if (!pin.pinned && !opts.force) {
    return { refused: 'could not pin the capture moment — the frames would not be comparable', pin };
  }

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

  // 4. the widest shot a player ACTUALLY SEES
  //
  // THIS POSE IS NOT INVENTED HERE ANY MORE, AND THAT IS THE WHOLE POINT.
  //
  // Rounds 1-7 shot this frame from a pose written in this file: pulled back to
  // 1.45x the track's longest axis at about 32 degrees, chosen so a near table
  // corner and a leg would be in shot. It did that, and the round-7 judges duly
  // scored what it revealed — "the frame that costs the whole set", "a good car
  // asset dropped into someone else's blockout".
  //
  // They were right, and righter than the number they were given. That pose is
  // 82.8% bare room, measured by painting every MG.Room mesh flat magenta and
  // everything else flat black, letting the depth buffer do the occlusion and
  // counting magenta (control 0.0%). See shots/oldpose-mask.png.
  //
  // The 53.32% quoted here previously came from a worse instrument: hide the
  // room and diff the frame. That answers "what does the room AFFECT" — its
  // floor and walls bounce light into the whole scene — not "where is the room
  // on screen", and it was run with the grain still on, which by itself puts
  // 33% of pixels in the diff. ZERO THE GRAIN BEFORE A FRAME-DIFF, and mask
  // rather than toggle when the question is "how much of the frame is this".
  //
  // Then a player asked when that view is shown, and could not reproduce it.
  // The wide camera exists in exactly one place: the menu backdrop, in
  // `attract`. It is NOT a race intro — Director switches to 'race' the moment
  // the state leaves attract — and `?skipmenu=1` skips it outright. Room share
  // along the orbit a player really gets, by the mask instrument:
  //
  //     0.2 s  27.1%     1.4 s  17.5%     2.6 s  3.4%     3.4 s on  0%
  //     0.6 s  24.9%     1.8 s  12.5%     3.0 s  0.4%     mean      5.3%
  //
  // ...dimmed, behind menu panels, and gone entirely after three seconds. So
  // the old pose showed three times the room a player ever sees, at a camera
  // nobody occupies, and three rounds of judging weighted it as the thing that
  // sank the set. That is the FIFTH time this project has scored something the
  // harness could produce and the game cannot show — after a parked race,
  // coin-flip shadows, a DOM HUD, and now a measurement of the wrong quantity.
  //
  // So ask the Director for the pose instead of writing one.
  //
  // NOT at introDuration, which was the first thing I tried and the frame said
  // no: at p = 1 the blend term `b` reaches 1 and `_camWant.lerp(_introPos, 1-b)`
  // leaves the camera on the CHASE pose, so the orbit's resting place is not a
  // wide shot at all — it had quietly replaced the establishing frame with a
  // second gameplay frame. INTRO_ORBIT_T picks a moment while the orbit is
  // still wide and still showing the table as furniture: the widest thing a
  // player is ever actually shown.
  settle();
  {
    const dir = ctx.director;
    if (dir && typeof dir.setMode === 'function') {
      const wasEnabled = dir.enabled;
      const wasMode = dir.mode;
      const wasAuto = dir.autoIntroToRace;
      dir.enabled = true;
      dir.autoIntroToRace = false;      // or it flips straight back to 'race'
      dir.setMode('intro', { auto: false });
      dir.modeTime = INTRO_ORBIT_T;
      window.MG.engine?.stepOnce?.();   // let _orbit solve and write the camera
      dir.modeTime = INTRO_ORBIT_T;
      ctx.postfx?.notifyCameraCut?.();
      shots.push(await window.MG.capture('crit-4-establishing' + tag, 1920, 1080));
      dir.autoIntroToRace = wasAuto;
      dir.setMode(wasMode || 'race');
      dir.enabled = false;              // the rest of this file drives by hand
      void wasEnabled;
    } else {
      // No director (a stub, or a harness that never built one): fall back to
      // the old hand-written pose rather than shooting whatever was last set.
      const b = ctx.track.bounds;
      const ctr = b.getCenter(new THREE.Vector3());
      const sz = b.getSize(new THREE.Vector3());
      const d = Math.max(sz.x, sz.z) * 1.45;
      cam.fov = 34;
      cam.position.set(ctr.x + d * 0.62, ctr.y + d * 0.42, ctr.z + d * 0.86);
      cam.lookAt(ctr.x, ctr.y - sz.y * 0.55, ctr.z);
      cam.updateProjectionMatrix();
      ctx.postfx?.notifyCameraCut?.();
      shots.push(await window.MG.capture('crit-4-establishing' + tag, 1920, 1080));
    }
  }

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
