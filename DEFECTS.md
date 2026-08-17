# Open defects

## D18 — Cars interpenetrate to about half a car width — MAJOR — FIXED
`physics/Collision.js` [A8]. Playtest note ("the collision system seems flawed"), then measured.

**In a real race:** over 45 s of racing with 8 cars, the minimum centre-to-centre distance
between any two cars was **1.91 u**. Two cars are 4.15 u wide and 9.5 u long, so side by side
they touch at 4.15 and nose to tail at 9.5. 1.91 is a deep overlap in any orientation.

**Isolated, which is the useful part.** Place two cars 1.13 u apart — a massive deliberate
overlap — and let the solver run:

| step | centre distance |
|---|---|
| 0 | 1.13 |
| 10 | 1.32 |
| 60 | 1.87 |
| 120 | 1.91 |
| 239 | **1.99** |

So the response is **not absent** — it pushes them apart, monotonically, and then *plateaus at
roughly half the correct separation* and stays there. A solver that was not running would leave
them at 1.13; one that was working would reach about 4.15. This is a scale error, not a missing
system, which is a much narrower thing to look for.

**The mechanism, measured.** Force two cars to overlap, step once, and read the manifold between
their two proxies:

```
proxy:    shape 'box', roundXZ false, half [2.075, 1.46, 4.75], isVehicle true   (all correct)
manifold: count 1,  normal (0.795, 0.024, 0.606)
```

**`count: 1`.** Two overlapping boxes are producing a ONE-POINT manifold where a face-to-face
overlap should produce up to four, from the clipped face polygon. A single point is enough to
push at, which is why the separation improves at all, but it cannot resolve a face overlap: the
pair rotates and slides around that one point instead of separating, and the position solver
settles into a shallow equilibrium. That is exactly the observed "pushes apart, then plateaus at
half".

The normal supports it. For two roughly axis-aligned cars overlapping along X it should be close
to ±X; `(0.795, 0.024, 0.606)` is diagonal, which is what you get when the separating-axis search
returns an edge or corner feature rather than a face.

So the fault is in **contact generation, not the solver and not the shapes** — look at `boxBox`,
the clipping in `prepareManifold`, and `MAX_CONTACTS`.

**Ruled out by measurement, so nobody repeats them:**
- Not the proxy size. Half extents are exactly half of 4.15 × 2.92 × 9.5.
- Not `roundXZ`. Vehicles are shape `'box'`, so `roundXZ` is false and the `roundCylinder` path
  never runs for a car. The `radius: 1` on the proxy is an unused default, not a shrink factor.
  (This was my first hypothesis and it was wrong.)
- Not a missing response. It pushes apart monotonically; it just stops early.

**The `_pairCount` mystery is closed, and it was a bigger bug than D18.** `_makeTerrain` built a
heightfield proxy and `_syncTrack` stored it on `this._terrain`, but it was never given a slot in
`proxies` and never pushed to `_oversized` — the only route into the broadphase for a body with
no finite footprint, and a list filled exclusively by `addBody()`, which the terrain never calls.
So `_oversized` was empty for the entire run and `_terrainContacts` never executed once. A car on
its roof had nothing to rest on, and a prop knocked loose fell through the table for ever
(measured: y = −233 after two seconds). With no terrain in the broadphase the only pairs left
were the rare wall or car-car touch — hence a peak of 1.

Two fields it depends on were declared as `PhysicsWorld.prototype.x = null` under a comment
claiming they were guaranteed defined; `_terrainNormalSum.set()` on null throws, so the first
terrain contact would have taken the tick with it. Both are real instances now.

Verified in the running game: `_pairCount` peak 1 → **13**, `_oversized` length **1**, and a car
dropped from y = 40 rests at **y = 2.45** instead of falling through.

Do not "fix" this by inflating the half extents — they are correct, and a car whose collision box
is bigger than its geometry will bounce off things it visibly did not touch.

**FIXED, and the root cause is one line of missing arithmetic.** `boxBox`'s SAT compared the
nine edge-cross axes against the six face axes **without normalising them**. `|A_i × B_j|` is the
sine of the angle between those axes, so an edge pair's raw `proj - (ra + rb)` is the true
separation *scaled by that sine*, while the face separations are measured on unit axes. Two
different units, compared directly.

For two roughly-aligned cars that sine is ~0, so an edge pair reports a penetration crushed to
almost nothing and wins the shallowest-axis search outright. The existing `FACE_BIAS_REL/ABS` is
a few percent and cannot rescue a three-orders-of-magnitude scaling error. Dumped for the D18
configuration:

```
faceA 0  -3.03018            <- the correct answer, X
edge 2 2  raw -0.00000  sin 0.00000  (degenerate)   <- WINS
```

Two consequences, both matching what was measured in the field: a one-point manifold with a
diagonal near-horizontal normal (the winning axis is a cross product of two nearly-parallel
axes, so its direction is numerical noise in XZ — hence `(0.795, 0.024, 0.606)`), and a reported
separation of ~0, which makes `solvePosition` see `err < 0` and do nothing at all. The only push
left was the velocity constraint on closing speed, which is exactly "improves while approaching,
then plateaus".

**Worse than originally logged:** at *perfectly* equal yaw the degenerate axis makes `edgeContact`
bail and `boxBox` return **false — no contact at all**. Two cars at identical heading passed
through each other, as did a car hitting a wall square-on.

Fix: divide edge separations by the axis length before any comparison, and skip edge pairs below
`EDGE_PARALLEL_SQ` (parallel edges have no usable cross axis and are fully covered by the face
tests). Plus a car-car vertical guard, without which the fix alone still fails: once two cars are
within 1.23 u the genuinely shallowest axis is *vertical*, and an honest MTD solver stands one
car on the other's roof — which sticks here because an upright car is held up by suspension rays,
not contacts, so the suspension shoves it back down and the horizontal overlap never resolves.
The guard penalises near-vertical axes for ranking only, applies only to car-car, and lifts the
moment one car really is above the other.

Verified against an independent normalised-axis reference SAT over 14 407 overlapping pairs:
one-point manifolds 97% -> 1.9%, mean normal error 62.9° -> 2.1°. 40 000-pair fuzz: zero false
positives or negatives before and after, so the separation test's correctness is preserved.

Confirmed in the running game: two cars at 1.13 u now separate through 4.28 by step 10 instead
of plateauing at 1.99; the manifold is `count: 4` with a face-aligned normal; and the minimum
centre-to-centre distance over a 45 s race is **4.22 u, up from 1.91**.


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

## D17 — The table floats: a 3.6 u top 250 u above the floor, with no legs — MAJOR — FIXED
`world/TrackBuilder.js` [A5] + `render/Sky.js` [A4]. An integration seam between two agents in
the same wave, each of whom picked a defensible number in isolation.

| part | top | bottom |
|---|---|---|
| `track:ground` | 0.2 | −0.2 |
| `track:tableEdge` | 0.2 | **−3.6** |
| `MG.Room.floor` | — | **−250** |

The table-edge agent used a literal tabletop thickness: 3.6 u = 3.6 cm, correct at 1 u = 1 cm.
The room agent used the project's exaggerated scale — the playfield is ~460 × 340 u with 9 u
cars, i.e. a table already about 3.3× a real one relative to the toys on it — so it put the
floor at 250 u, a 75 cm table height in that same stretched space. Both are right on their own.
Together they give a 1:70 thickness-to-height ratio where a real table is about 1:25, and 246 u
of empty air where the legs should be.

It predicted this itself and said so: "table height is a guess the other agent must match".
The mechanism to reconcile them already exists — Sky honours `track.def.tableHeight` if it is
present, and `sky.setRoom({ floorDrop: N })` overrides at runtime.

**Not currently visible.** Every camera the game uses looks downward: chase is 26 u above the
table, macro 9 u, and the establishing shot at ~350 u pitched 50° has its frame top 31° BELOW
horizontal, so there are no upward sightlines in it at all. Confirmed in `shots/*-r7.png`.
Any low or side camera would expose it immediately.

**Fixed.** One scale wins, and it has to be the stretched one, because the room and the
playfield are both already in it. The board went 3.4 -> 10.0 u against the 250 u drop, which is
1:25 — the proportion of a table you would recognise. `TABLE_PROFILE` had to become FRACTIONS
of board thickness at the same time: it was authored in absolute units against a 3.4 u board,
so thickening alone left the bullnose rolling over in the first third and then dropping
straight, deforming the moulding instead of scaling it.

Four tapered legs now run from under the apron to the floor. `TrackBuilder._tableFloorDrop()`
resolves the drop the same way Sky does, from the same source in the same order
(`track.def.tableHeight`, else the shared default), so the two cannot disagree without a
definition saying so explicitly.

Verified from a camera deliberately placed BELOW the tabletop looking along it, which is the
angle no shipped camera uses and the only one that could ever have caught this. The first pass
also got the legs wrong in exactly the same way as the original defect — 7.4 u against a 250 u
drop is 1:34, and the frame showed four wires holding up a plank. Sized against the drop rather
than picked in absolute units, they are now 20 u, about a twelfth of the height.

## D12 — There is no room. The table runs to the horizon — FIXED
`render/Sky.js` [A4] + `world/Track.js` [A5]. `shots/diag-table-edge.png` looks across the
table at a low angle and there is nothing there: no kitchen, no walls, no floor, no table
edge, no table thickness. The wood plain runs to a flat horizon and everything past
mid-distance washes out to the fog colour (#d9d0bd), which is close enough to the wood that
the horizon barely resolves.

`MG.Backdrop`'s uniforms clearly intend a room — `uCeiling`, `uWindowColor`, `uClutterColor`,
`uGround` — but none of it survives the fog at any angle a camera actually uses.

This matters more than its severity suggests. The whole premise is toys on a kitchen table,
and that reading depends on seeing the table as an object in a room. Without the room it is
just an infinite wooden plain, which is a direct hit on the miniature illusion the tilt-shift
is working to sell.

It is also where the dark navy bands in `shots/diag-live-blur.png` and the first
`shots/ui-hud-racing.png` came from: they are the backdrop's ground/clutter colours (#38322b,
#2b2b31) showing wherever a sightline passes below the horizon, i.e. off the edge of the
table. I first read them as pure-black shadows, then as missing road geometry. They are
neither — a raycast finds the road present, and they survive with `shadowMap.enabled = false`.

## D13 — Fog is heavy enough to erase the backdrop — MAJOR — OPEN
`render/Sky.js` [A4]. Follows from D12 and may share a fix. At the distances the establishing
and low-angle cameras use, fog has already taken everything to near-flat. Whatever is built
behind the table will not be visible until this is retuned.

## D14 — A single cut warning removes a car from the race permanently — CRITICAL — FIXED
`game/Race.js` [A12]. `_advanceEntry`'s third branch — "more than one gate away: the car is
somewhere it did not drive to" — deliberately refuses to move `e.cp`. That makes it a one-way
trap. Once `e.cp` is frozen at gate *k* and the car drives past gate *k+1*, `delta` can never
be 1 again, so `e.gates` never increments again for the whole race. `e.score` is
`e.gates * gateLength + capped`, so the ordering scalar freezes too, while `e.t` keeps
reporting real progress.

Measured on `?track=kitchen&skipmenu=1&t=16&quality=ultra&autopilot=1&seed=20260730`:

| car | road position | gates | cp | score | cut | eliminated |
|---|---|---|---|---|---|---|
| car2 | 0.558 | 11 | 9 | 1080.3 | | |
| car1 | 0.600 | 11 | 10 | 1066.4 | | |
| **car0** | **0.735** | **4** | **3** | **556.2** | **✓** | **✓** |

car0 is **second on the road** and dead last by score, on one cut warning. The elimination
rule then takes it out — correctly, given the numbers it is shown — and because car0 is the
player, `_checkRaceOver` reads `player.eliminated` as "player done", enters FINISHED, DNFs
the field and closes the books. Seven cars still circulating, none past lap 1.

This one bug accounts for the whole family of "the race ends instantly" symptoms, including
the original D8, and for standings that disagree with what the frame shows. It is also why
every review frame so far was shot from a race that had already stopped.

The design intent in ARCHITECTURE.md — cutting is impossible, you must go back for the gate —
is worth keeping. Freezing the ordering scalar forever is not part of it.

**Fixed** at both sites. `_advanceEntry` now re-syncs `e.cp` to the current gate and credits
nothing for the skipped span, so the cut costs exactly what it skipped, permanently, and the
lap cannot set a personal best — but the score resumes advancing immediately. `_onRespawn`
carried the same one-way `else` and was the likelier trigger of the two: a car that went off
and respawned was silently removed from the classification for the rest of the race.

Two further things fell out of verifying it:

- **`compareEntries` ranked eliminated cars first.** Elimination assigns a `finishOrder` just
  as finishing does, and the sort tested only that field, so `if (a.finishOrder) return -1`
  promoted an eliminated car above every car still circulating. A car with two gates and one
  lap-zero cut held P1 — and since `this.leader` is `standings[0]`, every elimination gap was
  then measured against it. Now tiered: finishers, then runners by score, then eliminated.
- **Elimination is still judged on the cut-penalised score**, so one moderate cut can still
  put a mid-pack car out. Left alone deliberately. The obvious fix — judge on road position,
  since elimination is a spatial rule — is wrong as written: cars grid *behind* the line, so
  before their first crossing `t` is ~0.98 with `lap` still 0 and they read as nearly a lap
  *ahead* of anyone who has crossed. Measured: it inverts leader and last on the opening lap
  and eliminates half the field inside 30 s. Doing it properly needs a monotone
  distance-travelled signal rather than a wrapped parameter.

Verified with a full race, seed 20260730: car7 wins on lap 3 at 83.62 s, the player finishes
P2 at 88.98 s, fastest lap 25.09 by car1, and the five eliminated cars rank 4–8 in the order
they went out. Before the fix this race was over at 9.7 s with every car on lap 0.

## D16 — A dark navy wedge over a third of the frame — MAJOR — FIXED
`render/PostFX.js` [A2]. **The first two attributions in this entry were both wrong.** The
history is kept because the wrong turns are the useful part.

**What it actually is.** `GTAOPass` builds its own depth and normal buffers by re-rendering the
scene through `scene.overrideMaterial`. An override *replaces* the material, so a mesh's own
`depthWrite: false` and `transparent: true` do not travel with it: every additive ribbon is
written into that G-buffer as if it were opaque geometry. `fx:speedRibbon` is a wide sheet
flying just above the road, so AO reads it as an enormous near occluder and shades everything
behind it down to ambient. Fixed by hiding materials that declared `transparent && !depthWrite`
for the duration of the AO pass only.

**Wrong attribution 1 — `fx:skidRibbon`.** The original isolation hid `fx:skidRibbon` *and*
`fx:speedRibbon` together, and the wedge went away. I pinned it on skid because the round-2
adjudication had already described a near-black normal-blended ribbon and the story fit. A fix
agent then spent its whole slot rewriting that shader. Its work is a genuine improvement to the
skid marks and is kept — but it changed the wedge not at all, which is what exposed the error.
Two variables, one observation, and the wrong one got the blame.

**Wrong attribution 2 — the capture pipeline.** Probing the live framebuffer where the wedge
was returned ordinary warm wood, at both the live size and 1920×1080, which looked like proof
that the artifact was introduced by `toDataURL`. It was not: the capture set disables the
director and repositions the camera for shots 2–4, and the sim keeps advancing between tool
calls, so *every one of those probes was a different camera looking at a different frame*.
Freezing the engine and doing framebuffer read, `toDataURL` decode and disk write inside a
single uninterrupted call showed all three agreeing to the byte. The capture path was always
faithful.

**What finally settled it,** after `visible = false` removed the wedge but
`material.colorWrite = false` did not — that gap is the whole tell, because it means something
draws the mesh *without using its material*:

| | 900,950 | 700,1000 | control 300,900 |
|---|---|---|---|
| baseline | 31,36,55 | 30,35,54 | 176,114,59 |
| `fx:speedRibbon` hidden | **148,91,73** | **143,81,63** | 177,116,62 |
| GTAO pass disabled | **142,79,57** | **152,98,84** | 179,119,69 |

Also ruled out by measurement, not by argument: alpha accumulation (forcing alpha to stop
accumulating changed nothing) and shadows (`castShadow` was already false on all three ribbons).

**Note for anyone touching additive FX here.** `Renderer.js:180` sets
`premultipliedAlpha: true`, and r180's premultiplied branch uses `gl.blendFunc(ONE, ONE)` for
AdditiveBlending. `SPEED_FRAG`'s comment claims "additive blending is (SrcAlpha, One), so the
alpha channel already scales the contribution" — that is false for this renderer. It is not
what caused D16, but it is a live trap.

## D15 — The sim does not run while the browser pane is hidden — HARNESS — DOCUMENTED
`core/Engine.js` pauses itself on `visibilitychange` when `document.hidden`, which is correct
for a game and a trap for automated review: an agent-driven pane is hidden most of the time,
so every progress sample reads frozen and the simulation looks broken. Two boots of the same
seeded URL appeared to diverge for this reason alone — the pane had been hidden for different
amounts of wall-clock, not the game behaving differently. `captureSet()` now tests
`document.hidden` and `engine.paused` before it concludes anything about the field.

## D9 — Screen-filling black wedge and radial streaks in every frame — CRITICAL — FIXED

`fx/Trails.js` [A9]. Every round-2 capture carried two headline artifacts: a pure-black
hard-edged polygon covering a large part of the frame, and cream-coloured streaks radiating
across the whole image. They were one bug.

`RIBBON_VERT` retired a dead segment by teleporting its vertex outside the clip volume:

```glsl
if (aLife.y <= 0.0 || f <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); ... }
```

That idiom is only valid when the condition is **uniform across the primitive** — which is
how `fx/Particles.js` uses it correctly, since all four vertices of a particle quad share one
`aTime`. On a ribbon it is not. `Ribbon.push()` writes `strength0` to the trailing edge and
`strength1` to the leading edge, so `aLife.y` differs *within* a quad, and every trail starts
with `strength0 = 0`. The result is a triangle with two dead and two live vertices. The
clipper does not discard such a triangle — it clips it, stretching a polygon from the live
geometry out toward the off-screen corner, across a huge span of screen. The streaks were the
same polygons at other orientations.

`f` derives from `aLife.x`, which `push()` writes identically to all four vertices, so that
half of the test *is* uniform and still collapses the quad safely. Fix: drop `aLife.y` from
the branch and let `vFade` plus the existing `if (a < 0.004) discard;` retire weak vertices.
The boundary quad then tapers from zero, which is what it should have looked like anyway.

Two notes worth keeping:

- **Why black, not bright?** The material is additive, which cannot darken, and that sent me
  looking in the wrong place. The geometric cause above is confirmed by isolation (hiding
  `fx:speedRibbon` alone removes the wedge; the fix removes it at source). The most likely
  compositing mechanism is that the stretched polygons dumped alpha into the target while
  contributing almost no RGB, and premultiplied-alpha compositing then reads high alpha with
  low RGB as opaque black — but that part is inference, not something I measured.
- **Diagnosis route.** A raycast through the black pixels named `fx:speedRibbon` as the first
  hit. Isolating each of the three ribbons in turn was what actually settled it. Guessing from
  material state was misleading: `blending: 2` (additive), `depthWrite: false` and clean,
  NaN-free geometry all say "this mesh cannot possibly do that".

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
- **`MG.capture()` now pauses the engine for you** and resumes it afterwards, so two captures
  in a row are the same moment and an A/B between them is meaningful. Before that it did not,
  and I burned several isolation passes comparing two different shots without noticing. It
  also cured the radial streaks: a capture that repositioned the camera while the loop ran came
  back smeared, while the identical camera captured paused was clean — verified both ways with
  motion blur on and off. I reached that through three wrong explanations (a scene effect, then
  excessive blur strength, then the aspect change during the capture resize) before measuring
  it. If you ever need the old behaviour, note that `ctx.director.enabled = false` is still
  yours to set.
- **Backticks cannot appear in a `/* glsl */` comment.** They terminate the template literal
  and the module fails to parse. This has now bitten three times (c483289, and again in the
  commit that introduced the D9 fix). If a shader module suddenly reports a `SyntaxError` on
  an identifier that looks like ordinary prose, this is why.
- **The motion blur streaks in a captured frame are usually not what a player sees.**
  `MG.capture()` calls `renderFrame()` outside the normal update cadence, so `_prevVP` can be
  stale by an arbitrary amount and the reprojection smears. A live gameplay frame at the same
  speed is clean (`shots/diag-live-blur.png`, camera travel 0.9–3.6 u/frame). Judge motion
  blur from a live frame, never from a capture that has just moved the camera.
- **`cloneNode()` does not copy a canvas bitmap**, and a `<canvas>` inside an SVG
  `foreignObject` rasterises blank regardless. The HUD minimap looked broken in the first UI
  captures and was drawing perfectly. `tools/capture-ui.js` swaps each canvas for an `<img>`
  of its `toDataURL()`. Cloned nodes also restart their CSS animations from keyframe zero,
  which is why the results table rendered with a header and no rows.
