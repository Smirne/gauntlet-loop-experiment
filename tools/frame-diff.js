// Compare two frames already on disk, and refuse to let the comparison lie.
//
// D49 was a wrong conclusion drawn from a pixel diff, so this file exists to
// stop the next one. Two rules it enforces, both bought the hard way:
//
//   * A DIFF NEEDS A FLOOR. "57.85% of pixels changed" means nothing until you
//     know what two frames of the SAME build at the SAME moment score. That
//     number is not zero — supersampling, temporal history and float precision
//     all move pixels — and on this project it is 0.102%. A result is only a
//     result if it clears the floor by a wide margin, so `floor` is reported
//     next to every ratio rather than left for the reader to remember.
//   * A DIFF NEEDS A THRESHOLD. Counting any non-zero channel delta counts
//     dither. The default asks for a delta a person could see.
//
//   const m = await import('/tools/frame-diff.js');
//   await m.diff('d49-draft', 'd49-sharp');

// fetch + createImageBitmap + OffscreenCanvas, NOT `new Image()` + decode().
//
// The obvious version hangs forever when this is driven from a backgrounded
// browser pane: an `<img>` in a hidden document is never decoded, so the await
// never returns and the run looks like a crash. Same family as the
// requestAnimationFrame stall that grain-probe.js had to route around.
async function loadPixels(name) {
  const url = name.startsWith('/') ? name : '/shots/' + name + '.png';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('no such frame: ' + url + ' (' + res.status + ')');
  const bmp = await createImageBitmap(await res.blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const out = { px: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
  bmp.close();
  return out;
}

/**
 * @param {string} aName  frame name in shots/, without .png
 * @param {string} bName  the other one
 * @param {{threshold?: number, bands?: number}} [opts]
 *   threshold - per-channel delta that counts as "changed" (default 8/255)
 *   bands     - split the frame into this many horizontal bands and report each,
 *               so "all of it is in the table" can be shown rather than claimed
 */
export async function diff(aName, bName, opts = {}) {
  const th = opts.threshold ?? 8;
  const a = await loadPixels(aName);
  const b = await loadPixels(bName);
  if (a.w !== b.w || a.h !== b.h) {
    return { refused: 'different sizes', a: [a.w, a.h], b: [b.w, b.h] };
  }
  const nBands = opts.bands ?? 6;
  const bandH = Math.ceil(a.h / nBands);
  const bands = new Array(nBands).fill(0).map(() => ({ changed: 0, total: 0, sum: 0 }));

  let changed = 0, sum = 0, maxDelta = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(a.px[o] - b.px[o]);
    const dg = Math.abs(a.px[o + 1] - b.px[o + 1]);
    const db = Math.abs(a.px[o + 2] - b.px[o + 2]);
    const d = Math.max(dr, dg, db);
    if (d > maxDelta) maxDelta = d;
    sum += d;
    const band = bands[Math.min(nBands - 1, Math.floor((i / a.w) / bandH))];
    band.total++; band.sum += d;
    if (d >= th) { changed++; band.changed++; }
  }
  return {
    a: aName, b: bName, size: [a.w, a.h], threshold: th,
    /** THE NUMBER — but see `floor` before believing it. */
    changedPct: +(100 * changed / n).toFixed(3),
    meanDelta: +(sum / n).toFixed(3),
    maxDelta,
    bands: bands.map((x, i) => ({
      band: i, yFrom: i * bandH, changedPct: +(100 * x.changed / x.total).toFixed(2),
      meanDelta: +(x.sum / x.total).toFixed(2),
    })),
    floor: 'two boots of the same build in ONE session measured 0.102% on this project. '
         + 'A cross-SESSION diff has no established floor and must not be trusted — that '
         + 'is D49.',
  };
}
