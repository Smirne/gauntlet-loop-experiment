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
| 7 | UI & type | Designed, hierarchical, consistent rhythm, animated, doesn't obscure the action |
| 8 | Environment richness | The world feels like a real place with a story, not a track in a void |
| 9 | Cohesion | Does it look like one art-directed product, or parts from different projects? |

**A frame is AAA only when every category is ≥ 8 and none is below 7.**

## Blind A/B

When comparing two iterations you will be given two images labelled only **A** and **B**,
in randomised order, with no indication of which is newer. Judge purely on what you see and
name the winner with specific reasons. This exists to catch regressions that a "surely the
new one is better" bias would hide — it is legitimate for the older frame to win, and saying
so is the most valuable outcome this check can produce.

> Note on references: no copyrighted screenshots from commercial games are stored in this
> repo. Comparison is against your own knowledge of how those titles look, applied through
> the rubric above, plus blind A/B between our own iterations.

## Output

Report per-category scores, the single worst problem in the frame, and a prioritised list of
concrete, actionable fixes naming the module responsible (see ARCHITECTURE.md section 3).
Vague notes like "improve lighting" are useless. "The sun elevation is too high at 78°,
flattening the cars — drop to 30–40° for raking light and longer shadows" is useful.
