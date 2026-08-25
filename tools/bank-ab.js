// One fixed camera on the Toaster hairpin's outside kerb, at a pinned race
// clock, with the lens taken out of the picture — the subject is the shape of
// the road, and depth of field only makes it harder to see.
//
// Boot the SAME build twice and shoot at the same clock (D25):
//   /?track=kitchen&skipmenu=1&quality=ultra&autopilot=1&seed=7[&bankBaseline=0]
//   const m = await import('/tools/bank-ab.js'); await m.bankShot();
//
// The camera is FIXED in world coordinates on purpose. The first attempt at
// this derived it from the road's own banked frame — `pos + right * halfWidth`
// — so the camera moved with the very thing under test and the two frames were
// not comparable. If the subject is a transform, do not build the camera out of
// that transform.

const PIN = 8.0;
const CAM_POS = [-173, 9, 157];
const CAM_LOOK = [-196, 1.0, 60];

export async function bankShot(tag = null, pin = PIN) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const ctx = MG.ctx;
  const e = MG.engine;
  if (!ctx?.race || !e) return { refused: 'no race' };

  const baseline = new URLSearchParams(location.search).get('bankBaseline');
  const name = tag || (baseline === '0' ? 'bank-before' : 'bank-after');

  if (ctx.race.raceTime > pin) return { refused: 'already past the pin', raceTime: ctx.race.raceTime };

  const real = e.renderFrame;
  let suppressed = true;
  e.renderFrame = function () { if (!suppressed) return real.apply(this, arguments); };
  try {
    while (ctx.race.raceTime < pin) e.stepOnce();
  } finally {
    e.renderFrame = real;
  }

  // Grain off (this project's rule before any frame comparison) and tilt-shift
  // off, so what differs between the two frames can only be the road.
  const grain = ctx.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;
  const tilt = ctx.postfx?.passes?.tiltShift;
  const tiltWas = tilt ? tilt.enabled : null;
  if (tilt) tilt.enabled = false;

  if (ctx.director) ctx.director.enabled = false;
  const cam = ctx.camera;
  cam.fov = 26;
  cam.position.set(CAM_POS[0], CAM_POS[1], CAM_POS[2]);
  cam.lookAt(CAM_LOOK[0], CAM_LOOK[1], CAM_LOOK[2]);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  ctx.postfx?.notifyCameraCut?.();
  e.renderFrame();

  const shot = await MG.capture(name, 1600, 900);

  if (grain) grain.value = grainWas;
  if (tilt) tilt.enabled = tiltWas;

  const d = ctx.track.data;
  const n = d.bank.length;
  const deg = (t) => +(d.bank[Math.round(t * n) % n] * 57.2958).toFixed(2);
  let variation = 0;
  for (let i = 0; i < n; i++) variation += Math.abs(d.bank[i] - d.bank[(i + 1) % n]);

  return {
    shot: shot.path,
    raceTime: +ctx.race.raceTime.toFixed(3),
    bankBaseline: baseline === null ? 'default' : baseline,
    hairpinDeg: [0.51, 0.525, 0.535, 0.545, 0.56, 0.57].map((t) => [t, deg(t)]),
    totalVariationDeg: +(variation * 57.2958).toFixed(1),
  };
}
