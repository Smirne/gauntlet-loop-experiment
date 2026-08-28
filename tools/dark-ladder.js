// D57: four ways to make the bedroom's dark holes readable, rendered from one
// boot, at one moment, so a human can flip between them.
//
// The measurement is already done (see D57): road-ahead luma swings 37-172
// round the lap and the first ramp at t = 0.148 sits in the trough, lit by a
// single lamp at irradiance 5.6 with d^2 falloff and nothing else in the rig
// above 0.5. What is NOT decided, and is not mine to decide, is which way to
// lift it. "Brighter" is not one option, it is four, and they are four
// different games at night.
//
// So this renders the candidates rather than arguing them:
//
//   base      what ships now
//   ambient   lift the room's floor -- ambient and hemisphere fill up
//   lamp      the existing lamp does more work -- brighter and wider
//   road      the road surface self-lights; the room stays as dark as it is
//   exposure  POSITIVE CONTROL, a global exposure lift that must show up
//   base2     FLOOR, `base` again at the end
//
// DISCIPLINE, all of it learned the hard way on this project:
//
//  * ONE BOOT. A pinned frame is not the moment it says it is (D55): two boots
//    of an identical URL, both asserting the same frame number, came back 91%
//    of pixels apart. Every frame here comes from one page load.
//  * ONE SYNCHRONOUS TASK. Render, toDataURL and the variant switch all happen
//    in one JS task with no `await` between them, so no rAF can interleave and
//    move the world under the ladder. The data URLs are collected first and
//    POSTed afterwards.
//  * THE DIRECTOR STAYS ON. It owns the camera and drives it from the render
//    loop, not the fixed step; disabling it leaves the camera behind while the
//    cars drive away, and the probe still cheerfully reports `ok: true` (D55).
//    So this rides the live loop to the moment and then simply stops stepping.
//  * A FLOOR AND A CONTROL. `base` is rendered first and last and must come
//    back byte-identical, or the ladder is measuring the scheduler. `exposure`
//    is a change that cannot fail to be visible, so a run where it reads as
//    zero is void no matter what the other rows say.
//
//   const m = await import('/tools/dark-ladder.js');
//   await m.ladder();                 // drives to the ramp, then renders
//
// Nothing here is a fix. It is a chooser.

const TARGET_T = 0.152;          // the first ramp, from bedroom.js (t = 0.148)
const TOL = 0.012;

/** The candidates. Each gets the rig back in `base` state before it is applied. */
export const VARIANTS = [
  { name: 'base', label: 'shipped', apply: () => {} },
  {
    name: 'ambient',
    label: 'lift the room floor',
    note: 'ambient 0.18 -> 0.62, hemisphere fill 0.26 -> 0.58',
    apply: (P) => { P.ambient.intensity = 0.62; P.fill.intensity = 0.58; },
  },
  {
    name: 'lamp',
    label: 'the lamp does more work',
    note: 'irradiance 5.6 -> 15.5, cone 0.66 -> 0.92 rad',
    apply: (P) => { P.lamp.irradiance = 15.5; P.lamp.angle = 0.92; },
  },
  {
    name: 'road',
    label: 'the road self-lights',
    note: 'road materials only: emissive lifted, room untouched',
    road: 0.34,
    apply: () => {},
  },
  {
    name: 'exposure',
    label: 'CONTROL — global exposure',
    note: 'exposure 1.20 -> 1.95; must be visible or the run is void',
    apply: (P) => { P.exposure = 1.95; },
  },
  { name: 'base2', label: 'FLOOR — shipped, again', apply: () => {} },
];

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * @param {{t?: number, w?: number, h?: number, prefix?: string}} [opts]
 */
export async function ladder(opts = {}) {
  const MG = window.MG;
  const engine = MG.engine;
  const renderer = engine.renderer;
  const lighting = MG.ctx.lighting;
  const preset = 'nightLamp';

  const mod = await import('/src/render/Lighting.js');
  const PRESETS = mod.LIGHT_PRESETS;
  const P = PRESETS[preset];
  if (!P) throw new Error('no nightLamp preset');
  const pristine = clone(P);

  const wantT = opts.t ?? TARGET_T;
  const prefix = opts.prefix ?? 'd57';

  // ---- 1. drive to the moment ----------------------------------------------
  // NOT on rAF. In this project's only browser the game runs in a hidden pane
  // where rAF is throttled to roughly 0.1 s of race per composite, so waiting
  // for the car to reach a place on the lap never finishes. Drive `_tick` by
  // hand off a synthetic 60 Hz clock instead: it runs lateUpdate, so the
  // DIRECTOR still drives the camera and the pose is a real one. `stepOnce`
  // would not, which is the D55 trap — it moves the cars and leaves the camera
  // behind while reporting success.
  const car = MG.ctx.player;
  engine.stop();
  if (engine.paused) engine.resume('darkladder');
  const arrived = (() => {
    let clock = performance.now();
    const stepMs = 1000 / 60;
    for (let i = 0; i < 6000; i++) {
      const t = car.trackT ?? 0;
      if (Math.abs(t - wantT) < TOL) return { ok: true, t: +t.toFixed(4), ticks: i };
      clock += stepMs;
      engine._tick(clock);
    }
    return { ok: false, t: +(car.trackT ?? 0).toFixed(4), ticks: 6000 };
  })();

  const pose = {
    t: +(car.trackT ?? 0).toFixed(4),
    clock: +(MG.ctx.race?.raceTime ?? 0).toFixed(2),
    frame: engine.time.frame,
    cam: renderer && MG.ctx.camera ? MG.ctx.camera.position.toArray().map((v) => +v.toFixed(2)) : null,
  };

  // Road materials, for the `road` variant.
  //
  // NOT from `ctx.trackBuilder` — that is a module wrapper exposing
  // { TrackBuilder, default }, not the instance, so `roadMaterials` on it is
  // undefined and the variant silently rendered the base frame. It read as
  // "lighting the road does nothing", which is the most expensive kind of
  // wrong: a null that looks like a finding. Take them off the scene instead,
  // by the names TrackBuilder actually gives the meshes.
  //
  // `track:ground` is deliberately NOT in this list. It is the off-track
  // carpet, and leaving it dark is the entire point of this candidate: the
  // surface you must read lights up, the room does not.
  const ROAD_NODES = /^track:(road|kerbs|markings)$/;
  const roadMatSet = new Set();
  MG.ctx.scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || !ROAD_NODES.test(o.name || '')) return;
    const m = o.material;
    for (const mm of (Array.isArray(m) ? m : [m])) if (mm && mm.emissive) roadMatSet.add(mm);
  });
  const roadMats = [...roadMatSet];
  if (!roadMats.length) throw new Error('no road materials found — the `road` variant would be a false zero');
  const roadWas = roadMats.map((m) => ({
    m, emissive: m.emissive ? m.emissive.getHex() : null,
    intensity: m.emissiveIntensity,
  }));

  const restoreRoad = () => {
    for (const r of roadWas) {
      if (r.m.emissive && r.emissive !== null) r.m.emissive.setHex(r.emissive);
      r.m.emissiveIntensity = r.intensity;
    }
  };

  // ---- 2. the ladder, in ONE synchronous task ------------------------------
  const shots = [];
  const rows = [];
  const band = [0.34, 0.30, 0.66, 0.72];   // road ahead, for a luma number
  const oc = new OffscreenCanvas(64, 32);
  const g2 = oc.getContext('2d', { willReadFrequently: true });
  const canvas = renderer.domElement;

  const lumaOf = () => {
    const cw = canvas.width, ch = canvas.height;
    const sx = Math.round(band[0] * cw), sy = Math.round(band[1] * ch);
    const sw = Math.max(1, Math.round((band[2] - band[0]) * cw));
    const sh = Math.max(1, Math.round((band[3] - band[1]) * ch));
    g2.drawImage(canvas, sx, sy, sw, sh, 0, 0, 64, 32);
    const px = g2.getImageData(0, 0, 64, 32).data;
    let sum = 0; const n = 64 * 32;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    }
    return +(sum / n).toFixed(2);
  };

  for (const v of VARIANTS) {
    // Reset to shipped, then apply this one. Resetting every time is what makes
    // the rows independent rather than cumulative.
    Object.assign(P, clone(pristine));
    restoreRoad();
    v.apply(P);
    lighting.setPreset(preset, { transition: 0 });

    if (v.road) {
      for (const r of roadWas) {
        if (!r.m.emissive) continue;
        // Lift the road's own emission toward the lamp's warm colour. This is
        // the one candidate that leaves the room exactly as dark as it is and
        // only makes the surface you have to read carry itself.
        r.m.emissive.setHex(0x6b5a44);
        r.m.emissiveIntensity = v.road;
      }
    }

    // The rig's own per-frame work lives in update/lateUpdate, not in render:
    // contact strength is baked when the blobs are rebuilt, and the cascades
    // are fitted in lateUpdate. Rendering without this leaves the frame lit by
    // the PREVIOUS row's rig.
    engine.syncSystems?.();
    for (const c of (lighting.cascades || [])) c.light.shadow.needsUpdate = true;
    engine.renderFrame(0);

    // Read the rig back. A variant whose change did not land renders the base
    // frame and reports a difference of zero, which is indistinguishable from
    // "this candidate does not help" unless the applied value is checked. It
    // already happened once here, to `road`.
    const applied = {
      ambient: +(lighting.ambient?.intensity ?? -1).toFixed(3),
      fill: +(lighting.fill?.intensity ?? -1).toFixed(3),
      lampIntensity: +(lighting.lamp?.intensity ?? -1).toFixed(1),
      lampAngle: +(lighting.lamp?.angle ?? -1).toFixed(3),
      exposure: +(renderer.toneMappingExposure ?? -1).toFixed(3),
      roadEmissive: roadMats[0]?.emissive?.getHexString?.() ?? null,
      roadEmissiveIntensity: roadMats[0]?.emissiveIntensity ?? null,
    };
    rows.push({ name: v.name, label: v.label, note: v.note || '', roadLuma: lumaOf(), applied });
    shots.push({ name: `${prefix}-${v.name}`, url: canvas.toDataURL('image/png') });
  }

  // ---- 3. put the world back ----------------------------------------------
  Object.assign(P, clone(pristine));
  restoreRoad();
  lighting.setPreset(preset, { transition: 0 });
  engine.syncSystems?.();
  engine.start();

  // ---- 4. now, and only now, touch the network ----------------------------
  const written = [];
  for (const s of shots) {
    const res = await fetch('/__shot?name=' + encodeURIComponent(s.name), { method: 'POST', body: s.url });
    written.push((await res.json()).path);
  }

  const base = rows.find((r) => r.name === 'base');
  const base2 = rows.find((r) => r.name === 'base2');
  const control = rows.find((r) => r.name === 'exposure');
  return {
    arrived, pose, rows, written,
    floorLumaDelta: base && base2 ? +(base2.roadLuma - base.roadLuma).toFixed(3) : null,
    controlLumaDelta: base && control ? +(control.roadLuma - base.roadLuma).toFixed(2) : null,
  };
}
