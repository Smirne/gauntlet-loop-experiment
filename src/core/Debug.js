// core/Debug.js — developer overlay: stats, free camera, live tuning.
//
// Off by default and invisible until someone presses the key. That is a hard
// requirement: review screenshots are taken from the live page, so anything
// this module draws must be opt-in. The panel is DOM (never composited into
// the WebGL canvas, so it cannot leak into a capture at all) and the only
// in-scene objects — grid and axes helpers — are removed from the scene
// entirely while disabled, and hidden again around any MG.capture() call.
//
// Bindings (only the first is live while the overlay is closed):
//   `  or F9   toggle overlay
//   F          free orbit camera (overrides the Director)
//   G / X      grid / axes helpers
//   W          wireframe
//   U          hide the DOM UI layer
//   P / .      pause / single fixed step
//   H          collapse the tuning panel, keep the stats
//   F2         headless capture via window.MG.capture

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Settings, META, QUALITY } from './Settings.js';

const CSS = `
#mg-debug {
  position: fixed; top: 10px; left: 10px; z-index: 90;
  width: 316px; max-height: calc(100vh - 20px);
  display: flex; flex-direction: column; gap: 6px;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cdd6e6; pointer-events: none; user-select: none;
  -webkit-font-smoothing: antialiased;
}
#mg-debug .mg-card {
  pointer-events: auto;
  background: rgba(10, 13, 20, 0.86);
  border: 1px solid rgba(120, 140, 175, 0.22);
  border-radius: 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.045);
  backdrop-filter: blur(9px);
}
#mg-debug .mg-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 9px; border-bottom: 1px solid rgba(120, 140, 175, 0.16);
  letter-spacing: .14em; text-transform: uppercase; font-size: 9px; color: #7d8aa3;
}
#mg-debug .mg-head b { color: #ff5a3c; letter-spacing: .18em; }
#mg-debug .mg-head .mg-sp { margin-left: auto; color: #55607a; letter-spacing: .06em; }
#mg-debug .mg-body { padding: 7px 9px 9px; }
#mg-debug .mg-fps { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
#mg-debug .mg-fps b { font-size: 21px; font-weight: 700; color: #eef3ff; letter-spacing: -.02em; }
#mg-debug .mg-fps span { color: #7d8aa3; }
#mg-debug canvas.mg-graph { display: block; width: 100%; height: 42px; margin: 5px 0 6px; border-radius: 3px; background: rgba(255,255,255,.028); }
#mg-debug table { width: 100%; border-collapse: collapse; font-size: 10px; }
#mg-debug td { padding: 1px 0; color: #9aa6bd; }
#mg-debug td.n { text-align: right; font-variant-numeric: tabular-nums; color: #cdd6e6; }
#mg-debug td.w { color: #ffcf6b; }
#mg-debug td.e { color: #ff7a6a; }
#mg-debug .mg-scroll { overflow-y: auto; overflow-x: hidden; max-height: 52vh; }
#mg-debug .mg-scroll::-webkit-scrollbar { width: 7px; }
#mg-debug .mg-scroll::-webkit-scrollbar-thumb { background: rgba(140,160,200,.22); border-radius: 4px; }
#mg-debug .mg-sec { border-top: 1px solid rgba(120, 140, 175, 0.13); }
#mg-debug .mg-sec > h4 {
  margin: 0; padding: 5px 9px; font-size: 9px; font-weight: 600; letter-spacing: .13em;
  text-transform: uppercase; color: #6f7c94; cursor: pointer; display: flex; align-items: center; gap: 6px;
}
#mg-debug .mg-sec > h4:hover { color: #b9c4d8; }
#mg-debug .mg-sec > h4::before { content: '\\25be'; font-size: 8px; color: #55607a; }
#mg-debug .mg-sec.closed > h4::before { content: '\\25b8'; }
#mg-debug .mg-sec.closed > .mg-secbody { display: none; }
#mg-debug .mg-secbody { padding: 2px 9px 8px; }
#mg-debug .mg-row { display: flex; align-items: center; gap: 6px; height: 19px; }
#mg-debug .mg-row > label { flex: 0 0 106px; color: #8f9bb2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#mg-debug .mg-row > .mg-val { flex: 0 0 46px; text-align: right; font-variant-numeric: tabular-nums; color: #dfe6f4; }
#mg-debug input[type=range] {
  flex: 1 1 auto; min-width: 0; height: 3px; appearance: none; -webkit-appearance: none;
  background: rgba(150,170,205,.24); border-radius: 3px; outline: none; cursor: ew-resize;
}
#mg-debug input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%;
  background: #ff5a3c; border: 0; cursor: ew-resize; box-shadow: 0 0 0 2px rgba(255,90,60,.2);
}
#mg-debug input[type=range]::-moz-range-thumb { width: 10px; height: 10px; border: 0; border-radius: 50%; background: #ff5a3c; }
#mg-debug input[type=checkbox] { appearance: none; -webkit-appearance: none; width: 26px; height: 13px; border-radius: 8px;
  background: rgba(150,170,205,.2); position: relative; cursor: pointer; transition: background .12s; margin: 0; }
#mg-debug input[type=checkbox]::after { content: ''; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px;
  border-radius: 50%; background: #97a3ba; transition: transform .12s, background .12s; }
#mg-debug input[type=checkbox]:checked { background: rgba(255,90,60,.34); }
#mg-debug input[type=checkbox]:checked::after { transform: translateX(13px); background: #ff5a3c; }
#mg-debug select {
  flex: 1 1 auto; min-width: 0; background: rgba(255,255,255,.05); color: #dfe6f4;
  border: 1px solid rgba(140,160,200,.22); border-radius: 3px; padding: 1px 3px;
  font: inherit; font-size: 10px; outline: none; cursor: pointer;
}
#mg-debug .mg-btns { display: flex; flex-wrap: wrap; gap: 4px; padding: 7px 9px; }
#mg-debug button {
  font: inherit; font-size: 9px; letter-spacing: .07em; text-transform: uppercase;
  background: rgba(255,255,255,.055); color: #b6c1d6; border: 1px solid rgba(140,160,200,.2);
  border-radius: 3px; padding: 3px 6px; cursor: pointer; transition: all .12s;
}
#mg-debug button:hover { background: rgba(255,90,60,.16); color: #ffd9d1; border-color: rgba(255,90,60,.4); }
#mg-debug button.on { background: rgba(255,90,60,.28); color: #fff; border-color: rgba(255,90,60,.6); }
#mg-debug .mg-hint { padding: 0 9px 7px; font-size: 9px; color: #55607a; line-height: 1.5; }
`;

const HIST_W = 296;
const HIST_H = 42;

// Preallocated scratch — the fly-camera step runs every frame.
const _v1 = new THREE.Vector3();

/* ------------------------------------------------------------------ helpers */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  if (a >= 0.01) return v.toFixed(3);
  return v.toPrecision(2);
}

function big(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n | 0);
}

/** Sensible slider bounds for a value we know nothing about. */
function guessRange(v) {
  if (v === 0) return [0, 1, 0.01];
  const a = Math.abs(v);
  if (a <= 1) return [v < 0 ? -1 : 0, 1, 0.005];
  const max = Math.pow(10, Math.ceil(Math.log10(a))) * (a / Math.pow(10, Math.floor(Math.log10(a))) > 3 ? 1 : 0.5);
  const hi = Math.max(max, a * 2);
  const lo = v < 0 ? -hi : 0;
  return [lo, hi, (hi - lo) / 400];
}

/* -------------------------------------------------------------------- system */

export class Debug {
  name = 'debug';

  constructor(ctx = {}) {
    this.ctx = ctx;
    ctx.debug = this;

    this.enabled = false;
    this.panelOpen = true;
    this.freeCam = false;
    this.showGrid = false;
    this.showAxes = false;
    this.wireframe = false;
    this.uiHidden = false;

    this.root = null;
    this.helpers = null;
    this.freeCamera = null;
    this.controls = null;

    this._refreshers = [];
    this._acc = 0;
    this._keys = new Set();
    this._saveTimer = 0;
    this._applyTimer = 0;
    this._lastApply = 0;
    this._selfRaf = 0;
    this._lastSelf = 0;
    this._wireStash = new Map();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);

    this._autoOpen = false;
    try {
      const q = new URLSearchParams(location.search);
      this._autoOpen = q.get('debug') === '1' || q.has('dev');
    } catch (_) { /* not a browser */ }
  }

  /* --------------------------------------------------------------- lifecycle */

  async init() {
    if (typeof document === 'undefined') return;
    window.addEventListener('keydown', this._onKeyDown, false);
    window.addEventListener('keyup', this._onKeyUp, false);
    this._wrapCapture();
    if (this._autoOpen || Settings.debug?.overlay) this.setEnabled(true);
  }

  update(dt) {
    if (!this.enabled || !this.root) return;
    this._lastSelf = performance.now();
    this._drawGraph();
    this._acc += dt;
    if (this._acc >= 0.1) {
      this._acc = 0;
      this._refreshStats();
    }
  }

  lateUpdate(dt) {
    if (!this.freeCam || !this.freeCamera) return;
    this._flyStep(dt);
    this.controls?.update();
    const cam = this.ctx.camera;
    if (!cam) return;
    // Runs last in lateUpdate, so this wins over whatever the Director did.
    cam.position.copy(this.freeCamera.position);
    cam.quaternion.copy(this.freeCamera.quaternion);
    if (cam.isPerspectiveCamera && cam.fov !== this.freeCamera.fov) {
      cam.fov = this.freeCamera.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  onResize(w, h) {
    if (this.freeCamera && h > 0) {
      this.freeCamera.aspect = w / h;
      this.freeCamera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.setEnabled(false);
    clearTimeout(this._saveTimer);
    clearTimeout(this._applyTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
    }
    this.root?.remove();
    this.root = null;
    document.getElementById('mg-debug-css')?.remove();
    this._disposeHelpers();
  }

  /* ------------------------------------------------------------------ toggle */

  toggle() { this.setEnabled(!this.enabled); return this; }

  setEnabled(on) {
    const want = !!on;
    if (want === this.enabled) return this;
    this.enabled = want;
    Settings.debug.overlay = want;

    if (want) {
      if (!this.root) this._build();
      this.root.style.display = 'flex';
      this._wrapCapture();
      this._refreshAll();
      this._startSelfDrive();
    } else {
      if (this.root) this.root.style.display = 'none';
      if (this.freeCam) this.setFreeCam(false);
      this.setHelper('grid', false);
      this.setHelper('axes', false);
      this.setWireframe(false);
      this.setUiHidden(false);
      this._stopSelfDrive();
    }
    this.ctx.bus?.emit?.('debug:toggle', want);
    return this;
  }

  togglePanel() {
    this.panelOpen = !this.panelOpen;
    if (this.panelCard) this.panelCard.style.display = this.panelOpen ? '' : 'none';
    if (this.btnCard) this.btnCard.style.display = this.panelOpen ? '' : 'none';
    return this;
  }

  /* ---------------------------------------------------------------- free cam */

  toggleFreeCam() { return this.setFreeCam(!this.freeCam); }

  setFreeCam(on) {
    const want = !!on;
    if (want === this.freeCam) return this;
    const cam = this.ctx.camera;
    if (want && !cam) return this;

    if (want) {
      this._camStash = {
        position: cam.position.clone(),
        quaternion: cam.quaternion.clone(),
        fov: cam.isPerspectiveCamera ? cam.fov : 0,
      };
      if (!this.freeCamera) {
        this.freeCamera = new THREE.PerspectiveCamera(
          cam.isPerspectiveCamera ? cam.fov : Settings.camera.fov,
          cam.aspect || 16 / 9,
          Settings.camera.near,
          Settings.camera.far
        );
      }
      this.freeCamera.position.copy(cam.position);
      this.freeCamera.quaternion.copy(cam.quaternion);
      this.freeCamera.aspect = cam.aspect || this.freeCamera.aspect;
      if (cam.isPerspectiveCamera) this.freeCamera.fov = cam.fov;
      this.freeCamera.updateProjectionMatrix();

      const dom = this.ctx.engine?.renderer?.domElement
        || this.ctx.renderer?.domElement
        || document.getElementById('stage');
      if (dom) {
        this.controls = new OrbitControls(this.freeCamera, dom);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.09;
        this.controls.rotateSpeed = 0.75;
        this.controls.zoomSpeed = 1.1;
        this.controls.panSpeed = 1.1;
        this.controls.screenSpacePanning = true;
        this.controls.minDistance = 6;
        this.controls.maxDistance = 2600;
        // Orbit around whatever the game camera was looking at, ~a car length
        // and a half ahead, so the first drag does not swing wildly.
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        this.controls.target.copy(cam.position).addScaledVector(fwd, 55);
        this.controls.update();
      }
    } else {
      this.controls?.dispose();
      this.controls = null;
      if (this._camStash && cam) {
        cam.position.copy(this._camStash.position);
        cam.quaternion.copy(this._camStash.quaternion);
        if (cam.isPerspectiveCamera && this._camStash.fov) {
          cam.fov = this._camStash.fov;
          cam.updateProjectionMatrix();
        }
        cam.updateMatrixWorld();
      }
      this._camStash = null;
    }

    this.freeCam = want;
    Settings.debug.freeCam = want;
    this.ctx.bus?.emit?.('debug:freecam', want);
    this.ctx.director?.setMode?.(want ? 'free' : 'race');
    this._syncButtons();
    return this;
  }

  _flyStep(dt) {
    if (!this.controls || this._keys.size === 0) return;
    const k = this._keys;
    let fx = 0, fy = 0, fz = 0;
    if (k.has('KeyW')) fz -= 1;
    if (k.has('KeyS')) fz += 1;
    if (k.has('KeyA')) fx -= 1;
    if (k.has('KeyD')) fx += 1;
    if (k.has('KeyE')) fy += 1;
    if (k.has('KeyQ')) fy -= 1;
    if (fx === 0 && fy === 0 && fz === 0) return;

    const cam = this.freeCamera;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 420 : 130) * dt;
    _v1.set(fx, 0, fz);
    if (_v1.lengthSq() > 0) _v1.normalize().applyQuaternion(cam.quaternion);
    _v1.y += fy;
    _v1.multiplyScalar(speed);
    cam.position.add(_v1);
    this.controls.target.add(_v1);
  }

  /* ----------------------------------------------------------------- helpers */

  setHelper(kind, on) {
    const want = !!on;
    if (kind === 'grid') this.showGrid = want;
    if (kind === 'axes') this.showAxes = want;

    // Nothing to build or tear down: never allocate helper geometry just to
    // switch it off (this path runs whenever the overlay closes).
    if (!want && !this.helpers) return this;

    const scene = this.ctx.scene;
    if (!scene) return this;

    if (!this.helpers) {
      this.helpers = new THREE.Group();
      this.helpers.name = 'debug-helpers';
      this.helpers.matrixAutoUpdate = false;

      // Playfield is ~460 x 340 u, so a 480 u grid at 10 u cells reads as scale.
      const grid = new THREE.GridHelper(480, 48, 0x5a6b8a, 0x2a3245);
      grid.material.transparent = true;
      grid.material.opacity = 0.45;
      grid.material.depthWrite = false;
      grid.position.y = 0.05; // above the ground plane, below the track ribbon
      grid.name = 'grid';
      this.helpers.add(grid);

      const axes = new THREE.AxesHelper(60);
      axes.material.depthTest = false;
      axes.material.transparent = true;
      axes.name = 'axes';
      this.helpers.add(axes);

      this.helpers.updateMatrix();
    }

    const grid = this.helpers.getObjectByName('grid');
    const axes = this.helpers.getObjectByName('axes');
    if (grid) grid.visible = this.showGrid;
    if (axes) axes.visible = this.showAxes;

    const wanted = this.showGrid || this.showAxes;
    if (wanted && this.helpers.parent !== scene) scene.add(this.helpers);
    else if (!wanted && this.helpers.parent) this.helpers.parent.remove(this.helpers);

    this._syncButtons();
    return this;
  }

  _disposeHelpers() {
    if (!this.helpers) return;
    this.helpers.parent?.remove(this.helpers);
    this.helpers.traverse((o) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
      else o.material?.dispose?.();
    });
    this.helpers = null;
  }

  setWireframe(on) {
    const want = !!on;
    if (want === this.wireframe) return this;
    this.wireframe = want;
    const scene = this.ctx.scene;
    if (!scene) return this;
    if (want) {
      scene.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          if (m.wireframe === undefined || this._wireStash.has(m)) continue;
          this._wireStash.set(m, m.wireframe);
          m.wireframe = true;
        }
      });
    } else {
      for (const [m, v] of this._wireStash) m.wireframe = v;
      this._wireStash.clear();
    }
    this._syncButtons();
    return this;
  }

  setUiHidden(on) {
    this.uiHidden = !!on;
    const ui = document.getElementById('ui-root');
    if (ui) ui.style.visibility = this.uiHidden ? 'hidden' : '';
    this._syncButtons();
    return this;
  }

  /* -------------------------------------------------------------------- keys */

  _onKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if (e.code === 'Escape') t.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.code === 'Backquote' || e.code === 'F9') {
      e.preventDefault();
      this.toggle();
      return;
    }
    if (!this.enabled) return;

    this._keys.add(e.code);

    switch (e.code) {
      case 'KeyF': e.preventDefault(); this.toggleFreeCam(); break;
      case 'KeyG': this.setHelper('grid', !this.showGrid); break;
      case 'KeyX': this.setHelper('axes', !this.showAxes); break;
      case 'KeyW': if (!this.freeCam) this.setWireframe(!this.wireframe); break;
      case 'KeyU': this.setUiHidden(!this.uiHidden); break;
      case 'KeyH': this.togglePanel(); break;
      case 'KeyP': this.ctx.engine?.togglePause?.('debug'); this._syncButtons(); break;
      case 'Period': this.ctx.engine?.stepOnce?.(); break;
      case 'F2': e.preventDefault(); this._capture(); break;
      default: break;
    }
  }

  _onKeyUp(e) { this._keys.delete(e.code); }

  _capture() {
    const name = 'debug-' + new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
    window.MG?.capture?.(name, 1920, 1080)
      ?.then?.((r) => console.log('[Debug] captured', r))
      ?.catch?.((err) => console.warn('[Debug] capture failed', err));
  }

  /** Hide the in-scene helpers (and the panel) for the duration of a capture. */
  _wrapCapture() {
    const MG = window.MG;
    if (!MG || MG.__mgDebugWrapped || typeof MG.capture !== 'function') return;
    const orig = MG.capture.bind(MG);
    const self = this;
    MG.capture = async function wrapped(...args) {
      const hv = self.helpers ? self.helpers.visible : null;
      const rd = self.root ? self.root.style.display : null;
      if (self.helpers) self.helpers.visible = false;
      if (self.root) self.root.style.display = 'none';
      try {
        return await orig(...args);
      } finally {
        if (self.helpers && hv !== null) self.helpers.visible = hv;
        if (self.root && rd !== null) self.root.style.display = rd;
      }
    };
    MG.__mgDebugWrapped = true;
  }

  /* --------------------------------------------------------------- self drive */

  // If main.js never registered Debug as a system, drive the overlay from our
  // own rAF so it still works. Yields the moment the engine starts calling us.
  _startSelfDrive() {
    if (this._selfRaf) return;
    const engine = this.ctx.engine;
    if (engine && engine.get && engine.get('debug') === this) return;
    let last = performance.now();
    const loop = (t) => {
      this._selfRaf = requestAnimationFrame(loop);
      if (performance.now() - this._lastSelf < 250) return; // engine is driving us
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      this._drawGraph();
      this._acc += dt;
      if (this._acc >= 0.1) { this._acc = 0; this._refreshStats(); }
    };
    this._selfRaf = requestAnimationFrame(loop);
  }

  _stopSelfDrive() {
    if (this._selfRaf) cancelAnimationFrame(this._selfRaf);
    this._selfRaf = 0;
  }

  /* ------------------------------------------------------------------ the DOM */

  _build() {
    if (!document.getElementById('mg-debug-css')) {
      const style = el('style');
      style.id = 'mg-debug-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const root = el('div');
    root.id = 'mg-debug';
    root.style.display = 'none';
    this.root = root;

    /* ---- stats card */
    const statCard = el('div', 'mg-card');
    const head = el('div', 'mg-head');
    head.appendChild(el('b', null, 'MICRO GAUNTLET'));
    head.appendChild(el('span', null, 'debug'));
    this.headInfo = el('span', 'mg-sp', '');
    head.appendChild(this.headInfo);
    statCard.appendChild(head);

    const body = el('div', 'mg-body');
    const fps = el('div', 'mg-fps');
    this.fpsNum = el('b', null, '--');
    this.fpsSub = el('span', null, '');
    fps.append(this.fpsNum, this.fpsSub);
    body.appendChild(fps);

    this.graph = el('canvas', 'mg-graph');
    this.graph.width = HIST_W;
    this.graph.height = HIST_H;
    this.gctx = this.graph.getContext('2d');
    body.appendChild(this.graph);

    // Rows go into an explicit tbody: appending <tr> straight to <table> via
    // the DOM API skips the parser's implied tbody.
    const counterTable = el('table');
    this.counters = el('tbody');
    counterTable.appendChild(this.counters);
    body.appendChild(counterTable);

    const sysTableEl = el('table');
    sysTableEl.style.marginTop = '5px';
    this.sysTable = el('tbody');
    sysTableEl.appendChild(this.sysTable);
    body.appendChild(sysTableEl);

    statCard.appendChild(body);
    root.appendChild(statCard);

    /* ---- action buttons */
    const btnCard = el('div', 'mg-card');
    this.btnCard = btnCard;
    const btns = el('div', 'mg-btns');
    this._buttons = {};
    const mkBtn = (key, label, fn) => {
      const b = el('button', null, label);
      b.addEventListener('click', (e) => { e.preventDefault(); fn(); this._syncButtons(); });
      btns.appendChild(b);
      this._buttons[key] = b;
      return b;
    };
    mkBtn('pause', 'pause', () => this.ctx.engine?.togglePause?.('debug'));
    mkBtn('step', 'step', () => this.ctx.engine?.stepOnce?.());
    mkBtn('freecam', 'free cam', () => this.toggleFreeCam());
    mkBtn('grid', 'grid', () => this.setHelper('grid', !this.showGrid));
    mkBtn('axes', 'axes', () => this.setHelper('axes', !this.showAxes));
    mkBtn('wire', 'wire', () => this.setWireframe(!this.wireframe));
    mkBtn('ui', 'hide ui', () => this.setUiHidden(!this.uiHidden));
    mkBtn('shot', 'capture', () => this._capture());
    mkBtn('gl', 'lose gl', () => this.ctx.engine?.simulateContextLoss?.(1200));
    mkBtn('reset', 'defaults', () => { Settings.reset(this.ctx); this._refreshAll(); });
    btnCard.appendChild(btns);
    btnCard.appendChild(el('div', 'mg-hint', '` overlay · F free cam · WASD/QE fly · G grid · X axes · W wire · U ui · P pause · . step · H panel · F2 shot'));
    root.appendChild(btnCard);

    /* ---- tuning panel */
    const panel = el('div', 'mg-card mg-scroll');
    this.panelCard = panel;
    this.panelBody = panel;
    root.appendChild(panel);

    this._buildPanel();

    document.body.appendChild(root);
  }

  _section(title, closed) {
    const sec = el('div', 'mg-sec' + (closed ? ' closed' : ''));
    const h = el('h4', null, title);
    const bodyEl = el('div', 'mg-secbody');
    h.addEventListener('click', () => sec.classList.toggle('closed'));
    sec.append(h, bodyEl);
    this.panelBody.appendChild(sec);
    return bodyEl;
  }

  _slider(parent, label, get, set, min, max, step) {
    const row = el('div', 'mg-row');
    row.appendChild(el('label', null, label));
    const input = el('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    const val = el('span', 'mg-val');
    const paint = () => {
      const v = get();
      if (document.activeElement !== input) input.value = v;
      val.textContent = fmt(v);
    };
    input.addEventListener('input', () => {
      set(parseFloat(input.value));
      val.textContent = fmt(parseFloat(input.value));
    });
    row.append(input, val);
    parent.appendChild(row);
    paint();
    this._refreshers.push(paint);
    return row;
  }

  _toggle(parent, label, get, set) {
    const row = el('div', 'mg-row');
    row.appendChild(el('label', null, label));
    const input = el('input');
    input.type = 'checkbox';
    input.style.marginLeft = 'auto';
    input.addEventListener('change', () => set(input.checked));
    row.appendChild(input);
    parent.appendChild(row);
    const paint = () => { input.checked = !!get(); };
    paint();
    this._refreshers.push(paint);
    return row;
  }

  _select(parent, label, get, set, options) {
    const row = el('div', 'mg-row');
    row.appendChild(el('label', null, label));
    const sel = el('select');
    for (const o of options) {
      const opt = el('option', null, String(o));
      opt.value = String(o);
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const num = Number(raw);
      set(raw !== '' && !Number.isNaN(num) && typeof options[0] === 'number' ? num : raw);
    });
    row.appendChild(sel);
    parent.appendChild(row);
    const paint = () => { sel.value = String(get()); };
    paint();
    this._refreshers.push(paint);
    return row;
  }

  /** Build a control from a Settings path using its META description. */
  _settingRow(parent, path) {
    const m = META[path];
    const label = m?.label || path.split('.').pop();
    const get = () => Settings.get(path);
    const set = (v) => {
      // Write immediately (systems that read Settings every frame respond at
      // once) but throttle the heavyweight propagation — dragging a slider
      // fires dozens of input events per second and apply() can rebuild render
      // targets and particle pools.
      Settings.set(path, v);
      this._queueApply();
      this._queueSave();
    };
    const cur = get();
    if (typeof cur === 'boolean') return this._toggle(parent, label, get, set);
    if (m?.options) return this._select(parent, label, get, set, m.options);
    if (typeof cur === 'number') {
      const min = m?.min ?? 0;
      const max = m?.max ?? 1;
      const step = m?.step ?? (max - min) / 200;
      return this._slider(parent, label, get, set, min, max, step);
    }
    return null;
  }

  /** Leading-edge throttle so the first drag frame lands instantly and the
   *  stream that follows is capped at ~20 applies per second. */
  _queueApply() {
    const now = performance.now();
    if (now - this._lastApply >= 50) {
      this._lastApply = now;
      Settings.apply(this.ctx);
      return;
    }
    if (this._applyTimer) return;
    this._applyTimer = setTimeout(() => {
      this._applyTimer = 0;
      this._lastApply = performance.now();
      Settings.apply(this.ctx);
    }, 50);
  }

  _queueSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => Settings.save(), 400);
  }

  _buildPanel() {
    this.panelBody.textContent = '';
    this._refreshers.length = 0;

    /* quality */
    let s = this._section('Quality');
    this._select(s, 'Tier', () => Settings.quality, (v) => {
      Settings.setQuality(v, this.ctx);
      // Rebuild out of band: the <select> that fired this is about to be
      // removed from the document by the rebuild.
      setTimeout(() => this._buildPanel(), 0);
    }, QUALITY);
    for (const p of [
      'render.maxPixelRatio', 'render.renderScale', 'render.exposure',
      'render.shadows', 'render.shadowMapSize', 'render.shadowCascades',
      'render.shadowDistance', 'render.shadowNormalBias', 'render.anisotropy',
      'render.contactShadows',
    ]) this._settingRow(s, p);

    /* post */
    s = this._section('Post FX');
    for (const p of [
      'post.enabled', 'post.ssao', 'post.bloom', 'post.tiltShift', 'post.motionBlur',
      'post.grade', 'post.grain', 'post.chromatic', 'post.vignette', 'post.crt', 'post.smaa',
    ]) this._settingRow(s, p);

    s = this._section('Tilt-shift & bloom', true);
    for (const p of [
      'post.params.tiltShiftAmount', 'post.params.tiltShiftCenter', 'post.params.tiltShiftBand',
      'post.params.tiltShiftFalloff', 'post.params.tiltShiftMaxRadius', 'post.params.tiltShiftFollowPlayer',
      'post.params.bloomStrength', 'post.params.bloomThreshold', 'post.params.bloomRadius',
    ]) this._settingRow(s, p);

    s = this._section('Grade & film', true);
    for (const p of [
      'post.params.gradeContrast', 'post.params.gradeSaturation', 'post.params.gradeLift',
      'post.params.gradeGamma', 'post.params.gradeGain', 'post.params.gradeTemperature',
      'post.params.grainAmount', 'post.params.chromaticAmount', 'post.params.vignetteAmount',
      'post.params.ssaoRadius', 'post.params.ssaoIntensity', 'post.params.motionBlurAmount',
    ]) this._settingRow(s, p);

    /* physics */
    s = this._section('Physics');
    for (const p of [
      'physics.gravity', 'physics.fixedHz', 'physics.substeps', 'physics.maxCatchUpSteps',
      'physics.timeScale', 'physics.restitution', 'physics.friction',
    ]) this._settingRow(s, p);

    /* camera */
    s = this._section('Camera', true);
    for (const p of ['camera.fov', 'camera.pitch', 'camera.distance', 'camera.height', 'camera.damping', 'camera.lookahead']) {
      this._settingRow(s, p);
    }

    /* world & particles */
    s = this._section('World & FX', true);
    for (const p of [
      'particles.enabled', 'particles.budget', 'particles.sizeScale', 'particles.softParticles',
      'world.propDensity', 'world.decalBudget', 'world.skidBudget', 'world.grassDensity',
      'world.dustMotes', 'world.drawDistance',
    ]) this._settingRow(s, p);

    /* audio */
    s = this._section('Audio', true);
    for (const p of ['audio.master', 'audio.music', 'audio.sfx', 'audio.engine', 'audio.ambience', 'audio.muted']) {
      this._settingRow(s, p);
    }

    /* gameplay */
    s = this._section('Gameplay', true);
    for (const p of ['gameplay.assists', 'gameplay.aiDifficulty', 'gameplay.aiCount', 'gameplay.laps', 'gameplay.damage', 'gameplay.cameraShake']) {
      this._settingRow(s, p);
    }

    /* live object inspector */
    this._buildInspector();
  }

  /** Targets worth poking at runtime, whichever of them currently exist. */
  _inspectTargets() {
    const c = this.ctx;
    const out = [];
    const add = (label, obj, rel) => { if (obj && typeof obj === 'object') out.push({ label, obj, rel }); };
    const player = c.player || c.vehicles?.[0];
    if (player) {
      // Prefer a dedicated tuning bag if the vehicle exposes one.
      for (const key of ['tuning', 'config', 'params', 'setup', 'spec']) {
        if (player[key] && typeof player[key] === 'object') add('player.' + key, player[key], key);
      }
      add('player', player, '');
      if (player.tires) add('player.tires', player.tires, 'tires');
    }
    add('director', c.director, null);
    add('physics', c.physics, null);
    add('race', c.race, null);
    add('particles', c.fx?.particles, null);
    add('trails', c.fx?.trails, null);
    add('lighting', c.lighting, null);
    add('postfx', c.postfx, null);
    add('track', c.track, null);
    add('input', c.input, null);
    add('audio', c.audio, null);
    return out;
  }

  _buildInspector() {
    const targets = this._inspectTargets();
    const body = this._section('Live objects', targets.length === 0);
    if (targets.length === 0) {
      body.appendChild(el('div', 'mg-hint', 'no live systems yet — press refresh once the race is running'));
      const b = el('button', null, 'refresh');
      b.addEventListener('click', () => this._buildPanel());
      body.appendChild(b);
      return;
    }

    const head = el('div', 'mg-row');
    head.appendChild(el('label', null, 'target'));
    const sel = el('select');
    for (const t of targets) {
      const o = el('option', null, t.label);
      o.value = t.label;
      sel.appendChild(o);
    }
    head.appendChild(sel);
    body.appendChild(head);

    const allRow = el('div', 'mg-row');
    allRow.appendChild(el('label', null, 'apply to all cars'));
    const allBox = el('input');
    allBox.type = 'checkbox';
    allBox.checked = true;
    allBox.style.marginLeft = 'auto';
    allRow.appendChild(allBox);
    body.appendChild(allRow);

    const host = el('div');
    body.appendChild(host);

    // Everything appended past this mark belongs to the currently selected
    // target; switching targets rewinds to it so refreshers for detached
    // controls do not pile up.
    const mark = this._refreshers.length;
    const rebuild = () => {
      this._refreshers.length = mark;
      host.textContent = '';
      const t = targets.find((x) => x.label === sel.value) || targets[0];
      if (!t) return;
      this._autoControls(host, t.obj, t.rel, () => allBox.checked);
    };
    sel.addEventListener('change', rebuild);
    this._inspectorSel = sel;
    rebuild();

    const b = el('button', null, 'refresh targets');
    b.style.marginTop = '4px';
    b.addEventListener('click', () => this._buildPanel());
    body.appendChild(b);
  }

  /** Generate sliders/toggles for every finite number and boolean on `obj`. */
  _autoControls(parent, obj, rel, allFn) {
    let keys;
    try { keys = Object.keys(obj); } catch (_) { return; }
    let shown = 0;
    for (const k of keys) {
      if (k.startsWith('_')) continue;
      let v;
      try { v = obj[k]; } catch (_) { continue; }

      const write = (nv) => {
        obj[k] = nv;
        if (allFn && allFn() && rel !== null && Array.isArray(this.ctx.vehicles)) {
          for (const veh of this.ctx.vehicles) {
            const target = rel ? veh?.[rel] : veh;
            if (target && target !== obj && k in target) target[k] = nv;
          }
        }
      };

      if (typeof v === 'boolean') {
        this._toggle(parent, k, () => obj[k], write);
        shown++;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        const [min, max, step] = guessRange(v);
        this._slider(parent, k, () => obj[k], write, min, max, step);
        shown++;
      }
      if (shown >= 48) break; // a wall of sliders helps nobody
    }
    if (shown === 0) parent.appendChild(el('div', 'mg-hint', 'no numeric or boolean fields'));
  }

  _refreshAll() {
    this._buildPanel();
    this._refreshStats();
    this._syncButtons();
  }

  _syncButtons() {
    const b = this._buttons;
    if (!b) return;
    const engine = this.ctx.engine;
    b.pause?.classList.toggle('on', !!engine?.paused);
    b.freecam?.classList.toggle('on', this.freeCam);
    b.grid?.classList.toggle('on', this.showGrid);
    b.axes?.classList.toggle('on', this.showAxes);
    b.wire?.classList.toggle('on', this.wireframe);
    b.ui?.classList.toggle('on', this.uiHidden);
  }

  /* ------------------------------------------------------------------- stats */

  _refreshStats() {
    const engine = this.ctx.engine;
    const s = engine?.stats;
    if (!s) return;

    const fps = s.fps || 0;
    this.fpsNum.textContent = fps.toFixed(0);
    this.fpsNum.style.color = fps >= 58 ? '#8ef0a8' : fps >= 45 ? '#ffcf6b' : '#ff7a6a';
    this.fpsSub.textContent = `${s.frameMs.toFixed(1)} ms  ·  cpu ${s.cpuMs.toFixed(1)}  ·  ${engine.width}x${engine.height} @${Settings.render.pixelRatio.toFixed(2)}`;
    this.headInfo.textContent = Settings.quality + (engine.paused ? ' · paused' : '');

    const info = engine.renderer?.info;
    const rows = [
      ['fixed', s.fixedMs.toFixed(2) + ' ms', 'steps', String(s.steps)],
      ['update', s.updateMs.toFixed(2) + ' ms', 'late', s.lateMs.toFixed(2)],
      ['render', s.renderMs.toFixed(2) + ' ms', 'drop', String(s.droppedSteps)],
      ['draws', String(info?.render.calls ?? s.calls), 'tris', big(info?.render.triangles ?? s.triangles)],
      ['geo', String(info?.memory.geometries ?? s.geometries), 'tex', String(info?.memory.textures ?? s.textures)],
    ];
    const p = this.ctx.player || this.ctx.vehicles?.[0];
    if (p) {
      const speed = typeof p.speed === 'number' ? p.speed : 0;
      rows.push(['speed', speed.toFixed(1) + ' u/s', 'gear', String(p.gear ?? '-')]);
      rows.push(['slip', typeof p.slipAngle === 'number' ? p.slipAngle.toFixed(2) : '-',
        'state', (p.isAirborne ? 'air' : p.isDrifting ? 'drift' : 'grip')]);
    }
    this.counters.textContent = '';
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', null, r[0]));
      tr.appendChild(el('td', 'n', r[1]));
      tr.appendChild(el('td', null, ' ' + r[2]));
      tr.appendChild(el('td', 'n', r[3]));
      this.counters.appendChild(tr);
    }

    const prof = engine.profile?.() || [];
    this.sysTable.textContent = '';
    const hdr = el('tr');
    hdr.appendChild(el('td', null, 'system'));
    hdr.appendChild(el('td', 'n', 'fix'));
    hdr.appendChild(el('td', 'n', 'upd'));
    hdr.appendChild(el('td', 'n', 'tot'));
    this.sysTable.appendChild(hdr);
    for (let i = 0; i < Math.min(prof.length, 12); i++) {
      const r = prof[i];
      const tr = el('tr');
      const nameCell = el('td', r.errors > 0 ? 'e' : (!r.enabled ? 'w' : null), r.name);
      tr.appendChild(nameCell);
      tr.appendChild(el('td', 'n', r.fixed.toFixed(2)));
      tr.appendChild(el('td', 'n', (r.update + r.late).toFixed(2)));
      tr.appendChild(el('td', 'n', r.total.toFixed(2)));
      this.sysTable.appendChild(tr);
    }

    for (let i = 0; i < this._refreshers.length; i++) {
      try { this._refreshers[i](); } catch (_) { /* control was removed */ }
    }
  }

  _drawGraph() {
    const g = this.gctx;
    const engine = this.ctx.engine;
    if (!g || !engine) return;
    const hist = engine.frameHistory;
    if (!hist || !hist.length) return;
    const head = engine.frameHistoryIndex | 0;
    const n = hist.length;
    const w = HIST_W, h = HIST_H;

    g.clearRect(0, 0, w, h);

    // Budget lines: 60 fps and 30 fps.
    const scale = h / 50; // 50 ms full height
    g.strokeStyle = 'rgba(140,240,170,0.22)';
    g.beginPath();
    g.moveTo(0, h - 16.67 * scale + 0.5);
    g.lineTo(w, h - 16.67 * scale + 0.5);
    g.stroke();
    g.strokeStyle = 'rgba(255,120,100,0.16)';
    g.beginPath();
    g.moveTo(0, h - 33.3 * scale + 0.5);
    g.lineTo(w, h - 33.3 * scale + 0.5);
    g.stroke();

    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = hist[(head + i) % n];
      if (!(v > 0)) continue;
      const bh = Math.min(h, v * scale);
      g.fillStyle = v <= 17 ? 'rgba(142,240,168,0.72)'
        : v <= 34 ? 'rgba(255,207,107,0.75)'
          : 'rgba(255,122,106,0.8)';
      g.fillRect(i * bw, h - bh, Math.max(1, bw - 0.4), bh);
    }
  }
}

export function installDebug(ctx) {
  const d = new Debug(ctx);
  d.init();
  return d;
}

export default Debug;
