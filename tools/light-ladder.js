// Render a parameter ladder from ONE boot, at ONE moment, in ONE JS task.
//
// Why this exists, and why pin-shot.js could not do it:
//
//   pin-shot pins by step count and calls that "the same simulated moment
//   every time". Across two boots of the identical URL, both pinned to
//   absolute frame 3841, that claim is FALSE — measured 91.176% of pixels
//   apart, against a same-session floor of 0.102%. The two frames reported
//   clocks of 32.175 and 32.500 at the same frame number, and eight car
//   speeds that share nothing. The boot seek (?t=16) advances the race clock
//   by something other than engine steps, so the frame counter is not a
//   cross-boot pin and neither is anything derived from it.
//
// So: never cross a boot. Take the whole ladder from one page, changing only
// the parameter under test between renders.
//
// The one discipline that makes that trustworthy: NO `await` INSIDE THE LOOP.
// Every render and every readback happens in a single synchronous task, so no
// requestAnimationFrame can interleave and no scheduler decision can land
// between rung 2 and rung 3. The data URLs are collected first and POSTed
// afterwards. MG.capture() awaits per shot and drifted 12.1% between two calls
// on a PAUSED engine; that is the hole this closes.
//
// Shoot the baseline rung FIRST and LAST. The diff between those two is the
// floor, and it is measured rather than assumed.
//
//   const m = await import('/tools/light-ladder.js');
//   await m.ladder([
//     { name: 'd54-hl-00',  N: 0 },
//     { name: 'd54-hl-033', N: 0.33 },
//     { name: 'd54-hl-00b', N: 0 },      // <- the floor
//   ]);

/** Mirrors HEADLIGHT_* in src/vehicle/VehicleVisual.js. Keep in step. */
const FAR_TARGET = 900 / Math.pow(20, 1.6);
export function shapeToLight(N) {
  const decay = 1.6 + (0.6 - 1.6) * N;
  return { decay, intensity: FAR_TARGET * Math.pow(20, decay) };
}

/** Every headlight spot in the scene, with the lamp mix it is currently at. */
function collectSpots(MG) {
  const out = [];
  for (const v of MG.ctx?.vehicles || []) {
    const spots = v.visual?.spots || [];
    const base = shapeToLight(0).intensity;
    for (const s of spots) out.push({ s, mix: s.intensity / base });
  }
  return out;
}

/**
 * @param {{name: string, N: number}[]} rungs  rendered in the order given
 * @param {{w?: number, h?: number, ss?: number}} [opts]
 */
export async function ladder(rungs, opts = {}) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const engine = MG.engine;
  const renderer = engine.renderer;
  const w = opts.w ?? 1280, h = opts.h ?? 720, ss = opts.ss ?? 2;

  const dir = MG.ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;

  const wasPaused = engine.paused;
  if (!wasPaused) engine.pause?.('ladder');

  // Same three disciplines pin-shot earned: settle the foundry, zero the
  // grain, hold the sim. Done ONCE, outside the loop, so every rung shares them.
  const drafts = engine.ctx?.surfaces?.settle?.() ?? [];
  const grain = engine.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;

  const prevPR = renderer.getPixelRatio();
  const prevW = Math.round(renderer.domElement.width / prevPR);
  const prevH = Math.round(renderer.domElement.height / prevPR);

  const spots = collectSpots(MG);
  const spotsWere = spots.map((e) => ({ decay: e.s.decay, intensity: e.s.intensity }));

  const clock = MG.ctx?.race?.raceTime ?? null;
  const frame = engine.time?.frame ?? null;
  const speeds = [...(MG.ctx?.vehicles || [])].map((c) => +(c.speed ?? 0).toFixed(3));

  const shots = [];
  let failure = null;
  try {
    renderer.setPixelRatio(ss);
    renderer.setSize(w, h, false);
    engine.onResize?.(w, h);
    engine.ctx?.postfx?.notifyCameraCut?.();
    engine.syncSystems?.();

    // ---- one synchronous task from here to the end of the loop ----
    for (const r of rungs) {
      const { decay, intensity } = shapeToLight(r.N);
      for (const e of spots) { e.s.decay = decay; e.s.intensity = e.mix * intensity; }
      engine.renderFrame?.(1 / 60);
      engine.renderFrame?.(1 / 60);
      const url = renderer.domElement.toDataURL('image/png');
      shots.push({ name: r.name, N: r.N, decay: +decay.toFixed(3), I: +intensity.toFixed(1), url });
    }
    // ---- end of the synchronous section ----
  } catch (err) {
    failure = err;
  } finally {
    spots.forEach((e, i) => { e.s.decay = spotsWere[i].decay; e.s.intensity = spotsWere[i].intensity; });
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevW, prevH, false);
    engine.onResize?.(prevW, prevH);
    engine.ctx?.postfx?.notifyCameraCut?.();
    if (grain) grain.value = grainWas;
    if (!wasPaused) engine.resume?.('ladder');
    if (dir) dir.enabled = dirWas;
  }
  if (failure) return { ok: false, error: failure.message, rendered: shots.length };

  const written = [];
  for (const s of shots) {
    const res = await fetch('/__shot?name=' + encodeURIComponent(s.name), { method: 'POST', body: s.url });
    const json = await res.json();
    written.push({ name: s.name, N: s.N, decay: s.decay, I: s.I, file: json.file ?? json.name, ok: json.ok !== false });
  }

  return {
    ok: true, clock, frame, speeds,
    movingCars: speeds.filter((s) => s > 1).length,
    spots: spots.length, settledDrafts: drafts.length ?? 0,
    renderW: w * ss, renderH: h * ss, shots: written,
  };
}
