// One chase frame at a pinned race moment, so the tyre-smoke calibration can be
// judged instead of argued about.
//
// Boot the SAME build three times with &smokeGain=0 / 0.5 / 1 and shoot at the
// same race clock (D25). The camera is the director's own — smoke has to be
// judged on the shot a player actually looks at, not on a pose invented for the
// capture (D26).
//
//   /?track=kitchen&skipmenu=1&quality=ultra&autopilot=1&smokeGain=1
//   const m = await import('/tools/smoke-ab.js'); await m.smokeShot('g1');
//
// Reports the smoke channel's own statistics alongside the frame, because the
// point of the change is that the channel never left its floor: a frame that
// looks the same AND reports the same p95 means the dial did nothing.

const PIN = 20.0;

export async function smokeShot(tag = '', pin = PIN) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const race = MG.ctx?.race;
  const engine = MG.engine;
  if (!race || !engine) return { refused: 'no race' };
  if (race.raceTime > pin) return { refused: 'already past the pin', raceTime: race.raceTime };

  const smokes = [];
  let spawnedAt = null;

  // Step to the pinned clock with rendering suppressed, sampling the channel on
  // the way: the frames in between are not wanted and rendering them is the
  // expensive part.
  engine.pause?.('smoke-ab');
  const real = engine.renderFrame;
  engine.renderFrame = () => {};
  let steps = 0;
  try {
    while (race.raceTime < pin && steps < 20000) {
      engine.stepOnce();
      steps++;
      if (steps % 6 === 0) {
        for (const v of MG.ctx.vehicles) {
          for (const w of v.wheels) if (w.grounded) smokes.push(w.smoke || 0);
        }
      }
      if (race.raceTime >= 12 && spawnedAt === null) {
        spawnedAt = MG.particles?.info?.().kinds?.tyreSmoke?.spawned ?? null;
      }
    }
  } finally {
    delete engine.renderFrame;
    if (engine.renderFrame !== real) engine.renderFrame = real;
  }

  smokes.sort((a, b) => a - b);
  const q = (f) => (smokes.length ? +smokes[Math.floor(f * (smokes.length - 1))].toFixed(3) : null);
  const info = MG.particles?.info?.() ?? {};
  const shot = await MG.capture('smoke-' + tag, 1920, 1080);

  return {
    shot: shot.path,
    raceTime: +race.raceTime.toFixed(3),
    gain: MG.ctx.vehicles?.[0]?.tires?.smokeSlipMix ?? null,
    smokeStart: MG.ctx.vehicles?.[0]?.tires?.smokeStart ?? null,
    smokeFull: MG.ctx.vehicles?.[0]?.tires?.smokeFull ?? null,
    heatPowerRef: MG.ctx.vehicles?.[0]?.tires?.heatPowerRef ?? null,
    smokeP50: q(0.5), smokeP90: q(0.9), smokeP99: q(0.99), smokeMax: q(1),
    samples: smokes.length,
    tyreSmokeSpawned: info.kinds?.tyreSmoke?.spawned ?? null,
    tyreSmokeLive: info.kinds?.tyreSmoke?.live ?? null,
    liveTotal: info.live ?? null,
  };
}
