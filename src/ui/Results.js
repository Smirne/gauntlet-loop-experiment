// ui/Results.js — the classification, and the reason to run the next race.
//
// Driven entirely by the 'race:results' payload Race.js publishes: an ordered
// array of { position, name, car, isPlayer, time, bestLap, laps, points,
// placePoints, bonusPoints, eliminated, dnf, fastestLap, gap }, plus the live
// championship object and the id of the next round.
//
// The screen has exactly one trick and it is worth doing properly: the table
// arrives one row at a time from the left, and the championship column counts
// its points up from last round's total to this one. Standings that are simply
// *there* when the screen appears read as a spreadsheet. Standings that land
// read as a result.
//
// No imports — this must survive Race being a stub, in which case it never
// shows and costs nothing.

const ROW_STAGGER = 70;      // ms between rows landing
const COUNT_TIME = 900;      // ms for the championship tally to run up

/* ------------------------------------------------------------------ helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--.---';
  const ms = Math.floor((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60);
  const mm = String(ms).padStart(3, '0');
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}.${mm}`;
  return `${s}.${mm}`;
}

function ordinal(n) {
  const i = Math.round(n);
  const mod100 = i % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${i}TH`;
  switch (i % 10) {
    case 1: return `${i}ST`;
    case 2: return `${i}ND`;
    case 3: return `${i}RD`;
    default: return `${i}TH`;
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/* ==========================================================================
 * Results
 * ========================================================================== */

export class Results {
  name = 'results';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.root = null;
    this.visible = false;
    this.payload = null;

    this.n = {};
    this.items = [];        // focusable buttons
    this.focus = 0;
    this._counters = [];    // { node, from, to, t }
    this._timers = new Set();
    this._offBus = [];
    this._pad = { buttons: [], axis: 0, primed: false };
    this._disposed = false;

    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /* ==================================================================== init */

  async init() {
    const host = document.getElementById('ui-root');
    if (!host) return this;

    this.root = el('div');
    this.root.id = 'mg-results';
    this.root.classList.add('mg-hidden');

    this.n.veil = el('div', 'mn-veil mn-veil--heavy');
    this.n.frame = el('div', 'mn-frame');
    this.n.page = el('div', 'mn-page');
    this.n.frame.appendChild(this.n.page);
    this.root.append(this.n.veil, this.n.frame);
    host.appendChild(this.root);

    this._buildShell();

    const bus = this.ctx?.bus;
    if (bus?.on) {
      this._offBus.push(bus.on('race:results', (p) => this.show(p)));
      this._offBus.push(bus.on('race:reset', () => this.hide()));
      this._offBus.push(bus.on('race:start', () => this.hide()));
    }

    const MG = (globalThis.MG = globalThis.MG || {});
    MG.ui = MG.ui || {};
    MG.ui.results = this;

    return this;
  }

  _buildShell() {
    const page = this.n.page;

    /* --- header ---------------------------------------------------------- */
    const head = el('div', 'mn-head');
    head.append(
      (this.n.title = el('div', 'mn-head-t', 'RESULTS')),
      (this.n.subtitle = el('div', 'mn-head-s', '')),
    );
    const right = el('div', 'mn-head-r');
    this.n.fastest = el('div', 'mg-chip mg-chip--cyan', '');
    right.appendChild(this.n.fastest);
    head.appendChild(right);
    page.appendChild(head);

    /* --- body ------------------------------------------------------------ */
    const body = el('div', 'rs-body');

    const table = el('div', 'rs-table');
    const thead = el('div', 'rs-head');
    thead.append(
      el('span', null, 'Pos'), el('span', null, 'Driver'), el('span', null, 'Car'),
      el('span', null, 'Time'), el('span', null, 'Best lap'), el('span', null, 'Pts'),
    );
    this.n.rows = el('div', 'rs-rows');
    table.append(thead, this.n.rows);

    const side = el('div', 'rs-side');

    const hero = el('div', 'mg-plate mg-plate--lg rs-panel');
    const heroRow = el('div', 'rs-hero');
    this.n.heroV = el('div', 'rs-hero-v', '—');
    heroRow.append(this.n.heroV, (this.n.heroLabel = el('div', 'mg-label', 'Your finish')));
    this.n.heroSub = el('div', 'mn-row-hint', '');
    hero.append(heroRow, this.n.heroSub);

    const champ = el('div', 'mg-plate mg-plate--lg rs-panel');
    this.n.champTitle = el('div', 'mg-label', 'Championship');
    this.n.champRows = el('div');
    champ.append(this.n.champTitle, el('div', 'mg-rule'), this.n.champRows);
    this.n.champPanel = champ;

    const actions = el('div', 'rs-actions');
    this.n.btnContinue = this._button('Continue', () => this._continue());
    this.n.btnRetry = this._button('Retry', () => this._retry());
    actions.append(this.n.btnContinue, this.n.btnRetry);

    side.append(hero, champ, actions);
    body.append(table, side);
    page.appendChild(body);
  }

  _button(label, onActivate) {
    const b = el('button', 'mg-btn');
    b.type = 'button';
    b.appendChild(el('span', null, label.toUpperCase()));
    const index = this.items.length;
    this.items.push({ el: b, activate: onActivate });
    b.addEventListener('click', () => { this.focus = index; this._syncFocus(); this._sfx('confirm'); onActivate(); });
    b.addEventListener('pointerenter', () => this._setFocus(index));
    return b;
  }

  /* ================================================================== show */

  show(payload) {
    if (!this.root) return this;
    this.payload = payload || null;
    this._render(payload);
    this.root.classList.remove('mg-hidden');
    this.root.classList.remove('is-out');
    this.visible = true;
    this.focus = 0;
    this._pad.primed = false;
    this._syncFocus();
    globalThis.addEventListener('keydown', this._onKeyDown, true);
    this.ctx?.hud?.setVisible?.(false);
    this.ctx?.bus?.emit?.('ui:menu', { screen: 'results', open: true });
    return this;
  }

  hide() {
    if (!this.root || !this.visible) return this;
    this.visible = false;
    this.root.classList.add('is-out');
    const t = setTimeout(() => {
      this._timers.delete(t);
      if (!this.visible) this.root?.classList.add('mg-hidden');
    }, 320);
    this._timers.add(t);
    globalThis.removeEventListener('keydown', this._onKeyDown, true);
    this.ctx?.bus?.emit?.('ui:menu', { screen: 'results', open: false });
    return this;
  }

  /* ------------------------------------------------------------------ render */

  _render(payload) {
    const race = this.ctx?.race;
    const rows = Array.isArray(payload?.results) ? payload.results
      : Array.isArray(race?.results) ? race.results : [];

    const trackName = race?.trackName || this.ctx?.track?.title || '';
    this.n.subtitle.textContent = trackName ? `${trackName} · ${race?.totalLaps ?? ''} LAPS`.trim() : '';

    /* --- fastest lap chip ------------------------------------------------ */
    const fl = race?.fastestLap;
    if (fl?.time > 0) {
      this.n.fastest.textContent = `FASTEST ${formatTime(fl.time)} · ${fl.entry?.name || ''}`.trim();
      this.n.fastest.classList.remove('mg-hidden');
    } else {
      this.n.fastest.classList.add('mg-hidden');
    }

    /* --- table ------------------------------------------------------------ */
    this.n.rows.textContent = '';
    const winner = rows[0];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const row = el('div', 'rs-row');
      if (r.isPlayer) row.classList.add('is-player');
      if (r.position === 1) row.classList.add('is-p1');
      if (r.eliminated || r.dnf) row.classList.add('is-out');

      const pos = el('div', 'rs-pos', String(r.position));
      const name = el('div', 'rs-name', r.name || '—');
      const car = el('div', 'rs-car', r.car || '');

      let timeText;
      if (r.dnf) timeText = 'DNF';
      else if (r.eliminated) timeText = 'OUT';
      else if (!winner || r === winner) timeText = formatTime(r.time);
      else timeText = `+${formatTime(Math.max(0, r.gap || 0))}`;
      const time = el('div', 'rs-time mg-num', timeText);

      const best = el('div', 'rs-best mg-num', r.bestLap > 0 ? formatTime(r.bestLap) : '--.---');
      if (r.fastestLap) best.classList.add('is-fastest');

      const pts = el('div', 'rs-pts mg-num', r.points > 0 ? `+${r.points}` : '—');

      row.append(pos, name, car, time, best, pts);
      this.n.rows.appendChild(row);

      const t = setTimeout(() => { this._timers.delete(t); row.classList.add('is-in'); }, 120 + i * ROW_STAGGER);
      this._timers.add(t);
    }

    /* --- hero ------------------------------------------------------------- */
    const me = rows.find((r) => r.isPlayer) || null;
    if (me) {
      this.n.heroV.textContent = me.dnf ? 'DNF' : me.eliminated ? 'OUT' : ordinal(me.position);
      const bits = [];
      if (me.bestLap > 0) bits.push(`best ${formatTime(me.bestLap)}`);
      if (me.placePoints) bits.push(`${me.placePoints} pts`);
      if (me.bonusPoints) bits.push('+1 fastest lap');
      this.n.heroSub.textContent = bits.join('  ·  ');
    } else {
      this.n.heroV.textContent = '—';
      this.n.heroSub.textContent = '';
    }

    /* --- championship ----------------------------------------------------- */
    this._renderChampionship(payload, rows);

    /* --- actions ---------------------------------------------------------- */
    const next = payload?.nextTrack ?? race?.nextChampionshipTrack?.() ?? null;
    const label = next ? `Next round · ${String(next).toUpperCase()}` : 'Continue';
    this.n.btnContinue.textContent = '';
    this.n.btnContinue.appendChild(el('span', null, label.toUpperCase()));
    this.n.btnContinue.appendChild(el('span', 'mg-btn-key', 'ENTER'));
    this.n.btnRetry.textContent = '';
    this.n.btnRetry.appendChild(el('span', null, 'RETRY'));
    this.n.btnRetry.appendChild(el('span', 'mg-btn-key', 'R'));
  }

  _renderChampionship(payload, rows) {
    const race = this.ctx?.race;
    const champ = payload?.championship ?? race?.championship ?? null;
    const standings = typeof race?.championshipStandings === 'function' ? race.championshipStandings() : [];
    this._counters.length = 0;
    this.n.champRows.textContent = '';

    if (!champ || !standings.length) {
      this.n.champTitle.textContent = 'Season';
      const hint = el('div', 'mn-row-hint', 'Start a championship from the title screen to carry points between circuits.');
      this.n.champRows.appendChild(hint);
      return;
    }

    const round = clamp((champ.round | 0), 0, champ.order?.length || 5);
    this.n.champTitle.textContent = `Championship · round ${round}/${champ.order?.length ?? 5}`;

    // Points banked *this* race, so the counter has somewhere to start.
    const gained = new Map();
    for (const r of rows) gained.set(r.name, (gained.get(r.name) || 0) + (r.points || 0));

    for (const s of standings.slice(0, 8)) {
      const row = el('div', 'rs-champ-row');
      if (s.isPlayer) row.classList.add('is-player');
      const value = el('div', 'rs-cv mg-num', '0');
      row.append(
        el('div', 'rs-cp mg-num', String(s.position)),
        el('div', 'rs-cn', s.name),
        value,
      );
      this.n.champRows.appendChild(row);
      const to = s.points || 0;
      const from = Math.max(0, to - (gained.get(s.name) || 0));
      value.textContent = String(from);
      if (to !== from) this._counters.push({ node: value, from, to, t: 0 });
    }
  }

  /* ==================================================================== loop */

  update(dt) {
    if (this._disposed || !this.visible) return;

    /* --- points tally ----------------------------------------------------- */
    if (this._counters.length) {
      const step = (dt * 1000) / COUNT_TIME;
      for (let i = this._counters.length - 1; i >= 0; i--) {
        const c = this._counters[i];
        c.t = Math.min(1, c.t + step);
        const v = Math.round(c.from + (c.to - c.from) * easeOut(c.t));
        if (c.node.textContent !== String(v)) c.node.textContent = String(v);
        if (c.t >= 1) this._counters.splice(i, 1);
      }
    }

    this._pollPad();
  }

  /* ============================================================ navigation */

  _setFocus(i) {
    if (i < 0 || i >= this.items.length) return;
    if (i === this.focus) return;
    this.focus = i;
    this._syncFocus();
    this._sfx('move');
  }

  _syncFocus() {
    for (let i = 0; i < this.items.length; i++) {
      this.items[i].el.classList.toggle('is-focused', i === this.focus);
    }
  }

  _move(delta) {
    const n = this.items.length;
    if (!n) return;
    this._setFocus((this.focus + delta + n) % n);
  }

  _activate() {
    const item = this.items[this.focus];
    if (!item) return;
    this._sfx('confirm');
    item.activate();
  }

  _onKeyDown(e) {
    if (!this.visible) return;
    switch (e.code) {
      case 'ArrowRight': case 'KeyD': case 'ArrowDown': case 'KeyS':
        e.preventDefault(); e.stopPropagation(); this._move(1); break;
      case 'ArrowLeft': case 'KeyA': case 'ArrowUp': case 'KeyW':
        e.preventDefault(); e.stopPropagation(); this._move(-1); break;
      case 'Enter': case 'NumpadEnter': case 'Space':
        e.preventDefault(); e.stopPropagation(); this._activate(); break;
      case 'KeyR':
        e.preventDefault(); e.stopPropagation(); this._retry(); break;
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); this._continue(); break;
      default: break;
    }
  }

  /** Minimal standard-mapping poll. Input.js owns driving; this owns menus. */
  _pollPad() {
    let pads = [];
    try { pads = globalThis.navigator?.getGamepads?.() || []; } catch (_) { return; }
    let pad = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) { pad = pads[i]; break; }
    if (!pad) return;

    const prev = this._pad.buttons;
    const down = (i) => !!pad.buttons[i]?.pressed;
    const edge = (i) => down(i) && !prev[i];

    // First poll only samples: a button still held from the last corner must
    // not skip straight past the standings.
    if (!this._pad.primed) {
      this._pad.primed = true;
      for (let i = 0; i < 17; i++) prev[i] = down(i);
      this._pad.axis = pad.axes?.[0] || 0;
      return;
    }

    if (edge(0)) this._activate();
    else if (edge(1)) this._continue();
    else if (edge(12) || edge(14)) this._move(-1);
    else if (edge(13) || edge(15)) this._move(1);
    else {
      const ax = pad.axes?.[0] || 0;
      const ay = pad.axes?.[1] || 0;
      const v = Math.abs(ax) > Math.abs(ay) ? ax : ay;
      if (Math.abs(v) > 0.6 && Math.abs(this._pad.axis) <= 0.6) this._move(v > 0 ? 1 : -1);
      this._pad.axis = v;
    }
    for (let i = 0; i < 17; i++) prev[i] = down(i);
  }

  /* ================================================================ actions */

  _continue() {
    const race = this.ctx?.race;
    const url = typeof race?.nextChampionshipUrl === 'function' ? race.nextChampionshipUrl() : null;
    this.hide();
    if (url) {
      // main.js binds exactly one track per boot, so the next round is a load.
      globalThis.location.href = url;
      return;
    }
    try { race?.reset?.(); } catch (_) { /* stub race */ }
    const menu = this.ctx?.menu;
    if (menu?.show) menu.show('title');
    else if (menu?.open) menu.open();
  }

  _retry() {
    this.hide();
    const race = this.ctx?.race;
    try { race?.start?.({ skipCountdown: false }); } catch (_) { /* stub race */ }
  }

  _sfx(kind) {
    const audio = this.ctx?.audio;
    try {
      if (audio?.ui) audio.ui(kind);
      else audio?.play?.(`ui.${kind}`);
    } catch (_) { /* audio is a nicety */ }
    this.ctx?.bus?.emit?.('ui:select', { kind, screen: 'results' });
  }

  onResize() { return this; }

  dispose() {
    this._disposed = true;
    globalThis.removeEventListener('keydown', this._onKeyDown, true);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    this.root?.remove();
    this.root = null;
    return this;
  }
}

export function makeResults(ctx) { return new Results(ctx); }

export default Results;
