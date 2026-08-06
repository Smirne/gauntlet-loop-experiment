// Headless screenshot pipeline.
//
// The browser pane doesn't always composite frames, which makes ordinary
// screenshot tooling unreliable here. Instead the page renders on demand at an
// explicit resolution and POSTs the PNG to the dev server, which writes it to
// shots/. Review agents then read those PNGs straight off disk.
//
// Exposed as window.MG.capture(...) so it can be driven from the console.

import { Vector2 } from 'three';

/**
 * @param {object} engine - object exposing { renderer, composer, camera, render(dt) }
 */
export function installCapture(engine) {
  const MG = (window.MG = window.MG || {});
  MG.engine = engine;

  /**
   * Render one frame at an exact resolution and persist it to shots/<name>.png.
   * Restores the live viewport afterwards so gameplay is unaffected.
   */
  MG.capture = async function capture(name = 'shot', w = 1920, h = 1080) {
    const { renderer } = engine;
    const prevSize = renderer.getSize(new Vector2());
    const prevPR = renderer.getPixelRatio();

    // Hold the simulation still for the duration.
    //
    // Two reasons, and the second cost a lot of time to pin down. The obvious
    // one: two captures in a row otherwise show different moments, so any A/B
    // between them compares two different shots and is worthless. The subtle
    // one: with the loop running, a capture that repositions the camera comes
    // back with the frame smeared into radial streaks, while the identical
    // camera captured with the engine paused is clean — verified both ways,
    // motion blur on and off. I chased that through three wrong explanations
    // (a scene effect, then blur strength, then the aspect change on resize)
    // before settling it by measurement. Pausing removes the whole class.
    const wasPaused = engine.paused;
    if (!wasPaused) engine.pause?.('capture');

    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    engine.onResize?.(w, h);

    // The resize just changed the camera's aspect, which changes the projection
    // matrix — and to the motion blur's reprojection that is indistinguishable
    // from the camera having lurched sideways, so it smears the frame into
    // radial streaks. It has to be signalled AFTER the resize: a caller that
    // does it before, which is the obvious place, is undone by this line. The
    // streaks fooled me twice, first as a scene effect and then as excessive
    // blur strength, before I noticed live frames were clean and only captures
    // were not.
    engine.ctx?.postfx?.notifyCameraCut?.();

    // Two frames: the first settles anything sized off the new viewport
    // (post-processing render targets, temporal history buffers).
    engine.renderFrame?.(1 / 60);
    engine.renderFrame?.(1 / 60);

    const dataURL = renderer.domElement.toDataURL('image/png');

    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevSize.x, prevSize.y, false);
    engine.onResize?.(prevSize.x, prevSize.y);
    engine.ctx?.postfx?.notifyCameraCut?.();   // the restore is a jump too
    if (!wasPaused) engine.resume?.('capture');

    const res = await fetch('/__shot?name=' + encodeURIComponent(name), {
      method: 'POST',
      body: dataURL,
    });
    const json = await res.json();
    return { ...json, w, h, kb: Math.round(dataURL.length / 1365) };
  };

  /** Quick sanity probe: is the framebuffer actually showing anything? */
  MG.probe = function probe(w = 320, h = 180) {
    const { renderer } = engine;
    engine.renderFrame?.(1 / 60);
    const gl = renderer.getContext();
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = px[i] + px[i + 1] + px[i + 2];
      sum += l;
      if (l > max) max = l;
    }
    return { meanLuma: +(sum / (px.length / 4) / 3).toFixed(2), maxLuma: max, pixels: px.length / 4 };
  };

  return MG;
}
