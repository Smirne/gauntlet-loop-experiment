// How much of a frame is ROOM — floor, walls, the props standing on the floor —
// as opposed to the table, the track and the cars.
//
// Two earlier answers to this question were wrong, both in ways worth keeping
// written down:
//
//  1. Hiding every MG.Room object and diffing the frame against itself answers
//     "what does the room AFFECT", not "where is the room". Its floor and walls
//     bounce light into the whole scene, so at the close end of the menu orbit —
//     where the image plainly shows no room at all — that method reported 50-60%.
//
//  2. It was run with film grain still on. Capturing the SAME frame three times
//     with nothing hidden gives consecutive diffs of 32.7% and 32.6%. Zero the
//     grain and the same test gives 0.00%. ZERO THE GRAIN BEFORE A FRAME-DIFF.
//
// What works: paint every MG.Room mesh flat magenta, everything else flat black,
// render with the depth buffer doing the occlusion, count magenta. Control 0.0%.
//
//   const m = await import('/tools/room-share.js');
//   m.roomShare();                  // the frame as currently posed
//   await m.orbitSweep();           // along the menu backdrop orbit

const W = 480;
const H = 270;
let _canvas = null;
let _mag = null;
let _blk = null;

function scratch() {
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _canvas.width = W;
    _canvas.height = H;
  }
  return _canvas.getContext('2d', { willReadFrequently: true });
}

/** Fraction of the current frame, 0..100, showing room a viewer can actually see. */
export function roomShare() {
  const MG = window.MG;
  const e = MG.engine;
  const sc = e.scene;
  const T = MG.THREE;
  const cam = MG.ctx.camera;
  if (!_mag) {
    _mag = new T.MeshBasicMaterial({ color: 0xff00ff });
    _blk = new T.MeshBasicMaterial({ color: 0x000000 });
  }

  const saved = [];
  sc.traverse((o) => {
    if (!o.isMesh) return;
    saved.push([o, o.material]);
    o.material = /^MG\.Room/.test(o.name || '') ? _mag : _blk;
  });
  const bg = sc.background;
  sc.background = new T.Color(0x000000);

  // Straight renderer.render, NOT the composer: post is irrelevant to a mask and
  // the grain in it is exactly what poisoned the previous instrument.
  e.renderer.render(sc, cam);

  const g = scratch();
  g.clearRect(0, 0, W, H);
  g.drawImage(e.renderer.domElement, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;

  sc.background = bg;
  for (const p of saved) p[0].material = p[1];

  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 140 && px[i + 2] > 140 && px[i + 1] < 110) n++;
  }
  return +((100 * n) / (W * H)).toFixed(1);
}

/**
 * Room share along the menu backdrop orbit — the only place the wide camera
 * exists. Boot into attract (no `skipmenu`) and call this.
 */
export async function orbitSweep(step = 0.4, until = 8.8) {
  const MG = window.MG;
  const e = MG.engine;
  const d = MG.ctx.director;
  if (MG.ctx.race?.state !== 'attract') {
    return { refused: 'not in attract — boot without ?skipmenu=1', state: MG.ctx.race?.state };
  }

  const real = e.renderFrame;
  let suppressed = true;
  e.renderFrame = function () { if (!suppressed) return real.apply(this, arguments); };
  const out = [];
  try {
    let next = 0.2;
    for (let s = 0; s < 1400 && next <= until; s++) {
      e.stepOnce();
      if (d.modeTime >= next) {
        suppressed = false;
        out.push([+d.modeTime.toFixed(1), roomShare()]);
        suppressed = true;
        next += step;
      }
    }
  } finally {
    e.renderFrame = real;
  }
  const v = out.map((x) => x[1]).sort((a, b) => a - b);
  return {
    samples: out,
    min: v[0],
    median: v[v.length >> 1],
    max: v[v.length - 1],
    mean: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1),
  };
}
