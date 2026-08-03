# Open defects

Found during integration verification. Fed into the post-build fix wave.
Each entry names the owning module per ARCHITECTURE.md section 3.

## D1 — `Materials.carPaint()` renders invisible — CRITICAL — FIXED
`render/Materials.js` [A3]. Root cause: the flake and orange-peel fragment blocks rotate an
object-space direction into view space with `normalMatrix`. three declares that uniform in
the **vertex** prefix only, so referencing it from the fragment stage is an undeclared
identifier, the program fails to link, and the material draws nothing at all.

My first two diagnoses were wrong and worth recording: I assumed the injected chunk was
zeroing alpha, and separately trusted `renderer.debug.checkShaderErrors` reporting "no
error" — the error *was* being logged, but a filtered console read returned nothing and I
took that as absence of evidence. Reading the unfiltered console gave the exact line.

Fix: re-declare `uniform mat3 normalMatrix;` in the fragment prefix when `flake` or `peel`
is active, guarded against double declaration. GLSL uniforms are program-wide, so it binds
to the value three already uploads. Verified in `shots/mats-fixed.png` — flake sparkle and
clearcoat highlight both resolve.

## D2 — `Materials.plasticToy()` renders invisible — CRITICAL — FIXED
Same root cause as D1 (shared `peel` path), fixed by the same change. Verified.

## D3 — `Materials.rubber()` crushes to pure black
`render/Materials.js` [A3]. Reads as a void, not a substance. Real tyre rubber has a soft
broad sheen and sits around 0.05–0.08 albedo, not 0. Needs a specular response so the
silhouette separates from shadow.

## D4 — `brushedAluminium` reads as matte blue paint, not metal
`textures/Surfaces.js` + `ProcTex.js` [A3]. Albedo carries a strong blue tint and the
roughness map is high enough across the surface that the metal never resolves a specular
highlight. Should be near-neutral grey with anisotropic streaks and roughness ~0.25–0.40.

## D5 — `oak` has blue-tinted knot artifacts
`textures/ProcTex.js` [A3]. Knots and nail holes render as desaturated blue dots. Should be
dark warm brown. The grain, plank seams and ray fleck are otherwise excellent — this is a
palette bug in the knot pass only.

## D6, D7, D8 — ALL FIXED BY ONE SIGN ERROR

`world/Track.js` built its per-frame surface normal as `right × tangent`. With forward = +Z
the `right` vector it constructs is +X, and X × Z = **−Y** — so every track frame's normal
pointed straight down. Corrected to `tangent × right` (Z × X = +Y).

That single error produced every symptom below, which is why they looked like three
independent bugs in three different modules:

- **Cars spawned upside-down.** `basisFromFrame` feeds the normal in as "up", so an inverted
  normal flips the grid quaternion. Measured `up · worldUp = −0.984` at spawn.
- **Cars fell through the track.** Inverted cars point their wheels skyward, so the
  suspension rays cast *away* from the road and never found ground. They free-fell to
  y ≈ −32. This looked like a physics bug; physics was fine. `PhysicsWorld` even masked the
  bad normal with an `n.y > 0.05` fallback, which is why a direct `raycast()` probe returned
  a correct (0,1,0) and sent me looking in the wrong module.
- **The race finished instantly.** Cars tumbling below the world produced nonsense checkpoint
  progress, so every entry reported `lap: 3, finished: true` within a tick.
- **The road ribbon rendered washed-out**, because its normals faced away from the sun.

After the fix: `up · worldUp = 1`, all four wheels grounded, body resting at y = 2.29,
race state `racing`, zero module errors. Verified in `shots/fixed-grid.png`.

The earlier D7 "livery bakes near-black" entry was a **misdiagnosis** — I sampled the paint
atlas across regions that are legitimately dark trim. The liveries render correctly in colour
once the cars are the right way up.

## (historical) D6 — Cars spawn upside-down — CRITICAL
`vehicle/VehicleVisual.js` [A7] or the grid placement in `vehicle/Vehicle.js` `_placeOnGrid`.
Every car sits inverted on the grid, presenting its die-cast base plate to the camera. In
wide shots this reads as a row of pale rectangles on the track and is easily mistaken for
painted grid-box markings — that misreading cost real diagnosis time. Confirmed by isolating
one car against a hidden scene: `shots/car-closeup.png` shows the cream base plate up and
the wheels splayed outward.
Check the sign of the roll/pitch applied when the visual group is synced to the body
quaternion, and whether `_placeOnGrid` composes the spawn rotation in the same handedness as
`Track.spawnPoints`.

## D7 — Livery texture bakes near-black
`vehicle/VehicleVisual.js` [A7]. `makePaintMaterial` deliberately keeps the material colour
white and carries the livery in `tex.map` — that design is fine. But the baked 1024×512 canvas
is 22% #080808, 17% #000000, 17% #080810, with only ~19% of a dark orange. The livery record
itself is correct (`Hemi Orange` base #D85A1C, `Forest Green` #1D5A34), so the fault is in the
canvas paint pass, not the palette. Cars will read as black even once D6 is fixed.

## D8 — Race finishes instantly
`game/Race.js` [A12]. At `raceTime` 5.4 s with the field only 8% around the lap
(`t: 0.083`), every entry already reports `lap: 3, cp: 19, finished: true`, so the state
machine jumps to `finished` and the director drops into results framing. Suspect the
checkpoint wrap: with 20 checkpoints the "previous" index at the start line is 19, which
likely satisfies the crossing test on every tick and increments the lap counter each frame.

---

## Fixed during integration

- **`main.js` race start glue.** `ctx.race?.start?.(opts) ?? ctx.race?.begin?.()` fired *both*
  entry points, because `begin()` is an alias for `start()` and `start()` returns undefined.
  The second call re-entered the state machine. Now resolves one callable and invokes it once.
- **`vehicle/Vehicle.js` syntax error.** Line 339 had an unquoted object key containing a
  space (`group b: 'rally'`) in the chassis alias map. The whole module failed to parse, so
  no vehicle ever constructed and the game ran with an empty grid. Quoted the key.

---

## Verification notes (not defects)

- Browser module registry caches a **failed** dynamic import for the document's lifetime.
  Re-importing a module that 404'd at boot returns the cached rejection even after the file
  lands on disk. **Always hard-reload before verifying.** Cost me one false diagnosis.
- A metallic sphere in a scene with a dark environment map reads as near-black and looks
  "missing". Judge metals against a lit floor before calling them broken — this produced one
  false positive before the re-test with an oak floor disambiguated it.
