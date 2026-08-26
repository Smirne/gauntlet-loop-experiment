#!/usr/bin/env node
// Run a blind A/B round that can come back saying "nothing here".
//
// D28 is why. The road-wear round put four judges on four camera angles with
// the labels mixed, all four picked the frame on the LEFT, and the write-up
// read that as a win because nobody was obliged to count the sides. Mixed
// labels detected the bias. They could not stop it being reported as a result.
//
// This builds the round so that the bias, if it is there, has to show up as a
// number next to the verdict — and adds the two things the old protocol had no
// way to express:
//
//   NULL PAIRS. Every cell also gets a pair of IDENTICAL frames. A judge that
//   finds a difference there is not measuring the variable, and the round says
//   so out loud instead of averaging it in. This is the project's oldest rule —
//   measure the floor in the same run, with the same instrument — pointed at
//   the judges rather than at the pixels.
//
//   BOTH ORDERS. Every cell is judged twice, once each way round, by different
//   judges who never see each other. If the two orders name different settings,
//   the round measured the presentation.
//
//   node tools/ab-round.js build spec.json rounds/bedroom
//   ...dispatch one judge per rounds/bedroom/t*/ , each writing answer.json...
//   node tools/ab-round.js collect rounds/bedroom
//   node tools/ab-round.js score   rounds/bedroom
//
// A spec is:
//
//   { "variable": "bedroom lighting: shipped vs warmer key",
//     "settings": { "a": "shipped", "b": "warm" },
//     "seed": 4127,
//     "cells": [ { "cell": "chase", "a": "shots/bed-chase-ship.jpg",
//                                   "b": "shots/bed-chase-warm.jpg" } ] }
//
// TASK IDS CARRY NOTHING. They are t01, t02, ... in a seeded shuffle, so a
// judge cannot infer from its own id which cell it has, whether its pair is a
// control, or what any other judge was given. The mapping lives in round.json,
// which the judges are never pointed at.

import fs from 'node:fs';
import path from 'node:path';
import { score } from './ab-score.js';

const BRIEF = `# You are judging two frames from a video game.

Two images sit next to this file: **first.jpg** and **second.jpg**. Look at both.

Write your answer to \`answer.json\` in this same directory, with exactly these
fields, **filled in from top to bottom, in this order**:

\`\`\`json
{
  "describeFirst":  "what you see in first.jpg, on its own terms",
  "describeSecond": "what you see in second.jpg, on its own terms",
  "differences":    ["each concrete difference you can actually point at"],
  "anyDifference":  true,
  "preferred":      "first",
  "confidence":     0.7,
  "why":            "why the one you chose is better, or why neither is"
}
\`\`\`

## The order matters

Describe each image **before** you compare them, and list the differences
**before** you decide which you prefer. Do not skip ahead and do not revise the
earlier fields once you have picked a side. A judge that decides first and finds
reasons afterwards is the exact failure this round is built to catch.

## "No difference" is a real answer

Some pairs in this round are **identical images**. They are there deliberately.
If you cannot point at a difference, set \`anyDifference\` to false, leave
\`differences\` empty, and set \`preferred\` to \`"neither"\`. That is a useful,
correct, valued answer and it costs you nothing. Reaching for a preference you
cannot justify is what damages the round.

Likewise, if the two images differ but neither is better, say \`"neither"\`.

## Rules

- \`preferred\` is \`"first"\`, \`"second"\`, or \`"neither"\`.
- \`confidence\` is 0 to 1. Use low numbers when you mean them.
- Judge **by looking**. Do not diff the files, hash them, or read their bytes.
  The question is what a player would see, not what \`cmp\` would find.
- Every \`difference\` must be something you could point to in the frame. Not
  "the second feels more cohesive" — *where*, and *what*.
- You are judging these two frames only. There is no other context, and nothing
  you have been told about the project should enter the answer.
`;

/* -------------------------------------------------------------------- build */

function build(specPath, outDir) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const cells = spec.cells || [];
  if (!cells.length) throw new Error('spec has no cells');
  const rng = mulberry32(spec.seed ?? 1);

  const tasks = [];
  for (const c of cells) {
    must(c.a); must(c.b);
    // Both orders of the real pair, as two separate tasks for two separate
    // judges. Same frames, opposite sides.
    tasks.push({ kind: 'real', cell: c.cell, first: 'a', second: 'b', files: [c.a, c.b] });
    tasks.push({ kind: 'real', cell: c.cell, first: 'b', second: 'a', files: [c.b, c.a] });
    // The control: one frame against itself.
    const same = spec.nullFrom === 'b' ? c.b : c.a;
    tasks.push({ kind: 'null', cell: c.cell, first: 'a', second: 'a', files: [same, same] });
  }
  shuffle(tasks, rng);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const round = { variable: spec.variable ?? null, settings: spec.settings ?? null,
                  builtFrom: specPath, tasks: [] };
  tasks.forEach((t, i) => {
    const id = `t${String(i + 1).padStart(2, '0')}`;
    const dir = path.join(outDir, id);
    fs.mkdirSync(dir);
    fs.copyFileSync(t.files[0], path.join(dir, 'first' + path.extname(t.files[0])));
    fs.copyFileSync(t.files[1], path.join(dir, 'second' + path.extname(t.files[1])));
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), BRIEF);
    round.tasks.push({ id, kind: t.kind, cell: t.cell, first: t.first, second: t.second,
                       sources: t.files, answer: null });
  });
  fs.writeFileSync(path.join(outDir, 'round.json'), JSON.stringify(round, null, 1));

  const real = round.tasks.filter((t) => t.kind === 'real').length;
  return `built ${round.tasks.length} tasks in ${outDir}  (${real} real, ${round.tasks.length - real} control)\n`
       + `judges must not be shown round.json — point each at ${outDir}/<id>/ only`;
}

function must(p) { if (!p || !fs.existsSync(p)) throw new Error(`missing frame: ${p}`); }

/* ------------------------------------------------------------------ collect */

function collect(outDir) {
  const roundPath = path.join(outDir, 'round.json');
  const round = JSON.parse(fs.readFileSync(roundPath, 'utf8'));
  const missing = [];
  for (const t of round.tasks) {
    const p = path.join(outDir, t.id, 'answer.json');
    if (!fs.existsSync(p)) { missing.push(t.id); continue; }
    let a;
    try { a = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (err) { missing.push(`${t.id} (unparseable: ${err.message})`); continue; }
    // An answer that skipped the description fields did not follow the
    // protocol, and a round scored on those answers is not this protocol's
    // round. Refuse it here rather than discovering it in the write-up.
    if (!a.describeFirst || !a.describeSecond) { missing.push(`${t.id} (no description)`); continue; }
    t.answer = a;
  }
  fs.writeFileSync(roundPath, JSON.stringify(round, null, 1));
  const have = round.tasks.filter((t) => t.answer).length;
  return `collected ${have}/${round.tasks.length}`
       + (missing.length ? `\nnot usable: ${missing.join(', ')}` : '');
}

/* -------------------------------------------------------------------- score */

function scoreDir(outDir) {
  const round = JSON.parse(fs.readFileSync(path.join(outDir, 'round.json'), 'utf8'));
  const scored = { ...round, tasks: round.tasks.filter((t) => t.answer) };
  const res = score(scored);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(res, null, 1));
  return res;
}

/* ---------------------------------------------------------------- plumbing */

function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const [, , cmd, a, b] = process.argv;
try {
  if (cmd === 'build') console.log(build(a, b));
  else if (cmd === 'collect') console.log(collect(a));
  else if (cmd === 'score') console.log(JSON.stringify(scoreDir(a), null, 1));
  else console.log('usage: ab-round.js build <spec.json> <outdir> | collect <outdir> | score <outdir>');
} catch (err) {
  console.error(`ab-round: ${err.message}`);
  process.exit(1);
}
