// ui/HUD.js — everything the driver reads without taking their eyes off the car.
//
// DOM inside #ui-root, styled entirely by src/ui/style.css. No canvas except the
// minimap, where per-frame car dots make 2D the right tool.
//
// Three decisions worth knowing before changing anything here:
//
// * THE CENTRE OF FRAME IS SACRED. Every persistent element lives in a corner
//   cluster that scales from the corner it hugs (transform-origin), so the HUD
//   keeps its proportions from 720p to 4K without a media query and never grows
//   inward. The only things allowed in the middle are the countdown and the
//   chequered flag, both of which are gone inside a second.
//
// * THE DELTA IS REAL. It is not lapTime-minus-bestLap scaled by progress. HUD
//   records the time-into-lap at every checkpoint Race validates, promotes that
//   row to the reference whenever a personal best is set, and reports
//   now-minus-reference at the gate just passed. That is what a timing screen
//   does, and it is the difference between a number that means something and a
//   number that jitters.
//
// * NOTHING IS WRITTEN THAT HAS NOT CHANGED. Text nodes, classes and custom
//   properties are all diffed against a cached previous value. A racing HUD
//   updates six strings a frame, not sixty.
//
// No imports. HUD has to survive every peer being a stub — including Race.

const PREFS_KEY = 'microgauntlet.ui.v1';

/* Scale speed for display. One unit is a centimetre and the cars are 1:64
   die-cast, so a car doing 100 u/s is a full-size car doing 64 m/s. The
   speedometer reads that scale speed, which is the only number that means
   anything to a human. */
const UNIT = {
  kmh: { factor: 0.01 * 64 * 3.6, label: 'KM/H', step: 40 },
  mph: { factor: 0.01 * 64 * 2.236936, label: 'MPH', step: 20 },
};

const TOAST_LIFE = 3200;
const TOAST_MAX = 4;
const MAP_SAMPLES = 240;

/* Fallback dot colours, used only when a car has no livery to read. Chosen to
   stay separable at 7 px on a dark map. */
const FALLBACK_COLOURS = [
  '#ff5a3c', '#35e0ff', '#ffc93c', '#38dd82', '#a06bff',
  '#ff7ab8', '#7ee081', '#f2f4f8', '#ff9a3c', '#5b8cff',
  '#c8f24a', '#ff4d6d',
];

/* ------------------------------------------------------------------ helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function saturate(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** m:ss.mmm, or s.mmm under a minute — the same shape Race prints. */
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--.---';
  const ms = Math.floor((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60);
  const mm = String(ms).padStart(3, '0');
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}.${mm}`;
  return `${s}.${mm}`;
}

function formatDelta(seconds) {
  if (!Number.isFinite(seconds)) return '—.———';
  const sign = seconds >= 0 ? '+' : '-';
  const a = Math.abs(seconds);
  return sign + (a >= 60 ? formatTime(a) : a.toFixed(3));
}

function ordinalSuffix(n) {
  const i = Math.round(n);
  const mod100 = i % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'TH';
  switch (i % 10) {
    case 1: return 'ST';
    case 2: return 'ND';
    case 3: return 'RD';
    default: return 'TH';
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function hexOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return '#' + (value >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  }
  if (typeof value === 'string' && value) return value;
  return fallback;
}

function readPrefs() {
  const out = { units: 'kmh', minimap: true, toasts: true };
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!raw) return out;
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      if (data.units === 'kmh' || data.units === 'mph') out.units = data.units;
      if (typeof data.minimap === 'boolean') out.minimap = data.minimap;
      if (typeof data.toasts === 'boolean') out.toasts = data.toasts;
    }
  } catch (_) { /* private mode, or a hand-edited blob */ }
  return out;
}

/** One shared viewport factor for HUD, Menu and Results. Idempotent. */
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
  return vp;
}

/* ==========================================================================
 * Speedometer face
 * ========================================================================== */

const DIAL = {
  cx: 100, cy: 106, r: 82, rTick: 82, rTickIn: 70, rNum: 58,
  start: 148, sweep: 244,
};

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [DIAL.cx + r * Math.cos(a), DIAL.cy + r * Math.sin(a)];
}

/** Length of a full-sweep arc. Computed rather than measured: getTotalLength()
 *  is unreliable on an SVG element that is not yet in the document, and the
 *  dial is assembled before it is mounted. */
function arcLength(radius) {
  return (radius * DIAL.sweep * Math.PI) / 180;
}

/** Arc path from fraction a to fraction b of the dial sweep. */
function arcPath(radius, a, b) {
  const a0 = DIAL.start + DIAL.sweep * a;
  const a1 = DIAL.start + DIAL.sweep * b;
  const [x0, y0] = polar(radius, a0);
  const [x1, y1] = polar(radius, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/* ==========================================================================
 * HUD
 * ========================================================================== */

export class HUD {
  name = 'hud';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.root = null;
    this.visible = true;
    this.forcedHidden = false;

    this.prefs = readPrefs();
    this.unit = UNIT[this.prefs.units] || UNIT.kmh;

    /* --- cached DOM ------------------------------------------------------ */
    this.n = {};                 // named nodes
    this.cache = {};             // last written values, keyed by node name

    /* --- speedometer state ---------------------------------------------- */
    this.dialMax = 260;
    this._needle = 0;            // damped 0..1 of dial sweep
    this._revNeedle = 0;
    this._valLen = 1;
    this._rpmLen = 1;

    /* --- minimap --------------------------------------------------------- */
    this.map = null;             // { baked, g, W, H, toX, toY, dpr, scale }
    this._mapDirty = true;
    this._colours = new WeakMap();

    /* --- live timing ----------------------------------------------------- */
    this.splits = [];            // time into the current lap at each gate
    this.refSplits = null;       // the same row from the best lap so far
    this.delta = NaN;
    this.deltaAge = 99;
    this._lastGate = -1;

    /* --- transient ------------------------------------------------------- */
    this._toasts = [];
    this._timers = new Set();
    this._offBus = [];
    this._lastGear = '';
    this._shiftAge = 9;
    this._wrongWay = false;
    this._boostWasLive = false;
    this._raceState = '';
    this._uiScale = ctx?.settings?.gameplay?.uiScale ?? 1;
    this._disposed = false;
  }

  /* ==================================================================== init */

  async init() {
    const host = document.getElementById('ui-root');
    if (!host) {
      console.warn('[HUD] #ui-root is missing; the HUD cannot mount');
      return this;
    }

    applyViewportVars(this.ctx?.settings?.gameplay?.uiScale ?? 1);

    this.root = el('div');
    this.root.id = 'mg-hud';
    this.root.className = 'is-out';

    this._buildTopLeft();
    this._buildTopRight();
    this._buildTopCentre();
    this._buildBottomLeft();
    this._buildBottomRight();
    this._buildBottomCentre();
    this._buildCentre();

    host.appendChild(this.root);

    this._bakeMinimap();
    this._subscribe();
    this._syncVisibility();

    // A console handle for driving HUD states without playing a race.
    const MG = (globalThis.MG = globalThis.MG || {});
    MG.ui = MG.ui || {};
    MG.ui.hud = this;

    return this;
  }

  /* ------------------------------------------------------------ DOM: build */

  _buildTopLeft() {
    const c = el('div', 'hud-c hud-c--tl');

    const pos = el('div', 'hud-pos');
    this.n.posNum = el('span', 'hud-pos-num', '—');
    this.n.posOrd = el('span', 'hud-pos-ord', '');
    this.n.posOf = el('span', 'hud-pos-of', '');
    pos.append(this.n.posNum, this.n.posOrd, this.n.posOf);

    const lap = el('div', 'hud-lap');
    this.n.lapBlock = lap;
    lap.append(
      el('span', 'hud-lap-word', 'LAP'),
      (this.n.lapVal = el('span', 'hud-lap-val', '1')),
      (this.n.lapTot = el('span', 'hud-lap-tot', '/3'))
    );

    this.n.feed = el('div', 'hud-feed');

    c.append(pos, lap, this.n.feed);
    this.root.appendChild(c);
  }

  _buildTopRight() {
    const c = el('div', 'hud-c hud-c--tr');

    this.n.timeNow = el('div', 'hud-time-now mg-num', '0.000');

    const bestRow = el('div', 'hud-time-row');
    bestRow.append(el('span', 'mg-label', 'Best'), (this.n.timeBest = el('span', 'hud-time-val', '--.---')));

    const lastRow = el('div', 'hud-time-row');
    lastRow.append(el('span', 'mg-label', 'Last'), (this.n.timeLast = el('span', 'hud-time-val', '--.---')));

    this.n.delta = el('div', 'hud-delta mg-num', '—.———');

    c.append(this.n.timeNow, bestRow, lastRow, this.n.delta);
    this.root.appendChild(c);
  }

  _buildTopCentre() {
    const c = el('div', 'hud-c hud-c--tc');
    this.n.banners = el('div', 'hud-banners');
    this.n.wrong = el('div', 'hud-wrong mg-hidden');
    this.n.wrong.append(
      el('i', null, '◀'), el('i', null, '◀'), el('i', null, '◀'),
      el('span', null, 'WRONG WAY')
    );

    c.append(this.n.banners, this.n.wrong);
    this.root.appendChild(c);
  }

  _buildBottomLeft() {
    const c = el('div', 'hud-c hud-c--bl');
    const wrap = el('div', 'hud-map-wrap');
    this.n.mapCanvas = el('canvas', 'hud-map');
    this.n.mapTag = el('div', 'hud-map-tag', '');
    wrap.append(this.n.mapCanvas, this.n.mapTag);
    this.n.mapWrap = wrap;
    c.appendChild(wrap);
    this.root.appendChild(c);
  }

  _buildBottomRight() {
    const c = el('div', 'hud-c hud-c--br');
    const dash = el('div', 'hud-dash');

    /* --- boost column --------------------------------------------------- */
    const boost = el('div', 'hud-boost');
    this.n.boostBar = el('div', 'hud-boost-bar');
    this.n.boostBar.appendChild(el('i'));
    boost.append(this.n.boostBar, el('span', 'mg-label', 'Boost'));

    /* --- gauge ----------------------------------------------------------- */
    const gauge = el('div', 'hud-gauge');
    gauge.appendChild(this._buildDial());

    const read = el('div', 'hud-gauge-read');
    this.n.speed = el('div', 'hud-speed mg-num', '0');
    this.n.speedUnit = el('div', 'hud-speed-unit', this.unit.label);
    read.append(this.n.speed, this.n.speedUnit);

    this.n.gear = el('div', 'hud-gear', '1');
    gauge.append(read, this.n.gear);

    dash.append(boost, gauge);
    c.appendChild(dash);
    this.root.appendChild(c);
  }

  /**
   * The dial face is drawn once. Per frame only the needle transform, two arc
   * dash offsets and two text nodes ever change.
   */
  _buildDial() {
    const s = svg('svg', { viewBox: '0 0 200 200', 'aria-hidden': 'true' });

    // Face plate: a dark disc with a hairline rim, so the needle reads against
    // something rather than floating over the track.
    s.appendChild(svg('circle', {
      cx: DIAL.cx, cy: DIAL.cy, r: DIAL.r + 12, class: 'spd-face',
    }));

    s.appendChild(svg('path', { d: arcPath(DIAL.r, 0, 1), class: 'spd-track' }));
    s.appendChild(svg('path', { d: arcPath(DIAL.r, 0.82, 1), class: 'spd-red' }));

    // Ticks and numerals.
    this.n.dialNums = [];
    const majors = 7;
    for (let i = 0; i <= majors * 2; i++) {
      const f = i / (majors * 2);
      const major = i % 2 === 0;
      const a = DIAL.start + DIAL.sweep * f;
      const [x0, y0] = polar(DIAL.rTick - (major ? 0 : 3), a);
      const [x1, y1] = polar(major ? DIAL.rTickIn : DIAL.rTickIn + 6, a);
      s.appendChild(svg('line', {
        x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2),
        class: major ? 'spd-tick spd-tick--maj' : 'spd-tick',
      }));
      if (major) {
        const [nx, ny] = polar(DIAL.rNum, a);
        const t = svg('text', { x: nx.toFixed(2), y: (ny + 4).toFixed(2), class: 'spd-num' });
        t.textContent = '0';
        s.appendChild(t);
        this.n.dialNums.push({ node: t, f });
      }
    }

    // rpm ring, inside the numerals
    this.n.rpmArc = svg('path', { d: arcPath(42, 0, 1), class: 'spd-rpm' });
    s.appendChild(this.n.rpmArc);

    // value arc, on the outer track
    this.n.valArc = svg('path', { d: arcPath(DIAL.r, 0, 1), class: 'spd-val' });
    s.appendChild(this.n.valArc);

    const needle = svg('g', { class: 'spd-needle' });
    needle.appendChild(svg('polygon', {
      points: `${DIAL.cx - 16},${DIAL.cy - 3.4} ${DIAL.cx + 74},${DIAL.cy - 1.1} ${DIAL.cx + 74},${DIAL.cy + 1.1} ${DIAL.cx - 16},${DIAL.cy + 3.4}`,
    }));
    this.n.needle = needle;
    s.appendChild(needle);

    s.appendChild(svg('circle', { cx: DIAL.cx, cy: DIAL.cy, r: 8, class: 'spd-hub' }));
    s.appendChild(svg('circle', { cx: DIAL.cx, cy: DIAL.cy, r: 3, class: 'spd-hub-in' }));

    // Dash lengths for the sweep arcs, from the arc geometry itself.
    this._valLen = arcLength(DIAL.r);
    this._rpmLen = arcLength(42);
    this.n.valArc.setAttribute('stroke-dasharray', String(this._valLen));
    this.n.valArc.setAttribute('stroke-dashoffset', String(this._valLen));
    this.n.rpmArc.setAttribute('stroke-dasharray', String(this._rpmLen));
    this.n.rpmArc.setAttribute('stroke-dashoffset', String(this._rpmLen));

    return s;
  }

  _buildBottomCentre() {
    const c = el('div', 'hud-c hud-c--bc');
    // HIDDEN UNTIL THERE IS SOMETHING TO PUT IN IT.
    //
    // Nothing in the game emits `pickup:collect`, `pickup:use` or
    // `pickup:clear` — the only references in the tree are the three listeners
    // below — so this slot reads EMPTY for the whole race, every race, in the
    // middle of the bottom edge of the screen. A player asked what it was for,
    // which is the evidence that it costs something.
    //
    // The listeners stay wired and `setPickup` un-hides it, so the slot returns
    // by itself the moment a pickup system exists. Nothing here needs undoing
    // to bring it back.
    const slot = el('div', 'hud-pickup');
    slot.style.display = 'none';
    const inner = el('div', 'hud-pickup-inner');
    this.n.pickupIcon = el('div', 'hud-pickup-icon', '◇');
    inner.appendChild(this.n.pickupIcon);
    this.n.pickupName = el('div', 'hud-pickup-name', 'EMPTY');
    slot.append(inner, this.n.pickupName);
    this.n.pickup = slot;
    c.appendChild(slot);
    this.root.appendChild(c);
  }

  _buildCentre() {
    this.n.centre = el('div', 'hud-cd');
    this.root.appendChild(this.n.centre);
  }

  /* ------------------------------------------------------------------- bus */

  _subscribe() {
    const bus = this.ctx?.bus;
    if (!bus?.on) return;
    const on = (name, fn) => this._offBus.push(bus.on(name, fn));

    on('race:state', (p) => this._onState(p));
    on('race:reset', () => this._resetTiming());
    on('race:countdown', (p) => this._onCountdown(p));
    on('race:start', () => { this._resetTiming(); this._syncVisibility(); });
    on('race:checkpoint', (p) => this._onCheckpoint(p));
    on('race:lap', (p) => this._onLap(p));
    on('race:sector', (p) => this._onSector(p));
    on('race:position', (p) => this._onPosition(p));
    on('race:overtake', (p) => this._onOvertake(p));
    on('race:whiteFlag', () => this._banner('FINAL LAP', 'gold'));
    on('race:finalLap', (p) => { if (p?.isPlayer) this._toast('FINAL LAP', '', 'gold'); });
    on('race:wrongway', (p) => this._onWrongWay(p));
    on('race:cut', (p) => { if (p?.entry?.isPlayer) this._toast('LAP INVALIDATED', 'CUT', 'bad'); });
    on('race:record', (p) => this._onRecord(p));
    on('race:eliminated', (p) => this._onEliminated(p));
    on('race:carFinished', (p) => this._onFinished(p));
    on('race:chequered', () => this._banner('CHEQUERED FLAG', 'cyan'));
    on('race:results', () => this.setVisible(false));
    on('race:pause', (p) => this._onPause(p));
    on('vehicle:respawn', (p) => { if (this._isPlayer(p)) this._toast('RESPAWN', '', 'cyan'); });
    on('ui:prefs', (p) => this._onPrefs(p));
    on('settings:applied', (s) => this.applySettings(s));
    on('track:ready', () => { this._mapDirty = true; });

    // Pickups do not exist as a system yet; the slot is driven entirely by
    // these events so it lights up the moment one does.
    on('pickup:collect', (p) => this.setPickup(p?.kind ?? p?.type ?? null, p));
    on('pickup:use', () => this.setPickup(null));
    on('pickup:clear', () => this.setPickup(null));
  }

  _isPlayer(p) {
    const v = p?.vehicle ?? p;
    return !!(v && (v.isPlayer || v === this.ctx?.player));
  }

  /* ---------------------------------------------------------------- events */

  _onState(p) {
    const to = p?.to || this.ctx?.race?.state || '';
    this._raceState = to;
    this._syncVisibility();
    if (to === 'grid' || to === 'countdown') this._resetTiming();
  }

  _onPause(p) {
    // The Menu owns the pause screen when it exists. Without one, at least say
    // the game is stopped rather than looking frozen.
    if (this.ctx?.menu) return;
    if (p?.paused) {
      if (this.n.pauseOverlay) return;
      const o = el('div', 'hud-paused');
      o.appendChild(el('span', null, 'PAUSED'));
      this.root.appendChild(o);
      this.n.pauseOverlay = o;
    } else if (this.n.pauseOverlay) {
      this.n.pauseOverlay.remove();
      this.n.pauseOverlay = null;
    }
  }

  _onCountdown(p) {
    const value = p?.value ?? 0;
    const label = p?.label || (value > 0 ? String(value) : 'GO');
    this._flashCountdown(label, value === 0);
    if (value === 0) this.setVisible(true);
  }

  _flashCountdown(label, isGo) {
    const host = this.n.centre;
    if (!host) return;
    host.textContent = '';
    const ring = el('div', 'hud-cd-ring' + (isGo ? ' is-go' : ''));
    const num = el('div', 'hud-cd-num' + (isGo ? ' is-go' : ''), label);
    host.append(ring, num);
    // Only clear if these are still the nodes on screen: a faster countdown
    // must not have its digit wiped by the previous one's timer.
    this._after(isGo ? 1000 : 1050, () => { if (host.contains(num)) host.textContent = ''; });
  }

  _onCheckpoint(p) {
    if (!p?.entry?.isPlayer) return;
    const race = this.ctx?.race;
    const entry = p.entry;
    const idx = p.index | 0;
    if (!race || !entry.started) return;
    const t = (race.raceTime || 0) - (entry.lapStartTime || 0);
    if (!(t > 0)) return;
    this.splits[idx] = t;
    this._lastGate = idx;
    if (this.refSplits && Number.isFinite(this.refSplits[idx])) {
      this.delta = t - this.refSplits[idx];
      this.deltaAge = 0;
    }
  }

  _onLap(p) {
    if (!p?.isPlayer) return;
    // A lap that improved the personal best becomes the new reference row.
    if (p.personalBest && !p.invalid && this.splits.length) {
      this.refSplits = this.splits.slice();
    }
    this.splits = [];
    this._lastGate = -1;
    if (!this.refSplits) this.delta = NaN;

    const time = formatTime(p.lapTime);
    if (p.raceBest) this._toast('FASTEST LAP', time, 'gold');
    else if (p.personalBest) this._toast('PERSONAL BEST', time, 'good');
    else if (p.invalid) this._toast('LAP INVALID', time, 'bad');
    else this._toast(`LAP ${p.lap}`, time, '');
  }

  _onSector(p) {
    if (!p?.isPlayer) return;
    const n = (p.sector | 0) + 1;
    if (p.best) this._toast(`SECTOR ${n}`, formatTime(p.time), 'good');
    else if (Number.isFinite(p.delta) && Math.abs(p.delta) > 0.001) {
      this._toast(`SECTOR ${n}`, formatDelta(p.delta), p.delta < 0 ? 'good' : 'bad');
    }
  }

  _onPosition(p) {
    if (!p?.isPlayer) return;
    const gained = p.gained || 0;
    const node = this.n.posNum;
    if (!node || !gained) return;
    node.classList.remove('is-up', 'is-down');
    // Force a reflow so the same animation can retrigger back to back.
    void node.offsetWidth;
    node.classList.add(gained > 0 ? 'is-up' : 'is-down');
    this._edgeFlash(gained > 0 ? 'good' : 'bad');
    this._after(520, () => node.classList.remove('is-up', 'is-down'));
  }

  _onOvertake(p) {
    if (!p?.isPlayer) return;
    const name = p.overEntry?.name || p.over?.driverName || '';
    this._toast('OVERTAKE', name, 'good');
  }

  _onWrongWay(p) {
    if (!p?.isPlayer) return;
    const on = !!p.on;
    if (on === this._wrongWay) return;
    this._wrongWay = on;
    this.n.wrong?.classList.toggle('mg-hidden', !on);
  }

  _onRecord(p) {
    if (p?.kind === 'lap') this._toast('TRACK RECORD', formatTime(p.time), 'gold');
    else if (p?.kind === 'race') this._toast('RACE RECORD', formatTime(p.time), 'gold');
  }

  _onEliminated(p) {
    if (p?.isPlayer) this._banner('ELIMINATED', '');
    else if (p?.entry?.name) this._toast('KNOCKED OUT', p.entry.name, 'bad');
  }

  _onFinished(p) {
    if (!p?.isPlayer) return;
    this._banner(`FINISHED ${p.ordinal || ''}`.trim(), 'cyan');
  }

  _onPrefs(p) {
    if (p && typeof p === 'object') Object.assign(this.prefs, p);
    else this.prefs = readPrefs();
    this.unit = UNIT[this.prefs.units] || UNIT.kmh;
    this.dialMax = 0;                       // force a rebuild of the numerals
    if (this.n.speedUnit) this.n.speedUnit.textContent = this.unit.label;
    if (this.n.mapWrap) this.n.mapWrap.classList.toggle('mg-hidden', !this.prefs.minimap);
  }

  /* ------------------------------------------------------------- transient */

  _after(ms, fn) {
    const id = setTimeout(() => { this._timers.delete(id); if (!this._disposed) fn(); }, ms);
    this._timers.add(id);
    return id;
  }

  _toast(label, value, kind) {
    if (!this.prefs.toasts || !this.n.feed) return;
    const node = el('div', 'hud-toast' + (kind ? ` hud-toast--${kind}` : ''));
    node.appendChild(el('span', null, label));
    if (value) node.appendChild(el('b', null, value));
    this.n.feed.appendChild(node);
    this._toasts.push(node);
    while (this._toasts.length > TOAST_MAX) this._killToast(this._toasts[0]);
    this._after(TOAST_LIFE, () => this._killToast(node));
  }

  _killToast(node) {
    const i = this._toasts.indexOf(node);
    if (i >= 0) this._toasts.splice(i, 1);
    if (!node.isConnected) return;
    node.classList.add('is-out');
    this._after(320, () => node.remove());
  }

  _banner(text, kind) {
    if (!this.n.banners) return;
    const node = el('div', 'hud-banner' + (kind ? ` hud-banner--${kind}` : ''));
    node.appendChild(el('span', null, text));
    this.n.banners.appendChild(node);
    this._after(2700, () => node.remove());
  }

  _edgeFlash(kind) {
    if (!this.root) return;
    const node = el('div', `hud-edge hud-edge--${kind}`);
    this.root.appendChild(node);
    this._after(760, () => node.remove());
  }

  /* -------------------------------------------------------------- minimap */

  /**
   * Bake the circuit once into an offscreen canvas: a dark casing stroke, the
   * road, a dashed centre line, the start line and the two sector gates. Per
   * frame we only blit that and draw the cars.
   */
  _bakeMinimap() {
    const canvas = this.n.mapCanvas;
    const track = this.ctx?.track;
    if (!canvas) return;

    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const host = document.getElementById('ui-root');
    const scale = host
      ? (parseFloat(getComputedStyle(host).getPropertyValue('--mg-vp')) || 1)
      : 1;
    const cssW = 236;
    const cssH = 168;
    const W = Math.max(64, Math.round(cssW * scale * dpr));
    const H = Math.max(48, Math.round(cssH * scale * dpr));
    canvas.width = W;
    canvas.height = H;

    const g = canvas.getContext('2d');
    if (!g) return;

    if (!track || typeof track.sampleAt !== 'function') {
      this.n.mapWrap?.classList.add('mg-hidden');
      return;
    }
    this.n.mapWrap?.classList.toggle('mg-hidden', !this.prefs.minimap);
    if (this.n.mapTag) this.n.mapTag.textContent = track.title || track.id || '';

    /* --- sample the centreline ------------------------------------------ */
    const n = MAP_SAMPLES;
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    let widthSum = 0;
    for (let i = 0; i < n; i++) {
      const s = track.sampleAt(i / n);
      const x = s.pos.x;
      const z = s.pos.z;
      xs[i] = x; zs[i] = z;
      widthSum += s.width || 26;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || maxX - minX < 1) {
      this.n.mapWrap?.classList.add('mg-hidden');
      return;
    }
    const avgWidth = widthSum / n;

    const pad = 12 * dpr * scale + avgWidth * 0.02;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    const k = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanZ);
    const ox = (W - spanX * k) * 0.5 - minX * k;
    const oy = (H - spanZ * k) * 0.5 - minZ * k;
    const toX = (x) => x * k + ox;
    const toY = (z) => z * k + oy;

    const baked = document.createElement('canvas');
    baked.width = W;
    baked.height = H;
    const b = baked.getContext('2d');
    if (!b) return;

    const trace = () => {
      b.beginPath();
      b.moveTo(toX(xs[0]), toY(zs[0]));
      for (let i = 1; i < n; i++) b.lineTo(toX(xs[i]), toY(zs[i]));
      b.closePath();
    };

    b.lineJoin = 'round';
    b.lineCap = 'round';

    // Casing: reads as the shoulder, and stops the road merging into the plate.
    trace();
    b.strokeStyle = 'rgba(0,0,0,0.85)';
    b.lineWidth = Math.max(5, avgWidth * k * 1.5);
    b.stroke();

    trace();
    b.strokeStyle = '#39415a';
    b.lineWidth = Math.max(3, avgWidth * k * 1.0);
    b.stroke();

    trace();
    b.strokeStyle = 'rgba(255,255,255,0.10)';
    b.lineWidth = Math.max(1, 1.2 * dpr);
    b.setLineDash([6 * dpr, 7 * dpr]);
    b.stroke();
    b.setLineDash([]);

    /* --- start line and sector gates ------------------------------------ */
    const tick = (t, colour, len, width) => {
      let s;
      try { s = track.sampleAt(t); } catch (_) { return; }
      const px = toX(s.pos.x);
      const py = toY(s.pos.z);
      // right vector is already unit length and lies in the ground plane
      const rx = s.right.x;
      const rz = s.right.z;
      const half = Math.max(4, (s.width || avgWidth) * k * 0.6) * len;
      b.beginPath();
      b.moveTo(px - rx * half, py - rz * half);
      b.lineTo(px + rx * half, py + rz * half);
      b.strokeStyle = colour;
      b.lineWidth = width * dpr;
      b.stroke();
    };

    const startT = Number.isFinite(track.startT) ? track.startT : 0;
    const cps = Array.isArray(track.checkpoints) ? track.checkpoints : [];
    if (cps.length >= 6) {
      tick(cps[Math.round(cps.length / 3)]?.t ?? 0.33, 'rgba(53,224,255,0.75)', 0.85, 2);
      tick(cps[Math.round((cps.length * 2) / 3)]?.t ?? 0.66, 'rgba(53,224,255,0.75)', 0.85, 2);
    }
    tick(startT, '#ffffff', 1.05, 3.2);

    this.map = { baked, g, W, H, toX, toY, dpr, scale };
    this._mapDirty = false;
  }

  _drawMinimap() {
    const m = this.map;
    if (!m || !this.prefs.minimap) return;
    const g = m.g;
    g.clearRect(0, 0, m.W, m.H);
    g.drawImage(m.baked, 0, 0);

    const vehicles = this.ctx?.vehicles;
    if (!Array.isArray(vehicles) || !vehicles.length) return;
    const r = Math.max(2.6, 3.4 * m.dpr * m.scale);
    const player = this.ctx?.player;

    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v?.position) continue;
      if (v.eliminated || v.group?.visible === false) continue;
      const x = m.toX(v.position.x);
      const y = m.toY(v.position.z);
      const isPlayer = v === player || v.isPlayer;
      const colour = this._carColour(v, i);

      g.beginPath();
      g.arc(x, y, isPlayer ? r * 1.5 : r, 0, Math.PI * 2);
      g.fillStyle = colour;
      g.fill();
      g.lineWidth = Math.max(1, 1.4 * m.dpr);
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.stroke();

      if (isPlayer) {
        g.beginPath();
        g.arc(x, y, r * 2.5, 0, Math.PI * 2);
        g.strokeStyle = '#ffffff';
        g.lineWidth = Math.max(1.4, 1.8 * m.dpr);
        g.stroke();
      }
    }
  }

  /**
   * A dot the colour of the actual paint. VehicleVisual resolves the livery at
   * build time and publishes it, so the map agrees with what is on screen.
   * Cached in a WeakMap rather than stamped onto the Vehicle: this module does
   * not get to add fields to a peer's objects.
   */
  _carColour(v, i) {
    const hit = this._colours.get(v);
    if (hit) return hit;
    const base = v.visual?.livery?.base;
    const hex = hexOf(base, FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]);
    // Only cache once a real livery has resolved; a car whose visual is still
    // building must not be stuck with the fallback for the whole race.
    if (base !== undefined) this._colours.set(v, hex);
    return hex;
  }

  /* ==================================================================== loop */

  update(dt) {
    if (!this.root || this._disposed) return;
    this.deltaAge += dt;
    this._shiftAge += dt;
  }

  lateUpdate(dt) {
    if (!this.root || this._disposed || !this.visible) return;
    if (this._mapDirty) this._bakeMinimap();

    const ctx = this.ctx;
    const race = ctx?.race;
    const player = ctx?.player || ctx?.vehicles?.[0] || null;
    const d = clamp(dt || 0, 0, 0.1);

    this._updatePosition(race);
    this._updateLap(race);
    this._updateTiming(race);
    this._updateDial(player, d);
    this._updateBoost(player);
    this._drawMinimap();
  }

  _set(key, node, value) {
    if (!node || this.cache[key] === value) return;
    this.cache[key] = value;
    node.textContent = value;
  }

  _updatePosition(race) {
    const entry = race?.player;
    const pos = entry?.position || 0;
    const field = race?.entries?.length || this.ctx?.vehicles?.length || 0;
    this._set('pos', this.n.posNum, pos > 0 ? String(pos) : '—');
    this._set('posOrd', this.n.posOrd, pos > 0 ? ordinalSuffix(pos) : '');
    this._set('posOf', this.n.posOf, field ? `/ ${field}` : '');
  }

  _updateLap(race) {
    const total = race?.totalLaps || this.ctx?.track?.laps || 3;
    const entry = race?.player;
    const lap = entry ? clamp(entry.lap + 1, 1, total) : 1;
    this._set('lap', this.n.lapVal, String(lap));
    this._set('lapTot', this.n.lapTot, `/${total}`);
    const isFinal = lap >= total && total > 1;
    if (this.cache.lapFinal !== isFinal) {
      this.cache.lapFinal = isFinal;
      this.n.lapBlock?.classList.toggle('is-final', isFinal);
    }
  }

  _updateTiming(race) {
    const entry = race?.player;
    let now = 0;
    if (entry && race && entry.started && !entry.finished) now = (race.raceTime || 0) - (entry.lapStartTime || 0);
    else if (entry?.finished) now = entry.lastLap || 0;
    this._set('now', this.n.timeNow, formatTime(Math.max(0, now)));
    this._set('best', this.n.timeBest, entry?.bestLap ? formatTime(entry.bestLap) : '--.---');
    this._set('last', this.n.timeLast, entry?.lastLap ? formatTime(entry.lastLap) : '--.---');

    // The record row is the only place violet appears in the HUD; it means
    // "this is the best anyone has ever gone here".
    const record = race?.records?.bestLap || 0;
    const isRecord = record > 0 && entry?.bestLap > 0 && entry.bestLap <= record + 1e-4;
    if (this.cache.bestRec !== isRecord) {
      this.cache.bestRec = isRecord;
      this.n.timeBest?.classList.toggle('is-record', isRecord);
    }

    const node = this.n.delta;
    if (!node) return;
    const has = Number.isFinite(this.delta);
    const text = has ? formatDelta(this.delta) : '—.———';
    if (this.cache.delta !== text) {
      this.cache.delta = text;
      node.textContent = text;
      node.classList.remove('is-good', 'is-bad');
      void node.offsetWidth;
      if (has) node.classList.add(this.delta < 0 ? 'is-good' : 'is-bad');
    }
  }

  _updateDial(player, dt) {
    const unit = this.unit;
    const top = Math.max(40, player?.topSpeed || player?.spec?.topSpeed || 100);
    const wantMax = Math.ceil((top * unit.factor * 1.14) / unit.step) * unit.step;
    if (wantMax !== this.dialMax) {
      this.dialMax = wantMax;
      for (const d of this.n.dialNums || []) {
        d.node.textContent = String(Math.round(this.dialMax * d.f));
      }
    }

    const speed = Math.abs(player?.speed || 0) * unit.factor;
    const target = saturate(speed / Math.max(1, this.dialMax));
    // A real needle has mass. Critically damped at ~13 Hz: it settles inside a
    // tenth of a second but never snaps between two integers.
    this._needle += (target - this._needle) * saturate(dt * 13);
    const angle = DIAL.start + DIAL.sweep * this._needle;
    this.n.needle?.setAttribute('transform', `rotate(${angle.toFixed(2)} ${DIAL.cx} ${DIAL.cy})`);
    this.n.valArc?.setAttribute('stroke-dashoffset', (this._valLen * (1 - this._needle)).toFixed(2));

    this._set('speed', this.n.speed, String(Math.round(speed)));

    const redline = Math.max(2000, player?.tuning?.redlineRpm || 7500);
    const revTarget = saturate((player?.rpm || 0) / redline);
    this._revNeedle += (revTarget - this._revNeedle) * saturate(dt * 16);
    this.n.rpmArc?.setAttribute('stroke-dashoffset', (this._rpmLen * (1 - this._revNeedle)).toFixed(2));
    const hot = this._revNeedle > 0.88;
    if (this.cache.rpmHot !== hot) {
      this.cache.rpmHot = hot;
      this.n.rpmArc?.classList.toggle('is-hot', hot);
    }

    const gear = player?.gearLabel ?? (player?.gear === -1 ? 'R' : String(player?.gear ?? 1));
    if (gear !== this._lastGear) {
      this._lastGear = gear;
      const node = this.n.gear;
      if (node) {
        node.textContent = gear;
        node.classList.toggle('is-rev', gear === 'R');
        node.classList.remove('is-shift');
        void node.offsetWidth;
        node.classList.add('is-shift');
        this._shiftAge = 0;
      }
    } else if (this._shiftAge > 0.24 && this.n.gear?.classList.contains('is-shift')) {
      this.n.gear.classList.remove('is-shift');
    }
  }

  _updateBoost(player) {
    const bar = this.n.boostBar;
    if (!bar) return;
    const fuel = saturate(player?.boostFuel ?? 0);
    const q = fuel.toFixed(3);
    if (this.cache.boost !== q) {
      this.cache.boost = q;
      bar.style.setProperty('--v', q);
    }
    const live = !!player?.boosting;
    if (this.cache.boostLive !== live) {
      this.cache.boostLive = live;
      bar.classList.toggle('is-live', live);
      if (live && !this._boostWasLive) this._edgeFlash('boost');
      this._boostWasLive = live;
    }
    const empty = fuel < 0.08;
    if (this.cache.boostEmpty !== empty) {
      this.cache.boostEmpty = empty;
      bar.classList.toggle('is-empty', empty);
    }
  }

  /* ================================================================ control */

  /**
   * Put something in the pickup slot.
   * @param {?string} kind e.g. 'boost' | 'shield' | 'mine' | 'oil'
   */
  setPickup(kind, payload) {
    const slot = this.n.pickup;
    if (!slot) return this;
    const glyphs = {
      boost: '»', shield: '◉', mine: '✖', oil: '●',
      repair: '+', magnet: '⌘', freeze: '❄',
    };
    if (!kind) {
      slot.classList.remove('is-full', 'is-armed');
      this.n.pickupIcon.textContent = '◇';
      this.n.pickupName.textContent = 'EMPTY';
      // Back out of sight rather than sitting there reading EMPTY. `pickup:use`
      // and `pickup:clear` both land here.
      slot.style.display = 'none';
      return this;
    }
    slot.style.display = '';
    slot.classList.add('is-full');
    slot.classList.toggle('is-armed', !!payload?.armed);
    this.n.pickupIcon.textContent = glyphs[kind] || '◆';
    this.n.pickupName.textContent = String(payload?.label || kind).toUpperCase();
    return this;
  }

  _resetTiming() {
    this.splits = [];
    this.refSplits = null;
    this.delta = NaN;
    this._lastGate = -1;
    this._wrongWay = false;
    this.n.wrong?.classList.add('mg-hidden');
    this.cache = {};
  }

  /** The HUD belongs to the race, not to the front end. Public because Menu
   *  calls it when it closes: the pause screen must give the HUD back. */
  syncVisibility() {
    const state = this._raceState || this.ctx?.race?.state || '';
    const racing = state === 'countdown' || state === 'racing' || state === 'finished' || state === 'grid';
    const menuOpen = !!this.ctx?.menu?.visible || !!this.ctx?.results?.visible;
    this.setVisible(racing && !menuOpen);
    return this;
  }

  _syncVisibility() { return this.syncVisibility(); }

  setVisible(on) {
    const want = !!on && !this.forcedHidden;
    this.visible = want;
    this.root?.classList.toggle('is-out', !want);
    return this;
  }

  show() {
    this.forcedHidden = false;
    this.setVisible(true);
    return this;
  }

  /** main.js calls this for ?nohud=1; it must stay hidden after that. */
  hide() {
    this.forcedHidden = true;
    this.visible = false;
    this.root?.classList.add('is-out');
    return this;
  }

  applySettings(settings) {
    const s = settings || this.ctx?.settings;
    const scale = s?.gameplay?.uiScale ?? 1;
    applyViewportVars(scale);
    // Settings.apply() fires on every slider tick, and rebaking the circuit is
    // 240 spline samples plus four canvas strokes. Only the scale matters here.
    if (scale !== this._uiScale) {
      this._uiScale = scale;
      this._mapDirty = true;
    }
    return this;
  }

  onResize() {
    applyViewportVars(this.ctx?.settings?.gameplay?.uiScale ?? 1);
    this._mapDirty = true;
    return this;
  }

  /** Compact snapshot for the debug overlay. */
  snapshot() {
    return {
      visible: this.visible,
      delta: Number.isFinite(this.delta) ? +this.delta.toFixed(3) : null,
      refSplits: this.refSplits ? this.refSplits.length : 0,
      toasts: this._toasts.length,
      units: this.prefs.units,
    };
  }

  dispose() {
    this._disposed = true;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    this.root?.remove();
    this.root = null;
    this.map = null;
    return this;
  }
}

export function makeHUD(ctx) { return new HUD(ctx); }

export default HUD;
