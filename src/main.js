// MICRO GAUNTLET — bootstrap and wiring.
//
// Owned by the integrator. Subsystems are built independently against
// ARCHITECTURE.md; this file is the only place that knows about all of them.
//
// Modules are loaded dynamically and individually rather than with static
// imports. With a dozen subsystems landing in parallel, one bad file would
// otherwise take the whole game down with an opaque black screen. Instead each
// failure is isolated, recorded in window.MG.status, and the rest still runs.

import * as THREE from 'three';
import { installCapture } from './core/Capture.js';

const params = new URLSearchParams(location.search);
const status = { loaded: [], failed: [], warnings: [] };

/** Dynamic import that records failures instead of propagating them. */
async function load(path) {
  try {
    const mod = await import(path);
    status.loaded.push(path);
    return mod;
  } catch (err) {
    status.failed.push({ path, error: String(err && (err.stack || err.message || err)) });
    console.error('[MG] module failed:', path, err);
    return null;
  }
}

/** Pull the first export that exists, tolerating naming drift between agents. */
function pick(mod, ...names) {
  if (!mod) return null;
  for (const n of names) if (mod[n]) return mod[n];
  return mod.default ?? null;
}

/** Construct defensively: a throwing constructor must not abort the boot. */
function build(Ctor, label, ...args) {
  if (!Ctor) {
    status.warnings.push(`${label}: not available`);
    return null;
  }
  try {
    return typeof Ctor === 'function' && /^\s*class\s/.test(Ctor.toString())
      ? new Ctor(...args)
      : Ctor(...args);
  } catch (err) {
    status.failed.push({ path: label, error: String(err && (err.stack || err.message || err)) });
    console.error('[MG] construct failed:', label, err);
    return null;
  }
}

async function initSystem(sys, label) {
  if (!sys?.init) return sys;
  try {
    await sys.init();
  } catch (err) {
    status.failed.push({ path: `${label}.init`, error: String(err && (err.stack || err.message || err)) });
    console.error('[MG] init failed:', label, err);
  }
  return sys;
}

function setBootMessage(msg) {
  const el = document.querySelector('#boot .boot-msg');
  if (el) el.textContent = msg;
}

async function boot() {
  const canvas = document.getElementById('stage');

  // ---- core ---------------------------------------------------------------
  setBootMessage('starting engine');
  const [coreEngine, coreBus, coreSettings, coreRandom, coreDebug] = await Promise.all([
    load('./core/Engine.js'),
    load('./core/EventBus.js'),
    load('./core/Settings.js'),
    load('./core/Random.js'),
    load('./core/Debug.js'),
  ]);

  const Settings = pick(coreSettings, 'Settings', 'settings') || {
    quality: 'ultra',
    physics: { gravity: 260, fixedHz: 120 },
    render: {},
    post: {},
    audio: {},
    gameplay: {},
  };
  Settings.load?.();
  if (params.has('quality')) Settings.quality = params.get('quality');

  const Bus = pick(coreBus, 'EventBus', 'Bus');
  const bus = build(Bus, 'EventBus') || {
    on() {}, off() {}, emit() {},
  };

  const makeRng = coreRandom?.makeRng;
  const seed = Number(params.get('seed') ?? 20260730);
  const rng = makeRng ? makeRng(seed) : { next: () => 0.5, range: (a, b) => (a + b) / 2 };

  // ---- rendering ----------------------------------------------------------
  setBootMessage('building renderer');
  const [rRenderer, rLighting, rPostFX, rSky, rMaterials, tProcTex, tSurfaces] = await Promise.all([
    load('./render/Renderer.js'),
    load('./render/Lighting.js'),
    load('./render/PostFX.js'),
    load('./render/Sky.js'),
    load('./render/Materials.js'),
    load('./textures/ProcTex.js'),
    load('./textures/Surfaces.js'),
  ]);

  const W = innerWidth || 1920;
  const H = innerHeight || 1080;

  const makeRenderer = pick(rRenderer, 'createRenderer', 'makeRenderer', 'Renderer');
  let renderer = null;
  if (makeRenderer) renderer = build(makeRenderer, 'Renderer', canvas, Settings);
  if (renderer && renderer.renderer) renderer = renderer.renderer; // class wrapper
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    status.warnings.push('Renderer: using fallback');
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Settings.render?.pixelRatio ?? 2));
  renderer.setSize(W, H, false);
  // Required so the headless capture path can read the framebuffer back.
  renderer.debug.checkShaderErrors = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, W / H, 2, 4000);
  camera.position.set(0, 190, 240);
  camera.lookAt(0, 0, 0);

  // ---- shared context -----------------------------------------------------
  const ctx = {
    THREE,
    renderer,
    scene,
    camera,
    canvas,
    settings: Settings,
    bus,
    rng,
    seed,
    time: { elapsed: 0, dt: 0, fixedDt: 1 / (Settings.physics?.fixedHz ?? 120), frame: 0 },
    vehicles: [],
    fx: {},
    params,
  };

  // ---- materials & textures ----------------------------------------------
  setBootMessage('painting surfaces');
  ctx.procTex = tProcTex;
  ctx.surfaces = pick(tSurfaces, 'Surfaces', 'SurfaceLibrary');
  await ctx.surfaces?.init?.(ctx);
  ctx.materials = pick(rMaterials, 'Materials', 'MaterialFactory');
  if (ctx.materials?.init) await ctx.materials.init(ctx);
  ctx.assets = { materials: ctx.materials, surfaces: ctx.surfaces, tex: tProcTex };

  // ---- lighting, sky, post ------------------------------------------------
  setBootMessage('lighting the set');
  ctx.lighting = await initSystem(build(pick(rLighting, 'Lighting'), 'Lighting', ctx), 'Lighting');
  ctx.sky = await initSystem(build(pick(rSky, 'Sky', 'SkyBox'), 'Sky', ctx), 'Sky');
  ctx.postfx = await initSystem(build(pick(rPostFX, 'PostFX'), 'PostFX', ctx), 'PostFX');
  ctx.postfx?.build?.();
  ctx.composer = ctx.postfx?.composer ?? null;

  // ---- physics ------------------------------------------------------------
  setBootMessage('winding up physics');
  const [pWorld, pCollision] = await Promise.all([
    load('./physics/World.js'),
    load('./physics/Collision.js'),
  ]);
  ctx.physics = await initSystem(
    build(pick(pWorld, 'PhysicsWorld', 'World'), 'PhysicsWorld', ctx),
    'PhysicsWorld'
  );
  ctx.collision = pCollision;

  // ---- world --------------------------------------------------------------
  setBootMessage('laying out the circuit');
  const [wTrack, wBuilder, wLine, wProps, wDecals] = await Promise.all([
    load('./world/Track.js'),
    load('./world/TrackBuilder.js'),
    load('./world/RacingLine.js'),
    load('./world/Props.js'),
    load('./world/Decals.js'),
  ]);
  ctx.trackBuilder = wBuilder;
  ctx.racingLineMod = wLine;
  ctx.props = await initSystem(build(pick(wProps, 'Props', 'PropSystem'), 'Props', ctx), 'Props');
  ctx.decals = await initSystem(build(pick(wDecals, 'Decals', 'DecalSystem'), 'Decals', ctx), 'Decals');

  const trackId = params.get('track') || 'kitchen';
  const trackDefMod = await load(`./world/tracks/${trackId}.js`);
  const trackDef = trackDefMod?.default ?? trackDefMod?.track ?? null;
  const Track = pick(wTrack, 'Track');
  if (Track && trackDef) {
    ctx.track = build(Track, 'Track', trackDef, ctx);
    try {
      await ctx.track?.build?.();
    } catch (err) {
      status.failed.push({ path: 'Track.build', error: String(err && (err.stack || err.message || err)) });
      console.error('[MG] track build failed:', err);
    }
    ctx.racingLine =
      ctx.track?.racingLine ??
      build(pick(wLine, 'RacingLine'), 'RacingLine', ctx.track, ctx);
  } else {
    status.warnings.push(`Track: could not load "${trackId}"`);
  }

  // ---- fx -----------------------------------------------------------------
  setBootMessage('lighting the fuse');
  const [fParticles, fTrails, fImpacts] = await Promise.all([
    load('./fx/Particles.js'),
    load('./fx/Trails.js'),
    load('./fx/Impacts.js'),
  ]);
  ctx.fx.particles = await initSystem(
    build(pick(fParticles, 'Particles', 'ParticleSystem'), 'Particles', ctx), 'Particles');
  ctx.fx.trails = await initSystem(
    build(pick(fTrails, 'Trails', 'TrailSystem'), 'Trails', ctx), 'Trails');
  ctx.fx.impacts = await initSystem(
    build(pick(fImpacts, 'Impacts', 'ImpactSystem'), 'Impacts', ctx), 'Impacts');

  // ---- audio --------------------------------------------------------------
  const [aAudio] = await Promise.all([load('./audio/Audio.js')]);
  ctx.audio = await initSystem(build(pick(aAudio, 'Audio', 'AudioSystem'), 'Audio', ctx), 'Audio');

  // ---- vehicles & drivers -------------------------------------------------
  setBootMessage('rolling out the grid');
  const [vVehicle, vVisual, vModels, aiDriver] = await Promise.all([
    load('./vehicle/Vehicle.js'),
    load('./vehicle/VehicleVisual.js'),
    load('./vehicle/CarModels.js'),
    load('./ai/Driver.js'),
  ]);
  const Vehicle = pick(vVehicle, 'Vehicle');
  const Driver = pick(aiDriver, 'Driver');
  const CAR_MODELS = pick(vModels, 'CAR_MODELS', 'CarModels', 'MODELS');
  ctx.carModels = CAR_MODELS;
  ctx.vehicleVisualMod = vVisual;

  // Build the field from the promoted roster only (CarModels.ROSTER), not from
  // every authored chassis. Eight chassis exist and all of them work; three are
  // what a wave can carry to a die-cast finish, so the other five are out of
  // the quality budget rather than out of the repo. `?cars=N` still sets the
  // grid size — the roster wraps.
  const allModelIds = Array.isArray(CAR_MODELS)
    ? CAR_MODELS.map((m) => m.id ?? m.name)
    : CAR_MODELS && typeof CAR_MODELS === 'object'
      ? Object.keys(CAR_MODELS)
      : [];
  const roster = pick(vModels, 'ROSTER');
  const modelIds = Array.isArray(roster) && roster.length
    ? roster.filter((id) => allModelIds.includes(id))
    : allModelIds;

  const FIELD = Number(params.get('cars') ?? 8);

  // Colour-separated grid. `roster[i % 3]` with `livery: i` gave eight distinct
  // (chassis, livery) pairs but three blues, two of them 28 apart in RGB — the
  // same car twice as far as a player can tell at 40 pixels. `assignField`
  // keeps the chassis cycle and picks liveries by farthest-point, taking the
  // worst pair on a full grid from 28 to 75. Falls back to the old arithmetic if
  // the module predates it.
  //
  // `?liveryMode=index` restores the old `livery: i` arithmetic. It exists so the
  // two schemes can be captured from ONE build at the SAME pinned race moment,
  // which is the only way to A/B a change that is purely about colour — see D25.
  //
  // `?liveryMode=oak` reproduces the grid as it stood BEFORE the field was scored
  // against all six of the kitchen's surfaces instead of just the table's oak:
  // one surface, and no Cyan Flash. Same purpose as `index` above — a colour
  // change can only be judged with both versions rendered from one build.
  const assignField = pick(vModels, 'assignField');
  const legacySurface = pick(vModels, 'DEFAULT_SURFACE_RGB');
  const liveryMode = params.get('liveryMode') || 'separated';
  const grid = (liveryMode !== 'index' && typeof assignField === 'function')
    ? assignField(FIELD, roster, liveryMode === 'oak'
      ? { surface: legacySurface, exclude: ['Cyan Flash'] }
      : undefined)
    : null;

  ctx.drivers = [];
  if (Vehicle) {
    for (let i = 0; i < FIELD; i++) {
      const isPlayer = i === 0;
      const v = build(Vehicle, `Vehicle[${i}]`, ctx, {
        model: grid?.[i]?.model ?? modelIds[i % Math.max(1, modelIds.length)] ?? 'muscle',
        livery: grid?.[i]?.livery ?? i,
        isPlayer,
        driverName: isPlayer ? 'YOU' : `CPU ${i}`,
        gridIndex: i,
      });
      if (!v) break;
      await initSystem(v, `Vehicle[${i}]`);
      ctx.vehicles.push(v);
      if (isPlayer) ctx.player = v;
      else if (Driver) {
        const d = build(Driver, `Driver[${i}]`, ctx, v, {
          skill: 0.72 + (i / FIELD) * 0.24,
          aggression: 0.4 + rng.next() * 0.5,
          consistency: 0.7 + rng.next() * 0.28,
          seed: seed + i * 7919,
        });
        if (d) ctx.drivers.push(d);
      }
    }
  }
  if (!ctx.vehicles.length) status.warnings.push('Vehicles: none spawned');

  // ---- game systems -------------------------------------------------------
  setBootMessage('checking the flags');
  const [gRace, gDirector, gInput] = await Promise.all([
    load('./game/Race.js'),
    load('./game/Director.js'),
    load('./game/Input.js'),
  ]);
  ctx.input = await initSystem(build(pick(gInput, 'Input', 'InputSystem'), 'Input', ctx), 'Input');
  ctx.race = await initSystem(build(pick(gRace, 'Race', 'RaceSystem'), 'Race', ctx), 'Race');
  ctx.director = await initSystem(build(pick(gDirector, 'Director'), 'Director', ctx), 'Director');

  // ---- ui -----------------------------------------------------------------
  const [uHud, uMenu, uResults] = await Promise.all([
    load('./ui/HUD.js'),
    load('./ui/Menu.js'),
    load('./ui/Results.js'),
  ]);
  ctx.hud = await initSystem(build(pick(uHud, 'HUD'), 'HUD', ctx), 'HUD');
  ctx.menu = await initSystem(build(pick(uMenu, 'Menu'), 'Menu', ctx), 'Menu');
  ctx.results = await initSystem(build(pick(uResults, 'Results'), 'Results', ctx), 'Results');
  ctx.debug = await initSystem(build(pick(coreDebug, 'Debug'), 'Debug', ctx), 'Debug');

  // ---- engine assembly ----------------------------------------------------
  const Engine = pick(coreEngine, 'Engine');
  const engine = build(Engine, 'Engine', ctx) ?? makeFallbackEngine(ctx);
  ctx.engine = engine;

  // Update order matters: physics settles, AI reads settled state, vehicles
  // integrate, fx react, and the director runs last so it sees final transforms.
  for (const sys of [
    ctx.input, ctx.physics, ...ctx.drivers, ...ctx.vehicles, ctx.track,
    ctx.props, ctx.decals, ctx.fx.particles, ctx.fx.trails, ctx.fx.impacts,
    ctx.lighting, ctx.sky, ctx.audio, ctx.race, ctx.hud, ctx.menu,
    ctx.results, ctx.director, ctx.debug,
  ]) {
    if (sys) engine.add?.(sys);
  }

  installCapture(engine);
  window.MG.ctx = ctx;
  window.MG.status = status;
  window.MG.THREE = THREE;

  // Deterministic entry points for automated review: skip straight into a race
  // and optionally fast-forward the simulation so the field is spread out and
  // effects are active before the frame is captured.
  const skipMenu = params.get('skipmenu') === '1' || params.has('t');
  if (skipMenu) {
    ctx.menu?.hide?.();
    // begin() is an alias for start(), so `start(...) ?? begin()` fires both
    // whenever start() returns undefined and re-enters the state machine.
    const startRace = ctx.race?.start ?? ctx.race?.begin;
    startRace?.call(ctx.race, { skipCountdown: true });
  }
  if (params.get('nohud') === '1') ctx.hud?.hide?.();

  // Fast-forward advances the whole simulation so the field is spread out and
  // the effects are alive before a review frame is captured.
  //
  // This used to hand-pump a hardcoded list of systems around
  // `engine.stepFixed?.(fdt)`. Engine has no `stepFixed` — it never has — so
  // the optional call silently did nothing and all 31 registered systems,
  // physics included, sat still through every capture. The hand-pumped list
  // was me patching the symptom: it moved the cars, but with no physics step
  // behind it the field crawled roughly an eighth of the expected distance,
  // and Race.fixedUpdate never ran, so the clock and the lap counter stayed
  // at zero in every fast-forwarded shot.
  //
  // `stepOnce()` is the real entry point: correct time bookkeeping, all
  // systems, right phase order, bus flushed. It also renders, which is the one
  // thing we cannot afford 1920 times, so suppress just that for the burst.
  const ff = Number(params.get('t') ?? 0);
  if (ff > 0) {
    const fdt = ctx.time.fixedDt;
    const steps = Math.min(Math.round(ff / fdt), 60 * 120);
    const realRender = engine.renderFrame;
    engine.renderFrame = () => {};        // own property shadows the prototype
    try {
      for (let i = 0; i < steps; i++) engine.stepOnce();
    } finally {
      delete engine.renderFrame;
      if (engine.renderFrame !== realRender) engine.renderFrame = realRender;
    }
    window.MG.fastForwarded = { seconds: ff, steps };
  }

  document.getElementById('boot')?.remove();
  engine.start?.();

  window.__mgReady = {
    ok: status.failed.length === 0,
    loaded: status.loaded.length,
    failed: status.failed.length,
    vehicles: ctx.vehicles.length,
    track: trackId,
  };
  console.log('[MG] boot complete', window.__mgReady, status);
}

/** Minimal loop used only if core/Engine.js is unavailable. */
function makeFallbackEngine(ctx) {
  const systems = [];
  let last = performance.now();
  let acc = 0;
  const fdt = ctx.time.fixedDt;
  const engine = {
    ctx,
    renderer: ctx.renderer,
    composer: ctx.composer,
    scene: ctx.scene,
    camera: ctx.camera,
    add: (s) => systems.push(s),
    stepFixed(dt) {
      for (const s of systems) s.fixedUpdate?.(dt, ctx);
    },
    onResize(w, h) {
      ctx.camera.aspect = w / h;
      ctx.camera.updateProjectionMatrix();
      ctx.renderer.setSize(w, h, false);
      ctx.postfx?.onResize?.(w, h);
      for (const s of systems) s.onResize?.(w, h);
    },
    renderFrame(dt = 1 / 60) {
      ctx.time.dt = dt;
      ctx.time.elapsed += dt;
      ctx.time.frame++;
      acc += dt;
      let n = 0;
      while (acc >= fdt && n++ < 5) {
        engine.stepFixed(fdt);
        acc -= fdt;
      }
      for (const s of systems) s.update?.(dt, ctx);
      for (const s of systems) s.lateUpdate?.(dt, ctx);
      if (ctx.postfx?.render) ctx.postfx.render(dt);
      else if (ctx.composer) ctx.composer.render();
      else ctx.renderer.render(ctx.scene, ctx.camera);
    },
    start() {
      ctx.renderer.setAnimationLoop((now) => {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        engine.renderFrame(dt);
      });
    },
  };
  addEventListener('resize', () => engine.onResize(innerWidth, innerHeight));
  ctx.warnFallbackEngine = true;
  return engine;
}

boot().catch((err) => window.__mgFatal?.(err));
