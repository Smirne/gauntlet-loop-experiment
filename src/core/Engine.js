// core/Engine.js — the beating heart.
//
// One requestAnimationFrame loop drives everything:
//
//   fixedUpdate  exactly 1/Settings.physics.fixedHz seconds (120 Hz), run 0..5
//                times per frame from an accumulator. Physics and vehicle
//                dynamics live here so handling is identical at 30 fps and at
//                144 fps.
//   update       once per rendered frame, variable dt clamped to 50 ms.
//   lateUpdate   after every update, so cameras and the HUD read final state.
//   render       composer if there is one, plain renderer otherwise.
//
// Everything a system does is wrapped: a peer that throws gets logged, then
// counted, then disabled. A broken module degrades to a missing feature, never
// to a black screen — which is the difference between "the smoke is gone" and
// "the game does not boot".
//
// Capture.js calls engine.renderFrame(dt) and engine.onResize(w, h) directly,
// so both are safe to call out of band: renderFrame only renders (it never
// steps simulation), and onResize never touches the renderer's own size — the
// caller owns that.

import { Settings, resolveRenderer } from './Settings.js';
import { EventBus, Events } from './EventBus.js';

const perfNow = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

const HISTORY = 180;          // frames kept for the debug frame-time graph
const ERROR_LIMIT = 8;        // throws before a system is switched off
const SPIRAL_TRIP = 30;       // consecutive overrun frames before we shout

export class Engine {
  /**
   * @param {object} ctx the shared context. Engine attaches itself as
   *   ctx.engine and creates ctx.time / ctx.bus / ctx.settings if missing.
   *   ctx.renderer, ctx.scene, ctx.camera and ctx.composer may be assigned
   *   later — everything is resolved lazily.
   */
  constructor(ctx = {}) {
    this.ctx = ctx;
    ctx.engine = this;

    this.bus = ctx.bus || (ctx.bus = new EventBus());
    this.settings = ctx.settings || (ctx.settings = Settings);

    // time is shared by reference: systems may cache it.
    const t = ctx.time || (ctx.time = {});
    t.elapsed = t.elapsed || 0;         // scaled seconds since start
    t.unscaled = t.unscaled || 0;       // wall-clock seconds since start
    t.dt = 0;                           // this frame's scaled delta
    t.unscaledDt = 0;
    t.fixedDt = 1 / Settings.physics.fixedHz;
    t.fixedElapsed = t.fixedElapsed || 0;
    t.frame = t.frame || 0;
    t.alpha = 0;                        // leftover accumulator / fixedDt
    t.scale = 1;
    t.paused = false;
    this.time = t;

    /** @type {object[]} the system objects, in registration order */
    this.systems = [];
    /** @type {object[]} bookkeeping records, parallel to systems */
    this.registry = [];
    this._byName = new Map();

    this.running = false;
    this.paused = false;
    this._pauseReasons = new Set();
    this.contextLost = false;
    this.profiling = true;
    this.timeScale = 1;

    this._raf = 0;
    this._last = 0;
    this._accum = 0;
    this._spiral = 0;
    this._initialized = false;
    this._initPromise = null;
    this._pendingResize = null;
    this._disposed = false;
    this._observedCanvas = null;
    this._ro = null;
    this._renderBlamed = false;

    this.width = 1;
    this.height = 1;

    this.fixedDt = 1 / Settings.physics.fixedHz;

    this.stats = {
      fps: 0,
      frameMs: 0,      // wall clock between frames
      cpuMs: 0,        // our own work inside the frame
      fixedMs: 0,
      updateMs: 0,
      lateMs: 0,
      renderMs: 0,
      steps: 0,
      droppedSteps: 0,
      overloads: 0,
      frame: 0,
      alpha: 0,
      calls: 0,
      triangles: 0,
      programs: 0,
      geometries: 0,
      textures: 0,
    };

    /** ring buffer of raw frame times in ms, for the debug graph */
    this.frameHistory = new Float32Array(HISTORY);
    this.frameHistoryIndex = 0;

    this._fpsFrames = 0;
    this._fpsSince = 0;

    this._tick = this._tick.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);

    this._installObservers();
    this.measure();
  }

  /* ------------------------------------------------------------- accessors */

  /** The real THREE.WebGLRenderer, unwrapped from A2's Renderer if needed. */
  get renderer() { return resolveRenderer(this.ctx); }
  get scene() { return this.ctx.scene || null; }
  get camera() { return this.ctx.camera || null; }
  get composer() { return this.ctx.composer || null; }

  get canvas() {
    return this.ctx.canvas
      || this.renderer?.domElement
      || (typeof document !== 'undefined' ? document.getElementById('stage') : null)
      || null;
  }

  /* --------------------------------------------------------- system registry */

  /**
   * Register a system. Order matters: it is the order every phase runs in.
   * Accepts a single system or an array.
   */
  add(system) {
    if (Array.isArray(system)) { for (const s of system) this.add(s); return system; }
    if (!system || typeof system !== 'object') return system;
    if (this._byName.has(system.name) && this._byName.get(system.name).sys === system) return system;

    const name = system.name || `system${this.registry.length}`;
    const rec = {
      sys: system,
      name,
      enabled: true,
      errors: 0,
      order: this.registry.length,
      ms: { init: 0, fixed: 0, update: 0, late: 0, total: 0 },
      acc: { fixed: 0, update: 0, late: 0 },
    };
    if (this._byName.has(name)) {
      console.warn(`[Engine] two systems are both called "${name}" — get('${name}') will return the newer one`);
    }
    this.registry.push(rec);
    this.systems.push(system);
    this._byName.set(name, rec);

    if (this._initialized && typeof system.init === 'function') {
      // Registered after boot (a track reload, say) — bring it up on its own.
      Promise.resolve()
        .then(() => system.init(this.ctx))
        .catch((err) => this._systemError(rec, 'init', err));
    }
    return system;
  }

  /** Alias — reads better in main.js next to a long list of constructors. */
  register(system) { return this.add(system); }

  /** Register and await its init(). */
  async addAndInit(system) {
    this.add(system);
    if (typeof system?.init === 'function') {
      try { await system.init(this.ctx); }
      catch (err) { this._systemError(this._byName.get(system.name), 'init', err); }
    }
    return system;
  }

  remove(system, { dispose = true } = {}) {
    const i = this.systems.indexOf(system);
    if (i < 0) return false;
    const rec = this.registry[i];
    this.systems.splice(i, 1);
    this.registry.splice(i, 1);
    if (this._byName.get(rec.name) === rec) this._byName.delete(rec.name);
    for (let k = 0; k < this.registry.length; k++) this.registry[k].order = k;
    if (dispose) {
      try { system.dispose?.(); }
      catch (err) { console.warn(`[Engine] ${rec.name}.dispose() threw`, err); }
    }
    return true;
  }

  /** Look a system up by its `name` field. */
  get(name) { return this._byName.get(name)?.sys || null; }

  has(name) { return this._byName.has(name); }

  setEnabled(name, on) {
    const rec = this._byName.get(name);
    if (rec) rec.enabled = !!on;
    return this;
  }

  /* ------------------------------------------------------------------- boot */

  /**
   * Run every system's init() in registration order, awaiting each. Failures
   * are contained: the system is reported and skipped, boot continues.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this._ensureCanvasObservers();
      const total = this.registry.length;
      for (let i = 0; i < total; i++) {
        const rec = this.registry[i];
        const t0 = perfNow();
        try {
          if (typeof rec.sys.init === 'function') await rec.sys.init(this.ctx);
        } catch (err) {
          this._systemError(rec, 'init', err);
        }
        rec.ms.init = perfNow() - t0;
        this.bus.emit(Events.BOOT_PROGRESS, {
          index: i + 1, total, name: rec.name, ms: rec.ms.init,
        });
      }
      this._initialized = true;
      // Now that the renderer certainly exists, push settings into it.
      try { Settings.apply(this.ctx); } catch (err) { console.warn('[Engine] settings apply failed', err); }
      this.measure();
      return this;
    })();
    return this._initPromise;
  }

  /* ------------------------------------------------------------------- loop */

  start() {
    if (this.running || this._disposed) return this;
    this._ensureCanvasObservers();
    this.running = true;
    this._last = perfNow();
    this._accum = 0;
    this._fpsSince = this._last;
    this._fpsFrames = 0;
    this._raf = requestAnimationFrame(this._tick);
    this.bus.emit(Events.ENGINE_START, this);
    return this;
  }

  stop() {
    if (!this.running) return this;
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.bus.emit(Events.ENGINE_STOP, this);
    return this;
  }

  /**
   * Freeze simulation. Rendering and update()/lateUpdate() keep running so
   * menus, the HUD and the debug overlay stay alive — only the fixed-step
   * accumulator stops being fed, which is what actually freezes the world.
   * Reason-counted: pause('menu') and pause('hidden') do not cancel each other.
   */
  pause(reason = 'user') {
    const was = this.paused;
    this._pauseReasons.add(reason);
    this.paused = true;
    this.time.paused = true;
    this._accum = 0;
    if (!was) this.bus.emit(Events.ENGINE_PAUSE, reason);
    return this;
  }

  resume(reason = 'user') {
    this._pauseReasons.delete(reason);
    if (this._pauseReasons.size > 0) return this;
    if (!this.paused) return this;
    this.paused = false;
    this.time.paused = false;
    // Do not let the time spent paused arrive as one giant catch-up burst.
    this._last = perfNow();
    this._accum = 0;
    this.bus.emit(Events.ENGINE_RESUME, reason);
    return this;
  }

  togglePause(reason = 'user') {
    return this.paused ? this.resume(reason) : this.pause(reason);
  }

  /** Advance exactly one fixed step while paused. */
  stepOnce() {
    const fdt = this.fixedDt;
    const t = this.time;
    t.dt = fdt;
    t.unscaledDt = fdt;
    t.fixedDt = fdt;
    t.elapsed += fdt;
    t.unscaled += fdt;
    t.fixedElapsed += fdt;
    t.frame++;
    t.alpha = 0;
    this._runFixed(fdt);
    this._runPhase('update', fdt);
    this._runPhase('lateUpdate', fdt);
    this.bus.flushQueue?.();
    this.renderFrame(fdt);
    return this;
  }

  setFixedHz(hz) {
    const h = Math.max(20, Math.min(480, hz | 0));
    if (Settings.physics.fixedHz !== h) Settings.physics.fixedHz = h;
    this.fixedDt = 1 / h;
    this.time.fixedDt = this.fixedDt;
    return this;
  }

  setTimeScale(s) {
    this.timeScale = Math.max(0, s);
    return this;
  }

  _tick(now) {
    // Queue the next frame before doing any work: if something below throws in
    // a way we failed to contain, the loop still survives.
    if (this.running) this._raf = requestAnimationFrame(this._tick);
    if (this._disposed) return;

    const cpuStart = perfNow();

    if (this._pendingResize) this._flushResize();

    let wall = (now - this._last) / 1000;
    this._last = now;
    if (!(wall > 0)) wall = 0;
    const maxDt = Settings.physics.maxRenderDt || 0.05;
    // A long stall (tab switch, GC, breakpoint) is dropped, not simulated.
    const dt = wall > maxDt ? maxDt : wall;

    const scale = this.timeScale * (Settings.physics.timeScale || 1);
    const sdt = dt * scale;

    const t = this.time;
    t.unscaledDt = dt;
    t.dt = sdt;
    t.scale = scale;
    t.unscaled += dt;
    t.elapsed += sdt;
    t.frame++;
    t.fixedDt = this.fixedDt;

    // ---- fixed steps
    let steps = 0;
    let fixedMs = 0;
    if (!this.paused && !this.contextLost) {
      this._accum += sdt;
      const fdt = this.fixedDt;
      const maxSteps = Math.max(1, Math.min(20, Settings.physics.maxCatchUpSteps || 5));
      const f0 = perfNow();
      while (this._accum >= fdt && steps < maxSteps) {
        this._accum -= fdt;
        t.fixedElapsed += fdt;
        this._runFixed(fdt);
        steps++;
      }
      fixedMs = perfNow() - f0;

      // Spiral-of-death guard: if we still owe time after the cap, the machine
      // cannot keep up. Forgive the debt rather than fall further behind every
      // frame until the tab dies.
      if (this._accum >= fdt) {
        this.stats.droppedSteps += Math.floor(this._accum / fdt);
        this._accum = 0;
        this._spiral++;
        if (this._spiral >= SPIRAL_TRIP) {
          this._spiral = 0;
          this.stats.overloads++;
          this.bus.emit(Events.ENGINE_OVERLOAD, {
            fps: this.stats.fps, frameMs: this.stats.frameMs, dropped: this.stats.droppedSteps,
          });
        }
      } else if (this._spiral > 0) {
        this._spiral--;
      }
      t.alpha = this._accum / fdt;
    } else {
      t.alpha = 0;
    }

    // ---- variable steps
    const u0 = perfNow();
    this._runPhase('update', sdt);
    const u1 = perfNow();
    this._runPhase('lateUpdate', sdt);
    const u2 = perfNow();

    this.bus.flushQueue?.();

    // ---- present
    this.renderFrame(sdt);
    const r1 = perfNow();

    // ---- bookkeeping
    const s = this.stats;
    s.steps = steps;
    s.frame = t.frame;
    s.alpha = t.alpha;
    s.fixedMs = ema(s.fixedMs, fixedMs);
    s.updateMs = ema(s.updateMs, u1 - u0);
    s.lateMs = ema(s.lateMs, u2 - u1);
    s.renderMs = ema(s.renderMs, r1 - u2);
    s.frameMs = ema(s.frameMs, wall * 1000);
    s.cpuMs = ema(s.cpuMs, r1 - cpuStart);

    this.frameHistory[this.frameHistoryIndex] = wall * 1000;
    this.frameHistoryIndex = (this.frameHistoryIndex + 1) % HISTORY;

    this._fpsFrames++;
    const since = now - this._fpsSince;
    if (since >= 500) {
      s.fps = (this._fpsFrames * 1000) / since;
      this._fpsFrames = 0;
      this._fpsSince = now;
      const info = this.renderer?.info;
      if (info) {
        s.calls = info.render.calls;
        s.triangles = info.render.triangles;
        s.programs = info.programs ? info.programs.length : 0;
        s.geometries = info.memory.geometries;
        s.textures = info.memory.textures;
      }
    }

    // Smooth per-system numbers once per frame.
    if (this.profiling) {
      const reg = this.registry;
      for (let i = 0; i < reg.length; i++) {
        const rec = reg[i];
        rec.ms.fixed = ema(rec.ms.fixed, rec.acc.fixed);
        rec.ms.update = ema(rec.ms.update, rec.acc.update);
        rec.ms.late = ema(rec.ms.late, rec.acc.late);
        rec.ms.total = rec.ms.fixed + rec.ms.update + rec.ms.late;
        rec.acc.fixed = 0; rec.acc.update = 0; rec.acc.late = 0;
      }
    }
  }

  _runFixed(fdt) {
    const reg = this.registry;
    const ctx = this.ctx;
    const prof = this.profiling;
    for (let i = 0; i < reg.length; i++) {
      const rec = reg[i];
      if (!rec.enabled) continue;
      const fn = rec.sys.fixedUpdate;
      if (typeof fn !== 'function') continue;
      if (prof) {
        const t0 = perfNow();
        try { fn.call(rec.sys, fdt, ctx); } catch (err) { this._systemError(rec, 'fixedUpdate', err); }
        rec.acc.fixed += perfNow() - t0;
      } else {
        try { fn.call(rec.sys, fdt, ctx); } catch (err) { this._systemError(rec, 'fixedUpdate', err); }
      }
    }
  }

  /**
   * Run update + lateUpdate with dt = 0, advancing nothing.
   *
   * For out-of-band renders — captures, thumbnails, anything that repositions
   * the camera and then calls renderFrame() directly. Those never run a phase,
   * so every system that fits itself to the camera in lateUpdate is still
   * fitted to whatever camera the last real frame used.
   *
   * That is not hypothetical: it cost this project four rounds of critique.
   * Lighting._fitToCamera() lives in lateUpdate (deliberately — the director
   * moves the camera there), so the review captures rendered shots 2-4 with the
   * shadow cascades still fitted to the PREVIOUS shot's camera. On the
   * establishing wide that meant cascade 2 was centred 427 u below the tabletop,
   * left over from a macro camera 27 u from one car, and every prop on the table
   * — six boxes, a mug, a bowl — stood in the frame with no cast shadow at all.
   * A critic A/B'd it at the identical camera and sim state and proved it.
   *
   * dt = 0 is the point: a system that integrates by dt does nothing, while a
   * system that re-fits to current state does its whole job.
   */
  syncSystems() {
    this._runPhase('update', 0);
    this._runPhase('lateUpdate', 0);
    return this;
  }

  _runPhase(method, dt) {
    const reg = this.registry;
    const ctx = this.ctx;
    const prof = this.profiling;
    const key = method === 'update' ? 'update' : 'late';
    for (let i = 0; i < reg.length; i++) {
      const rec = reg[i];
      if (!rec.enabled) continue;
      const fn = rec.sys[method];
      if (typeof fn !== 'function') continue;
      if (prof) {
        const t0 = perfNow();
        try { fn.call(rec.sys, dt, ctx); } catch (err) { this._systemError(rec, method, err); }
        rec.acc[key] += perfNow() - t0;
      } else {
        try { fn.call(rec.sys, dt, ctx); } catch (err) { this._systemError(rec, method, err); }
      }
    }
  }

  _systemError(rec, method, err) {
    if (!rec) { console.error('[Engine] error in unregistered system', err); return; }
    rec.errors++;
    if (rec.errors <= 3) {
      console.error(`[Engine] ${rec.name}.${method}() threw (${rec.errors})`, err);
    }
    if (rec.errors === ERROR_LIMIT) {
      rec.enabled = false;
      console.error(`[Engine] disabling system "${rec.name}" after ${ERROR_LIMIT} errors`);
    }
    this.bus.emit(Events.SYSTEM_ERROR, { name: rec.name, method, error: err, errors: rec.errors, disabled: !rec.enabled });
  }

  /* ----------------------------------------------------------------- render */

  /**
   * Render exactly one frame. No simulation, no time advance — Capture.js
   * calls this twice back to back at an off-screen resolution and must get two
   * identical, settled frames.
   */
  renderFrame(dt = this.time.dt || 1 / 60) {
    const gl = this.renderer;
    if (!gl || this.contextLost) return this;

    // Whole-frame draw-call stats: with a post chain, three would otherwise
    // reset the counters at every pass and we would only ever see the last one.
    if (gl.info) {
      if (gl.info.autoReset) gl.info.autoReset = false;
      gl.info.reset();
    }

    const ctx = this.ctx;
    try {
      const post = ctx.postfx;
      const composer = ctx.composer;
      if (post && typeof post.render === 'function' && post.enabled !== false) {
        post.render(dt);
      } else if (composer && typeof composer.render === 'function') {
        composer.render(dt);
      } else if (ctx.scene && ctx.camera) {
        gl.render(ctx.scene, ctx.camera);
      }
    } catch (err) {
      if (!this._renderBlamed) {
        this._renderBlamed = true;
        console.error('[Engine] render failed; falling back to direct scene render', err);
      }
      try {
        if (ctx.scene && ctx.camera) gl.render(ctx.scene, ctx.camera);
      } catch (_) { /* nothing more we can do this frame */ }
    }
    return this;
  }

  /** Alias for callers that expect a bare render(). */
  render(dt) { return this.renderFrame(dt); }

  /**
   * Viewport changed. Updates the camera and everything that owns a render
   * target. Deliberately does NOT resize the renderer: Capture.js sets the
   * renderer size itself and then calls this, and double-applying the pixel
   * ratio would halve the capture resolution.
   */
  onResize(w, h) {
    const width = Math.max(1, Math.round(w || 0));
    const height = Math.max(1, Math.round(h || 0));
    this.width = width;
    this.height = height;

    const cam = this.ctx.camera;
    if (cam) {
      if (cam.isPerspectiveCamera) {
        cam.aspect = width / height;
        cam.updateProjectionMatrix();
      } else if (cam.isOrthographicCamera) {
        const halfH = (cam.top - cam.bottom) * 0.5;
        const halfW = halfH * (width / height);
        cam.left = -halfW; cam.right = halfW;
        cam.updateProjectionMatrix();
      }
    }

    const reg = this.registry;
    for (let i = 0; i < reg.length; i++) {
      const rec = reg[i];
      if (!rec.enabled) continue;
      const fn = rec.sys.onResize;
      if (typeof fn !== 'function') continue;
      try { fn.call(rec.sys, width, height, this.ctx); }
      catch (err) { this._systemError(rec, 'onResize', err); }
    }

    // The composer is usually not a registered system, so it needs a nudge.
    const composer = this.ctx.composer;
    if (composer && typeof composer.setSize === 'function' && !this._isRegistered(composer)) {
      try { composer.setSize(width, height); } catch (err) { console.warn('[Engine] composer.setSize failed', err); }
    }
    const post = this.ctx.postfx;
    if (post && post !== composer && typeof post.onResize === 'function' && !this._isRegistered(post)) {
      try { post.onResize(width, height); } catch (err) { console.warn('[Engine] postfx.onResize failed', err); }
    }

    this.bus.emit(Events.RESIZE, { width, height, aspect: width / height });
    return this;
  }

  _isRegistered(obj) {
    for (let i = 0; i < this.systems.length; i++) if (this.systems[i] === obj) return true;
    return false;
  }

  /** Read the canvas's current CSS size and apply it. */
  measure() {
    this._ensureCanvasObservers();
    const canvas = this.canvas;
    let w = 0, h = 0;
    if (canvas) {
      w = canvas.clientWidth || canvas.width || 0;
      h = canvas.clientHeight || canvas.height || 0;
    }
    if (!w || !h) {
      w = (typeof innerWidth !== 'undefined' && innerWidth) || 1600;
      h = (typeof innerHeight !== 'undefined' && innerHeight) || 900;
    }
    this._pendingResize = { w, h };
    this._flushResize();
    return this;
  }

  _flushResize() {
    const p = this._pendingResize;
    this._pendingResize = null;
    if (!p) return;
    const gl = this.renderer;
    if (gl) {
      try {
        gl.setPixelRatio(Settings.render.pixelRatio);
        gl.setSize(p.w, p.h, false);
      } catch (err) {
        console.warn('[Engine] renderer resize failed', err);
      }
    }
    this.onResize(p.w, p.h);
  }

  /* -------------------------------------------------------------- observers */

  _installObservers() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this._onVisibility, false);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._onWindowResize, false);
      window.addEventListener('orientationchange', this._onWindowResize, false);
    }
    this._ensureCanvasObservers();
  }

  /** The canvas may only appear once main.js has built the renderer, so this is
   *  idempotent and re-run from measure(), start() and init(). */
  _ensureCanvasObservers() {
    const canvas = this.canvas;
    if (!canvas || canvas === this._observedCanvas) return;

    if (this._observedCanvas) {
      this._observedCanvas.removeEventListener('webglcontextlost', this._onContextLost);
      this._observedCanvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      try { this._ro?.disconnect(); } catch (_) { /* ignore */ }
      this._ro = null;
    }
    this._observedCanvas = canvas;

    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        let w = 0, h = 0;
        if (e.contentBoxSize) {
          const box = Array.isArray(e.contentBoxSize) ? e.contentBoxSize[0] : e.contentBoxSize;
          w = box.inlineSize; h = box.blockSize;
        } else if (e.contentRect) {
          w = e.contentRect.width; h = e.contentRect.height;
        }
        if (w > 0 && h > 0) {
          this._pendingResize = { w: Math.round(w), h: Math.round(h) };
          // Apply immediately when the loop is not running to keep the very
          // first frame and any headless capture correctly sized.
          if (!this.running) this._flushResize();
        }
      });
      try { this._ro.observe(canvas); } catch (_) { this._ro = null; }
    }
  }

  _onWindowResize() {
    // Fallback path for browsers without ResizeObserver, and a safety net for
    // DPR changes (dragging the window to a different-density monitor).
    Settings.resolve();
    const canvas = this.canvas;
    const w = canvas?.clientWidth || (typeof innerWidth !== 'undefined' ? innerWidth : 0);
    const h = canvas?.clientHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 0);
    if (w > 0 && h > 0) {
      this._pendingResize = { w: Math.round(w), h: Math.round(h) };
      if (!this.running) this._flushResize();
    }
  }

  _onVisibility() {
    if (document.hidden) {
      this.pause('hidden');
    } else {
      // rAF has not fired while hidden, so _last is stale by however long the
      // tab was in the background. Rebase before resuming or the first frame
      // back would try to catch up on minutes of simulation.
      this._last = perfNow();
      this._accum = 0;
      this.resume('hidden');
    }
  }

  _onContextLost(e) {
    e.preventDefault();
    this.contextLost = true;
    this.pause('gl');
    console.warn('[Engine] WebGL context lost');
    this.bus.emit(Events.GL_LOST, this);
  }

  _onContextRestored() {
    // three registers its own 'webglcontextrestored' listener on this same
    // canvas and re-initialises its GL state there. Ours may have been attached
    // first (the Engine can exist before the renderer), so defer a task to
    // guarantee we rebuild on top of a re-initialised context, not under it.
    setTimeout(() => this._doContextRestore(), 0);
  }

  _doContextRestore() {
    console.warn('[Engine] WebGL context restored — rebuilding GPU resources');
    this.contextLost = false;
    try { Settings.apply(this.ctx); } catch (err) { console.warn('[Engine] settings reapply failed', err); }
    const reg = this.registry;
    for (let i = 0; i < reg.length; i++) {
      const rec = reg[i];
      const fn = rec.sys.onContextRestored;
      if (typeof fn !== 'function') continue;
      try { fn.call(rec.sys, this.ctx); }
      catch (err) { this._systemError(rec, 'onContextRestored', err); }
    }
    this.measure();
    this._last = perfNow();
    this._accum = 0;
    this.resume('gl');
    this.bus.emit(Events.GL_RESTORED, this);
  }

  /** Debug helper: force a context loss to exercise the restore path. */
  simulateContextLoss(restoreAfterMs = 1500) {
    const gl = this.renderer?.getContext?.();
    const ext = gl?.getExtension?.('WEBGL_lose_context');
    if (!ext) { console.warn('[Engine] WEBGL_lose_context unavailable'); return this; }
    ext.loseContext();
    if (restoreAfterMs > 0) setTimeout(() => { try { ext.restoreContext(); } catch (_) { /* ignore */ } }, restoreAfterMs);
    return this;
  }

  /* -------------------------------------------------------------- reporting */

  /** Per-system timings, slowest first — the debug overlay's data source. */
  profile() {
    const rows = this.registry.map((r) => ({
      name: r.name,
      enabled: r.enabled,
      errors: r.errors,
      fixed: r.ms.fixed,
      update: r.ms.update,
      late: r.ms.late,
      total: r.ms.total,
      init: r.ms.init,
    }));
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }

  snapshot() {
    return {
      ...this.stats,
      running: this.running,
      paused: this.paused,
      pauseReasons: [...this._pauseReasons],
      systems: this.registry.length,
      fixedHz: Math.round(1 / this.fixedDt),
      size: `${this.width}x${this.height}`,
      pixelRatio: Settings.render.pixelRatio,
      quality: Settings.quality,
    };
  }

  dispose() {
    this._disposed = true;
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onWindowResize);
      window.removeEventListener('orientationchange', this._onWindowResize);
    }
    const canvas = this._observedCanvas;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', this._onContextLost);
      canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    }
    this._observedCanvas = null;
    try { this._ro?.disconnect(); } catch (_) { /* ignore */ }
    this._ro = null;

    for (let i = this.registry.length - 1; i >= 0; i--) {
      const rec = this.registry[i];
      try { rec.sys.dispose?.(); }
      catch (err) { console.warn(`[Engine] ${rec.name}.dispose() threw`, err); }
    }
    this.registry.length = 0;
    this.systems.length = 0;
    this._byName.clear();
    return this;
  }
}

// Exponential moving average: enough smoothing that the overlay is readable,
// little enough that a hitch is still visible.
function ema(prev, next, k = 0.12) {
  return prev === 0 ? next : prev + (next - prev) * k;
}

export function makeEngine(ctx) {
  return new Engine(ctx);
}

export default Engine;
