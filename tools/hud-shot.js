// A store screenshot WITH the HUD on it.
//
// The problem: MG.capture reads the WebGL drawing buffer, and the HUD is DOM in
// #ui-root, so every capture this project has ever taken is HUD-less. That was
// fine for critic rounds — they are judging the render — and it is wrong for a
// store page, where a clean render reads as a tech demo and the HUD is what
// says "this is a game you play".
//
// The browser pane's own screenshot composites both, but caps at 800x450.
//
// So: render the HUD to an image through an SVG <foreignObject>, which
// rasterises real DOM at whatever size you ask for, and draw it over the
// 1920x1080 capture. The catch with foreignObject is that it gets NO access to
// the parent document's stylesheets — an un-inlined clone rasterises as
// unstyled text in the corner — so style.css is fetched and embedded.
//
//   const m = await import('/tools/hud-shot.js'); await m.hudShot('kitchen-hud');
//
// Verify the OUTPUT, not the return value. A foreignObject that fails to style
// still resolves successfully and still composites; it just composites
// garbage. Look at the frame.

const W = 1920, H = 1080;

async function hudLayer(w, h) {
  const root = document.querySelector('#ui-root');
  if (!root) throw new Error('no #ui-root');

  // The HUD is authored against the live viewport and scales itself with
  // --mg-vp. Rasterising at 1920x1080 means the clone must be told it lives in
  // a 1920x1080 viewport, or every cluster keeps the on-screen scale and lands
  // at the wrong size on a larger canvas.
  const vw = window.innerWidth || w;
  const scale = w / vw;

  const css = await (await fetch('/src/ui/style.css')).text();
  const clone = root.cloneNode(true);
  clone.style.width = vw + 'px';
  clone.style.height = (h / scale) + 'px';
  clone.style.position = 'relative';
  clone.style.inset = 'auto';

  // cloneNode copies a <canvas> ELEMENT but not its PIXELS, so the minimap
  // rasterised as an empty black panel — present, correctly placed, and blank.
  // Swap every cloned canvas for an <img> carrying the live canvas's contents.
  // Walked in parallel over the two trees rather than matched by id, because
  // the HUD's canvases do not all have one.
  const live = root.querySelectorAll('canvas');
  const copies = clone.querySelectorAll('canvas');
  for (let i = 0; i < copies.length; i++) {
    const src = live[i];
    if (!src) continue;
    let url;
    try { url = src.toDataURL('image/png'); }
    catch (_) { continue; }              // tainted canvas: leave it as it was
    const img = document.createElement('img');
    img.setAttribute('src', url);
    img.setAttribute('width', String(src.clientWidth || src.width));
    img.setAttribute('height', String(src.clientHeight || src.height));
    img.setAttribute('style', copies[i].getAttribute('style') || '');
    img.className = copies[i].className;
    copies[i].replaceWith(img);
  }

  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${vw} ${h / scale}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${xml}</div>` +
    `</foreignObject></svg>`;

  const img = new Image();
  const done = new Promise((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('foreignObject failed to rasterise'));
  });
  // encodeURIComponent, not btoa: the HUD carries non-Latin-1 glyphs (arrows,
  // the degree sign) and btoa throws on those.
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await done;
  return img;
}

export async function hudShot(name = 'hud', opts = {}) {
  if (!window.MG?.status) return { booting: true };

  // Capture the render first, at full size.
  const base = await window.MG.capture('_hudbase', W, H, opts.ss ?? 2);
  const bimg = new Image();
  const bdone = new Promise((res, rej) => { bimg.onload = () => res(); bimg.onerror = () => rej(new Error('base load failed')); });
  bimg.src = '/' + base.path + '?t=' + (base.kb || 0);
  await bdone;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.drawImage(bimg, 0, 0, W, H);

  let hudOk = true, why = null;
  try { g.drawImage(await hudLayer(W, H), 0, 0, W, H); }
  catch (err) { hudOk = false; why = err.message; }

  const res = await fetch('/__shot?name=' + encodeURIComponent(name), {
    method: 'POST', body: cv.toDataURL('image/png'),
  });
  return { ...(await res.json()), hudOk, why, w: W, h: H };
}
