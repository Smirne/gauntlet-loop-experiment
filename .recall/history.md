# Recall History — gauntlet-loop-experiment-11bcc4


## Session 5ded4c28 — 2026-08-13 17:39

**You:** I was running this gauntlet loop experiment with you on another computer. I'd like to resume here.
Read the repo, you should find some handover notes i think. 
Ask questions and tell me when you are ready to start.

**Claude:** I'll start by reading the repo to find those handover notes.
  - `Bash: ls -la`
  - `Bash: git log --oneline -25`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/RESUME.md`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/PROMPT.md`

**Claude:** RESUME.md is stale — it predates 10 commits. Let me read the current state.
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/DEFECTS.md`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/REVIEW.md`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/CRITIQUE-LOG.md`
  - `Bash: git log -3 --stat | head -60; echo "---LAUNCH---"; cat .claude/launch.json 2>/dev/null; echo "---CLAUDE DIR---"; ls -R .claude | head -40`
  - `Bash: git log -1 --format=%B 5e1dedb; echo "=========="; git log -1 --format=%B 0a82dd5; echo "=========="; git log -1 --format=%B 4ef9eb4`
  - `Bash: sysctl -n hw.ncpu; echo "---"; which python3 node; echo "---SRC---"; find src -name '*.js' | sort; echo "---"; find src -name '*.js' | wc -l; echo "---TOOLS---"`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/server.ps1`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/src/core/Capture.js`
  - `Bash: grep -n '^#\|^##\|^###' ARCHITECTURE.md | head -60`
  - `Bash: head -30 tools/capture-set.js; echo "=== index.html ==="; cat index.html`

**Claude:** I have the picture. Let me get it runnable on this machine — the server is PowerShell-only and the capture pipeline depends on its `/__shot` POST sink.
  - `Write: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/server.js`
  - `Write: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/.claude/launch.json`
  - `mcp__Claude_Browser__preview_start: micro-gauntlet`
  - `mcp__Claude_Browser__navigate: http://localhost:8791/?track=kitchen&skipmenu=1&t=16&quality=ultra`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__computer: wait`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`

**Claude:** 34 modules, 0 failures, 8 cars on track. Let me verify the capture pipeline works end to end on this machine.
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/shots/crit-1-gameplay-mac-baseline.png`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/shots/crit-4-establishing-mac-baseline`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/shots/crit-2-chase-mac-baseline.png`
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/shots/crit-3-macro-mac-baseline.png`
  - `mcp__Claude_Browser__navigate: http://localhost:8791/?track=kitchen&skipmenu=1&t=16&quality=ultra`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `Bash: grep -n "finished\|lap\b\|laps\|_cp\|checkpoint" src/game/Race.js | head -60`
  - `Bash: sed -n '855,900p' src/game/Race.js; echo "=== callers of _finish ==="; grep -n "_finish\|_dnf\|ELIM\|_eliminate" src/game/Race.js | head -40`
  - `Bash: grep -n "finished = \|finished=" src/game/Race.js; echo "=== state transitions ==="; grep -n "RACING\|FINISHED\|RESULTS\|_setState\|this.state = " src/game/Race`
  - `Bash: sed -n '1045,1105p' src/game/Race.js`
  - `Bash: grep -n "_autopilot\|autopilot\|attract" src/game/Race.js | head -30; echo "=== main.js url params ==="; grep -n "autopilot\|attract\|searchParams\|params\." sr`
  - `mcp__Claude_Browser__navigate: http://localhost:8791/?track=kitchen&skipmenu=1&quality=ultra&autopilot=1`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__ccd_session__mark_chapter: Resume: port to macOS, verify state`

**Claude:** I've read the handover docs, got it running here, and captured a baseline. Here's where things actually stand.

## The docs, and how stale they are

`RESUME.md` is from **2026-07-31 and predates 10 commits** — ignore its "Start here" section entirely. Its one blocker ("no cars spawn") was fixed long ago. `DEFECTS.md` is also partly stale: D3 (rubber) is marked open but the wave-3 commit fixed it. The reliable record is the commit messages, which are unusually detailed, plus `CRITIQUE-LOG.md`.

Real state: **34 modules, 0 failures, 8 cars, all five circuits, all subsystems built.** Nothing is in flight.

Outstanding work, per the last three commits:
- **Wave 3 landed 4 of 8 agents** before a session limit. `Director.js`, track, fx/props and **the room** never ran. `Director.js` was reverted and still carries a comment describing an orientation-aware `_subjectExtent()` that was never implemented.
- **D12 (there is no room — the table runs to the horizon)** and **D13 (fog erases the backdrop)** are open, and D12 is the biggest hit on the miniature illusion.
- D4 (`brushedAluminium` reads as matte blue paint) and D5 (blue-tinted oak knots) — B-surfaces landed, so these may be fixed; unverified.

## Porting to this machine

`server.ps1` is .NET `HttpListener` — that box had no Node or Python. It isn't just a static server: the capture pipeline POSTs PNGs to `/__shot` and the server writes them to `shots/`, which is how every review frame reaches disk. `python3 -m http.server` would have silently broken the whole review loop.

I wrote [server.js](server.js) — same port, same no-cache headers, same `/__shot` sink — and pointed [launch.json](.claude/launch.json) at it. Verified end to end: booted, ran the deterministic critic set, four 1920×1080 PNGs landed in `shots/`. **Uncommitted.**

This machine has **12 cores vs the old 2**, so parallel agents go from 2 to 10.

## What I found booting it — this is the important part

**Every review frame ever captured was shot from a race that had already died.**

The unattended player car never moves, falls a screen behind, and the Micro Machines elimination rule eliminates it. `_checkRaceOver` treats `player.eliminated` as "player done", flips to `FINISHED`, and after the AI grace period marks the whole field `dnf` and closes the books. Measured with a live race, no fast-forward:

- t=9.7s: state `results`, leader at **8.6% of lap 0**, 7 of 8 cars `finished: true` on lap 0, engine paused, `raceTime` frozen at 9.7 forever.

That is near-identical to the old D8 symptom, which is presumably why it read as fixed — but the mechanism is different, and Race.js is behaving correctly. `?autopilot=1` exists and cures it: with it, at t=21s the state is still `racing` and the player has driven 75% of the lap. The critic capture URL in `tools/capture-set.js` just doesn't pass it.

So the round-2 scores in `CRITIQUE-LOG.md` — and the 4/4 blind A/B — were judged on frames of a stalled, empty race. My baseline `crit-2` and `crit-3` have **no cars in them at all**, which is why.

Two other things visible in the baseline, worth flagging before any critic pass: `crit-1` has a blown-out white blob with **blocky pixel artifacts** (bloom mip aliasing) eating the right third of the frame, and `crit-4` still shows the **hard-edged black wedge** in the lower left.

Before I start, three calls that change what I do:
  - `AskUserQuestion`

**Claude:** Settings noted: small waves (4–6 agents), report between each; harness-only fix for elimination; commit locally per verified wave, no push.

Let me do the one piece of prep that everything else depends on — the review harness — so wave 1 starts on solid ground.
  - `Read: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/tools/capture-set.js`
  - `Edit: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/tools/capture-set.js`

**Claude:** Now the review doc, so critic agents get the right URL:
  - `Edit: /Users/michele.giacobazzi/Desktop/wspace/welld/gauntlet-loop-experiment/.claude/worktrees/gauntlet-loop-experiment-11bcc4/REVIEW.md`

**Claude:** Now verifying the harness end to end — the guard must refuse a dead race and shoot a live one.
  - `mcp__Claude_Browser__navigate: http://localhost:8791/?track=kitchen&skipmenu=1&quality=ultra`

**Claude:** Pausing before wave 1 — understood. Let me just finish verifying the harness change (that's prep, not the wave), then stop.
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`
  - `mcp__Claude_Browser__javascript_tool: javascript_exec`

**Claude:** Paused. And I need to correct something I told you — a second boot contradicted my first finding.

## What I actually established

My baseline capture was definitely shot from a dead race: `race: "results"`, and `crit-2`/`crit-3` have no car in frame. That part is measured and solid. The first boot I instrumented collapsed to `results` at t=9.7s with the leader 8.6% around lap 0 and seven cars flagged finished.

But the second boot, same URL, did something **different and roughly opposite**:

| | car0 | car1 | car2 | car3 | car4 | car5 | car6 | car7 |
|---|---|---|---|---|---|---|---|---|
| lap | 0 | 0 | 1 | 2 | 2 | 0 | 2 | 3 |
| finished | | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| eliminated | ✓ | | | | ✓ | | | |

Every car is finished or eliminated — `running === 0` — and `_checkRaceOver` has two separate branches that should have ended the race on that condition. Yet the state sat at `racing` for the full 66 s I watched, clock still ticking.

So it isn't one clean story. The state machine fails in at least two contradictory ways across boots: once ending a race that had barely started, once refusing to end one where nobody is left running. On a seeded-RNG project that claims determinism, boot-to-boot divergence is itself the more interesting finding.

**This also weakens the guard I just wrote.** I made `captureSet()` refuse unless `race.state === 'racing'`, and this second boot proves `racing` can mean "all eight cars are parked." The guard passed and let me shoot four frames of a field that had stopped racing 20 seconds earlier. A liveness check has to measure *motion* — leader progress advancing between two samples — not trust the state flag.

## Where things are

Committed: nothing. Working tree has [server.js](server.js) (new, verified), [launch.json](.claude/launch.json), and the — now known-insufficient — guard in [capture-set.js](tools/capture-set.js:34) plus the `autopilot=1` note in [REVIEW.md](REVIEW.md:12).

The dev server is running on port 8791 and the game boots clean here: 34 modules, 0 failures, 8 cars.

Wave 1 hasn't started. My read is that it shouldn't until the harness is trustworthy — a critic pass costs real tokens and every frame it scores is worthless if the race behind it has quietly stopped, which is exactly how rounds 1 and 2 appear to have gone. That's a one-agent job, not a wave: replace the state check with a two-sample motion probe, then run the same boot 3–4 times to see how far the divergence goes.

Your call on whether that's the right next step, or whether you had something else in mind for the pause.
