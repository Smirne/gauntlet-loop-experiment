// D53: what the car looks like when its shadow can get out from under it.
//
// The measurement is done and is arithmetic (see D53). The bedside lamp sits at
// `offset: [-118, 205, -92]` — 149.6 u out, 205 u up, an elevation of 53.9° — so
// a cast shadow is `horizontal / vertical` = 0.73x the caster's height. For a car
// 9.12 u long and about 2.5 u tall that is roughly 1.8 u of shadow, which cannot
// reach past the bodywork above it. Measured: the car's cast shadow covers 0.877%
// of the sampled ground ANYWHERE, and exactly 0% of it outside the car's own
// screen silhouette. It is not missing and it is not misshapen. It is underneath.
//
// Lowering the lamp is the only lever that changes that, and it is not a tuning
// value — it moves the pool of light, the wall gradients and the whole character
// of the room. So this renders it rather than arguing it.
//
// AND IT RENDERS EACH HEIGHT TWICE, because the first run of this ladder asked
// the wrong question. Dropping the lamp from 205 to 80 also drops the whole
// frame's mean luma from 135.1 to 76.7 — the light arrives at the floor at a
// shallower angle, N·L collapses, and the room goes dark. Put those frames side
// by side and a human is judging "dimmer", not "longer shadow", and would answer
// about the wrong variable with complete confidence. So every lowered lamp also
// gets a BRIGHTNESS-MATCHED twin: the same geometry with `irradiance` solved by
// iteration until the GROUND AROUND THE CAR is back within 2% of shipped. Those
// are the rows that isolate shadow direction.
//
// The match is solved on the road band, not on the whole frame, and that choice
// is the result of getting it wrong first. Solved against whole-frame mean luma,
// none of the three lowered lamps converged: y110 and y80 ran the irradiance to
// the 200 clamp — 35x shipped — and moved the frame mean from 28.0 to only 32.0
// against a target of 55.1. Which is itself worth knowing, and is reported: a low
// lamp does not dim the room evenly, it concentrates the light into a small pool
// that blows out long before the rest of the room lifts at all. But the question
// here is what the CAR's shadow looks like, so the invariant to hold is the light
// on the ground the car is standing on.
//
//   base       y = 205, 53.9°, shadow 0.73x height   — what ships
//   y150/y110/y80                raw: lower lamp, and the dimming that comes with it
//   y150m/y110m/y80m             the same, brightness matched — the real comparison
//   y110msoft  y = 110 matched AND the contact halo cut to 0.45 — on the theory
//              that a real cast shadow makes the current halo read as a second,
//              doubled shadow
//   nohalo     POSITIVE CONTROL — the contact halo off entirely. It is the thing
//              currently doing all the grounding, so removing it cannot fail to
//              be visible. A run where this reads as no change is void.
//   base2      FLOOR — `base` again at the end.
//
// AND EACH MATCHED HEIGHT ALSO GETS A CASTER-OFF TWIN (`*nc`), because at the
// shipped racing camera — distance 94, height 77, the car about 60 px tall — a
// human cannot tell from a JPEG whether a shadow is present at all, and neither
// can I. Difference a row against its own caster-off twin and what is left is
// exactly the car's cast shadow, in pixels, at that lamp height. That is the
// number D53 actually turns on: not "does it look better" but "does any of it
// get out from under the car".
//
// ON THE FLOOR, honestly: it is NOT byte-identical here and two attempts to make
// it so (zeroing film grain, settling the texture drafts) did not close it. What
// is left is 638 of 921600 pixels, 633 of them at a delta of 4 or less, five at
// up to 42 inside one 53x13 box on the car — a mean absolute delta over the whole
// frame of 0.0008. The positive control moves the same statistic to 0.97, about
// 1200x the floor, and the candidates move it to 26-78. So the floor is measured
// rather than assumed, and it is far below everything being compared; the residual
// itself is unexplained and is written down rather than rounded away.
//
// Same discipline as tools/dark-ladder.js otherwise: one boot, one moment, one
// synchronous task, director left on so the pose is a real one.
//
// AND THE LAMP'S SHADOW MAP IS REFRESHED BY HAND. `lamp.shadow.autoUpdate` is
// false and `needsUpdate` is set only inside `Lighting._updateLamps`. Anything
// that renders without running update() keeps the shadow map from the previous
// lamp position, so every frame below would show the SHIPPED shadow no matter
// where the lamp was moved to. That exact fault voided the first D53
// re-measurement — its positive control came back zero — so it is worth saying
// twice: moving a light in this engine does not move its shadow until you say so.
//
//   const m = await import('/tools/shadow-ladder.js');
//   await m.ladder();
//
// Nothing here is a fix. It is a chooser.

const TARGET_T = 0.30;     // a lit, flattish stretch — the shadow has somewhere to fall
const TOL = 0.02;

const LAMP_X = -118, LAMP_Z = -92;
const HORIZ = Math.hypot(LAMP_X, LAMP_Z);          // 149.6
export const elevationOf = (y) => (Math.atan2(y, HORIZ) * 180) / Math.PI;
export const shadowLenOf = (y) => HORIZ / y;       // multiples of caster height

export const VARIANTS = [
  { name: 'base', label: 'shipped', y: 205 },
  { name: 'y150', label: 'lamp lower — raw', y: 150 },
  { name: 'y110', label: 'lamp lower still — raw', y: 110 },
  { name: 'y80', label: 'lamp low — raw', y: 80 },
  { name: 'y150m', label: 'lamp lower, brightness matched', y: 150, match: true },
  { name: 'y110m', label: 'lamp lower still, brightness matched', y: 110, match: true },
  { name: 'y80m', label: 'lamp low, brightness matched', y: 80, match: true },
  { name: 'y110msoft', label: 'lower + matched + halo cut', y: 110, match: true, halo: 0.45 },
  { name: 'nohalo', label: 'CONTROL — halo off', y: 205, halo: 0 },
  { name: 'base2', label: 'FLOOR — shipped again', y: 205 },
  // Caster-off twins. `matchTo` reuses the irradiance solved for the named row
  // rather than solving again, so the twin differs from its partner in exactly
  // one thing: whether the car casts.
  { name: 'basenc', label: 'shipped, car casts nothing', y: 205, nocast: true },
  { name: 'y150mnc', label: 'y150 matched, car casts nothing', y: 150, nocast: true, matchTo: 'y150m' },
  { name: 'y110mnc', label: 'y110 matched, car casts nothing', y: 110, nocast: true, matchTo: 'y110m' },
  { name: 'y80mnc', label: 'y80 matched, car casts nothing', y: 80, nocast: true, matchTo: 'y80m' },
];

const clone = (o) => JSON.parse(JSON.stringify(o));

/** @param {{t?: number, prefix?: string}} [opts] */
export async function ladder(opts = {}) {
  const MG = window.MG;
  const engine = MG.engine;
  const renderer = engine.renderer;
  const lighting = MG.ctx.lighting;
  const preset = 'nightLamp';

  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS[preset];
  if (!P) throw new Error('no nightLamp preset');
  const pristine = clone(P);

  const wantT = opts.t ?? TARGET_T;
  const prefix = opts.prefix ?? 'd53';

  // ---- drive to the moment, director on (D55) ------------------------------
  //
  // AND WITH A DRIVER. The player's car has no input source in a probe, and Input
  // does not merely fail to help — it writes all-zero controls every frame (see
  // the long note in tools/elim-probe.js). A crawling car takes 6000 ticks to get
  // a quarter of the way round, which is how the previous run of this ladder
  // finished on `ok: false` at t = 0.2737 with a frame mean luma of 55 against
  // 135 the time before: a different, darker part of the room, reached by
  // accident. The pose a chooser renders has to be the pose it asked for.
  const car = MG.ctx.player;
  engine.stop();
  if (engine.paused) engine.resume('shadowladder');
  MG.ctx.race.start();

  const { Driver } = await import('/src/ai/Driver.js');
  const alreadyDriven = (MG.ctx.drivers || []).some((d) => d.vehicle === car);
  const borrowed = alreadyDriven ? null : new Driver(MG.ctx, car, {
    skill: 0.84, aggression: 0.35, consistency: 0.9, seed: 4242,
  });
  const autoPollWas = car.autoPollInput;
  const inputWas = MG.ctx.input?.enabled;
  if (borrowed) {
    // Driven by hand immediately before the tick that consumes it, NOT via
    // engine.add — that appends after the vehicles and the steering saturates.
    car.autoPollInput = false;
    if (MG.ctx.input) MG.ctx.input.enabled = false;
  }

  const arrived = (() => {
    let clock = performance.now();
    for (let i = 0; i < 12000; i++) {
      const t = car.trackT ?? 0;
      if (i > 120 && Math.abs(t - wantT) < TOL) return { ok: true, t: +t.toFixed(4), ticks: i };
      clock += 1000 / 60;
      if (borrowed) { try { borrowed.update(1 / 60, MG.ctx); } catch (_) { /* keep going */ } }
      engine._tick(clock);
    }
    return { ok: false, t: +(car.trackT ?? 0).toFixed(4), ticks: 12000 };
  })();

  const restoreDriver = () => {
    if (!borrowed) return;
    try { borrowed.dispose?.(); } catch (_) { /* nothing owns it but us */ }
    car.autoPollInput = autoPollWas;
    if (inputWas !== undefined && MG.ctx.input) MG.ctx.input.enabled = inputWas;
  };

  // A ladder rendered at a pose it did not reach is not the ladder anyone asked
  // for, and there is no way to tell from the pictures. Fail loudly instead.
  if (!arrived.ok) {
    restoreDriver();
    engine.start();
    throw new Error(`never reached t=${wantT} (stopped at ${arrived.t} after ${arrived.ticks} ticks)`);
  }

  const pose = {
    t: +(car.trackT ?? 0).toFixed(4),
    clock: +(MG.ctx.race?.raceTime ?? 0).toFixed(2),
    frame: engine.time.frame,
  };

  // Two known sources of frame-to-frame difference on an unchanged scene, both
  // removed so the floor is as tight as it can be made:
  //
  //   * FILM GRAIN. Noise by construction. `shadow-shape.js` zeroes it too.
  //   * TEXTURE DRAFTS. Surfaces hands out a magnified 256 bake and sharpens it
  //     later; a draft settling between the first row and the last is a real
  //     pixel difference with nothing to do with the lamp.
  //
  // Neither closed the floor completely. See the header for what is left.
  const grain = engine.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;
  const settledDrafts = engine.ctx?.surfaces?.settle?.() ?? [];

  const canvas = renderer.domElement;

  // Two luma readings per frame, off 64x36 downsamples:
  //   ground — the band the car and its shadow occupy. The match is solved here.
  //   frame  — the whole picture. NOT matched; reported, so the room going dark
  //            stays visible instead of being hidden by the thing that fixed it.
  const oc = new OffscreenCanvas(64, 36);
  const g2 = oc.getContext('2d', { willReadFrequently: true });
  const BAND = [0.30, 0.42, 0.70, 0.86];   // around the car, on the road
  const meanOf = (sx, sy, sw, sh) => {
    g2.drawImage(canvas, sx, sy, sw, sh, 0, 0, 64, 36);
    const px = g2.getImageData(0, 0, 64, 36).data;
    let sum = 0; const n = 64 * 36;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    }
    return +(sum / n).toFixed(2);
  };
  const frameLuma = () => meanOf(0, 0, canvas.width, canvas.height);
  const groundLuma = () => {
    const cw = canvas.width, ch = canvas.height;
    return meanOf(
      Math.round(BAND[0] * cw), Math.round(BAND[1] * ch),
      Math.max(1, Math.round((BAND[2] - BAND[0]) * cw)),
      Math.max(1, Math.round((BAND[3] - BAND[1]) * ch)),
    );
  };

  // The player's own casters, so a row can be rendered with the car lit exactly
  // as before but casting nothing. Every mesh goes through VehicleVisual's single
  // `_mesh()` factory into `meshes`, so this is the whole car and nothing else.
  const casters = (MG.ctx.player?.visual?.meshes || []).filter((m) => m.castShadow);
  const setCasting = (on) => { for (const m of casters) m.castShadow = on; };

  // Apply one variant's rig and render it. Two passes: the shadow map flagged in
  // the first is only USED by the second.
  const applyAndRender = (v, irradiance) => {
    setCasting(!v.nocast);
    Object.assign(P, clone(pristine));
    P.lamp.offset = [LAMP_X, v.y, LAMP_Z];
    if (irradiance !== undefined) P.lamp.irradiance = irradiance;
    if (v.halo !== undefined) P.contact.strength = v.halo;

    lighting.setPreset(preset, { transition: 0 });

    // The rig's per-frame work lives in update/lateUpdate: the contact blobs are
    // rebuilt there, the cascades are fitted there, and the lamp's shadow is
    // flagged there. Rendering without it leaves the frame lit by the PREVIOUS
    // row's rig — and, specifically, shadowed by the previous row's lamp.
    engine.syncSystems?.();
    if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
    for (const c of (lighting.cascades || [])) c.light.shadow.needsUpdate = true;
    lighting._updateContactShadows?.(MG.ctx);

    engine.renderFrame(0);
    engine.renderFrame(0);
    return { ground: groundLuma(), frame: frameLuma() };
  };

  const shots = [];
  const rows = [];
  let target = null;

  const solvedIrradiance = {};

  for (const v of VARIANTS) {
    let irradiance = v.matchTo && solvedIrradiance[v.matchTo] !== undefined
      ? solvedIrradiance[v.matchTo]
      : pristine.lamp.irradiance;
    let luma = applyAndRender(v, (v.match || v.matchTo) ? irradiance : undefined);
    const solve = [];

    if (v.name === 'base') target = luma.ground;

    if (v.match && target) {
      // Solve irradiance for the brightness match. The output is tone-mapped, so
      // ground luma is not linear in irradiance and a single ratio will not land
      // it — hence iterate, and record every step so a match that failed to
      // converge is visible in the result instead of passing as one that did.
      for (let i = 0; i < 8 && Math.abs(luma.ground - target) / target > 0.02; i++) {
        irradiance = Math.min(400, Math.max(0.2, irradiance * (target / Math.max(1, luma.ground))));
        luma = applyAndRender(v, irradiance);
        solve.push({ irradiance: +irradiance.toFixed(2), ground: luma.ground, frame: luma.frame });
      }
      solvedIrradiance[v.name] = irradiance;
    }

    rows.push({
      name: v.name,
      label: v.label,
      y: v.y,
      elevation: +elevationOf(v.y).toFixed(1),
      shadowLen: +shadowLenOf(v.y).toFixed(2),
      halo: v.halo !== undefined ? v.halo : pristine.contact.strength,
      matched: !!v.match,
      casts: !v.nocast,
      irradiance: +irradiance.toFixed(2),
      groundLuma: luma.ground,
      frameLuma: luma.frame,
      groundVsBase: target ? +(luma.ground - target).toFixed(2) : null,
      converged: v.match ? Math.abs(luma.ground - target) / target <= 0.02 : null,
      solve,
      // Read the rig back. A variant whose change did not land renders the
      // previous frame and reports a difference of zero, which is
      // indistinguishable from "this candidate does nothing" unless the applied
      // value is checked. That already happened once, on D57's `road` row.
      applied: {
        lampY: +(lighting.lamp?.position?.y ?? -1).toFixed(1),
        lampIntensity: +(lighting.lamp?.intensity ?? -1).toFixed(1),
        contact: +(lighting.contactStrength ?? P.contact.strength).toFixed(2),
      },
    });
    shots.push({ name: `${prefix}-${v.name}`, url: canvas.toDataURL('image/png') });
  }

  Object.assign(P, clone(pristine));
  lighting.setPreset(preset, { transition: 0 });
  engine.syncSystems?.();
  if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
  if (grain) grain.value = grainWas;
  setCasting(true);
  restoreDriver();
  engine.start();

  const written = [];
  for (const s of shots) {
    const res = await fetch('/__shot?name=' + encodeURIComponent(s.name), { method: 'POST', body: s.url });
    written.push((await res.json()).path);
  }

  return { arrived, pose, rows, written, settledDrafts: settledDrafts.length ?? 0 };
}
