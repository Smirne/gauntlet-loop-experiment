// Store-page screenshots.
//
// The COVER lies on purpose — it drops to a low hero angle no player occupies,
// because a store thumbnail has one second to say "tiny cars on furniture".
// These do not get that licence. A screenshot is a promise about what the game
// looks like while you play it, so every frame here is the director's own
// camera, the one the player actually looks through, with the HUD on.
//
//   /?track=<id>&skipmenu=1&autopilot=1&quality=ultra
//   const m = await import('/tools/store-shots.js'); await m.storeShot('pack');
//
// `pack` pins early, at 7 s, while the field is still nose to tail — that is
// what an arcade racer's screenshot has to show, and by the 16 s pin the critic
// set uses, the leaders are alone. `solo` pins at 18 s for a clean run.

const PINS = { pack: 7, solo: 18 };

function pinTo(target) {
  const engine = window.MG.engine, race = window.MG.ctx?.race;
  if (!engine || !race) return { pinned: false, why: 'no engine or race' };
  engine.pause?.('store-pin');
  if (race.raceTime > target) {
    return { pinned: false, why: `clock already ${race.raceTime.toFixed(2)} s past the ${target} s pin` };
  }
  const real = engine.renderFrame;
  engine.renderFrame = () => {};
  let steps = 0;
  try { while (race.raceTime < target && steps < 20000) { engine.stepOnce(); steps++; } }
  finally { delete engine.renderFrame; if (engine.renderFrame !== real) engine.renderFrame = real; }
  return { pinned: true, to: +race.raceTime.toFixed(2), steps };
}

/** How tightly the field is bunched, so "the pack is in shot" is measured and
 *  not hoped for. Spread is in lap-fractions between first and last runner. */
function spread() {
  const race = window.MG.ctx?.race;
  let lo = Infinity, hi = -Infinity, running = 0;
  for (const e of race?.entries ?? []) {
    if (e.finished || e.eliminated) continue;
    const p = (e.lap ?? 0) + (e.t ?? 0);
    lo = Math.min(lo, p); hi = Math.max(hi, p); running++;
  }
  return { running, spread: +(hi - lo).toFixed(4) };
}

export async function storeShot(kind = 'pack', opts = {}) {
  if (!window.MG?.status) return { booting: true };
  const track = window.MG.ctx?.track?.id || 'x';

  const p = pinTo(opts.at ?? PINS[kind] ?? PINS.pack);
  if (!p.pinned && !opts.force) return { refused: 'could not pin the moment', pin: p };

  // The director keeps the camera. That is the entire point of this file — do
  // NOT pose it here, or these stop being screenshots and become renders.
  const sp = spread();

  // Let the damped screen-space terms settle at this moment before reading it.
  const eng = window.MG.engine;
  const real = eng.renderFrame; eng.renderFrame = () => {};
  try { for (let i = 0; i < 40; i++) eng.stepOnce(); }
  finally { delete eng.renderFrame; if (eng.renderFrame !== real) eng.renderFrame = real; }

  const shot = await window.MG.capture(`store-${track}-${kind}`, 1920, 1080);
  return { track, kind, pin: p, field: sp, shot };
}
