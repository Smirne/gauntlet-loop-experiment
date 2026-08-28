# Defects

Every defect this project has raised, in the order they were found — fixed, open and retracted
alike. The title used to say *Open defects*, which stopped being true somewhere around D18.

## What is actually open, as of 28 Aug 2026

Audited by reading each entry against the code rather than trusting its header, because nine
headers carried no status at all and two entries asserted things about the code that had since
become false. Both corrections are recorded in place.

| | defect | why it is open |
|---|---|---|
| **D27** | the livery lever is nearly exhausted | needs a bigger roster, not a fix |
| **D51** | the texture budget trims the wrong surfaces | MAJOR, unstarted |
| **D53** | the car's shadow is nearly absent, not misshapen | MAJOR; measured against a box control at a byte-identical floor. Reframed 28 Aug: a lighting-level problem, not a shape one. Needs a daylight replication |
| **D54** | the headlight clips to white at the near end of its own beam | MAJOR; named by 6 of 6 critics on both sides of a controlled round. `?headlight=N` and the four-rung ladder now exist; **waiting on a human's look verdict** |
| **D56** | eliminated with cars still behind you | MAJOR; reported from play. Ranked on `score`, eliminated on `roadDistance` — the two disagree by design |
| **D55** | a pinned frame is not the moment it says it is | CRITICAL (method); `pin-shot` does not survive a boot, and its camera does not follow the step |
| D40 | tyre smoke calibration | **open by design** — the dial ships at 0 and the look is a human call |
| D41 | the macro camera's focus erases the scale cues | **open by design** — left as a question, same reason |
| D3, D4 | `rubber()` crushes to black; `brushedAluminium` reads blue | status never recorded; needs a look, probably long since fixed |

**D52 is resolved** — the critic score does discriminate, and the scoreboard is not void. What
it discriminated is the uncomfortable part: see its entry.

Everything else is fixed, retracted, or documented as harness behaviour. Two entries share a
number by accident and are now **D23a** and **D23b**. D30 and D31 each carry a deliberate
follow-up — the diagnosis and then its correction — now **D30a/D30b** and **D31a/D31b**.


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

## D3 — `Materials.rubber()` crushes to pure black — MINOR — STATUS UNRECORDED
`render/Materials.js` [A3]. Reads as a void, not a substance. Real tyre rubber has a soft
broad sheen and sits around 0.05–0.08 albedo, not 0. Needs a specular response so the
silhouette separates from shadow.

## D4 — `brushedAluminium` reads as matte blue paint, not metal — MINOR — STATUS UNRECORDED
`textures/Surfaces.js` + `ProcTex.js` [A3]. Albedo carries a strong blue tint and the
roughness map is high enough across the surface that the metal never resolves a specular
highlight. Should be near-neutral grey with anisotropic streaks and roughness ~0.25–0.40.

## D5 — `oak` has blue-tinted knot artifacts — MINOR — FIXED (no blue knot in any current frame)
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

## D19 — A ramp's lip injects energy into whatever is standing on it — MAJOR — **FIXED**
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

### D19 — the answer

The mechanism in the paragraph above was right, and it was still live on 26 Aug 2026 — after
the ramp was lowered from 8.5 to 6.5, which cut the visible symptom (respawns at the jump
went 29/55% to 8-12/0%) without touching the cause.

Two things had to be built before anything could be said about it.

The first was a way to ask the question at all. `tools/lip-probe.js` watches a whole race for
one-step speed gains, and a race is 7200 steps that in a backgrounded pane run at roughly
eight a second — a quarter of an hour per seed, per side of an A/B. Its first two versions
were also simply wrong: v1 read `c.t`, which does not exist on a vehicle, so every hit
reported an identical `distToLip: 465.5` — a constant dressed as a measurement — and every
row it flagged was a respawn, not an injection. The respawn signal that actually works is
`_respawnCooldown` going UP; `_lastRespawnAt` is only written when the escalation path runs.

The second was `tools/lip-solve.js`, which answers the useful question in a tenth of a second
instead: place the car, ask `_probeWheels()` where the ground is, then ask the track how high
the ground really is AT THE POINT THE STRUT PICKED. Disagreement is spring travel the game
invented. Two attempts at that were also wrong and were caught by their own guards:

- Respawn HOVERS the car (cgHeight + 0.6, then 0.35 more along up). 3397 of 3600 wheels came
  back ungrounded, and the handful that were not read a 1.17 u "solver error" that was
  really the placement burying the chassis in the ramp. Fixed by settling the car onto its
  springs before measuring, and by throwing out any sample whose mount is under the ground.
- A car settled flat has its struts nearly normal to the surface, which is the case the
  tangent plane handles perfectly: 940 samples across the lip, worst error **0.000**. That
  reading said "no defect" and it was an artefact of the grid. A car AT a lip is pitched,
  often rolled, often already light on its springs. Sweeping attitude is what found it.

Measured, one build, one instrument, floor taken in the same run on quiet track:

    grid: 81 positions across the lip x pitch [-25..25] x roll [0,12] x lift [0,1,3,6]

                                    at butterJump's lip      quiet track (t = 0.400)
    worst contact-vs-surface error       6.453 u                    0.004 u
    samples past 1 u of error               11                         0
    samples with d clamped to -2             3                         0

6.453 u against a 6.5 u ramp: the strut is finding the floor BEHIND the cliff and calling it
contact. Every one of the worst rows is a car pitched 15-25 degrees within about 3 u of the
lip, and each shows `compression: 1.586` — exactly `suspRest * 1.22`, the hard cap — with the
bump stop at the force ceiling. That is worth **7.97 u/s of speed per step, per wheel**, in a
game whose gravity manages 2.17 and whose tyres manage 2.8. D19's original observation of
12-15 u/s sits inside that range with three wheels to spare.

`clamp(d, -2, this._maxRay + 4)` was what made the fiction survive: a negative intersection
distance puts the contact patch ABOVE the strut mount, which no wheel can be, and clamping it
turns nonsense into a fully bottomed strut rather than into a rejected sample.

The fix, in `vehicle/Vehicle.js` `_probeWheels`:

- a negative intersection distance is no longer clamped, it disqualifies the plane;
- the `denom > -0.12` near-parallel branch no longer plumbs to `_ground.y`, which on the
  second iteration is the height at the REFINED sample point — at a lip, the floor 6.5 u
  below — it disqualifies the plane too;
- every surviving candidate is checked against `heightAt` at the contact patch, and anything
  more than `SUSPENSION_PLANE_TOLERANCE` (0.12 u) out is thrown away;
- disqualified struts go to `_marchGround`, which solves the real crossing along the strut
  against the height field: a 12-step march for the bracket (the field steps at a hazard
  edge, so nothing smarter is safe) then 6 bisections.

A plumb drop is NOT an acceptable fallback and trying it first left five configurations still
6 u out: it measures the ground under the MOUNT and then puts the contact at mount + dir *
dist, which for an oblique strut is somewhere else entirely — a different wrong answer, not a
safer one.

After, same instrument, same grid, same run:

                                    at butterJump's lip      quiet track
    worst contact-vs-surface error       0.097 u                 0.004 u
    samples past 0.5 u of error             0                       0
    samples with d clamped to -2            0                       0

Cost: 32 fallbacks in 28,800 wheel probes over 900 steps of eight-car racing — **0.111%**.
The tolerance is 30x the 0.004 u the plane solve costs on ordinary track and under a tenth of
a strut's 1.30 u travel, so it fires at cliffs and nowhere else.

`?rawSuspension=1` puts the defect back, so the A/B is one build and two flags rather than
two checkouts. Driven, seed 771, kitchen, 25 s, `tools/lip-probe.js`:

                                    rawSuspension=1      fixed
    one-step gains over 12 u/s             4               0
    worst one-step gain              16.15 u/s       7.86 u/s
    flips                                  0               0
    respawns                               5               6

And `tools/jump-arc.js`, one car, no AI, full throttle over the lip:

    entry 40 u/s                     rawSuspension=1      fixed
    worst one-step gain              15.65 u/s       0.77 u/s
    air time                             2.233 s           0 s
    apex above ground                   5.02 u           0 u

### What the fix also revealed: the jump was the bug

With the strut no longer inventing spring travel, butterJump does not launch the car at all.
Five entry speeds (30, 45, 60, 75, 90 u/s), full throttle, fixed build: not one leaves the
ground anywhere near the lip. The only airborne moments in the whole sweep are 32 u before
and 32 u after it, all with an identical 2.53 u apex, which is other terrain.

That is what the geometry says it should do. The ramp climbs 6.5 u over 30 u of track, and
`hazardHeight`'s exit slope is `h * 0.82 / length` — about 10 degrees. At a realistic 60 u/s
that is 10.5 u/s of vertical velocity, which against gravity 260 is 0.08 s of air and a
0.21 u apex: nothing. The 2.2 s and 5 u apex the old code produced were not the ramp, they
were the bump stop firing at its force ceiling against a surface 6.5 u below the wheel.

So the ramp has never actually been a jump. It looked like one because it was broken. Whether
to leave it as a bump or re-cut it so it launches for real is a design decision, not a bug —
recorded here so it is not silently decided by whoever next reads this file. For scale: at
60 u/s and gravity 260, a 30-degree exit gives 0.23 s of air and a 1.7 u apex, which needs
roughly triple the current height over the same length, or the same height over a third of
it. It was lowered 8.5 to 6.5 on 2026-08-24 specifically to stop the respawns this defect was
causing, so that constraint is now lifted.

Instrument caveat, recorded so the numbers are not over-read: `jump-arc.js` runs a 90 u
full-throttle approach, and every entry speed saturates to 59-62 u/s by the lip. The sweep
therefore tests one arrival speed, not five. It is a realistic arrival speed, and the
conclusion "no air at the lip at race pace" stands, but it is not a statement about slow
crossings.

### And then: what shape WOULD be a jump? Measured, not guessed

The paragraph above says "roughly triple the height". That was arithmetic on the exit slope,
and the arithmetic is not what happens. Two more instruments were built to find out.

`tools/jump-shape.js` mutates the resolved hazard record in place — height, length, and the t
span derived from length — so every candidate is measured on ONE boot with nothing else
different, and drives one car over it at full throttle. The road MESH does not follow a
reshape, so it is an instrument for numbers only; `?hazardGeom=butterJump:height=14,length=24`
reshapes before the mesh is built, for looking.

Two things it got wrong first, both worth keeping:

- A fresh page sits in ATTRACT with the whole field held, and a held car does not integrate.
  Every candidate came back `toeSpeed: null`, `airSeconds: 0`, `worstStepGain: 0` — which
  reads exactly like "no shape jumps" and was really "the car never moved". A run that does
  not complete cleanly is now reported `void`, never as a zero.
- A shape that flips the car DAMAGES it, and a damaged car climbs the next ramp slower. The
  same 14 x 30 read 54.4 u/s at the toe in one sequence and 51.5 in another. Repaired between
  candidates the runs agree to three decimals — and 16 x 30, which had "inverted the car",
  turned out to land upright once it was not driving the previous candidate's wreck.

One car, centreline, no steering, arriving at ~60 u/s, length 30 throughout:

    height  exit    air       apex    lands at    up.y at landing
      6.5   10.1    0         0       --          1.00
      8     12.3    0         0       --          1.00
     10     15.3    0         0       --          1.00
     12     18.2    0.075 s   3.65    +13.3 u     0.69
     14     20.9    0.117 s   4.29    +12.1 u     0.62
     16     23.6    0.125 s   4.77    +10.4 u     0.43
     18     26.2    inverted, recovered
     20     28.7    inverted, recovered

**The launcher is the toe, not the lip.** Every apex in that table sits about 20 u BEFORE the
lip, i.e. just past the smoothstep at the ramp's leading edge (`toe = smoothstep(0, 0.22, x)`
spans the first 6.6 u of a 30 u ramp). The exit slope does not predict the air at all: 12 x 24
is a 22.3 degree exit and produces nothing, while 12 x 30 is 18.2 degrees and produces the
first air in the table. The car is thrown by the kink where the ramp starts, and lands well
before the drop it was supposed to fly off.

Then the number that actually decides it. `tools/jump-cost.js` runs a full eight-car race at a
given shape and counts recoveries and flips within 0.02 of a lap of the ramp — the same
currency the 8.5 -> 6.5 cut was made in. 60 s, kitchen, seed 771, all eight cars, chunked so a
7200-step race is not indistinguishable from a hang:

    height  exit    respawns  at jump   flips  at jump    air (1 car)
      6.5   10.1        3        0        2       0       none
     10     15.3       10        3       10       7       none
     12     18.2       39       31       43      39       0.075 s
     14     20.9       41       30       40      31       0.117 s

**There is no height in this profile that produces air without wrecking the race.** The cost
arrives BEFORE the air does: at 10 u nothing flies and the field is already paying 3 recoveries
and 7 flips at the jump, and the first height that gives a single car any air at all costs 31
recoveries — ten times the whole-race total at 6.5. The single-car table understates it because
it drives the centreline with the wheel straight; a field arrives at an angle, and the toe kink
rolls it.

So the honest statement is stronger than "the ramp is now a bump". Within this hazard profile,
at gravity 260, **a jump is not available**. Making one is not a number change: it needs a
different ramp profile (a take-off that rotates the car instead of kicking one axle), and
probably air stabilisation to go with it. That is a feature, not a fix, and it is not being
started without a decision.

### Decided: 10 u, for the look, knowing the price

Put to Michele on 26 Aug 2026 with the tables above and a pair of frames of the same crossing at
6.5 and 14. His call: **raise it to 10** — no air, but a wedge with a face and a shadow instead
of a swell in the wood.

Then a correction, because the table he decided from was one race per shape and one race is a
noisy sample. Height 10 measured **3, 7 and 8** recoveries at the jump across three races, and
**7, 13 and 13** flips. The two instruments agree with each other — reshaping the hazard in
place and baking the mesh through `?hazardGeom` give the same at-jump numbers — so this is
race-to-race variance rather than an instrument bias, and the earlier "3 and 7" was simply the
low end of it. Fresh boots, mesh baked, one 60 s eight-car race each:

    height   respawns   at jump   flips   at jump
      6.5        2         0        0        0
      8          5         2        6        5
     10         13         8       14       13

10 ships. 8 is on record as the cheaper half of the same trade if the rolls ever start costing
races, and the ranking — which is what the sweep is good for — was never in doubt.

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

## D13 — Fog is heavy enough to erase the backdrop — MAJOR — FIXED (and it was flattening every frame, not just the backdrop)
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

## D7 — Livery texture bakes near-black — CRITICAL — FIXED (liveries read in colour in every current frame)
`vehicle/VehicleVisual.js` [A7]. `makePaintMaterial` deliberately keeps the material colour
white and carries the livery in `tex.map` — that design is fine. But the baked 1024×512 canvas
is 22% #080808, 17% #000000, 17% #080810, with only ~19% of a dark orange. The livery record
itself is correct (`Hemi Orange` base #D85A1C, `Forest Green` #1D5A34), so the fault is in the
canvas paint pass, not the palette. Cars will read as black even once D6 is fixed.

## D8 — Race finishes instantly — CRITICAL — FIXED (see the fix section below)
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


## D23a — The road does not read as a road: the first pass — MAJOR — **FIXED** (bde13b3; original numbers VOID, re-measured at the end)
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


## D28 — The blind A/B is position-biased when the difference is subtle — CRITICAL (method) — **FIXED** (protocol rebuilt and validated against three known answers)
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


### Fixed: the protocol was rebuilt, and then shown a known answer three times

An instrument that has never been given a question whose answer is already known is not an
instrument. The old protocol had never been given one — every round it ever ran was a round
whose answer nobody knew. So the fix is a harness (`tools/ab-round.js`, scored by
`tools/ab-score.js`), and the evidence that it works is three rounds where the answer was
settled before any judge saw a frame. 27 judges, records in `rounds/d28-*`.

| round | known answer | verdict | position | variable | controls called different |
|---|---|---|---|---|---|
| every pair is one frame against itself | nothing there | NULL | no preferences | — | **0 / 2** |
| full detail vs a 320 px round trip | the clean one | **VERDICT** | 3 / 3 | 6-0, p=0.031 | **0 / 3** |
| depth of field on vs off | genuinely contested | **SPLIT** | **4 / 4** | 2-2 | **0 / 2** |

**Describe-before-choosing works, at detection.** Perfect separation, both ways: none of the
eleven control judges claimed a difference between a frame and itself — all wrote "neither"
without being pushed — and all ten real-pair judges named the actual difference in concrete,
locatable terms before choosing. That was the adopted policy in REVIEW.md and it earns its
place.

**It does not stop position bias.** On the depth-of-field round every judge chose the second
image while describing the difference accurately and naming the trade-off in its own words —
"legibility versus style", said four different ways. Honest, specific, self-aware, and still
4-0 on the slot.

**The bias has no fixed direction.** The road-wear round above went 4-0 to the FIRST image.
This one went 4-0 to the SECOND. Whatever the mechanism is, it is judges converging on a
side rather than preferring a side, so no correction absorbs it and mixed labels only ever
detect it after the fact.

**And it appears exactly where this file predicted.** D28 argued from memory that position
bias is a failure mode of the *hard* comparison specifically. Measured: position was 3/3,
dead level, on the round whose answer was obvious, and 4/4 on the round whose answer was
contested — same judges, same brief, same session, same controls.

**What actually caught it was the cross-order rule, which REVIEW.md had declined on cost.**
At four judgements a 4-0 position split is p=0.125 and cannot clear any honest threshold, so
the position tally could not have condemned that round. Both orders of both cells naming
opposite settings could, and did. That paragraph in REVIEW.md is now overturned, on its own
stated revisit condition.

**A fourth rule fell out of the arithmetic, and it indicts every round this project has
run.** A unanimous split of n judges is p = 2 / 2ⁿ. The four-judge, four-camera round used by
every round to date bottoms out at **p = 0.125** — it was never capable of producing a
significant result, and D28's own "four out of four" was not significant even as a position
split. Six real judgements (three cells, both orders) reach 0.031. The scorer now returns
NULL and says *underpowered* rather than letting a small round's quiet null read as evidence
of no difference.

Encoded, so none of it depends on remembering: `ab-round.js` builds both orders and the
controls or it does not build a round; `ab-score.js` refuses VERDICT to any round without
controls, voids a round whose controls come back different, and reports the position tally,
the cross-order agreement and the power next to every verdict. Its `--selftest` scores the
road-wear round above from its own numbers and must return NULL.

**Not proven:** that the bias is absent from *critic* rounds, which score one frame rather
than compare two. That has its own control now — see the bedroom round — but it is a
different measurement and this one says nothing about it.


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


## D30a — The room is outside the shadow system, so the table casts nothing on the floor — MAJOR — PARTIALLY FIXED (flags corrected; the visible result is still missing)
Found by the round-6 establishing judge, which called it "a shadow-cascade/receiver bug
visible from across a room": a 3 cm milk carton on the tabletop throws a crisp shadow three
times its own length, while the largest object in frame — the table — puts nothing on the
floor beside it.

Checked, and it is broader than that. Every mesh in the room:

    MG.Room.floor            cast false   receive FALSE
    MG.Room.wall0..wall3     cast false   receive FALSE
    MG.Room.prop0..prop10    cast false   receive FALSE
    track:tableLeg0..3       cast FALSE   receive false
    track:tableUnderside     cast false   receive false
    track:tableEdge          cast false   receive true     <- the only receiver

So the floor cannot receive and the legs cannot cast; the absence is structural, not a
cascade-range problem.

**It is deliberate.** `Sky.js` states it outright: "a floor, four walls, and a handful of
block silhouettes, all behind and below the playfield, all opaque, none of it castShadow or
receiveShadow", on the reasoning that the room is a distant backdrop that gets fog falloff,
DOF and occlusion by the table for free. That is sound for a backdrop.

**The assumption is violated by one camera.** The establishing wide frames the floor
prominently *beside* the table rather than behind it, and there the missing shadow is the
first thing a viewer notices. The fix is not to switch the whole room on — that would cost
the shadow budget the exclusion was protecting — but to make the table legs and top cast, and
the floor receive, which is four flags and one cascade that already reaches (cascade 2 has a
902 u radius against a 1300 u far plane).

Do not re-test this by looking at the gameplay or chase cameras: the floor is not in frame
there, and the change will correctly appear to do nothing.


### D30 attempt: flags corrected, far plane tried and reverted, effect still not visible
Three flags were wrong and are now right, at no cost: `MG.Room.floor` receives, and
`track:tableLeg0..3` and `track:tableUnderside` cast. The legs were marked "far outside the
shadow cascade", which was true at `shadowFar` 760 and has not been true since it went to
1300 — measured, all four legs sit inside cascade 2's frustum.

**And it barely changed the frame.** Cast-shadow coverage on the establishing camera, both
variants captured from one build at one pinned moment:

    before D30                       2.35%
    after the flag fix               2.51%
    after ALSO raising shadowFar     2.55%

**The far-plane theory was right about the arithmetic and wrong about the outcome.** The
table's shadow lands on the floor at a view depth of 1312, and the shader's baked fade window
was 1170-1300, so `smoothstep` returned 1 and the shadow term collapsed to 1.0 — genuinely
faded out, with cascade 2's coordinate at (0.376, 0.44, 0.617), comfortably inside the map.
Raising `shadowFar` to 1650 moved the window to 1485-1650 and the point stopped being clipped.
It made no measurable difference, and it cost real quality everywhere: cascade 2's radius went
902 -> 1157 and its texel 0.88 -> 1.13, i.e. **every shadow in the game 28% blurrier** to buy
0.04% of frame. Reverted.

**What is still unexplained.** The floor is 16.75% of the frame at the live director camera,
and the round-6 judge described the floor and the table leg in the establishing capture — so
it is in shot. Either the capture pose shows much less floor than the live camera does, or
something downstream of the fade is still suppressing it. **Measure what fraction of the
CAPTURE establishing frame is floor before going further** — capture once with
`MG.Room.floor` hidden and diff. If it is a few percent, the whole defect is worth less than
it looks and the flags alone are the right stopping point.

Keep the flags: they are correct, they cost nothing, and they are a precondition for any
later fix. Do not raise `shadowFar` again without a measured gain to justify the texel cost.

---

## D31a — the paint never reaches the screen: a clearcoat reflecting a beige kitchen eats about half of every livery's chroma — MAJOR — SYMPTOM REAL, CAUSE RETRACTED (see D31b)

**Status: OPEN.** Found while shooting the before/after for the livery change, which is the
only reason it was found at all — nothing else in the project had ever photographed all eight
cars at once with the lens blur switched off.

**The symptom.** In the line-up frame, `Candy Plum #6a1d5c` — a deep purple — is grey.
`Petrol Blue #18468c` is grey-brown. `Arrest Me Red #c21520` is a dusty mauve. `Verde Acido
#8fce1c`, an acid green, is olive. Every car in the field has been pulled toward the colour of
the table it is standing on, which is *precisely* the complaint three independent judges made
in their own words in round 4 and which I answered with colour arithmetic instead of looking.

**The cause, isolated with one probe.** `car:paint` carries `clearcoat: 1` and
`envMapIntensity: 1.35` over a `metalness` of 0.34, and the scene's environment is a warm room
at `environmentIntensity` 0.6 lit by a `#ffd8ae` sun at intensity 5.91. The clearcoat lobe is
a full-strength mirror of that warm room laid over every painted panel, and the paint is
underneath it. Captured from one build at one pinned pose, paint materials only, everything
else untouched:

    shipping     clearcoat 1   envMapIntensity 1.35   metalness 0.34
    probe        clearcoat 0   envMapIntensity 0.25   metalness 0

The probe frame is in `shots/livery-board-probe-nocoat.png`. Green becomes green, orange
becomes orange, white becomes white. It is not subtle and it does not need a judge.

**THIS IS NOT A BUG REPORT AGAINST THE CLEARCOAT.** The probe is *worse* as an image: the cars
go flat and plasticky, and the die-cast read — a highlight rolling around a cast fillet — is
most of what sells the scale. The defect is that the veil is at **full strength**, not that it
exists. The fix is a value between the two ends, and it has to be found by looking, not by
picking a number that sounds moderate.

**What this costs the work already done.** D24 and the change committed alongside this entry
both optimise *authored* hex distance. The authored numbers are the right thing to choose on —
they are the only stable handle — but the improvement they promise arrives at the screen
heavily attenuated, and no number in either writeup accounted for that. Both are still
improvements. Neither is worth what its table says.

**Rule earned: A COLOUR DECISION IS NOT DONE UNTIL YOU HAVE SEEN THE PIXELS.** Authored data
is the right thing to *decide* on (that rule stands). It is not evidence about what a player
sees. Two instruments failed on the way here and both failed silently: sampling the
most-saturated pixels in a patch around each car returned the colour of the oak for all eight,
because fogged paint is less saturated than wood; and aiming the patch at 0.82 of body height
returned the colour of the tinted canopy. Both produced complete, plausible tables of numbers.
The contact sheet of sample points is what caught them — print the patch, look at it, and only
then read the number off it.

---

## D31b — RETRACTED CAUSE. The symptom is real and measured; the explanation I committed was wrong.

**What I claimed, one commit ago:** that `car:paint`'s `clearcoat: 1` at `envMapIntensity:
1.35` lays a full-strength mirror of a warm kitchen over every panel, and that this is what
eats the liveries' colour.

**That is false, and the test that produced it was malformed.** The probe changed THREE things
at once — `clearcoat` 1→0, `envMapIntensity` 1.35→0.25, `metalness` 0.34→0 — I saw the frames
differ, and I attributed the difference to the one I had a story about. Changing them one at a
time, on the eight cars, measured as the 95th percentile of chroma in a box around each car
(a metric that ignores the number decals, the glass and any table between the wheels):

    paint envMapIntensity 1.35 -> 0        +0%
    paint clearcoat 1 -> 0                 +0%
    paint metalness 0.34 -> 0              +5%
    scene.environment removed entirely     +6%

The clearcoat contributes **nothing** to the colour loss. Neither does the paint's environment
reflection. The whole postfx stack is no better an explanation: bloom off 0%, AO off +1%, fog
off 0%, the grade pass off +3%.

**And the tone-map knob was never connected.** Four different operators — Neutral, AgX, Cineon,
Linear — produced byte-identical frames, because `postfx._gradeOwnsToneMap` is true and the
grade pass does its own tone mapping in-shader. Any conclusion drawn from
`renderer.toneMapping` in this project is worthless. Halving the sun moved car luma from 140.5
to 139.0, which says the sun is not lighting the cars either.

**What survives, and it is worth keeping.** The symptom is measured and not in doubt: on-screen
chroma is roughly 45% of authored chroma across the field (Cyan Flash authored 212, on screen
84; Sunburst 216 -> 103). The textures are innocent — sampled straight off the paint map, Cyan
Flash's modal texel is rgb(3,180,207) against an authored `#00b8d4`. So the colour is correct
right up to the moment it is lit, and **nothing I have switched off accounts for the loss.**
The cause is open.

**Rule earned: A PROBE THAT MOVES THREE THINGS EXPLAINS NONE OF THEM.** I would not have
accepted this test from anyone else. One variable per frame, and a control frame — capturing
the same state twice and requiring the diff to be 0.000% — before any of it is believed.

---

## D30b — SOLVED. The room cannot receive a shadow: it is a ShaderMaterial with no shadow code in it.

Two rounds of this defect went looking for the missing shadow in the shadow system. It was
never there. **`MG.Room` is a raw `ShaderMaterial` with `lights: false`**, and its 29 KB
fragment shader contains no `shadowmap_pars`, no `lights_fragment_begin`, and no shadow sample
of any kind. The cascaded shadow map is installed by rewriting
`THREE.ShaderChunk.lights_fragment_begin` — a chunk this material never includes.

**So `floor.receiveShadow = true` is a no-op.** It was set last round, recorded as "correct and
free", and it is indeed free. It also does nothing at all. The same material covers the floor,
all four walls and eleven props: **37 objects in the scene, none of which can darken.**

Measured on the establishing frame, grain and chromatic aberration disabled, with a control
capture of the identical state to prove the instrument (control diff **0.000%**):

    room floor, share of the frame                16.72%
    all shadow in the frame                        2.25%
    share of that shadow falling on the floor      0.00%

**Every earlier theory is now falsified, including two of mine from today.**

*The far plane.* The previous writeup put the table's floor shadow at view depth 1312 against
a baked 1170-1300 fade window. Measured from the actual establishing pose, the floor under the
table is at depth **926** — comfortably inside `shadowFar` 1300 — and projecting it into
cascade 2 puts it at (0.21, -0.16, 0.14), inside on every axis. Raising `shadowFar` was
correctly reverted, for the wrong reason.

*The sun angle.* I proposed that the sun at 24 degrees elevation throws the table's shadow
clear of the visible floor wedge. Raising it to 55 degrees produced no shadow either.

*Anything at all.* A red slab hung 30 units above the floor, `castShadow = true`, directly in
the visible wedge, casts nothing. That is the whole defect in one frame:
`shots/d30c-probe-slab.png`.

**The fix is not in Lighting.js.** It is to give the room a material that participates in
lighting, or to catch the shadow separately. That is a real visual change to 16.7% of the
frame and it needs judging, not just landing.

**Rule earned: A FLAG IS NOT A FEATURE.** `receiveShadow` is a request to a shader that may not
be listening. Before believing any material property, check that the material's shader actually
reads it — `/shadowmap_pars/.test(mat.fragmentShader)` would have ended this defect two rounds
ago, and it cost one line.

---

## D32 — the depth of field blurs the car you are racing. FIXED at 0.55.

Reported from a playthrough as "the ones far behind or before are a bit blurred". Measured on
the live chase camera, a rival **17 units ahead — two car lengths** — was at `coc 1.00`, the
entire 67 px kernel. Both terms saturated independently: screen band 1.00, depth 0.71.

The screen band is blind by construction: it blurs by how far up the FRAME a pixel is, and its
sharp strip is 23% of frame height. Anything ahead of or behind the hero in a chase shot leaves
it however close it really is.

PostFX already had the right rule with the wrong definition of subject — "the band may never be
narrower than the hero's own silhouette". The subject of a racing game is the part of the field
you can still do something about. Both terms now measure the rivals within `DOF_FIELD_REACH` by
projecting them, which picks up camera pitch, road slope and foreshortening for free.

**Shipped at 0.55 of the way, and the fraction is the point.** Judged from three frames out of
one build at one pinned clock (20.008 s): A today 67.0 px on the nearest rival; B at 0.55,
5.5 px; C at 1.0, zero — and the sharp strip at 60%, which is what a wide establishing shot is
allowed, with the miniature read gone. `?dofField=N` renders any point on the dial.

## D33 — `R` is two different actions and the results screen advertises the other one — MINOR — FIXED (Results.js:386 no longer advertises `R`)

`Input.js` binds `respawn: ['KeyR']` and `restart: ['Backslash']`. `Results.js` draws the RETRY
button with the key hint **R**. So during a race `R` puts the car back on track at its last good
point, and on the results screen `R` restarts the whole race — and nothing tells the player
which one they are about to get.

Reported as "the retry key sometimes restarts from the last position, I guess it should start
the full race again?". It is not intermittent and `Race.start()` is not at fault: it calls
`_placeOnGrid()` on every entry and resets the clock correctly. This is a key collision plus a
label, nothing more, and it is a real defect because the player cannot tell the two apart.

## D34 — boost has no top end, because the force that was supposed to give it was never wired up — MAJOR — FIXED (`boostForce` is applied at Vehicle.js:1889)

`boostForce: 27` is declared in the tuning table, commented "flat thrust — **this is what raises
top speed**", and the comment at the application site says "Boost multiplies torque (the punch)
and adds a flat force later (the top end)".

**`boostForce` has exactly one mention in the entire tree: its own declaration.** Nothing reads
it. The flat force is never added. *(No longer true: it is applied at `Vehicle.js:1889` as
`t.boostForce * BOOST_FORCE_SCALE * this.boostAmount * t.mass`. The paragraph is left as
written because it is the diagnosis; this note is the correction.)* Boost multiplies engine torque by `boostTorque` 1.55 and
does nothing else, which is why a player reports "Is the boost doing something apart visual
effect? Effect on speed is not very evident."

One theory checked and dropped: `crank` is zeroed on the limiter, while shifting and in
neutral, so boost could have been a no-op at the top end for that reason instead. Measured over
1400 steps across all eight cars — of 304 samples above 90% of top speed, **0%** had the
torque zeroed. The engine is pulling up there. The missing force is the whole story.

## D35 — the respawn has a visual hook that nothing has ever read — MINOR — FIXED (`respawnFlash` drives the blink at VehicleVisual.js:873)

`Vehicle.respawnFlash` is set to 1 in `respawn()` and decayed every frame in `update()`.
Searched the whole tree: **there are no other references.** *(No longer true: `VehicleVisual.js:873`
reads it to drive the respawn blink. Diagnosis left as written; this note is the correction.)* No material, no shader, no fx
system and no HUD element consumes it, so a respawn is a hard teleport with no visual event on
the car at all. The only feedback is a DOM toast in the corner reading RESPAWN.

Reported as "sometimes my car gets repositioned very quickly, I don't know if it's the crash
restore, it should have some visual effect?" — which is exactly right, and the codebase already
agreed with him three years of commits ago and then never finished the sentence.

## D36 — the biscuit. NOT REPRODUCED, and the obvious cause is ruled out.

A player asked "where did that biscuit came from?" over two stills a moment apart, the second
of which has a large biscuit next to the car where the first appears to show bare paper.

The obvious mechanism is stale instanced bounds: props are `InstancedMesh` with
`frustumCulled = true`, many are `knockable` and move under `DynamicDrawUsage`, and
`computeBoundingSphere` does not appear anywhere in `Props.js` — so a mesh whose instances have
been knocked about could be culled against bounds that no longer describe it.

**Measured, and it is not that.** Of 30 prop meshes, 29 have bounds identical to freshly
computed ones and the single drifted mesh (`prop:toast:bread`) is out by 1.4 units on a radius
of 171. Every prop mesh's bounding radius spans the whole table anyway, so per-instance culling
is not happening and a single biscuit cannot pop on its own.

Two stills is not enough to tell a pop-in from a prop that another car knocked into shot. Needs
the moment in the full clip, or a systematic pass watching prop visibility over a lap.

---

## D37 — being eliminated after 26 seconds DNFs the entire field. FIXED.

Spotted in a player's results screenshot: seven CPUs ranked 1st to 7th, **every one of them
showing DNF**, and a championship round that scored nothing but the knockout point.

`AI_GRACE` is documented as "seconds the field gets to finish **after the player**", and
`_checkRaceOver` spends it like this:

    if (running === 0 || this.raceTime - this._playerFinishedAt > AI_GRACE) { ...DNF everyone... }

`_playerFinishedAt` was assigned in exactly one place in the file: the `e.isPlayer` branch of
`_finishEntry`, i.e. **crossing the line**. Being knocked out never set it, so it kept the 0 it
was given in `start()` and the grace was measured against the whole race clock instead of
against the moment the player left the race.

That put a cliff at 26 seconds. Measured before the fix, same build, same track:

    player out at  8 s  ->  7 real finishers, 0 DNF   (8 - 0 = 8, inside the grace)
    player out at 40 s  ->  0 finishers, 7 DNF        (40 - 0 = 40, already expired)

The second row is the screenshot. Every remaining car was classified on the very next tick,
which is also why the ranking looks incoherent — they are ordered by where they happened to be
standing, and all of them are DNF.

**Fix:** `_eliminate` sets `_playerFinishedAt` when the eliminated entry is the player. One
line, restoring what the constant's own comment already promised.

Verified after, three eliminations at different clocks, each played out to the results screen:

    out at  8 s -> ended 11.2 s, 7 finishers, 0 DNF, top three CPU 1/2/3
    out at 40 s -> ended 43.2 s, 7 finishers, 0 DNF, top three CPU 1/2/3
    out at 70 s -> ended 73.2 s, 5 finishers, 0 DNF, top three CPU 1/2/4

The grace actually used is 3.2 s in all three: the AI were near the flag each time and the
`running === 0` branch closed the race long before the 26 s ceiling. The ceiling only ever
existed to stop a stuck AI holding the results screen hostage, and it still does.

**Not a bug, checked while here:** CPU 1's `+1` in that screenshot is correct. `_eliminate`
gives the car that knocked you out a point — "the leader banks a point for the knockout,
exactly as the original does" — and CPU 1 was the reference car. It is not a fastest-lap point
and it is not scoring off a DNF.

**Rule earned: A CONSTANT'S COMMENT IS A CLAIM ABOUT CODE THAT MAY NOT EXIST.** `AI_GRACE`
said "after the player" and nothing in the file made that true for half the ways a player can
leave a race. The same shape as `boostForce`, `respawnFlash` and `receiveShadow` on the room —
four in one session. Grep for a field's writers before trusting what its neighbours say it does.

---

## D38 — the respawns at the start are real. The blink just made them visible. — MAJOR — FIXED (respawns at the jump 55% -> 0%)

Reported as "at the start of the race I often get respawn and other car does, even if no
accident occurs". There is an accident. It is a fall, it is silent, and until the respawn blink
shipped nothing on screen said it had happened.

Instrumented over the first 11 s of a race: **four respawns**, three of them on cars with
`up.y = -1` — completely inverted — and airborne for over two seconds. Tracing the moment each
car flips puts them all in the same place:

    flipped at   lapT 0.175 .. 0.256      lateral -6.5 .. -15      y up to 12.5      speed 66..88

Track half-width there is 14.4, so they are leaving the road at the left edge at full speed.
The cross-section at t = 0.245 says why:

    lateral    0 .. -9     surface y 6.41   (road, dead flat)
    lateral  -10.5         surface y 5.77
    lateral  -12           surface y 2.58   <-- a 3.19 u step in 1.5 u of lateral
    lateral  -13.5         surface y 0.54
    lateral  -15 outward   surface y ~0.5 -> 0  (the table)

**The road is a ribbon standing 5.9 units proud of the table and it drops that in about three
units of lateral distance** — near enough a 60 degree wall, with a single 3.19 u step in the
middle of it. A car that runs wide at 80 does not slide off, it trips and barrel-rolls.

It happens early because that is when the field is bunched and cars get pushed wide.

**NOT the kerbs, and not my change to them.** Three of the six flips traced happened where
`kerbWidthAt` returns 0 — there is no kerb there at all — and the wall spanning 0.150-0.232 is
on side +1, the right, while every flip is on the left. Kerb suppression only zeroes the side
the wall is on, so it touched none of this.

**Not a new bug either.** Nothing in this session altered the road profile. What changed is that
`respawnFlash` is finally read by something (D35), so a recovery that has always been silent now
blinks. The report is evidence the blink works.

**OPEN, and it is a design question, not a defect with one right answer.** Options, none taken:
a taller lip on the elevated sections so a car is turned back instead of tripped; a gentler
shoulder taper so leaving the road is survivable; AI early-race line tuning so the field does not
get shoved off in the first corner; or accepting it as a hazard of a raised circuit and leaving
it. The first three all change how the track drives.

### D38 update — the ramp's SIDE is fixed. The ramp's LANDING is the real problem.

`hazardLateralWeight` holds a hazard at full height out to 72% of its half-width and tapers the
rest. `butterJump` was 27 wide on a 28.75-wide road, so its entire 8.5 u fall sat INSIDE the
drivable surface — flat to lateral 9.7, on the table by 13.5. Widened to 40, measured:

    before   flat to  9.7   steepest step 3.19 u per unit lateral   INSIDE the road
    after    flat to 15.0   steepest step 1.56 u per unit lateral   out on the table

The road edge (14.38) now sits on the ramp's flat top instead of halfway down its side. That
part is deterministic, measured, and an improvement.

**IT DID NOT REDUCE THE RESPAWN RATE, AND I NEARLY REPORTED THAT IT DID.** A first A/B showed
14 respawns at width 27 against 8 at width 40, which is the number I would have shipped. Running
the same width three times in a row gave 10, 10, 10 — stable — but the earlier 8 came from a
different starting state, because each run inherits the end state of the last. Interleaving the
two widths, three runs each:

    width 27   respawns 10, 13, 10      flips 13, 14, 14
    width 40   respawns 10, 10, 16      flips  7,  8, 13

Median respawns: **10 against 10**. There is no respawn improvement in the data. Flips may be
lower and the evidence is too weak to claim it.

**Where the respawns actually come from.** One 71 s race, respawn positions bucketed by lap
fraction:

    lapT 0.25   16 respawns   55%   <-- the ramp LANDING (butterJump is at 0.243)
    lapT 0.05    6            21%
    lapT 0.70    4            14%
    lapT 0.10    2             7%

**Over half of every respawn in the race is cars landing badly off one 8.5 u jump.** The side
wall was real and is fixed; it was not the dominant cause. Keeping the width change — better
geometry, no regression — and reopening the actual question: an 8.5 u ramp launching a 2.8 u
tall car, with whatever it lands on.

**Rule reinforced: FIND THE NOISE FLOOR BEFORE BELIEVING A DIFFERENCE.** Two runs is not a
measurement when consecutive identical runs disagree. Repeat the same condition until it
reproduces, then interleave the conditions so drift cannot favour one.

### D38 resolved — the jump was too tall, and 6.5 is where it stops costing races

The side wall was fixed by widening the hazard (above) and it did not move the respawn rate.
The height did. Respawns caused at the jump over a 60 s race, heights interleaved so drift
could not favour a value:

    height  8.5    7 respawns
    height  7.5    7, then 6
    height  6.5    0, then 0
    height  5.5    0

A cliff edge, not a gradient: everything at 7.5 and up costs six or seven recoveries a race,
everything at 6.5 and down costs none. 6.5 ships because the jump should be as tall as it can
be — it is the one moment on this circuit anyone will remember — and 6.5 is the tallest that
lands.

Landing width 29 -> 33 (half-width 16.45) on top of that, tested separately over three full
races each:

    height 6.5, width 29    respawns at the jump  3, 0, 2
    height 6.5, width 33    respawns at the jump  0, 0, 0

Small, real, and it removes the tail rather than the bulk.

**Whole-race totals, same measurement as the original diagnosis:**

    before   29 respawns, 55% of them at the jump
    after    8-12 respawns, 0% of them at the jump

The remaining recoveries are somewhere else entirely: lapT 0.05 (the grid, where the field is
still bunched) and lapT 0.70. Neither has been looked at.

---

## D39 — the hairpin's banking pumps, because the curvature it is derived from is not smooth. FIXED.

A player, looking at the walled hairpin: *"right side kerb seems to go down, like there's some
kind of hole / small change in elevation on the track. Is this on purpose?"*

Half on purpose. Banking is on purpose and it is automatic — `bank = -gain * kappa * vRef^2 / g`,
hard-capped, driven by smoothed curvature, and the kitchen defines no `bankingProfile`, so every
bank on the circuit is derived rather than authored. Through the hairpin the road rotates about
its centreline: the inside edge rises to +2.2 and the outside drops to -1.1, a 3.3 u cross-fall.
The centreline stays at 0.55 throughout, so there is no hole and nothing is broken.

**What is NOT on purpose is that it does it twice.** Sampling the outside edge along the corner:

    t      0.49   0.50   0.51   0.52   0.53   0.54   0.55   0.56   0.57
    drop  -0.04  -0.56  -1.67  -1.58  -1.06  -0.55  -1.61  -1.66  +0.02
    radius  1362   140     22     40     77    154     29     21     277

The bank falls, recovers almost to flat at t 0.54, then falls again — and the curvature does
exactly the same thing, 22 -> 40 -> 77 -> 154 -> 29 -> 21. The hairpin's spline has a slack
section in its middle, the derived banking follows it faithfully, and the outside kerb visibly
rises and drops twice through one corner.

### The corner was never the problem. The ruler was.

The plan was to move the hairpin's control points so its curvature became monotonic. Measured
first, and the geometry turned out to be innocent. Radius at t = 0.535, by the length of the
baseline the curvature is measured over:

     4 u baseline     -124   a SIGN FLIP — reads as a right-hander
    15 u baseline   -14265   effectively straight
    35 u baseline       67   the real shape: a continuous left

Across the whole corner the 35 u reading runs 33-67 and **never changes sign**. So the double
apex is genuine, gentle, and exactly what the track header says it is. The R23-to-R153 swing
only exists at short baselines, and it is resampling ripple: the path's control points are
integer coordinates 22 u apart, and `curv` is a **1.5 u finite difference**, which at that scale
sees the rounding rather than the road.

The banking followed the ripple faithfully. Bank through the corner, in degrees:

    t       0.505  0.510  0.515  0.520  0.525  0.530  0.535  0.540  0.545  0.550  0.560  0.570
    before  -4.24  -9.14  -9.17  -9.17  -9.16  -6.10  +2.37  -2.30  -9.15  -9.17  -9.17  +0.45
    after   -8.95  -9.17  -9.17  -9.17  -9.00  -6.41  -5.15  -7.39  -9.16  -9.17  -9.17  -5.48

**It hit the -9.17 cap, un-banked through zero to +2.37 — tilted the wrong way, mid-corner —
and returned to the cap, inside about 18 u of road.** That is the "hole" a player reported.

**Fix: derive banking from a road-scale baseline.** Bank now comes from how far the tangent has
actually swung over 35 u (one and a half control spacings — long enough to be immune to the
ripple, short enough that a real R26 chicane still banks), via `atan2(cross, dot)` so it stays
exact through a hairpin where the two tangents are more than 90 degrees apart. `curv` itself is
deliberately untouched: TrackBuilder generates kerbs from it and ai/Driver.js picks corner
speeds from it, and neither wants a smoothed version.

Whole lap, one build, `?bankBaseline=0` against the default:

    mean |bank|          3.70 deg  ->  3.71 deg     the corners bank exactly as much
    p90 |bank|           9.17     ->  9.17
    max |bank|           9.17     ->  9.17
    TOTAL VARIATION    344.9 deg  -> 178.1 deg      the road stops wobbling

Same banking budget, half the wobble. `shots/bank-ab.png` is the fixed-camera pair, and
`tools/bank-ab.js` reproduces it.

**Two mistakes worth keeping.** The sign was inverted on the first attempt — `atan2(cross, dot)`
already measures the same quantity `curv` does, and negating it banked every corner on the
circuit the wrong way, +9.17 where the shipped build reads -9.17: right magnitude, mirrored
road. And the first A/B images were not comparable, because the camera was built from
`pos + right * halfWidth` — the road's own **banked** frame — so the camera moved with the very
thing under test. **If the subject is a transform, do not build the camera out of that
transform.**

## Instrument note — the establishing frame, and the instrument that measured it

The review's establishing pose was said to put the room at 53.32% of frame, and both round-7
judges named it as the thing that cost the set. Everything about that sentence needed checking,
and three separate things were wrong.

**Wrong 1: "the wide view opens every race."** It does not. It is the MENU BACKDROP — dimmed,
behind panels — and `?skipmenu=1` skips it outright. A player asked when that view is shown and
could not reproduce it. He was right not to be able to.

**Wrong 2: the room-share instrument counted the wrong pixels.** It hid every `MG.Room` object
and diffed the frame against itself. But the room is not just something you SEE — its floor and
walls bounce light into the whole scene, so hiding them shifts pixels the room does not occupy.
At the close end of the menu orbit, where the image plainly shows no room at all, that method
reported 50-60%.

**Wrong 3: the diff was run without zeroing the grain, so its noise floor was 33%.** Captured
the SAME frame three times with nothing hidden: consecutive captures differ by 32.7% and 32.6%
of pixels. With `passes.grain.uniforms.uAmount = 0` the same test gives **0.00%**. This project
already had the rule — ZERO THE GRAIN BEFORE A FRAME-DIFF — and it was broken anyway, which is
how two full tables of room-share numbers were produced and briefly believed.

The instrument that actually works paints every `MG.Room` mesh flat magenta, everything else
flat black, renders with the depth buffer doing the occlusion, and counts magenta. It measures
room a viewer can SEE. Control: 0.0%. Measured with it:

    the OLD review pose (hand-written, rounds 1-7)       82.8%  room
    the NEW review pose (Director's orbit at 1.2 s)      33.9%  room
    the menu backdrop, what a player is actually shown:
        0.2 s  27.1%    1.4 s  17.5%    2.6 s  3.4%    3.4 s onward  0%
        0.6 s  24.9%    1.8 s  12.5%    3.0 s  0.4%    mean over orbit  5.3%

So the judges were right, and righter than the number they were given: the frame they scored is
**82.8% bare room**, not 53%. It is a small track on a big table in an empty box with no
skirting, no furniture and no story — `shots/oldpose-mask.png`. And it is a frame no player has
ever seen. The reposed review frame is `shots/newpose-mask.png`; the backdrop a player really
gets is `shots/orbit-strip.png`.

Two lessons, and the second is the expensive one:

1. **Measure what you mean.** "Hide it and diff" answers *what does this object affect*, which
   is not *where is this object on screen*. A flat-colour mask answers the second question and
   costs ten lines.
2. **This is the fifth harness fault of the same shape** — after a race that had already stopped
   (rounds 1-2), shadows that were a coin flip (through round 5), a DOM HUD that cannot appear
   in a capture (round 6), and a camera nobody occupies (round 7). The pattern never varies:
   the harness produces a number or a frame the game never shows, and judging then weights it as
   fact. Before a round: ask what the harness cannot show, and ask whether the instrument
   measures the thing its name claims.

## D40 — tyre smoke is authored against a slip range the car cannot reach — MINOR — OPEN BY DESIGN (dial ships at 0; the look is a human call)

Effects has been the lowest-scoring category for three rounds (3.5 in round 7). The working
theory was "a broken emitter — every fx system renders count 1." **That theory was wrong twice
over,** and the way it was wrong is the finding.

**Not "count 1".** That number was a scene-traversal reading one InstancedMesh per kind, not an
instance count. `MG.particles.info()` at t = 12 reports 651 live particles across 11 draw calls.

**Not a render bug either.** Forcing 240 particles at the player's contact patches and stepping
36 frames draws a full, soft, correctly-lit plume (`shots/fx-forced-smoke2.png`). The pipeline
works. (The first attempt at this test showed nothing and nearly became a third wrong theory:
particles emitted and captured in the SAME frame have `age = 0`, and `aTime.x` is Float32 while
`uTime` is Float64, so `uTime - birth` rounds negative and the `u < 0.0` branch discards them.
A real one-frame flicker on every spawn, and a reminder to let a probe's subject actually exist
before photographing it.)

**The real cause is a signal that never leaves its floor.** `Tires.js` publishes `w.smoke`, and
`fx/Particles.js:1669` is its only consumer — where it multiplies FOUR authored curves: emission
rate (`smokeRate: 46`, commented *"particles/s at full slip"*), sprite scale, opacity and
lifetime. Measured over 13 241 grounded wheel-samples of ordinary racing (8 cars, kitchen,
t = 12..25 s):

    w.smoke     p50 0.048   p90 0.126   p99 0.303   max 0.535
    scrub       56% below 5 u/s, 87% below 15 u/s   vs  smokeStart 13, smokeFull 74
    slip power  p95 1735, p99 3822                  vs  heatPowerRef 5200

`smokeFull = 74` sits at roughly the 99.7th percentile of scrub — a once-a-race event — and the
slip pathway is then multiplied by a flat `0.45`, so `w.smoke` is hard-capped below half scale
no matter what the driver does. At the median of 0.048 all four curves sit on their floor: rate
2.3/s per wheel against an authored 46, scale 0.75 of a range to 1.34, opacity 0.58 of a range
to 1.2, life 0.83 s of a range to 1.35 s. That is why a car at the limit lays down single-digit
particles nobody can see.

**`?smokeGain=N`** lerps the calibration from shipped (0) to one scaled against what the game
measurably produces (1): `smokeStart 13->11`, `smokeFull 74->34`, `heatPowerRef 5200->1500`,
slip cap `0.45->1.0`. Four points captured from ONE build at ONE pinned moment (t = 20.008,
seed 7, identical physics — smoke is a pure output channel, so the cars drive the same line in
all four):

    gain   smoke p50/p90/p99   tyreSmoke spawned   verdict
    0.00   0.048 0.126 0.303          558          the shipped bug: a wisp, easy to miss
    0.25   0.059 0.156 0.426          747          readable plumes, cars still legible
    0.50   0.075 0.200 0.602        1 032          three cars washed out
    1.00   0.165 0.429 1.000        2 215          a fog bank; the field disappears

Contact sheet: `shots/smoke-ladder.png`. **Full recalibration is wrong** — the channel reaching
its authored range means the authored range itself is too strong for a miniature at this camera
height, and the opacity curve topping out at 1.2 buries the field. Default left at 0 pending a
human verdict; the dial and the measurement ship, the look does not.

## D41 — the scale cues are everywhere; the macro camera's focus erases them — MINOR — OPEN BY DESIGN (left as a question; the look is a human call)

Judge C, round 7: the car reads as a **full-size** car, unambiguously. The planned fix was
"put one household object in the macro frame for scale." Measured before building it, and the
premise was wrong for the third time this session.

**The objects are already there, and they are everywhere.** The kitchen carries 91 sugar cubes,
213 cornflakes, 18 coins, 15 bottle caps, 15 egg shells, plus mugs, toast, cutlery, jam jars,
cereal boxes and pencils. Distance from the racing line to the nearest prop whose real-world
size a viewer knows on sight, sampled at 200 points around the lap:

    p10 23.7    p25 26.1    p50 29.2    p75 33.0    p90 35.5    max 41.0

The road's half-width is about 15, so **there is a sugar cube, coin or bottle cap within one to
two car-lengths of the road at every point of the circuit.** 195 of 200 samples have one inside
40 units. Nothing needs adding.

**What erases them is the depth of field.** Same frame, same instant, one variable at a time:

    shipped (band + depth)        the cube is a grey smudge, the flake an anonymous blob
    depth term only               still a smudge
    screen band only              gone into the ramp
    tilt-shift off entirely       a crisp, faceted SUGAR CUBE with a specular hit,
                                  a cornflake that reads as cereal, and wood that reads
                                  as a table rather than as tarmac

`shots/macro-dof-decomp.png`. Both terms contribute and neither alone accounts for it. The
mechanism is plain in the uniforms: at the macro pose the camera sits 28 units from the car,
`uFocusDepth` is 28.4 and `uFarSpan` is 45.5, so everything past ~74 units is going soft — and
the nearest cube is beyond that.

**But this is a macro-camera problem, not a gameplay problem.** At the chase pose `uFocusDepth`
is 135 with a 52-unit far span, and the A/B (`shots/chase-dof-ab.png`) shows the sugar cubes,
flakes and bottle caps in the mid-field surviving the blur and reading as what they are. The
camera a player actually looks at keeps its scale cues; the review's close-up does not.

So the tension is real but narrow: **tilt-shift asserts "miniature" by imitation, while a sugar
cube proves it by evidence, and at 28 units the imitation eats the evidence.** Three ways to
resolve it, none taken yet:

- extend the focus rule that now holds the road ahead sharp so it also holds any legible scale
  prop within reach of the subject — it is the same machinery, and it only widens the band where
  such a prop exists, so it costs nothing elsewhere;
- widen `uFarSpan` at close focus distances only;
- accept it. A real macro photograph of a die-cast car has exactly this shallow focus, and the
  review set already carries a chase frame and an establishing frame where the scale reads.

Left as a question rather than a change, because it is a look and this project's rule is that a
look is decided from frames by a human, not from a rationale by me.

## D42 — the contact shadow is drawn, placed and blended correctly, and hidden under the car — MAJOR — FIXED (d3d54ef shipped the tuned pair; then see D53)

Both round-7 judges said the car floats, and the working note said the system "changes 0.05% of
the macro frame at 13 luma — on, in the scene, 264 instances, doing effectively nothing." That
number was roughly right. The explanation for it took four wrong theories to reach.

**Ruled out, one at a time:**

- *Buried below the surface.* Against the wheels' own `contactY` — ground truth from the physics
  rather than a terrain query — the blobs sit 0.05 to 0.35 above the contact patch on seven of
  eight cars and −0.01 on the eighth. Exactly as designed. (An earlier reading looked like
  burial only because it compared against `track.surfacePoint`, which is a different quantity.
  The `CONTACT_SINK_MAX` guard added earlier does work: it was written when 221 of 264 blobs
  really were under the table.)
- *The multiply blend not reaching the framebuffer.* Setting `uTint` to pure black — the
  strongest multiply there is — moved the frame by 12 luma against the normal tint's 11. That
  looked damning, and it was a red herring; see below.
- *`aParams` not arriving.* A probe painting the varying showed darkness and core arriving
  correctly.
- *The uv varying broken.* A probe painting `uv` showed a clean gradient across every quad.

**What is actually happening.** The blob is a soft ellipse whose density lives inside
`d < core * 1.15`. `Lighting._autoContactEntry` sizes a car's blob at `length * 1.75` and
`width * 2.30` with a comment stating that the plateau edge then "lands just outside the tyre
line on both axes" — a measured pair. But `VehicleVisual._buildContactShadow` registers
explicitly, an explicit registration SUPPRESSES the automatic one, and it asks for
`length * 1.28` and `width * 1.68`. **The tuned numbers have never once been used.** At the
narrower size the dense plateau is entirely underneath the car, occluded by the very object it
exists to ground, and the only part a camera above can see is the faintest rim of the penumbra.
That is also why the black-tint probe did nothing: the visible rim has `a` near zero, so `mix(
white, tint, a )` stays white whatever the tint is.

Measured at the chase pose against blobs-off, film grain zeroed, control 0.000%:

    shipped   length x1.28  width x1.68  lean 0.0    0.185% of frame   mean  5.1 luma   max 17
    mid       length x1.51  width x1.98  lean 0.3    2.190%            mean 11.5        max 38
    tuned     length x1.75  width x2.30  lean 0.6    3.903%            mean 16.7        max 69

**Twenty-one times the area and three times the intensity, for a 37% wider quad.** Ladder at
`shots/contact-ladder-chase.png`. `?contactHalo=N` lerps between the two, default 0, so both
render from one build at one moment.

Note the ladder moves size and `groundLean` together, because the tuned configuration is a
package rather than a single number. The size is what does the work: an earlier probe that moved
only the density profile (`core` 0.50 -> 0.92) took the macro frame from 0.113% to 3.628%
without touching the quad at all.

**Two instrument notes, both of which cost a wrong conclusion:**

1. A probe material with `transparent: false` rendered NOTHING. A non-transparent material goes
   in the opaque queue, where `renderOrder: -5` puts it before the ground, which then paints over
   it. That is exactly the mechanism proposed and "disproved" in round 7 — it is real, it simply
   does not apply to the shipped material, which is transparent.
2. Writing directly into `contact.params.array` changed nothing, because `_updateContactShadows`
   rewrites every param slot from the entries on each update. **Edit the entry, not the buffer.**

## D43 — the bokeh was square because the blur was separable, which cannot be round — MAJOR — FIXED (`?dofKernel`, default `half`)

Round 7, judge A and judge C independently, at 6-8x: "hard axis-aligned rectangles", "a
stair-stepped hexagon with vertical stripe banding". The player, unprompted and in his own
words: "you can see blur lines / borders. Maybe the blur should be a gradient."

Three observers, one artefact, and the cause is structural rather than a tuning slip. The
tilt-shift blur was **separable** — a horizontal pass then a vertical one — and a separable
blur's 2D kernel is the outer product of its 1D kernel with itself, `k(x) * k(y)`. A flat-top
1D profile with a hard rim therefore produces a SQUARE with slightly rounded corners. No value
of any parameter makes that round. The kernel's own comment said it "converges on a squircle
rather than the pointy Gaussian profile that turns bokeh into mush", which is true, and beside
the point: a squircle is square enough that every out-of-focus highlight reads as a box.

**Replaced with a real aperture.** A golden-angle spiral over the disc, `r = sqrt((i+0.5)/N)`
so the taps sample area evenly instead of piling at the centre, rotated by a per-pixel spatial
hash so the spiral does not settle into fixed arms. Everything else is carried over unchanged:
the flat-top rim profile (now radial, so it describes the aperture instead of one axis of it),
the scatter-as-gather CoC guard, and the saturating highlight weighting.

**Gathered at half resolution and composited back by CoC.** Everything the gather produces is
by definition out of focus, so resolving it at full rate is work thrown away. The composite
mixes by CoC rather than replacing, so the in-focus band keeps its full-resolution pixels
exactly, and the mix ramps over the first pixel of radius so the band edge stays a gradient
rather than a seam.

Sample budget, per tier — separable took `2 * (2T+1)` samples at EVERY pixel; the disc takes
`3 * (2T+1)` at a quarter of them:

    tier      T     separable          disc         samples per full-res pixel
    low       5     22 at every px     33 at 1/4     22  ->  8.3
    medium    8     34                 51            34  -> 12.8
    high     11     46                 69            46  -> 17.3
    ultra    13     54                 81            54  -> 20.3

**A cost claim I am NOT making.** This was supposed to be settled with
`EXT_disjoint_timer_query_webgl2` rather than arithmetic. The first round of measurements gave
a consistent ordering three times over (square < half-res disc < full-res disc); the second,
with a DOF-off baseline, drifted so badly under thermal throttling that the baseline came out
**slower than the square kernel**, and a third of the queries never resolved. CPU-side
`performance.now()` around `renderFrame` was worse still: five identical blocks read 1.1, 34.7,
51.5, 59.1 and 58.2 ms. The noise floor exceeded the signal, so the cost statement above rests
on sample counts and pass structure, which are exactly knowable, and the wall-clock effect
wants checking on real hardware.

Tap count chosen from frames: `shots/bokeh-4way.png` ladders 40 / 54 / 80 taps against the
square. Every disc variant is plainly round where the square one is plainly square, and the
residual spiral speckle falls off sharply between 54 and 80. At the shipping grain setting
(`shots/bokeh-ship.png`) the speckle is not separable from the film grain, while the square
highlight is glaring.

`?dofKernel=square|full|half` renders all three from one build. Default `half`.

## D44 — the drawing buffer compounded to 33 megapixels whenever the canvas measured zero — CRITICAL — FIXED

Found during the itch.io pre-flight, and it is exactly the kind of thing that pre-flight is for.

`Engine.measure()` resolved the canvas size as:

    w = canvas.clientWidth || canvas.width || 0;

`clientWidth` is a CSS measurement. **`canvas.width` is the DRAWING BUFFER**, already multiplied
by the pixel ratio. Feeding it back in as a CSS size multiplies by the ratio again, every time:
1600 -> 3200 -> 6400. Measured in a hidden browser pane, where `clientWidth` reads 0, the buffer
had compounded to **7680 x 4320 — 33.18 megapixels, sixteen times a 1080p frame** — against an
ultra budget of 4.4 Mpx.

The budget never fired because `_flushResize` set `Settings.render.pixelRatio` straight onto the
renderer instead of going through `resizeRenderer`, which is where `computePixelRatio` and the
tier's `maxPixels` ceiling live. So the cap was enforced on one resize path and advisory on the
other.

**Not a lab-only case.** A browser game on itch.io boots inside an iframe that is commonly
zero-sized or `display: none` until the player clicks the splash — precisely the state that
triggers it.

Fixed by falling back to `getBoundingClientRect()` and then `innerWidth`, never to the drawing
buffer, and by routing `_flushResize` through `resizeRenderer`. After six consecutive
`measure()` calls at a zero client size:

    before   7680 x 4320   33.18 Mpx   and still growing
    after    2347 x 1320    3.10 Mpx   exactly the "high" tier budget, stable

**A 10.7x reduction in fill**, and it retroactively explains why the GPU timings taken while
choosing the bokeh kernel would not hold still: they were measured at 33 megapixels.

Budget verified across every tier and CSS size — low 1.15, medium 2.10, high 3.10, ultra 4.40
Mpx, each respected. One deliberate exception: `computePixelRatio` floors the ratio at 0.5, so
`low` at a 4K CSS size lands at 2.07 Mpx rather than 1.15. That floor is intentional; below it
the image stops being legible.

## itch.io pre-flight

Done, except the parts that are a human's to do.

- **Boots from a plain static file server.** No `server.js`, no build step. 34 modules loaded,
  0 failed, 0 warnings, straight to the menu. The dev server's only job is the `/__shot`
  endpoint the capture tools POST to, and nothing in the game touches it.
- **three.js licence now ships.** r180 is vendored with an SPDX header on the two build files
  but no licence text, and the `examples/jsm` modules carry no header at all. MIT requires the
  full text to accompany any redistribution, so `vendor/three/LICENSE` was added at the root of
  the vendored tree, with `CREDITS.md` explaining what is vendored and why the licence sits
  where it does.
- **Everything else is generated at runtime** — textures baked procedurally, car bodies and
  props built from primitives, audio synthesised, type from the system stack. No imported
  models, no photographic textures, no sample libraries, no downloaded fonts. One third-party
  licence to honour, total.
- **Page furniture**: title, an inline-SVG favicon (no external request, no asset pipeline),
  description, `theme-color`, OG tags.
- **The build is 4.8 MB unpacked, ~1.25 MB zipped, 95 files, `index.html` at the archive root**
  — which is what itch's "play in browser" upload expects. Against itch's limits this is
  nothing. (This line said *122 files* until 27 Aug 2026. 122 is the number of zip *entries*;
  27 of them are directories. Caught by diffing a fresh staging tree against the uploaded
  archive and finding 95 on both sides — the count was never wrong about the build, only
  about what it was counting.)

Left for a human, because publishing is not mine to do: create the page, upload the zip, tick
"this file will be played in the browser", choose the viewport size, write the description and
draw a cover image.


---

## D45 — Four of the five circuits have never been looked at, and two of them read as broken — MAJOR — **MITIGATED, NOT FIXED** (0948409)

**Found while answering "are we ready to publish?", which is the only question that
would have found it.** Every defect in this file above D45 was found by pointing an
instrument at `kitchen`. Every fix was shipped into `kitchen`. Meanwhile
`Menu.js:43` reads:

```js
const TRACK_IDS = ['kitchen', 'pool', 'garden', 'bedroom', 'workbench'];
```

and the title screen offers a five-round championship across all of them. A player
who clicks past Quick Race sees four circuits that no critic round has ever scored.

**Line count is not a review.** The first thing I reached for was a count —
kitchen.js is 423 lines, the rest are 207–228 — and it says nothing, because a track
file's length does not predict whether the thing renders as a place. Mesh, prop and
triangle counts are flat across all five (317–340 meshes, 704k–867k tris). The
circuits are the same *size*. They are not the same *quality*, and only a frame
shows that. LOOK AT THE FRAME BEFORE BELIEVING AN AGGREGATE, again.

`tools/track-tour.js` shoots one frame per circuit at the same pin (t = 16.01 s),
through the director's own camera, with the liveness guard from `capture-set.js`
attached. Verdicts:

| circuit | reviewed | verdict | what the frame shows |
|---|---|---|---|
| kitchen | yes, every round | ship | the room, the props, the fixes. Still carries D23. |
| bedroom | never | ship | best frame in the game. Opaque plank road, convincing carpet. |
| garden  | never | fixable | best road surface in the game; exposure far too low; two cars stopped on the grass mid-race |
| pool    | never | hold | flat green to every edge — no rim, no cushion. **This is D12 unfixed on this track.** |
| workbench | never | hold | magenta cast, blown bloom on the racing line, road invisible against the bench |

**D12 is not fixed. It was fixed on one track.** "There is no room, the table runs
to the horizon" is marked FIXED above. Pool has exactly that defect today, untouched.
The same is true of every environment fix in this file — they are kitchen fixes
wearing a project-wide status.

**Bedroom answers D23 for free.** D23 is "the road does not read as a road", open
since round 4 and agreed on by four judges. Kitchen's road is a translucent wash: the
oak grain reads straight through it, so it looks like a stain on the table. Bedroom's
road is an *opaque plank* laid on the carpet, and it reads as a road immediately.
Garden's gravel does the same. The fix for D23 is already shipping in two files;
kitchen is the one that does it differently.

**Not fixed here, deliberately.** Two of these are art passes on circuits nobody has
scoped, and one of them (workbench) may be a light rig fault rather than an art gap.
The publishable move is to cut the circuit list, not to open two unreviewed tracks
under time pressure.

**What shipped (0948409), and why this is MITIGATED rather than FIXED.** `SHIPPED_TRACKS`
in `Race.js` is now the single roster and everything that enumerates circuits reads it.
Kitchen and bedroom ship; pool, garden and workbench are hidden, not deleted, and
`?track=pool` still boots so the next round of work on them can be shot.

The defect underneath is untouched, and it is the one sentence in this file most worth
re-reading: **every fix above is a kitchen fix wearing a project-wide status.** Bedroom
now ships and has never been through a critic round. Pool still has D12. The roster cut
bought time; it did not buy a second reviewed circuit.

---

## D46 — Nothing tells a new player how to drive — MAJOR — **FIXED** (0948409)

The title screen's footer reads `↑↓ Navigate · ENTER Select · ESC Back`. That is how
to work the *menu*. The driving controls — W/A/S/D, SHIFT boost, SPACE handbrake, R
respawn — exist only in Options → Controls, three screens deep.

This is a defect specifically *because* of how the game is about to be distributed.
On a desktop build the player has a manual and a store page. Embedded in an itch.io
iframe they have a canvas and nothing else. A player who never finds SHIFT reports
that the cars feel slow, and that report is worthless — it measures the menu, not the
handling. Every piece of first-play feedback is filtered through this.

Cheapest honest fix: a controls card on the title screen, and the same four keys on
the grid during the countdown, where the player is already waiting and looking.

---

## D47 — The menu was a hiss generator, running at twice the level of the music — MAJOR — FIXED

Reported as "it's a bit disturbing, lot of white noise in menu". That is a report
about a *spectrum*, and a spectrum is measurable — so before changing anything I
built `tools/audio-probe.js`, which taps the real buses with `AnalyserNode`s while
the master gain is pinned to zero. It refuses to run unless `master.gain.value` is
0. Every audio session on this project so far has ended with somebody hearing
something they did not ask for, and an instrument that can make noise is not one
worth having.

On the menu:

| bus | flatness | centroid | rolloff85 | rms |
|---|---|---|---|---|
| ambience | **0.750** | **10 096 Hz** | 16 869 Hz | 3.54e-5 |
| music | 0.003 | 545 Hz | 879 Hz | 1.81e-5 |

Flatness is the Wiener entropy — the geometric mean of the power spectrum over its
arithmetic mean. 1.0 is white noise, 0 is a pure tone. **0.75 with its energy centred
at 10 kHz is hiss**, and it was running at roughly *twice the level of the music it
was sitting on top of*. The player's word for it was exactly right.

The cause is one line. The ambience `air` layer was a **highpass** on white noise:

```js
this.ambAirHp.type = 'highpass';   // airHz .. Nyquist
```

White noise carries equal energy *per hertz*. A highpass at 3.4 kHz therefore hands
you the 3.4 k–20 k band — about **eight times the bandwidth** of everything below it —
so the layer intended as "a bit of room air" owned the entire spectrum. The gain
number in the table looked modest precisely because nobody had asked how much
bandwidth it was buying.

Fixed three ways: `air` is now a **band** (`AIR_TOP_MULT = 2.5`, about 1.3 octaves)
rather than a highpass; the gains are cut hard across every theme; and the whole bed
ducks by `MENU_AMBIENCE_DUCK = 0.45` outside a race, wired through a new
`Sfx.setMenu()` off the existing `race:state` handler. The menu and the results
table are where a bed is most exposed — no engines, nothing competing — and they are
where the player sits reading rather than racing.

Measured after, same instrument, same page:

| bus | flatness | centroid | rolloff85 | rms |
|---|---|---|---|---|
| ambience | 0.750 → **0.273** | 10 096 → **3 761 Hz** | 16 869 → 8 016 Hz | 3.54e-5 → **5.25e-6** |
| music | 0.002 | 520 Hz | 879 Hz | 2.16e-5 |

Ambience went from **2×** the music to **0.24×** it — 16.6 dB down — and the tail that
owned the spectrum is gone.

**The race keeps its room.** Checked, because a fix that silences the menu by
gutting the ambience everywhere is not a fix. Unducked during a race at t = 18.8 s:
engine 1.72e-4, sfx 1.05e-4, music 2.07e-5, ambience 1.87e-5. The ambience is now
the quietest thing on the track, which is where it belongs.

**An instrument bug found on the way, and fixed.** The probe reported the music bus
at `flatness: 6420`. A Wiener entropy above 1.0 is not a finding, it is impossible —
on a near-silent bus the `EPS` floor becomes the whole arithmetic mean and the ratio
runs away. It now reports `silent: true` instead of a number.

**And a defect I nearly filed and did not.** That silent music bus read as "the music
does not play during a race". It was my own instrument: I had force-stepped the race
clock 12 s ahead of the AudioContext clock, so every note was scheduled in the past.
Stepped in real time instead, the music bus measures 2.07e-5 and plays fine. MEASURE
WHAT YOU MEAN — and when the measurement accuses the game, check the ruler first.

---

## D48 — The game starts playing at a stranger before they touch it — MAJOR — FIXED

The user has now reported unexpected sound **four times** across two sessions. Each
time I treated it as a mistake in how I was driving the page. It was a defect in the
game.

`Audio.unlock()` opened the whole graph whenever it found the AudioContext already
running:

```js
if (this.ac.state === 'running') { this._afterUnlock(); return Promise.resolve(true); }
```

The reasoning was sound and the conclusion was wrong. A running context normally
*does* mean the browser has satisfied itself that a person is present — the browser's
autoplay gate was doing this job, and the code was leaning on it without saying so.
**An itch.io embed carries `allow="autoplay"`.** The context is running from the first
millisecond, the gate is gone, and the page starts playing at whoever loaded it.

Reproduced directly: a fresh boot with no input of any kind reached `unlocked: true`
with the ambience bus producing signal.

Fixed by putting the gate where it cannot be removed by an embedder — a `_gestured`
flag set only from a **trusted** `pointerdown`/`mousedown`/`touchstart`/`keydown`.
`unlock()` refuses until then. `opts.force` exists for tooling that has already
pinned master to 0. `isTrusted` matters: a script on the embedding site firing a
synthetic click is not somebody deciding to play.

Verified both halves on a real boot, muted:

- **No interaction** — `unlocked: false`, `_started` never set, and all four buses
  measure `silent: true`, despite `ac.state === 'running'`.
- **One real click** — `gestured: true`, `started: true`, ambience 7.45e-6 and music
  1.58e-5, both playing.

This is the fix that matters more than D47. Enabling click-to-launch in itch's embed
options is still worth doing, but the game no longer depends on it: it is now silent
until invited, wherever it is hosted.

**Also added `?mute=1`** (`src/main.js`), which seeds a muted bus before the audio
system builds. Every audio measurement in this project now runs behind it. The
previous approach — seeding a muted setting into `localStorage` — worked right up
until the page was a third-party iframe, where Chrome's storage partitioning meant
the seed never reached it. A URL flag travels with the page.

---

## D23b — The road does not read as a road: the second pass — MAJOR — FIXED (the road was made of the table)

Open since round 4, agreed on by four independent judges, and survivor of two failed
attempts. The answer was in the configuration the whole time:

| circuit | road `surface` | `groundSurface` | |
|---|---|---|---|
| kitchen | `varnishedWood` | `oak` | both `category: 'wood'` |
| bedroom | `laminate` | `carpet` | hard on soft |

Kitchen's road is a varnish over oak and its table is oak. Same projection, same kind of
texture, so the grain, the knots and the plank joints run through the road edge unbroken.
`TrackBuilder`'s own header says so out loud, as a design intent rather than a defect:

> A world projection is what "the road is a piece of the table" actually means — the grain
> runs straight and the road crosses the joints instead of carrying them along with it.

The code does exactly what it says. What it says is the defect. And it explains why every
attempt to close this with *contrast* failed: there is 58 luma of road-vs-table separation at
the shipping camera (D23 re-measurement) and it is not enough, because the eye is not reading
brightness here, it is reading whether one surface stops and another begins.

**Measured, with a new instrument.** `tools/grain-probe.js` takes a patch wholly inside the
road and a patch wholly on the table, builds a gradient-orientation histogram over each, and
reports the angle between them. 0 deg means the road is made of the table. Six points around
the kitchen lap, before and after:

    t         0.03    0.05    0.2325   0.55    0.75    0.95      mean*
    before    0.23    6.26     6.43    3.36    0.68    0.99      2.34 deg
    after    33.44     --     31.93   36.62   27.62   26.89     31.30 deg
    * over the five points where both readings are valid

**At t = 0.75 and t = 0.95 the road's grain was within one degree of the table's.** Not
similar to it. The same board.

**The fix is a rotation, not a reprojection.** `ROAD_GRAIN_DEFAULT` turns the ROAD's world XZ
projection 35 deg against the ground's. It is still a world planar projection, so everything
the header defends is intact — the grain runs dead straight, the hairpin cannot drag it round,
no board bends. It simply stops being the *same* board. Ribbon-space UVs, which is what was
tried and reverted before, are still ruled out and still for the reason recorded.

**Per track, not global.** `{ kitchen: 35 }`. Bedroom is the best-looking circuit in the game
and does not have this defect — a plank on a carpet cannot be mistaken for more carpet — so it
keeps 0 and is left alone. `?roadGrain=N` overrides for capture.

**Verified as a change confined to the road.** Within one session, cross-boot noise floor
0.102% of pixels / 0.012 mean luma. Kitchen at 0 vs 35 differs by **21.05% / 3.41 mean luma**,
and the difference image is the road corridor and nothing else. Bedroom moved no more than a
null-change kitchen did (see D49).

**Two instrument faults found and fixed on the way, both of the same family.**

1. The first run reported the road at concentration 0.17 against the table's 0.62 and called
   it a 21.6 deg separation. It was measuring the **painted lane markings** — straight, bright,
   aligned to the circuit. Markings, kerbs, cars and props are separate meshes; only
   `track:road` and `track:ground` are visible to the probe now.
2. The table's contrast — which nothing under test can affect — flipped between 11.64 and
   42.53 depending on what had been rendered before. That was a **prop's shadow** falling
   across the patch in some runs. Shadows are off for the measurement. A shadow edge is a
   long straight high-contrast oriented gradient, which is to say it is exactly the thing
   being measured, arriving from somewhere else.

**And one result refused rather than reported.** At t = 0.05 the 35 deg setting appeared to
make things *worse* — separation 3.19 against a 6.26 baseline — contradicting every
neighbouring sample. The road patch there measured concentration **0.13** against 0.42-0.60 at
t = 0.03 / 0.07 / 0.09, with the highest contrast of the four: something bright and undirected
sits on that patch, near the start line. An angle taken from a patch with no direction is
noise with a decimal point on it. The probe now returns `undirected: true` and no angle below
a concentration of 0.25, and that point is excluded from the mean above rather than argued
away. Same shape as the audio probe's impossible `flatness: 6420` in D47.

**Not claimed: the grazing-angle case.** `Surfaces.js` warns at length that `varnishedWood` is
"the most dangerous material in the game" at grazing incidence. Both low-camera pins available
(`store-shots.js` at 7 s and 18 s) land on the milk spill and the ceramic tile span
respectively, so neither actually shows varnished wood at a shallow angle. No artefact appeared
at any rung in any frame taken, and that is a weaker statement than "there is none".

**Still missing from the four-judge brief**, unchanged by this: twin wheel ruts at wheel-track
spacing, braking smears before corners, scuff arcs, debris swept off the driven line, and a
corridor edge where kerbs are absent. Those remain the D23 implementation plan's work. This
fixes the one thing that plan did not identify, because it was in the config rather than in
the markings.

---

## D49 — Frames from different sessions are not comparable, and nobody knew — CRITICAL (method) — **FIXED**

Found while checking that the D23 fix had not regressed bedroom, a circuit it does not touch.

    bedroom, yesterday vs today          57.83% of pixels changed, 6.03 mean luma
    kitchen, yesterday vs today          57.85% of pixels changed, 7.93 mean luma
      ...with today's kitchen captured at ?roadGrain=0, which is byte-identical behaviour
    kitchen, today vs today, two boots    0.102% of pixels changed, 0.012 mean luma
    bedroom, today vs today, two boots    0.104% of pixels changed, 0.015 mean luma

**Within a session the capture is reproducible to a tenth of a percent. Across sessions it
moves by 58% of the frame.** Both tracks by the same amount, on identical code.

`git log` since the earlier captures: **no commit touched `src/textures/`, `src/world/` or
`src/render/`.** The rendering code is the same code.

**Where the difference is.** The difference image is unambiguous: the road corridor, the kerbs,
the cars and every prop are black — bit-identical — and the entire difference is the *table's
wood grain*, a fine texture-following pattern across the whole slab.

**What is known about the state.** The canvas reports `clientWidth/clientHeight = 0` — D44's
condition — and the renderer is at `pixelRatio 1.748`, drawing buffer 2796x1573 = 4.40 Mpx.
That is the ultra tier's budget, so D44's clamp is working; it is simply not landing on the
same number it landed on before (D44 recorded 2347x1320 = 3.10 Mpx under the same zero-size
condition). The ground material's map is 1024x1024 at anisotropy 16, max anisotropy 16.

**The cause is NOT identified, and is deliberately not guessed at here.** A capture renders at
a pinned 3840x2160 regardless of the live drawing buffer, which is exactly what should make
mip and anisotropy selection reproducible, so "different render resolution" does not on its own
explain a difference confined to one material. Writing a plausible mechanism into this file is
how D31's cause got asserted and then retracted.

**Why this is CRITICAL and why it is method rather than art.** This project's entire practice
is comparing frames. Several conclusions in this file rest on a cross-session before/after —
including "the reverted build matches the pre-feature capture to the noise floor (0.14%
against a 0.13% floor)" in D23's first attempt, a number that cannot have been measured the way
this one was. **Any conclusion in this file that rests on a cross-session pixel diff is now
suspect** and should be re-derived from same-session captures before being relied on.

**The rule that follows immediately, whatever the cause turns out to be:** a before/after
pixel diff is only valid when both frames come from the same session, and the session's own
cross-boot floor is measured and quoted alongside it. The D23 numbers above were taken that
way. Nothing else in this session's work depends on a cross-session diff.


### D49 — the answer

**There was no regression. The instrument was measuring itself.**

Cross-boot reproducibility, same build, pinned to the same simulated moment (engine frame
1921, raceTime 16.0083 s, all 8 cars moving, speeds identical to three decimals across both
boots — the simulation itself is deterministic):

    two boots, three disciplines applied      0.068% of pixels, mean delta 0.107
    the number that raised the alarm         57.85% of pixels

Three things had to be true at once, and none of them were:

**1. ZERO THE GRAIN BEFORE A FRAME-DIFF.** This project's oldest instrument rule, written down
after `room-share.js` learned it, and I ignored it for most of this investigation. Film grain
reseeds every frame. Measured here: **two captures of a FROZEN scene, engine held paused,
nothing whatsoever changed, differ by 23.8% of pixels.** That is the real explanation for the
57.85%. It is not a small effect and it is not subtle once measured — it was simply never
measured, because the 0.102% "same-session floor" in the table above had been taken under
different conditions from the 57.85%. *A floor measured one way does not license a diff
measured another way.* That is the whole defect.

**2. HOLD THE ENGINE ACROSS THE PAIR, not just inside each capture.** `MG.capture` pauses on
entry and resumes on exit — correct for one frame, useless for two. Between two calls the race
runs on, the cars move, the camera follows. Measured: **two consecutive captures of the "same"
moment, 23.7% of pixels apart.** An earlier version of `tools/draft-ab.js` reported 28.0% for
the thing it was actually testing, and nearly all of that was the race advancing. It was
one step from being filed.

**3. SETTLE THE TEXTURE FOUNDRY.** See D50. Worth 2.49% of pixels — real, and two orders of
magnitude smaller than the noise it was hiding behind.

With all three applied, two captures of one held moment are **bit-identical: 0.000% of pixels,
max channel delta 0.** That is a floor worth having, and it is what makes the 0.068% cross-boot
figure meaningful.

**Consequences for this file.** The retraction in D49's original entry stands but narrows: it
is not that cross-session diffs are impossible, it is that **every diff in this file taken with
film grain live is noise**, whatever session it came from. Conclusions resting on a diff whose
quoted floor is around a tenth of a percent were measured with grain off and are fine.
Conclusions resting on a diff in the tens of percent, with no floor quoted, mean nothing.

**What was wrong in my own reasoning, since it is the same mistake twice.** I found a real
mechanism (D50), measured it at 28.0%, and it matched the shape of the defect closely enough
that I nearly stopped. It survived only because a floor measurement I took as a formality came
back at 23.8% and killed my own result. LOOK AT THE FRAME BEFORE BELIEVING AN AGGREGATE has a
sibling: **measure the floor before believing the difference, in the same run, with the same
instrument.**

New tools: `tools/pin-shot.js` (a reproducible pinned capture that enforces all three and
reports the liveness of the field), `tools/frame-diff.js` (a diff that will not report a ratio
without stating the floor beside it), `tools/draft-ab.js` (the D50 experiment, which now
measures its own floor as a third frame).

---

## D50 — Nothing in the game ever forced a texture to full resolution — MAJOR — **FIXED**

Found while hunting D49. Not the cause of it, but a real defect underneath.

Every surface in the game is handed out as a **draft**: a 256 bake magnified into the final
texture, sharpened later on an idle queue. That design is sound. What was missing is that
**nothing ever opted out of it**:

* `Surfaces.warm()` — "bake a list of surfaces to full resolution" — **has no callers anywhere
  in `src/`.**
* No code in `src/` has ever passed `immediate: true`.
* `Surfaces.ensure(kind)` — documented as "force one surface to full resolution right now
  (blocking)" — **was a silent no-op in the exact case it exists for.** `textures()` returned
  the cache entry before it looked at `immediate`, so calling `ensure` on a kind that was
  already cached as a draft returned the draft, with no way for the caller to tell.

So which surfaces were sharp in any given frame was decided entirely by the browser's idle
scheduler. On a kitchen boot the table — which *is* the frame on a kitchen table — went through
the queue like everything else, behind a sheet of paper and some crumbs.

    draft frame vs settled frame, same boot, same held moment, grain zeroed
      2.492% of pixels, mean delta 1.93, max 54
      against a floor of 0.000% — the same pair, bit-identical

    concentrated in the top two bands (3.11% and 8.81%), which is the far half of
    the table, where texel density is highest and magnification shows worst

**Not measured, and not claimed: how long a real player waits.** The only browser available to
this project runs the game in a hidden pane, where idle callbacks are throttled to roughly
their timeout. Every wall-clock number taken here measures Chrome's background throttle. An
earlier draft of this entry quoted 23.7 s and 40.8 s as if they were player-facing; they are
not, and they have been removed rather than qualified.

**What is established and scheduler-independent:** a bake costs about **292 ms at 1024** and
about **1 s at 2048** (`oak` 292 ms, `varnishedWood` 1006 ms, `pine` 908 ms, `ceramicTile`
1261 ms). That is the real reason the draft system exists, and the real cost of opting out.

**Fixed three ways.**

1. `ensure()` now honours `immediate` on a cache hit, which is what it always claimed to do.
2. `TrackBuilder.resolveMaterials()` bakes the track's **ground and shoulder** surfaces
   blocking, before asking for any material. Kitchen pays 292 ms once during a load and never
   shows a magnified table. The road's own spans stay on the queue — `pine` and `ceramicTile`
   are 2048s at about a second each, and spending two more seconds of boot on them is a
   different trade, not one to make silently. They are moved to the front of the queue instead,
   via a new `Surfaces.prioritise()`.
3. `MG.capture` calls the new `Surfaces.settle()` before reading a pixel, and reports
   `settledDrafts` in its result so a frame can say whether it was measuring the game or the
   scheduler. `?noPrebake=1` puts the defect back so it can still be photographed.

An unintended and welcome side effect: with the ground baked first it claims a 2048 while the
budget is still open, and `ceramicTile` drops to 1024 instead. Total texture memory is
unchanged at 466.3 MB, and it is now spent on the surface that fills the screen rather than on
one span of the lap.

---

## Audit — does anything in this file rest on a grain-live frame diff? — **NO**

D49 established that film grain reseeds every frame, so two captures of a **frozen** scene
come back 23.8% of pixels apart, and one measurement of the same thing read 33%. That
retroactively threatens every percentage-of-pixels conclusion in this file: any claim smaller
than its own noise floor is not a finding, it is the grain.

Swept on 26 Aug 2026, every frame-diff figure in this document. **All of them survive**, by one
of two routes:

| conclusion | figure | what saves it |
|---|---|---|
| D20 — the slab casts nothing | 13.13% vs **0.00%** | 0.00% is unreachable with grain live, and the control sits in the same run |
| D22 — shadow intensity does something | 5.004% vs control **0.013%** | floor taken in the same run, same instrument |
| D25 — the capture set is pinned | 0.02% | measured as the residue *after* pinning, and named as grain (D21) in the text |
| D23 — the ninth atlas row regressed every marking | 7.8% / 17.9% vs floor **0.03%** | floor quoted beside the claim |
| D23 — 35 deg road grain | 21.05% vs floor **0.102%** | two-boot floor in the same session |
| D50 — draft vs settled | 2.492% vs floor **0.000%** | the same pair, bit-identical |
| D19 / D39 / D44 | — | not frame diffs at all; physics and buffer measurements |

So the rule this project earned the hard way — **zero the grain before a frame-diff, and
measure the floor in the same run** — was in fact applied everywhere it mattered, including in
the rounds that predate the rule being written down. The one place it was not, D40's "wrong 3",
is already recorded as a caught mistake rather than as a finding.

This audit is itself a claim, so its method is stated: `grep` for every percentage-of-pixels
figure in the document, then read the surrounding paragraph for a control or floor. A figure
with no floor beside it would have been listed here as void. None were.

---

## D51 — The texture memory budget trims the wrong surfaces, and misses by half — MAJOR — OPEN

    ultra tier budget      320 MB     (Settings.js)
    actually resident      466.3 MB   (kitchen, measured)
    overshoot              1.46x

`targetSize()` decides a kind's resolution by reading `_bytes` — **the bytes already spent at
the moment that kind is first requested.** The set it is about to allocate is not counted, and
nothing is ever revisited. So the trim cannot prevent an overshoot; it can only punish whatever
happens to be requested last.

Which is exactly what it does. Before D50's fix, on kitchen:

    ceramicTile   2048   one span of the lap
    pine          2048   one span of the lap
    oak           1024   the entire table
    rubber         512   the tyres, on screen every frame

The three surfaces that got trimmed to 512 are `plasticMatte`, `plasticGloss` and `rubber` —
not the least important, just the last asked for.

**Not fixed here, because the fix is a policy question rather than a bug.** Making the arithmetic
correct is easy; deciding *which* surfaces deserve a 2048 when the budget will not cover all of
them is a judgement about what the frame is made of, and it should be made deliberately rather
than as a side effect of scene-graph walk order. D50's `prioritise()` gives the ordering hook
that a real policy would need.


## D52 — The critic score cannot tell a reviewed circuit from an unreviewed one — CRITICAL (method) — RESOLVED (the score works; the answer is the worse one)

Bedroom was to get its first critic round. It got one, and the round is about the critic
instead.

Eight critics, one frame each, same brief, shuffled and unlabelled: **four frames of bedroom,
which has never been reviewed, and four of kitchen, which has been through 24 rounds.** The
kitchen half is the control — the critic-round equivalent of the identical-frame pairs that
D28's fix put into every A/B. It had never been run before, because until now a critic round
had no floor at all.

| category | bedroom | kitchen | delta |
|---|---|---|---|
| 1 Materials & texture | 4.50 | 4.50 | 0 |
| 2 Lighting & shadow | 3.75 | 3.75 | 0 |
| 3 Post & grade | 5.25 | 5.75 | −0.5 |
| 4 Geometry & silhouette | 5.00 | 4.50 | +0.5 |
| 5 Effects | 2.75 | 2.25 | +0.5 |
| 6 Composition & camera | 4.75 | 5.00 | −0.25 |
| 8 Environment richness | 3.25 | 3.25 | 0 |
| 9 Cohesion | 4.50 | 4.00 | +0.5 |

Defects raised: **bedroom 49** (8 critical, 31 major, 10 minor), **kitchen 48** (8 critical,
29 major, 11 minor). Per-frame means run 3.75–4.75 on both sides, and the single highest and
single lowest frame in the round are both *kitchen*.

**Not one category clears the ±1.0 floor. All eight are indistinguishable.**

Two readings, and they are both bad:

1. **The absolute critic score has no resolving power.** It returns roughly 4.3/10 and about
   twelve defects for any frame of this project, so every per-round score ever recorded —
   including the "critic rounds 7 · 5.19" on the status page — measured the critic's baseline
   hostility rather than the build.
2. **24 rounds of kitchen work produced no measurable visual gain** over a circuit that has
   had none.

**These are separable, and the test is cheap.** Run the same brief over the deliberately
degraded frames already built for D28's validation (`rounds/d28-mush` — a 320 px round trip,
which six of six comparative judges called worse, unanimously and in both orders). If a
visibly broken frame also scores ≈4.3 with ≈12 defects, reading 1 is proved and the absolute
score is a constant function. If it scores materially lower, the scale works and reading 2 is
the live one. **Not yet run** — the round hit an API session limit.

What is NOT in doubt: the comparative instrument does resolve. In `rounds/d28-mush` the same
class of judge picked the clean frame 6-0 across three cameras and both orders, p=0.031, with
zero false differences on the controls. Whatever is wrong here is specific to scoring one
frame in isolation, not to judging generally.

**The bedroom defect list from this round is not usable as a bedroom defect list.** Its
contents may still be true — several findings are specific and locatable, and the four
"worst problem" answers converge hard on one thing:

- *macro* — the projected light-shaft quads render their own rectangular outlines on the
  track ahead of the front wheel, while the same lamp's core clips to detail-free white
- *chase* — the headlight bloom is a clipped white blob that deletes the front half of the
  only hero object in the frame
- *gameplay* — the car casts no shadow and has no contact darkening, so it floats like a
  decal, while a large blob shadow sits ~250 px away attached to nothing
- *establishing* — nothing in the frame is grounded; no contact shadow or AO anywhere

Three of four independently name the headlights or the missing contact shadow. That
convergence is worth following up **as a lead**, by looking at the frames and the code, not
by citing the scores — the scores are what this defect is about. The `250 px away from the
car` blob shadow in particular is a claim about geometry that can be checked directly.

**Followed up, and it held: see D53.** The claim is true in every part, on both circuits, and
the contact shadow it asks for is already shipped and measurable. That does not settle D52
either way — a lead that survives says the critics can see, not that the score can
discriminate. The `rounds/d28-mush` discriminator is still the test that decides this one.

Round record: `rounds/bedroom-r1`. Harness: `tools/critique-round.js`, which will not build a
round without a control circuit.

---

### Resolved, 28 Aug 2026 — the discriminator ran, and reading 1 is dead

The test was designed at the time this defect was raised and is recorded above: run the same
brief over frames that are *known* to be worse. Built as `rounds/d52-discriminator` —
**test: the three 320 px round-trip "mush" frames; control: the three clean originals**, same
poses, same race moment, same build. One variable, and it is one already proven visible: six
comparative judges in both orders called clean better **6-0 (p=0.031)**, position balanced
3/3, zero false differences across three null pairs (`rounds/d28-mush`).

This is a stronger control than the bedroom round had. Bedroom-vs-kitchen confounded *circuit*
with *review history*; nothing is confounded here.

Six critics, one frame each, blind and shuffled:

| pose | mush | clean | delta | defects m/c | critical m/c |
|---|---|---|---|---|---|
| gameplay | 5.00 | 5.50 | −0.50 | 8 / 6 | 1 / 0 |
| chase | 4.25 | 4.88 | −0.62 | 8 / 8 | 2 / 1 |
| macro | 4.38 | 5.75 | **−1.38** | 8 / 6 | 2 / 1 |
| **overall** | **4.54** | **5.38** | **−0.83** | 24 / 20 | 5 / 2 |

**Mush scored lower in 3 of 3 poses and in 8 of 8 categories** — every single category moved in
the predicted direction, including the four that did not clear the ±1.0 floor. Four did clear
it: Post & grade (−1.33), Materials & texture (−1.00), Lighting & shadow (−1.00), Geometry &
silhouette (−1.00).

**Reading 1 is refuted. The absolute critic score is not a constant function, and nothing on
the scoreboard is void.** The 5.19 stands. Given a genuinely degraded frame the score moves,
consistently, by about eight tenths of a point.

### Which leaves the reading nobody wanted

**24 rounds of kitchen work produced no gain this instrument can see.** Side by side:

| | mean \|delta\| | direction |
|---|---|---|
| mush vs clean | **0.834** | 8 of 8 categories the same way |
| bedroom vs kitchen | 0.281 | 3 up, 3 down, 2 tied |

There is a third possibility and it deserves naming rather than burying: the instrument's
sensitivity floor may simply sit *between* "24 rounds of polish" and "a 320 px round trip" —
working, but too coarse for the differences this loop is trying to produce. That is not
reading 1, and it would be a comfortable place to land.

**The direction data argues against it.** An instrument that is merely too blunt, pointed at a
real difference, should still *lean* the right way even when magnitudes stay under the floor —
exactly as the four sub-floor categories did in the mush round. Bedroom versus kitchen did not
lean at all: three categories favoured the reviewed circuit, three favoured the unreviewed one,
two tied. That is not a small signal under a coarse instrument. That is the shape of no signal.

So the honest statement is the harsher one: the critic round can measure, and what it measures
is that two dozen rounds of review left no mark a blind critic can find.

---

## D53 — The contact shadow is present, measured, and invisible to every critic — MAJOR — OPEN

D52 closed with a lead rather than a finding: three of four bedroom critics named the missing
contact shadow or the headlights as the worst thing in the frame, and one made a checkable
claim about geometry — *"the large blob shadow 250px away at (1050,300) proves shadows are
being cast in this scene, which makes the omission read as a bug rather than a style."*
Checked. Every part of it is true, and the conclusion it points at is the opposite of the
obvious one.

**The blob is there.** Not "should be there" — measured, in the running build, on both
circuits:

| | bedroom (night, sun 0.44) | kitchen (morning, sun 5.91) |
|---|---|---|
| blobs registered / drawn | 264 / 264 | 264 / 264 |
| pool strength | 0.82 | 0.74 |
| `dark` written for a grounded car | 0.82 | 0.74 |
| **all 264 blobs off** | **6.38 %** of frame | **2.21 %** |
| **the 8 car blobs off** | **0.89 %** (33 k px, mean Δ 41) | **0.58 %** (5.3 k px, mean Δ 37) |
| all shadow mapping off | 0.44 % | 1.45 % |
| floor (identical state, twice) | **0.0000 %** | **0.0000 %** |

Blob centroids sit 14–42 px from their car's projected contact patch in a 2560 px frame —
under the car, where they belong. Nothing is broken, mispositioned, culled, or suppressed.

**And it was the tuned pair, not the narrow one.** `CONTACT_HALO_DEFAULT` went to 1 in
`d3d54ef` on 25 Aug 12:46; the bedroom and kitchen frames were shot 26 Aug 16:20. The blobs
the critics looked at were 1.75 × 2.30 with `groundLean` 0.6 — confirmed live, not inferred.
The widening that D25/D42 argued for had already shipped, over a day earlier.

**Eight out of eight critics said the cars have no contact shadow and read as decals.** Four
bedroom, four kitchen, blind, one frame each, no contact between them. Kitchen — 24 reviewed
rounds — is if anything more explicit than bedroom:

> the wood grain and its specular sheen run at full brightness right up to and under the sill,
> so the car reads as a sprite pasted onto the floor rather than an object resting on it

> No contact shadow, no AO at the tyre patches, and a shapeless blurred oval standing in for a
> cast shadow while a nearby eraser throws a crisp, correctly-shaped one

That last line is the kitchen critic independently reporting bedroom's "250 px away" claim:
**the props throw shadows the cars do not.** Two circuits, two lighting presets, eight
observers, same complaint.

### What this defect actually says

Blob **area** is not the variable that buys the grounding read, and the project has now spent
two defects (D25, D42) and a ship on the assumption that it is. 21× the area moved the
critics not at all. The remaining candidates, none of them tested:

* **No dark line at the tyre contact patch.** Every critic asks for the same specific thing —
  "a tight, dark contact shadow/AO term at the tyre patches and under the sills". A soft
  elliptical plateau under the whole car is not that, at any width.
* **The asymmetry against props.** A crisp, correctly-shaped shadow beside a shapeless oval
  reads as a bug even if the oval is objectively darker. This is a *relative* fault, so a
  brighter blob cannot fix it — only a shaped one can.
* **Cast shadow — ANSWERED, see below.** The cars cast. The shadow has no silhouette.

### Instruments that lied, and how they were caught

Both were caught by a control, and neither would have been caught without one.

* **`composer.render()` re-renders the main pass but not the shadow maps.** Toggling
  `castShadow` on 145 props changed **0 pixels** — and so did toggling it on the car, which
  is the answer one was hoping for. The positive control is what exposed it: an instrument
  that cannot see 145 props cannot be trusted to have seen 1 car. Toggling the whole system
  (`shadowMap.enabled = false`, materials recompiled) *does* register, which is where the
  0.44 % / 1.45 % rows above come from.
* **`MG.capture()` drifts between calls.** Two captures of a paused engine at the same pose
  differ by **12.1 %** — larger than every effect being measured, and larger than the
  positive control taken between them. `engine.pause()` freezes the fixed step, not the RAF,
  and temporal history keeps moving. `capture-set.js` pins properly; a bare `MG.capture()`
  pair does not, and D49's cross-session warning does not cover it.

The working instrument is synchronous: `renderer.render(scene, camera)` and a `drawImage`
readback inside one JS task, so no RAF can interleave. Its floor is 0.0000 %, exactly — not
0.102 %, because nothing steps between the two reads.

There was a third, and it is the one that mattered: **`renderer.shadowMap.needsUpdate` is the
wrong flag.** Every cascade sets `light.shadow.autoUpdate = false` (Lighting.js:961) and
Lighting drives each map itself by setting that light's own `needsUpdate`. Until the probe did
the same, no `castShadow` toggle could ever register, because no shadow map was ever
re-rendered. That single line is why the first pass came back "the car casts nothing" — the
most plausible-sounding wrong answer available.

### The car casts. The shadow has no silhouette.

Kitchen, morning preset, sun 5.91 at **24° elevation**, contact blobs hidden so only real
shadows remain, floor **0.0000 %** measured twice:

| | pixels | % of frame | mean Δ |
|---|---|---|---|
| positive control — all 37 prop casters off | 6 892 | 0.748 % | 51.4 |
| **test — all 128 car meshes off** | **7 292** | **0.791 %** | **49.7** |

The cars' cast shadows cover **more of the frame than every prop in the scene combined**, at
the same darkness. Per car, the shadow's centroid sits 27–57 px from its contact patch with a
bounding box up to 108 × 152 px — long and correctly offset for a 24° sun. Nothing is missing,
weak, or mispositioned.

**It is just formless.** The car's shadow is a soft grey wedge with no wheels, no roofline, no
gap under the chassis. A metal clip lying on the wood a few centimetres away — *smaller than
the car, and further from the camera in a coarser cascade* — throws a crisp, correctly-shaped
shadow in the same frame. That is the kitchen critic's sentence, arrived at from the code:

> a shapeless blurred oval standing in for a cast shadow while a nearby eraser throws a crisp,
> correctly-shaped one

So D53's real subject is not a missing shadow and not blob area. It is that **the car is the
one object in the scene whose shadow carries no information about its shape**, and eight
observers read that as "no shadow at all".

### Ruled out, each against the 0.0000 % floor

* **Post-processing.** Raw `renderer.render` with the composer bypassed entirely — no bloom,
  no DOF, no motion blur, no grade. Unchanged. (The motion blur pass is camera-velocity
  reprojection anyway, which would smear the crisp clip shadow equally.)
* **Shadow-map resolution.** Cascade 1 forced from 2048 to 4096. Unchanged. The car already
  spans **68 texels** at 2048 (cascade 1, 0.134 u/texel), while the clip that reads crisply is
  further away at 0.903 u/texel. More resolution is not the lever.
* **PCF kernel.** `PCFShadowMap` instead of `PCFSoftShadowMap`, every material recompiled.
  Unchanged.
* **Darkness.** Mean Δ 49.7 for the car against 51.4 for the props. The shadow is not faint.

### The cascade lead — RETRACTED, it was my probe

Recorded here rather than deleted, because the retraction is the useful part.

`_intervals` is `[1, 2, 3, 4]` at ultra (Lighting.js:856): cascade 0 refits every frame, the
wider ones every 2nd, 3rd and 4th, and the throttle is bypassed only by `_isCameraCut` —
which compares **camera** position and direction, nothing else. Moving the sun is not a camera
cut. The probe changed `sunDir` and called `_fitToCamera` exactly once, landing on a frame
where `_frame % 2` and `_frame % 3` were both non-zero, so cascades 1 and 2 were skipped
*correctly*.

The throttle is not an oversight; it is the fix for a defect this file already records. From
the comment at the top of `_fitToCamera`: `Capture` calls `syncSystems()` once after posing,
so cascade 2 "refits only when the frame counter happens to be divisible by 3. r18 won that
lottery and was scored with shadows; r19 and r20 lost it and were scored without. Four blind
judges called r18 the better build 4/4 on exactly that difference." The cut check exists to
stop that, and it does.

So: no defect here, and the first thing to check turned out to be the last thing.

### The control that replaces it: a box where the car is

Same frame, same light, same cascade, same receiving surface, contact blobs hidden — a plain
`MeshStandardMaterial` box the size of the car's footprint (9.12 × 3.0 × 4.11) placed beside
it at the car's own yaw, plus a 2.2 u cube further along.

**The box throws a crisp, hard-edged, obviously rectangular shadow. The cars beside it do
not.** Whatever is happening is a property of the cars, not of the shadow system, the
cascade, the receiver, or the light.

Ruled out from there, each against a 0.0000 % floor:

* **`alphaTest`.** The paint material carries `alphaTest: 0.45` when the livery texture has
  apertures (`VehicleVisual.js:249`), and three applies the same test in the depth pass — a
  good story for a shadow full of holes. Zeroing it on all 8 cars moved **0.055 %** of the
  frame. Not it.
* **Body height.** The box sits on the ground; a car's shell floats on its wheels. Lifting the
  box 1.6 u to match the sill detached its shadow and moved it — still crisp. Not it.

### What is actually measured, and where it stops

Isolating each caster by toggle and profiling the per-pixel darkening it contributes (floor:
0 px):

| | pixels | max darkening | median | mean / max | fraction at full density |
|---|---|---|---|---|---|
| the box | 82 027 | 84.4 | 57.4 | **0.619** | 3.5 % |
| all 8 cars | 176 166 | 93.7 | 51.1 | **0.482** | 0.9 % |

The cars' shadows reach a *higher* peak darkening than the box's and carry less of their area
at full density — real, and in the expected direction, but a ratio of 1.3, not the gulf that
"crisp versus formless" implies. **The photometric gap is much smaller than the perceptual
one**, which is itself the finding: whatever the eight critics were responding to is not
mostly a density difference.

The untested hypothesis, stated as one: the box reads as a shadow because it has straight
edges and resolves to a *rectangle*, while a car lit from 24° and viewed from above projects
to a rounded blob with no interpretable contour — so the missing quantity is **shape
information, not darkness**. If that is right, no amount of density tuning will move a critic,
and the fix is contour: a harder edge near the contact patch, or a shadow that resolves the
wheel gaps. Testing it needs a shape metric, not another diff.

### Also fixed here

The comment at the registration site in `VehicleVisual.js` still described the pre-`d3d54ef`
world in the present tense — "the tuned numbers have never once been used and these narrower
ones win instead", and "Default 0 until a human has judged the frames" — 36 hours after the
default became 1 and the tuned numbers started shipping. Rewritten to say what the code does,
and to carry the measurement above so the next widening has to argue past it.

---


### 28 Aug: the shape metric says the shadow is not misshapen. It is nearly absent.

Built `tools/shadow-shape.js` to answer the open question — *is the missing
quantity contour rather than darkness?* — and the answer at the pose the critics
were judging is neither. It is light.

**The instrument.** Difference imaging: a shadow is exactly what disappears when
you switch it off, so render the region with and without each shadow and subtract.
The residue is that shadow alone — no wood grain, no carpet, no bodywork, no
headlight spill. Seven variants from one boot at one moment, every render and
readback inside a single synchronous JS task. The floor is `base` minus `base2`,
the same render five variants apart: **exactly zero on every statistic**, and the
two PNGs are byte-identical.

Two designs were thrown away first, and both failures are the reason to trust the
third:

* Absolute gradient inside the region called **21.3% of it an edge in every
  variant**, because a fifth of a wooden track at 2560×1440 is grain. Removing
  the entire contact halo moved that by 0.1. That is a fact about the instrument.
* The positive control returned **all zeros** on its first paired run: the `cast`
  flag was being applied to the car's meshes, and the car is hidden in both box
  variants, so box and box-without-shadow rendered identically. A control that
  returns zero voids the run. It does not get to be a finding.

**The measurement.** Bedroom, night, chase pose, frame 4428, car centred at NDC
(0, −0.16) at 87 km/h — the frame family every one of the eight critics was
looking at. Region is a 24.6 u square of ground centred under the car, with the
car's own silhouette masked out so this is a question about the ground and not
about a highlight on a wing mirror.

| isolated by subtraction | area | peak | mean depth | grad p99.9 | sharpness |
|---|---|---|---|---|---|
| **floor** (same render twice) | **0** | **0** | **0** | **0** | **0** |
| contact halo alone | 0.791% | 8.57 | 3.03 | 1.81 | 0.211 |
| car's cast shadow alone | 1.047% | 14.94 | 3.49 | 2.23 | 0.149 |
| both of the car's shadows | 1.207% | 15.15 | 5.13 | 3.27 | 0.216 |
| **box of the car's footprint, in the car's place** | **1.286%** | **14.94** | **2.84** | **2.55** | **0.171** |

*Depths are luma out of 255. `sharpness` is grad p99.9 divided by peak: how much
of a shadow's own depth turns up inside one pixel at its sharpest, normalised so
that darker cannot be mistaken for sharper.*

**The car's shadow is not misshapen.** Against a box of its own footprint, standing
in exactly its place, on exactly the same ground, under exactly the same light and
the same cascade, the car matches on every axis: peak **14.94 against 14.94**, area
1.047% against 1.286%, sharpness 0.149 against 0.171. The hypothesis this probe was
built to test — that the halo buries the cast shadow's contour — is **refuted**:
the halo is the smallest of the three isolations and removing it changes the region's
mean luma by 0.23 out of 255.

**What is actually wrong is the size of every number in that table.** The whole
ground-shadow contribution of a car — halo and cast shadow together — darkens 1.2%
of the region by a mean of 5 luma and a peak of 15, out of 255. The region's own
mean is 36 and its darkest pixel is 11.66 **in all seven variants**. Put plainly:
`base` and `neither` — the shipping frame, and the same frame with both of the car's
ground shadows switched off — are indistinguishable by eye. There is no light under
that car for a shadow to remove.

So D53 is not a shadow-shape defect. It is a lighting-level one, and it is the same
frame as D54: the only strong light in the picture is a headlight pointing forward at
ground level, which produces almost no downward occlusion beneath the car that casts
it. Eight critics said the cars look like decals. On this evidence they are describing
a car sitting on a surface that is already black.

**Limits, stated rather than buried.** One pose, one circuit, one preset. The box
control loses the headlights, because the spotlights are parented to the car's visual
root — so its illumination is not identical to the car's, only its geometry, place and
cascade are. And the box does not cast the crisp rectangle recorded earlier in this
entry: at this pose it casts almost nothing either, which is consistent with the
reading above but means the earlier observation was made under conditions I have not
reproduced and have not re-examined.

**Next:** run the same probe on a daylight circuit. If the numbers scale up with the
light, "there is nothing to shadow" is confirmed as the mechanism. If they stay at 15
out of 255 in full sun, this reading is wrong and the contour question is open again.

## D54 — The headlight is tuned for the far end of its own beam and clips to white at the near end — MAJOR — OPEN

Raised by the D52 discriminator, from evidence it was not looking for.

**Six critics out of six named the headlight**, as the tell or as the single worst problem in
the frame — and crucially they did so on **both sides of the round**. Three were looking at
degraded frames, three at clean ones; the degradation is a 320 px round trip and has nothing to
do with lighting. So this is not an artifact of the test variable. It is a property of the
build, and it is the most reproducible observation this project has:

> a clipped pure-white blob with no falloff, no cone volume and no reciprocal effect on the car
> emitting it — *(mush, gameplay)*

> A single unclamped white blob directly in front of the car burns to pure paper-white with no
> falloff shape, no visible beam cone … No shipped racing title lets a headlight nuke its own
> road surface like that. — *(clean, gameplay)*

Add `rounds/bedroom-r1`, where **all four** bedroom critics raised it (14, 6, 8 and 13 mentions
across their answers). **That is ten of ten critics who have ever been shown a bedroom night
frame.**

**Corrected on the same day it was written.** This entry first claimed the evidence spanned
"two circuits, two lighting presets". It does not, and the error was mine: all six discriminator
frames are bedroom, not kitchen — the critics describe carpet and a night interior, and the
`abval2` captures they were cut from are bedroom's. The kitchen critics in `rounds/bedroom-r1`
mention a headlight 1, 0, 0 and 0 times, for the good reason that **kitchen has no headlights
on**: it runs the `morning` preset at darkness 0.0 against a threshold of `> 0.24`
(`VehicleVisual.js:1077`), so the lamps never switch on. They could not have seen one.

So this is **one circuit and one preset** — but unanimous within it, and still spanning both
sides of a controlled round, which is the part that matters: the test variable is a 320 px round
trip and has nothing to do with lighting, so the complaint cannot be an artifact of the
degradation.

### The cause is in the code, and the code's own comment contains it

`VehicleVisual.js:1105` sets `s.intensity = this._lampMix * 900`, with this justification:

> Punctual intensity is candela and falls off as distance^decay, so the number that matters is
> the irradiance where the beam lands: 900 cd at decay 1.6 puts roughly 7 on the road 20 u
> ahead, which sits alongside Lighting's own lamp rather than blowing straight through the grade.

The arithmetic is right and the reasoning is sound — **for 20 u ahead**. The beam does not start
at 20 u. At decay 1.6, irradiance ∝ 900 / d^1.6:

| distance ahead | irradiance | against a target of ~7 |
|---|---|---|
| 20 u | 7.5 | the tuned figure |
| 8 u | 32 | 4× over |
| 5 u | 69 | 9× over |
| 3 u | 155 | **21× over** |

The near end of the pool — the part directly in front of the car, which is what the camera is
looking at in every one of these frames — is being driven ten to twenty times past the value the
comment was aiming for. It clips, and a clipped region has no falloff and no shape by
definition. Every critic complaint follows from that one number: no falloff, no cone, no beam
structure, erases the track surface under it.

**And `spot.castShadow = false` (`VehicleVisual.js:739`)**, which is the other half of what they
reported — *"it does not light the car that emits it or cast the car's own shadow backwards"*.
That flag is a deliberate cost decision (the comment at `SPOT_BUDGET` explains that every extra
shadow-casting spotlight recompiles every material in the scene), so it is a trade, not an
oversight. But it is a trade whose price is now measured: six of six critics noticed.

### The dial now exists, and the ladder is rendered

The fix is not simply "turn it down" — 900 cd is correct at the far end, so lowering it to fix
the near end would lose the beam's reach. So the dial trades the two against each other and
holds the far end fixed by construction. `?headlight=N` in `VehicleVisual.js`, N in [0, 1]:

    HEADLIGHT_DECAY     = 1.6 + (0.6 - 1.6) * N
    HEADLIGHT_INTENSITY = (900 / 20^1.6) * 20^HEADLIGHT_DECAY

The leading constant is the irradiance the original comment was aiming for — 7.458 at 20 u — and
it is a *fixed point of the whole family*. Every rung lands on 7.458 at 20 u; they differ only
in how fast the beam gets there. Verified live at all four settings.

| N | decay | intensity | at 20 u | at 3 u | pixels changed vs N=0 | max Δ |
|---|---|---|---|---|---|---|
| **0** (shipping) | 1.60 | 900 | 7.46 | **155** | — baseline | — |
| **0 repeated** | 1.60 | 900 | 7.46 | 155 | **0.000%** | **0** |
| 0.33 | 1.27 | 335 | 7.46 | 83 | 10.165% | 118 |
| 0.67 | 0.93 | 121 | 7.46 | 44 | 23.160% | 183 |
| 1.00 | 0.60 | 45 | 7.46 | **23** | 30.827% | 203 |

`shots/d54-hl-{00,033,067,100}.png`, 2560x1440, one boot, race clock 38.075, frame 4400, seven
cars moving. The floor rung is not "small" — the first and last renders of the ladder are the
same file, md5 `38297a98…`, five renders apart. The near field moves 6.7× across the ladder
while the far field does not move at all.

**What the frames show.** At N=0 the pool directly ahead of the car has a white-hot core that
clips — it reads as a flare, and it swallows the apex of the cone where the cone is defined. By
N=1 the core is gone: the wash is warm, the wood grain reads straight through it, and the two
shadow edges cast by the car's own body are continuous from the bumper outward, so the pool
finally reads as a *cone* rather than a blob. The lit stretch further up the track is unchanged
in all four, which is the point of the fixed far end.

**Nothing is committed as the default.** `HEADLIGHT_SHAPE` defaults to 0, so the build ships
exactly as before; the dial only answers the URL. Which rung ships is a look decision and this
project's rule is that a look is decided from frames by a human.

### It also refutes two things the harness believed about itself — see D55

The first attempt at this ladder was one boot per setting, pinned by absolute frame. It was
worthless, and finding out why cost more than the ladder did.


## D55 — A pinned frame is not the moment it says it is: the pin does not cross a boot, and the camera does not come with it — CRITICAL (method) — OPEN

Two independent failures in `tools/pin-shot.js`, both found while trying to render the D54
headlight ladder, both of which silently produce a frame that looks completely valid.

### 1. Pinning by frame does not survive a boot

`pin-shot.js`'s own header says it: *"PIN BY STEP COUNT, not by wall clock. The engine is a
fixed 120 Hz timestep, so N steps from boot is the same simulated moment every time."* That
claim is false, and here is the measurement that kills it. Two boots of the byte-identical URL
(`?track=bedroom&skipmenu=1&t=16&quality=ultra&autopilot=1&mute=1&headlight=0`), each stepped
to **absolute frame 3841** and asserted to have landed there:

| | boot A | boot B |
|---|---|---|
| frame at shot | 3841 | 3841 |
| race clock at shot | 32.175 | **32.500** |
| car speeds | 21.6, 2.2, 22.1, 2.3, 2.5, 28.9, 64.2, 81.5 | 84.2, 76.3, 92.9, 8.8, 1.8, 26.4, 19.9, 96.1 |

**91.176% of pixels differ**, mean channel delta 41.5, and every one of the six bands is between
89.6% and 94.0% — the whole frame, not a region. The floor for two boots of one build in one
session is 0.102% (D49). This is not a near miss; the two frames are different races.

The cause is visible in the numbers. During the pin itself the clock and the frame counter are
locked exactly: A advanced 1908 steps and 15.900 s, B advanced 1878 steps and 15.650 s, both
precisely 1/120 per step. The divergence is entirely upstream, in the `?t=16` boot seek, which
advances `race.raceTime` by something that is **not** engine steps — so two boots arrive at the
same frame number holding different clocks, and the frame counter is not a cross-boot coordinate
at all. D25 fixed exactly this for `captureSet` by pinning to a **race clock** (`PIN_RACE_TIME`)
rather than a step count; `pin-shot` was written afterwards and pins by step count.

### 2. Force-stepping leaves the camera behind

`pinShot` disables the director for the duration — correctly, per D26, because the director
drifts the camera. But **the director is also what drives the camera**, and it runs in the render
loop, not the fixed step. So `stepOnce()` moves the cars and moves nothing else. Step far enough
and the shot is taken from a camera belonging to the pre-step moment.

Measured directly. From a held frame, stepping 20 at a time and projecting the player into the
camera each time, the car walks off the screen and never comes back:

| frame | 3871 | 3931 | 3991 | 4091 | 4191 | 4331 |
|---|---|---|---|---|---|---|
| player NDC y | −0.29 | +0.08 | +0.48 | +1.04 | +1.49 | **+2.01** |

Monotonic, straight out of the top of the frame. The 1878-step pin above produced a 2560×1440
frame of **an empty stretch of track with no car in it** — and it reported `movingCars: 8`,
`raceState: "racing"`, `ok: true`. Nothing in the return value says the picture is of nowhere.
Re-enabling the director snapped the camera back onto the car within four RAF frames, which
confirms the direction of causation.

Both failures share a shape: **the assertion that was checked is not the assertion that
matters.** `frameAfter === 3841` was true in both boots and told me nothing.

### Not fixed

Nothing has been changed in `pin-shot.js`. The D54 ladder routed around it instead —
`tools/light-ladder.js` never crosses a boot and never steps: it takes the whole ladder from one
live-driven moment, changing only the parameter under test between renders, with every render
and readback inside a single synchronous JS task so no RAF can interleave. Its floor rung is
**byte-identical** to its baseline, md5 for md5, five renders apart. That is the strongest floor
this project has recorded and it is worth keeping, but it only works for parameters that can be
changed live, which is a strictly smaller class than what `pin-shot` claims to cover.

A real fix for `pin-shot` needs both halves: pin to `race.raceTime` like `captureSet` does, and
either drive the camera forward during the step or refuse a step larger than the camera's
settling time.


## D56 — You can be eliminated with cars still behind you, because the game ranks you on one quantity and eliminates you on another — MAJOR — OPEN

Reported from play: *"sometimes I get eliminated while there are still active cars
behind me."*

Not reproduced by measurement yet. But it does not need a repro to be established
as possible, because the two orders involved are different quantities by
construction and the code says so in its own comments.

**The position you are shown is a score order.** `_rank()` sorts `standings` with
`compareEntries`, which for running cars is `b.score - a.score`. That array is what
the HUD reads for "6TH", and what the results table reads.

**The car that gets eliminated is chosen on road order.** `_checkElimination()`
scans for the entry with the lowest `roadDistance` and takes it, explicitly
refusing to use the tail of `standings`:

> The car that goes is therefore the one furthest back ON THE ROAD, found by
> scanning rather than taken off the tail of `standings` — the classification can
> legitimately disagree with the road order, and here it is the road order that
> decides.

**And the two are guaranteed to disagree, on purpose.** `score` carries the cut
penalty; `roadDistance` is documented as being indifferent to it. D14 is the reason:

> One moderate cut costs more score than the elimination gap, so a car sitting
> mid-pack in plain view could be eliminated for it.

Which gives the reported symptom directly. A CPU cuts a corner. Its `score` drops
below the player's, so the HUD moves it *behind* the player and the player sees a
car still racing behind them. Its `roadDistance` does not drop, because that signal
deliberately follows the cut — so on the road it is still ahead. The player is now
genuinely last on the road, the gap opens, and the player is eliminated with one or
more cars showing behind them.

Every individual decision here is defensible and each was made for a measured
reason. The defect is the pair: **the game shows you one ranking and enforces
another, and never shows you the one it enforces.** From the seat, that is
indistinguishable from a bug.

### Not fixed, and the fix is a design call

Three candidates, and they are not equivalent:

* **Eliminate on the order the player is shown.** Simple and honest, but it
  reinstates exactly the defect D14 removed: a cut costs more score than the
  elimination gap, so cutting could put a mid-pack car out.
* **Require last on BOTH orders.** The player is only eliminated when they are last
  by score *and* last on the road. Keeps D14's protection, removes the
  contradiction, and costs some eliminations that were spatially fair.
* **Show the road order while elimination is armed.** Changes nothing about who
  goes; makes the threat legible. The player would see themselves drop to last
  before being taken out, which is what "a threat you can feel closing" needs.

The third is the smallest change and the only one that does not trade away
something already bought. But which of these ships is a design decision, not a bug
fix, and it is the user's call.

**Before implementing any of them, this needs a repro** — hook `race:eliminated`,
dump the whole field's `score`, `position` and `roadDistance` at the moment the
player goes, and confirm that cars classified behind the player really were ahead
of them on the road. Until that is on record, the mechanism above is a reading of
the source, not a measurement.
