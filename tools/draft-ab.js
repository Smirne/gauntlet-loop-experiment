// Is D49 the texture foundry's idle queue? One boot, one moment, two frames.
//
// D49: two captures of identical code taken in different sessions differed by
// 57.85% of pixels, all of it in the table, while two boots inside ONE session
// agreed to 0.102%. That pattern — huge across sessions, tiny within one — is
// the signature of something timing-dependent that happens to be stable for as
// long as a session lasts.
//
// The suspect: Surfaces hands out a DRAFT (a 256 bake magnified into the final
// texture) and sharpens it later, one kind per idle callback. Measured on a
// kitchen boot: 14 of 15 kinds are drafts at 12.7 s, the table (`oak`) does not
// sharpen until 23.7 s, the last surface not until 40.8 s. The capture harness
// pins the race clock at 16 s and force-steps there in far less wall clock than
// that, so a capture lands ON the crossing.
//
// This proves it or kills it. Both frames come from the SAME boot at the SAME
// pinned step count, with nothing between them but the foundry's bake level.
// If the difference is of D49's size, the cause is settled.
//
//   const m = await import('/tools/draft-ab.js'); await m.draftAB();

export async function draftAB(opts = {}) {
  const MG = window.MG;
  if (!MG?.status) return { booting: true };
  const e = MG.engine, S = MG.ctx?.surfaces;
  if (!S?.settle) return { refused: 'this build has no Surfaces.settle' };

  const dir = MG.ctx?.director;
  const dirWas = dir?.enabled;
  if (dir) dir.enabled = false;

  // HOLD THE ENGINE ACROSS BOTH FRAMES, not just inside each one.
  //
  // MG.capture pauses on entry and resumes on exit, which is right for a single
  // frame and useless for a pair: between the two calls the race runs on, the
  // cars move and the camera follows, so the two frames are different MOMENTS
  // and the diff is dominated by the race rather than by the thing under test.
  //
  // Measured, and it nearly cost a wrong finding: two consecutive captures of
  // the "same" moment taken this way differ by 23.7% of pixels with nothing
  // changed at all. An earlier version of this file reported 28.0% for
  // draft-vs-settled and that number was almost entirely the race advancing.
  // Pausing FIRST makes capture see `wasPaused` and leave the clock alone.
  const wasPaused = e.paused;
  if (!wasPaused) e.pause?.('draft-ab');

  // ZERO THE GRAIN BEFORE A FRAME-DIFF. This project's oldest instrument rule,
  // and ignoring it cost a whole investigation: film grain reseeds every frame,
  // so two captures of a FROZEN scene came back 23.8% of pixels apart. Against
  // that floor the thing actually under test (28.0%) looked like noise, and the
  // floor looked like a second defect. It was neither — it was the grain.
  const grain = MG.ctx?.postfx?.passes?.grain?.uniforms?.uAmount;
  const grainWas = grain ? grain.value : null;
  if (grain) grain.value = 0;

  const before = S.stats();
  const drafts = before.sets.filter((x) => x.level === 0).map((x) => x.kind);
  if (!drafts.length) {
    if (grain) grain.value = grainWas;
    if (!wasPaused) e.resume?.('draft-ab');
    if (dir) dir.enabled = dirWas;
    return { refused: 'nothing is a draft any more — reload and run this sooner',
             ageMs: Math.round(performance.now()) };
  }

  const name = opts.name || 'draft-ab';
  const w = opts.w ?? 1280, h = opts.h ?? 720;

  // The draft frame has to be taken with the settle SUPPRESSED, because the fix
  // for D49 lives inside MG.capture: it drains the foundry before reading a
  // pixel, which is exactly the state this frame needs to preserve. Stubbing it
  // out for one call is the only way to photograph the defect after fixing it.
  const realSettle = S.settle;
  let pre;
  try {
    S.settle = () => [];
    pre = await MG.capture(name + '-draft', w, h, 1);
  } finally {
    S.settle = realSettle;
  }
  const post = await MG.capture(name + '-sharp', w, h, 1);
  // The floor for THIS pair: a third frame, same held moment, foundry already
  // settled. Whatever `post` and `floor` differ by is what two captures of an
  // unchanged scene cost, and no smaller difference means anything.
  const floor = await MG.capture(name + '-floor', w, h, 1);

  if (grain) grain.value = grainWas;
  if (!wasPaused) e.resume?.('draft-ab');
  if (dir) dir.enabled = dirWas;
  return {
    grainZeroed: !!grain,
    ageMs: Math.round(performance.now()),
    heldPaused: true,
    draftsAtCapture: drafts,
    settledByPre: pre.settledDrafts?.length ?? 0,
    settledByPost: post.settledDrafts?.length ?? 0,
    frames: { draft: name + '-draft', sharp: name + '-sharp', floor: name + '-floor' },
    note: 'diff(draft, sharp) is the claim; diff(sharp, floor) is the floor it has '
        + 'to clear. Both pairs come from one boot at one held moment.',
  };
}
