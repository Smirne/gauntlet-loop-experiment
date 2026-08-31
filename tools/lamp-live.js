// Flip the bedside lamp between candidate settings WHILE DRIVING.
//
// The user's verdict on the URL-override ladder was "hard to tell, maybe I like
// this best". That is not indecision, it is the method failing: each setting
// needs its own page load, so the comparison is between the frame in front of
// you and a memory of a frame from two minutes ago. Human vision is poor at
// difference across time and excellent at change — the same reason the D57 and
// D53 chooser pages are flip-to-compare rather than side-by-side. A comparison
// the judge cannot flip between is not a comparison.
//
// So this binds the candidates to keys and switches them in place, mid-corner,
// with no reload and no loss of race state. Drive into the stretch you care
// about, then tap through them.
//
//   Q  and  E     previous / next candidate
//   1 .. 6        jump straight to one
//
// KEYS ARE MATCHED ON `KeyboardEvent.code`, NOT `.key`. The first version used
// `[`, `]` and `\`, which is wrong twice over on an Italian keyboard: the
// brackets need AltGr, and `\` is ALREADY BOUND — it is the game's restart, in
// both its Backslash and IntlBackslash positions, precisely because Input.js
// learned this same lesson once already (see the comment on DEFAULT_KEYS). So a
// "reset the lamp" key would have reset the race instead.
//
// `code` is the physical key, so KeyQ is the key left of W on every layout.
// Q and E are chosen because they are adjacent to the throttle key and are the
// only unbound letters nearby: W, S, A, D, Space, Shift, B, R, C and V are all
// taken by Input.js.
//
// Load it from the console once, then drive:
//
//   const m = await import('/tools/lamp-live.js'); m.enable();
//
// Nothing here is shipped and nothing is persisted. `disable()` puts the lamp
// back exactly as it was found.

const CANDIDATES = [
  { key: '1', code: 'Digit1', name: 'ships now', y: 205, irr: 4.20 },
  { key: '2', code: 'Digit2', name: 'lamp lower', y: 110, irr: 4.20 },
  { key: '3', code: 'Digit3', name: 'lamp lower + dimmer', y: 110, irr: 3.36 },
  { key: '4', code: 'Digit4', name: 'dimmer only', y: 205, irr: 3.36 },
  { key: '5', code: 'Digit5', name: 'lamp lowest', y: 80, irr: 4.20 },
  { key: '6', code: 'Digit6', name: 'before any of this', y: 205, irr: 5.60 },
];

let state = null;

function overlay() {
  let el = document.getElementById('mg-lamp-live');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'mg-lamp-live';
  el.style.cssText = [
    'position:fixed', 'left:14px', 'bottom:14px', 'z-index:99999',
    'font:600 13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'background:rgba(10,7,4,.86)', 'color:#ece3d7', 'padding:9px 13px',
    'border:1px solid #2c221a', 'border-left:2px solid #ffb000',
    'letter-spacing:.04em', 'pointer-events:none', 'white-space:pre',
  ].join(';');
  document.body.appendChild(el);
  return el;
}

/** @param {number} i */
function apply(i) {
  const c = CANDIDATES[i];
  const { P, lighting, MG } = state;
  P.lamp.offset = [-118, c.y, -92];
  P.lamp.irradiance = c.irr;

  // transition 0, because a cross-fade is exactly the thing that makes an A/B
  // unreadable: you end up judging the blend rather than either end of it.
  lighting.setPreset('nightLamp', { transition: 0 });

  // The lamp's shadow map has `autoUpdate = false` and is only flagged inside
  // Lighting's own update. Move the light without this and the shadow stays
  // where the previous candidate put it — which is the fault that voided an
  // entire D53 measurement, and would be worse here because it is silent.
  if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
  for (const cas of (lighting.cascades || [])) cas.light.shadow.needsUpdate = true;
  lighting._updateContactShadows?.(MG.ctx);

  state.i = i;
  overlay().textContent =
    `${c.key}  ${c.name}\n`
    + `lamp y ${c.y}   irradiance ${c.irr.toFixed(2)}\n`
    + `Q E step   1-6 jump`;
}

export async function enable() {
  if (state) return 'already on';
  const MG = window.MG;
  if (!MG?.ctx?.lighting) throw new Error('game not booted');
  const mod = await import('/src/render/Lighting.js');
  const P = mod.LIGHT_PRESETS.nightLamp;
  if (!P) throw new Error('no nightLamp preset');

  state = {
    MG,
    P,
    lighting: MG.ctx.lighting,
    i: 0,
    was: { offset: P.lamp.offset.slice(), irradiance: P.lamp.irradiance },
    handler: null,
  };

  // Capture phase, so this runs before Input.js and can stop the event reaching
  // it. Matched on `code` — the physical key — so the binding is the same on
  // every layout. Digits are accepted from the number row and the numpad.
  state.handler = (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    let next = null;
    if (ev.code === 'KeyE') next = (state.i + 1) % CANDIDATES.length;
    else if (ev.code === 'KeyQ') next = (state.i - 1 + CANDIDATES.length) % CANDIDATES.length;
    else {
      const k = CANDIDATES.findIndex((c) => c.code === ev.code || `Numpad${c.key}` === ev.code);
      if (k >= 0) next = k;
    }
    if (next === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    apply(next);
  };
  window.addEventListener('keydown', state.handler, true);

  // Start on what ships, so the first thing on screen is the reference.
  apply(0);
  return CANDIDATES.map((c) => `${c.key} ${c.name} (y ${c.y}, irr ${c.irr})`);
}

export function disable() {
  if (!state) return 'not on';
  const { P, lighting, was, handler } = state;
  window.removeEventListener('keydown', handler, true);
  P.lamp.offset = was.offset.slice();
  P.lamp.irradiance = was.irradiance;
  lighting.setPreset('nightLamp', { transition: 0 });
  if (lighting.lamp?.shadow) lighting.lamp.shadow.needsUpdate = true;
  document.getElementById('mg-lamp-live')?.remove();
  state = null;
  return 'restored';
}

export { CANDIDATES };
