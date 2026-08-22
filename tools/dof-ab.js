// One frame of the chase camera, captured at a pinned race moment, so the
// depth-of-field field rule can be judged instead of argued about.
//
// Boot twice from the SAME build, once with &dofField=0, and shoot at the same
// race clock. The camera is the director's own — the rule exists to serve the
// shot a player actually looks at, so it has to be judged on that shot and not
// on a pose invented for the capture (D26: the camera is not mine to set while
// the director owns it).
//
//   /?track=kitchen&skipmenu=1&t=16&quality=ultra&autopilot=1[&dofField=0]
//   const m = await import('/tools/dof-ab.js'); await m.dofShot('on');

const PIN = 20.0;

export async function dofShot(tag = '', pin = PIN) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const race = MG.ctx?.race;
  const engine = MG.engine;
  if (!race || !engine) return { refused: 'no race' };
  if (race.raceTime > pin) return { refused: 'already past the pin', raceTime: race.raceTime };

  // Step to the pinned clock with rendering suppressed: the frames on the way
  // are not wanted and rendering them is the expensive part.
  engine.pause?.('dof-ab');
  const real = engine.renderFrame;
  engine.renderFrame = () => {};
  let steps = 0;
  try {
    while (race.raceTime < pin && steps < 20000) { engine.stepOnce(); steps++; }
  } finally {
    delete engine.renderFrame;
    if (engine.renderFrame !== real) engine.renderFrame = real;
  }

  const u = MG.ctx.postfx?.passes?.tiltShift?.uniforms;
  const shot = await MG.capture('dof-' + tag, 1920, 1080);
  return {
    shot: shot.path, raceTime: +race.raceTime.toFixed(3), steps,
    fieldRule: MG.ctx.postfx?._fieldRule,
    bandWidth: u ? +u.uBandWidth.value.toFixed(3) : null,
    depthBand: u ? +u.uDepthBand.value.toFixed(1) : null,
  };
}
