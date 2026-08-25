// ui/Menu.js — the front end.
//
// Title, garage, circuits, options and pause, all DOM inside #ui-root, all
// styled from src/ui/style.css, all navigable by keyboard, gamepad and mouse.
//
// ---------------------------------------------------------------- the showroom
//
// The car preview is not a second WebGL context. It is the *real* renderer, the
// real materials and the real post chain, looking at a small lit set parked at
// y = SHOWROOM_Y, far above the circuit and enclosed by its own cyclorama so
// nothing of the track can leak into frame. Entering the garage switches the
// Director off and Menu drives ctx.camera itself from lateUpdate; leaving hands
// it back with a snap so the camera cuts rather than sweeping nine hundred units
// of empty air. ('free' mode would also release the camera, but it re-pins the
// tilt-shift band to the player every frame, and the player is far below us.)
//
// That buys a preview that is lit, graded and tone-mapped exactly like the game
// for the cost of one Group, three directional lights and a turntable. A second
// WebGLRenderer would have been simpler to reason about and much worse: the
// materials carry an envMap that belongs to the main renderer's PMREM target,
// and a texture backed by another context's render target cannot be bound.
//
// ------------------------------------------------------------------- selection
//
// Track selection works today: main.js reads ?track=. Car and livery are
// persisted and written into the URL for ?car= / ?livery=, which main.js does
// not read yet — see the report. The menu therefore only reloads the page when
// the *track* changes, so a garage visit never costs a pointless boot.

import * as THREE from 'three';
import { SHIPPED_TRACKS } from '../game/Race.js';

const PREFS_KEY = 'microgauntlet.ui.v1';
const GARAGE_KEY = 'microgauntlet.garage.v1';

const SHOWROOM_Y = 900;          // well clear of the ~460x340 playfield
const STAGE_RADIUS = 46;         // cyclorama radius, camera sits inside it
const TURNTABLE_RATE = 0.42;     // rad/s
const CAM_DIST = 21;
const CAM_HEIGHT = 6.4;
const CAM_LOOK_Y = 2.1;
const CAM_SHIFT = 0.30;          // fraction of half-width the car sits left of centre

/** The circuits this build offers. Owned by Race.js — see SHIPPED_TRACKS there
 *  for which three are held back and why. Do not re-list them here. */
const TRACK_IDS = SHIPPED_TRACKS;

/** Garage focus items that survive a car change: prev, next, confirm. */
const GARAGE_FIXED = 3;

/** Map colours for the circuit previews. Not the real materials — a legible
 *  cartographic palette keyed to the same surface names. */
const SURFACE_COLOUR = {
  varnishedWood: '#8a5c30', oak: '#7a5030', pine: '#a07a48', laminate: '#8d7350',
  ceramicTile: '#9aa6ae', linoleum: '#7f8c7c', concrete: '#6f7278',
  brushedAluminium: '#8f959e', galvanisedSteel: '#7c828c', chromePlate: '#aab2bc',
  paper: '#d9d6cc', cardboard: '#b39468', gaffaTape: '#3b3f47',
  rubber: '#33363c', plasticMatte: '#4e5460', plasticGloss: '#5a6272',
  poolFelt: '#1f7a45', carpet: '#5c4460', rug: '#7c4a58',
  grass: '#3f8034', soil: '#5c4830', sand: '#c8a865', gravel: '#6d6459',
  sawdust: '#c0a271', crumbs: '#b8955e',
  spilledMilk: '#e6e4dc', waterPuddle: '#3f7f98', oilSlick: '#26262e',
  chalkLine: '#dfe3ea',
};
const SURFACE_FALLBACK = '#4c5468';

const HAZARD_COLOUR = {
  ramp: '#ffc93c', jump: '#ffc93c', bump: '#ffc93c',
  puddle: '#35e0ff', oil: '#a06bff', gap: '#ff3b52', fan: '#38dd82',
};

/* ------------------------------------------------------------------ helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function readJson(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) { return fallback; }
}

function writeJson(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); }
  catch (_) { /* private mode */ }
}

function applyViewportVars(uiScale) {
  const root = document.getElementById('ui-root');
  if (!root) return;
  const w = globalThis.innerWidth || 1280;
  const h = globalThis.innerHeight || 720;
  const vp = clamp(Math.min(w / 1600, h / 900), 0.62, 1.5);
  const mn = clamp(Math.min(w / 1360, h / 790), 0.5, 1.6);
  root.style.setProperty('--mg-vp', vp.toFixed(4));
  root.style.setProperty('--mg-ui', String(clamp(uiScale || 1, 0.6, 1.6)));
  root.style.setProperty('--mg-mn', mn.toFixed(4));
}

function hexOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return '#' + (value >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  }
  return typeof value === 'string' && value ? value : fallback;
}

function titleCase(s) {
  return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/* ==========================================================================
 * Procedural set dressing for the showroom
 * ========================================================================== */

/** Brushed dark plinth: concentric turning marks, radial falloff, fine grain. */
function plinthTextures(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const half = size / 2;

  g.fillStyle = '#15171d';
  g.fillRect(0, 0, size, size);

  // Turned concentric rings — a machined disc, not a flat colour.
  for (let r = 6; r < half; r += 3) {
    const v = 0.5 + 0.5 * Math.sin(r * 1.7);
    g.beginPath();
    g.arc(half, half, r, 0, Math.PI * 2);
    g.strokeStyle = `rgba(255,255,255,${(0.012 + v * 0.020).toFixed(3)})`;
    g.lineWidth = 1.6;
    g.stroke();
  }

  // Radial vignette so the plinth falls away into the dark at its rim.
  const grad = g.createRadialGradient(half, half, half * 0.1, half, half, half);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.62, 'rgba(0,0,0,0.0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.72)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // Grain
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Deterministic hash rather than Math.random: the set must look the same
    // in every capture.
    const n = ((i * 2654435761) >>> 8) & 0xff;
    const j = (n / 255 - 0.5) * 14;
    d[i] = clamp(d[i] + j, 0, 255);
    d[i + 1] = clamp(d[i + 1] + j, 0, 255);
    d[i + 2] = clamp(d[i + 2] + j, 0, 255);
  }
  g.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  // Roughness: polished at the centre, duller toward the rim.
  const rc = document.createElement('canvas');
  rc.width = rc.height = size;
  const rg = rc.getContext('2d');
  const rgrad = rg.createRadialGradient(half, half, 0, half, half, half);
  rgrad.addColorStop(0, '#4a4a4a');
  rgrad.addColorStop(0.7, '#8a8a8a');
  rgrad.addColorStop(1, '#b4b4b4');
  rg.fillStyle = rgrad;
  rg.fillRect(0, 0, size, size);
  const rough = new THREE.CanvasTexture(rc);
  rough.colorSpace = THREE.NoColorSpace;

  return { map, rough };
}

/** Cyclorama: a vertical studio gradient with a soft warm pool behind the car. */
function backdropTexture(w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.00, '#04050a');
  grad.addColorStop(0.42, '#141a26');
  grad.addColorStop(0.74, '#1c2331');
  grad.addColorStop(1.00, '#07090f');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Two soft light pools, one warm one cool, so the wall is never a flat wash.
  const pool = (x, colour, radius) => {
    const rg = g.createRadialGradient(x, h * 0.62, 0, x, h * 0.62, radius);
    rg.addColorStop(0, colour);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  };
  pool(w * 0.26, 'rgba(255,150,90,0.20)', w * 0.34);
  pool(w * 0.72, 'rgba(90,180,255,0.16)', w * 0.32);

  // Faint vertical seams: a real cyc has panel joins and they sell the scale.
  g.globalAlpha = 0.05;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  for (let i = 1; i < 12; i++) {
    const x = (i / 12) * w;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/* ==========================================================================
 * Menu
 * ========================================================================== */

export class Menu {
  name = 'menu';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.root = null;
    this.visible = false;
    this.page = '';
    this.pageNode = null;
    this.returnPage = 'title';

    this.items = [];
    this.focus = 0;
    this.listening = false;

    this.prefs = Object.assign({ units: 'kmh', minimap: true, toasts: true }, readJson(PREFS_KEY, {}));
    this.sel = Object.assign(
      { carId: '', livery: 0, trackId: '', tab: 'video' },
      readJson(GARAGE_KEY, {})
    );

    this.models = [];
    this.trackDefs = new Map();

    this.stage = null;          // showroom rig
    this.stageActive = false;
    this._previewToken = 0;
    this._spin = 0;
    this._camSaved = null;
    this._carMod = null;        // CarModels namespace, imported lazily
    this._curves = new WeakMap();

    this._timers = new Set();
    this._offBus = [];
    this._pad = { buttons: [], ax: 0, ay: 0, repeat: 0, primed: false };
    this._disposed = false;

    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /* ==================================================================== init */

  async init() {
    const host = document.getElementById('ui-root');
    if (!host) return this;

    applyViewportVars(this.ctx?.settings?.gameplay?.uiScale ?? 1);

    this.root = el('div');
    this.root.id = 'mg-menu';
    this.root.classList.add('mg-hidden');
    this.n = {};
    this.n.veil = el('div', 'mn-veil');
    this.n.frame = el('div', 'mn-frame');
    this.root.append(this.n.veil, this.n.frame);
    host.appendChild(this.root);

    this._resolveModels();
    this._resolveDefaults();

    const bus = this.ctx?.bus;
    if (bus?.on) {
      this._offBus.push(bus.on('race:pause', (p) => this._onPause(p)));
      this._offBus.push(bus.on('input:rebindEnd', () => { this.listening = false; this._refreshRows(); }));
      this._offBus.push(bus.on('settings:applied', () => this._refreshRows()));
    }

    const MG = (globalThis.MG = globalThis.MG || {});
    MG.ui = MG.ui || {};
    MG.ui.menu = this;

    // Preload the circuit definitions and the livery tables so both select
    // screens have real data the first time they open. Both are already in the
    // module registry — main.js loaded them — so these resolve from cache.
    this._loadTrackDefs();
    this._loadCarModule();

    const params = this.ctx?.params;
    const skip = params?.get?.('skipmenu') === '1' || params?.has?.('t');
    if (!skip) this.show('title');

    return this;
  }

  _resolveModels() {
    const src = this.ctx?.carModels;
    const list = [];
    if (Array.isArray(src)) {
      for (const m of src) if (m) list.push({ id: m.id ?? m.name, def: m });
    } else if (src && typeof src === 'object') {
      for (const id of Object.keys(src)) list.push({ id, def: src[id] });
    }
    this.models = list;
  }

  _resolveDefaults() {
    const params = this.ctx?.params;
    const urlCar = params?.get?.('car');
    const urlLivery = Number(params?.get?.('livery'));
    const urlTrack = params?.get?.('track');

    if (urlCar) this.sel.carId = urlCar;
    if (Number.isFinite(urlLivery)) this.sel.livery = urlLivery;
    if (urlTrack) this.sel.trackId = urlTrack;

    if (!this.sel.carId || !this.models.some((m) => m.id === this.sel.carId)) {
      this.sel.carId = this.ctx?.player?.modelId || this.models[0]?.id || 'muscle';
    }
    // Clamp to the roster. `?track=workbench` still boots the circuit — main.js
    // reads the URL and the loader has never consulted this list — but the menu
    // must not come back holding a card it cannot draw, so the carousel falls to
    // the first shipped circuit instead.
    if (!this.sel.trackId || !TRACK_IDS.includes(this.sel.trackId)) {
      const booted = this.ctx?.track?.id;
      this.sel.trackId = TRACK_IDS.includes(booted) ? booted : TRACK_IDS[0];
    }
    this.sel.livery = clamp(Math.round(this.sel.livery) || 0, 0, 4);
  }

  async _loadTrackDefs() {
    const ids = TRACK_IDS.slice();
    const current = this.ctx?.track;
    for (const id of ids) {
      if (this.trackDefs.has(id)) continue;
      // The live track already has its definition in memory.
      if (current?.id === id && current.def) { this.trackDefs.set(id, current.def); continue; }
      try {
        const mod = await import(`../world/tracks/${id}.js`);
        const def = mod?.default ?? mod?.track ?? null;
        if (def) this.trackDefs.set(id, def);
      } catch (err) {
        console.warn(`[Menu] could not load circuit "${id}"`, err);
      }
    }
    if (this.page === 'circuits' || this.page === 'title') this._setPage(this.page, { silent: true });
  }

  /**
   * LIVERIES and liveryFor live in CarModels.js. A dynamic import keeps a
   * 2,700-line peer from being able to take the front end down at parse time.
   */
  async _loadCarModule() {
    try {
      this._carMod = await import('../vehicle/CarModels.js');
      this._liveryCache = null;
      if (this.page === 'garage') this._refreshGarage();
    } catch (err) {
      console.warn('[Menu] livery table unavailable; using derived schemes', err);
    }
  }

  /* ================================================================ lifecycle */

  show(page = 'title') {
    if (!this.root) return this;
    this.root.classList.remove('mg-hidden', 'is-out');
    this.visible = true;
    this._pad.primed = false;
    globalThis.addEventListener('keydown', this._onKeyDown, true);
    // The pause screen sits over a live race; every other page replaces it.
    if (page !== 'pause') this.ctx?.hud?.setVisible?.(false);
    this._setPage(page);
    this.ctx?.bus?.emit?.('ui:menu', { screen: page, open: true });
    return this;
  }

  /** main.js calls this for automated screenshots. */
  hide() {
    if (!this.root) return this;
    this.visible = false;
    this._leaveShowroom();
    this.root.classList.add('is-out');
    this._after(340, () => { if (!this.visible) this.root?.classList.add('mg-hidden'); });
    globalThis.removeEventListener('keydown', this._onKeyDown, true);
    this.ctx?.hud?.syncVisibility?.();
    this.ctx?.bus?.emit?.('ui:menu', { screen: this.page, open: false });
    this.page = '';
    return this;
  }

  open(page) { return this.show(page); }
  close() { return this.hide(); }

  _onPause(p) {
    if (p?.paused) {
      if (!this.visible) this.show('pause');
    } else if (this.visible && this.page === 'pause') {
      this.hide();
    }
  }

  /* ===================================================================== pages */

  _setPage(id, opts = {}) {
    const previous = this.pageNode;
    if (previous) {
      previous.classList.add('is-leaving');
      const node = previous;
      this._after(220, () => node.remove());
    }

    if (id !== 'garage') this._leaveShowroom();

    // A silent rebuild (a tab switch, or circuit data arriving late) must not
    // yank the cursor back to the first row under the player's hands.
    const keepFocus = opts.silent && this.page === id ? this.focus : 0;

    this.page = id;
    this.items = [];
    this.focus = keepFocus;

    const page = el('div', 'mn-page is-enter');
    this.pageNode = page;
    this.n.frame.appendChild(page);

    switch (id) {
      case 'garage': this._buildGarage(page); break;
      case 'circuits': this._buildCircuits(page); break;
      case 'options': this._buildOptions(page); break;
      case 'pause': this._buildPause(page); break;
      case 'title':
      default: this._buildTitle(page); break;
    }

    // The garage shows a real 3D car through the left of the screen, so it gets
    // a scrim that is only opaque under the spec sheet.
    const veil = id === 'title' || id === 'pause' ? ''
      : id === 'garage' ? ' mn-veil--stage'
        : ' mn-veil--heavy';
    this.n.veil.className = 'mn-veil' + veil;

    this._syncFocus();
    if (!opts.silent) this._sfx('page');
    if (id === 'garage') this._enterShowroom();
  }

  /* ------------------------------------------------------------------ title */

  _buildTitle(page) {
    page.appendChild(this._masthead('An arcade racer at 1:64 scale'));

    const body = el('div', 'mn-title-body');
    const nav = el('div', 'mn-nav');

    const trackDef = this.trackDefs.get(this.sel.trackId);
    nav.append(
      this._button('Quick race', () => this._startRace(), 'ENTER'),
      // Count the roster. The literal '5 rounds' outlived the five-track roster
      // by exactly as long as it took someone to read the title screen.
      this._button('Championship', () => this._startChampionship(),
        `${TRACK_IDS.length} round${TRACK_IDS.length === 1 ? '' : 's'}`),
      this._button('Garage', () => this._setPage('garage'), this._carName()),
      this._button('Circuits', () => this._setPage('circuits'), trackDef?.name || this.sel.trackId.toUpperCase()),
      this._button('Options', () => { this.returnPage = 'title'; this._setPage('options'); }, 'O'),
    );

    const blurb = el('div', 'mn-blurb');
    blurb.append(
      el('div', 'mn-blurb-title', trackDef?.name || (this.ctx?.track?.title ?? 'BREAKFAST RUSH')),
      el('div', 'mn-blurb-text', this._trackBlurb(trackDef)),
    );

    const stats = el('div', 'mn-stat-row');
    const race = this.ctx?.race;
    const rec = race?.records?.bestLap || 0;
    stats.append(
      this._stat('Circuit', String(this.trackDefs.size || TRACK_IDS.length)),
      this._stat('Cars', String(this.models.length || 8)),
      this._stat('Best lap', rec > 0 ? this._time(rec) : '--.---'),
    );
    blurb.appendChild(stats);
    blurb.appendChild(this._driveCard());

    body.append(nav, blurb);
    page.appendChild(body);
    page.appendChild(this._footer([
      ['↑↓', 'Navigate'], ['ENTER', 'Select'], ['ESC', 'Back'],
    ]));
  }

  /**
   * How to drive the car, on the first screen the player sees.
   *
   * D46. The footer under this card explains the *menu* — arrows, enter, escape
   * — and until now that was the only key legend anywhere outside Options →
   * Controls, three screens deep. That is survivable in a desktop build with a
   * store page next to it and fatal in an itch.io iframe, where the player has a
   * canvas and nothing else. Someone who never finds SHIFT reports that the cars
   * feel slow, and that report is about the menu, not the handling.
   *
   * Bindings are read back from Input rather than written out here, so a rebind
   * shows the key the player actually has. `input.glyph()` — not `glyphs()` —
   * because it follows the *active device*: a player on a pad gets RB, not
   * "SHIFT / SHIFT". The written-out defaults below are only the fallback for
   * the first title build, before Input exists.
   */
  _driveCard() {
    const card = el('div', 'mn-drive');
    card.appendChild(el('div', 'mg-label', 'Drive'));
    const row = el('div', 'mn-drive-keys');
    const pairs = [
      [this._bindLabel('throttle', 'W'), 'Go'],
      [this._bindLabel('brake', 'S'), 'Brake'],
      [`${this._bindLabel('steerLeft', 'A')} ${this._bindLabel('steerRight', 'D')}`, 'Steer'],
      [this._bindLabel('boost', 'SHIFT'), 'Boost'],
      [this._bindLabel('handbrake', 'SPACE'), 'Drift'],
      [this._bindLabel('respawn', 'R'), 'Respawn'],
    ];
    for (const [k, label] of pairs) {
      const hint = el('div', 'mn-hint');
      for (const part of String(k).split(' ')) hint.appendChild(el('span', 'mn-key', part));
      hint.appendChild(document.createTextNode(label));
      row.appendChild(hint);
    }
    card.appendChild(row);
    return card;
  }

  /** The glyph currently bound to an action, or the shipped default. */
  _bindLabel(action, fallback) {
    try {
      const g = this.ctx?.input?.glyph?.(action);
      // '?' is Input's own "bound to nothing on this device" marker — printing
      // it on the title screen would be worse than printing the default.
      if (g && g !== '?') return g;
    } catch (_) { /* input not up yet during the first title build */ }
    return fallback;
  }

  _masthead(subtitle) {
    const wrap = el('div', 'mn-logo');
    wrap.append(
      el('span', 'mn-logo-1', 'MICRO'),
      el('span', 'mn-logo-2', 'GAUNTLET'),
    );
    const rule = el('div', 'mn-logo-rule');
    rule.append(el('div', 'mg-rule'), el('div', 'mn-logo-sub', subtitle));
    wrap.appendChild(rule);
    wrap.appendChild(this._mark());
    return wrap;
  }

  /** Three speed chevrons. The only piece of drawn identity in the UI. */
  _mark() {
    const s = svgEl('svg', { class: 'mn-mark', viewBox: '0 0 100 100' });
    const chevron = (x, o) => svgEl('path', {
      d: `M${x} 8 L${x + 26} 8 L${x + 50} 50 L${x + 26} 92 L${x} 92 L${x + 24} 50 Z`,
      opacity: String(o),
    });
    s.append(chevron(2, 0.28), chevron(24, 0.58), chevron(46, 1));
    return s;
  }

  _stat(label, value) {
    const wrap = el('div', 'mn-stat');
    wrap.append(el('div', 'mg-label', label), el('div', 'mn-stat-v', value));
    return wrap;
  }

  _trackBlurb(def) {
    if (!def) return 'Five improvised circuits across a house. Same rules everywhere: keep it on the surface, and do not fall a screen behind.';
    const surfaces = new Set();
    for (const s of def.surfaceSpans || []) if (s?.surface) surfaces.add(titleCase(s.surface).toLowerCase());
    const hazards = new Set();
    for (const h of def.hazards || []) if (h?.type) hazards.add(h.type);
    const bits = [];
    if (surfaces.size) bits.push(`Run over ${Array.from(surfaces).slice(0, 3).join(', ')}.`);
    if (hazards.size) bits.push(`Watch for ${Array.from(hazards).slice(0, 3).join(', ')}.`);
    bits.push(`${def.laps ?? 3} laps. Difficulty ${def.difficulty ?? 1} of 5.`);
    return bits.join(' ');
  }

  /* ----------------------------------------------------------------- garage */

  _buildGarage(page) {
    const head = el('div', 'mn-head');
    head.append(el('div', 'mn-head-t', 'GARAGE'), el('div', 'mn-head-s', 'Choose your car'));
    const right = el('div', 'mn-head-r');
    right.appendChild(el('div', 'mg-chip mg-chip--accent', `${this.models.length || 8} CHASSIS`));
    head.appendChild(right);
    page.appendChild(head);

    const body = el('div', 'mn-garage');

    /* --- 3D stage frame -------------------------------------------------- */
    const stage = el('div', 'mn-stage');
    stage.appendChild(el('div', 'mn-stage-frame'));
    this.n.stageClass = el('div', 'mn-stage-class', '');
    this.n.stageName = el('div', 'mn-stage-name', '');
    const arrows = el('div', 'mn-stage-arrows');
    const prev = this._arrow('‹', () => this._cycleCar(-1));
    const next = this._arrow('›', () => this._cycleCar(1));
    arrows.append(prev, next);
    this.n.stageFallback = el('div', 'mn-stage-fallback mg-hidden');
    stage.append(this.n.stageFallback, this.n.stageClass, this.n.stageName, arrows);
    body.appendChild(stage);

    /* --- spec sheet ------------------------------------------------------ */
    const spec = el('div', 'mn-spec');
    this.n.specBlurb = el('div', 'mn-spec-blurb', '');

    this.n.bars = el('div', 'mn-bars');
    this.n.barNodes = {};
    for (const key of ['speed', 'accel', 'grip', 'handling', 'toughness']) {
      const row = el('div', 'mn-bar-row');
      const bar = el('div', 'mn-bar' + (key === 'toughness' ? ' mn-bar--alt' : ''));
      bar.appendChild(el('i'));
      const val = el('div', 'mn-bar-v', '0');
      row.append(el('div', 'mg-label', key), bar, val);
      this.n.bars.appendChild(row);
      this.n.barNodes[key] = { bar, val };
    }

    const facts = el('div', 'mn-track-facts');
    this.n.factDrive = this._fact('Drive', '—');
    this.n.factTop = this._fact('Top speed', '—');
    this.n.factGears = this._fact('Gears', '—');
    facts.append(this.n.factDrive.wrap, this.n.factTop.wrap, this.n.factGears.wrap);

    this.n.liveryName = el('div', 'mn-livery-name', '');
    this.n.liveries = el('div', 'mn-liveries');

    spec.append(
      this.n.specBlurb, el('div', 'mg-rule'), this.n.bars, facts,
      el('div', 'mg-rule'), el('div', 'mg-label', 'Livery'),
      this.n.liveryName, this.n.liveries,
    );
    body.appendChild(spec);
    page.appendChild(body);

    page.appendChild(this._footer([
      ['← →', 'Car'], ['1-5', 'Livery'], ['ENTER', 'Confirm'], ['ESC', 'Back'],
    ]));

    // Focus order is fixed-then-swatches: the first GARAGE_FIXED items survive a
    // car change, everything after them is rebuilt with the livery row.
    const confirm = el('button', 'mg-btn mg-btn--primary');
    confirm.type = 'button';
    confirm.append(el('span', null, 'CONFIRM'), el('span', 'mg-btn-key', 'ENTER'));
    confirm.addEventListener('click', () => { this._sfx('confirm'); this._confirmCar(); });
    spec.appendChild(confirm);

    this.items.push({ el: prev, activate: () => this._cycleCar(-1) });
    this.items.push({ el: next, activate: () => this._cycleCar(1) });
    this.items.push({ el: confirm, activate: () => this._confirmCar() });
    this.focus = GARAGE_FIXED - 1;

    this._refreshGarage();
  }

  _confirmCar() {
    this._persist();
    this._syncUrl();
    this._setPage('title');
  }

  _arrow(glyph, onActivate) {
    const b = el('button', 'mn-arrow');
    b.type = 'button';
    b.textContent = glyph;
    b.addEventListener('click', () => { this._sfx('move'); onActivate(); });
    return b;
  }

  _fact(label, value) {
    const wrap = el('div', 'mn-fact');
    const v = el('div', 'mn-fact-v', value);
    wrap.append(el('div', 'mg-label', label), v);
    return { wrap, v };
  }

  _carEntry() {
    return this.models.find((m) => m.id === this.sel.carId) || this.models[0] || null;
  }

  _carName() {
    return this._carEntry()?.def?.name || String(this.sel.carId || '').toUpperCase();
  }

  _cycleCar(delta) {
    if (!this.models.length) return;
    const i = Math.max(0, this.models.findIndex((m) => m.id === this.sel.carId));
    const next = (i + delta + this.models.length) % this.models.length;
    this.sel.carId = this.models[next].id;
    this.sel.livery = 0;
    this._persist();
    this._refreshGarage();
    this._loadPreview();
  }

  _setLivery(index) {
    this.sel.livery = clamp(index, 0, 4);
    this._persist();
    this._refreshGarage();
    this._loadPreview();
  }

  _refreshGarage() {
    const entry = this._carEntry();
    const def = entry?.def || {};
    if (this.n.stageName) this.n.stageName.textContent = def.name || String(entry?.id || '').toUpperCase();
    if (this.n.stageClass) this.n.stageClass.textContent = `${(def.drive || 'rwd').toUpperCase()} · ${titleCase(entry?.id || '')}`;
    if (this.n.specBlurb) this.n.specBlurb.textContent = def.blurb || '';

    const stats = def.stats || {};
    for (const key in this.n.barNodes || {}) {
      const v = clamp(Number(stats[key]) || 0, 0, 1);
      this.n.barNodes[key].bar.style.setProperty('--v', v.toFixed(3));
      this.n.barNodes[key].val.textContent = String(Math.round(v * 100));
    }

    this.n.factDrive.v.textContent = (def.drive || 'rwd').toUpperCase();
    // Same 1:64 scale conversion the speedometer uses.
    const factor = this.prefs.units === 'mph' ? 0.01 * 64 * 2.236936 : 0.01 * 64 * 3.6;
    const unit = this.prefs.units === 'mph' ? 'mph' : 'km/h';
    this.n.factTop.v.textContent = def.topSpeed ? `${Math.round(def.topSpeed * factor)} ${unit}` : '—';
    this.n.factGears.v.textContent = Array.isArray(def.gears) ? String(def.gears.length) : '—';

    this._buildLiverySwatches();
    this._renderFallbackCar(def);
  }

  _buildLiverySwatches() {
    const host = this.n.liveries;
    if (!host) return;
    host.textContent = '';
    // Drop the swatch items and rebuild them, so a car change can never leave a
    // focus entry pointing at a detached node.
    this.items.length = Math.min(this.items.length, GARAGE_FIXED);

    const liveries = this._liveriesFor(this.sel.carId);
    for (let i = 0; i < liveries.length; i++) {
      const lv = liveries[i];
      const sw = el('button', 'mn-swatch');
      sw.type = 'button';
      sw.style.background = `linear-gradient(150deg, ${hexOf(lv.base, '#c8302a')} 0%, ${hexOf(lv.base, '#c8302a')} 62%, ${hexOf(lv.secondary, '#16181d')} 62%)`;
      const stripe = el('i');
      stripe.style.background = hexOf(lv.accent, '#f0f2f5');
      sw.appendChild(stripe);
      if (i === this.sel.livery) sw.classList.add('is-on');
      const idx = i;
      sw.addEventListener('click', () => { this._sfx('confirm'); this._setLivery(idx); });
      host.appendChild(sw);
      this.items.push({ el: sw, activate: () => this._setLivery(idx) });
    }
    if (this.n.liveryName) {
      this.n.liveryName.textContent = liveries[this.sel.livery]?.name || '';
    }
    this._syncFocus();
  }

  /**
   * Livery data lives in CarModels.js, reached by lazy dynamic import so a
   * parse error in a 2,700-line peer cannot take the front end down with it.
   * A derived palette covers the case where it never arrives.
   */
  _liveriesFor(modelId) {
    if (!this._liveryCache) this._liveryCache = new Map();
    const cached = this._liveryCache;
    if (cached.has(modelId)) return cached.get(modelId);

    let out = null;
    const mod = this._carMod;
    if (mod?.LIVERIES?.[modelId]) out = mod.LIVERIES[modelId];
    if (!out && typeof mod?.liveryFor === 'function') {
      out = [0, 1, 2, 3, 4].map((i) => mod.liveryFor(modelId, i));
    }
    if (!out) {
      // Derive five plausible schemes from the chassis id so the swatches are
      // still distinct, still deterministic and never grey boxes.
      const seed = Array.from(String(modelId)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
      out = [];
      for (let i = 0; i < 5; i++) {
        const h = ((seed >>> (i * 3)) % 360 + i * 67) % 360;
        out.push({
          name: ['WORKS', 'HERITAGE', 'STREET', 'PRESS', 'NIGHT'][i],
          base: hslHex(h, 0.62, 0.46),
          secondary: hslHex((h + 210) % 360, 0.18, 0.12),
          accent: hslHex((h + 40) % 360, 0.85, 0.72),
        });
      }
    }
    cached.set(modelId, out);
    return out;
  }

  /**
   * Side elevation drawn from the chassis's own body key sections. Only used
   * when the 3D preview could not be built — but it is a real drawing of the
   * real car, not a placeholder.
   */
  _renderFallbackCar(def) {
    const host = this.n.stageFallback;
    if (!host) return;
    host.textContent = '';
    if (this.stageActive && this.stage?.visual) { host.classList.add('mg-hidden'); return; }

    const keys = def?.body?.keys;
    if (!Array.isArray(keys) || keys.length < 3) { host.classList.add('mg-hidden'); return; }
    host.classList.remove('mg-hidden');

    const L = def.length || 9;
    const floorY = def.body.floorY ?? 0.4;
    const H = def.height || 2.9;
    const pad = 0.6;
    const vb = `${-L / 2 - pad} ${-pad} ${L + pad * 2} ${H + pad * 2}`;
    const s = svgEl('svg', { viewBox: vb, preserveAspectRatio: 'xMidYMid meet' });
    // SVG y grows downward; the car is authored y-up, so flip inside a group.
    const g = svgEl('g', { transform: `translate(0 ${H}) scale(1 -1)` });

    let top = '';
    for (const k of keys) top += `${top ? 'L' : 'M'}${k.z.toFixed(2)} ${k.top.toFixed(2)} `;
    const last = keys[keys.length - 1];
    const first = keys[0];
    const body = `${top}L${last.z.toFixed(2)} ${floorY.toFixed(2)} L${first.z.toFixed(2)} ${floorY.toFixed(2)} Z`;
    g.appendChild(svgEl('path', { d: body, class: 'mn-sil-body' }));

    const p = def.physics || {};
    const R = p.wheelRadius ?? 1.15;
    const wb = p.wheelbase ?? 5.6;
    const bias = p.cgBias ?? 0.5;
    for (const z of [wb * (1 - bias), -wb * bias]) {
      g.appendChild(svgEl('circle', { cx: z.toFixed(2), cy: R.toFixed(2), r: R.toFixed(2), class: 'mn-sil-tyre' }));
      g.appendChild(svgEl('circle', { cx: z.toFixed(2), cy: R.toFixed(2), r: (R * 0.58).toFixed(2), class: 'mn-sil-rim' }));
    }
    s.appendChild(g);
    host.appendChild(s);
  }

  /* --------------------------------------------------------------- circuits */

  _buildCircuits(page) {
    const head = el('div', 'mn-head');
    // Counted, not written. This subtitle said "Five rooms, five circuits" over
    // a list of two — the same stale literal as the title screen's '5 rounds',
    // and there is no third place left that hardcodes the roster size.
    const n = TRACK_IDS.length;
    const word = ['no', 'one', 'two', 'three', 'four', 'five'][n] || String(n);
    const sub = n === 1 ? 'One room, one circuit' : `${titleCase(word)} rooms, ${word} circuits`;
    head.append(el('div', 'mn-head-t', 'CIRCUITS'), el('div', 'mn-head-s', sub));
    page.appendChild(head);

    const body = el('div', 'mn-tracks');
    const list = el('div', 'mn-track-list');

    for (const id of TRACK_IDS) {
      const def = this.trackDefs.get(id);
      const card = el('div', 'mn-track-card');
      if (id === this.sel.trackId) card.classList.add('is-on');
      const cv = el('canvas');
      cv.width = 148; cv.height = 104;
      const info = el('div');
      info.append(
        el('div', 'mn-tc-name', def?.name || id.toUpperCase()),
        el('div', 'mn-tc-meta', def ? `${def.laps ?? 3} LAPS · DIFF ${def.difficulty ?? 1}` : 'LOADING'),
      );
      card.append(cv, info);
      if (def) this._drawTrack(cv, def, { simple: true });
      card.addEventListener('click', () => { this._sfx('confirm'); this._selectTrack(id); });
      list.appendChild(card);
      this.items.push({ el: card, activate: () => this._selectTrack(id), focus: () => this._previewTrack(id) });
    }

    const view = el('div', 'mn-track-view');
    const big = el('div', 'mn-track-big');
    this.n.trackCanvas = el('canvas');
    big.append(this.n.trackCanvas, el('div', 'mn-stage-frame'));
    this.n.trackFacts = el('div', 'mn-track-facts');
    this.n.trackLegend = el('div', 'mn-legend');
    view.append(big, this.n.trackFacts, this.n.trackLegend);

    body.append(list, view);
    page.appendChild(body);
    page.appendChild(this._footer([
      ['↑↓', 'Circuit'], ['ENTER', 'Race here'], ['ESC', 'Back'],
    ]));

    this._previewTrack(this.sel.trackId);
    const idx = TRACK_IDS.indexOf(this.sel.trackId);
    if (idx >= 0) this.focus = idx;
  }

  _selectTrack(id) {
    this.sel.trackId = id;
    this._persist();
    this._startRace();
  }

  _previewTrack(id) {
    const def = this.trackDefs.get(id);
    const canvas = this.n.trackCanvas;
    if (!canvas) return;
    const rect = canvas.parentElement?.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(200, Math.round((rect?.width || 640) * dpr));
    canvas.height = Math.max(140, Math.round((rect?.height || 340) * dpr));
    if (def) this._drawTrack(canvas, def, { simple: false });

    const facts = this.n.trackFacts;
    if (facts) {
      facts.textContent = '';
      const length = def ? Math.round(this._trackLength(def)) : 0;
      facts.append(
        this._fact('Length', length ? `${length} u` : '—').wrap,
        this._fact('Laps', String(def?.laps ?? 3)).wrap,
        this._fact('Theme', titleCase(def?.theme || '—')).wrap,
      );
      const diffWrap = el('div', 'mn-fact');
      const dots = el('div', 'mn-diff');
      for (let i = 0; i < 5; i++) {
        const d = el('i');
        if (i < (def?.difficulty ?? 1)) d.classList.add('is-on');
        dots.appendChild(d);
      }
      diffWrap.append(el('div', 'mg-label', 'Difficulty'), dots);
      facts.appendChild(diffWrap);
    }

    const legend = this.n.trackLegend;
    if (legend) {
      legend.textContent = '';
      const seen = new Set();
      for (const span of def?.surfaceSpans || []) {
        const name = span?.surface;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const item = el('span');
        const swatch = el('i');
        swatch.style.background = SURFACE_COLOUR[name] || SURFACE_FALLBACK;
        item.append(swatch, document.createTextNode(titleCase(name)));
        legend.appendChild(item);
      }
      const hz = new Set();
      for (const h of def?.hazards || []) if (h?.type) hz.add(h.type);
      for (const type of hz) {
        const item = el('span');
        const swatch = el('i');
        swatch.style.background = HAZARD_COLOUR[type] || '#ffffff';
        item.append(swatch, document.createTextNode(type));
        legend.appendChild(item);
      }
    }
  }

  /** Closed Catmull-Rom through the definition's control points — the same
   *  curve world/Track.js builds, so the preview is the circuit, not a sketch. */
  _trackCurve(def) {
    if (!def) return null;
    const hit = this._curves.get(def);
    if (hit) return hit;
    const pts = [];
    for (const p of def.path || []) {
      if (Array.isArray(p) && p.length >= 3) pts.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
    if (pts.length < 4) return null;
    const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
    this._curves.set(def, curve);
    return curve;
  }

  _trackLength(def) {
    const curve = this._trackCurve(def);
    if (!curve) return 0;
    try { return curve.getLength(); } catch (_) { return 0; }
  }

  /**
   * Draw a circuit from its definition alone — no built Track needed, which is
   * what lets the select screen show all five while only one is loaded.
   */
  _drawTrack(canvas, def, { simple }) {
    const g = canvas.getContext('2d');
    if (!g) return;
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);

    const curve = this._trackCurve(def);
    if (!curve) return;
    const n = simple ? 140 : 380;
    const pts = curve.getSpacedPoints(n);

    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const pad = simple ? 8 : 26;
    const k = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanZ);
    const ox = (W - spanX * k) * 0.5 - minX * k;
    const oy = (H - spanZ * k) * 0.5 - minZ * k;
    const X = (x) => x * k + ox;
    const Y = (z) => z * k + oy;

    let width = 26;
    if (Array.isArray(def.widthProfile) && def.widthProfile.length) {
      let sum = 0;
      for (const w of def.widthProfile) sum += Number(w.width) || 26;
      width = sum / def.widthProfile.length;
    }
    const roadPx = Math.max(simple ? 3 : 7, width * k);

    g.lineJoin = 'round';
    g.lineCap = 'round';

    const trace = () => {
      g.beginPath();
      g.moveTo(X(pts[0].x), Y(pts[0].z));
      for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i].x), Y(pts[i].z));
      g.closePath();
    };

    trace();
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.lineWidth = roadPx * 1.5;
    g.stroke();

    if (simple) {
      trace();
      g.strokeStyle = '#39415a';
      g.lineWidth = roadPx;
      g.stroke();
    } else {
      // Colour the ribbon by the surface actually laid on each span.
      const spans = Array.isArray(def.surfaceSpans) && def.surfaceSpans.length
        ? def.surfaceSpans
        : [{ from: 0, to: 1, surface: def.surface }];
      for (const span of spans) {
        const from = clamp(Number(span.from) || 0, 0, 1);
        const toRaw = Number(span.to);
        const to = Number.isFinite(toRaw) ? clamp(toRaw, 0, 1) : 1;
        const i0 = Math.floor(from * n);
        // A span that wraps past the start line is drawn straight through it;
        // the point indices are taken modulo the ring below.
        const i1 = Math.ceil((to > from ? to : to + 1) * n);
        g.beginPath();
        g.moveTo(X(pts[i0 % pts.length].x), Y(pts[i0 % pts.length].z));
        for (let i = i0 + 1; i <= i1; i++) {
          const p = pts[i % pts.length];
          g.lineTo(X(p.x), Y(p.z));
        }
        g.strokeStyle = SURFACE_COLOUR[span.surface] || SURFACE_FALLBACK;
        g.lineWidth = roadPx;
        g.stroke();
      }

      trace();
      g.setLineDash([7, 9]);
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.lineWidth = 1.5;
      g.stroke();
      g.setLineDash([]);

      // Hazards, on the line where they actually sit.
      for (const h of def.hazards || []) {
        const t = clamp(Number(h?.t) || 0, 0, 0.9999);
        const p = pts[Math.floor(t * n) % pts.length];
        g.beginPath();
        g.arc(X(p.x), Y(p.z), roadPx * 0.42, 0, Math.PI * 2);
        g.fillStyle = HAZARD_COLOUR[h.type] || '#ffffff';
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.65)';
        g.lineWidth = 2;
        g.stroke();
      }
    }

    // Start line, drawn across the road on the real tangent.
    const st = clamp(Number(def.startT) || 0, 0, 0.9999);
    const i = Math.floor(st * n) % pts.length;
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x;
    const dz = pts[j].z - pts[i].z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const half = roadPx * 0.62;
    g.beginPath();
    g.moveTo(X(pts[i].x) - nx * half, Y(pts[i].z) - nz * half);
    g.lineTo(X(pts[i].x) + nx * half, Y(pts[i].z) + nz * half);
    g.strokeStyle = '#ffffff';
    g.lineWidth = simple ? 2.5 : 4;
    g.stroke();
  }

  /* ---------------------------------------------------------------- options */

  _buildOptions(page) {
    const head = el('div', 'mn-head');
    head.append(el('div', 'mn-head-t', 'OPTIONS'), el('div', 'mn-head-s', 'Everything is live'));
    const right = el('div', 'mn-head-r');
    right.appendChild(el('div', 'mg-chip', (this.ctx?.settings?.quality || 'ultra').toUpperCase()));
    head.appendChild(right);
    page.appendChild(head);

    const body = el('div', 'mn-opt-body');
    const tabs = el('div', 'mn-tabs');
    const list = el('div', 'mn-opt-list');
    this.n.optList = list;

    const defs = this._tabs();
    for (const tab of defs) {
      const node = el('div', 'mn-tab', tab.label);
      if (tab.id === this.sel.tab) node.classList.add('is-on');
      node.addEventListener('click', () => { this._sfx('move'); this.sel.tab = tab.id; this._persist(); this._setPage('options', { silent: true }); });
      tabs.appendChild(node);
    }

    const active = defs.find((t) => t.id === this.sel.tab) || defs[0];
    this.sel.tab = active.id;
    this._rows = [];
    for (const row of active.rows) this._addRow(list, row);

    body.append(tabs, list);
    page.appendChild(body);
    page.appendChild(this._footer([
      ['↑↓', 'Row'], ['← →', 'Change'], ['TAB', 'Section'], ['ESC', 'Back'],
    ]));
  }

  _tabs() {
    const S = this.ctx?.settings;
    const set = (path, v) => {
      try { S?.set?.(path, v, this.ctx); S?.save?.(); } catch (err) { console.warn('[Menu] setting failed', path, err); }
      // Toggling a pass changes the shape of the chain, not just a uniform.
      if (path.startsWith('post.') && !path.startsWith('post.params')) {
        try { this.ctx?.postfx?.build?.(); } catch (err) { console.warn('[Menu] post rebuild failed', err); }
      }
      if (path === 'gameplay.uiScale') applyViewportVars(v);
    };
    const get = (path, fallback) => {
      const v = S?.get?.(path);
      return v === undefined ? fallback : v;
    };
    const num = (path, label, hint) => {
      const meta = S?.describe?.(path) || {};
      return {
        kind: 'slider', label, hint,
        min: meta.min ?? 0, max: meta.max ?? 1, step: meta.step ?? 0.01,
        get: () => Number(get(path, meta.min ?? 0)),
        set: (v) => set(path, v),
      };
    };
    const bool = (path, label, hint) => ({
      kind: 'toggle', label, hint,
      get: () => !!get(path, false),
      set: (v) => set(path, !!v),
    });

    return [
      {
        id: 'video', label: 'Video',
        rows: [
          {
            kind: 'seg', label: 'Quality preset',
            hint: 'Resets textures, shadows, particles and the post chain to that tier.',
            options: ['low', 'medium', 'high', 'ultra'],
            get: () => S?.quality || 'ultra',
            set: (v) => { try { S?.setQuality?.(v, this.ctx); this.ctx?.postfx?.build?.(); } catch (err) { console.warn('[Menu] tier change failed', err); } this._setPage('options', { silent: true }); },
          },
          num('render.renderScale', 'Render scale', 'Internal resolution multiplier.'),
          num('render.maxPixelRatio', 'Max pixel ratio', 'Ceiling applied to the display DPR.'),
          bool('render.shadows', 'Shadows'),
          { kind: 'seg', label: 'Shadow map', options: [512, 1024, 2048, 4096], get: () => get('render.shadowMapSize', 2048), set: (v) => set('render.shadowMapSize', v) },
          { kind: 'seg', label: 'Anisotropy', options: [1, 2, 4, 8, 16], get: () => get('render.anisotropy', 8), set: (v) => set('render.anisotropy', v) },
          bool('render.contactShadows', 'Contact shadows', 'A car without one looks like it is floating.'),
          num('render.exposure', 'Exposure'),
        ],
      },
      {
        id: 'post', label: 'Post FX',
        rows: [
          bool('post.enabled', 'Post processing'),
          bool('post.ssao', 'Ambient occlusion'),
          bool('post.bloom', 'Bloom', 'Keyed off speculars, not overall brightness.'),
          bool('post.tiltShift', 'Tilt-shift', 'The effect that sells the miniature scale.'),
          bool('post.motionBlur', 'Motion blur'),
          bool('post.grade', 'Colour grade'),
          bool('post.chromatic', 'Chromatic aberration'),
          bool('post.vignette', 'Vignette'),
          bool('post.grain', 'Film grain'),
          bool('post.crt', 'CRT grade', 'Scanlines and curvature, for the full arcade read.'),
          bool('post.smaa', 'SMAA'),
          num('post.params.tiltShiftAmount', 'Tilt-shift amount'),
          num('post.params.bloomStrength', 'Bloom strength'),
          num('post.params.grainAmount', 'Grain amount'),
          num('post.params.gradeSaturation', 'Saturation'),
        ],
      },
      {
        id: 'audio', label: 'Audio',
        rows: [
          bool('audio.muted', 'Mute everything'),
          num('audio.master', 'Master'),
          num('audio.music', 'Music'),
          num('audio.sfx', 'Effects'),
          num('audio.engine', 'Engine'),
          num('audio.ambience', 'Ambience'),
        ],
      },
      {
        id: 'game', label: 'Gameplay',
        rows: [
          num('gameplay.laps', 'Laps'),
          num('gameplay.aiDifficulty', 'AI difficulty'),
          bool('gameplay.assists', 'Driving assists'),
          bool('gameplay.damage', 'Damage'),
          num('gameplay.cameraShake', 'Camera shake'),
          num('gameplay.uiScale', 'Interface scale'),
          {
            kind: 'seg', label: 'Speed units', options: ['kmh', 'mph'],
            hint: 'Scale speed: what a 1:64 car would be doing at full size.',
            get: () => this.prefs.units,
            set: (v) => { this.prefs.units = v; this._savePrefs(); this._refreshGarage(); },
          },
          {
            kind: 'toggle', label: 'Minimap',
            get: () => this.prefs.minimap,
            set: (v) => { this.prefs.minimap = !!v; this._savePrefs(); },
          },
          {
            kind: 'toggle', label: 'Event feed',
            get: () => this.prefs.toasts,
            set: (v) => { this.prefs.toasts = !!v; this._savePrefs(); },
          },
          {
            kind: 'action', label: 'Clear lap records', hint: 'Deletes every stored best lap and best race.',
            run: () => { this.ctx?.race?.clearRecords?.(); this._flash('Records cleared'); },
          },
          {
            kind: 'action', label: 'Restore defaults', hint: 'Back to the shipped settings at the current tier.',
            run: () => { try { this.ctx?.settings?.reset?.(this.ctx); this.ctx?.postfx?.build?.(); } catch (_) { /* ignore */ } this._setPage('options', { silent: true }); this._flash('Defaults restored'); },
          },
        ],
      },
      { id: 'controls', label: 'Controls', rows: this._controlRows() },
    ];
  }

  _controlRows() {
    const input = this.ctx?.input;
    const labels = {
      throttle: 'Accelerate', brake: 'Brake / reverse', steerLeft: 'Steer left',
      steerRight: 'Steer right', handbrake: 'Handbrake', boost: 'Boost',
      lookBack: 'Look back', respawn: 'Respawn', pause: 'Pause', photo: 'Photo mode',
      camera: 'Change camera', restart: 'Restart race', accept: 'Confirm', back: 'Back',
    };
    const actions = input?.bindings?.keys ? Object.keys(input.bindings.keys) : Object.keys(labels);
    const rows = actions.map((action) => ({
      kind: 'bind', label: labels[action] || titleCase(action), action,
      get: () => {
        try { return input?.glyphs?.(action) || '—'; } catch (_) { return '—'; }
      },
      run: () => {
        if (!input?.beginRebind) return;
        this.listening = true;
        this._refreshRows();
        input.beginRebind(action, 0, 'key');
      },
    }));
    rows.push({
      kind: 'action', label: 'Reset bindings', hint: 'Back to WASD, space, shift.',
      run: () => { this.ctx?.input?.resetBindings?.(); this._refreshRows(); this._flash('Bindings reset'); },
    });
    return rows;
  }

  _addRow(list, def) {
    const row = el('div', 'mn-row');
    const left = el('div');
    left.appendChild(el('div', 'mn-row-name', def.label));
    if (def.hint) left.appendChild(el('div', 'mn-row-hint', def.hint));
    const val = el('div', 'mn-val');

    const item = { el: row, def, nodes: {} };

    switch (def.kind) {
      case 'toggle': {
        const t = el('div', 'mn-toggle');
        t.appendChild(el('i'));
        val.appendChild(t);
        item.nodes.toggle = t;
        item.activate = () => { def.set(!def.get()); this._refreshRow(item); };
        item.delta = () => item.activate();
        break;
      }
      case 'slider': {
        const caretL = el('div', 'mn-caret', '‹');
        const s = el('div', 'mn-slider');
        s.append(el('i'), el('b'));
        const text = el('div', 'mn-val-t', '');
        const caretR = el('div', 'mn-caret', '›');
        val.append(caretL, s, text, caretR);
        item.nodes.slider = s;
        item.nodes.text = text;
        item.delta = (dir) => {
          const step = def.step || 0.01;
          const v = clamp(def.get() + dir * step, def.min, def.max);
          // Snap to the step grid so 0.30000000000000004 can never be shown.
          const snapped = Math.round(v / step) * step;
          def.set(Number(snapped.toFixed(6)));
          this._refreshRow(item);
        };
        item.activate = () => item.delta(1);
        break;
      }
      case 'seg': {
        const seg = el('div', 'mn-seg');
        for (const opt of def.options) seg.appendChild(el('span', null, String(opt).toUpperCase()));
        val.appendChild(seg);
        item.nodes.seg = seg;
        item.delta = (dir) => {
          const opts = def.options;
          const i = Math.max(0, opts.findIndex((o) => String(o) === String(def.get())));
          def.set(opts[(i + dir + opts.length) % opts.length]);
          this._refreshRow(item);
        };
        item.activate = () => item.delta(1);
        break;
      }
      case 'bind': {
        const key = el('div', 'mn-bindkey', '—');
        val.appendChild(key);
        item.nodes.key = key;
        item.activate = () => def.run();
        break;
      }
      case 'action':
      default: {
        const caret = el('div', 'mn-caret', '›');
        val.append(el('div', 'mn-val-t', 'RUN'), caret);
        item.activate = () => def.run();
        break;
      }
    }

    row.append(left, val);
    row.addEventListener('click', () => {
      const i = this.items.indexOf(item);
      if (i >= 0) { this.focus = i; this._syncFocus(); }
      this._sfx('confirm');
      item.activate?.();
    });
    row.addEventListener('pointerenter', () => this._setFocus(this.items.indexOf(item)));
    list.appendChild(row);
    this.items.push(item);
    this._rows.push(item);
    this._refreshRow(item);
    return item;
  }

  _refreshRow(item) {
    const def = item.def;
    if (!def) return;
    switch (def.kind) {
      case 'toggle':
        item.nodes.toggle?.classList.toggle('is-on', !!def.get());
        break;
      case 'slider': {
        const v = Number(def.get());
        const f = (v - def.min) / Math.max(1e-6, def.max - def.min);
        item.nodes.slider?.style.setProperty('--v', clamp(f, 0, 1).toFixed(4));
        const decimals = def.step >= 1 ? 0 : def.step >= 0.1 ? 1 : def.step >= 0.01 ? 2 : 4;
        if (item.nodes.text) item.nodes.text.textContent = v.toFixed(decimals);
        break;
      }
      case 'seg': {
        const cur = String(def.get());
        const kids = item.nodes.seg?.children || [];
        for (let i = 0; i < kids.length; i++) {
          kids[i].classList.toggle('is-on', String(def.options[i]) === cur);
        }
        break;
      }
      case 'bind':
        if (item.nodes.key) item.nodes.key.textContent = def.get();
        item.el.classList.toggle('is-listening', this.listening && this.items[this.focus] === item);
        break;
      default: break;
    }
  }

  _refreshRows() {
    for (const item of this._rows || []) this._refreshRow(item);
  }

  /* ------------------------------------------------------------------ pause */

  _buildPause(page) {
    const card = el('div', 'mg-plate mg-plate--lg mn-pause-card');
    const head = el('div', 'mn-head');
    head.append(el('div', 'mn-head-t', 'PAUSED'), el('div', 'mn-head-s', this.ctx?.track?.title || ''));
    card.appendChild(head);

    const nav = el('div', 'mn-nav');
    nav.append(
      this._button('Resume', () => this._resume(), 'ESC'),
      this._button('Restart race', () => { this._resume(); this.ctx?.race?.start?.({ skipCountdown: false }); }, 'R'),
      this._button('Options', () => { this.returnPage = 'pause'; this._setPage('options'); }, 'O'),
      this._button('Quit to title', () => { this._resume(); this.ctx?.race?.reset?.(); this.show('title'); }, ''),
    );
    card.appendChild(nav);
    page.appendChild(card);
  }

  _resume() {
    this.hide();
    try { this.ctx?.race?.resume?.(); } catch (_) { /* stub race */ }
  }

  /* ------------------------------------------------------------- primitives */

  _button(label, onActivate, note) {
    const b = el('button', 'mg-btn');
    b.type = 'button';
    b.appendChild(el('span', null, label.toUpperCase()));
    if (note) b.appendChild(el('span', 'mg-btn-key', String(note).toUpperCase()));
    const item = { el: b, activate: onActivate };
    this.items.push(item);
    b.addEventListener('click', () => {
      const i = this.items.indexOf(item);
      if (i >= 0) { this.focus = i; this._syncFocus(); }
      this._sfx('confirm');
      onActivate();
    });
    b.addEventListener('pointerenter', () => this._setFocus(this.items.indexOf(item)));
    return b;
  }

  _footer(hints) {
    const foot = el('div', 'mn-foot');
    const wrap = el('div', 'mn-hints');
    for (const [key, label] of hints) {
      const hint = el('div', 'mn-hint');
      hint.append(el('span', 'mn-key', key), document.createTextNode(label));
      wrap.appendChild(hint);
    }
    foot.appendChild(wrap);
    foot.appendChild(el('div', 'mn-build', 'MICRO GAUNTLET · r180'));
    return foot;
  }

  _flash(text) {
    if (!this.pageNode) return;
    const node = el('div', 'mn-flash', text.toUpperCase());
    this.pageNode.appendChild(node);
    this._after(1800, () => node.remove());
  }

  _time(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--.---';
    const ms = Math.floor((seconds % 1) * 1000);
    const total = Math.floor(seconds);
    const s = total % 60;
    const m = Math.floor(total / 60);
    const mm = String(ms).padStart(3, '0');
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${mm}` : `${s}.${mm}`;
  }

  /* ================================================================ showroom */

  _enterShowroom() {
    const scene = this.ctx?.scene;
    const camera = this.ctx?.camera;
    if (!scene || !camera) return;
    try {
      if (!this.stage) this._buildStage();
      if (!this.stage) return;
      if (this.stage.group.parent !== scene) scene.add(this.stage.group);
      this.stage.group.visible = true;
      this.stageActive = true;

      this._camSaved = { fov: camera.fov, near: camera.near, far: camera.far };
      camera.fov = 30;
      camera.updateProjectionMatrix();

      // Take the camera cleanly. Disabling the Director rather than putting it
      // in 'free' matters: 'free' still resets the tilt-shift band to track the
      // player every frame, and the player is nine hundred units below us.
      const d = this.ctx?.director;
      if (d) d.enabled = false;
      this.ctx?.postfx?.setFocusBand?.(0.54, 0.30, 1.5);

      this._loadPreview();
    } catch (err) {
      console.warn('[Menu] showroom unavailable; falling back to the drawn card', err);
      this.stageActive = false;
      this._renderFallbackCar(this._carEntry()?.def);
    }
  }

  _leaveShowroom() {
    if (!this.stageActive) return;
    this.stageActive = false;
    if (this.stage?.group) this.stage.group.visible = false;
    if (this.stage?.group?.parent) this.stage.group.parent.remove(this.stage.group);

    const camera = this.ctx?.camera;
    if (camera && this._camSaved) {
      camera.fov = this._camSaved.fov;
      camera.near = this._camSaved.near;
      camera.far = this._camSaved.far;
      camera.updateProjectionMatrix();
      this._camSaved = null;
    }
    this.ctx?.postfx?.setFocusBand?.(null);

    // Hand the camera back and make it cut rather than sweep across nine
    // hundred units of empty air. setMode is a no-op when the mode is already
    // the target, so bounce through 'free' to guarantee the snap takes.
    const race = this.ctx?.race;
    const mode = race && (race.state === 'racing' || race.state === 'finished') ? 'race' : 'intro';
    const d = this.ctx?.director;
    if (d) {
      d.enabled = true;
      try {
        d.setMode?.('free');
        d.setMode?.(mode, { snap: true });
      } catch (err) {
        console.warn('[Menu] could not hand the camera back', err);
      }
    }
  }

  _buildStage() {
    const group = new THREE.Group();
    group.name = 'menu:showroom';
    group.position.set(0, SHOWROOM_Y, 0);

    const { map, rough } = plinthTextures(512);
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 17.2, 1.2, 72, 1, false),
      new THREE.MeshStandardMaterial({
        map, roughnessMap: rough, color: 0xffffff, metalness: 0.55, roughness: 1, envMapIntensity: 0.9,
      })
    );
    plinth.position.y = -0.6;
    plinth.receiveShadow = true;
    group.add(plinth);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(STAGE_RADIUS - 0.2, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0a0c11, roughness: 0.86, metalness: 0.1 })
    );
    floor.position.y = -1.2;
    floor.receiveShadow = true;
    group.add(floor);

    const cyc = new THREE.Mesh(
      new THREE.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS, 64, 48, 1, true),
      new THREE.MeshStandardMaterial({
        map: backdropTexture(), side: THREE.BackSide, roughness: 0.95, metalness: 0,
      })
    );
    cyc.position.y = 22;
    group.add(cyc);

    // Studio rig: warm key from front-left, cool fill from the right, cold rim
    // from behind. Three directionals are predictable at any scale, which point
    // lights at centimetre units emphatically are not.
    const key = new THREE.DirectionalLight(0xfff0dc, 3.4);
    key.position.set(-16, 20, 18);
    key.target.position.set(0, 1.4, 0);
    // Deliberately not a shadow caster. render/Lighting already runs three
    // cascades; a fourth shadowing directional risks blowing the uniform budget
    // on weak parts, and a failed link is a black screen. The grounding comes
    // from VehicleVisual's own contact shadow, which builds here precisely
    // because the preview context reports no lighting system.
    key.castShadow = false;
    group.add(key, key.target);

    const fill = new THREE.DirectionalLight(0x9fc6ff, 1.05);
    fill.position.set(22, 10, 8);
    fill.target.position.set(0, 1.2, 0);
    group.add(fill, fill.target);

    const rim = new THREE.DirectionalLight(0xffb27a, 2.1);
    rim.position.set(6, 9, -24);
    rim.target.position.set(0, 1.6, 0);
    group.add(rim, rim.target);

    const carPivot = new THREE.Group();
    carPivot.name = 'menu:turntable';
    group.add(carPivot);

    group.visible = false;
    this.stage = { group, carPivot, plinth, floor, cyc, key, fill, rim, visual: null, fake: null, ctx: null };
    return this.stage;
  }

  /**
   * A minimal object with exactly the surface VehicleVisual reads. Every number
   * comes from the model definition, so the wheels sit at their real rest
   * height and the exposed suspension solves correctly.
   */
  _makeFakeVehicle(def) {
    const p = def?.physics || {};
    const R = p.wheelRadius ?? 1.15;
    const cg = p.cgHeight ?? 1.25;
    const wb = p.wheelbase ?? 5.6;
    const bias = p.cgBias ?? 0.5;
    const half = (p.trackWidth ?? 3.6) * 0.5;
    const susp = p.suspRest ?? 1.3;
    const zf = wb * (1 - bias);
    const zr = -wb * bias;
    const wheels = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const left = (i & 1) === 0;
      wheels.push({
        localX: left ? half : -half,
        localY: R - cg,
        localZ: front ? zf : zr,
        compression: susp,          // travel 0 => the hub sits exactly at rest
        steerAngle: front ? 0.16 : 0,
        omega: 0,
        radius: R,
      });
    }
    return {
      isPlayer: false,
      wheels,
      tuning: {
        suspRest: susp, wheelRadius: R, cgHeight: cg,
        brakeBias: p.brakeBias ?? 0.62, redlineRpm: p.redlineRpm ?? 7500,
      },
      position: new THREE.Vector3(0, cg, 0),
      quaternion: new THREE.Quaternion(),
      brake: 0, brakeLight: 0, reverseLight: 0,
      longitudinalG: 0, lateralG: 0,
      scuff: 0, damage: 0, dirt: 0,
      speed: 0,
    };
  }

  async _loadPreview() {
    if (!this.stageActive || !this.stage) return;
    const mod = this.ctx?.vehicleVisualMod;
    const Ctor = mod?.VehicleVisual || (typeof mod?.default === 'function' ? mod.default : null);
    if (!Ctor) { this._renderFallbackCar(this._carEntry()?.def); return; }

    const token = ++this._previewToken;
    const entry = this._carEntry();
    const def = entry?.def || {};
    const fake = this._makeFakeVehicle(def);

    // A private view of the context: the visual must dress *our* set, not the
    // live scene, and it must build its own grounding shadow rather than defer
    // to render/Lighting's instanced blobs, which only cover the playfield.
    const previewCtx = {
      ...this.ctx,
      scene: this.stage.group,
      lighting: null,
      track: null,
      player: null,
      vehicles: [],
    };

    let visual = null;
    try {
      visual = new Ctor(previewCtx, fake, { model: entry?.id, livery: this.sel.livery, isPlayer: false });
      await visual.init(previewCtx, fake);
    } catch (err) {
      console.warn('[Menu] car preview failed to build', err);
      try { visual?.dispose?.(); } catch (_) { /* ignore */ }
      this._renderFallbackCar(def);
      return;
    }

    if (token !== this._previewToken || !this.stageActive) {
      try { visual.dispose?.(); } catch (_) { /* ignore */ }
      return;
    }

    this._disposePreview();
    visual.attach(this.stage.carPivot);
    this.stage.visual = visual;
    this.stage.fake = fake;
    this.stage.ctx = previewCtx;
    // One update seats the wheels, the linkage and the body attitude; without
    // it every wheel would be sitting at the origin.
    try {
      visual.update(1 / 60, previewCtx, fake);
      visual.lateUpdate?.(1 / 60, previewCtx, fake);
    } catch (err) {
      console.warn('[Menu] car preview failed to pose', err);
    }
    this.n.stageFallback?.classList.add('mg-hidden');
  }

  _disposePreview() {
    const s = this.stage;
    if (!s?.visual) return;
    try { s.visual.dispose(); } catch (_) { /* ignore */ }
    s.visual = null;
    s.fake = null;
    s.ctx = null;
  }

  /* ==================================================================== loop */

  update(dt) {
    if (this._disposed || !this.visible) return;
    if (this.ctx?.results?.visible) return;      // results owns the input focus
    this._pollPad(dt);
  }

  lateUpdate(dt) {
    if (this._disposed || !this.stageActive || !this.stage) return;
    const camera = this.ctx?.camera;
    if (!camera) return;
    const d = clamp(dt || 0, 0, 0.05);

    this._spin = (this._spin + d * TURNTABLE_RATE) % (Math.PI * 2);
    this.stage.carPivot.rotation.y = this._spin;

    const s = this.stage;
    if (s.visual && s.fake && s.ctx) {
      try {
        s.visual.update(d, s.ctx, s.fake);
        s.visual.lateUpdate?.(d, s.ctx, s.fake);
      } catch (err) {
        console.warn('[Menu] preview update failed; detaching', err);
        this._disposePreview();
      }
    }

    // Fixed hero pose. The car turns, the camera does not — which is what makes
    // the key light sweep the bodywork instead of sliding with it.
    const az = 0.62;
    camera.position.set(
      Math.sin(az) * CAM_DIST,
      SHOWROOM_Y + CAM_HEIGHT,
      Math.cos(az) * CAM_DIST
    );
    camera.lookAt(0, SHOWROOM_Y + CAM_LOOK_Y, 0);
    // Slide the car off centre so it sits under the stage frame rather than
    // behind the spec sheet. Translating after the aim keeps the pose square.
    const halfW = CAM_DIST * Math.tan((camera.fov * Math.PI) / 360) * (camera.aspect || 1.78);
    camera.translateX(halfW * CAM_SHIFT);
    camera.updateMatrixWorld();
  }

  /* ============================================================ navigation */

  _setFocus(i) {
    if (i < 0 || i >= this.items.length || i === this.focus) return;
    this.focus = i;
    this._syncFocus();
    this._sfx('move');
  }

  _syncFocus() {
    if (this.focus >= this.items.length) this.focus = Math.max(0, this.items.length - 1);
    for (let i = 0; i < this.items.length; i++) {
      this.items[i].el.classList.toggle('is-focused', i === this.focus);
    }
    const item = this.items[this.focus];
    if (!item) return;
    if (item.def?.kind === 'bind') this._refreshRow(item);
    if (item.focus) item.focus();
    if (item.el.parentElement === this.n.optList) item.el.scrollIntoView({ block: 'nearest' });
  }

  _move(delta) {
    const n = this.items.length;
    if (!n) return;
    let i = this.focus;
    i = (i + delta + n) % n;
    this.focus = i;
    this._syncFocus();
    this._sfx('move');
  }

  _delta(dir) {
    const item = this.items[this.focus];
    if (item?.delta) { item.delta(dir); this._sfx('move'); return true; }
    return false;
  }

  _activate() {
    const item = this.items[this.focus];
    if (!item?.activate) return;
    this._sfx('confirm');
    item.activate();
  }

  _back() {
    this._sfx('back');
    switch (this.page) {
      case 'garage':
      case 'circuits':
        this._setPage('title');
        break;
      case 'options':
        this._setPage(this.returnPage === 'pause' ? 'pause' : 'title');
        break;
      case 'pause':
        this._resume();
        break;
      default:
        break;
    }
  }

  _onKeyDown(e) {
    if (!this.visible || this._disposed) return;
    // A rebind in progress belongs to Input.js; do not eat its keystroke.
    if (this.listening) return;
    if (this.ctx?.results?.visible) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const stop = () => { e.preventDefault(); e.stopPropagation(); };

    switch (e.code) {
      case 'ArrowUp': case 'KeyW': stop(); this._move(-1); return;
      case 'ArrowDown': case 'KeyS': stop(); this._move(1); return;
      case 'ArrowLeft': case 'KeyA':
        stop();
        if (!this._delta(-1) && this.page === 'garage') this._cycleCar(-1);
        return;
      case 'ArrowRight': case 'KeyD':
        stop();
        if (!this._delta(1) && this.page === 'garage') this._cycleCar(1);
        return;
      case 'Enter': case 'NumpadEnter': case 'Space': stop(); this._activate(); return;
      case 'Escape': case 'Backspace': stop(); this._back(); return;
      case 'Tab':
        if (this.page === 'options') {
          stop();
          const tabs = this._tabs();
          const i = Math.max(0, tabs.findIndex((t) => t.id === this.sel.tab));
          this.sel.tab = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id;
          this._persist();
          this._setPage('options', { silent: true });
        }
        return;
      case 'KeyO':
        if (this.page === 'title' || this.page === 'pause') {
          stop();
          this.returnPage = this.page;
          this._setPage('options');
        }
        return;
      case 'KeyR':
        if (this.page === 'pause') { stop(); this._resume(); this.ctx?.race?.start?.({ skipCountdown: false }); }
        return;
      default: break;
    }

    if (this.page === 'garage' && /^Digit[1-5]$/.test(e.code)) {
      stop();
      this._setLivery(Number(e.code.slice(5)) - 1);
    }
  }

  /** Standard-mapping poll with a hold-to-repeat, independent of Input.js. */
  _pollPad(dt) {
    let pads = [];
    try { pads = globalThis.navigator?.getGamepads?.() || []; } catch (_) { return; }
    let pad = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) { pad = pads[i]; break; }
    if (!pad) return;

    const prev = this._pad.buttons;
    const down = (i) => !!pad.buttons[i]?.pressed;
    const edge = (i) => down(i) && !prev[i];

    // First poll only samples: a button already held when the menu opened must
    // not read as a fresh press and fire the row under the cursor.
    if (!this._pad.primed) {
      this._pad.primed = true;
      for (let i = 0; i < 17; i++) prev[i] = down(i);
      this._pad.ax = pad.axes?.[0] || 0;
      this._pad.ay = pad.axes?.[1] || 0;
      return;
    }

    if (edge(0)) this._activate();
    else if (edge(1)) this._back();
    else if (edge(12)) this._move(-1);
    else if (edge(13)) this._move(1);
    else if (edge(14)) { if (!this._delta(-1) && this.page === 'garage') this._cycleCar(-1); }
    else if (edge(15)) { if (!this._delta(1) && this.page === 'garage') this._cycleCar(1); }
    else if (edge(4)) this._delta(-1);
    else if (edge(5)) this._delta(1);
    else {
      const ax = pad.axes?.[0] || 0;
      const ay = pad.axes?.[1] || 0;
      const armedY = Math.abs(ay) > 0.6;
      const armedX = Math.abs(ax) > 0.6;
      if (armedY && Math.abs(this._pad.ay) <= 0.6) this._move(ay > 0 ? 1 : -1);
      else if (armedX && Math.abs(this._pad.ax) <= 0.6) {
        if (!this._delta(ax > 0 ? 1 : -1) && this.page === 'garage') this._cycleCar(ax > 0 ? 1 : -1);
      } else if (armedY || armedX) {
        // Hold to repeat, after a comfortable initial delay.
        this._pad.repeat += dt;
        if (this._pad.repeat > 0.42) {
          this._pad.repeat = 0.30;
          if (armedY) this._move(ay > 0 ? 1 : -1);
          else if (!this._delta(ax > 0 ? 1 : -1) && this.page === 'garage') this._cycleCar(ax > 0 ? 1 : -1);
        }
      } else {
        this._pad.repeat = 0;
      }
      this._pad.ax = ax;
      this._pad.ay = ay;
    }
    for (let i = 0; i < 17; i++) prev[i] = down(i);
  }

  /* ================================================================ actions */

  _startRace() {
    this._persist();
    const wantTrack = this.sel.trackId;
    const currentTrack = this.ctx?.track?.id;

    if (wantTrack && currentTrack && wantTrack !== currentTrack) {
      globalThis.location.href = this._buildUrl();
      return;
    }
    // The car and livery are already in the URL for the next boot; changing them
    // mid-session would need main.js to rebuild the grid.
    this._syncUrl();
    this.hide();
    try { this.ctx?.race?.start?.({ skipCountdown: false }); }
    catch (err) { console.warn('[Menu] could not start the race', err); }
  }

  _startChampionship() {
    const race = this.ctx?.race;
    let first = null;
    try {
      const champ = race?.startChampionship?.();
      first = champ?.order?.[0] || null;
    } catch (err) {
      console.warn('[Menu] could not open a championship', err);
    }
    if (first) this.sel.trackId = first;
    this._startRace();
  }

  _buildUrl() {
    const params = new URLSearchParams(globalThis.location?.search || '');
    params.set('track', this.sel.trackId);
    params.set('car', this.sel.carId);
    params.set('livery', String(this.sel.livery));
    params.set('skipmenu', '1');
    return `${globalThis.location?.pathname || './'}?${params.toString()}`;
  }

  /** Keep the address bar honest without reloading. */
  _syncUrl() {
    try {
      const params = new URLSearchParams(globalThis.location.search);
      params.set('car', this.sel.carId);
      params.set('livery', String(this.sel.livery));
      globalThis.history?.replaceState?.(null, '', `${globalThis.location.pathname}?${params.toString()}`);
    } catch (_) { /* file:// or a sandbox without history */ }
  }

  _persist() { writeJson(GARAGE_KEY, this.sel); }

  _savePrefs() {
    writeJson(PREFS_KEY, this.prefs);
    this.ctx?.bus?.emit?.('ui:prefs', { ...this.prefs });
  }

  _sfx(kind) {
    const audio = this.ctx?.audio;
    try {
      if (audio?.ui) audio.ui(kind);
      else audio?.play?.(`ui.${kind}`);
    } catch (_) { /* audio is a nicety */ }
    this.ctx?.bus?.emit?.('ui:select', { kind, screen: this.page });
  }

  _after(ms, fn) {
    const id = setTimeout(() => { this._timers.delete(id); if (!this._disposed) fn(); }, ms);
    this._timers.add(id);
    return id;
  }

  applySettings(settings) {
    applyViewportVars((settings || this.ctx?.settings)?.gameplay?.uiScale ?? 1);
    return this;
  }

  onResize() {
    applyViewportVars(this.ctx?.settings?.gameplay?.uiScale ?? 1);
    if (this.page === 'circuits') this._previewTrack(this.sel.trackId);
    return this;
  }

  snapshot() {
    return {
      visible: this.visible,
      page: this.page,
      car: this.sel.carId,
      livery: this.sel.livery,
      track: this.sel.trackId,
      showroom: this.stageActive,
    };
  }

  dispose() {
    // Give the camera back before anything else: a disposed Menu must not leave
    // the Director switched off.
    this._leaveShowroom();
    this._disposed = true;
    globalThis.removeEventListener('keydown', this._onKeyDown, true);
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    this._disposePreview();
    const s = this.stage;
    if (s) {
      s.group.parent?.remove(s.group);
      s.plinth.geometry.dispose();
      s.plinth.material.map?.dispose();
      s.plinth.material.roughnessMap?.dispose();
      s.plinth.material.dispose();
      s.floor.geometry.dispose();
      s.floor.material.dispose();
      s.cyc.geometry.dispose();
      s.cyc.material.map?.dispose();
      s.cyc.material.dispose();
      this.stage = null;
    }
    this.root?.remove();
    this.root = null;
    return this;
  }
}

/* ------------------------------------------------------------------ statics */

function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * v);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

export function makeMenu(ctx) { return new Menu(ctx); }

export default Menu;
