#!/usr/bin/env node
// Run a critic round that knows what a critic says about a GOOD frame.
//
// The blind A/B has a control now (ab-round.js puts a frame against itself and
// counts how often a judge finds a difference that is not there). The critic
// round had none, and it needs one more badly, because the brief in REVIEW.md
// opens with "your job is to be hostile, the default verdict is not good
// enough". A critic told that will produce a list of faults for any frame you
// hand it. Nine defects on an unreviewed circuit means nothing until you know
// how many the same critic finds on one that has already been through the loop
// twenty-four times.
//
// So every round shoots two circuits: the one under test, and a REVIEWED one as
// the floor. Same brief, same cameras, judges shuffled together and told
// nothing about which is which. What survives is the DIFFERENCE between them.
//
//   node tools/critique-round.js build spec.json rounds/bedroom-crit
//   ...one judge per rounds/bedroom-crit/c*/ , each writing answer.json...
//   node tools/critique-round.js collect rounds/bedroom-crit
//   node tools/critique-round.js score   rounds/bedroom-crit
//
// A spec is:
//
//   { "test":    { "name": "bedroom", "frames": { "gameplay": "shots/a.jpg" } },
//     "control": { "name": "kitchen", "frames": { "gameplay": "shots/b.jpg" } },
//     "seed": 77 }
//
// Category 7 (UI & type) is absent on purpose: REVIEW.md records that it cannot
// be judged from an MG.capture() frame, which does not composite the DOM, and
// that scoring it anyway has already cost one round.

import fs from 'node:fs';
import path from 'node:path';

const CATS = [
  [1, 'Materials & texture'],
  [2, 'Lighting & shadow'],
  [3, 'Post & grade'],
  [4, 'Geometry & silhouette'],
  [5, 'Effects'],
  [6, 'Composition & camera'],
  [8, 'Environment richness'],
  [9, 'Cohesion'],
];

const BRIEF = `# Visual review of one frame

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

## Write your answer to \`answer.json\`

\`\`\`json
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
\`\`\`

Rules:

- Describe **before** you criticise. Do not revise the description afterwards.
- \`severity\` is \`"minor"\`, \`"major"\` or \`"critical"\`.
- Every defect must be something you can point at in **this** frame. Not "the
  lighting could be better" — *where*, *what*, and *why it is wrong*.
- **A frame can be good.** If a category genuinely deserves 8 or 9, give it 8 or
  9, and if you cannot find a real fault in a category, do not invent one to
  fill the list. Some frames in this batch come from a part of the game that has
  already been through many rounds of exactly this review. Padding the list on
  those is not hostility, it is noise, and it makes the whole round worthless.
- You are judging this frame alone. You have no other context and should not
  guess at any.
`;

function build(specPath, outDir) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const rng = mulberry32(spec.seed ?? 1);
  const tasks = [];
  for (const side of ['test', 'control']) {
    const c = spec[side];
    if (!c) throw new Error(`spec has no ${side} circuit — a round without a floor is the thing this replaces`);
    for (const [cell, file] of Object.entries(c.frames || {})) {
      if (!fs.existsSync(file)) throw new Error(`missing frame: ${file}`);
      tasks.push({ side, circuit: c.name, cell, file });
    }
  }
  shuffle(tasks, rng);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const round = { test: spec.test.name, control: spec.control.name, builtFrom: specPath, tasks: [] };
  tasks.forEach((t, i) => {
    const id = `c${String(i + 1).padStart(2, '0')}`;
    const dir = path.join(outDir, id);
    fs.mkdirSync(dir);
    fs.copyFileSync(t.file, path.join(dir, 'frame' + path.extname(t.file)));
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), BRIEF);
    round.tasks.push({ id, side: t.side, circuit: t.circuit, cell: t.cell, source: t.file, answer: null });
  });
  fs.writeFileSync(path.join(outDir, 'round.json'), JSON.stringify(round, null, 1));
  return `built ${round.tasks.length} critiques in ${outDir} `
       + `(${round.tasks.filter((t) => t.side === 'test').length} ${round.test}, `
       + `${round.tasks.filter((t) => t.side === 'control').length} ${round.control} as the floor)`;
}

function collect(outDir) {
  const rp = path.join(outDir, 'round.json');
  const round = JSON.parse(fs.readFileSync(rp, 'utf8'));
  const bad = [];
  for (const t of round.tasks) {
    const p = path.join(outDir, t.id, 'answer.json');
    if (!fs.existsSync(p)) { bad.push(t.id); continue; }
    let a;
    try { a = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { bad.push(`${t.id} (${e.message})`); continue; }
    if (!a.describe || !a.scores) { bad.push(`${t.id} (incomplete)`); continue; }
    t.answer = a;
  }
  fs.writeFileSync(rp, JSON.stringify(round, null, 1));
  return `collected ${round.tasks.filter((t) => t.answer).length}/${round.tasks.length}`
       + (bad.length ? `\nnot usable: ${bad.join(', ')}` : '');
}

function scoreDir(outDir) {
  const round = JSON.parse(fs.readFileSync(path.join(outDir, 'round.json'), 'utf8'));
  const done = round.tasks.filter((t) => t.answer);
  const bySide = (s) => done.filter((t) => t.side === s);
  const test = bySide('test'), control = bySide('control');

  const cats = CATS.map(([n, label]) => {
    const t = mean(test.map((x) => num(x.answer.scores?.[n])));
    const c = mean(control.map((x) => num(x.answer.scores?.[n])));
    return { n, label, test: t, control: c, delta: t === null || c === null ? null : +(t - c).toFixed(2) };
  });

  const sev = (list, s) => list.reduce((a, t) =>
    a + (t.answer.defects || []).filter((d) => (d.severity || '').toLowerCase() === s).length, 0);
  const defects = {
    test: { critical: sev(test, 'critical'), major: sev(test, 'major'), minor: sev(test, 'minor'),
            total: test.reduce((a, t) => a + (t.answer.defects || []).length, 0) },
    control: { critical: sev(control, 'critical'), major: sev(control, 'major'), minor: sev(control, 'minor'),
               total: control.reduce((a, t) => a + (t.answer.defects || []).length, 0) },
  };

  // What actually counts as a finding: a category where the circuit under test
  // scores materially below the reviewed one. Anything the two share is the
  // critic's own baseline hostility, not a fact about this circuit.
  const FLOOR = 1.0;
  const real = cats.filter((c) => c.delta !== null && c.delta <= -FLOOR)
                   .sort((a, b) => a.delta - b.delta);
  const shared = cats.filter((c) => c.delta !== null && Math.abs(c.delta) < FLOOR);

  const out = {
    test: round.test, control: round.control,
    critiques: { test: test.length, control: control.length },
    categories: cats,
    defects,
    belowTheFloor: real.map((c) => `${c.n} ${c.label}: ${c.test} vs ${c.control} (${c.delta})`),
    indistinguishable: shared.map((c) => `${c.n} ${c.label}`),
    worst: test.map((t) => ({ cell: t.cell, worst: t.answer.worst })),
    tells: { test: test.map((t) => t.answer.tell).filter(Boolean),
             control: control.map((t) => t.answer.tell).filter(Boolean) },
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(out, null, 1));
  return out;
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function mean(xs) { const v = xs.filter((x) => x !== null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; }
function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
}

const [, , cmd, a, b] = process.argv;
try {
  if (cmd === 'build') console.log(build(a, b));
  else if (cmd === 'collect') console.log(collect(a));
  else if (cmd === 'score') console.log(JSON.stringify(scoreDir(a), null, 1));
  else console.log('usage: critique-round.js build <spec.json> <outdir> | collect <outdir> | score <outdir>');
} catch (err) { console.error(`critique-round: ${err.message}`); process.exit(1); }
