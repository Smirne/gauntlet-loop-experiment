// One establishing frame per circuit, from the camera a player actually looks
// through.
//
// WHY THIS EXISTS. Every art fix this project has shipped — the room, the
// props, the banking, the contact shadows, the bokeh — landed on `kitchen`,
// because kitchen is the one circuit the critic loop has ever been pointed at.
// The title screen, meanwhile, offers five circuits and a five-round
// championship. Nobody has ever looked at the other four.
//
// Line counts are not an answer to that. kitchen.js is 423 lines and the rest
// are ~220, but a track file's length says nothing about whether the thing
// renders as a place. LOOK AT THE FRAME BEFORE BELIEVING AN AGGREGATE.
//
// Same rules as capture-set.js, for the same reason: the frames are only
// comparable to each other if every one of them is shot at the same race
// clock, through the same camera, with the field actually moving.
//
//   /?track=<id>&skipmenu=1&autopilot=1&quality=ultra
//   const m = await import('/tools/track-tour.js'); await m.tourShot('pool');
//
// `autopilot=1` is NOT optional — without it car 0 sits on the grid, trails the
// field and gets eliminated, and the frame shows a race that has already
// stopped. See the assertMoving note in capture-set.js.

const PIN = 16;   // same pin as the critic set: leaders ~55% of the opening lap

function pinMoment(target = PIN) {
  const engine = window.MG.engine || window.MG.ctx?.engine;
  const race = window.MG.ctx?.race;
  if (!engine || !race || typeof race.raceTime !== 'number') {
    return { pinned: false, why: 'no engine or race clock' };
  }
  engine.pause?.('tour-pin');
  const before = race.raceTime;
  if (before > target) {
    return { pinned: false, why: `clock already at ${before.toFixed(2)} s, past the ${target} s pin` };
  }
  const real = engine.renderFrame;
  engine.renderFrame = () => {};
  let steps = 0;
  try {
    while (race.raceTime < target && steps < 20000) { engine.stepOnce(); steps++; }
  } finally {
    delete engine.renderFrame;
    if (engine.renderFrame !== real) engine.renderFrame = real;
  }
  return { pinned: true, from: +before.toFixed(2), to: +race.raceTime.toFixed(2), steps };
}

/** Is the field moving? A parked race renders a frame that lies about the game. */
function moving(steps = 60) {
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
  const a = lead();
  const real = engine.renderFrame;
  engine.renderFrame = () => {};
  try { for (let i = 0; i < steps; i++) engine.stepOnce(); }
  finally { delete engine.renderFrame; if (engine.renderFrame !== real) engine.renderFrame = real; }
  const b = lead();
  return { moving: b > a, from: +a.toFixed(4), to: +b.toFixed(4) };
}

/**
 * @param {string} id      circuit that must be booted, or falsy for whatever is
 * @param {{name?: string}} opts  `name` overrides the output file, so a dial
 *   (see ?roadGrain) can put several rungs side by side without each one
 *   overwriting the last. The pin, the liveness guard and the camera are
 *   deliberately NOT parameterised: they are what make the frames comparable.
 */
export async function tourShot(id, opts = {}) {
  const s = window.MG?.status;
  if (!s) return { booting: true, msg: document.querySelector('#boot .boot-msg')?.textContent };

  const track = window.MG.ctx?.track;
  const got = track?.id || '?';
  if (id && got !== id) return { refused: `asked for ${id}, booted ${got}` };

  const pin = pinMoment();
  if (!pin.pinned) return { refused: 'could not pin the moment', pin };

  const live = moving();
  if (!live.moving) {
    return { refused: 'the field is not moving — this frame would not show a race', live,
             state: window.MG.ctx?.race?.state };
  }

  const shot = await window.MG.capture(opts.name || ('tour-' + got), 1920, 1080);

  // What the frame is made of, so a look and a count can be checked against
  // each other rather than one standing in for the other.
  const scene = window.MG.ctx?.scene;
  let meshes = 0, props = 0, tris = 0;
  scene?.traverse?.((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    if (o.userData?.mgProp || /prop/i.test(o.name || '')) props++;
    const g = o.geometry;
    const n = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3;
    tris += n * (o.isInstancedMesh ? (o.count || 1) : 1);
  });

  return { track: got, shot, pin, live, meshes, props, tris: Math.round(tris),
           info: window.MG.renderer?.info?.render };
}
