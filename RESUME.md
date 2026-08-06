# MICRO GAUNTLET — how to resume

Paused 2026-07-31 08:10. Everything is committed on `main`. Nothing is in flight.

## Where it stands

**1,317 KB of source across 28 modules.** The game boots, builds the kitchen circuit
(1854 units, 20 checkpoints, 12 spawn points) and renders it. See `shots/first-world.png`.

| Area | State |
|---|---|
| core | ✅ Engine (fixed 120 Hz), Settings, Random, EventBus, Debug |
| render | ✅ Renderer, Lighting (cascaded shadows, 6 presets), PostFX (12 passes), Sky |
| textures | ✅ ProcTex foundry, Surfaces library |
| materials | ✅ incl. carPaint with metallic flake + clearcoat (bug fixed, verified) |
| world | ✅ Track, TrackBuilder, RacingLine, Props, Decals, **5 circuits** |
| vehicle | ✅ Vehicle, Tires, CarModels (8 chassis), VehicleVisual |
| physics | ✅ World, Collision |
| game | ✅ Race, Director, Input |
| ai | ❌ `src/ai/Driver.js` |
| fx | ❌ `src/fx/Particles.js`, `Trails.js`, `Impacts.js` |
| audio | ❌ `src/audio/Audio.js`, `EngineSound.js`, `Sfx.js`, `Music.js` |
| ui | ❌ `src/ui/HUD.js`, `Menu.js`, `Results.js` (`style.css` exists) |

## Start here — the one blocker

**No cars spawn.** `window.__mgReady.vehicles === 0` even though `CarModels` exposes 8 models
and the track has 12 spawn points. The vehicle construction loop in `src/main.js` (search
`FIELD`) builds `Vehicle` with a `model` id taken from `Object.keys(CAR_MODELS)`; either the
constructor is throwing (check `window.MG.status.failed` for `Vehicle[0]`) or the id shape
doesn't match what `Vehicle.js` expects. Diagnose that first — nothing else can be judged
until cars are on the track.

Then, from `shots/first-world.png`, the visual issues to hand to a critic pass:
- The road ribbon reads washed-out and pale against the table; it doesn't sit *on* the wood.
- The whole frame is hazy and low-contrast — fog density or exposure is likely too high.
- Tilt-shift isn't visibly reading; the miniature illusion depends on it.
- Some props (napkins, cutlery) are flat quads that read as decals, not objects.

## Running it

No build step, no dependencies — Three.js r180 is vendored in `vendor/three/` and committed.
Any static file server works. Serve the repo root, open the page.

Windows (what this session used):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
```

macOS / Linux — anything equivalent is fine:

```bash
python3 -m http.server 8791
```

Then open `http://localhost:8791`. In Claude Code, the `micro-gauntlet` entry in
`.claude/launch.json` starts the PowerShell server via `preview_start`; on a non-Windows
machine, edit that entry to your server command and keep `"port": 8791`.

### URL parameters

`?track=kitchen|garden|workbench|pool|bedroom` `&skipmenu=1` `&t=6` (fast-forward seconds)
`&quality=low|medium|high|ultra` `&cars=8` `&seed=N` `&nohud=1`

### Screenshots (how visual review works)

The browser pane doesn't reliably composite frames, so normal screenshotting fails. The page
renders on demand and POSTs a PNG to the dev server, which writes it to `shots/`:

```js
await window.MG.capture('name', 1920, 1080)   // -> shots/name.png
window.MG.probe()                             // { meanLuma, maxLuma } black-frame check
window.MG.status                              // per-module load/construct results
```

Then read the PNG off disk. `shots/` is gitignored.

**Two traps that cost time in this session — don't repeat them:**
1. The browser caches a *failed* dynamic import for the document's lifetime. A module that
   404'd at boot keeps returning the cached rejection after the file lands. **Hard-reload
   before verifying anything.**
2. Read the console **unfiltered**. A filtered read returned "no logs" and I concluded there
   was no shader error when the error was right there. That cost two wrong diagnoses.
3. Boot takes several seconds on a slow CPU (texture baking + track build). Probing too early
   looks like a boot failure. Check `window.MG.status` exists before concluding anything.

## Switching machines — yes, easily

The repo is fully self-contained: vendored Three.js, zero npm dependencies, no build step,
all art generated procedurally in code. Nothing is machine-specific except `server.ps1`.

The remote is `https://github.com/Smirne/gauntlet-loop-experiment` and `main` tracks
`origin/main`, so on another machine it is just:

```bash
git clone https://github.com/Smirne/gauntlet-loop-experiment
```

Copying the folder directly also works (~15 MB, mostly `vendor/`). Either way, serve the root
with any static server as above — there is nothing to install.

**Do not commit or push while a fix workflow is in flight.** Agents edit files in the working
tree as they go, so a commit taken mid-wave captures half-written modules. Wait for the wave
to report, boot the game, confirm 34 modules and zero failures, then commit.

A faster machine is worth it. This one is a 2-core i7-7500U, which capped parallel agents at
`min(16, cores-2)` = **2 at a time**. A 8+ core machine would run 6+ agents concurrently and
cut the remaining build from hours to well under one.

## Resuming the build

Remaining work is one batch of four independent subsystems — AI, fx, audio, UI — with no
interdependencies, so they can all run in parallel. The prompt pattern that worked is in
`.claude`-adjacent workflow scripts under the session dir, but it's simple to restate:

> Read `ARCHITECTURE.md` (binding contract), `REVIEW.md` (quality bar) and `DEFECTS.md`.
> Everything except ai/fx/audio/ui is already built — read the real exports of the modules
> you depend on, especially `src/main.js` for wiring. Zero dependencies, zero binary assets,
> everything procedural, 1 unit = 1 cm, gravity 260, seeded RNG only. Build `<subsystem>`.

After that: fix the remaining items in `DEFECTS.md` (D3 rubber too black, D4
brushedAluminium reads as matte blue paint, D5 oak knots blue-tinted), then run the critic
loop in `REVIEW.md` — capture at 1920×1080, score against the rubric, fix, re-capture, and
blind-A/B successive iterations with randomised labels so regressions can win.

## Honest state of the goal

This is a solid, real foundation with a genuine art direction — not a demo. It is **not yet**
at the bar the brief set. No frame has been through a hostile critic pass, the cars aren't
on track, and four subsystems are missing. The remaining work is well-specified rather than
exploratory, which is the good position to be paused in.
