// A line-up shot: all eight cars, all eight liveries, one frame.
//
// Every other capture in tools/ photographs a RACE, and a race is the wrong
// instrument for a colour question — the field strings out, half the grid is
// off-screen, and whichever cars happen to be in shot is an accident of the
// physics. A livery change has to be judged on all eight at once, against the
// surface they are actually driven on.
//
// So this is the grid, before the lights, shot from the director's height with
// the whole formation in frame. Nothing here moves the simulation forward: the
// engine is paused, the camera is taken from the director, one frame is
// rendered, and the camera is handed back.
//
// Load and run (boot with t=0 so the field is still on the grid):
//   /?track=kitchen&skipmenu=1&t=0&quality=ultra&autopilot=1
//   const m = await import('/tools/livery-board.js'); await m.liveryBoard('new');
//
// Pair it with `&liveryMode=oak` for the before-frame. Both come out of ONE
// build at the SAME moment, which is the only honest way to A/B a colour (D25).

export async function liveryBoard(tag = '', opts = {}) {
  const { LIVERIES } = await import('/src/vehicle/CarModels.js');
  const MG = window.MG;
  if (!MG?.status) return { booting: true, msg: document.querySelector('#boot .boot-msg')?.textContent };

  const THREE = MG.THREE;
  const ctx = MG.ctx;
  const cars = ctx.vehicles || [];
  if (cars.length < 2) return { refused: 'fewer than two cars exist', count: cars.length };

  // Freeze first. A line-up that drifts between the two halves of an A/B is
  // not a line-up, it is two different photographs.
  MG.engine?.pause?.('livery-board');

  const wasEnabled = ctx.director?.enabled;
  if (ctx.director) ctx.director.enabled = false;

  const box = new THREE.Box3();
  for (const v of cars) box.expandByPoint(v.group.position);
  const ctr = box.getCenter(new THREE.Vector3());
  const span = Math.max(box.getSize(new THREE.Vector3()).length(), 40);

  const cam = ctx.camera;
  const prev = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };

  // TURN THE LENS BLUR OFF, and say why in the frame's own file.
  //
  // The first board came back with four of the eight cars behind the tilt-shift
  // and unreadable, which is correct behaviour for a game camera and useless as
  // evidence. A defocus blur is a property of the lens, not of the paint: it
  // would sit on top of ANY livery equally, so leaving it on cannot change which
  // roster is better and can only stop the frame from answering the question.
  // The as-played look is what tools/capture-set.js photographs; this shot is
  // the pigment.
  const tilt = ctx.postfx?.passes?.tiltShift;
  const tiltWas = tilt?.enabled;
  if (tilt && opts.dof !== true) tilt.enabled = false;

  // Low and along the grid, not overhead: a roof is not what a player reads a
  // car by. This is roughly the angle the chase camera holds, which is where
  // the cars have to be tellable apart.
  // FIT, do not guess. A hand-picked distance framed six of the eight cars and
  // the two it dropped were the two the change was supposed to be judged on.
  // Walk the camera back along a fixed direction until every car projects
  // inside the frame with a margin, then stop — the closest pose that still
  // shows the whole field.
  const dir = new THREE.Vector3(-0.55, 0.42, -0.80).normalize();
  const aim = new THREE.Vector3(ctr.x, ctr.y + 1.5, ctr.z);
  cam.fov = opts.fov ?? 38;

  const fits = (d) => {
    cam.position.copy(dir).multiplyScalar(d).add(ctr);
    cam.lookAt(aim);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    for (const v of cars) {
      p.copy(v.group.position).project(cam);
      if (p.z > 1 || Math.abs(p.x) > 0.88 || Math.abs(p.y) > 0.86) return false;
    }
    return true;
  };

  let dist = span * (opts.distance ?? 0.55);
  if (opts.distance == null) {
    for (let i = 0; i < 40 && !fits(dist); i++) dist *= 1.08;
  }
  fits(dist);
  ctx.postfx?.notifyCameraCut?.();

  // Record where each car LANDED, in the coordinates of the file that is about
  // to be written. Authored hex is what the roster was chosen on; what a player
  // reads is whatever survives fog, tone mapping and the grade, and the only
  // place to find that out is the pixels.
  //
  // Aim at the BODYWORK, not the origin. `group.position` is the centre of
  // mass, which projects to a point somewhere between the front wheels with
  // road either side of it — a patch there is mostly table, and a first pass
  // that took the most-saturated pixels in it faithfully reported the colour of
  // the oak for all eight cars, because fogged paint is less saturated than
  // wood. Take the top face of the car's own bounding box instead, and let the
  // sampler use a plain median of a small patch.
  const _box = new THREE.Box3();
  const screen = cars.map((v, i) => {
    _box.setFromObject(v.group);
    const roof = new THREE.Vector3(
      (_box.min.x + _box.max.x) * 0.5,
      // 0.82 of the way up is the GREENHOUSE, not the paint. Half the sample
      // points landed on tinted glass and reported the colour of the canopy.
      _box.min.y + (_box.max.y - _box.min.y) * 0.52,
      (_box.min.z + _box.max.z) * 0.5,
    );
    const p = roof.project(cam);
    return {
      i,
      model: v.modelId,
      livery: LIVERIES[v.modelId]?.[v.livery]?.name ?? String(v.livery),
      base: '#' + (LIVERIES[v.modelId]?.[v.livery]?.base ?? 0).toString(16).padStart(6, '0'),
      x: Math.round((p.x * 0.5 + 0.5) * 1920),
      y: Math.round((-p.y * 0.5 + 0.5) * 1080),
    };
  });

  const name = 'livery-board' + (tag ? '-' + tag : '');
  const shot = await MG.capture(name, 1920, 1080);

  cam.position.copy(prev.pos);
  cam.quaternion.copy(prev.quat);
  cam.fov = prev.fov;
  cam.updateProjectionMatrix();
  if (ctx.director) ctx.director.enabled = wasEnabled;
  if (tilt) tilt.enabled = tiltWas;

  return {
    shot,
    dist: Math.round(dist),
    cars: screen,
  };
}
