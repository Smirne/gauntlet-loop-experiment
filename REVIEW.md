# MICRO GAUNTLET — Visual Review Rubric

For review agents. Your job is to be **hostile**. The default verdict is "not good enough."
A frame passes only when you cannot construct a specific, concrete criticism that a
professional art director would raise in a review.

## How to review

1. Start the dev server if it isn't running (`micro-gauntlet` preview config, port 8791).
2. Drive the page to the state you want to inspect via URL params:
   - `?track=kitchen|garden|workbench|pool|bedroom`
   - `?skipmenu=1` — straight into the race
   - `?autopilot=1` — **required.** Nobody is holding the keyboard during a review, so
     without it car0 never moves, gets eliminated at ~10 s for trailing the field, and
     that ends the race: engine parked, `raceTime` frozen, every car flagged finished on
     lap 0. Rounds 1 and 2 were both scored on frames captured after that had happened.
     `captureSet()` now refuses to shoot unless `race.state === 'racing'`.
   - `?t=12` — fast-forward 12 s of simulation before rendering (field spread out,
     effects active, skid marks laid down). This is the most useful shot for judging.
   - `?quality=ultra`, `?nohud=1`, `?cars=8`, `?seed=N`
3. Capture at full resolution and read the PNG back:
   ```js
   await window.MG.capture('review-kitchen-t12', 1920, 1080)
   ```
   Then `Read` `shots/review-kitchen-t12.png`.
4. Also check `window.MG.status` for failed modules and `window.MG.probe()` for a black
   frame. A frame that fails to render is an automatic 0.

## The tell test (the only test that really matters)

Imagine this frame placed in a grid next to frames from *Forza Horizon*, *Art of Rally*,
*Hot Wheels Unleashed*, *Circuit Superstars*, and *Trackmania*. **Could a stranger pick ours
out as the hobby project in under two seconds?** If yes, say exactly what gave it away.

Common giveaways, in the order they usually appear:

- **Flat, ambient-looking light.** No directional key, no shadow contrast, everything evenly
  lit. Real games have a clear light direction and deep, shaped shadows.
- **Floating objects.** No contact shadow or AO where an object meets the ground. This is
  the single most common amateur tell.
- **Untextured or obviously-procedural surfaces.** Visible tiling repetition, uniform noise
  that reads as "TV static," a flat colour where a material should be, plastic-looking
  everything because roughness is constant across a surface.
- **Aliasing.** Hard jaggies on edges, shimmering on high-frequency textures.
- **No depth cues.** Everything equally sharp, no atmospheric perspective, no DOF.
- **Geometry that is obviously primitives.** Sharp box corners, cylinders with visible
  facets, no bevels catching a highlight.
- **Post that is either absent or overcooked.** Milky bloom over the whole frame, crushed
  blacks, a grade so heavy it eats detail.
- **Default-looking UI.** Browser fonts, unstyled rectangles, inconsistent spacing.
- **Empty space.** A track floating in a void with nothing around it.

## Scoring

Score each category 1–10. Anchors: **5** = a competent hobby project. **7** = a good indie
release. **9** = indistinguishable from a well-funded commercial title. Be stingy above 7.

| # | Category | What you are judging |
|---|---|---|
| 1 | Materials & texture | Do surfaces read as real substances? Wood grain, felt nap, rubber, chrome, dust. Tiling invisible? Roughness varied? |
| 2 | Lighting & shadow | Clear key direction, soft shadow falloff, contact shadows and AO, believable bounce, no light leaks or peter-panning |
| 3 | Post & grade | Tilt-shift sells miniature scale; bloom only on speculars; grade has intent; grain subtle; AA clean |
| 4 | Geometry & silhouette | Cars read as desirable die-cast objects; bevels catch light; props are modelled, not blocked out |
| 5 | Effects | Smoke has volume and turbulence; sparks stretch and bounce; particles depth-fade; skid marks follow the real contact path |
| 6 | Composition & camera | Frame is composed, not merely pointed; scale reads correctly; action is legible; motion is damped |
| 7 | UI & type | Designed, hierarchical, consistent rhythm, animated, doesn't obscure the action. **NOT SCOREABLE from a `MG.capture()` frame — see below.** |
| 8 | Environment richness | The world feels like a real place with a story, not a track in a void |
| 9 | Cohesion | Does it look like one art-directed product, or parts from different projects? |

**A frame is AAA only when every category is ≥ 8 and none is below 7.**

### Category 7 cannot be judged from a capture, and scoring it anyway has cost a round

The HUD is **DOM, not canvas** (`capture-set.js`: "it can never appear in these captures").
`MG.capture()` reads the WebGL canvas, so the UI is structurally absent from every review
frame regardless of whether it is built, styled or animated.

In critic round 6 all three reporting judges scored this category **1 out of 10** — "there is
no UI at all", "there isn't any" — and two of them named it in the tell test as evidence the
project was a hobby build. The HUD exists: position, lap, lap time, a speedometer with a boost
gauge, and a minimap, all visible in an ordinary browser screenshot of the same moment.

So: **do not score category 7 from a captured frame.** Either skip it and score out of eight,
or judge it from a real browser screenshot, which does composite the DOM. A judge asked to
score it from a capture will not report "I cannot see this" — it will report a 1, and it will
carry that into the tell test as well, which poisons more than one number.

This is the third time this project has scored a round on evidence the harness could not
produce: rounds 1-2 were scored on a race that had already stopped, rounds up to 5 on frames
whose shadows were a coin flip, and round 6 on a UI that cannot be photographed. **Before a
review round, ask what the harness is incapable of showing, and take those categories off the
sheet.**

## Blind A/B

When comparing two iterations you will be given two images labelled only **A** and **B**,
in randomised order, with no indication of which is newer. Judge purely on what you see and
name the winner with specific reasons. This exists to catch regressions that a "surely the
new one is better" bias would hide — it is legitimate for the older frame to win, and saying
so is the most valuable outcome this check can produce.

> Note on references: no copyrighted screenshots from commercial games are stored in this
> repo. Comparison is against your own knowledge of how those titles look, applied through
> the rubric above, plus blind A/B between our own iterations.

### The subtle-difference protocol — required whenever the change is small

A round comparing road wear at 1x against 2.4x returned **four judges out of four choosing
A**, with the label mix putting the heavier setting in slot A for two of them and the lighter
setting in slot A for the other two. On the variable that is 2-2, a null. Every judge wrote a
confident rationale for why *their* A had wear and *their* B was bare wood — two of those
descriptions are of the heavier frame and two of the lighter one. Below some difference
threshold, a judge picks the first image and then explains it.

Rounds where the difference was obvious do not show this (the background-aware livery round
came out B, A, B, B), so it is a failure mode of the hard comparison specifically — which is
where a wrong verdict is hardest to notice. Three rules follow.

1. **Describe before choosing.** Ask the judge to describe each frame separately, and to state
   what physically differs between them, BEFORE it is asked which is better. **A judge that
   cannot name the difference must say so and decline to pick** — "I cannot see a difference"
   is a valid, useful answer and must be offered explicitly in the prompt. This is the
   adopted policy.
2. **Report the position tally as a first-class result.** A 4-0 split on which *slot* won,
   against a 2-2 split on the *variable*, is a null however confident the prose. Compute this
   every round and put it above the verdict.
3. **On a null, do not ship and do not re-run for a better answer.** Re-running until the
   result is agreeable is how a loop launders noise into evidence. Change the stimulus so the
   difference is large enough to be seen, or accept that the change is below the threshold
   that matters and drop it.

### Revisited, and overturned, by measurement — 26 Aug 2026

The paragraph that used to sit here declined the two-order rule as too expensive and bet on
describe-first alone, ending "if describe-first only converts position bias into more honest
nulls — which is a real possibility — revisit this." That is what happened. Three rounds,
27 judges, all on the fixed brief:

| round | known answer | verdict | position split | controls called different |
|---|---|---|---|---|
| a frame against itself, every pair | nothing there | NULL | no preferences at all | **0 / 2** |
| full detail vs a 320 px round trip | the clean one | **VERDICT**, 6-0, p=0.031 | 3 / 3 | **0 / 3** |
| depth of field on vs off | genuinely contested | **SPLIT** | **4 / 4 one side** | **0 / 2** |

**Describe-first works, at the job it does.** Detection was perfect and separated cleanly:
not one of the eleven control judges claimed a difference between a frame and itself, all of
them wrote "neither" unprompted, and every one of the ten real-pair judges named the actual
difference in concrete, locatable terms before choosing. The protocol's first rule is sound
and stays.

**Describe-first does not stop position bias.** On the depth-of-field round all four judges
chose the second image while describing the difference accurately and acknowledging the
trade-off in their own words. Honest, specific, self-aware prose, and still 4-0 on the slot.

**The bias is not a left-bias.** The road-wear round went 4-0 to the *first* image. This one
went 4-0 to the *second*. Direction is not stable, so no correction and no fixed slot order
can absorb it, and mixing labels only ever detects it after the fact.

**It strikes exactly where D28 said it would.** Position was 3/3 — dead level — on the round
whose answer was obvious, and 4/4 on the round whose answer was contested. The claim that
this is a failure mode of the *hard* comparison specifically was made from memory in D28; it
is now measured, inside one session, against a control.

**So both orders are mandatory**, and they are what actually caught it: at four judgements a
4-0 position split is p=0.125 and cannot clear any honest threshold, so the position tally
alone could not have condemned the round. The cross-order disagreement could, and did.

### The protocol, as it now stands

Rounds are built, blinded and scored by `tools/ab-round.js`; it will not let a round skip
these. Judges are pointed at one task directory each and never see `round.json`.

4. **Every cell goes to two judges in opposite orders.** Keep the verdict only where both
   name the same setting. Cells that disagree make the round a SPLIT, not an average.
5. **Every round carries controls — a frame against itself.** A judge that finds a difference
   there is not measuring the variable, and a round where most controls come back "different"
   is VOID. This is the oldest rule in the project (measure the floor in the same run, with
   the same instrument) pointed at the judges instead of at the pixels. **A round with no
   controls cannot return a verdict at all.**
6. **Three cells minimum.** A unanimous split of n judges is p = 2 / 2ⁿ, so the four-judge,
   four-camera round every earlier round used bottoms out at p=0.125 and was never capable of
   a significant result — D28's "four out of four" was not significant even as a position
   split. Six real judgements reach 0.031. Below that the scorer returns NULL and says
   *underpowered* rather than letting a quiet null read as evidence of no difference.

Cost is roughly 3× the old round (three cells, both orders, plus controls). The
depth-of-field round is what that buys: under the old protocol it would have been written up
as a win for whichever side the labels happened to favour.

What a null round is still good for: the judges' *descriptions* remain useful even when their
*verdict* is worthless, because a description does not depend on which frame was which. The
road-wear round produced its most actionable brief that way — all four independently said
neither setting read as a road, and agreed on why.

## Output

Report per-category scores, the single worst problem in the frame, and a prioritised list of
concrete, actionable fixes naming the module responsible (see ARCHITECTURE.md section 3).
Vague notes like "improve lighting" are useless. "The sun elevation is too high at 78°,
flattening the cars — drop to 30–40° for raking light and longer shadows" is useful.
