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

## D12 — There is no room. The table runs to the horizon — MAJOR — OPEN
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

## D16 — The trail ribbons paint a black wedge across the table — MAJOR — OPEN
`fx/Trails.js` [A9]. Isolated, not inferred. Hiding `fx:skidRibbon` and `fx:speedRibbon` and
re-capturing the identical paused moment removes the wedge; everything else in the frame is
unchanged. Compare `shots/wedge-shadows-off.png` with `shots/wedge-no-trails.png`.

The elimination order matters, because the two obvious explanations are both wrong:

- **Not geometry.** A raycast through the wedge hits `track:ground` (material `track:oak`) at
  132–134 units — the same mesh, material and distance as clean table 20° away. The road is
  present underneath. It is an overlay, not a hole, which also matches the round-2 measurement
  that the band has identical RGB over wood and over concrete.
- **Not a shadow.** With `shadowMap.enabled = false` the band is still there, hard-edged and
  black. Sampling the live framebuffer in that region returns RGB(153,85,22) — ordinary warm
  wood — which is the trap: the artifact is in the capture path's composite, so probing the
  live frame says "nothing wrong here" and sends you looking in the wrong place. That is the
  same shape of mistake as the motion-blur streaks.

`fx:skidRibbon` draws with `blending: 1` (NormalBlending) and `transparent: true`, and the
round-2 adjudication measured its tint at `0x1a1a1a`, unlit, at `uOpacity 0.92`. A near-black,
unlit, all-but-opaque normal-blended ribbon laid on the table is a black band by construction.
A rubber mark should darken what is under it, not replace it.

This was correctly diagnosed in round 2 and never fixed — the fx agent that owned it was one
of the four that did not run before the session limit. A narrower band survives hiding both
ribbons, so there is a second, smaller contributor still to find.

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
