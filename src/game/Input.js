// game/Input.js — one commanded control state, from whatever the player is holding.
//
// Two devices, one output. Everything downstream (Vehicle, HUD, Race, Director)
// reads `input.getControls()` and never has to know whether the throttle came
// from a key or a trigger.
//
// Three things here are worth more than they look:
//
//   1. Digital -> analogue steering. A keyboard gives you -1, 0 or +1. A car
//      that snaps between those is unsteerable at 100 u/s. The commanded steer
//      is therefore rate-limited, and the rate is speed-sensitive: full lock in
//      85 ms parked, 260 ms flat out. Counter-steer is the fastest transition of
//      the three, because that is the input you make when you are already
//      sideways and cannot afford to wait. This shapes the *command*; the
//      physical lock limit is Vehicle's job and is not duplicated here.
//
//   2. Radial deadzones. Per-axis deadzones make a stick square: hold it fully
//      diagonal and each axis reads 1.0, so the car steers as hard diagonally as
//      it does straight left. The magnitude of the pair is deadzoned and
//      rescaled instead, which keeps the stick round and makes small
//      corrections near centre actually usable.
//
//   3. It never touches the car when something else is driving. Race can hand
//      the player to an autopilot (attract mode, headless capture); Input asks
//      before it writes, and zeroes the controls exactly once on the way out.
//
// No imports: this module has to work even if every peer failed to load.

const STORAGE_KEY = 'microgauntlet.input.v1';

/* ------------------------------------------------------------------ actions */

/** Every bindable action. `axis` actions feed the analogue control state;
 *  `event` actions fire once on press and are published on the bus. */
export const ACTIONS = Object.freeze({
  throttle:   { kind: 'axis',  label: 'Accelerate' },
  brake:      { kind: 'axis',  label: 'Brake / reverse' },
  steerLeft:  { kind: 'axis',  label: 'Steer left' },
  steerRight: { kind: 'axis',  label: 'Steer right' },
  handbrake:  { kind: 'axis',  label: 'Handbrake' },
  boost:      { kind: 'axis',  label: 'Boost' },
  lookBack:   { kind: 'axis',  label: 'Look back' },
  respawn:    { kind: 'event', label: 'Respawn' },
  pause:      { kind: 'event', label: 'Pause' },
  photo:      { kind: 'event', label: 'Photo mode' },
  camera:     { kind: 'event', label: 'Change camera' },
  restart:    { kind: 'event', label: 'Restart race' },
  accept:     { kind: 'event', label: 'Confirm' },
  back:       { kind: 'event', label: 'Back' },
});

export const ACTION_LIST = Object.freeze(Object.keys(ACTIONS));

/** KeyboardEvent.code lists. Two slots each so a rebind never orphans an action. */
const DEFAULT_KEYS = Object.freeze({
  throttle:   ['KeyW', 'ArrowUp'],
  brake:      ['KeyS', 'ArrowDown'],
  steerLeft:  ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake:  ['Space'],
  boost:      ['ShiftLeft', 'ShiftRight'],
  lookBack:   ['KeyB'],
  respawn:    ['KeyR'],
  pause:      ['Escape'],
  photo:      ['KeyC'],
  camera:     ['KeyV'],
  restart:    ['Backslash'],
  accept:     ['Enter', 'NumpadEnter'],
  back:       ['Escape'],
});

// Standard-mapping button indices. `analog` names a button whose .value is a
// real 0..1 (the triggers on every pad that reports the standard mapping).
const DEFAULT_PAD = Object.freeze({
  throttle:   { buttons: [0], analog: 7 },
  brake:      { buttons: [1], analog: 6 },
  steerLeft:  { buttons: [14] },
  steerRight: { buttons: [15] },
  handbrake:  { buttons: [2, 4] },
  boost:      { buttons: [5] },
  lookBack:   { buttons: [10] },
  respawn:    { buttons: [3] },
  pause:      { buttons: [9] },
  photo:      { buttons: [8] },
  camera:     { buttons: [11] },
  restart:    { buttons: [] },
  accept:     { buttons: [0] },
  back:       { buttons: [1] },
});

const PAD_STEER_AXIS_X = 0;
const PAD_STEER_AXIS_Y = 1;

/* ------------------------------------------------------------------- glyphs */

// Face-button lettering differs per family, and a HUD prompt that shows "A"
// to someone holding a DualSense is exactly the kind of detail that reads as
// unfinished.
const PAD_GLYPHS = Object.freeze({
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'MENU', 'LS', 'RS', 'D-UP', 'D-DN', 'D-LT', 'D-RT'],
  playstation: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'SHARE', 'OPTIONS', 'L3', 'R3', 'D-UP', 'D-DN', 'D-LT', 'D-RT'],
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '-', '+', 'LS', 'RS', 'D-UP', 'D-DN', 'D-LT', 'D-RT'],
  generic: ['1', '2', '3', '4', 'L1', 'R1', 'L2', 'R2', 'SELECT', 'START', 'L3', 'R3', 'D-UP', 'D-DN', 'D-LT', 'D-RT'],
});

const KEY_GLYPHS = Object.freeze({
  Space: 'SPACE', Escape: 'ESC', Enter: 'ENTER', NumpadEnter: 'ENTER',
  ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL',
  AltLeft: 'ALT', AltRight: 'ALT', Tab: 'TAB', Backspace: 'BKSP', Backslash: '\\',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: '\'',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
});

/** Codes we swallow so the page never scrolls mid-corner. Tab is deliberately
 *  left alone: the options screen needs it to be a focus key. */
const SWALLOW = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace',
]);

/* ------------------------------------------------------------------ helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function saturate(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem(STORAGE_KEY);
    return s;
  } catch (_) {
    return null;
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

function padFamily(id) {
  const s = String(id || '').toLowerCase();
  if (/dualsense|dualshock|playstation|wireless controller|sony|054c/.test(s)) return 'playstation';
  if (/switch|joy-con|pro controller|nintendo|057e/.test(s)) return 'nintendo';
  if (/xbox|xinput|microsoft|045e/.test(s)) return 'xbox';
  return 'generic';
}

/**
 * Move `cur` toward `target` at a fixed rate. Used instead of an exponential
 * lerp for steering because a rate limit has a knowable, tunable time-to-lock,
 * and an exponential never quite arrives.
 */
function approach(cur, target, rate, dt) {
  const step = rate * dt;
  const d = target - cur;
  if (d > step) return cur + step;
  if (d < -step) return cur - step;
  return target;
}

/* -------------------------------------------------------------------- Input */

export class Input {
  name = 'input';

  constructor(ctx = {}) {
    this.ctx = ctx;

    /** The commanded control state. Stable object identity: Vehicle reads it
     *  every frame and must never see a fresh allocation. */
    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0 };

    /** Raw, unsmoothed intent for this frame, before the steering rate limit. */
    this.raw = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0, lookBack: 0 };

    this.enabled = true;
    /** 'keyboard' | 'gamepad' — whichever moved most recently. HUD glyph source. */
    this.device = 'keyboard';
    this.padFamily = 'generic';
    this.padId = '';
    this.padIndex = -1;
    this.hasGamepad = false;
    this.lookBack = false;
    this.photoMode = false;
    this.anyInputSince = 0;

    /** Tunables. Persisted alongside the bindings. */
    this.options = {
      stickDeadzone: 0.18,     // radial, as a fraction of full stick throw
      stickOuter: 0.95,        // treat anything past this as full deflection
      stickExpo: 0.35,         // 0 linear, 1 heavily eased around centre
      triggerDeadzone: 0.06,
      // Playtest: "a small press makes a huge turn". Measured at 52 u/s, half
      // top speed: the command ramped linearly to full lock in 178 ms, so a
      // 100 ms tap — an ordinary correction on a keyboard — already commanded
      // 61% of lock, 14.6 of 24 degrees. `steerPos` tracked the command
      // exactly, so the vehicle's own rate limiter never engaged; this ramp was
      // the entire steering feel.
      steerAttackSlow: 0.13,   // seconds to full lock, parked
      steerAttackFast: 0.34,   // seconds to full lock, at top speed
      steerReturn: 0.075,      // seconds back to centre
      steerCounter: 0.055,     // seconds to cross centre when countersteering
      // Shape the command so the first half of the travel is gentler than the
      // second. Slowing the ramp alone buys time but keeps the response
      // linear, and linear means there is no fine region near centre at all —
      // every small input is a scaled-down version of a big one. This is the
      // curve that gives a keyboard a trim range: out = x*(k + (1-k)*x*x),
      // exact at full lock, so nothing is taken away at the extremes.
      steerExpo: 0.45,         // 1 = linear; lower = finer around centre
      rumble: 1,
      invertSteer: false,
    };

    this.bindings = { keys: cloneBindings(DEFAULT_KEYS), pad: clonePad(DEFAULT_PAD) };

    /* --- device state ---------------------------------------------------- */

    this._keys = new Set();
    /** actions pressed this frame, cleared at the end of update() */
    this._pressed = new Set();
    this._held = new Set();
    this._heldPrev = new Set();
    this._padButtons = new Float32Array(24);
    this._padPrev = new Float32Array(24);
    this._padAxes = new Float32Array(8);
    this._steer = 0;
    this._steerRaw = 0;
    this._stickSteer = 0;

    /* --- rumble ---------------------------------------------------------- */

    this._rumbleUntil = 0;
    this._rumbleStrong = 0;
    this._rumbleWeak = 0;
    this._rumbleIssued = -1;
    this._ambientRumble = 0;

    /* --- rebinding ------------------------------------------------------- */

    this._rebind = null;
    this._offBus = [];
    this._wroteZero = false;
    this._acceptedLast = true;
    this._now = 0;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onPadConnect = this._onPadConnect.bind(this);
    this._onPadDisconnect = this._onPadDisconnect.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
  }

  /* ------------------------------------------------------------------ setup */

  async init() {
    this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown, false);
      window.addEventListener('keyup', this._onKeyUp, false);
      window.addEventListener('blur', this._onBlur, false);
      window.addEventListener('gamepadconnected', this._onPadConnect, false);
      window.addEventListener('gamepaddisconnected', this._onPadDisconnect, false);
      // A click is a user gesture: the right moment to let audio out of jail.
      window.addEventListener('pointerdown', this._onPointerDown, false);
    }
    // A pad that was already connected at load time fires no event.
    this._scanPads();

    const bus = this.ctx?.bus;
    if (bus?.on) {
      this._offBus.push(bus.on('vehicle:impact', (p) => this._onImpact(p)));
      this._offBus.push(bus.on('impact', (p) => this._onImpact(p)));
      this._offBus.push(bus.on('collision', (p) => this._onImpact(p)));
    }
    return this;
  }

  /* --------------------------------------------------------------- contract */

  /** The control state Vehicle and AI both speak. Never reallocated. */
  getControls() { return this.controls; }
  getState() { return this.controls; }

  /** True while the action is held (analogue actions report > 0.5). */
  isDown(action) { return this._held.has(action); }

  /** True on the frame the action went down. Cleared at the end of update(). */
  justPressed(action) { return this._pressed.has(action); }

  /** Analogue value of an action in 0..1 (or -1..1 for `steer`). */
  axis(name) {
    if (name === 'steer') return this.controls.steer;
    const v = this.raw[name];
    return typeof v === 'number' ? v : 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this._releaseAll();
    return this;
  }

  /* ------------------------------------------------------------------- loop */

  update(dt, ctx) {
    if (ctx) this.ctx = ctx;
    this._now += dt;

    this._heldPrev.clear();
    for (const a of this._held) this._heldPrev.add(a);
    this._held.clear();

    this._pollPad();
    this._resolveActions();
    this._pumpRumble(dt);

    // Held-edge detection for actions that arrived from the pad (keyboard edges
    // come straight off keydown, which is more responsive than polling).
    for (const a of this._held) {
      if (!this._heldPrev.has(a) && ACTIONS[a]?.kind === 'event') this._fire(a);
    }

    this._pressed.clear();
  }

  /**
   * Steering is integrated at the physics rate and pushed straight into the
   * player before Vehicle.fixedUpdate runs (Input is registered first), so the
   * command the tyre solve sees is never a frame stale.
   */
  fixedUpdate(fdt, ctx) {
    if (ctx) this.ctx = ctx;
    this._integrateSteer(fdt);

    const c = this.controls;
    const player = this.ctx?.player;
    const accepted = this.enabled && (this.ctx?.race?.acceptsInput?.() ?? true);

    if (!accepted) {
      // Something else has the wheel (an autopilot, the results camera, the
      // grid). Zero the published state as well as pushing zeros once: Vehicle
      // polls getControls() directly when nothing stamped its controls this
      // frame, so leaving live values in here would drive the car anyway.
      c.throttle = 0; c.brake = 0; c.steer = 0; c.handbrake = 0; c.boost = 0;
      if (!this._wroteZero && player?.setControls) {
        player.setControls(c);
        this._wroteZero = true;
      }
      this._acceptedLast = false;
      return;
    }

    if (!this._acceptedLast) {
      // Coming back from an autopilot with a stale integrator would yank the
      // wheel; start from where the car actually is.
      this._steer = clamp(player?.steerPos ?? 0, -1, 1);
      this._acceptedLast = true;
    }

    c.throttle = this.raw.throttle;
    c.brake = this.raw.brake;
    c.handbrake = this.raw.handbrake;
    c.boost = this.raw.boost;
    const shaped = this._shapeSteer(this._steer);
    c.steer = this.options.invertSteer ? -shaped : shaped;

    this._wroteZero = false;
    if (player?.setControls) player.setControls(c);
  }

  /* -------------------------------------------------------------- steering */

  /**
   * Digital -> analogue. The rate at which the command may move is a function
   * of speed: quick and direct when parked, deliberate at speed. Returning to
   * centre and crossing centre are both faster than applying lock, which is
   * what makes a keyboard car catchable once it steps out.
   */
  _integrateSteer(dt) {
    const o = this.options;
    const target = clamp(this._steerRaw, -1, 1);

    // A real stick is already analogue: rate-limiting it would only add lag.
    if (this._stickActive) {
      this._steer = approach(this._steer, target, 12, dt);
      return;
    }

    const player = this.ctx?.player;
    const speed = Math.abs(player?.forwardSpeed ?? player?.speed ?? 0);
    const top = Math.max(40, player?.topSpeed ?? 100);
    const norm = saturate(speed / top);

    let time;
    if (Math.abs(target) < 0.02) time = o.steerReturn;
    else if (target * this._steer < -0.02) time = o.steerCounter;
    else time = o.steerAttackSlow + (o.steerAttackFast - o.steerAttackSlow) * norm;

    this._steer = approach(this._steer, target, 1 / Math.max(0.02, time), dt);
    if (Math.abs(this._steer) < 1e-4) this._steer = 0;
  }

  /**
   * Command shaping. Applied to the resolved command, not to the raw key, so
   * the ramp above stays a pure "how fast may this move" and this stays a pure
   * "how much lock does that mean" — the two are independently tunable.
   *
   * Only the human is shaped. The AI drivers and the autopilot call
   * `vehicle.setControls()` directly and never pass through here, so their
   * racing line is untouched by a change to player feel.
   */
  _shapeSteer(x) {
    const k = clamp(this.options.steerExpo ?? 1, 0.15, 1);
    if (k >= 1) return x;
    const a = Math.abs(x);
    return Math.sign(x) * a * (k + (1 - k) * a * a);
  }

  /* ------------------------------------------------------------- resolution */

  /** Fold keyboard and pad state into `raw` and the held-action set. */
  _resolveActions() {
    const raw = this.raw;
    const keys = this.bindings.keys;
    const pad = this.bindings.pad;

    let throttle = 0;
    let brake = 0;
    let handbrake = 0;
    let boost = 0;
    let left = 0;
    let right = 0;
    let look = 0;

    if (this.enabled) {
      // --- keyboard
      if (this._anyKey(keys.throttle)) throttle = 1;
      if (this._anyKey(keys.brake)) brake = 1;
      if (this._anyKey(keys.handbrake)) handbrake = 1;
      if (this._anyKey(keys.boost)) boost = 1;
      if (this._anyKey(keys.steerLeft)) left = 1;
      if (this._anyKey(keys.steerRight)) right = 1;
      if (this._anyKey(keys.lookBack)) look = 1;

      // --- gamepad
      if (this.hasGamepad) {
        throttle = Math.max(throttle, this._padAxisFor(pad.throttle));
        brake = Math.max(brake, this._padAxisFor(pad.brake));
        handbrake = Math.max(handbrake, this._padAxisFor(pad.handbrake));
        boost = Math.max(boost, this._padAxisFor(pad.boost));
        left = Math.max(left, this._padAxisFor(pad.steerLeft));
        right = Math.max(right, this._padAxisFor(pad.steerRight));
        look = Math.max(look, this._padAxisFor(pad.lookBack));
      }
    }

    // Stick steer wins over the d-pad/keys whenever it is actually deflected.
    const stick = this._stickSteer;
    this._stickActive = Math.abs(stick) > 0.02;
    const digital = right - left;
    this._steerRaw = this._stickActive && Math.abs(stick) >= Math.abs(digital) ? stick : digital;

    raw.throttle = saturate(throttle);
    raw.brake = saturate(brake);
    raw.handbrake = saturate(handbrake);
    raw.boost = saturate(boost);
    raw.steer = this._steerRaw;
    raw.lookBack = saturate(look);
    this.lookBack = raw.lookBack > 0.5;

    // Held set, for isDown() and for pad edge detection.
    const held = this._held;
    if (raw.throttle > 0.5) held.add('throttle');
    if (raw.brake > 0.5) held.add('brake');
    if (raw.handbrake > 0.5) held.add('handbrake');
    if (raw.boost > 0.5) held.add('boost');
    if (this._steerRaw < -0.5) held.add('steerLeft');
    if (this._steerRaw > 0.5) held.add('steerRight');
    if (raw.lookBack > 0.5) held.add('lookBack');
    if (this.enabled && this.hasGamepad) {
      for (const action of ACTION_LIST) {
        if (ACTIONS[action].kind !== 'event') continue;
        if (this._padAxisFor(pad[action]) > 0.5) held.add(action);
      }
    }
  }

  _anyKey(list) {
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (this._keys.has(list[i])) return true;
    return false;
  }

  /** 0..1 for a pad binding: max of its digital buttons and its analogue one. */
  _padAxisFor(bind) {
    if (!bind) return 0;
    let v = 0;
    const b = bind.buttons;
    if (b) {
      for (let i = 0; i < b.length; i++) {
        const idx = b[i];
        if (idx >= 0 && idx < this._padButtons.length) v = Math.max(v, this._padButtons[idx]);
      }
    }
    if (bind.analog != null && bind.analog < this._padButtons.length) {
      const a = this._padButtons[bind.analog];
      const dz = this.options.triggerDeadzone;
      if (a > dz) v = Math.max(v, (a - dz) / (1 - dz));
    }
    return saturate(v);
  }

  /* ---------------------------------------------------------------- gamepad */

  _scanPads() {
    const pads = this._getPads();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) { this._adoptPad(p); return; }
    }
    this.hasGamepad = false;
    this.padIndex = -1;
  }

  _getPads() {
    try {
      const nav = globalThis.navigator;
      if (!nav || typeof nav.getGamepads !== 'function') return [];
      return nav.getGamepads() || [];
    } catch (_) {
      return [];
    }
  }

  _adoptPad(p) {
    this.padIndex = p.index;
    this.padId = p.id || '';
    this.padFamily = padFamily(this.padId);
    this.hasGamepad = true;
    this._padTouched = false;
    this.ctx?.bus?.emit?.('input:gamepad', { connected: true, id: this.padId, family: this.padFamily });
  }

  _onPadConnect(e) {
    if (e?.gamepad) this._adoptPad(e.gamepad);
  }

  _onPadDisconnect(e) {
    if (e?.gamepad && e.gamepad.index !== this.padIndex) return;
    this.hasGamepad = false;
    this.padIndex = -1;
    this._padButtons.fill(0);
    this._padAxes.fill(0);
    this._stickSteer = 0;
    this._setDevice('keyboard');
    this.ctx?.bus?.emit?.('input:gamepad', { connected: false, id: this.padId, family: this.padFamily });
  }

  _pollPad() {
    const pads = this._getPads();
    let pad = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (!pad || !pad.connected) {
      pad = null;
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) { this._adoptPad(pads[i]); pad = pads[i]; break; }
      }
    }
    if (!pad) {
      if (this.hasGamepad) this._onPadDisconnect(null);
      return;
    }
    this.hasGamepad = true;

    const prev = this._padPrev;
    const cur = this._padButtons;
    prev.set(cur);

    const btns = pad.buttons;
    const n = Math.min(cur.length, btns.length);
    let touched = false;
    for (let i = 0; i < n; i++) {
      const b = btns[i];
      const v = typeof b === 'object' ? (typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0)) : (b ? 1 : 0);
      cur[i] = v;
      if (v > 0.35) touched = true;
    }
    for (let i = n; i < cur.length; i++) cur[i] = 0;

    const ax = pad.axes;
    const m = Math.min(this._padAxes.length, ax.length);
    for (let i = 0; i < m; i++) this._padAxes[i] = typeof ax[i] === 'number' ? ax[i] : 0;
    for (let i = m; i < this._padAxes.length; i++) this._padAxes[i] = 0;

    this._stickSteer = this._radialX(PAD_STEER_AXIS_X, PAD_STEER_AXIS_Y);
    if (Math.abs(this._stickSteer) > 0.05) touched = true;
    if (touched) {
      this._padTouched = true;
      this._setDevice('gamepad');
    }

    // Rebinding listens for a button edge, not a held button.
    if (this._rebind && this._rebind.device === 'pad') {
      for (let i = 0; i < n; i++) {
        if (cur[i] > 0.6 && prev[i] <= 0.6) { this._completeRebind('pad', i); break; }
      }
    }
  }

  /**
   * Radial deadzone over an (x, y) stick pair, returning the rescaled x.
   * Deadzoning each axis on its own turns a round stick into a square one and
   * makes every diagonal read as full lock.
   */
  _radialX(ix, iy) {
    const o = this.options;
    const x = this._padAxes[ix] || 0;
    const y = this._padAxes[iy] || 0;
    const mag = Math.hypot(x, y);
    if (mag <= o.stickDeadzone) return 0;
    const outer = Math.max(o.stickDeadzone + 0.01, o.stickOuter);
    const scaled = Math.min(1, (mag - o.stickDeadzone) / (outer - o.stickDeadzone));
    // Expo keeps the first third of stick travel gentle so a small correction
    // at 100 u/s is possible without a 3-degree twitch of the thumb.
    const shaped = scaled * (1 - o.stickExpo) + scaled * scaled * scaled * o.stickExpo;
    return clamp((x / mag) * shaped, -1, 1);
  }

  /* ----------------------------------------------------------------- rumble */

  /**
   * @param {number} strong low-frequency motor, 0..1
   * @param {number} [weak] high-frequency motor, 0..1 (defaults to half strong)
   * @param {number} [ms] duration in milliseconds
   */
  rumble(strong, weak, ms = 180) {
    const s = saturate(strong) * saturate(this.options.rumble);
    if (!(s > 0.01) || !this.hasGamepad) return this;
    const w = weak == null ? s * 0.5 : saturate(weak) * saturate(this.options.rumble);
    const until = this._now + ms / 1000;
    // A bigger hit overrides a smaller one already playing; a smaller one only
    // extends the tail.
    if (s >= this._rumbleStrong || until > this._rumbleUntil) {
      this._rumbleStrong = Math.max(this._rumbleStrong, s);
      this._rumbleWeak = Math.max(this._rumbleWeak, w);
      this._rumbleUntil = Math.max(this._rumbleUntil, until);
      this._issueRumble(this._rumbleStrong, this._rumbleWeak, (this._rumbleUntil - this._now) * 1000);
    }
    return this;
  }

  _issueRumble(strong, weak, ms) {
    if (!(ms > 0)) return;
    const pad = this.padIndex >= 0 ? this._getPads()[this.padIndex] : null;
    if (!pad) return;
    try {
      const act = pad.vibrationActuator;
      if (act && typeof act.playEffect === 'function') {
        const p = act.playEffect('dual-rumble', {
          startDelay: 0,
          duration: Math.min(1500, Math.max(20, ms)),
          strongMagnitude: strong,
          weakMagnitude: weak,
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return;
      }
      const legacy = pad.hapticActuators && pad.hapticActuators[0];
      if (legacy && typeof legacy.pulse === 'function') {
        const p = legacy.pulse(Math.max(strong, weak), Math.min(1500, Math.max(20, ms)));
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) { /* haptics are a nicety, never a failure */ }
  }

  _pumpRumble(dt) {
    if (this._rumbleUntil > 0 && this._now >= this._rumbleUntil) {
      this._rumbleUntil = 0;
      this._rumbleStrong = 0;
      this._rumbleWeak = 0;
    }

    // Continuous texture: running wide onto grass or gravel buzzes the pad.
    // Re-issued on a slow cadence because playEffect cancels whatever is
    // playing, and re-issuing every frame produces a stutter, not a rumble.
    if (!this.hasGamepad) return;
    const player = this.ctx?.player;
    let want = 0;
    if (player && player.offTrack && (player.speed || 0) > 18 && !player.isAirborne) {
      want = saturate((player.speed - 18) / 70) * 0.32;
    }
    this._ambientRumble += (want - this._ambientRumble) * saturate(dt * 6);
    if (this._rumbleUntil > 0) return;
    if (this._ambientRumble > 0.02) {
      if (this._now - this._rumbleIssued > 0.18) {
        this._rumbleIssued = this._now;
        this._issueRumble(this._ambientRumble * 0.55, this._ambientRumble, 220);
      }
    } else if (this._rumbleIssued > 0) {
      this._rumbleIssued = -1;
      this._issueRumble(0, 0, 30);
    }
  }

  _onImpact(p) {
    const v = p?.vehicle || p?.a || null;
    const player = this.ctx?.player;
    if (player && v && v !== player) return;
    const mag = Math.abs(p?.impulse ?? p?.force ?? p?.relativeSpeed ?? 0);
    if (!(mag > 0)) return;
    // Impulses land roughly in 0..900 for a solid car-to-wall hit at speed.
    const s = saturate(mag / 420);
    this.rumble(0.25 + s * 0.75, 0.15 + s * 0.6, 90 + s * 240);
  }

  /* --------------------------------------------------------------- keyboard */

  _onKeyDown(e) {
    if (isTypingTarget(e.target)) return;

    if (this._rebind && this._rebind.device === 'key') {
      e.preventDefault();
      if (e.code === 'Escape') this.cancelRebind();
      else this._completeRebind('key', e.code);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (SWALLOW.has(e.code)) e.preventDefault();

    this._setDevice('keyboard');
    if (e.repeat) return;
    if (this._keys.has(e.code)) return;
    this._keys.add(e.code);

    if (!this.enabled) return;
    // Keyboard edges fire immediately rather than waiting for the next update:
    // a pause press must never be eaten by a long frame.
    for (const action of ACTION_LIST) {
      if (ACTIONS[action].kind !== 'event') continue;
      const list = this.bindings.keys[action];
      if (list && list.indexOf(e.code) >= 0) this._fire(action);
    }
  }

  _onKeyUp(e) {
    this._keys.delete(e.code);
  }

  _onBlur() {
    this._releaseAll();
  }

  _onPointerDown() {
    // Autoplay policy: the first gesture anywhere is the one chance to open
    // the audio graph. Cheap to try, harmless if audio is missing.
    try { this.ctx?.audio?.unlock?.(); } catch (_) { /* ignore */ }
  }

  _releaseAll() {
    this._keys.clear();
    this._held.clear();
    this._pressed.clear();
    this._steerRaw = 0;
    this._stickSteer = 0;
    this._stickActive = false;
    const raw = this.raw;
    raw.throttle = 0; raw.brake = 0; raw.handbrake = 0; raw.boost = 0; raw.steer = 0; raw.lookBack = 0;
    const c = this.controls;
    c.throttle = 0; c.brake = 0; c.handbrake = 0; c.boost = 0;
  }

  /* ------------------------------------------------------------------ events */

  _fire(action) {
    this._pressed.add(action);
    this.anyInputSince = this._now;
    const bus = this.ctx?.bus;

    switch (action) {
      case 'pause':
        bus?.emit?.('input:pause', { device: this.device });
        break;
      case 'photo':
        this.photoMode = !this.photoMode;
        bus?.emit?.('input:photo', { on: this.photoMode });
        break;
      case 'respawn':
        bus?.emit?.('input:respawn', { device: this.device });
        try { this.ctx?.player?.respawn?.(); } catch (_) { /* no track yet */ }
        break;
      case 'camera':
        bus?.emit?.('input:camera', { device: this.device });
        break;
      case 'restart':
        bus?.emit?.('input:restart', { device: this.device });
        break;
      case 'accept':
        bus?.emit?.('input:accept', { device: this.device });
        break;
      case 'back':
        bus?.emit?.('input:back', { device: this.device });
        break;
      default:
        break;
    }
    bus?.emit?.('input:action', { action, device: this.device });

    // Real input from a human retires any autopilot that was covering for them.
    if (action !== 'photo') {
      try { this.ctx?.race?.notifyPlayerInput?.(); } catch (_) { /* optional peer */ }
    }
  }

  _setDevice(device) {
    if (this.device === device) return;
    this.device = device;
    this.ctx?.bus?.emit?.('input:device', { device, family: this.padFamily, id: this.padId });
  }

  /* --------------------------------------------------------------- bindings */

  /** Every code bound to an action, for the options screen. */
  bindingsFor(action) {
    return {
      keys: (this.bindings.keys[action] || []).slice(),
      pad: this.bindings.pad[action] ? { ...this.bindings.pad[action] } : { buttons: [] },
    };
  }

  /** Bind a keyboard code (or pad button index) to an action slot. */
  bind(action, code, slot = 0, device = 'key') {
    if (!ACTIONS[action]) return this;
    if (device === 'key') {
      const list = this.bindings.keys[action] || (this.bindings.keys[action] = []);
      // A code may only drive one action, or a rebind quietly doubles up.
      for (const other of ACTION_LIST) {
        if (other === action) continue;
        const l = this.bindings.keys[other];
        if (!l) continue;
        const i = l.indexOf(code);
        if (i >= 0) l.splice(i, 1);
      }
      list[clamp(slot, 0, 1)] = code;
    } else {
      const b = this.bindings.pad[action] || (this.bindings.pad[action] = { buttons: [] });
      // `analog` is left alone on purpose: the triggers are throttle and brake
      // on every pad ever made, and nobody rebinding a face button means to
      // give that up.
      b.buttons = [code];
    }
    this.save();
    this.ctx?.bus?.emit?.('input:bindings', { action, code, device });
    return this;
  }

  /** Listen for the next key (or pad button) and bind it to `action`. */
  beginRebind(action, slot = 0, device = 'key') {
    if (!ACTIONS[action]) return this;
    this._rebind = { action, slot, device };
    this.ctx?.bus?.emit?.('input:rebindStart', { action, slot, device });
    return this;
  }

  cancelRebind() {
    if (!this._rebind) return this;
    const r = this._rebind;
    this._rebind = null;
    this.ctx?.bus?.emit?.('input:rebindEnd', { ...r, cancelled: true });
    return this;
  }

  _completeRebind(device, code) {
    const r = this._rebind;
    this._rebind = null;
    if (!r) return;
    this.bind(r.action, code, r.slot, device);
    this.ctx?.bus?.emit?.('input:rebindEnd', { ...r, code, cancelled: false });
  }

  resetBindings() {
    this.bindings.keys = cloneBindings(DEFAULT_KEYS);
    this.bindings.pad = clonePad(DEFAULT_PAD);
    this.save();
    this.ctx?.bus?.emit?.('input:bindings', { reset: true });
    return this;
  }

  /* ----------------------------------------------------------------- glyphs */

  /**
   * A short display string for the currently active device, so the HUD can
   * print "SHIFT" or "RB" without knowing anything about bindings.
   */
  glyph(action) {
    if (this.device === 'gamepad') {
      const b = this.bindings.pad[action];
      const table = PAD_GLYPHS[this.padFamily] || PAD_GLYPHS.generic;
      if (b) {
        if (b.analog != null && table[b.analog]) return table[b.analog];
        if (b.buttons && b.buttons.length && table[b.buttons[0]]) return table[b.buttons[0]];
      }
      if (action === 'steerLeft' || action === 'steerRight') return 'LS';
      return '?';
    }
    const list = this.bindings.keys[action];
    const code = list && list[0];
    return keyGlyph(code);
  }

  /** Both glyphs for a two-slot action, e.g. "W / ↑". */
  glyphs(action) {
    if (this.device === 'gamepad') return this.glyph(action);
    const list = this.bindings.keys[action] || [];
    return list.map(keyGlyph).filter(Boolean).join(' / ');
  }

  /* ------------------------------------------------------------ persistence */

  load() {
    const store = safeStorage();
    if (!store) return this;
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) return this;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return this;
      if (data.keys && typeof data.keys === 'object') {
        for (const action of ACTION_LIST) {
          const v = data.keys[action];
          if (Array.isArray(v) && v.every((c) => typeof c === 'string')) {
            this.bindings.keys[action] = v.slice(0, 2);
          }
        }
      }
      if (data.pad && typeof data.pad === 'object') {
        for (const action of ACTION_LIST) {
          const v = data.pad[action];
          if (!v || typeof v !== 'object') continue;
          const buttons = Array.isArray(v.buttons) ? v.buttons.filter((n) => Number.isInteger(n) && n >= 0 && n < 24) : [];
          const out = { buttons };
          if (Number.isInteger(v.analog) && v.analog >= 0 && v.analog < 24) out.analog = v.analog;
          this.bindings.pad[action] = out;
        }
      }
      if (data.options && typeof data.options === 'object') {
        for (const k in this.options) {
          const v = data.options[k];
          if (typeof v === typeof this.options[k] && (typeof v !== 'number' || Number.isFinite(v))) {
            this.options[k] = v;
          }
        }
      }
    } catch (err) {
      console.warn('[Input] ignoring unreadable saved bindings', err);
    }
    return this;
  }

  save() {
    const store = safeStorage();
    if (!store) return this;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({
        keys: this.bindings.keys,
        pad: this.bindings.pad,
        options: this.options,
      }));
    } catch (err) {
      console.warn('[Input] could not persist bindings', err);
    }
    return this;
  }

  /* ------------------------------------------------------------------- misc */

  /** Compact snapshot for the debug overlay. */
  snapshot() {
    return {
      device: this.device,
      pad: this.hasGamepad ? `${this.padFamily}:${this.padId.slice(0, 28)}` : 'none',
      throttle: +this.controls.throttle.toFixed(2),
      brake: +this.controls.brake.toFixed(2),
      steer: +this.controls.steer.toFixed(2),
      handbrake: +this.controls.handbrake.toFixed(2),
      boost: +this.controls.boost.toFixed(2),
    };
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      window.removeEventListener('gamepadconnected', this._onPadConnect);
      window.removeEventListener('gamepaddisconnected', this._onPadDisconnect);
      window.removeEventListener('pointerdown', this._onPointerDown);
    }
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    this._issueRumble(0, 0, 30);
    this._releaseAll();
    return this;
  }
}

/* ------------------------------------------------------------------ statics */

function keyGlyph(code) {
  if (!code) return '';
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  return code.toUpperCase();
}

function cloneBindings(src) {
  const out = {};
  for (const k in src) out[k] = src[k].slice();
  return out;
}

function clonePad(src) {
  const out = {};
  for (const k in src) {
    const v = src[k];
    out[k] = v.analog != null ? { buttons: v.buttons.slice(), analog: v.analog } : { buttons: v.buttons.slice() };
  }
  return out;
}

export function makeInput(ctx) { return new Input(ctx); }

export default Input;
