// UI capture: get the DOM HUD into a reviewable PNG.
//
// The game renders to a canvas; the HUD, menus and results are DOM on top. So
// window.MG.capture(), which reads canvas.toDataURL(), can never see the UI —
// every review frame so far has been the game with its interface invisible, and
// the UI has therefore never been critiqued at all.
//
// Screenshotting the browser pane is not an answer either: the pane here is
// about 300x300 CSS pixels, so the HUD lays out in its most cramped form and
// nothing about it reads the way a player at 1080p would see it.
//
// So: clone the UI into an offscreen host at the target resolution, let it lay
// out there, serialise it through an SVG <foreignObject>, and composite that
// over a freshly rendered game frame. Same /__shot sink as the other captures.
//
//   const m = await import('/tools/capture-ui.js'); await m.captureUI('hud');
//
// Two honest limits:
//   * The page's own stylesheet is same-origin, so its rules can be read and
//     inlined. Anything cross-origin could not be, and would render unstyled.
//   * CSS viewport units inside a foreignObject resolve against the real
//     viewport, not the host. style.css uses three of them (6vw, 21vw, 60vw),
//     all inside a clamp() or min() with px bounds, and all on .boot-logo,
//     .boot-bar and .hud-cd-num — the boot screen and the countdown digit. None
//     appear in a racing or results frame, so in practice this does not bite.
//     If a vw ever lands on a HUD element, its size here will be wrong.

/**
 * Freeze anything mid-animation at the state it is actually in.
 *
 * A cloned node restarts its CSS animations from keyframe zero, and the SVG
 * rasterises that first frame. The results table entrance animation starts at
 * opacity 0, so all eight rows came out invisible while the header — which is
 * not animated — rendered fine. Walk the two trees together and pin the
 * animated properties from the live element onto its clone.
 */
function freezeAnimations(live, clone) {
  const cs = getComputedStyle(live);
  if (cs.animationName !== 'none' || cs.transitionProperty !== 'all') {
    clone.style.animation = 'none';
    clone.style.transition = 'none';
    clone.style.opacity = cs.opacity;
    if (cs.transform !== 'none') clone.style.transform = cs.transform;
    if (cs.filter !== 'none') clone.style.filter = cs.filter;
  }
  const a = live.children;
  const b = clone.children;
  for (let i = 0; i < a.length && i < b.length; i++) freezeAnimations(a[i], b[i]);
}

/**
 * Carry canvas pixels across the clone.
 *
 * cloneNode() copies a <canvas> element but not its bitmap, and a canvas inside
 * a foreignObject rasterises blank regardless. The HUD minimap is a canvas, so
 * it came out as an empty dark panel and looked like a broken minimap when it
 * was drawing perfectly well. Swap each one for an <img> of its current
 * contents, keeping the class and inline style so layout is untouched.
 */
function inlineCanvases(live, clone) {
  const a = live.querySelectorAll('canvas');
  const b = clone.querySelectorAll('canvas');
  for (let i = 0; i < a.length && i < b.length; i++) {
    let url;
    try {
      url = a[i].toDataURL('image/png');
    } catch {
      continue;   // tainted canvas; leave it blank rather than throw
    }
    const img = document.createElement('img');
    img.src = url;
    img.className = b[i].className;
    img.setAttribute('style', b[i].getAttribute('style') || '');
    img.style.width = a[i].clientWidth + 'px';
    img.style.height = a[i].clientHeight + 'px';
    b[i].replaceWith(img);
  }
}

function collectCSS() {
  let out = '';
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin sheet: unreadable by design. Nothing to do but note it.
      out += `/* skipped cross-origin sheet: ${sheet.href} */\n`;
      continue;
    }
    for (const rule of rules) out += rule.cssText + '\n';
  }
  return out;
}

/**
 * @param {string} name    output file stem -> shots/<name>.png
 * @param {object} opts
 * @param {number} opts.w  target width
 * @param {number} opts.h  target height
 * @param {boolean} opts.overGame  composite over a rendered game frame (default
 *        true). Pass false for a UI-only sheet on a neutral grey, which is the
 *        better frame for judging typography and spacing.
 */
export async function captureUI(name = 'ui', opts = {}) {
  const { w = 1920, h = 1080, overGame = true } = opts;
  const src = document.querySelector('#ui-root');
  if (!src) return { ok: false, error: 'no #ui-root' };

  // Lay the UI out at the target size rather than at the pane size.
  const host = document.createElement('div');
  host.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${w}px;height:${h}px;overflow:hidden;`;
  const clone = src.cloneNode(true);
  clone.style.cssText = `width:${w}px;height:${h}px;position:relative;`;
  freezeAnimations(src, clone);
  inlineCanvases(src, clone);
  host.appendChild(clone);
  document.body.appendChild(host);
  // Force layout before serialising.
  void host.offsetHeight;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px">` +
    `<style>${collectCSS()}</style>` +
    new XMLSerializer().serializeToString(clone) +
    `</div></foreignObject></svg>`;

  document.body.removeChild(host);

  const img = new Image();
  const loaded = new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('foreignObject failed to rasterise'));
  });
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await loaded;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');

  if (overGame) {
    const engine = window.MG.engine;
    const renderer = engine.renderer;
    const THREE = window.MG.THREE;
    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevPR = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    engine.onResize?.(w, h);
    window.MG.ctx.postfx?.notifyCameraCut?.();
    engine.renderFrame?.(1 / 60);
    engine.renderFrame?.(1 / 60);
    g.drawImage(renderer.domElement, 0, 0, w, h);
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevSize.x, prevSize.y, false);
    engine.onResize?.(prevSize.x, prevSize.y);
  } else {
    g.fillStyle = '#3a3a3e';
    g.fillRect(0, 0, w, h);
  }

  g.drawImage(img, 0, 0, w, h);

  const dataURL = out.toDataURL('image/png');
  const res = await fetch('/__shot?name=' + encodeURIComponent(name), {
    method: 'POST',
    body: dataURL,
  });
  return { ...(await res.json()), w, h, kb: Math.round(dataURL.length / 1365) };
}
