# MICRO GAUNTLET — Architecture Contract

**Read this file completely before writing a line of code.** Every module is built in
parallel by a different agent against these interfaces. If you deviate, integration breaks.

---

## 0. The game

A retro top-down/isometric arcade racer in the lineage of **Micro Machines**: tiny die-cast
toy cars tearing around circuits improvised across real household surfaces — a breakfast
table, a garden path, a workbench, a pool table, a kid's bedroom floor.

**Visual thesis: "Macro Toybox."** The scene is photographed as if with a macro tilt-shift
lens on a full-frame body. Miniaturisation is sold by optics, not by cartooning:

- Long lens (fov ~30–36°), shallow depth of field, gradient-masked tilt-shift blur at the
  top and bottom of frame.
- Physically-plausible PBR everywhere. Die-cast paint = thick clearcoat over metallic
  basecoat. Surfaces = real wood, real felt, real anodised aluminium, real crumbs.
- Strong directional key (a window), warm/cool split with cool bounce fill, deep contact
  shadows, believable AO in every crevice.
- Dust motes in the light shafts. Fingerprints on the varnish. Scale is a lie told by detail.

**Retro soul, modern execution.** The retro read comes from *design language*, never from
low fidelity: saturated primary-colour toy cars, chunky high-contrast HUD typography with
hard offset shadows, a chiptune-flavoured score with real drums, arcade-instant handling,
optional CRT/scanline grade. Nothing is allowed to look cheap, flat, or untextured.

**Non-negotiable quality bar:** every frame must survive a blind side-by-side against a
current-generation commercial racing game. If a reviewer can pick ours out as "the hobby
project" in under two seconds, it is not done.

---

## 1. Hard technical constraints

This machine has **no Node.js, no Python, no npm, no build step.** Work within that.

- Three.js **r180** is vendored at `vendor/three/`. Import via the importmap already in
  `index.html`: `import * as THREE from 'three'` and
  `import { X } from 'three/addons/postprocessing/X.js'`.
- **Everything is ES modules loaded directly by the browser.** No bundler, no JSX, no
  TypeScript, no transpilation. Plain modern JS (top-level await is available).
- **No new runtime dependencies.** Do not add a package, do not reference a CDN, do not
  `fetch()` a remote asset. If you need a library, write it.
- **Zero binary assets.** Every texture, mesh, and sound is generated procedurally at
  runtime, in code. No .png, .glb, .mp3, .hdr — none. This is a feature: it keeps the whole
  game inspectable and makes the art directable by parameter.
- Dev server: `powershell -File server.ps1` (port 8791), or the `micro-gauntlet` preview
  config. It serves the repo root with no-cache headers.

### Screenshots (how review works)

The browser pane does not reliably composite frames here, so ordinary screenshotting fails.
Instead the page renders on demand and POSTs a PNG to the dev server, which writes it to
`shots/`. From a browser tool:

```js
await window.MG.capture('name', 1920, 1080)   // -> shots/name.png
window.MG.probe()                             // -> { meanLuma, maxLuma } sanity check
```

Review agents then `Read` the PNG file directly. `shots/` is gitignored.

---

## 2. Units, scale, and the one deliberate lie

**1 world unit = 1 centimetre. Y is up. Tracks lie in the XZ plane. Ground is y = 0.**

| Quantity | Value |
|---|---|
| Car length | 9 u (a real 1:64 die-cast) |
| Car width / height | 4.0 u / 2.8 u |
| Wheelbase / track width | 5.6 u / 3.6 u |
| Wheel radius | 1.15 u |
| Mass | 1.0 (normalised; tune forces, not kilograms) |
| Top speed | 88–112 u/s depending on chassis |
| Track width | 22–34 u (≈ 2.5–4 car widths) |
| Lap length | 1800–2600 u (≈ 22–30 s laps) |
| Playfield bounds | ~460 × 340 u |
| Camera near / far | 2 / 4000 |
| Camera fov | 30–36° (long lens — critical to the miniature look) |

**The lie:** gravity is `260 u/s²`, not the physically correct `981`. Real gravity at
centimetre scale makes jumps last ~60 ms and look dead — this is exactly why miniature
effects shots are filmed with high-speed cameras and played back slow. We bake that
correction in. At 260, a 90 u/s launch off a 20° ramp gives ~0.24 s of air and ~21 u of
distance: about two and a half car lengths, which reads as a proper arcade jump.

`Settings.physics.gravity` is the single source of truth. Never hardcode 981 or 9.81.

---

## 3. Directory ownership

**You may only create and edit the files assigned to you.** If you need something from
another module, code against its documented interface and assume it exists. Do not edit
`src/main.js`, `index.html`, `server.ps1`, or `ARCHITECTURE.md` — those are owned by the
integrator. If you believe the contract is wrong, implement it as specified and say so in
your report.

```
src/
  main.js               [INTEGRATOR] bootstrap + wiring
  core/
    Engine.js           [A1] loop, fixed timestep, resize, system registry
    EventBus.js         [A1] pub/sub
    Settings.js         [A1] quality tiers, options, persistence
    Random.js           [A1] seeded PRNG + value/simplex/fbm noise
    Debug.js            [A1] stats, dev overlay, free-cam, tuning panel
    Capture.js          [INTEGRATOR] headless screenshots (already written)
  render/
    Renderer.js         [A2] WebGLRenderer config, tone mapping, shadow setup
    Lighting.js         [A2] sun rig, cascaded shadows, IBL, bounce fill
    PostFX.js           [A2] the full post chain
    Sky.js              [A2] environment, backdrop, procedural env map
    Materials.js        [A3] PBR material factory, shader patches, clearcoat
  textures/
    ProcTex.js          [A3] canvas/noise texture generators (albedo/normal/rough/ao)
    Surfaces.js         [A3] named surface library: wood, felt, sand, grass, tile, ...
  world/
    Track.js            [A4] track data model, spline, checkpoints, surface segments
    TrackBuilder.js     [A4] track data -> meshes (ribbon, kerbs, edges, walls)
    RacingLine.js       [A4] optimal-line solver used by AI and the minimap
    Props.js            [A5] instanced scenery system
    Decals.js           [A5] skid marks, spills, projected stains
    tracks/
      kitchen.js        [A5] breakfast table
      garden.js         [A5] garden path + sandbox
      workbench.js      [A5] garage workbench
      pool.js           [A5] pool table
      bedroom.js        [A5] bedroom floor + rug
  vehicle/
    Vehicle.js          [A6] chassis dynamics, raycast suspension, drift
    Tires.js            [A6] slip curves, per-surface grip
    VehicleVisual.js    [A7] procedural car mesh assembly, wheels, lights, damage
    CarModels.js        [A7] 8 distinct chassis designs + liveries
  physics/
    World.js            [A8] broadphase, integration, contact resolution
    Collision.js        [A8] shapes, impulses, car-car and car-prop response
  ai/
    Driver.js           [A9] line following, throttle planning, overtaking, mistakes
  fx/
    Particles.js        [A10] instanced GPU particles: smoke, dust, sparks, splash
    Trails.js           [A10] skid ribbons, tyre marks
    Impacts.js          [A10] collision flashes, debris, screen shake hooks
  audio/
    Audio.js            [A11] WebAudio graph, buses, mixer
    EngineSound.js      [A11] procedural rpm-driven engine synth
    Sfx.js              [A11] skids, impacts, pickups, countdown
    Music.js            [A11] generative chiptune-flavoured score
  game/
    Race.js             [A12] state machine, laps, checkpoints, positions, timing
    Director.js         [A12] camera director
    Input.js            [A12] keyboard + gamepad, deadzones, remapping
  ui/
    HUD.js              [A13] position, lap, timer, speedo, minimap
    Menu.js             [A13] title, car select, track select, options
    Results.js          [A13] post-race standings
    style.css           [A13] all UI styling
```

---

## 4. The shared context object

One context object is threaded through everything. `main.js` builds it and passes it to
every system's constructor and update call.

```js
ctx = {
  engine, renderer, scene, camera, composer,   // core/render
  settings, bus, rng, assets,
  time: { elapsed, dt, fixedDt, frame },
  track,        // world/Track instance (current)
  physics,      // physics/World instance
  vehicles,     // Vehicle[] — index 0..n, player included
  player,       // Vehicle (convenience alias)
  race,         // game/Race instance
  director,     // game/Director instance
  fx,           // { particles, trails, impacts }
  audio, hud, input, debug,
}
```

## 5. The system interface

Every subsystem exposes this shape. All methods are optional except `name`.

```js
export class ThingSystem {
  name = 'thing';
  constructor(ctx) {}
  async init() {}                 // async setup: build geometry, generate textures
  fixedUpdate(fdt, ctx) {}        // physics tick, exactly 1/120 s, may run 0..N times/frame
  update(dt, ctx) {}              // per render frame, variable dt (clamped to 0.05 max)
  lateUpdate(dt, ctx) {}          // after all updates: cameras, HUD, anything that reads state
  onResize(w, h) {}
  dispose() {}
}
```

Registration order in `main.js` determines update order. Physics runs before AI reads it;
the director runs in `lateUpdate` so it sees final vehicle transforms.

---

## 6. Interfaces you must implement (or may rely on)

### core/Settings.js — [A1]

```js
export const QUALITY = ['low', 'medium', 'high', 'ultra'];
export const Settings = {
  quality: 'ultra',
  render: { pixelRatio, shadowMapSize, anisotropy, msaaSamples },
  post: { ssao, bloom, tiltShift, motionBlur, grade, grain, chromatic, vignette, crt },
  physics: { gravity: 260, fixedHz: 120, substeps: 1 },
  audio: { master, music, sfx },
  gameplay: { assists, aiDifficulty },
  load(), save(), apply(ctx), forQuality(tier)   // forQuality returns a settings patch
};
```

### core/Random.js — [A1]

```js
export function makeRng(seed);        // -> { next(), range(a,b), int(a,b), pick(arr), sign() }
export function value2D(x, y, seed);  // deterministic value noise, [0,1]
export function simplex2D(x, y);      // [-1,1]
export function fbm2D(x, y, octaves, lacunarity, gain);
export function worley2D(x, y, seed); // cellular, for crumbs/gravel/leather
```
Determinism matters: same seed must produce identical tracks and textures every run.

### textures/ProcTex.js — [A3]

All generators return a `THREE.CanvasTexture` (or `DataTexture`) already configured with
correct `colorSpace`, `wrapS/T`, and anisotropy. Never return a raw canvas.

```js
export function makeTextureSet(kind, opts) -> {
  map, normalMap, roughnessMap, aoMap, displacementMap?, alphaMap?
}
```
`kind` is one of the named surfaces in `Surfaces.js`. Textures must be **seamlessly
tileable** — no visible repetition seams — and generated at 1024² (2048² on ultra).
Normal maps must be derived from the height field, not faked.

Required surface kinds: `oak`, `pine`, `varnishedWood`, `laminate`, `poolFelt`, `carpet`,
`rug`, `sand`, `grass`, `soil`, `gravel`, `concrete`, `ceramicTile`, `linoleum`,
`brushedAluminium`, `galvanisedSteel`, `chromePlate`, `plasticMatte`, `plasticGloss`,
`rubber`, `paper`, `cardboard`, `spilledMilk`, `oilSlick`, `waterPuddle`, `chalkLine`,
`gaffaTape`, `crumbs`, `sawdust`.

### render/Materials.js — [A3]

```js
export const Materials = {
  get(kind, opts) -> THREE.Material,        // cached, shared
  carPaint({ color, flake, clearcoat }),    // metallic basecoat + clearcoat lobe
  chrome(), glass(), rubber(), plasticToy({ color }),
  surface(kind, { repeat, triplanar }),
  dispose()
};
```
Car paint must have a real clearcoat: a second specular lobe with its own roughness, plus
metallic flake sparkle that only resolves at close range. This is the single biggest
"is it AAA" tell on the cars.

### render/PostFX.js — [A2]

```js
export class PostFX {
  constructor(ctx)
  build()                       // assemble composer chain per Settings.post
  setQuality(tier)
  onResize(w, h)
  render(dt)
}
```
**Chain order (do not reorder):**
`RenderPass → GTAO/SSAO → Bloom (specular-thresholded) → Tilt-shift DOF (gradient-masked,
separable) → Motion blur (camera velocity reprojection) → Colour grade (ACES + lift/gamma/
gain + procedural LUT) → Chromatic aberration → Vignette → Film grain → SMAA → OutputPass`

Tilt-shift is the signature effect and must be a custom pass: a vertical gradient defines
the in-focus band, blur radius ramps quadratically away from it, and the band's centre
tracks the player car in screen space. Bloom must key off specular highlights, not overall
brightness — no milky wash. Grain must be animated and subtle (≤ 0.04 at ultra).

### render/Lighting.js — [A2]

```js
export class Lighting {
  constructor(ctx)
  async init()
  setPreset(name)     // 'morning' | 'noon' | 'goldenHour' | 'overcast' | 'dusk' | 'nightLamp'
  update(dt, ctx)
}
```
Cascaded shadow maps (3 cascades) covering the playfield with tight fits; PCF soft shadows.
A procedurally generated environment map (no HDR files) drives IBL — build it by rendering
a gradient sky + ground bounce into a `PMREMGenerator`. Contact shadows under cars are
mandatory; a car that appears to float is an automatic fail.

### world/Track.js — [A4]

```js
export class Track {
  constructor(def, ctx)          // def is a track definition module's export
  async build()                  // generate all geometry, add to scene
  // Query API used by vehicles, AI, physics, HUD:
  sampleAt(t) -> { pos: Vector3, tangent: Vector3, normal: Vector3, width, surface, banking }
  nearestT(pos) -> t             // [0,1) around the lap
  surfaceAt(pos) -> surfaceName  // drives grip, particles, and audio
  heightAt(x, z) -> y            // ground height, includes ramps and banking
  isOnTrack(pos) -> bool
  checkpoints -> Checkpoint[]    // ordered, with { index, position, normal, width }
  spawnPoints -> { position, rotation }[]
  bounds -> Box3
  length -> number               // lap length in world units
}
```

### Track definition format — [A5]

Each file in `world/tracks/` default-exports:

```js
export default {
  id: 'kitchen',
  name: 'BREAKFAST RUSH',
  theme: 'kitchen',
  lighting: 'morning',
  seed: 1337,
  laps: 3,
  difficulty: 1,
  // Centreline control points in world units. The spline is a closed
  // CatmullRomCurve3 through these, so keep spacing reasonably even.
  path: [ [x, y, z], ... ],
  // Width and surface can vary along the lap; t is [0,1).
  widthProfile: [ { t: 0, width: 28 }, ... ],
  surfaceSpans: [ { from: 0.0, to: 0.35, surface: 'oak' }, ... ],
  hazards: [ { type: 'ramp'|'puddle'|'gap'|'bump'|'oil'|'fan', t, ... } ],
  props:   [ { model: 'cerealBox', position: [x,y,z], rotation, scale, collide: true } ],
  ambient: { fogColor, fogDensity, dustDensity },
};
```

### vehicle/Vehicle.js — [A6]

```js
export class Vehicle {
  constructor(ctx, { model, livery, isPlayer, driverName })
  position, quaternion, velocity, angularVelocity   // THREE types, authoritative
  speed, rpm, gear, slipAngle, isDrifting, isAirborne, wheelContacts[4]
  setControls({ throttle, brake, steer, handbrake, boost })  // all -1..1 or 0..1
  fixedUpdate(fdt, ctx)
  respawn(t)                        // put back on track at spline param t
  applyImpulse(v3, atPoint)
}
```
Four raycast suspension springs (spring + damper, anti-roll bars), a Pacejka-flavoured tyre
model with separate longitudinal and lateral slip curves, per-surface grip multipliers,
weight transfer under braking and cornering, aero downforce, and a controllable drift: on
handbrake the rear slip limit drops, and counter-steer must genuinely recover the slide.
Airborne cars keep angular momentum and can be pitch-corrected slightly by the player.
It must feel *arcade-instant* — grippy, forgiving, always recoverable — not a sim.

### physics/World.js — [A8]

```js
export class PhysicsWorld {
  constructor(ctx)
  addBody(body), removeBody(body)
  raycast(origin, dir, maxDist, mask) -> { hit, point, normal, distance, surface, body }
  fixedUpdate(fdt, ctx)
  onContact(cb)   // cb({ a, b, point, normal, impulse, relativeSpeed })
}
```
Cars are oriented boxes; props are boxes/cylinders/spheres. Car-car collisions must produce
satisfying arcade shunts that conserve momentum and transfer spin. Nothing may ever tunnel
at top speed — use swept tests or enough substeps.

### ai/Driver.js — [A9]

```js
export class Driver {
  constructor(ctx, vehicle, { skill, aggression, consistency, seed })
  update(dt, ctx)   // sets vehicle.setControls(...)
}
```
Follow the racing line with lookahead proportional to speed; brake for corners using a
proper speed-for-curvature calculation, not a lookup; take alternate lines to overtake;
avoid collisions; make *believable* mistakes scaled by `consistency`. Mild rubber-banding
is allowed (±6% max) and must never be visible as obvious catch-up.

### game/Director.js — [A12]

```js
export class Director {
  constructor(ctx)
  lateUpdate(dt, ctx)
  setMode(mode)       // 'race' | 'intro' | 'results' | 'replay' | 'free'
  shake(amount, duration)
  focusOn(vehicle)
}
```
A high-angle 3/4 chase (pitch 48–62°) that frames the player with lookahead along their
velocity, auto-zooms to keep nearby rivals in shot, banks slightly into drifts, punches in
on boost, and shakes on impact. All motion is critically damped — no spring oscillation, no
snapping. The intro is a slow orbiting establishing shot of the track.

### fx/Particles.js — [A10]

```js
export class Particles {
  constructor(ctx)
  async init()
  emit(kind, { position, velocity, count, spread, color, scale, life })
  update(dt, ctx)
}
```
Kinds: `tyreSmoke`, `dust`, `sand`, `grassClipping`, `sparks`, `waterSplash`, `milkSplash`,
`exhaust`, `debris`, `boostFlame`, `dustMote`. One instanced draw call per kind, soft
particles (depth-faded so they don't cut into the ground), lit by the sun direction, and
sorted where it matters. Smoke must billow and dissipate, not pop.

### audio/*.js — [A11]

All sound is synthesised with WebAudio — no files. The engine is an oscillator stack whose
harmonic content tracks rpm and load, with proper gear shifts, overrun crackle, and a
distinct note per chassis. Doppler and distance attenuation for rivals. Skid volume tracks
lateral slip. Music is a generative chiptune-flavoured score layered with filtered noise
percussion, with an intensity parameter tied to race position. Must start muted until first
user gesture (browser autoplay policy) and expose `audio.unlock()`.

### ui/HUD.js — [A13]

DOM-based, inside `#ui-root`. Position/lap/lap-time/best/speedo/minimap/pickup slot.
Chunky arcade type with hard offset shadows, animated position changes, a countdown, and
lap-time deltas that flash green/red. It must look designed, not defaulted: no browser
default fonts, no unstyled boxes, consistent 8-px rhythm, and it must not obscure the
action. Fonts must be CSS-only (system stacks or generated) — no webfont downloads.

---

## 7. Rules that apply to every agent

1. **The app must always boot.** Never leave a syntax error or a missing export. Your module
   is imported by `main.js` at startup; if it throws, the whole game is a black screen.
2. **Guard against missing peers.** Another agent's module may still be a stub while you
   run. Use optional calls (`ctx.audio?.play?.()`) for cross-system calls.
3. **No placeholder art.** No `MeshBasicMaterial({color:'red'})` left in, no untextured
   grey boxes, no "TODO texture". If it ships in a frame, it is finished.
4. **Performance target: 60 fps at 1080p on ultra.** Instance everything repeated. Share
   materials and geometry. Never allocate in a per-frame loop — preallocate scratch vectors
   at module scope. Dispose what you create.
5. **Determinism.** Take randomness from `ctx.rng` or a seeded `makeRng`, never `Math.random()`.
6. **Comment the non-obvious only.** Explain why a magic number was chosen, not what a line does.
7. Write in the style already present in the repo: plain modern JS, named exports,
   two-space indent, single quotes, semicolons.

---

## 8. Definition of done

Your module is done when a hostile reviewer, shown a 1080p frame of the game next to a
frame from a current commercial racing title, cannot tell which is the indie one — and when
the thing you built is the reason they can't tell.
