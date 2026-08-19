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
