# Built, blind, and unscored — blocked on the machine, not the method

This is the D52 discriminator. It is built and ready; **no judge has returned an
answer**, so there is no result here and nothing may be inferred from its absence.

## The design

| side | frames | known answer |
|---|---|---|
| test | the three 320 px round-trip "mush" frames | plainly the worse side |
| control | the three clean originals, same poses, same moment, same build | plainly the better side |

The only variable is the one that is already known to be visible. Six comparative
judges, shown both sides in both orders, called clean better **6-0 (p=0.031)** with
position balanced 3/3 and **zero** false differences across three null pairs
(`rounds/d28-mush`). So a judge who sees both frames cannot miss this.

The question this round asks is the narrow one D52 turns on: **can the absolute
1-10 critic score see it when each critic sees only one frame?**

* mush scores materially below clean -> the score discriminates, D52 reading 1 dies,
  and bedroom's flat result means kitchen's 24 rounds bought nothing measurable.
* mush and clean come back indistinguishable -> the score is a constant function and
  every per-round score on record is void, the 5.19 included.

There is no third outcome that leaves the scoreboard standing.

## Why it is unscored

Ten judge agents were launched across two batches on the night of 27-28 Aug 2026.
Every one died the same way: `Your computer went to sleep mid-response`, plus one
stream stall. Not one wrote an `answer.json`.

The harness behaved correctly throughout — each judge writes its own answer file
before it reports, which is what saved the eight-judge bedroom round when seven
agents hit a session limit. Here there was simply nothing to save.

## For whoever runs this next

Relaunch one agent per `cNN/` directory. Each needs only its own folder: read
`BRIEF.md`, look at `frame.jpg`, write `answer.json` beside them. Point no judge at
`round.json` — it names the sides. Then:

    node tools/critique-round.js collect rounds/d52-discriminator
    node tools/critique-round.js score   rounds/d52-discriminator

**Do not score these frames yourself if you built the round.** Whoever assembled it
knows which three are the mush, and that is exactly the bias the protocol exists to
remove. An unscored round is a clean result; a self-scored one is a ruined one.
