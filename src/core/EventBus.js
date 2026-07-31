// core/EventBus.js — the nervous system.
//
// Synchronous pub/sub with three properties the rest of the game depends on:
//
//   1. Zero allocation on the hot path. `emit` walks a plain array and passes
//      the payload through untouched; a per-frame `emit('vehicle:slip', v)` at
//      120 Hz must not produce garbage.
//   2. Safe re-entrancy. Handlers routinely subscribe or unsubscribe while an
//      event is dispatching (a system tearing itself down inside a
//      'race:finish' handler, say). Structural changes are deferred until the
//      outermost dispatch unwinds; removals take effect immediately via a
//      tombstone flag so a dead handler is never called.
//   3. Fault isolation. One throwing listener must not stop the others or kill
//      the frame — a broken peer module degrades to "that feature is missing",
//      never "the screen is black".

/** Canonical event names. Strings are not validated — this is a shared vocabulary,
 *  not an enum — but using these keeps peers from inventing three spellings of
 *  the same idea. */
export const Events = Object.freeze({
  // engine / lifecycle
  BOOT_PROGRESS: 'boot:progress',
  ENGINE_START: 'engine:start',
  ENGINE_STOP: 'engine:stop',
  ENGINE_PAUSE: 'engine:pause',
  ENGINE_RESUME: 'engine:resume',
  ENGINE_OVERLOAD: 'engine:overload',
  SYSTEM_ERROR: 'system:error',
  RESIZE: 'resize',
  GL_LOST: 'gl:lost',
  GL_RESTORED: 'gl:restored',

  // settings
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_APPLIED: 'settings:applied',
  QUALITY_CHANGED: 'quality:changed',

  // race
  RACE_COUNTDOWN: 'race:countdown',
  RACE_START: 'race:start',
  RACE_LAP: 'race:lap',
  RACE_CHECKPOINT: 'race:checkpoint',
  RACE_POSITION: 'race:position',
  RACE_FINISH: 'race:finish',
  RACE_RESET: 'race:reset',

  // vehicle
  VEHICLE_SPAWN: 'vehicle:spawn',
  VEHICLE_RESPAWN: 'vehicle:respawn',
  VEHICLE_LAND: 'vehicle:land',
  VEHICLE_JUMP: 'vehicle:jump',
  VEHICLE_DRIFT_START: 'vehicle:driftStart',
  VEHICLE_DRIFT_END: 'vehicle:driftEnd',
  VEHICLE_SURFACE: 'vehicle:surface',
  VEHICLE_BOOST: 'vehicle:boost',

  // physics / fx
  COLLISION: 'collision',
  IMPACT: 'impact',
  SHAKE: 'shake',

  // ui
  UI_MENU: 'ui:menu',
  UI_SELECT: 'ui:select',
  UI_BACK: 'ui:back',

  // debug
  DEBUG_TOGGLE: 'debug:toggle',
  DEBUG_FREECAM: 'debug:freecam',
  DEBUG_COLLIDERS: 'debug:colliders',
});

let _uid = 0;

export class EventBus {
  constructor(opts = {}) {
    /** @type {Map<string, Array<object>>} */
    this._map = new Map();
    /** wildcard listeners, called for every event */
    this._any = [];
    /** dispatch nesting depth; > 0 means "do not restructure the arrays" */
    this._depth = 0;
    /** subscriptions added while dispatching, applied on unwind */
    this._pending = [];
    /** lists that contain tombstones and need compacting on unwind */
    this._dirty = new Set();
    /** deferred payloads, delivered by flushQueue() */
    this._queue = [];
    /** listeners that threw, so we can stop spamming the console */
    this._blamed = new Map();
    this.warnLimit = opts.warnLimit ?? 4;
    /** set true to console.debug every dispatch (Debug panel toggles this) */
    this.trace = false;
    this.traceFilter = null;
    /** rolling counters for the debug overlay */
    this.counts = new Map();
    this.enabled = true;
  }

  // ---------------------------------------------------------------- subscribe

  /**
   * @param {string|string[]} type  event name, or '*' for every event
   * @param {(payload:any, type:string)=>void} fn
   * @param {{ once?:boolean, priority?:number, scope?:any }} [opts]
   *        higher priority runs first; ties keep insertion order.
   * @returns {() => void} unsubscribe
   */
  on(type, fn, opts) {
    if (typeof fn !== 'function') return noop;
    if (Array.isArray(type)) {
      const offs = type.map((t) => this.on(t, fn, opts));
      return () => { for (let i = 0; i < offs.length; i++) offs[i](); };
    }
    const l = {
      id: ++_uid,
      type,
      fn,
      scope: opts?.scope ?? null,
      once: !!opts?.once,
      priority: opts?.priority ?? 0,
      dead: false,
      calls: 0,
    };
    if (this._depth > 0) this._pending.push(l);
    else this._insert(l);
    return () => this._kill(l);
  }

  /** One-shot subscription. */
  once(type, fn, opts) {
    return this.on(type, fn, { ...opts, once: true });
  }

  /** Subscribe to every event. Handler receives (payload, type). */
  onAny(fn, opts) {
    return this.on('*', fn, opts);
  }

  /**
   * Remove by (type, fn) pair, or every listener whose `scope` matches.
   * `off(scopeObject)` with a single non-string argument removes by scope —
   * the cheapest way for a system to unhook itself in dispose().
   */
  off(type, fn) {
    if (type && typeof type !== 'string' && !Array.isArray(type)) return this.offScope(type);
    if (Array.isArray(type)) { for (const t of type) this.off(t, fn); return this; }
    const list = type === '*' ? this._any : this._map.get(type);
    if (list) this._sweep(list, (l) => fn === undefined || l.fn === fn);
    for (let i = 0; i < this._pending.length; i++) {
      const l = this._pending[i];
      if (l.type === type && (fn === undefined || l.fn === fn)) l.dead = true;
    }
    return this;
  }

  /** Remove everything registered with `{ scope }`. */
  offScope(scope) {
    if (scope == null) return this;
    const match = (l) => l.scope === scope;
    this._sweep(this._any, match);
    for (const list of this._map.values()) this._sweep(list, match);
    for (let i = 0; i < this._pending.length; i++) {
      if (this._pending[i].scope === scope) this._pending[i].dead = true;
    }
    return this;
  }

  /** Drop every listener for a type, or the whole bus when called bare. */
  clear(type) {
    if (type === undefined) {
      this._map.clear();
      this._any.length = 0;
      this._pending.length = 0;
      this._queue.length = 0;
      this._dirty.clear();
      return this;
    }
    const list = type === '*' ? this._any : this._map.get(type);
    if (list) this._sweep(list, () => true);
    return this;
  }

  /**
   * Tombstone every matching listener in one pass, then compact once. Killing
   * and compacting inside the same walk would shift entries under the index
   * and silently skip listeners.
   */
  _sweep(list, match) {
    let hit = false;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (!l.dead && match(l)) { l.dead = true; hit = true; }
    }
    if (!hit) return;
    if (this._depth > 0) this._dirty.add(list);
    else compact(list);
  }

  // ------------------------------------------------------------------ publish

  /**
   * Dispatch synchronously. Listener exceptions are caught and reported; the
   * remaining listeners always run.
   */
  emit(type, payload) {
    if (!this.enabled) return this;
    this.counts.set(type, (this.counts.get(type) || 0) + 1);
    if (this.trace && (!this.traceFilter || this.traceFilter.test(type))) {
      console.debug('[bus]', type, payload);
    }
    this._depth++;
    try {
      const list = this._map.get(type);
      if (list !== undefined) {
        // Snapshot the length: listeners added during dispatch are queued in
        // _pending and therefore invisible here, which is the behaviour callers
        // expect (subscribing from a handler must not fire for this same event).
        const n = list.length;
        for (let i = 0; i < n; i++) {
          const l = list[i];
          if (l.dead) continue;
          if (l.once) { l.dead = true; this._dirty.add(list); }
          this._invoke(l, payload, type);
        }
      }
      const any = this._any;
      if (any.length > 0) {
        const n = any.length;
        for (let i = 0; i < n; i++) {
          const l = any[i];
          if (l.dead) continue;
          if (l.once) { l.dead = true; this._dirty.add(any); }
          this._invoke(l, payload, type);
        }
      }
    } finally {
      this._depth--;
      if (this._depth === 0) this._settle();
    }
    return this;
  }

  /**
   * Defer a payload until the next flushQueue() (Engine calls it once per
   * frame, after lateUpdate). Use for anything raised from inside a physics
   * substep that wants to be handled exactly once per rendered frame.
   */
  queue(type, payload) {
    this._queue.push(type, payload);
    return this;
  }

  /** Deliver everything accumulated by queue(). Re-entrant safe. */
  flushQueue() {
    const q = this._queue;
    if (q.length === 0) return this;
    // Swap out first: handlers are allowed to queue more work for next frame.
    const batch = q.slice();
    q.length = 0;
    for (let i = 0; i < batch.length; i += 2) this.emit(batch[i], batch[i + 1]);
    return this;
  }

  /** Promise that resolves with the next payload of `type`. */
  waitFor(type, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      const off = this.once(type, (p) => {
        if (timer) clearTimeout(timer);
        resolve(p);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => { off(); reject(new Error('EventBus.waitFor timeout: ' + type)); }, timeoutMs);
      }
    });
  }

  // ----------------------------------------------------------------- introspect

  /** Live listener count, total or for one type. */
  count(type) {
    if (type === undefined) {
      let n = this._any.filter(alive).length;
      for (const list of this._map.values()) n += list.filter(alive).length;
      return n;
    }
    const list = type === '*' ? this._any : this._map.get(type);
    return list ? list.filter(alive).length : 0;
  }

  /** [{ type, listeners, emitted }] sorted by traffic — for the debug panel. */
  inspect() {
    const rows = [];
    for (const [type, list] of this._map) {
      rows.push({ type, listeners: list.filter(alive).length, emitted: this.counts.get(type) || 0 });
    }
    for (const [type, emitted] of this.counts) {
      if (!this._map.has(type)) rows.push({ type, listeners: 0, emitted });
    }
    rows.sort((a, b) => b.emitted - a.emitted);
    return rows;
  }

  resetCounts() { this.counts.clear(); return this; }

  dispose() {
    this.clear();
    this._blamed.clear();
    this.counts.clear();
  }

  // -------------------------------------------------------------------- internal

  _insert(l) {
    const key = l.type;
    let list;
    if (key === '*') list = this._any;
    else {
      list = this._map.get(key);
      if (list === undefined) { list = []; this._map.set(key, list); }
    }
    if (l.priority === 0) {
      list.push(l);
    } else {
      // Stable insert: walk back over anything with >= priority.
      let i = list.length;
      while (i > 0 && list[i - 1].priority < l.priority) i--;
      list.splice(i, 0, l);
    }
  }

  _kill(l) {
    if (l.dead) return;
    l.dead = true;
    const list = l.type === '*' ? this._any : this._map.get(l.type);
    if (!list) return;
    if (this._depth > 0) this._dirty.add(list);
    else compact(list);
  }

  _settle() {
    if (this._dirty.size > 0) {
      for (const list of this._dirty) compact(list);
      this._dirty.clear();
    }
    if (this._pending.length > 0) {
      const pending = this._pending;
      this._pending = [];
      for (let i = 0; i < pending.length; i++) {
        if (!pending[i].dead) this._insert(pending[i]);
      }
    }
  }

  _invoke(l, payload, type) {
    l.calls++;
    try {
      l.fn(payload, type);
    } catch (err) {
      const n = (this._blamed.get(l.fn) || 0) + 1;
      this._blamed.set(l.fn, n);
      if (n <= this.warnLimit) {
        console.error(`[EventBus] listener for "${type}" threw` + (n === this.warnLimit ? ' (further reports suppressed)' : ''), err);
      }
      // Report, but never recurse into our own error channel.
      if (type !== 'bus:error') {
        try { this.emit('bus:error', { type, error: err, listener: l.fn }); } catch (_) { /* give up quietly */ }
      }
    }
  }
}

function alive(l) { return !l.dead; }
function noop() {}

function compact(list) {
  let w = 0;
  for (let r = 0; r < list.length; r++) {
    const l = list[r];
    if (!l.dead) { if (w !== r) list[w] = l; w++; }
  }
  list.length = w;
}

/** Convenience factory so callers do not have to import the class. */
export function makeBus(opts) {
  return new EventBus(opts);
}

/** Process-wide fallback bus. main.js should still create its own and put it on
 *  ctx; this exists so a module can emit diagnostics before ctx is wired. */
export const bus = new EventBus();

export default EventBus;
