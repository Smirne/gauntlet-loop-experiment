// Does the road's grain continue the table's? Measured, not eyeballed.
//
// D23 — "the road does not read as a road" — has survived every attempt to
// close it with contrast. There is 58 luma of road-vs-table separation at the
// shipping camera and four judges still said it reads as a stain. The
// explanation left standing is CONTINUITY: the deck and the ground slab are the
// same world XZ projection of the same kind of wood, so the grain, the knots
// and the plank joints run straight through the road edge unbroken. One board,
// with a dark patch on it.
//
// That is a claim about texture ORIENTATION, so this measures orientation.
// For each of two patches — one wholly inside the road, one wholly on the table
// — it builds a gradient-orientation histogram weighted by gradient magnitude
// and reports the dominant angle. The number that matters is the difference:
//
//   delta ~ 0 deg   the road is made of the table
//   delta = N deg   the road is a separate board laid across it
//
//   const m = await import('/tools/grain-probe.js'); await m.grain();
//
// Two disciplines it inherits from earlier instruments in this project:
//
//   * THE DIRECTOR IS DISABLED FIRST (D26). Every figure in the original D23
//     was taken through a camera that was still drifting, and all of them were
//     void.
//   * IT RENDERS STRAIGHT, NOT THROUGH THE COMPOSER. Film grain, bloom and DOF
//     are all texture-shaped, and an instrument that measures grain must not
//     measure the grain the post stack adds. room-share.js learned this the
//     expensive way.
//   * ONLY track:road AND track:ground ARE VISIBLE. The first run of this file
//     reported the road at concentration 0.17 against the table's 0.62 and a
//     21.6 deg separation, which looked like a result and was an artefact: the
//     patch was sitting on the painted lane markings, whose dashes are straight,
//     bright and aligned to the circuit. It was measuring the paint. Markings,
//     kerbs, cars, props and decals are all separate meshes, so the wood can be
//     asked about on its own.
//
// The measurement camera IS set here, deliberately, and that is the one place
// this file departs from THE CAMERA IS NOT YOURS TO SET. An orthographic view
// straight down a straight, with screen +x along the track's lateral axis,
// makes the road a vertical band of known pixel width — so the two patches are
// placed by geometry rather than by eye. Nothing this file renders is ever
// published as a frame.

const W = 900, H = 900;

let _cv = null;
function scratch() {
  if (!_cv) { _cv = document.createElement('canvas'); _cv.width = W; _cv.height = H; }
  return _cv.getContext('2d', { willReadFrequently: true });
}

/**
 * Dominant grain direction of a pixel rectangle, by circular statistics on the
 * DOUBLED gradient angle.
 *
 * Doubling is not a flourish. Grain is an undirected line, not an arrow: a
 * gradient at 10 deg and one at 190 deg are the same piece of wood. Averaging
 * the raw angles cancels them to nothing. Doubling maps both to 20 deg, so they
 * reinforce, and the result is halved back at the end.
 *
 * `concentration` is the resultant length, 0..1 — how directional the patch is
 * at all. A patch with no grain has no angle worth reporting, so it is returned
 * alongside the angle rather than left for the caller to assume.
 */
function orientation(px, x0, y0, w, h) {
  let sx = 0, sy = 0, mag = 0, n = 0;
  const at = (x, y) => {
    const i = ((y0 + y) * W + (x0 + x)) * 4;
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      // Sobel.
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const m = Math.hypot(gx, gy);
      if (m < 2) continue;                 // flat pixels carry no orientation
      const a2 = 2 * Math.atan2(gy, gx);   // doubled: see above
      sx += m * Math.cos(a2);
      sy += m * Math.sin(a2);
      mag += m;
      n++;
    }
  }
  if (!n || mag <= 0) return { angle: null, concentration: 0, samples: 0 };
  const ang = 0.5 * Math.atan2(sy, sx) * 180 / Math.PI;
  return {
    // Gradient direction is perpendicular to the grain it came from; +90 puts
    // the reported angle along the grain, which is what a person would name.
    angle: +(((ang + 90) % 180 + 180) % 180).toFixed(2),
    concentration: +(Math.hypot(sx, sy) / mag).toFixed(4),
    contrast: +(mag / n).toFixed(2),
    samples: n,
  };
}

/**
 * Below this resultant length the patch has no dominant direction, and an angle
 * taken from it is noise with a decimal point on it.
 *
 * Not a guess. At kitchen t=0.05 the road patch came back at concentration 0.13
 * against 0.42-0.60 at t=0.03/0.07/0.09, with the HIGHEST contrast of the four
 * — something bright and undirected sitting on it, near the start line. The
 * angle it produced made the 35 deg setting look like it had made things
 * WORSE at that one point (separation 3.19 against a 6.26 baseline), which is
 * the opposite of what every neighbouring sample said. Refusing to answer is
 * the correct answer.
 */
const MIN_CONCENTRATION = 0.25;

/** Smallest angle between two undirected directions, 0..90. */
function sep(a, b) {
  if (a === null || b === null) return null;
  const d = Math.abs(a - b) % 180;
  return +(d > 90 ? 180 - d : d).toFixed(2);
}

export async function grain(opts = {}) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const T = MG.THREE, e = MG.engine, track = MG.ctx?.track;
  if (!track) return { refused: 'no track' };

  // D26: the director drifts the camera, and every void figure in D23 was taken
  // through that drift. It cannot move what it does not own, but disable it
  // anyway — this file swaps the camera out and must put back what it found.
  const dir = MG.ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;
  e.pause?.('grain-probe');

  // SHADOWS OFF. This is a measurement of texture, and a shadow edge is a long,
  // straight, high-contrast oriented gradient — precisely the thing being
  // measured, arriving from somewhere else. It is the same fault as the lane
  // markings in the header, wearing different clothes.
  //
  // Found because the table's contrast — which nothing under test can affect —
  // flipped between 11.64 and 42.53 depending on what had been rendered before,
  // while its angle and both road figures stayed put. Chasing that with more
  // warm-up renders was the wrong repair: the number was not settling late, it
  // was reporting a prop's shadow falling across the patch in some runs and not
  // others. Removing the light's contribution to structure removes the whole
  // class of it.
  const shadowsWere = e.renderer.shadowMap.enabled;
  e.renderer.shadowMap.enabled = false;

  // A straight. Curvature would bend the road band and put table inside the
  // "road" patch, which would measure the boundary rather than either side of
  // it. Picked by scanning rather than hardcoded, so this survives a path edit.
  const t0 = opts.t ?? (() => {
    let best = 0.075, bestK = Infinity;
    for (let i = 0; i < 400; i++) {
      const t = i / 400;
      const k = Math.abs(track.curvatureAt?.(t) ?? 0);
      const w = track.widthAt(t);
      if (k < bestK && w > 20) { bestK = k; best = t; }
    }
    return best;
  })();

  const hw = track.widthAt(t0) * 0.5;
  const c = new T.Vector3(), fwd = new T.Vector3(), lat = new T.Vector3();
  track.surfacePoint(t0, 0, c);
  track.surfacePoint(t0 + 0.002, 0, fwd);
  fwd.sub(c).setY(0).normalize();
  lat.crossVectors(new T.Vector3(0, 1, 0), fwd).normalize();

  // Everything except the two surfaces under test. See the header: the first
  // run of this file measured the lane markings and called it grain.
  const KEEP = /^track:(road|ground)$/;
  const hidden = [];
  e.scene.traverse((o) => {
    if (!o.isMesh || KEEP.test(o.name || '')) return;
    if (o.visible) { hidden.push(o); o.visible = false; }
  });

  // Tight enough that the road patch is worth measuring. At the old 110 the
  // road came out 35 px across, which is not a texture, it is a thumbnail.
  const halfSpan = opts.span ?? 55;

  // Orthographic, looking straight down, screen +x along lateral. The road is
  // then a vertical band exactly (hw / halfSpan) * (W/2) pixels from centre,
  // which is what lets the two patches be placed arithmetically.
  const cam = new T.OrthographicCamera(-halfSpan, halfSpan, halfSpan, -halfSpan, 1, 4000);
  cam.position.set(c.x, c.y + 900, c.z);
  cam.up.copy(fwd);
  cam.lookAt(c.x, c.y, c.z);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  const pxPerU = (W / 2) / halfSpan;
  const roadPx = hw * pxPerU;

  const g = scratch();
  // Warm-up renders, then the one that counts.
  //
  // The first call after a boot reported the TABLE — which nothing under test
  // can affect — at contrast 11.64 against the 42.53 every settled run gives,
  // and its angle 0.6 deg off. Textures are still being uploaded on that first
  // pass. A reading that changes depending on how soon it is taken is not a
  // reading, so the frames are thrown away rather than averaged in.
  //
  // Rendered back to back rather than across animation frames: this file is
  // driven from a backgrounded browser pane, where requestAnimationFrame does
  // not fire and an await on one never returns.
  for (let i = 0; i < 2; i++) e.renderer.render(e.scene, cam);
  e.renderer.render(e.scene, cam);          // straight, NOT the composer
  g.clearRect(0, 0, W, H);
  g.drawImage(e.renderer.domElement, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;

  // Patch geometry. The road patch stops at 60% of the half width so kerbs,
  // edge lines and the shoulder blend cannot leak in; the table patch starts
  // 25 u beyond the edge for the same reason at the other end.
  const box = Math.round(Math.min(roadPx * 0.55, 170));
  const cx = W / 2, cy = H / 2;
  const roadRect = [Math.round(cx - box / 2), Math.round(cy - box / 2), box, box];
  const offPx = Math.round((hw + 25) * pxPerU + box / 2);
  const tableRect = [Math.round(cx + offPx - box / 2), Math.round(cy - box / 2), box, box];

  const fits = tableRect[0] + box < W;
  const road = orientation(px, ...roadRect);
  const table = fits ? orientation(px, ...tableRect) : { angle: null, concentration: 0 };
  // See MIN_CONCENTRATION. A patch with no direction does not get to contribute
  // one, so the angle is dropped rather than passed on for sep() to average in.
  for (const p of [road, table]) {
    if (p.angle !== null && p.concentration < MIN_CONCENTRATION) {
      p.undirected = true;
      p.angle = null;
    }
  }

  for (const o of hidden) o.visible = true;
  e.renderer.shadowMap.enabled = shadowsWere;
  e.renderer.shadowMap.needsUpdate = true;
  if (dir) dir.enabled = dirWas;
  e.resume?.('grain-probe');

  return {
    t: +t0.toFixed(4),
    halfWidth: +hw.toFixed(1),
    roadGrainDeg: Number(new URLSearchParams(location.search).get('roadGrain')) || 0,
    surface: track.surfaceAt?.(t0)?.kind ?? track.surface,
    road,
    table,
    /** THE NUMBER. 0 means the road is made of the table; null means ask elsewhere. */
    separationDeg: sep(road.angle, table.angle),
    patchPx: box,
    tableFitsInFrame: fits,
  };
}
