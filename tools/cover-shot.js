// Cover art for the store page, shot in-engine.
//
// itch.io wants 630x500 and shows it as a thumbnail as small as 315x250 in a
// browse grid. That size is the whole brief: at 315 px wide a player decides in
// about a second whether this is a racing game, and the only things legible at
// that size are one big subject, one recognisable object next to it for scale,
// and a strong value contrast between them.
//
// So this is NOT the game's own camera. The race camera is high and near
// top-down — correct for driving, and at thumbnail size it turns every car into
// an eight-pixel lozenge. These poses drop low and close, which is a lie about
// how the game is played and the truth about what the game IS: 1:64 cars on
// furniture. The gameplay frames in shots/tour-*.png are the honest ones and
// they belong in the screenshots section, not on the cover.
//
//   /?track=kitchen&skipmenu=1&autopilot=1&quality=ultra
//   const m = await import('/tools/cover-shot.js'); await m.coverShots();
//
// `autopilot=1` matters here for the same reason it matters in capture-set.js:
// without it car 0 never leaves the grid, and the hero car in the middle of the
// cover would be a parked one.

const PIN = 18;          // far enough in that the field has strung out and the
                         // leader is alone on a clean piece of road
const W = 1890;          // 3x the 630x500 itch cover, downsampled after
const H = 1500;

function pin(target = PIN) {
  const engine = window.MG.engine, race = window.MG.ctx?.race;
  if (!engine || !race) return { pinned: false, why: 'no engine or race' };
  engine.pause?.('cover-pin');
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

/** Advance without drawing, so damped screen-space effects catch up with a
 *  camera that just teleported. Same reason as capture-set.js's settle(). */
function settle(steps = 48) {
  const eng = window.MG.engine;
  const real = eng?.renderFrame;
  if (eng) eng.renderFrame = () => {};
  try { for (let i = 0; i < steps; i++) eng?.stepOnce?.(); }
  finally { if (eng) { delete eng.renderFrame; if (eng.renderFrame !== real) eng.renderFrame = real; } }
}

export async function coverShots(opts = {}) {
  if (!window.MG?.status) return { booting: true };
  const THREE = window.MG.THREE;
  const ctx = window.MG.ctx;
  const track = ctx?.track?.id || 'x';

  const p = pin(opts.pinRaceTime ?? PIN);
  if (!p.pinned && !opts.force) return { refused: 'could not pin the moment', pin: p };

  // The director owns the camera until we take it. See D26 — measuring or
  // shooting through a camera the director is still driving photographs its
  // pose, not ours.
  if (ctx.director) ctx.director.enabled = false;
  const cam = ctx.camera;
  const lead = ctx.vehicles[0];
  const shots = [];

  // Read the subject AFTER settling, never before: settling advances the sim,
  // so a pose computed from a pre-settle position aims where the car used to be.
  const aim = (fov, off, lookY, roll = 0) => {
    settle();
    const c = lead.group.position;
    const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(lead.quaternion);
    const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(lead.quaternion);
    cam.fov = fov;
    cam.position.set(
      c.x + fw.x * off.f + rt.x * off.r,
      c.y + off.up,
      c.z + fw.z * off.f + rt.z * off.r,
    );
    cam.lookAt(c.x, c.y + lookY, c.z);
    if (roll) cam.rotateZ(roll);
    cam.updateProjectionMatrix();
    ctx.postfx?.notifyCameraCut?.();
  };

  // A — low three-quarter from ahead. The classic box-art pose: the car comes
  //     at the viewer, so the silhouette is widest and reads at thumbnail size.
  aim(30, { f: 34, r: 13, up: 5.0 }, 1.6);
  shots.push(await window.MG.capture(`cover-${track}-a`, W, H));

  // B — lower and closer, slight dutch. More drama, less road context; the
  //     trade is whether the surface still reads as furniture at 315 px.
  aim(34, { f: 26, r: 10, up: 3.2 }, 1.3, -0.05);
  shots.push(await window.MG.capture(`cover-${track}-b`, W, H));

  // C — from behind and to the side, so the road ahead is in frame. Says
  //     "racing" rather than "car portrait", which the other two risk.
  aim(30, { f: -30, r: 14, up: 7.5 }, 1.8);
  shots.push(await window.MG.capture(`cover-${track}-c`, W, H));

  return { track, pin: p, shots: shots.map((s) => s.path || s) };
}
