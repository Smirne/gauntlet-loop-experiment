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

## D19 — A ramp's lip injects energy into whatever is standing on it — MAJOR — OPEN
### Closed false lead: correcting the lip normal makes it worse
`world/Track.js` `surfaceNormal` central-differences `hazardHeight` over a 2.8 u window, so
across the lip's step it reports the cliff as the surface and returns a normal lying 71 deg
forward of vertical — sampled directly: 13.1 deg along the whole ramp face, then 70.7 and
71.5 deg in the two samples straddling the lip, then 0 deg. That band is exactly the sample
window and every car crosses it. `Track.normalAt`'s own comment says the suspension uses this
normal, so a forward-pointing normal reads as an obvious horizontal cannon.

Replacing the central difference with two one-sided slopes, shallower wins, removes the band
cleanly (verified: 13.1 deg up to the lip, 0 deg after, worst tilt anywhere on the lap 32.2
deg at the toe, which is real geometry). It also makes the game much worse:

  seed        lip injections        flips
  20260730       2 ->  0           10 -> 5
  771            0 ->  5            5 -> 14
  4413           0 -> 12            7 -> 17
  total          2 -> 17

Reverted in "Revert the lip normal fix". The mechanism is not understood. The suspicion is
`_suspension`'s guard `if (denom > -0.12)` — denom is the strut direction dotted with this
normal, so changing the normal changes which samples take the tangent-plane path instead of
the plumb-drop fallback, and the shallow normal apparently admits contacts the steep one
rejected. Whatever the cause, the 2.8 u band is a real artefact and fixing it in isolation is
not the fix. Do not rediscover it and patch it the same way.

`vehicle/Vehicle.js` `_suspension`, against `world/Track.js`. The 71 deg normal band (fixed,
see commit "The lip's normal pointed 71 degrees forward") was one cause of this and not the
only one. What remains, measured on seed 771 with the normal fix live: five one-step speed
gains of 12-15 u/s within 1 u of the lip, each on a car whose centre is at y 6.0-6.8 while
the ramp surface there is 8.4 — the car is roughly 2 u inside the ramp.

The suspension finds ground by intersecting the strut with the tangent plane through a
sampled point, iterated twice. That model assumes the surface is locally a plane. At the lip
the surface is a cliff: `heightAt` drops from 8.96 to 0.50 between two samples 0.5 u apart.
A strut whose sample lands on the far side of the step intersects a plane 8.5 u below where
the wheel actually is, and `clamp(d, -2, maxRay + 4)` admits the result.

Traced, one car over the lip at 26 u/s (u = signed units from the lip, clr = y - heightAt):

      u      y    surf    clr   air  up.y  spd
    -0.4   8.68   8.96  -0.28    0   0.97   26
    +0.1   8.52   0.50   8.02    0   0.96   28
    +1.3   8.27   0.50   7.77    0   0.78   31
    +2.6   8.44   0.50   7.94    0   0.71   42
    +6.1   8.82   0.50   8.33    1   0.22   41
    +8.1   8.48   0.50   7.72    1  -0.05   43

The car is legitimately still grounded through most of that window — its rear wheels are on
the last of the ramp while its nose is over the void, which is what a lip is for — so
`isAirborne` is not the bug. The bug is that the front struts, sampling past the step, are
still returning contact against a plane 8 u down and feeding tyre forces from it. Note the
speed: 26 to 42 while nothing but the rear axle is on anything.

Ruled out: penetration recovery in the solver (the injection is horizontal with y unchanged,
and `velocityBias` uses a split impulse); car-car contact (two of the original ten flips had
the nearest car 42 and 52 u away).

Not yet attempted. The candidate fix is to reject a suspension sample whose ground height
differs from the previous iteration's by more than the strut can span, rather than clamping
the intersection distance and trusting it.

## D20 — The renderer casts no shadows at all — CRITICAL — FIXED (root cause: the capture path, not the renderer)
`render/Lighting.js`, the CSM chunk patch. Every critic round to date has been scored on
shadowless frames, which is most of the lighting score.

The test that settles it needs no flags and no shader recompiles: put a 300x300 slab 60 u
above the field and toggle only its `castShadow`.

    slab added to the scene vs not      13.13% of pixels change   (it is plainly visible)
    slab casting vs slab not casting     0.00% of pixels change   (it casts nothing)

Repeated at subject view depths of 61, 121, 303, 607, 708, 809 and 910 u: 0.00% at every
one. A clean-room scene built from scratch in the same renderer - new DirectionalLight with
castShadow, new ground plane with receiveShadow, new box - also gives 0.00%.

Configuration is all correct, which is why this survived so long: `shadowMap.enabled` true,
type PCFSoftShadowMap, three cascades all agreeing at elevation 24 deg / azimuth -52 deg,
2048x2048 maps allocated with `hasMap` true, 160 casters and 286 receivers in the scene. The
sun is also doing most of the lighting - zeroing the cascades changes 55.89% of pixels - so
there is plenty of direct light for shadows to attenuate.

Ruled out, each by measurement:
  - `shadow.autoUpdate` / `needsUpdate` being false. Forcing both on, renderer included,
    leaves the slab test at 0.00%.
  - Cascade frustum placement. The frusta are indeed aimed at nothing useful (targets at
    [410,284,552], [-107,-33,-70], [-322,-129,-336] while the cars sit at [9,1,31]) but
    re-aiming all three at the car field, with spans of 60/160/420, still gives 0.00%.
  - `Materials.js` tampering with shader chunks. `lights_fragment_begin`,
    `shadowmap_pars_fragment` and `shadowmask_pars_fragment` are pristine - no `mg_`
    substitution, `getShadowMask` intact.
  - The CSM patch's baked far fade. The installed chunk ends the key light with
    `mix( 1.0, getShadow(...), 1.0 - smoothstep( 684.0, 760.0, -geometryPosition.z ) )`,
    which does mean shadows are fully faded out past 760 u and the establishing camera sits
    at 819 u. That is a real second bug. It is not this one: the slab test is 0.00% at 61 u
    too.
  - Post-processing. Shadows are absent in a direct `renderer.render()` that never touches
    the composer.

Note for whoever picks this up: `renderer.info.programs` in this three build does not expose
`fragmentShader` as a string, so a probe that greps program sources for `USE_SHADOWMAP`
reports 0 for every program and means nothing. Do not read that as evidence.

### Root cause
Measured after stepping the engine so `Lighting` re-fits the cascades to the real camera,
which is the state the game actually ships:

    subject view depth                                     825 u
    shader fades all shadows out over                  684 - 760 u
    Cascade0  fit to view slice 0-112,   772 u from subject, map empty (0 of 16384 texels)
    Cascade1  fit to view slice 98-213,  660 u from subject, map empty
    Cascade2  covers the subject (297 u away, radius 380),   map empty

The split distances are sized for a camera sitting 100-200 u from the action. Every camera
the game uses sits 790-900 u out. Two consequences, either of which alone is fatal:

  1. The far fade. Cascade 2's shadow term is
     `mix( 1.0, getShadow(...), 1.0 - smoothstep( 684.0, 760.0, -geometryPosition.z ) )`.
     At 825 u the smoothstep is 1, so the whole expression is 1.0. No shadow is possible at
     any camera distance the game uses, regardless of what is in the maps.
  2. The near cascades are fitted onto nothing. `_fitToCamera` centres each cascade on its
     own view-frustum slice, so cascades 0 and 1 land 660-772 u away from the track, in open
     air. Their maps come back empty, which is correct behaviour for a fit that is pointed
     at nothing.

Still unexplained: cascade 2 geometrically contains the subject and its map is empty too.
That is a third thing to chase, but it is not needed to explain the black-and-white result -
(1) forces the shadow term to 1.0 on its own.

The fix is to derive the splits from the actual camera distance rather than from constants
tuned for a close chase camera, and to re-derive the shader's baked fade window from the same
source. Note the fade boundaries are baked into the shader as literals at install time and
the patch is one-shot per session, so changing splits at runtime will not move them.

### Far plane: fixed, and it was not enough
`shadowFar` 760 -> 1300, committed. The fade window verifiably moved 684-760 -> 1170-1300
and cascade 2's fit radius grew 380 -> 714, which now contains the playfield that spans
541-1111 u. Shadows did not come back: the slab test still reads 0.00% and all three cascade
maps still read back empty after a normal frame. So the far plane was a real second bug
sitting on top of this one, and removing it changes nothing visible on its own.

### Correction: the maps are NOT empty. That was my instrument.
Every "map comes back empty" reading in this entry was taken with
`readRenderTargetPixels( map, 0, 0, 128, 128, ... )` - a 128x128 corner of a 2048x2048
texture, 0.4% of it, in the corner where a fitted shadow map is least likely to project
anything. Re-sampled at four blocks across the map:

    cascade    corner(0,0)   centre    quarter   three-quarter
    Cascade0     18.2%         0%       17.3%        0%          min depth 145
    Cascade1      0%           0.7%      0%          0.9%        min depth 70
    Cascade2      0%           0%        0%          0%

Cascade 0 carries substantial real depth data. The shadow maps are being rendered. Do not
repeat the corner read; sample the centre, or downsample the whole target.

### What is left
With maps populated, shader shadow code compiled, `shadowIntensity` 0.98, the fade window now
1170-1300 and the subject at 114 u of view depth (well inside it), the slab test still
measures 0.00%. Casters are in frustum - 98, 127 and 160 for the three cascades. So the
remaining fault is between a populated map and the sampled result: candidate suspects are the
shadow matrix / `vDirectionalShadowCoord` not matching the fitted camera, `receiveShadow`
being false on the surface the test shadow should land on, or the per-cascade depth windows
selecting a cascade whose map covers a different region than the one being shaded.
Cascade 2's map read nothing at four sample blocks, but that is 1.7% of its area and after
the corner-read lesson it should not be called empty without a fuller sample.

The old claim was that maps come back empty (0 of 16384 sampled texels carry geometry)
after `stepOnce()` + `renderFrame()`, even with `needsUpdate` forced on all three
immediately before the render, and even with cascade 2's frustum now demonstrably containing
the track. Before stepping the engine, cascade 0's map did contain geometry (27990 texels,
min depth 76), so the maps are writable and the read-back method works - something about the
normal per-frame path leaves them empty. `Lighting._intervals` throttles cascade updates on a
per-tier schedule ([1,2,3,4] at ultra), which is the first thing to examine: a cascade that
is skipped should retain its previous contents rather than clear, so if it is clearing, the
throttle and the map lifetime disagree.

### Correction to the exclusions above
The line ruling out cascade frustum placement was first measured with an invalid method -
toggling `shadowMap.enabled` without forcing material recompiles, which cannot show a
difference. Re-run properly with the slab `castShadow` toggle it still reads 0.00%, so the
exclusion stands, but the first evidence for it was worthless. Separately, every close-range
slab test in this entry is invalid for a different reason: `_fitToCamera` fits cascades to
`ctx.camera`, and those tests rendered with a throwaway camera while the cascades stayed
fitted to the real one. The subject was never inside the frusta being tested. The numbers
above, taken after `stepOnce()` on the real camera, are the ones to trust.

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


### WRONG — I closed this and four blind judges reopened it. See the retraction at the end.
Measured on the running game with a method that needs no recompile and no new
geometry: `light.shadow.intensity` is a plain uniform, so setting it to 0 on all three
cascades turns cast shadows off without changing a single shader permutation.

    shadow.intensity 0.98 vs 0.00     5.004% of pixels change
    control, 0.98 vs 0.98 again       0.013% of pixels change
    largest single-channel delta      260

Five percent of a 2560x1440 frame is a lot of shadow. Visually confirmed too: the room
props throw long directional shadows across the table.

So `shadowFar` 760 -> 1300 was not "necessary but not sufficient" — it was sufficient, and
every reading that said otherwise came from the slab test, which was measuring the wrong
thing. Three lessons worth more than the fix:

  - **The slab test was never valid.** It adds a 300x300 slab and toggles its `castShadow`.
    But `_fitToCamera` centres each cascade on its own view-frustum slice, so whether the
    slab lands inside any cascade depends on the live camera, and the slab's shadow has to
    fall on a surface that is both in frame and in the same cascade. It reported 0.00% while
    the renderer was casting shadows over 5% of the frame. Do not use it again.
  - **The clean-room test was actively misleading.** A scene built from scratch with one
    directional light still gets the global CSM chunk, which multiplies cascade 0's
    contribution by `1.0 - smoothstep(98.3, 112.0, viewDepth)`. Any subject past ~112 u of
    view depth therefore receives *no direct light at all* from the only light in the scene,
    so of course toggling its shadow changes nothing. The patch is global; a "clean room"
    inside this session is not clean.
  - **Sample the thing the shader samples.** Projecting a known world point through
    `light.shadow.matrix` and reading that exact texel is the measurement that settles it.
    At the car: cascade 0 coord y = -3.60 and cascade 1 coord y = -1.39, both outside
    [0,1] — correct, the car is at 718 u of view depth and those cascades cover 2-105 and
    105-200. Cascade 2 coord (0.409, 0.678, 0.5755) is inside, and the map at that texel
    reads 0.57673 — real depth, 2.5 u behind the sample point. The cascade selection, the
    fit and the map contents all agree.


### Retraction of the "RESOLVED" section above
The 5.004% figure is real but it does not mean what I said it meant. It was measured on the
**menu** camera, where the subject sits at 718 u of view depth and cascade 2 — the one with a
900 u radius covering the whole room — is the active cascade. Long-range shadows do work.
The game is not played there.

Measured again on the race, the same way:

    mean luma darkening from shadows      0.7 of 255
    fraction of frame darkened at all     2.2%
    fraction of pixels moving < 10 luma   98.2%

That is not a lit scene with shadows in it. Blind A/B, r18 vs r20, four judges, one per
camera, labels mixed so always-answer-A scores 2/4:

| Pair | Angle | Label A | Label B | Winner | Confidence |
|---|---|---|---|---|---|
| 1 | gameplay | r20 | r18 | **B — r18** | high |
| 2 | chase | r18 | r20 | **A — r18** | high |
| 3 | macro | r18 | r20 | **A — r18** | high |
| 4 | establishing | r20 | r18 | **B — r18** | high |

**r18 won 4 of 4 at high confidence.** Unprompted, all four judges reported the same pair of
things, in both directions:

  - r18 has cast shadows and they are obvious — "a large dark soft shadow offset down-left
    from the car", "the table legs on the floor", "consistent direction, upper-right key".
  - r20 has none — "the wheels meet the surface with no darkening at all", "the car looks
    pasted onto the sheet".
  - r20 has the veil — "a broad, hazy diagonal band ... it ignores geometry and passes over
    the table and background at the same strength".
  - r18 does not.

So the shape of this defect is different from what the entry above assumed. Shadows are not
absent by construction; they **regressed between r18 and r19**, and the same regression
brought the veil. Those are very likely one change, not two, which is the first thing the
next session should test. `shadowFar` 760 -> 1300 did not restore them; keep the change (the
fade window was genuinely wrong) but do not credit it with a fix.

**Next step, concretely: bisect the commits between the r18 and r19 captures.** That is a
bounded list and the symptom is loud in a single frame, so it is a much cheaper route than
any further reasoning about the CSM patch — and my track record on reasoning about the CSM
patch in this entry is three wrong conclusions out of three.

**Standing method note, earned the hard way.** Every wrong call in this entry has the same
shape: a single aggregate number over a whole frame, read as though it were a measurement of
the thing I cared about. 0.00% from the slab test, 0% from a corner texel read, 5.004% from
the wrong camera. A frame-wide percentage cannot tell you *where* or *what*. Before believing
one again, look at the frame.


### ROOT CAUSE, at last: the review frames were a lottery and the renderer was never broken
The premise of this whole entry — "the renderer casts no shadows" — was false. The **running
game** has cast shadows and has had them throughout. What did not have them, most of the time,
was the **capture path that produces the frames every critic round is scored on**.

Measured in the live race, as a 32x18 grid of mean luma darkening rather than as one
frame-wide percentage — which is what should have been done on day one:

    the darkening is not spread over the frame. It sits in a handful of tight blobs
    in the lower half, peaking at 59.2 luma. Those are cast shadows, and they are strong.

Then the discriminating experiment. Teleport the camera the way `Capture` does, render
without letting anything refit, and compare against the same shot with one forced refit:

    camera teleported, no refit      4.73% of frame darkened by shadows
    same camera, cascades refitted  33.65% of frame darkened by shadows

**The mechanism.** `Capture` calls `engine.syncSystems()` once after posing the camera —
that was the round-4 fix for exactly this class of bug, and it is still there and still
correct. But one `syncSystems()` is one call to `Lighting._fitToCamera()`, and that method
throttles each cascade on its own interval, `[1, 2, 3, 4]` at ultra:

    if (!first && this._frame % interval !== 0) continue;

So a single resync refits cascade 2 — the only one wide enough to cover the table on the
wide shots — only when the frame counter happens to be divisible by 3. Measured by stepping
`_frame` through six values and recording which cascades actually moved:

    _frame  0: c0 c1 c2      _frame  3: c0 c1 --
    _frame  1: c0 c1 --      _frame  4: c0 -- --
    _frame  2: c0 -- c2      _frame  5: c0 c1 c2

**Two of six.** Every review set since the throttle landed has been a coin flip on whether
the frames show the lighting the game actually has. r18 won the toss and was scored with
shadows; r19 and r20 lost it and were scored without. Four blind judges then called r18 the
better build 4/4 on precisely that difference — a real, reproducible verdict about two
frames, and a completely false one about two builds.

### The fix
The throttle rests on frame-to-frame coherence: a cascade up to four frames stale is still
fitted near enough to where the camera is. Measured over 179 race frames, that premise holds
by a wide margin — worst single-frame camera motion is **0.67 u and 0.08 degrees**. A capture,
a replay cut or a camera change teleports hundreds of units in one step and breaks it
outright.

So `_fitToCamera` now detects a cut — more than 12 u or 2 degrees from the pose the cascades
were last *fitted for*, ~18x above the worst continuous motion — and refits every cascade
when it sees one. Verified both directions:

    after a cut, at all six frame parities    c0 c1 c2   (was 2 of 6 for c2)
    during a normal race                      c0 only, mostly — throttle intact

The comparison is against the pose the last fit was made for, not the last frame's pose, so a
cut followed by throttled frames keeps reporting true until every cascade has caught up.

### Why this took so long, and the standing rule that comes out of it
Three wrong conclusions, all the same mistake: one aggregate number over a whole frame, read
as though it measured the thing I cared about. 0.00% from a slab test that never checked
whether the slab was inside a cascade. 0% from a corner read of a 2048 texture. 5.004% from
the menu camera, where the wide cascade covers everything and shadows genuinely do work.

A frame-wide percentage cannot tell you *where* or *what*, and every one of those numbers was
consistent with the truth — the renderer works, the capture of it did not. **Rule: before
believing an aggregate, render the difference and look at where it lives.** The 32x18 grid
that cracked this took four lines more than the percentage did.


## D21 — `renderFrame()` is not idempotent: ~72% of the frame changes on some renders — NOT A DEFECT (see resolution)
Found while trying to localise the streak veil by hiding objects and diffing frames. The
diff kept reporting that hiding a dust emitter changed 72% of the image, which is absurd, so
I measured the instrument instead of trusting it.

One `stepOnce()`, then nine `renderFrame()` calls in a row with **nothing changed between
them**, comparing consecutive pairs:

    render     2    3      4  5  6  7    8      9
    vs prev    0    72.54  0  0  0  0    72.55  0
    vs first   0    72.54  72.54 72.54 72.54 72.54  72.56  72.56

The scene is frozen. The camera is frozen. Nothing is toggled. Yet render 3 differs from
render 2 across 72.5% of the frame, holds that state through render 7, and shifts again at
render 8 — and it does not return to the first state, so there are at least three of them.
Rendering the same frame twice does not produce the same image.

**Three consequences, in order of how much damage they have already done:**

1. **Every toggle-and-diff probe run outside the first two renders after a step is
   worthless.** That includes the earlier conclusion that the streak veil "survives disabling
   all twelve post passes, so it is scene geometry, and survives hiding the light shafts and
   dust". That was measured with this instrument and has to be treated as unproven — it is
   the reason the veil was chased into the room shell, which may well be the wrong place.
   The shadow measurements in this file are not affected: those were taken as `stepOnce()`
   followed by two or three grabs, inside the stable window.

2. **It is a plausible mechanism for the veil itself.** A full-screen artifact that appears
   on some renders and not others would show up in a capture whenever the capture lands on
   one, which is exactly the "sometimes there, sometimes not" character the veil has had. The
   capture path renders twice and keeps the second — always render 2, so at least it is
   consistent — but that is luck, not design.

3. **A still camera in the running game is periodically changing 72% of its pixels.** Whatever
   that is, a player sitting still at a menu or on a grid should not be seeing it.

**Do not** investigate this by comparing frames far apart. The valid window is renders 1-2
after a `stepOnce()`; past that the comparison is measuring this bug rather than whatever was
toggled. The first thing to identify is which pass or buffer has a period of about five
renders — the shape of the sequence (change at 3, hold to 7, change at 8) says something is
being accumulated or ping-ponged on a schedule, not jittered per frame.


### D21 resolved: it is the film grain, and it is deliberate
The flip is perfectly periodic — every 5th render, ~71.8% of pixels, phase following a global
counter. Signed, it is zero-mean: 42.5% of pixels brighter, 42.4% darker, flat at every scale
on a 32x18 grid. That is noise re-seeding, not a structural change.

`GrainShader` quantises its hash to `floor( uTime * 24.0 )` — 24 steps a second, on purpose,
with the comment "grain that updates every frame at 60 fps reads as electronic noise, not
film." At the 120 Hz fixed step that is exactly one re-seed every 5 renders. Setting
`uAmount` to 0 makes consecutive renders byte-identical:

    grain on   . . # . . . . # . . . .      (# = >1% of pixels differ)
    grain off  . . . . . . . . . . . .

So the renderer is fine and the framing in the entry above was overblown. What survives is
the instrument rule, and it is worth keeping: **zero the grain before any frame-diff probe.**
At the default amount of 0.03 the grain crosses a per-channel threshold of 6 on ~72% of
pixels, which is enough to bury any real signal. Every toggle-and-diff measurement taken
without doing this — including "the veil survives disabling all twelve post passes, so it is
scene geometry" — was reading grain.

## D22 — A boosting car paints a bright ring around the whole frame, in any shot — MAJOR — FIXED
`fx/Impacts.js`. This is the streak veil that lost r19 and r20 the blind A/B, and it is the
same bug that was already found and fixed once for speed lines, with the second uniform
missed.

With the grain zeroed so the probe means something, hiding one object changes the frame more
than everything else in the scene combined:

    fx:impacts   59.71%        decals        6.62%
    ao pass       2.28%        MG.Room       0%
    fx:particles  1.09%        control       0%

`fx:impacts` holds a single child: `fx:overlay`, a full-screen additively-blended quad. Mapped
as brightness added, it is dark in the middle and blazing at the edges — **up to 134 of 255
luma added in a ring around the entire frame** while the centre stays clean:

    ##########*++-:::--++**#########
    ########*+-.......:.+++**#######
    ######*+-.............:-*#######
    #####**-................-*######
    ########-..............-+#######
    #########+#*#+**-+++-**#########

Its uniforms at that moment: `uFlash 0`, `uSpeed 0`, `uBoost 0.86`. The boost rim alone.

### Root cause, and why the earlier fix missed it
`Impacts.update()` already carries a long comment titled "SPEED LINES BELONG TO THE CAMERA,
NOT THE SUBJECT", written when a wide establishing shot of a motionless table was found
wearing a full-screen streak veil because a 40-pixel toy car in frame was going fast. The fix
scales the subject term by how far the camera itself moved:

    wantSpeed *= this._cameraMotionGate(dt);

`wantBoost` sits two lines above and never got the same treatment. So the exact bug that
paragraph describes was still live, just through the other uniform.

There was a second half. `_cameraMotionGate` does detect a cut — `if (dist > 40)` — but it
**held** the previous gate value instead of clearing it, so a new shot inherited whatever
self-motion the last one had earned. And it returned that stale value from an early
`!(dt > 0)` guard placed before the position was even read, which is precisely the path a
capture takes: `Capture` re-poses the camera and syncs with `dt = 0` deliberately, so nothing
integrates.

Third half, found by testing the fix rather than assuming it: clearing the gate is not enough,
because `this.boost` is damped as `+= (want - boost) * (1 - exp(-dt * 7))`, which at `dt = 0`
is a no-op. The damped terms have to be snapped on a cut, which is also what a cut means — the
new shot has no history to ease out of.

### Fixed
Gate both uniforms on one shared `viewerMotion` (calling the gate twice would double-advance
its damping), clear the gate on a cut instead of holding it, check for the cut before the
`dt > 0` guard, and snap the damped terms when one is seen. Verified:

    live chase camera, field boosting   boost 0.18, overlay visible   (correctly earned)
    after a capture-style cut           boost 0.00, overlay NOT drawn


## D23 — The road does not read as a road — MAJOR — OPEN (original numbers VOID; re-measured at the end)
Every blind judge in all three A/B rounds said some version of this, having agreed on little
else. "The track surface is nearly indistinguishable from the surrounding table." "The lane is
just bare plywood with a few thin white line strokes that break up and float." "A
ghost-translucent film over bare wood with only faint white lane lines, so the driving line is
guesswork."

**The obvious explanation is wrong.** Sampling the rendered frame at the road centre against
the table 30 u outside the kerb, over the whole lap and at camera elevations from 12 to 80
degrees:

    varnishedWood road   -39.3 luma vs the table beside it   (n = 321)
    pine worn patch      +41.5 luma                          (n = 16)
    crumbs                -3.4 luma
    and -40 +/- 1 at every elevation from 12 to 80 degrees — not view-dependent

Forty luma is a lot of contrast, in both directions, and it is stable across viewing angle. So
"the road is too similar in brightness to the table" is false and should not be chased.

**What the frame shows instead.** The wood grain, the colour and — decisively — the **plank
seams run continuously through the track and out into the surrounding table**. The road is
the same material as the table with a different exposure. The eye segments surfaces by
texture and by boundary, not by mean level, so a 40-luma step across a boundary that no
texture feature respects reads as a lighting change, not as a different surface. The only
things actually saying "road" in frame are the kerb tubes and the painted lane lines, which is
precisely the list the judges gave.

Local detail does not explain it either: mean local luma std-dev in 11x11 px windows is 3.67
on the varnish road and 3.27 on the pine, against 0.54-1.77 on the table. The road has *more*
texture than the table, not less.

### Why the obvious fix is not safe
`varnishedWood` is described as polished varnish and the physics treats it as polished
(grip 0.92 against oak's 1.00), but its material is `clearcoat: 0.10` — visually almost matte.
Raising it is the first thing anyone will reach for and it would undo deliberate tuning:
`Surfaces.js` carries a note that roughness was raised to a 0.29 floor / 0.33 mean
specifically because "three's split-sum DFG returns ~63% of the environment at grazing
incidence for roughness 0.16 and ~29% at 0.33", to stop the surface going hot to the horizon
under a long lens. A clearcoat lobe would reintroduce exactly what that tuning removed.

### What to try instead, and how to judge it
The lever is **texture identity and boundary**, not level:
  - break or wear the plank seams where the track crosses them, so the boundary is something
    the texture respects rather than something painted over it;
  - give the driving line its own history — rubber and grime toward the centre, dust and
    debris pushed to the edges — which is what makes a real racing line legible;
  - keep the "the track is the varnished part of the same table" concept, which is deliberate
    and documented at the top of `world/tracks/kitchen.js`.

Adjudicate it blind against the current build like any other change. Do not adjudicate it on a
luma delta — that number is already large and it is measuring the wrong thing, which is the
whole content of this entry.


## D24 — Three of the eight cars were blue, two of them the same blue — MAJOR — FIXED
`main.js` field build + `vehicle/CarModels.js`. Found while chasing a judge's report of
"duplicated ghost curves" and "offset copies of geometry" on the chase frame. The frame does
show what looks like the same car twice. It is not ghosting — they are two different cars.

Field assignment was `roster[i % 3]` for the chassis and `livery: i` for the paint, and
`liveryFor` wraps at five liveries per chassis. So indices 5, 6 and 7 fell onto livery slots
0, 1 and 2, and what came out was:

    car0 Hemi Orange  #d85a1c      car4 Azzurro      #2a7fd4
    car1 Bianco       #eceef1      car5 Works Blue   #1546a8
    car2 Forest Green #1d5a34      car6 Petrol Blue  #18468c
    car3 Candy Plum   #6a1d5c      car7 Verde Acido  #8fce1c

Three blues in a field of eight, and **Works Blue against Petrol Blue is an RGB distance of
28** — indistinguishable at the size a rival car occupies on screen. (Bianco's hue computes as
216 but it is white at about 2% saturation, so it is not part of that cluster; do not count it.)

The docstring above `ROSTER` claims the scheme "yields eight distinct (chassis, livery) pairs
across a default grid — no two cars on track are the same object", and that is true. It is
just not the property that matters. At forty pixels a rival is a colour and a silhouette, and
**nothing in the assignment ever looked at a colour** — the separation was luck, and it came
out badly.

### Fixed
`assignField(count, roster)` keeps the chassis cycle, because the silhouette separation it
gives is deliberate and documented, and picks each car's livery by farthest-point selection:
maximise the minimum colour distance to every car already on the grid. Deterministic, no
hand-kept table, and it degrades gracefully with grid size.

    worst pair, full grid of 8     28 -> 75
    worst pair, N = 6              106
    worst pair, N = 4              121

Verified in the running game — the field is now Hemi Orange, Bianco, Works Blue, Candy Plum,
Verde Acido, Forest Green, Bare Primer, Azzurro.

### Two measurements that were wrong on the way here, so nobody repeats them
- **Reading livery colour off the material.** Every `car:paint` material is `#ffffff`; the
  livery is baked into the map, so material colour tells you nothing.
- **Averaging the baked livery atlas.** That gave a mean saturation of 0.24 and "every car is
  nearly black", which is false — the atlas includes undersides, interiors and dark trim that
  are never visible on a body. Sampling rendered pixels for the same cars gave `#b0342c` at
  0.60 saturation where the atlas said `#794832`. A second rendered pass then disagreed with
  the first (`#2b1f2c` for the same car), so that instrument is unreliable too.
  **The source of truth is the `LIVERIES` table.** It is authored data; read it directly
  instead of trying to recover it from pixels.


## D25 — Every review set was shot at a different race moment — CRITICAL (method) — FIXED
The blind A/B rests on one premise: the only difference between two sets is the build. That
premise has been false for every round run so far.

The engine's fast-forward is deterministic — two loads of the identical URL put car 0 at
exactly `(-125.997, 1.757, 40.595)`, byte for byte, both times. What is not deterministic is
everything after it. The RAF loop keeps stepping the race from the moment the page is ready
until somebody calls `captureSet()`, so the shot lands wherever the operator's typing speed
put it. `assertMoving`'s own leader-advance number, from four runs of the same URL:

    r20  0.01895     r21  0.01945     r22  0.02316     r23  0.01895

Four different moments. **This is my procedure, not the engine**, and it is worse than noise
because it is invisible in the output: every set looks like a valid capture of the build.

**It has already produced a wrong verdict.** The r22 vs r23 A/B was run to adjudicate the D24
livery change and came back 3-1 against it. The judges' stated reasons were mostly not about
liveries: one counted four cars in one set and two in the other and scored the difference,
which is a fact about when the shutter fell. **That round is void.** The livery change stands
on its measured colour separation (worst pair 28 -> 75), which is a property of the roster and
not of any frame, and it needs re-judging under the fixed harness before anything is claimed
about how it looks.

It very likely explains a good deal of the disagreement between earlier rounds too — including
why the veil seemed to move between builds. The veil root cause (a boosting car) is measured
directly and does not depend on this, but "r18 was clean" was always partly luck about the
moment.

### Fixed
`captureSet` now pins the moment before it does anything else: pause the engine, then step to
a fixed race clock (`PIN_RACE_TIME = 20.0 s`), absorbing whatever drift the RAF introduced. If
the clock is already past the pin it refuses rather than shooting an incomparable set.
`assertMoving` then steps its usual 60, which is constant from a pinned state.

Verified the only way that counts — two fresh loads of the same build, with a deliberate 2.5 s
extra delay on the second so the RAF drift differed:

    leader advance          0.01392 both runs   (was varying run to run)
    pixels differing > 6    0.02%
    mean signed luma        0.000
    pixels beyond +/-1      0% brighter, 0% darker

The residue is grain on a handful of pixels, which is D21 and expected. Before the pin, two
runs differed by a whole race moment.


## D26 — `syncSystems()` hands the camera back to the director, and I measured through it — CRITICAL (method) — FIXED
Found while trying to measure the rendered colour of each track surface, when five of six
spans returned zero samples from points that provably project to the dead centre of the
screen.

    I set the camera to            (150.8, 120.5, -71.2)
    after engine.syncSystems()     (-189.7,  85.8,  43.3)     moved 360.9 u
    after engine.renderFrame()     unchanged                   moved 0.0 u

`syncSystems()` runs update/lateUpdate, and the camera director is one of those systems. It
owns `ctx.camera` and overwrites any pose set by hand. So the sequence I had been using —
**pose the camera, syncSystems, render, project my sample points** — renders from the
*director's* camera while projecting against the pose I thought I had set. `renderFrame()`
alone does not move it; only the sync does.

### What this voids
**Every number in D23.** The road-vs-table figures were taken exactly that way. Worse, the
part of that entry I found most convincing is now the tell rather than the evidence: I
reported −40 ± 1 luma at every camera elevation from 12 to 80 degrees and read the constancy
as proof the finding was robust to viewing angle. It was proof the camera never moved. A
measurement that refuses to change when you change its input is not stable, it is
disconnected.

Re-measured with `ctx.director.enabled = false` first — drift 0 at every span, and all six
surfaces return 600 samples instead of five of them returning none:

    varnishedWood  #604b48  luma  81        crumbs       #b98358  luma 142
    oak table      #9a603b  luma 109        ceramicTile  #cdaf96  luma 181
    pine           #c7996f  luma 162        paper        #e7d4c1  luma 216

The road-against-table difference is **−28 luma**, not −39. The direction of D23's conclusion
survives — the varnished road is darker than the oak — but the magnitude was wrong and the
elevation sweep must be redone before anything is claimed about viewing angle.

### What this does NOT void, checked case by case
- The cascade refit work (D20). Those probes called `Lighting._fitToCamera()` directly and
  rendered with `renderFrame()`, which does not move the camera. Verified above.
- The veil (D22). No camera reposing involved.
- The capture-moment pin (D25) and both livery A/B rounds. Those go through `captureSet`,
  which releases the director properly — that is what the "SETTLE FIRST, THEN AIM" comment in
  it is about.
- The livery colours. Read from the authored `LIVERIES` table, not from pixels.

### The rule
**The camera is not yours to set while the director owns it.** Disable the director first, or
hold the pose across frames. And when a measurement returns the same answer no matter how you
vary its input, that is a reason to distrust the instrument, not to trust the result.

## D27 — The livery assignment lever is nearly exhausted; the roster is the limit — MINOR — OPEN
With all six surfaces measured, an exhaustive search over every legal assignment (5P3 x 5P3 x
5P2 = 72,000) puts a ceiling on what re-shuffling can achieve:

    shipped (oak-aware, won its A/B 3-1)   worst car-car 65   worst car-surface 51   player 99
    greedy, all six surfaces               worst car-car 65   worst car-surface 58   player 99
    exhaustive optimum on min(both)        worst car-car 62   worst car-surface 61   player 70

**The greedy multi-surface version was not shipped.** It buys 7 units on the worst car, does
not move the player's car at all, and pays for it by dropping Bianco — which judges singled
out as reading well. Shipping a marginal change on nice reasoning is exactly what lost the
first livery round 1-3, and the rule from that round applies to this one.

The exhaustive optimum is not obviously better either: it raises the worst car from 51 to 61
by putting **Hemi Orange back on the player's car**, dropping the player from 99 to 70 — undoing
the one change three judges asked for by name.

The real constraint is the palette. Only five of the fifteen authored liveries clear 89 units
from every surface, and the three worst — Candy Plum (51, sinks into the varnished road),
Bianco (55, sinks into the newspaper) and Bare Primer (58, sinks into the varnished road) —
fail against a surface the track actually spends a chunk of a lap on. **To do better, author
liveries that clear all six surfaces rather than re-permuting the fifteen that exist.**


### D23 re-measured, with the director disabled
Every figure in the original entry was taken through the bug in D26 and is void. Redone with
`ctx.director.enabled = false` first, drift verified at 0.00 u, 720 road samples and 480 table
samples per point:

    camera elevation   road luma   table luma   delta
         12 deg           84.3       116.9      -32.6
         20 deg           73.0       114.9      -41.9
         35 deg           59.1       113.3      -54.3
         55 deg           55.8       113.4      -57.7
         80 deg           56.4       114.2      -57.8

    pine worn patch, 20 deg   160.0 vs 98.4   +61.6
    pine worn patch, 55 deg   155.9 vs 96.0   +59.9

**Three corrections to the original entry.**

1. The delta is **not** constant across viewing angle. It runs from −33 at 12 degrees to −58
   at 55 and above — the road brightens as the camera drops, which is exactly what a surface
   with a specular/environment term should do, and exactly what the roughness tuning note in
   `Surfaces.js` was guarding against. The original "−40 ± 1 at every elevation" was the
   camera not moving.

2. The magnitude was understated at the angle that matters. The live race camera sits at
   **51.8 degrees** above the player car, measured over 90 steps, which lands on the strong
   end of that curve: **−57.7 luma**, not −39.

3. My follow-up guess was also wrong. Having found the view dependence I assumed the game must
   be played at the grazing end where contrast is weakest. It is not — 52 degrees is near the
   top of the range.

**The conclusion of the entry survives, and is now better supported than it was.** The road
carries 58 luma of separation from the table at the exact camera the game ships with, and four
independent judges still say it does not read as a road. That is a stronger version of the
original argument: contrast is not the missing ingredient, because there is more of it than I
first measured and it still is not enough. The texture-continuity explanation — grain, colour
and plank seams running through the boundary unbroken — is what is left, and it is now the
only candidate standing.


## D28 — The blind A/B is position-biased when the difference is subtle — CRITICAL (method) — OPEN
The road-wear round is void, and the way it failed is worth more than its answer.

Four judges, one per camera, 1x wear against 2.4x, captured from one build at one pinned race
moment so the frames differ ONLY in the wear term. Label assignment mixed as usual — A was the
heavier setting for pairs 1 and 3, the lighter one for pairs 2 and 4.

    pair 1   A = 2.4x   chose A      pair 3   A = 2.4x   chose A
    pair 2   A = 1.0x   chose A      pair 4   A = 1.0x   chose A

**Four out of four chose A.** On the actual variable that is 2-2, a dead null. And it is not
that they were guessing: each one wrote a confident, detailed rationale for why their A had
wear and their B did not — "visible tyre-worn grooves and a scuffed racing line" vs "bare
wood"; "a darkened tyre corridor" vs "essentially bare tabletop"; "the only frame where the
track corridor is a different, worked-over surface" vs "identical bare wood". Two of those
sentences describe the 2.4x frame and two describe the 1.0x frame. They are the same sentence.

So when the difference is small enough, the judge picks the first image and then explains it.
The mixed label assignment did not prevent this — it *detected* it, which is exactly why it
exists, and it is the only reason this round did not get written up as a win.

**Earlier rounds do not show the pattern**, which fits: where the difference was obvious the
choices came out mixed (the background-aware livery round went B, A, B, B). Position bias
appears to be a failure mode of the *hard* comparison, not of the protocol in general. That
makes it more dangerous, not less: it will strike precisely on the subtle changes where a
wrong verdict is hardest to notice.

**Protocol change needed before the next subtle A/B.** Have each judge describe both frames
separately and commit to what differs BEFORE being asked which is better, and always check the
position tally as a first-class result — a 4-0 split on position with a 2-2 split on the
variable is a null, however confident the prose. Consider also running the same pair past two
judges in opposite orders and keeping the verdict only when they agree.

### What survives, because it does not depend on which frame was which
All four judges volunteered the same brief, unprompted, and every one of them said plainly
that **neither setting reads as a road**. Converged list:

  - The wear is a flat, uniform tint across the whole corridor width. Real use is not uniform.
  - No twin wheel ruts at wheel-track spacing, so the wear has no car's footprint in it.
  - The line does not migrate: it parallels the kerb at constant offset instead of hugging the
    apex and drifting wide on exit.
  - It is albedo darkening only. The missing half is **polish** — the driven line should go
    smoother and catch a different specular from the surrounding matte grain, which is what
    actually says "something rubbed here".
  - No cause: no braking smear before a corner, no scuff arcs where cars slide.
  - No edge definition, so where kerbs are absent the corridor has no boundary of its own.
  - Debris should be swept clear of the driven line and piled at its edges, not scattered
    evenly across it.
  - **And the darkening must not touch the painted markings.** At 2.4x it visibly dims the
    white lines, which immediately reads as a lighting or dirt overlay rather than surface
    wear. `track:markings` is a separate mesh, so this is worth confirming rather than
    assuming — but the observation was specific and repeated.

`roadWear` stays at its default of 1. Nothing shipped.


### D23 implementation plan — costed, with the mechanism located
Not started. Recorded at this level of detail because the expensive part of this defect has
been the false starts, and three of the four dead ends are now closed off by evidence.

**Ruled out, do not retry.**
- Changing the road's UV projection to ribbon space. Deliberate, documented, and already tried
  and reverted — the boards bent round the hairpins. `TrackBuilder` header, and the `uv:`
  comment in the deck sweep.
- Raising contrast against the table. There is 58 luma of it at the camera the game ships
  with and it is not enough (D23 re-measurement).
- Simply scaling the existing wear. Tested at 2.4x; the round was a null (D28), and all four
  judges said neither setting reads as a road.

**The mechanism to use, and it already exists.** The markings layer is a separate ribbon-space
mesh over the deck (`track:markings`), built from an atlas of rows via
`buildLongitudinalMark({ row, lateral, lift })`, where `lateral` is a per-row callback — so a
strip can follow any lateral path, including the racing line, which the deck sweep already
samples into `lineLat[]`. Critically the markings material carries a **per-row roughness map**:

    const ROW_ROUGH = [0.30, 0.32, 0.94, 0.28, 0.60, 0.32, 0.30, 0.88];

That is exactly the "polish, not darkening" half that all four judges asked for — a row can be
smoother than the wood around it and catch a highlight the matte grain does not. No new
material and no shader work is needed; this is the same trick that already makes paint read as
paint and chalk read as chalk.

**The work.**
1. Add a `rut` row. `MARK_ROWS` is 8 and `rowH = size / MARK_ROWS`, which is exactly 128 px at
   size 1024. Nine rows gives 113.78 px and will bleed between rows under filtering, so this
   step is not free — either pad the atlas to 16 rows of 64 px (halves the narrow-axis
   resolution of `checker` and `tape`, which are 5.2 and 6.5 u wide, so check them) or give
   the ruts their own small texture and accept one extra draw call.
2. Paint the row as a soft-edged strip: slight albedo darkening, and a roughness well below
   the road's 0.29 floor so it reads as polished. Width one tyre, about 1.6 u.
3. Emit two of them per lap at wheel-track spacing (`trackWidth` on the chassis physics, 3.6 u
   default, so +/- 1.8 u), with `lateral: (i) => lineLat[i] +/- halfTrack`. `lineLat` already
   migrates with the racing line, which is the "tight at the apex, wide on exit" the judges
   asked for — it comes free from using the line rather than the kerb offset.
4. Do NOT let it touch the painted markings. One judge specifically saw the 2.4x wear dimming
   the white lines, which reads as a lighting overlay rather than wear. `track:markings` is a
   separate mesh so this should already hold, but it was reported and is worth confirming.
5. Leave the existing corridor-wide vertex tint at 1x underneath as the dust component, and
   reduce it if the ruts make it redundant.

**Still missing after that**, from the same brief, in rough order of value: braking smears
before corners and scuff arcs where cars slide (both need per-corner data the racing line
already implies); debris swept off the driven line and banked at its edges; and a corridor
edge so the road has a boundary where kerbs are absent.

**Judge it with the subtle-difference protocol in REVIEW.md**, and expect to need the ruts at
an exaggerated strength first just to confirm the mechanism is visible at all, then tune down.
A null round here is likely and is not a reason to re-run.


### D23 — first implementation attempt: built, measured, REVERTED
Written up because it cost real time and the next attempt should start from what it found
rather than from the plan above, which was wrong in one important place.

**What worked.** The geometry approach is sound and is confirmed in frame. Two
`buildLongitudinalMark` strips at `lineLat[i] +/- 1.8` produce twin ruts that follow the
racing line through a corner, tightening to the inside and drifting wide on exit — exactly
the migration four judges asked for, and it comes free from using the line rather than a kerb
offset. Screenshotted and verified with the director disabled.

**What killed it.** Adding a ninth atlas row regressed every existing marking. Measured with
the ruts themselves switched OFF, against a pre-feature capture at the same pinned moment:

    gameplay      7.8% of pixels changed, max 196 luma
    macro        17.9% of pixels changed, max 184 luma
    run-to-run noise floor for comparison      0.03%

So `MARK_ROWS` cannot simply be incremented. The V convention in `buildLongitudinalMark`
(`v0 = (row + 0.02) / MARK_ROWS`) does not survive a change to the row count — every existing
row lands somewhere new. The visible symptom of the same fault on the new row is that the rut
strips render as **row 6's yellow hazard chevrons**: against a ruts-off capture they made
7.6-11.8% of the frame *brighter* by up to 189 luma, with 0.01% of pixels darker.

**Ruled out by measurement, so nobody repeats them.**
- Roughness. 0.24 and 0.60 in the rut row give byte-identical frames — the roughness map is
  not what makes the strips bright, and my first three explanations all assumed it was.
- A stale module. The live roughness map reads the new ninth row back at exactly 0.60, so the
  browser was serving current code.
- The material's blending. `markMaterial` is plain alpha with `transparent: true`; a dark
  texel cannot brighten through it. `wearPass` is `destination-out` and only erases.
- The atlas paint. Reading the live albedo texture back, row 8 is `rgb(31, 25, 22)` at alpha
  0.32 — exactly what was painted. The atlas was right and the geometry was right; only the
  mapping between them was wrong.

**Next attempt starts here.** Either (a) find why the V mapping does not survive a row-count
change — paint row 8 flat magenta, load with the ruts on, and see what colour the strips
come out; or (b) sidestep the shared atlas entirely and give the ruts their own small texture
and material, at the cost of one draw call, which avoids touching a layout that eight other
mark types depend on. **(b) is now the recommended route.** The atlas is load-bearing for
edge lines, lane lines, chalk, checker, tape, grid boxes, hazard stripes and contact shade,
and this attempt showed it will silently move all of them.

Reverted in full; `MARK_ROWS` is 8 again and the reverted build matches the pre-feature
capture to the noise floor on the wide shot (0.14% against a 0.13% floor). The residual
difference on the closer cameras is the background-aware livery change, which is intended.


## D29 — A full race ends on lap 2 of 3 because the player is eliminated at exactly the threshold — MAJOR — FIXED (gap widened to half a lap)
Measured by running a complete race with the engine stepped directly and rendering suppressed,
`?autopilot=1` so car 0 is driven. Not a capture, a whole race.

    raceTime 73.5 s     state 'finished'     laps configured: 3
    car 0 (player)  lap 2  t 0.27   ELIMINATED
    car 1           lap 2  t 0.44   running
    car 4           lap 2  t 0.61   running   <- leader
    car 5           lap 2  t 0.31   running
    car 6           lap 2  t 0.58   running
    cars 2, 3, 7    lap 1, 1, 0     eliminated

**Nobody finished.** Four cars were still circulating on the final lap when the race declared
itself over, and the leader was 0.39 of a lap from the flag.

**The mechanism is two rules meeting, and each is defensible alone.**

1. `ELIM_LAP_FRACTION = 0.34` — a car is out when it is 34% of a lap behind the leader. The
   player was at `lap 2, t 0.27` against a leader at `lap 2, t 0.61`. That is a gap of exactly
   **0.34**. Eliminated on the threshold, on the last lap, in fourth place of five still
   running and in plain sight of the car ahead.
2. `_checkRaceOver` treats an eliminated player as the race being over:
   `const playerDone = !this.player || this.player.finished || this.player.eliminated;`
   and enters FINISHED immediately. That is a deliberate choice — it is the player's race —
   and it is why the other four never got to finish.

**This is not the old D8.** D8 was the field reporting `lap: 3, finished: true` at 5.4 s with
the pack 8% around the opening lap, which is a bookkeeping fault. This one is the rules
working as written and producing a race that ends before anyone crosses the line.

**Why the tuning is already suspect.** The header comment records that the gap used to be a
fifth of a lap with a 6 s cooldown and no grace period, and says elimination "should be a
threat you can feel closing, not a coin flip". It was widened once, to a third of a lap with a
9 s cooldown and no elimination until the leader has a lap in. The measurement above says a
third of a lap is still tight enough to catch a mid-pack car on the final lap.

**Do not fix this from the numbers alone.** Whether 0.34 is punishing or exciting is a
question about how it feels with hands on the controls, and the loop has no instrument for
that — D28 established the blind judges cannot even discriminate subtle stills. This is
first on the list to put in front of a human playtest, with one specific question: when you
were eliminated, did it feel like something you saw coming?

Two candidate directions if it does need changing, neither measured yet:
  - Widen the gap on the final lap only, or scale it with laps remaining, so the last lap is
    the hardest to be thrown out of rather than the easiest.
  - Let the race play out to the flag when the player is eliminated, showing the finish rather
    than cutting to results — the four cars still running had a race on.


### D29 fixed: `ELIM_LAP_FRACTION` 0.34 -> 0.50, on a direct call
Not a tuning I derived — it was asked for, and the measurement backs it. Same race, same seed,
same autopilot, stepped directly with rendering suppressed:

                            before (0.34)        after (0.50)
    elimination gap            630 u              927 u
    race ends at              73.5 s             106.5 s
    final state             'finished'          'results'
    cars that FINISHED           0                  7
    eliminated                   4                  1
    player                  eliminated, lap 2    FINISHED, 5th of 8

Before, the race declared itself over on lap 2 with nobody across the line and four cars still
circulating. After, seven of eight complete all three laps, the player among them, and the one
elimination is a car that was genuinely a lap down (car 3, still on lap 1 when the leaders were
on lap 3). The race reaches a proper `results` state instead of cutting out.

The elimination rule still fires — it is not disabled, just no longer catching cars that are
in touch with the pack. Half a lap on kitchen is 927 u, which at racing pace is roughly 13
seconds of road: a gap you can watch opening rather than one an ordinary mistake puts you in.

**Still unverified: how it feels.** Seven finishers out of eight may now be too soft — an
elimination race where almost nobody is eliminated has lost its threat. That is the same
question D29 always was, and it still needs hands on the controls. If it reads as toothless,
the next thing to try is scaling the gap with laps remaining — generous early, tightening
toward the flag — rather than moving the single number again.
