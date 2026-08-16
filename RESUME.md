# MICRO GAUNTLET — how to resume

Rewritten 2026-08-16. The previous version of this file was five weeks and a dozen commits
stale and its "start here" blocker had been fixed long before anyone read it again. **If this
header is more than a few commits behind `git log`, trust the commit messages instead — they
are unusually detailed in this repo and they are the real record.**

## Running it, on this machine

macOS. Node is present, so:

```bash
node server.js
```

Then `http://localhost:8791`. `server.ps1` is the Windows original and is kept for that box.

**The server is not just a static file server.** The capture pipeline POSTs PNGs to `/__shot`
and the server writes them to `shots/`. `python3 -m http.server` would serve the page perfectly
and silently break every review frame.

## Playing it

Enter to start from the menu. `W/↑` throttle, `S/↓` brake — **hold `S` at a standstill for
0.28 s to select reverse, then `S` drives you backwards** (the pedals swap in reverse). `A D`
steer, `Space` handbrake, `Shift` boost, `R` respawn, `V` camera, `Esc` pause, `\` restart.

URL params: `?track=kitchen|garden|workbench|pool|bedroom` `&skipmenu=1` `&t=30` (fast-forward
seconds, capped at 60) `&quality=low|medium|high|ultra` `&cars=8` `&seed=N` `&nohud=1`
`&autopilot=1`.

## Reviewing it — read this before capturing anything

```js
const m = await import('/tools/capture-set.js'); await m.captureSet('r13');
```

Boot with `/?track=kitchen&skipmenu=1&t=30&quality=ultra&autopilot=1&seed=20260730`.

**`autopilot=1` is not optional.** Without it nobody drives car0, it trails the field, gets
eliminated, and the race ends — rounds 1 and 2 of the critique were both scored on a stopped
race with two of four cameras showing no car at all. `captureSet()` now refuses to shoot unless
the field is measurably moving, and it establishes that by *driving* the simulation rather than
watching it.

## The traps, each of which cost a wrong diagnosis

1. **The sim does not run while the browser pane is hidden.** `Engine` pauses itself on
   `document.hidden`. An agent-driven pane is hidden nearly always, so every progress sample
   reads frozen. This is what made two boots of one seeded URL look non-deterministic.
2. **The camera drifts between tool calls.** `captureSet` disables the director and repositions
   the camera for shots 2–4, and the sim advances between calls. Any probe that spans two calls
   is looking at a different camera on a different frame. Freeze the engine and do the whole
   measurement inside ONE call.
3. **Isolate one variable at a time.** A "black wedge" was blamed on the skid ribbon because an
   isolation hid *two* ribbons at once and a plausible story fit. It cost an agent its whole
   slot. It was the ambient-occlusion pass.
4. **`visible = false` and `material.colorWrite = false` are not the same test.** If hiding a
   mesh changes the frame but disabling its colour write does not, something is drawing it
   *without its material* — an override pass. That gap is what found the AO bug.
5. **The browser caches a failed dynamic import for the document's lifetime.** Hard-reload
   before verifying a module that 404'd.
6. **Read the console unfiltered.** A filtered read returned "no logs" while the shader error
   was right there.
7. **Backticks cannot appear in a `/* glsl */` comment.** Four times now, including once in a
   workflow script written to warn agents about it.
8. **`setControls()` is overwritten by Input every step.** Driving the car from a probe requires
   going through `ctx.input.raw`, or the car simply never accelerates and your numbers are
   meaningless.
9. **Parsing is not booting.** Two agents once left files that parsed perfectly and hung the
   boot, because they had written calls to methods they never defined. **Boot is the acceptance
   test.** `grep` for `this.foo(` against defined methods catches this class in seconds.

## Where it stands

34 modules, 0 failures, 8 cars from 3 chassis on the kitchen circuit, races run to a real
classification. Scope is locked to **one track (kitchen) and three chassis (muscle, wedge,
rally)**; the other four tracks still load but get no quality budget.

Critic round 3 — the first ever run on a moving race — scored it against a rubric whose anchors
are 5 = competent hobby, 7 = good indie, 9 = commercial:

| Dimension | R2 | R3 |
|---|---|---|
| Lighting, shadow, grounding | 3 | 5 |
| Materials and texture | 4 | 5 |
| Modelling and silhouette | 4 | 6 |
| Post, colour, tell test | 4 | 6 |
| Camera, composition, world | 5 | 5 |

## Open, in rough priority order

- **Collision "seems flawed"** — a playtest note, not yet measured. Symptom unspecified: could be
  interpenetration, over-bouncy impulses, sticking, or pass-through. `physics/Collision.js`.
- **`SPEED_FRAG` documents the wrong blend function.** It claims additive is `(SrcAlpha, One)`;
  the renderer sets `premultipliedAlpha`, so r180 uses `(ONE, ONE)`. Not currently causing a
  visible defect, but it is a live trap for the next agent in `fx/Trails.js`.
- The tail cap, mirrors and exhaust stubs on the muscle chassis (round-3 modelling findings).
- Round 4 of the critique, to see whether the scores move.

## Working method that has actually worked

Small waves of 3–5 agents on **disjoint files**, each told to write the helper complete before
the call site. Agents cannot drive the browser — one shared pane — so they do source-level work
and the orchestrator verifies centrally by booting and capturing. Commit after every wave that
boots clean. Critics get read access to the source and are told a false finding costs a fix
agent its whole slot; that discipline has produced several "this is not a defect, here is the
arithmetic" results, which are worth as much as the fixes.
