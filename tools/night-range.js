// How much brightness range does one lap of the bedroom actually contain, and
// how much of it is the exposure?
//
// D57 shipped `nightLamp.exposure` 1.20 -> 1.95 on a ladder the user judged from
// stills at ONE pose (t = 0.152, the first ramp — the darkest place measured).
// It is marked shipped-but-unverified for exactly the reason this tool exists: a
// still at one pose cannot say whether the rest of the lap is now too bright, and
// a chooser that only ever showed the dark end cannot have answered that.
//
// So two measurements, both from one boot:
//
//   range()      the whole lap at the SHIPPED exposure. 24 evenly spaced points,
//                frame luma and road-band luma at each, plus the percentiles that
//                say whether the frame is crushing or clipping. This is the
//                "bright images vs dark parts" question, in numbers.
//
//   exposures()  one pose, the exposure ramp around what ships, with a floor.
//                Run it at the lap's darkest t and at its brightest and the
//                trade is visible: an exposure that rescues the trough is the
//                same exposure that blows the peak.
//
//   profiles()   the same lap walk, once per candidate rig. This is the one that
//                answers a brief rather than a question. The user's brief, after
//                a test drive: "the contrast is too strong... there are parts
//                where you pass from very low light to strong light very
//                quickly... I like the dark parts and the headlights, so I'd
//                stay more on the dark side, with no place under very strong
//                light (but without getting the darkest spots even more dark)."
//
//                That is three separate statistics, and they are scored as three:
//                  ceiling  the lap's brightest ground reading   -> must come DOWN
//                  floor    the lap's darkest ground reading     -> must NOT come down
//                  jump     the biggest step between adjacent    -> should come down
//                           sample points, i.e. how fast the
//                           light changes as you drive
//                A change that improves one by wrecking another is not a fix, and
//                a single mean would have hidden all three.
//
// D57's original numbers — road-ahead luma 37..172 round the lap — were taken at
// exposure 1.20. They do not describe the build any more. These do.
//
// Same discipline as tools/shadow-ladder.js: driven by hand off a synthetic 60 Hz
// clock with a borrowed Driver (Input writes all-zero controls otherwise and the
// car crawls), director left on so the camera is the real one, film grain zeroed
// and texture drafts settled so a floor can come back clean.
//
//   const m = await import('/tools/night-range.js');
//   await m.range();
//   await m.exposures({ t: 0.15 });
//
// Nothing here changes the game.

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------------ */
/* shared setup                                                        */
/* ------------------------------------------------------------------ */

async function stage() {
  const MG = window.MG;
  const engine = MG.engine;
  const renderer = engine.renderer;
  const canvas = renderer.domElement;
  const car = MG.ctx.player;

  engine.stop();
  if (engine.paused) engine.resume('nightrange');

  // A LAP WALK NEEDS THE CAR TO KEEP DRIVING, so the race rules that stop it are
  // switched off for the duration.
  //
  // This is not tidiness. The first version of profiles() died on
  // "never crossed the start line in 20000 ticks" and the reason was that the
  // player had been ELIMINATED: an eliminated car's `trackT` never changes
  // again, so the walk sat there for 333 seconds of race time watching a frozen
  // number. Three laps also simply end the race. Neither shows up as an error
  // anywhere — the walk just quietly never advances — which is why both are
  // disabled explicitly and asserted afterwards rather than hoped for.
  const race = MG.ctx.race;
  race.restart();
  const elimWas = race.elimination.enabled;
  const lapsWas = race.totalLaps;
  race.elimination.enabled = false;
  race.totalLaps = 999;
  race.start();

  const { Driver } = await import('/src/ai/Driver.js');
  const already = (MG.ctx.drivers || []).some((d) => d.vehicle === car);
  const borrowed = already ? null : new Driver(MG.ctx, car, {
    skill: 0.84, aggression: 0.35, consistency: 0.9, seed: 4242,
  });
  const autoPollWas = car.autoPollInput;
  const inputWas = MG.ctx.input?.enabled;
  if (borrowed) {
    car.autoPollInput = false;
    if (MG.ctx.input) MG.ctx.input.enabled = false;
  }

  const grain = engine.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;
  const drafts = engine.ctx?.surfaces?.settle?.() ?? [];

  let clock = performance.now();
  const tick = () => {
    clock += 1000 / 60;
    if (borrowed) { try { borrowed.update(1 / 60, MG.ctx); } catch (_) { /* keep going */ } }
    engine._tick(clock);
  };

  const restore = () => {
    race.elimination.enabled = elimWas;
    race.totalLaps = lapsWas;
    if (grain) grain.value = grainWas;
    if (borrowed) {
      try { borrowed.dispose?.(); } catch (_) { /* nothing owns it but us */ }
      car.autoPollInput = autoPollWas;
      if (inputWas !== undefined && MG.ctx.input) MG.ctx.input.enabled = inputWas;
    }
    engine.start();
  };

  // Put the race back on the grid with the walk's rules applied. Called before
  // every rig, not once, for two reasons. The obvious one: something in the race
  // puts the state back to `results` mid-run — measured, with elimination off and
  // totalLaps at 999 — and a walk against a finished race watches a parked car.
  // The better one: restarting per rig means every rig is driven from identical
  // starting conditions with the same seed, so the laps are comparable as laps
  // and not just as statistics.
  const freshRace = () => {
    race.restart();
    race.elimination.enabled = false;
    race.totalLaps = 999;
    race.start();
  };

  return { MG, engine, renderer, canvas, car, race, tick, restore, freshRace, drafts: drafts.length ?? 0 };
}

/**
 * Luma statistics for whatever is on the canvas right now.
 *
 * The percentiles are the point. A mean cannot tell "evenly lit at 140" from
 * "half the frame crushed and half of it clipped, averaging 140", and those are
 * completely different answers to a question about contrast.
 */
function reader(canvas) {
  const W = 160, H = 90;
  const oc = new OffscreenCanvas(W, H);
  const g = oc.getContext('2d', { willReadFrequently: true });
  const BAND = [0.30, 0.42, 0.70, 0.86];   // the ground the car sits on

  const stats = (sx, sy, sw, sh) => {
    g.drawImage(canvas, sx, sy, sw, sh, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const hist = new Uint32Array(256);
    let sum = 0;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const l = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) | 0;
      hist[l > 255 ? 255 : l]++;
      sum += l;
    }
    const q = (p) => {
      let c = 0;
      for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= n * p) return i; }
      return 255;
    };
    let dark = 0, hot = 0, clip = 0;
    for (let i = 0; i < 32; i++) dark += hist[i];
    for (let i = 224; i < 256; i++) hot += hist[i];
    for (let i = 250; i < 256; i++) clip += hist[i];
    return {
      mean: +(sum / n).toFixed(1),
      p5: q(0.05), median: q(0.5), p95: q(0.95),
      crushed: +(100 * dark / n).toFixed(2),
      hot: +(100 * hot / n).toFixed(2),
      clipped: +(100 * clip / n).toFixed(2),
    };
  };

  return {
    frame: () => stats(0, 0, canvas.width, canvas.height),
    ground: () => {
      const cw = canvas.width, ch = canvas.height;
      return stats(
        Math.round(BAND[0] * cw), Math.round(BAND[1] * ch),
        Math.max(1, Math.round((BAND[2] - BAND[0]) * cw)),
        Math.max(1, Math.round((BAND[3] - BAND[1]) * ch)),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. the whole lap, at the shipped exposure                           */
/* ------------------------------------------------------------------ */

/**
 * Sample the lap at evenly spaced track positions and record what the frame is
 * doing at each. No preset is touched — this is the build exactly as it ships.
 * @param {{samples?: number, maxTicks?: number, shots?: number}} [opts]
 */
export async function range(opts = {}) {
  const N = opts.samples ?? 24;
  const maxTicks = opts.maxTicks ?? 20000;
  const S = await stage();
  const read = reader(S.canvas);

  const want = Array.from({ length: N }, (_, i) => i / N);
  const rows = [];
  let next = 0;
  let ticks = 0;

  try {
    // Let the field settle off the grid before sampling, or the first few points
    // are a start-line camera rather than a racing one.
    for (let i = 0; i < 180; i++) { S.tick(); ticks++; }

    // Wait for the start line first — see the note in profiles(). Starting a
    // walk mid-lap fires every remaining boundary in consecutive ticks.
    let prevT = S.car.trackT ?? 0;
    let wrapped = false;
    while (!wrapped && ticks < maxTicks) {
      S.tick(); ticks++;
      const t = S.car.trackT ?? 0;
      if (t < prevT - 0.5) wrapped = true;
      prevT = t;
    }

    while (next < N && ticks < maxTicks) {
      S.tick(); ticks++;
      const t = S.car.trackT ?? 0;
      if (t >= want[next]) {
        rows.push({
          t: +t.toFixed(4),
          lap: S.car.lap ?? null,
          frame: read.frame(),
          ground: read.ground(),
        });
        next++;
      }
    }
  } finally {
    S.restore();
  }

  const gm = rows.map((r) => r.ground.mean);
  const fm = rows.map((r) => r.frame.mean);
  const lo = rows[gm.indexOf(Math.min(...gm))];
  const hi = rows[gm.indexOf(Math.max(...gm))];

  return {
    exposure: +(S.renderer.toneMappingExposure ?? -1).toFixed(3),
    ticks,
    samples: rows.length,
    groundLuma: { min: Math.min(...gm), max: Math.max(...gm), span: +(Math.max(...gm) - Math.min(...gm)).toFixed(1) },
    frameLuma: { min: Math.min(...fm), max: Math.max(...fm) },
    // The two ends of the lap, which is what a playthrough would be judging.
    darkest: lo,
    brightest: hi,
    // Places where the frame is losing information at one end or the other.
    crushing: rows.filter((r) => r.frame.crushed > 20).map((r) => ({ t: r.t, crushed: r.frame.crushed, mean: r.frame.mean })),
    clipping: rows.filter((r) => r.frame.clipped > 2).map((r) => ({ t: r.t, clipped: r.frame.clipped, mean: r.frame.mean })),
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* 1b. the same lap, once per candidate rig                            */
/* ------------------------------------------------------------------ */

/**
 * The candidates, as functions over the preset. Everything here is a rig change
 * except `tone`, which swaps the tone-mapping curve on the renderer itself.
 *
 * ACES (what ships) has a short shoulder: it rolls off late and hard, so a lamp
 * pool goes from bright to paper-white over a small range of input. AgX has a
 * much longer shoulder and desaturates as it approaches white, which is exactly
 * the "no place under very strong light" half of the brief — and, unlike an
 * exposure cut, it does almost nothing to the toe, which is the "don't make the
 * dark parts darker" half.
 */
export const RIGS = [
  { name: 'ships', label: 'what ships now', apply: () => {} },

  // The question actually asked: what does lowering the lamp do to the lap?
  { name: 'y150', label: 'lamp 205 -> 150', apply: (P) => { P.lamp.offset = [-118, 150, -92]; } },
  { name: 'y110', label: 'lamp 205 -> 110', apply: (P) => { P.lamp.offset = [-118, 110, -92]; } },
  { name: 'y80', label: 'lamp 205 -> 80', apply: (P) => { P.lamp.offset = [-118, 80, -92]; } },

  // VOID — DO NOT READ THESE AS A RESULT.
  //
  // Swapping `renderer.toneMapping` does nothing here. PostFX's colour grade
  // owns the tone map (`_gradeOwnsToneMap` is true, confirmed live) and parks
  // the renderer on NoToneMapping for the composite, so the curve these rows
  // select never reaches a pixel. They came back within the floor of `ships`,
  // which reads exactly like "the tone curve does not help" and is really "the
  // tone curve was never applied". Kept, labelled, and not deleted, because a
  // silent false null is the most expensive thing this project keeps producing.
  // Testing a real shoulder means changing the curve inside the grade pass.
  { name: 'agx', label: 'VOID — AgX (never reached the pixels)', tone: 'agx', void: true, apply: () => {} },

  // Turn the lamp down instead of moving it. The lamp is what makes the bright
  // places bright; the dark places are lit by ambient, fill and the sun term,
  // which the lamp does not touch. So this should pull the ceiling down and
  // leave the floor where it is — which is the brief.
  { name: 'lamp25', label: 'lamp irradiance -25%', apply: (P) => { P.lamp.irradiance = 4.20; } },
  { name: 'lamp40', label: 'lamp irradiance -40%', apply: (P) => { P.lamp.irradiance = 3.36; } },
  { name: 'lamp55', label: 'lamp irradiance -55%', apply: (P) => { P.lamp.irradiance = 2.52; } },

  // The combination the user is actually weighing: turn the lamp down for the
  // contrast, and move it down for the shadow. They pull against each other —
  // the shadow needs light to be cast with, and the contrast fix removes light.
  { name: 'y110lamp25', label: 'lamp at 110, irradiance -25%', apply: (P) => { P.lamp.offset = [-118, 110, -92]; P.lamp.irradiance = 4.20; } },
  { name: 'y110lamp40', label: 'lamp at 110, irradiance -40%', apply: (P) => { P.lamp.offset = [-118, 110, -92]; P.lamp.irradiance = 3.36; } },

  // Exposure back to where it was, for the record.
  { name: 'exp120', label: 'exposure back to 1.20', apply: (P) => { P.exposure = 1.20; } },

  // FLOOR — `ships` again at the end. A lap profile is a statistic over 24 poses
  // on a live race, so it cannot be byte-identical the way a pinned frame can.
  // What it CAN do is reproduce, and if it does not, none of the rows above mean
  // anything.
  { name: 'ships2', label: 'FLOOR — what ships, again', apply: () => {} },
];

/**
 * Walk the lap once per rig and score each against the three-part brief.
 *
 * ONE RIG PER TASK, with an await between them. A previous version walked all
 * nine laps in a single synchronous run and held the main thread for minutes:
 * nothing could poll it, the pane stopped answering, and the only way out was
 * to close the tab. Anything that takes minutes has to be observable while it
 * runs or it cannot be debugged when it goes wrong — and this one WAS wrong.
 *
 * The walk also renders at 960x540 rather than full size. Every number here
 * comes off a 160x90 downsample of the canvas, so the statistic does not care,
 * and the lap takes roughly a third as long.
 *
 * @param {{samples?: number, maxTicks?: number, only?: string[], onRig?: (r: object) => void, rw?: number, rh?: number}} [opts]
 */
export async function profiles(opts = {}) {
  const N = opts.samples ?? 24;
  const maxTicks = opts.maxTicks ?? 20000;
  const S = await stage();
  const read = reader(S.canvas);
  const THREE = S.MG.THREE;
  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS.nightLamp;
  const pristine = clone(P);
  const lighting = S.MG.ctx.lighting;
  const toneWas = S.renderer.toneMapping;

  const prevPR = S.renderer.getPixelRatio();
  const prevW = Math.round(S.renderer.domElement.width / prevPR);
  const prevH = Math.round(S.renderer.domElement.height / prevPR);
  const rw = opts.rw ?? 960, rh = opts.rh ?? 540;
  S.renderer.setPixelRatio(1);
  S.renderer.setSize(rw, rh, false);
  S.engine.onResize?.(rw, rh);
  S.engine.ctx?.postfx?.notifyCameraCut?.();

  const TONES = {
    aces: THREE.ACESFilmicToneMapping,
    agx: THREE.AgXToneMapping,
    neutral: THREE.NeutralToneMapping,
  };

  const want = Array.from({ length: N }, (_, i) => i / N);
  const rigs = opts.only ? RIGS.filter((r) => opts.only.includes(r.name)) : RIGS;
  const out = [];

  try {
    for (const rig of rigs) {
      // Let the browser have the thread back between laps, so this run can be
      // polled while it works.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
      Object.assign(P, clone(pristine));
      rig.apply(P);
      lighting.setPreset('nightLamp', { transition: 0 });
      S.renderer.toneMapping = TONES[rig.tone || 'aces'] ?? toneWas;
      // A tone-mapping swap recompiles every material; do it before the walk
      // rather than in the middle of one.
      S.MG.ctx.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mm of (Array.isArray(m) ? m : [m])) if (mm) mm.needsUpdate = true;
      });
      S.engine.syncSystems?.();
      if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;

      S.freshRace();

      // THREE THINGS HAVE TO HAPPEN BEFORE A SAMPLE IS WORTH TAKING, and each of
      // them broke a version of this walk:
      //
      //  1. THE LIGHTS HAVE TO GO OUT. `race.start()` puts the race on the GRID;
      //     the state does not become 'racing' until the countdown ends. A walk
      //     that begins on the grid samples a stationary car under a start-line
      //     camera.
      //  2. THE GRID RESET IS NOT A LAP. Restarting drops `trackT` from wherever
      //     the last rig left it back to the line, which looks exactly like a
      //     lap wrap — so `prevT` is re-read AFTER the countdown, not before.
      //  3. THE CAR HAS TO CROSS THE LINE ONCE. Sampling from a standing start
      //     bunches the first boundaries into consecutive ticks, because the car
      //     begins just behind t = 0 and is instantly "past" several of them.
      //
      // None of these announces itself in the output. Every one of them produces
      // 24 numbers that look like a lap profile and are not one.
      let ticks = 0;
      while (S.race.state !== 'racing' && ticks < maxTicks) { S.tick(); ticks++; }
      if (S.race.state !== 'racing') throw new Error(`${rig.name}: never left '${S.race.state}'`);

      let prevT = S.car.trackT ?? 0;
      let wrapped = false;
      while (!wrapped && ticks < maxTicks) {
        S.tick(); ticks++;
        const t = S.car.trackT ?? 0;
        if (t < prevT - 0.5) wrapped = true;      // crossed the line
        prevT = t;
      }
      if (!wrapped) {
        const pe = S.MG.ctx.race.entries.find((x) => x.isPlayer);
        throw new Error(`${rig.name}: never crossed the start line in ${maxTicks} ticks `
          + `(state=${S.MG.ctx.race.state} eliminated=${!!pe?.eliminated} finished=${!!pe?.finished} t=${(S.car.trackT ?? 0).toFixed(3)})`);
      }

      // Sample at the FIRST crossing of each boundary, and do not give up if the
      // car goes backwards. It does: a spin or a respawn drops `trackT`, and an
      // earlier version treated that as "lapped again" and bailed with 5 of 24
      // samples. Going round twice to collect 24 first-crossings is fine — the
      // rig is identical on both laps — so the only thing worth recording is
      // HOW many laps it took, so a walk that needed three is visible.
      const rows = [];
      let next = 0;
      let laps = 0;
      while (next < N && ticks < maxTicks) {
        S.tick(); ticks++;
        const t = S.car.trackT ?? 0;
        if (S.race.state !== 'racing') {
          throw new Error(`${rig.name}: race left 'racing' (now '${S.race.state}') after ${rows.length}/${N} samples `
            + `— a walk against a parked car is not a lap profile`);
        }
        if (t < prevT - 0.5) laps++;
        if (t >= want[next]) {
          rows.push({ t: +t.toFixed(4), tick: ticks, frame: read.frame(), ground: read.ground() });
          next++;
        }
        prevT = t;
      }
      if (rows.length < N) {
        const pe = S.MG.ctx.race.entries.find((x) => x.isPlayer);
        throw new Error(`${rig.name}: only ${rows.length}/${N} samples in ${ticks} ticks `
          + `(laps=${laps} state=${S.MG.ctx.race.state} eliminated=${!!pe?.eliminated} t=${(S.car.trackT ?? 0).toFixed(3)})`);
      }

      const g = rows.map((r) => r.ground.mean);
      let jump = 0, jumpAt = null;
      for (let i = 1; i < g.length; i++) {
        const d = Math.abs(g[i] - g[i - 1]);
        if (d > jump) { jump = d; jumpAt = rows[i].t; }
      }
      const sorted = g.slice().sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

      out.push({
        rig: rig.name,
        label: rig.label,
        tone: rig.tone || 'aces',
        exposure: +(S.renderer.toneMappingExposure ?? -1).toFixed(3),
        lampY: +(lighting.lamp?.position?.y ?? -1).toFixed(0),
        samples: rows.length,
        lapsUsed: laps + 1,
        // THE THREE NUMBERS THE BRIEF ASKS FOR.
        ceiling: +Math.max(...g).toFixed(1),      // must come DOWN
        floorLuma: +Math.min(...g).toFixed(1),    // must NOT come down
        jump: +jump.toFixed(1),                   // should come down
        jumpAt,
        span: +(Math.max(...g) - Math.min(...g)).toFixed(1),
        p10: q(0.10), median: q(0.5), p90: q(0.90),
        // Where the frame is actually losing information.
        crushedFrames: rows.filter((r) => r.frame.crushed > 20).length,
        clippedFrames: rows.filter((r) => r.ground.clipped > 3).length,
        worstCrush: +Math.max(...rows.map((r) => r.frame.crushed)).toFixed(1),
        worstClip: +Math.max(...rows.map((r) => r.ground.clipped)).toFixed(1),
        darkestMedian: rows.reduce((m, r) => (r.ground.mean === Math.min(...g) ? r.frame.median : m), null),
        rows: rows.map((r) => [r.t, r.ground.mean, r.frame.mean, r.frame.crushed, r.ground.clipped]),
      });
      try { opts.onRig?.(out[out.length - 1]); } catch (_) { /* a reporter must not stop the run */ }
    }
  } finally {
    Object.assign(P, clone(pristine));
    lighting.setPreset('nightLamp', { transition: 0 });
    S.renderer.toneMapping = toneWas;
    S.MG.ctx.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      for (const mm of (Array.isArray(m) ? m : [m])) if (mm) mm.needsUpdate = true;
    });
    S.engine.syncSystems?.();
    S.renderer.setPixelRatio(prevPR);
    S.renderer.setSize(prevW, prevH, false);
    S.engine.onResize?.(prevW, prevH);
    S.engine.ctx?.postfx?.notifyCameraCut?.();
    S.restore();
  }

  const a = out.find((r) => r.rig === 'ships');
  const b = out.find((r) => r.rig === 'ships2');
  return {
    // The floor for a lap statistic: the same rig, walked twice, one boot apart
    // in race time. Not zero and cannot be — say how far off instead of pretending.
    floor: a && b ? {
      ceiling: +(b.ceiling - a.ceiling).toFixed(1),
      floorLuma: +(b.floorLuma - a.floorLuma).toFixed(1),
      jump: +(b.jump - a.jump).toFixed(1),
    } : null,
    rigs: out,
  };
}

/* ------------------------------------------------------------------ */
/* 1d. where on the lap does the car have a shadow at all              */
/* ------------------------------------------------------------------ */

/**
 * D53 measured the car's cast shadow at ONE pose and found 233 px of a 1600x900
 * frame, all of it under the car. The obvious next question, and the user's:
 * is that the whole lap, or that spot?
 *
 * It should NOT be the whole lap, and the reason is geometry. The lamp is a
 * fixed point in the room, not a sun — `offset` is a world position. So the
 * elevation from car to lamp is a function of where the car IS: nearly overhead
 * when it drives under the bedside table, low and raking at the far end of the
 * carpet. Shadow length is horizontal/vertical of that vector, so it changes
 * round the lap by a large factor. What ALSO changes is how much light is there
 * to cast it with, and those two work against each other: the places with the
 * longest shadow geometry are the places furthest from the lamp.
 *
 * Measured the same way as tools/shadow-ladder.js — render the pose, render it
 * again with the car's shadow casters off, and the difference is the cast shadow
 * and nothing else — but now at every sample point of a lap walk, with its own
 * floor at every point.
 *
 * @param {{samples?: number, rigs?: string[], maxTicks?: number, onRig?: Function}} [opts]
 */
export async function shadowWalk(opts = {}) {
  const N = opts.samples ?? 16;
  const names = opts.rigs ?? ['ships'];
  const maxTicks = opts.maxTicks ?? 40000;
  const S = await stage();
  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS.nightLamp;
  const pristine = clone(P);
  const lighting = S.MG.ctx.lighting;
  const canvas = S.canvas;

  const casters = (S.MG.ctx.player?.visual?.meshes || []).filter((m) => m.castShadow);
  if (!casters.length) throw new Error('no shadow casters on the player — this would measure nothing');
  const setCasting = (on) => { for (const m of casters) m.castShadow = on; };

  // The shadow is small: 233 px of 1.44M at the shipped rig. Reading it back at
  // 800x450 keeps roughly a quarter of those pixels, which is still ~58 — well
  // clear of a floor that comes back at single digits. Reading at the 160x90 the
  // luma statistics use would put the whole shadow under one pixel.
  const RW = 800, RH = 450;
  const oc = new OffscreenCanvas(RW, RH);
  const g = oc.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, RW, RH);
    return g.getImageData(0, 0, RW, RH).data;
  };
  const lum = (p, o) => 0.2126 * p[o] + 0.7152 * p[o + 1] + 0.0722 * p[o + 2];
  // `b` is the frame with the car casting NOTHING, so it is brighter wherever
  // the car's shadow lands. Count those pixels.
  const darkerBy = (a, b) => {
    let n = 0;
    for (let i = 0; i < RW * RH; i++) { const o = i * 4; if (lum(b, o) - lum(a, o) >= 6) n++; }
    return n;
  };

  const refresh = () => {
    if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
    for (const c of (lighting.cascades || [])) c.light.shadow.needsUpdate = true;
    S.engine.renderFrame(0);
    S.engine.renderFrame(0);   // the map flagged above is only USED by the second
  };

  const want = Array.from({ length: N }, (_, i) => i / N);
  const out = [];

  try {
    for (const name of names) {
      const rig = RIGS.find((r) => r.name === name);
      if (!rig) throw new Error(`no rig named ${name}`);
      Object.assign(P, clone(pristine));
      rig.apply(P);
      lighting.setPreset('nightLamp', { transition: 0 });
      S.engine.syncSystems?.();

      S.freshRace();
      let ticks = 0;
      while (S.race.state !== 'racing' && ticks < maxTicks) { S.tick(); ticks++; }
      let prevT = S.car.trackT ?? 0;
      let wrapped = false;
      while (!wrapped && ticks < maxTicks) {
        S.tick(); ticks++;
        const t = S.car.trackT ?? 0;
        if (t < prevT - 0.5) wrapped = true;
        prevT = t;
      }

      const rows = [];
      let next = 0;
      while (next < N && ticks < maxTicks) {
        S.tick(); ticks++;
        const t = S.car.trackT ?? 0;
        if (t < want[next]) { prevT = t; continue; }
        prevT = t;

        // Freeze here and take the pair, plus this point's own floor.
        refresh();
        const a = grab();
        refresh();
        const a2 = grab();          // FLOOR: same state, twice
        setCasting(false);
        refresh();
        const b = grab();
        setCasting(true);
        refresh();

        const lamp = lighting.lamp?.position;
        const car = S.car.position ?? S.car.root?.position;
        let dist = null, elev = null;
        if (lamp && car) {
          const dx = lamp.x - car.x, dy = lamp.y - car.y, dz = lamp.z - car.z;
          const horiz = Math.hypot(dx, dz);
          dist = +Math.hypot(dx, dy, dz).toFixed(0);
          elev = +((Math.atan2(dy, horiz) * 180) / Math.PI).toFixed(1);
        }

        rows.push({
          t: +t.toFixed(4),
          shadowPx: darkerBy(a, b),
          floorPx: darkerBy(a, a2),
          lampDist: dist,
          elevation: elev,
          shadowLen: elev !== null ? +(1 / Math.tan((elev * Math.PI) / 180)).toFixed(2) : null,
        });
        next++;
      }
      if (rows.length < N) throw new Error(`${name}: only ${rows.length}/${N} samples`);

      const px = rows.map((r) => r.shadowPx);
      out.push({
        rig: name,
        label: rig.label,
        lampY: +(lighting.lamp?.position?.y ?? -1).toFixed(0),
        samples: rows.length,
        min: Math.min(...px),
        max: Math.max(...px),
        median: px.slice().sort((x, y) => x - y)[px.length >> 1],
        // The number that answers the question: at how many places on the lap is
        // there effectively no cast shadow at all?
        pointsUnder100: rows.filter((r) => r.shadowPx < 100).length,
        worstFloor: Math.max(...rows.map((r) => r.floorPx)),
        rows,
      });
      try { opts.onRig?.(out[out.length - 1]); } catch (_) { /* a reporter must not stop the run */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    setCasting(true);
    Object.assign(P, clone(pristine));
    lighting.setPreset('nightLamp', { transition: 0 });
    S.engine.syncSystems?.();
    S.restore();
  }

  return { rigs: out };
}

/* ------------------------------------------------------------------ */
/* 1c. the same pose, under two rigs                                   */
/* ------------------------------------------------------------------ */

/**
 * Drive to one pose and render it under each named rig, first rig repeated last
 * as the floor. This is the looking half — the profiles above are statistics
 * over a lap and cannot say whether the result is nice.
 * @param {{t?: number, rigs?: string[], prefix?: string, tol?: number}} [opts]
 */
export async function frames(opts = {}) {
  const wantT = opts.t ?? 0.33;
  const tol = opts.tol ?? 0.025;
  const names = opts.rigs ?? ['ships', 'lamp40'];
  const prefix = opts.prefix ?? 'd57r';

  const S = await stage();
  const read = reader(S.canvas);
  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS.nightLamp;
  const pristine = clone(P);
  const lighting = S.MG.ctx.lighting;

  S.freshRace();
  let ticks = 0;
  while (S.race.state !== 'racing' && ticks < 12000) { S.tick(); ticks++; }

  let arrived = { ok: false, t: null, ticks };
  for (; ticks < 24000; ticks++) {
    const t = S.car.trackT ?? 0;
    if (Math.abs(t - wantT) < tol) { arrived = { ok: true, t: +t.toFixed(4), ticks }; break; }
    S.tick();
  }
  if (!arrived.ok) { S.restore(); throw new Error(`never reached t=${wantT}`); }

  const plan = [...names, names[0]];
  const rows = [];
  const shots = [];
  for (let i = 0; i < plan.length; i++) {
    const rig = RIGS.find((r) => r.name === plan[i]);
    if (!rig) throw new Error(`no rig named ${plan[i]}`);
    Object.assign(P, clone(pristine));
    rig.apply(P);
    lighting.setPreset('nightLamp', { transition: 0 });
    S.engine.syncSystems?.();
    if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
    for (const c of (lighting.cascades || [])) c.light.shadow.needsUpdate = true;
    lighting._updateContactShadows?.(S.MG.ctx);
    S.engine.renderFrame(0);
    S.engine.renderFrame(0);
    rows.push({
      rig: rig.name,
      isFloor: i === plan.length - 1,
      lampIntensity: +(lighting.lamp?.intensity ?? -1).toFixed(0),
      frame: read.frame(),
      ground: read.ground(),
    });
    shots.push({ name: `${prefix}-${rig.name}${i === plan.length - 1 ? '-floor' : ''}`, url: S.canvas.toDataURL('image/png') });
  }

  Object.assign(P, clone(pristine));
  lighting.setPreset('nightLamp', { transition: 0 });
  S.engine.syncSystems?.();
  S.restore();

  const written = [];
  for (const s of shots) {
    const res = await fetch('/__shot?name=' + encodeURIComponent(s.name), { method: 'POST', body: s.url });
    written.push((await res.json()).path);
  }
  return {
    arrived, rows, written,
    floorDelta: +(rows[rows.length - 1].ground.mean - rows[0].ground.mean).toFixed(2),
  };
}

/* ------------------------------------------------------------------ */
/* 2. the exposure ramp, at one pose                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {{t?: number, values?: number[], prefix?: string, tol?: number}} [opts]
 */
export async function exposures(opts = {}) {
  const wantT = opts.t ?? 0.15;
  const tol = opts.tol ?? 0.02;
  const values = opts.values ?? [1.20, 1.55, 1.95, 2.35];
  const prefix = opts.prefix ?? 'd57x';

  const S = await stage();
  const read = reader(S.canvas);
  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS.nightLamp;
  const pristine = clone(P);
  const lighting = S.MG.ctx.lighting;

  let arrived = { ok: false, t: null, ticks: 0 };
  for (let i = 0; i < 12000; i++) {
    const t = S.car.trackT ?? 0;
    if (i > 120 && Math.abs(t - wantT) < tol) { arrived = { ok: true, t: +t.toFixed(4), ticks: i }; break; }
    S.tick();
    arrived.ticks = i;
    arrived.t = +(S.car.trackT ?? 0).toFixed(4);
  }
  if (!arrived.ok) { S.restore(); throw new Error(`never reached t=${wantT} (stopped at ${arrived.t})`); }

  // `base` first and last: the floor. Anything that moves between them is the
  // scheduler, not the exposure.
  const plan = [...values, values[0]];
  const rows = [];
  const shots = [];

  for (let i = 0; i < plan.length; i++) {
    const e = plan[i];
    Object.assign(P, clone(pristine));
    P.exposure = e;
    lighting.setPreset('nightLamp', { transition: 0 });
    S.engine.syncSystems?.();
    if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
    for (const c of (lighting.cascades || [])) c.light.shadow.needsUpdate = true;
    S.engine.renderFrame(0);
    S.engine.renderFrame(0);
    rows.push({
      exposure: e,
      isFloor: i === plan.length - 1,
      applied: +(S.renderer.toneMappingExposure ?? -1).toFixed(3),
      frame: read.frame(),
      ground: read.ground(),
    });
    shots.push({ name: `${prefix}-${i === plan.length - 1 ? 'floor' : String(e).replace('.', '')}`, url: S.canvas.toDataURL('image/png') });
  }

  Object.assign(P, clone(pristine));
  lighting.setPreset('nightLamp', { transition: 0 });
  S.engine.syncSystems?.();
  S.restore();

  const written = [];
  for (const s of shots) {
    const res = await fetch('/__shot?name=' + encodeURIComponent(s.name), { method: 'POST', body: s.url });
    written.push((await res.json()).path);
  }

  const first = rows[0], last = rows[rows.length - 1];
  return {
    arrived, rows, written,
    floorDelta: +(last.frame.mean - first.frame.mean).toFixed(2),
  };
}
