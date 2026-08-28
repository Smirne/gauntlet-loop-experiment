// D53: measure the SHAPE of a shadow, not its darkness.
//
// Everything D53 has measured so far is a density question, and density has
// come back saying the car's shadow is fine: it is drawn, correctly placed,
// and peaks DARKER than the props'. Eight blind critics still say the cars have
// no contact shadow and read as decals. So the missing quantity is probably not
// how dark the shadow is but whether it has an EDGE, and nothing here has ever
// measured an edge.
//
// The metric is DIFFERENCE IMAGING: a shadow is exactly what disappears when
// you switch it off. Render the region with the shadow and without it, subtract,
// and the residue is that shadow alone — no wood grain, no carpet, no bodywork,
// no headlight spill. Then ask of that residue how big it is, how dark it gets,
// and whether it has an EDGE, measured as the peak gradient of the difference
// field. A hard-edged shadow puts a step in the difference image; a soft blob
// cannot, however dark it is.
//
// The first version of this file measured absolute gradients inside the region
// instead, and it was useless: it came back saying 21.3% of the region was
// "edge" in every variant, because a fifth of a wooden track at 2560x1440 is
// grain. Removing the ENTIRE contact halo moved that number by 0.1, which is
// not a finding about halos, it is a finding about the instrument. Absolute
// gradient over a textured receiver is dominated by the receiver.
//
// THE POSITIVE CONTROL IS THE POINT. A metric that says "the car is soft" is
// worth nothing on its own — it might just be a bad metric. So one variant
// hides the car and stands a box of its own footprint in EXACTLY its place:
// same ground, same receiver material, same light, same cascade, same screen
// region, same pixels. D53 already established by eye that such a box casts a
// crisp hard-edged rectangle. If the metric does not say so too, the metric is
// wrong and the run is void.
//
// Beside the car was the obvious place to put it and it is the wrong one: at
// the chase pose there is about 12 u of track to the car's right and then
// carpet, so a box far enough away for the two shadow regions not to overlap
// lands on a different receiver. Comparing a shadow on wood to a shadow on
// carpet measures the carpet.
//
// The hypothesis it exists to test: the contact HALO is what destroys the
// contour. It is the one thing cars have and props and boxes do not — a soft
// dark oval 1.75 x 2.30 of the footprint, centred on the car, sitting on top of
// and around the smaller crisp cast shadow. If it is burying the edge, then
// turning it off should raise the car's gradient numbers toward the box's.
//
//   const m = await import('/tools/shadow-shape.js'); await m.shapeProbe();

const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Screen-space AABB of a ground quad centred on `pos`, half-extent `ext` u. */
function groundAABB(THREEV3, cam, pos, ext, w, h, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const dx of [-ext, ext]) {
    for (const dz of [-ext, ext]) {
      const p = new THREEV3(pos.x + dx, pos.y, pos.z + dz).project(cam);
      const sx = (p.x * 0.5 + 0.5) * w, sy = (-p.y * 0.5 + 0.5) * h;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
  }
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(w, Math.ceil(x1 + pad));  y1 = Math.min(h, Math.ceil(y1 + pad));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * Screen-space AABB of an Object3D's world bounding box.
 *
 * Used to MASK THE OBJECT OUT of the measurement. Without it, switching off a
 * car's castShadow also stops the car self-shadowing, so the difference field
 * picks up its bodywork: the first paired run reported a peak of 105.6 luma for
 * "the car's cast shadow", which is a specular highlight on a wing mirror, not
 * anything on the ground. D53 is a question about the ground.
 */
function objectAABB(THREE, obj, cam, w, h, pad) {
  const b = new THREE.Box3().setFromObject(obj);
  if (!isFinite(b.min.x) || b.isEmpty()) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const cx of [b.min.x, b.max.x]) {
    for (const cy of [b.min.y, b.max.y]) {
      for (const cz of [b.min.z, b.max.z]) {
        const p = new THREE.Vector3(cx, cy, cz).project(cam);
        const sx = (p.x * 0.5 + 0.5) * w, sy = (-p.y * 0.5 + 0.5) * h;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
    }
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Luma field of one ImageData, as Float32 in 0..255. */
function lumaField(px, n) {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    L[i] = LUMA(px[o], px[o + 1], px[o + 2]);
  }
  return L;
}

/** Plain luma summary, kept only so each variant's absolute level is on record. */
function level(L) {
  let sum = 0, min = 255;
  for (let i = 0; i < L.length; i++) { sum += L[i]; if (L[i] < min) min = L[i]; }
  return { meanLuma: +(sum / L.length).toFixed(2), minLuma: +min.toFixed(2) };
}

/**
 * Isolate one shadow by subtraction and describe its shape.
 *
 * `withIt` minus `withoutIt`, so a shadow is a NEGATIVE delta. Everything is
 * reported on |delta|, so the numbers read as "how much darker".
 *
 *   areaPct  - fraction of the region the shadow touches at all (|d| > 1/255)
 *   peak     - the darkest it ever gets, in luma
 *   mean     - its mean depth over the area it touches
 *   gradP99  - 99th percentile of |grad(d)|: the shape number
 *   gradMax  - the single hardest step in the difference field
 *
 * gradP99/gradMax are the whole point. A crisp shadow's difference field is a
 * plateau with a cliff around it; a soft blob's is a hill. Both can be equally
 * deep. Only the cliff shows up here.
 */
function isolate(withIt, withoutIt, w, h, floorDelta, mask) {
  const n = w * h;
  const D = new Float32Array(n);
  const inMask = (x, y) => mask && x >= mask.x0 && x <= mask.x1 && y >= mask.y0 && y <= mask.y1;
  let area = 0, peak = 0, sum = 0, counted = 0;
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0;
    if (inMask(x, y)) { D[i] = 0; continue; }
    counted++;
    const d = withoutIt[i] - withIt[i];   // positive where the shadow darkens
    D[i] = d;
    const a = Math.abs(d);
    if (a > floorDelta) { area++; sum += a; if (a > peak) peak = a; }
  }
  const grads = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (inMask(x, y) || inMask(x - 1, y) || inMask(x + 1, y) || inMask(x, y - 1) || inMask(x, y + 1)) continue;
      const i = y * w + x;
      grads.push(Math.hypot(D[i + 1] - D[i - 1], D[i + w] - D[i - w]));
    }
  }
  grads.sort((a, b) => a - b);
  const q = (p) => (grads.length ? +grads[Math.min(grads.length - 1, Math.floor(p * grads.length))].toFixed(2) : 0);
  const peakV = +peak.toFixed(2);
  const p999 = q(0.999);
  return {
    areaPct: +(100 * area / Math.max(1, counted)).toFixed(3),
    peak: peakV,
    mean: +(area ? sum / area : 0).toFixed(2),
    gradP99: q(0.99), gradP999: p999,
    gradMax: grads.length ? +grads[grads.length - 1].toFixed(2) : 0,
    // THE SHAPE NUMBER. How much of the shadow's own depth turns up inside a
    // single pixel at its sharpest. A hard edge approaches 1; a soft blob of
    // the same depth stays near 0. Depth-normalised on purpose, so "darker"
    // cannot be mistaken for "sharper".
    sharpness: peakV > 0 ? +(p999 / peakV).toFixed(3) : 0,
  };
}

/**
 * @param {{ext?: number, pad?: number, floorDelta?: number, w?: number,
 *           h?: number, ss?: number, save?: boolean}} [opts]
 *   ext        - half-extent of the sampled ground quad, in footprint widths
 *   floorDelta - |luma delta| below which a pixel is not part of the shadow
 *                (default 1/255, one code value)
 */
export async function shapeProbe(opts = {}) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const THREE = await import('three');   // resolved by the page's import map
  const engine = MG.engine, renderer = engine.renderer, cam = engine.camera;
  const lighting = MG.ctx.lighting;
  const car = MG.ctx.player;
  const w = opts.w ?? 1280, h = opts.h ?? 720, ss = opts.ss ?? 2;
  const RW = w * ss, RH = h * ss;
  const pad = opts.pad ?? 24;

  const dir = MG.ctx.director, dirWas = dir?.enabled;
  if (dir) dir.enabled = false;
  const wasPaused = engine.paused;
  if (!wasPaused) engine.pause?.('shape');
  const drafts = engine.ctx?.surfaces?.settle?.() ?? [];
  const grain = engine.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;

  const prevPR = renderer.getPixelRatio();
  const prevW = Math.round(renderer.domElement.width / prevPR);
  const prevH = Math.round(renderer.domElement.height / prevPR);

  // ---- the positive control: a box standing exactly where the car stands ----
  const fp = car.visual.chassis.footprint;
  const carPos = new THREE.Vector3();
  car.visual.root.getWorldPosition(carPos);
  const cg = car.tuning?.cgHeight ?? 1.25;
  const carGround = carPos.clone(); carGround.y -= cg;
  const boxH = opts.boxHeight ?? 3.6;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(fp.width, boxH, fp.length),
    new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9, metalness: 0 }),
  );
  box.castShadow = true;
  box.receiveShadow = true;
  box.position.copy(carGround).setY(carGround.y + boxH / 2);
  box.quaternion.copy(car.visual.root.quaternion);
  box.visible = false;
  MG.ctx.scene.add(box);

  const ext = (opts.ext ?? 1.35) * Math.max(fp.width, fp.length);

  const csWas = lighting.contact ? lighting.contact.strength : null;
  const carCast = [];
  car.visual.root.traverse((o) => { if (o.isMesh) carCast.push([o, o.castShadow]); });

  const refreshShadows = () => {
    for (const c of lighting.cascades) c.light.shadow.needsUpdate = true;
  };

  const VARIANTS = [
    { name: 'base',       halo: csWas, cast: true,  box: false },
    { name: 'nohalo',     halo: 0,     cast: true,  box: false },
    { name: 'nocast',     halo: csWas, cast: false, box: false },
    { name: 'neither',    halo: 0,     cast: false, box: false },
    { name: 'box',        halo: 0,     cast: true,  box: true  },   // <- control
    { name: 'boxnocast',  halo: 0,     cast: false, box: true  },   // <- its off-state
    { name: 'base2',      halo: csWas, cast: true,  box: false },   // <- the floor
  ];

  const out = [];
  let region = null;
  let objMaskScreen = null;
  let failure = null;
  try {
    renderer.setPixelRatio(ss);
    renderer.setSize(w, h, false);
    engine.onResize?.(w, h);
    engine.ctx?.postfx?.notifyCameraCut?.();
    engine.syncSystems?.();

    region = groundAABB(THREE.Vector3, cam, carGround, ext, RW, RH, pad);
    // Union of the car's silhouette and the stand-in box's, so the same pixels
    // are excluded whichever object is on screen.
    box.visible = true;
    const aCar = objectAABB(THREE, car.visual.root, cam, RW, RH, 6);
    const aBox = objectAABB(THREE, box, cam, RW, RH, 6);
    box.visible = false;
    if (aCar && aBox) {
      objMaskScreen = {
        x0: Math.min(aCar.x0, aBox.x0), y0: Math.min(aCar.y0, aBox.y0),
        x1: Math.max(aCar.x1, aBox.x1), y1: Math.max(aCar.y1, aBox.y1),
      };
    } else objMaskScreen = aCar || aBox;

    const oc = new OffscreenCanvas(RW, RH);
    const g2 = oc.getContext('2d', { willReadFrequently: true });

    // ---- one synchronous task from here to the end of the loop ----
    for (const v of VARIANTS) {
      if (lighting.contact) lighting.contact.strength = v.halo;
      for (const [mesh, was] of carCast) mesh.castShadow = v.cast ? was : false;
      box.visible = v.box;
      // The `cast` flag has to reach the box too. The first run of the paired
      // design toggled it on the CAR's meshes only, and the car is hidden in
      // both box variants — so box and boxnocast rendered identically and the
      // positive control came back all zeros. A control that returns zero voids
      // the run; it does not get to be a finding.
      box.castShadow = v.cast;
      car.visual.root.visible = !v.box;
      // `contact.strength` is consumed when the blob instances are rebuilt, in
      // update/lateUpdate — not at render time. Setting it and rendering does
      // NOTHING, which the first run of this probe proved by returning a
      // byte-identical frame for halo-on and halo-off. Rebuild it per variant.
      lighting._updateContactShadows?.(MG.ctx);
      refreshShadows();
      engine.renderFrame?.(1 / 60);
      engine.renderFrame?.(1 / 60);
      g2.drawImage(renderer.domElement, 0, 0);
      const px = g2.getImageData(region.x, region.y, region.w, region.h).data;
      out.push({
        variant: v.name, halo: v.halo, casts: v.cast, boxStandsIn: v.box,
        L: lumaField(px, region.w * region.h),
        url: opts.save === false ? null : renderer.domElement.toDataURL('image/png'),
      });
    }
    // ---- end of the synchronous section ----
    out.region = region;
  } catch (err) {
    failure = err;
  } finally {
    if (lighting.contact && csWas !== null) lighting.contact.strength = csWas;
    for (const [mesh, was] of carCast) mesh.castShadow = was;
    car.visual.root.visible = true;
    refreshShadows();
    MG.ctx.scene.remove(box);
    box.geometry.dispose(); box.material.dispose();
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevW, prevH, false);
    engine.onResize?.(prevW, prevH);
    engine.ctx?.postfx?.notifyCameraCut?.();
    if (grain) grain.value = grainWas;
    if (!wasPaused) engine.resume?.('shape');
    if (dir) dir.enabled = dirWas;
  }
  if (failure) return { ok: false, error: failure.message, done: out.length };

  for (const r of out) {
    if (!r.url) continue;
    await fetch('/__shot?name=' + encodeURIComponent('d53-shape-' + r.variant), { method: 'POST', body: r.url });
    delete r.url;
  }

  const F = (name) => out.find((r) => r.variant === name).L;
  const RW2 = region.w, RH2 = region.h;
  const floorDelta = opts.floorDelta ?? 1;
  // One mask for every pairing, in region-local pixels, so all five isolations
  // are computed over the identical pixel set.
  const mask = objMaskScreen
    ? { x0: objMaskScreen.x0 - region.x, y0: objMaskScreen.y0 - region.y,
        x1: objMaskScreen.x1 - region.x, y1: objMaskScreen.y1 - region.y }
    : null;

  return {
    ok: true,
    frame: engine.time?.frame ?? null,
    clock: MG.ctx?.race?.raceTime ?? null,
    haloStrength: csWas,
    region, footprint: fp, objectMask: objMaskScreen,
    renderW: RW, renderH: RH, floorDelta, settledDrafts: drafts.length ?? 0,
    levels: out.map((r) => ({ variant: r.variant, ...level(r.L) })),
    isolated: {
      // the floor: the same render twice, subtracted. Must be all zeros.
      floor:      isolate(F('base'),  F('base2'),    RW2, RH2, floorDelta, mask),
      // the car's contact halo, alone
      halo:       isolate(F('base'),  F('nohalo'),   RW2, RH2, floorDelta, mask),
      // the car's real cast shadow, alone
      carCast:    isolate(F('nohalo'), F('neither'), RW2, RH2, floorDelta, mask),
      // both of the car's shadows together
      carBoth:    isolate(F('base'),  F('neither'),  RW2, RH2, floorDelta, mask),
      // THE POSITIVE CONTROL: a box of the car's footprint, in the car's place,
      // its own cast shadow isolated exactly the same way.
      boxCast:    isolate(F('box'),   F('boxnocast'), RW2, RH2, floorDelta, mask),
    },
  };
}
