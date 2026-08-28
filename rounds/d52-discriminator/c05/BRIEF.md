# Visual review of one frame

**frame.jpg** sits next to this file. It is a captured frame from a toy-scale
racing game — die-cast cars racing on tracks built across an ordinary house.

Your job is to be hostile. The default verdict is "not good enough". A frame
passes a category only when you cannot construct a specific, concrete criticism
that a professional art director would raise.

## The tell test

Imagine this frame in a grid beside frames from *Forza Horizon*, *Art of Rally*,
*Hot Wheels Unleashed*, *Circuit Superstars* and *Trackmania*. Could a stranger
pick this one out as the hobby project in under two seconds? If so, say exactly
what gave it away.

Usual giveaways: flat ambient light with no key direction; objects floating with
no contact shadow; visible texture tiling or uniform noise; aliasing; no depth
cues; obvious primitive geometry; post that is absent or overcooked; a track
floating in a void.

## Scoring

Score each category 1–10. **5** = a competent hobby project. **7** = a good indie
release. **9** = indistinguishable from a well-funded commercial title. Be
stingy above 7.

| # | Category | What you are judging |
|---|---|---|
| 1 | Materials & texture | Do surfaces read as real substances? Tiling invisible? Roughness varied? |
| 2 | Lighting & shadow | Clear key direction, soft falloff, contact shadows and AO, no light leaks |
| 3 | Post & grade | Tilt-shift sells miniature scale; bloom only on speculars; grade has intent; AA clean |
| 4 | Geometry & silhouette | Cars read as desirable die-cast objects; bevels catch light; props modelled, not blocked out |
| 5 | Effects | Smoke has volume; sparks stretch; particles depth-fade; skid marks follow the contact path |
| 6 | Composition & camera | Composed, not merely pointed; scale reads correctly; action legible |
| 8 | Environment richness | The world feels like a real place with a story, not a track in a void |
| 9 | Cohesion | One art-directed product, or parts from different projects? |

There is no category 7. It covers UI and type, which cannot be judged from this
kind of capture, and scoring it anyway has already cost this project a round.

## Write your answer to `answer.json`

```json
{
  "describe": "what the frame actually shows, before you criticise it",
  "scores": { "1": 6, "2": 4, "3": 7, "4": 6, "5": 5, "6": 6, "8": 3, "9": 5 },
  "tell": "what gives it away as a hobby project, or null if nothing does",
  "defects": [
    { "category": 2, "severity": "major",
      "what": "one concrete fault, located in the frame",
      "fix": "what to change" }
  ],
  "worst": "the single worst problem in this frame"
}
```

Rules:

- Describe **before** you criticise. Do not revise the description afterwards.
- `severity` is `"minor"`, `"major"` or `"critical"`.
- Every defect must be something you can point at in **this** frame. Not "the
  lighting could be better" — *where*, *what*, and *why it is wrong*.
- **A frame can be good.** If a category genuinely deserves 8 or 9, give it 8 or
  9, and if you cannot find a real fault in a category, do not invent one to
  fill the list. Some frames in this batch come from a part of the game that has
  already been through many rounds of exactly this review. Padding the list on
  those is not hostility, it is noise, and it makes the whole round worthless.
- You are judging this frame alone. You have no other context and should not
  guess at any.
