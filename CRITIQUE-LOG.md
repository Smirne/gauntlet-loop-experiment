# Critique log

One entry per critique round. Scores are against the `REVIEW.md` anchors:
**5 = competent hobby project, 7 = good indie, 9 = commercial AAA.**

---

## Round 2 — post fix-wave-1, plus D9/D10/D11

Frames: `shots/crit-{1..4}-*-r2b.png`, mid-race at ~52 s, field strung out across the lap.
Five hostile critics, one per dimension, each free to read source to check a hypothesis.

| Dimension | Score |
|---|---|
| Lighting, shadow and grounding | **3** |
| Materials and texture | **4** |
| Modelling and silhouette | **4** |
| Post, colour and the tell test | **4** |
| Camera, composition, miniature illusion | **5** |

Below the "competent hobby" anchor on four of five. That is the honest position.

### Blind A/B — round 1 vs round 2

Four judges, one per camera angle. Each saw two frames at neutral filenames with **no**
indication which build was which, and the A/B assignment was deliberately mixed so that
always answering "A" scores 2/4.

| Pair | Angle | Label A | Label B | Winner | Confidence |
|---|---|---|---|---|---|
| 1 | gameplay | round 2 | round 1 | **A — round 2** | high |
| 2 | chase | round 1 | round 2 | **B — round 2** | high |
| 3 | macro | round 1 | round 2 | **B — round 2** | high |
| 4 | establishing | round 2 | round 1 | **A — round 2** | high |

**Round 2 won 4/4 at high confidence, across a mixed label assignment.** Fix wave 1 plus the
D9/D10/D11 bug fixes were a real improvement, not a self-assessment.

Both round-1 and round-2 frames in this comparison were captured at `t=6`, before D10 was
found, so both show the same not-really-simulated field. That makes the comparison fair — the
only difference between them is rendering — but it is why the round-2 *critique* above used
the `-r2b` frames at `t=16` instead, which are the first frames of an actually-simulated race.

### Adjudications that changed the work list

The synthesis agent re-measured the disputed regions rather than averaging the critics.

- **Six differently-named findings were one bug.** "Black wedge", "black band", "black
  polygon", "black slab", "gaffer tape", "a hole cut in the table" are all the skid ribbon:
  `fx/Trails.js` tints it `0x1a1a1a`, outputs it **unlit**, and draws it at `uOpacity 0.92`.
  Proof it is an overlay and not a hole through to the backdrop: the band has *identical RGB*
  whether it crosses wood or concrete. I had attributed these bands to the missing room (D12)
  — that was wrong, and the measurement is what settled it.
- **The grounding failure is inverted, not absent.** The contact patch under the coffee mug is
  RGB(190,167,159), luma 173; the wood 20 px away is RGB(175,118,75), luma 130. The "shadow" is
  **43 luma levels brighter** than the surface it should darken. Two blind judges named this
  independently without being asked to look for it.
- **"An entire hairpin has no road" and "kerbs detach from the road edge" are the same
  two-line bug.** `world/tracks/kitchen.js` assigns `'oak'` — the table's own surface — to the
  *road* over two spans totalling 20% of the lap. The kerbs are fine; the road they border is
  invisible.
- **Dropped as false:** "grain has no luma weighting" (PostFX does weight it, verified in
  source), "hard vertical seam bisecting the specular" (no seam at 2x; a soft material
  boundary), "debris reads as grey gravel" (half false — the grey cubes are sugar and are
  meant to be grey).
- **One correction carried into the fix brief:** the car's black paint is not a missing
  basecoat. `CarModels.js` bakes the livery and this car is authored black-with-red-stripes.
  A fix agent told to "add a red basecoat" would have made it worse.

The dropped items matter as much as the kept ones. An earlier round asserted a UV-stretching
bug that did not exist and a fix agent spent its whole slot on nothing.

## Blind A/B — r18 vs r22, after the shadow and veil fixes

Three A/B rounds were run in one session, each with a different mixed label assignment so
that always answering "A" scores 2/4 and cannot be learned across rounds.

| Round | Build vs r18 | Result | What the judges named |
|---|---|---|---|
| 1 | r20 | **r18 wins 4-0** | r20 has no cast shadows and does have the veil |
| 2 | r21 (shadow fix) | **2-2** | the two r21 wins both cite shadows; the two losses cite radial streaks |
| 3 | r22 (+ veil fix) | **r22 wins 3-1** | three of four cite shadows; r18 now carries the border veil |

### Round 3 in full — r18 vs r22

| Pair | Angle | Label A | Label B | Winner | Confidence |
|---|---|---|---|---|---|
| 1 | gameplay | r22 | r18 | **A — r22** | high |
| 2 | chase | r22 | r18 | **B — r18** | high |
| 3 | macro | r18 | r22 | **B — r22** | high |
| 4 | establishing | r18 | r22 | **B — r22** | medium |

**0-4, then 2-2, then 3-1** across the two fixes, on the same protocol with the label mix
changed each round.

**The veil changed sides, which is the confirmation that matters.** In round 1 the judges put
it on r20 and called r18 clean. In round 3 they put it on r18 — "a bright milky veil washes
the entire outer border, the top edge blown to near-white", "a milky veil sits along the outer
border, strongest in the top-left corner", "a milky white veil hugs the top edge and the
entire upper-right border" — and called r22 clean on three of four cameras. That is exactly
what a boost-driven artifact should do: it was never a property of a build, only of whether a
car happened to be boosting when the shutter fell. r18 looked clean in round 1 by luck. The
fix removes the luck for any locked-off shot rather than winning the coin toss.

**Two caveats recorded so the round is not oversold.**
- The pair-2 judge reached its verdict very differently from the other three — 17 tool calls
  over 127 s against roughly 2 calls and 23 s — and needed two prompts to produce a verdict.
  The verdict stands as given; the process is noted because a judge that behaves unlike its
  peers is worth watching across rounds.
- Its description of what it saw on r22 is *not* the boost rim: "ghost arcs are offset copies
  of geometry rather than a defocused version of it". Offset duplicate geometry is motion-blur
  ghosting, a different defect, and it is now the leading candidate for the chase camera.

**A theme across all three rounds, from judges that agreed on little else:** the road surface
does not read as a road. "The track surface is nearly indistinguishable from the surrounding
table." "A ghost-translucent film over bare wood with only faint white lane lines, so the
driving line is guesswork." "The lane is just bare plywood with a few thin white line strokes
that break up and float." That is the next thing to fix, and it is an art problem rather than
a bug.

## Livery A/B — the first rounds where the frame isolates the change

Both schemes captured from ONE build at the SAME pinned race moment via `?liveryMode=index`
(see D25). Identical geometry, lighting, effects and race state — the only difference in the
frame is which paint each car wears. Every earlier round in this log compared two moments as
much as two builds.

### Round A — car-separation only, vs the original
| Pair | Angle | Winner | Note |
|---|---|---|---|
| 1 | gameplay | original | "both dark, low-saturation blobs on brown wood" |
| 2 | chase | separated | lime-green vs red is "a far bigger colour gap" |
| 3 | macro | original | "the hero's dark upper surfaces bleed into the neighbouring car" |
| 4 | establishing | original | "four dark specks on a brown table" |

**Lost 1-3.** The scheme maximised distance between cars and took the worst pair from 28 to
75, and it still lost. Every judge volunteered the same reason without being asked for it, and
none of it was car-vs-car: *"change the red hero, red shares the wood's warm hue family"*,
*"the red car is nearly the same value and hue as the brown track"*, *"both sit within a hair
of the tabletop and dirt colour and effectively camouflage"*.

They were not saying the cars looked like each other. They were saying the cars looked like
the table — and the metric had no term for that.

### Round B — background-aware, vs the original
| Pair | Angle | Winner | Confidence |
|---|---|---|---|
| 1 | gameplay | **background-aware** | high |
| 2 | chase | **background-aware** | high |
| 3 | macro | **background-aware** | high |
| 4 | establishing | original | medium |

**Won 3-1**, and the judges' language tracks the measurement exactly. On the old hero car:
"sinks badly", "it is camouflage", "the eye slides off it and jumps to the blue car instead".
On the new one: "holds the eye firmly", "clamps the surface from both ends". The player's car
went from 69 to 157 units away from the oak it drives on.

### The loss is a real finding, not noise
The wide shot is the one frame dominated by the **dirt** sections rather than the oak table,
and there the background-aware scheme puts Rally Orange (79 from the oak) and Night Stage on
dirt, where the judge says they "sink" and "go muddy against the shaded dirt track". Optimising
against a single surface colour is better than optimising against none, and still wrong: the
kitchen track runs over varnished oak, pine, newspaper, crumbs and a ceramic trivet, and a
livery only has to lose against one of them to disappear for that stretch of the lap.

**Next: score each livery against the SET of surfaces the track actually uses, not one.**
That needs the rendered colour of each surface measured the way the oak was — from the frame,
not from the texture — and it should be judged blind like everything else. Do not assume the
multi-surface version is better because the reasoning is nicer; the car-only version had nice
reasoning too and lost 1-3.


## Round 6 — the first round scored on frames that show the lighting the game has

Four judges, one per camera, on the r24 set captured at the pinned moment. Every earlier round
was scored on a parked race, on frames whose shadows were a coin flip, or both.

| # | Category | gameplay | chase | macro | establishing | mean |
|---|---|---|---|---|---|---|
| 1 | Materials & texture | 3 | 4 | 4 | 3 | 3.5 |
| 2 | Lighting & shadow | 3 | 3 | 3 | 3 | **3.0** |
| 3 | Post & grade | 3 | 5 | 5 | 2 | 3.8 |
| 4 | Geometry & silhouette | 3 | 4 | 5 | 3 | 3.8 |
| 5 | Effects | 1 | 3 | 2 | 2 | **2.0** |
| 6 | Composition & camera | 3 | 4 | 4 | 4 | 3.8 |
| 7 | UI & type | 1 | 1 | 3 | 1 | **VOID** |
| 8 | Environment richness | 3 | 3 | 3 | 3 | 3.0 |
| 9 | Cohesion | 2 | 4 | 4 | 4 | 3.5 |

**Tell test: failed 4/4, all four saying "under two seconds".** Mean 3.3 excluding the void
category, against an anchor where 5 is a competent hobby project. That is the honest position
and it is worse than the round-2 numbers, which were measured on evidence that could not
support them.

### Two of the four judges were wrong about the headline, and measurement settled it

The chase and macro judges both led with "nothing casts a shadow". Captured the same pinned
moment with only the cast-shadow term zeroed and diffed:

    gameplay 11.1% of frame darkened, max 138 luma    macro 12.7%, max 161
    chase     6.0%,                   max 140         establishing 2.4%, max 91

Shadows are unambiguously present. The gameplay judge — the only one that pulled magnified
crops — saw them and made the sharper call: *"There is a long, confident directional shadow
thrown to the right of the blue car — so a key exists"*, and then *"the hero car casts a sun
but doesn't receive one."*

### What is actually wrong, measured

The perception all four shared — ambient dome, no lit side and shadow side, uniformly
mid-grey, milky — is real. The cause is not the light rig:

    mean frame luma            134.4
      fog contributes           39.0   (29%)   <-- largest single source
      sun / key                 20.4   (15%)
      environment / IBL          8.1   (6%)
      fill lights                1.8   (1%)
      unlit floor + grade lift  47.3   (35%)

**Fog puts more light into the frame than the sun does.** Key-to-fill measures 11.2:1, not the
1.3:1 the establishing judge estimated — the rig is fine. What flattens the image is a
`FogExp2` at density 0.00055 in `#d9d0bd`, plus a grade that lifts an unlit scene to 47 luma
before anything is lit at all. That is D13, and it is promoted from "erases the backdrop" to
"flattens every frame".

### Three harness faults found in one round

1. **Category 7 is unscoreable from a capture.** The HUD is DOM, not canvas. Three judges gave
   it a 1 and two carried "no UI" into the tell test. The HUD exists and is visible in an
   ordinary browser screenshot. Rubric fixed.
2. **The establishing judge was shown a letterboxed square.** Its JPEG was 1400x1400 with rows
   2-300 and 1100-1397 at pure luma 0.0 — about 44% black bars — while the other three
   converted correctly to 1400x787. It caught this itself and still scored composition and
   grade partly on the padding. That camera must be re-judged.
3. Both faults are the same failure as rounds 1-2 and 1-5 before them: **scoring a round on
   evidence the harness could not produce.** Ask what the harness cannot show before the
   round, not after.

## Round 7 — 3.3 to 5.2, every category up, and the tell test still failed

Two judges, not four. The third stalled on the harness watchdog at 600 s and produced nothing;
its slot is empty rather than filled with a guess. Both reporting judges scored all four frames
rather than one camera each.

**Category 7 was taken off the sheet before the round started**, for the first time. The HUD is
DOM and cannot appear in a `MG.capture()` frame; in round 6 all four judges scored it 1 and two
carried that into the tell test. Both judges this round were told not to score it and did not.

| # | Category | R6 | judge A | judge C | R7 | Δ |
|---|---|---|---|---|---|---|
| 1 | Materials & texture | 3.5 | 6 | 5 | 5.5 | +2.0 |
| 2 | Lighting & shadow | 3.0 | 5 | 5 | 5.0 | +2.0 |
| 3 | Post & grade | 3.8 | 6 | 4 | 5.0 | +1.2 |
| 4 | Geometry & silhouette | 3.8 | 6 | 6 | 6.0 | +2.2 |
| 5 | Effects | 2.0 | 4 | 3 | **3.5** | +1.5 |
| 6 | Composition & camera | 3.8 | 6 | 6 | 6.0 | +2.2 |
| 8 | Environment richness | 3.0 | 6 | 5 | 5.5 | +2.5 |
| 9 | Cohesion | 3.5 | 6 | 4 | 5.0 | +1.5 |
| | **mean** | **3.3** | **5.6** | **4.75** | **5.19** | **+1.9** |

**Read that gap carefully before enjoying it.** Round 6 ran four judges, one per camera; round 7
ran two, each scoring all four. A judge holding one frame has nothing to grade on a curve
against, and is plausibly harsher. Some of +1.9 is the build and some is the protocol, and this
round cannot separate them. What can be said without a caveat: **no category moved down, and the
two lowest in round 6 are still the two lowest now.**

**Tell test still fails.** Judge A: 3 of 4 frames spotted, `crit-2` borderline — *"could sit next
to Art of Rally or Circuit Superstars and survive."* Judge C: 4 of 4. Nothing is at 8. The bar in
REVIEW.md is every category ≥ 8 and none below 7; the floor is Effects at 3.5.

### What both judges found independently

Neither saw the other's report.

**The room.** A: *"everything the team finished is inside the table outline, and nothing outside
it was started."* C: *"a good car asset dropped into someone else's blockout."* Measured here by
hiding every `MG.Room` object and diffing, control capture at 0.000%: **the room is 53.32% of the
establishing frame.** It is also the material whose shader contains no shadow code at all (D30).
Over half of the widest shot is the least-finished thing in the project.

**The car floats.** A: the macro tyre contact zone measures luma 65-94 against 67-86 for
reference wood 400 px away — no darkening. C: the hero's shadow is *"a single featureless oval
with no wheel separation"* while a die 400 px away casts a correct shadow-mapped parallelogram.
Verified independently: hiding `MG.ContactShadows` and diffing the macro frame, control 0.000%,
**the contact shadow system changes 0.05% of the frame at 13 luma.** It is switched on, it is in
the scene, it has 264 instances, and it does effectively nothing.

**The bokeh is not round.** Both, at 6-8x: out-of-focus highlights resolve to hard axis-aligned
rectangles and a stair-stepped hexagon with vertical stripe banding. C measured the grain as flat
across focus (mean |dx| 3.37 in a fully blurred region against 3.43 on a flat wall), which is what
makes defocus read dirty instead of creamy.

**Effects remain the floor, as in round 6.** Four frames, eight cars at speed on a dusty wooden
surface. A found one flat alpha smear; C found none at all.

### A theory of mine, tested and wrong

I proposed that `MG.ContactShadows` renders invisibly because `renderOrder: -5` with
`depthWrite: false` draws it before the opaque ground, which then paints over it. Tested by
moving it to `renderOrder: 5` and diffing:

    renderOrder -5 (shipped)   0.05% of frame changed
    renderOrder +5             0.00% — it disappears completely

The negative render order is what makes it visible at all. The symptom the judges reported is
real and confirmed; my explanation for it was not, and the fix is not a one-line render-order
change. Cause still open.

### Not yet verified from this round

C reports one prop in `crit-4` at (1402, 850) rendering as a pure unlit silhouette — interior
mean RGB 37,31,36 against 213,188,166 on the table beside it. If that reproduces it is a bug,
not a design weakness. A reports a UV seam across the hero's right rear quarter in `crit-3`.
Neither has been checked here.
