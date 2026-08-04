// Deterministic critic capture set.
//
// The blind A/B in REVIEW.md only means anything if round N and round N+1 are
// shot from the *same* camera. Round 1 was captured from an inline snippet,
// which is exactly the thing that drifts between sessions — so it lives here
// now, verbatim, and every later round calls this file.
//
// Load and run:
//   const m = await import('/tools/capture-set.js'); await m.captureSet('r2');
//
// Boot with the matching URL or the sim state won't line up:
//   /?track=kitchen&skipmenu=1&t=16&quality=ultra
//
// t=16 puts the leaders around 55% of the opening lap with the field strung
// out, which is what a review frame should show. Rounds 1 and 2 used t=6, but
// that was before D10 was found: the fast-forward stepped no systems at all, so
// t=6 really meant "the field has barely left the grid and no physics has run".
// Do not compare frames across that boundary and read the difference as a
// rendering change.
//
// Pass a suffix to namespace a round: captureSet('r2') writes
// shots/crit-1-gameplay-r2.png etc. No suffix overwrites the round-1 names.

export async function captureSet(suffix = '') {
  const s = window.MG?.status;
  if (!s) return { booting: true, msg: document.querySelector('#boot .boot-msg')?.textContent };

  const THREE = window.MG.THREE;
  const ctx = window.MG.ctx;
  const tag = suffix ? '-' + suffix : '';
  const shots = [];

  // 1. the director's own race camera, exactly as a player sees it
  shots.push(await window.MG.capture('crit-1-gameplay' + tag, 1920, 1080));

  // From here we drive the camera by hand, so the director has to let go of it.
  const lead = ctx.vehicles[0];
  if (ctx.director) ctx.director.enabled = false;
  const cam = ctx.camera;
  const c = lead.group.position;

  // 2. tight chase on the leader
  const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(lead.quaternion);
  cam.fov = 34;
  cam.position.set(c.x - fw.x * 46 + 6, c.y + 26, c.z - fw.z * 46 + 6);
  cam.lookAt(c.x, c.y + 2, c.z);
  cam.updateProjectionMatrix();
  ctx.postfx?.notifyCameraCut?.();
  shots.push(await window.MG.capture('crit-2-chase' + tag, 1920, 1080));

  // 3. macro detail: car body against the table surface
  cam.fov = 26;
  cam.position.set(c.x + 17, c.y + 9, c.z + 21);
  cam.lookAt(c.x, c.y + 1.4, c.z);
  cam.updateProjectionMatrix();
  ctx.postfx?.notifyCameraCut?.();
  shots.push(await window.MG.capture('crit-3-macro' + tag, 1920, 1080));

  // 4. wide establishing shot of the whole circuit
  const b = ctx.track.bounds;
  const ctr = b.getCenter(new THREE.Vector3());
  const sz = b.getSize(new THREE.Vector3());
  const d = Math.max(sz.x, sz.z) * 0.95;
  cam.fov = 38;
  cam.position.set(ctr.x + d * 0.42, ctr.y + d * 0.80, ctr.z + d * 0.62);
  cam.lookAt(ctr.x, ctr.y, ctr.z);
  cam.updateProjectionMatrix();
  ctx.postfx?.notifyCameraCut?.();
  shots.push(await window.MG.capture('crit-4-establishing' + tag, 1920, 1080));

  return {
    shots,
    race: ctx.race?.state,
    cars: ctx.vehicles.length,
    // The HUD is DOM, not canvas — it can never appear in these captures.
    // Critiquing it needs a separate DOM-reading pass.
    hudNodes: document.querySelector('#ui-root')?.children.length ?? 0,
  };
}
