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
