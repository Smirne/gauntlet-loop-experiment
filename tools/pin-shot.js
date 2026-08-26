// One frame, at one exactly reproducible moment, with the instrument's own
// noise removed. For cross-BOOT comparisons, which is the thing D49 says
// cannot currently be trusted.
//
// Three disciplines, all of them earned:
//
//   * PIN BY STEP COUNT, not by wall clock. The engine is a fixed 120 Hz
//     timestep, so N steps from boot is the same simulated moment every time.
//   * ZERO THE GRAIN. Film grain reseeds every frame. With it on, two captures
//     of a FROZEN scene came back 23.8% of pixels apart — enough to bury
//     anything real, and enough to look like a finding of its own.
//   * SETTLE THE TEXTURE FOUNDRY. Surfaces sharpen on an idle queue, so without
//     this a frame is part game and part scheduler. Worth 2.5% of pixels.
//
// With all three: two captures of the same held moment are BIT-IDENTICAL —
// 0.000% of pixels, max channel delta 0. That is the floor a cross-boot diff
// has to be read against, and it is the number D49 was missing.
//
//   const m = await import('/tools/pin-shot.js'); await m.pinShot('boot-a', 1921);

export async function pinShot(name, steps = 1921, opts = {}) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const e = MG.engine;

  // D26: the director owns the camera and drifts it. Off first, always.
  const dir = MG.ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;

  const clockBefore = MG.ctx?.race?.raceTime ?? null;
  const frameBefore = e.time?.frame ?? null;

  // Drive the clock forward by an exact number of fixed steps.
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('pin-shot');
  for (let i = 0; i < steps; i++) e.stepOnce?.();

  // Liveness: a pinned frame of a dead field is worth nothing, and a pin that
  // silently produced one is how a whole review round gets scored on a still.
  const cars = MG.ctx?.vehicles || [];
  const speeds = [...cars].map((c) => +(c.speed ?? 0).toFixed(3));
  const moving = speeds.filter((s) => s > 1).length;

  const grain = MG.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;

  let shot;
  try {
    // capture() settles the foundry itself now; it reports what it had to do.
    shot = await MG.capture(name, opts.w ?? 1280, opts.h ?? 720, opts.ss ?? 1);
  } finally {
    if (grain) grain.value = grainWas;
    if (!wasPaused) e.resume?.('pin-shot');
    if (dir) dir.enabled = dirWas;
  }

  return {
    name, steps,
    clockBefore, frameBefore,
    clockAfter: MG.ctx?.race?.raceTime ?? null,
    frameAfter: e.time?.frame ?? null,
    raceState: MG.ctx?.race?.state ?? null,
    cars: speeds.length, movingCars: moving, speeds,
    grainZeroed: !!grain,
    settledDrafts: shot.settledDrafts?.length ?? 0,
    file: shot.file ?? shot.name, ok: shot.ok !== false,
  };
}
