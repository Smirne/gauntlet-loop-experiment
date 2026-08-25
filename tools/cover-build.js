// Compose the itch.io cover: an in-engine render plus the game's own logo.
//
// Run in the page rather than in an image editor, because the logo is defined
// in src/ui/style.css and nowhere else. Rebuilding it by eye in another tool
// makes a second source of truth for the game's wordmark, and the two drift.
// Everything below — weight, skew, letter-spacing, the layered shadows, the
// accent orange — is read off .mn-logo-1 / .mn-logo-2 / --accent, so a change
// to the title screen is a change to the cover.
//
//   const m = await import('/tools/cover-build.js');
//   await m.buildCover('/shots/cover-kitchen-c.png');
//
// Writes shots/itch-cover.png at exactly 630x500, which is what itch.io asks
// for. It is shown as small as 315x250 in a browse grid, so the logo is sized
// against the SHORT edge and checked at half scale before shipping.

const OUT_W = 630;
const OUT_H = 500;

/** The wordmark, drawn the way .mn-logo-1 / .mn-logo-2 set it. */
function drawLogo(g, x, y, scale) {
  const css = getComputedStyle(document.querySelector('#ui-root') || document.body);
  const accent = css.getPropertyValue('--accent').trim() || '#ff5a3c';
  const ink = css.getPropertyValue('--ink').trim() || '#f4f6fa';
  const display = css.getPropertyValue('--f-display').trim()
    || "'Arial Black', 'Arial Bold', system-ui, sans-serif";

  const SKEW = -9 * Math.PI / 180;   // skewX(-9deg) on both lines

  // Canvas has no letter-spacing before recent Chrome, and this must not depend
  // on that: draw glyph by glyph and advance by hand.
  const runs = (text, size, track) => {
    g.font = `900 ${size}px ${display}`;
    const w = [...text].reduce((a, ch) => a + g.measureText(ch).width + track, -track);
    return { text, size, track, width: w };
  };

  const stroke = (run, dx, dy, colour, atX, atY) => {
    g.save();
    g.transform(1, 0, Math.tan(SKEW), 1, atX + dx, atY + dy);
    g.font = `900 ${run.size}px ${display}`;
    g.fillStyle = colour;
    let cx = 0;
    for (const ch of run.text) {
      g.fillText(ch, cx, 0);
      cx += g.measureText(ch).width + run.track;
    }
    g.restore();
  };

  const s1 = 27 * scale, s2 = 47 * scale;
  const r1 = runs('MICRO', s1, s1 * 0.30);      // letter-spacing .30em
  const r2 = runs('GAUNTLET', s2, s2 * 0.02);   // letter-spacing .02em

  const y1 = y + s1;
  const y2 = y1 + s2 * 0.96;

  // Shadow offsets are EM FRACTIONS, not pixels.
  //
  // style.css writes them as px against a 62 px and a 108 px face. Carrying
  // those px straight over to a 27 px and a 47 px face more than doubles them
  // relative to the glyph, and the 16/20 layer on GAUNTLET stops reading as a
  // shadow and starts reading as a second, ghosted word behind the first.
  // Divided back out: 8/62 and 10/62 for MICRO, 16/108 and 20/108 for GAUNTLET.

  // MICRO — two dropped shadows, then the ink face.
  stroke(r1, s1 * 0.129, s1 * 0.161, 'rgba(0,0,0,.35)', x, y1);
  stroke(r1, 0, s1 * 0.065, 'rgba(0,0,0,.9)', x, y1);
  stroke(r1, 0, 0, ink, x, y1);

  // GAUNTLET — the four-layer stack from .mn-logo-2, painted back to front.
  stroke(r2, s2 * 0.148, s2 * 0.185, 'rgba(0,0,0,.30)', x, y2);
  stroke(r2, 0, s2 * 0.074, 'rgba(0,0,0,.92)', x, y2);
  stroke(r2, 0, s2 * 0.056, '#7d1c05', x, y2);
  stroke(r2, s2 * 0.019, 0, '#ff8a5c', x, y2);
  stroke(r2, 0, 0, accent, x, y2);

  return { w: Math.max(r1.width, r2.width), h: y2 - y + s2 * 0.2 };
}

export async function buildCover(src, opts = {}) {
  // NOT img.decode(). It never settles while the browser pane is backgrounded,
  // which is exactly the state this runs in, and the await eats the tool
  // timeout with nothing written and no error to read. load/error always fire.
  const img = new Image();
  const loaded = new Promise((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('could not load ' + src));
  });
  img.src = src;
  await loaded;

  const cv = document.createElement('canvas');
  cv.width = OUT_W; cv.height = OUT_H;
  const g = cv.getContext('2d');

  // Cover-fit. The source is already 1890x1500 — the same 1.26 ratio — so this
  // is a straight scale, but it is written as a fit so a differently framed
  // source cannot silently stretch the car.
  const sc = Math.max(OUT_W / img.width, OUT_H / img.height);
  const dw = img.width * sc, dh = img.height * sc;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (OUT_W - dw) / 2, (OUT_H - dh) / 2, dw, dh);

  // A soft top-left scrim. The logo lands on out-of-focus background here, but
  // that background is a mid-value wall and the wordmark's own shadows are not
  // enough on their own at thumbnail size.
  const grad = g.createLinearGradient(0, 0, 0, OUT_H * 0.62);
  grad.addColorStop(0, 'rgba(6,7,11,.58)');
  grad.addColorStop(1, 'rgba(6,7,11,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, OUT_W, OUT_H * 0.62);

  drawLogo(g, opts.x ?? 34, opts.y ?? 26, opts.scale ?? 1);

  // The sink takes the name in the query string and the raw data URL as the
  // body — same contract as Capture.js, not a JSON envelope.
  const name = opts.name || 'itch-cover';
  const dataURL = cv.toDataURL('image/png');
  const res = await fetch('/__shot?name=' + encodeURIComponent(name), {
    method: 'POST',
    body: dataURL,
  });
  return { ...(await res.json()), w: OUT_W, h: OUT_H, src };
}
