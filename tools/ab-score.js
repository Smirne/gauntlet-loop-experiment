#!/usr/bin/env node
// Score a blind A/B round, and refuse to call one when it did not happen.
//
// D28: four judges, one per camera, 1.0x road wear against 2.4x, from one build
// at one pinned moment so the frames differed ONLY in the wear term. Label
// assignment was mixed, so A was the heavy setting for two pairs and the light
// one for the other two. All four chose A. On the variable that is 2-2, a dead
// null — and every judge wrote a confident, specific rationale, two of them
// describing the 2.4x frame and two describing the 1.0x frame in the same
// sentence.
//
// The mixed assignment DETECTED that. It could not prevent it, and nothing in
// the write-up stage was obliged to look. This is the thing that is obliged to
// look.
//
//   node tools/ab-score.js round.json
//   node tools/ab-score.js --selftest
//
// A round file is:
//
//   {
//     "variable": "roadWear 1.0 vs 2.4",
//     "tasks": [
//       { "id": "cam1-ab", "kind": "real", "cell": "cam1",
//         "first": "variant", "second": "base",
//         "answer": { "anyDifference": true, "differences": ["..."],
//                     "preferred": "first", "confidence": 0.8, "why": "..." } },
//       { "id": "cam1-null", "kind": "null", "cell": "cam1",
//         "first": "base", "second": "base",
//         "answer": { "anyDifference": false, "differences": [], "preferred": "neither" } }
//     ]
//   }
//
// `first`/`second` say which SIDE each frame was shown on; the judge never sees
// them. `kind: "null"` is a pair of identical frames and is the round's own
// noise floor — this project's oldest rule (measure the floor in the same run,
// with the same instrument) applied to judging instead of to pixels.
//
// FOUR WAYS A ROUND FAILS, and each one is a separate verdict rather than a
// footnote on a number:
//
//   VOID     the judges reported differences on identical frames. Nothing they
//            said about the real pairs can be trusted, whatever it was.
//   NULL     the position split is decisive and the variable split is not. That
//            is the D28 signature exactly.
//   SPLIT    the two orders of the same cell disagree about the variable. The
//            round measured the presentation, not the change.
//   VERDICT  a decisive variable split that survives all three checks above.
//
// A round with no null tasks in it cannot return VERDICT. That is deliberate:
// an A/B with no control is the failure this file exists to stop, and making it
// unrepresentable is cheaper than remembering.

/* ------------------------------------------------------------------ scoring */

/**
 * @param {object} round parsed round file
 * @returns {object} the full tally and a verdict
 */
export function score(round) {
  const tasks = Array.isArray(round?.tasks) ? round.tasks : [];
  const real = tasks.filter((t) => t.kind === 'real');
  const nulls = tasks.filter((t) => t.kind === 'null');

  // The floor. A judge that finds a difference between a frame and itself is
  // not measuring the variable, and the ones that did are named so the round
  // can be re-run without them rather than argued about.
  const nullFalse = nulls.filter((t) => answeredDifference(t));
  const nullRate = nulls.length ? nullFalse.length / nulls.length : null;

  // Position: which SIDE was preferred, ignoring what was on it.
  const positioned = real.filter((t) => side(t) === 'first' || side(t) === 'second');
  const firstCount = positioned.filter((t) => side(t) === 'first').length;

  // Variable: which SETTING was preferred, de-positioned.
  const varVotes = positioned.map((t) => (side(t) === 'first' ? t.first : t.second));
  const settings = [...new Set(varVotes)].sort();
  const varTally = {};
  for (const s of settings) varTally[s] = varVotes.filter((v) => v === s).length;
  const [topSetting, topCount] = Object.entries(varTally)
    .sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  // Order agreement: each cell should appear twice, once in each order. A cell
  // whose two orders name different settings measured the presentation.
  const cells = new Map();
  for (const t of positioned) {
    const c = t.cell ?? t.id;
    if (!cells.has(c)) cells.set(c, []);
    cells.get(c).push(side(t) === 'first' ? t.first : t.second);
  }
  const paired = [...cells.entries()].filter(([, v]) => v.length >= 2);
  const agreed = paired.filter(([, v]) => v.every((x) => x === v[0]));
  const unpaired = [...cells.entries()].filter(([, v]) => v.length < 2).map(([c]) => c);

  // Decisiveness. Two-sided sign test against a fair coin: what are the odds of
  // a split this lopsided or worse if the judges were flipping? Small n is the
  // norm here (four judges is a round), so this is exact rather than normal.
  const posP = signTestP(firstCount, positioned.length);
  const varP = signTestP(topCount, positioned.length);
  const ALPHA = 0.05;

  const positionDecisive = posP !== null && posP < ALPHA;
  const variableDecisive = varP !== null && varP < ALPHA;

  // CAN THIS ROUND SAY YES AT ALL?
  //
  // A unanimous split of n judges is p = 2 / 2^n, so four judgements bottom out
  // at 0.125 and can never clear 0.05 however they fall. Every historical round
  // in this project was four judges on four cameras — which means none of them
  // was ever capable of producing a decisive result, and D28's "four out of
  // four" was not even significant as a position split.
  //
  // Six real judgements (three cells, both orders) reach 0.031 when unanimous.
  // That is the floor for a round that is allowed to have an opinion, and a
  // round below it says so instead of returning a quiet NULL that reads like
  // evidence of no difference.
  const bestP = signTestP(positioned.length, positioned.length);
  const underpowered = positioned.length > 0 && bestP !== null && bestP >= ALPHA;

  let verdict;
  let because;
  if (!nulls.length) {
    verdict = 'VOID';
    because = 'no null pairs: a round with no control cannot report a verdict';
  } else if (nullRate > 0.5) {
    verdict = 'VOID';
    because = `judges reported a difference on ${nullFalse.length}/${nulls.length} identical pairs`;
  } else if (!positioned.length) {
    verdict = 'NULL';
    because = 'no judge expressed a preference';
  } else if (positionDecisive && !variableDecisive) {
    verdict = 'NULL';
    because = `position split ${firstCount}/${positioned.length} (p=${fmtP(posP)}) with the variable at `
            + describeTally(varTally) + ' — the judges chose a side, not a setting';
  } else if (paired.length && agreed.length < paired.length) {
    verdict = 'SPLIT';
    because = `${paired.length - agreed.length} of ${paired.length} cells disagree between their two orders`;
  } else if (underpowered) {
    verdict = 'NULL';
    because = `underpowered: ${positioned.length} judgements cannot reach p<${ALPHA} however they fall `
            + `(best possible ${fmtP(bestP)}) — this round was never able to return a verdict. `
            + `Three cells in both orders is the minimum.`;
  } else if (!variableDecisive) {
    verdict = 'NULL';
    because = `variable split ${describeTally(varTally)} (p=${fmtP(varP)}) is not decisive at ${ALPHA}`;
  } else {
    verdict = 'VERDICT';
    because = `${topSetting} wins ${describeTally(varTally)} (p=${fmtP(varP)}), position `
            + `${firstCount}/${positioned.length} (p=${fmtP(posP)}), all cells agree across orders`;
  }

  return {
    variable: round?.variable ?? null,
    verdict,
    because,
    winner: verdict === 'VERDICT' ? topSetting : null,
    tasks: { real: real.length, null: nulls.length, withPreference: positioned.length },
    floor: { nullPairs: nulls.length, falseDifferences: nullFalse.length, rate: nullRate,
             offenders: nullFalse.map((t) => t.id) },
    power: { judgements: positioned.length, bestPossibleP: bestP, underpowered },
    position: { first: firstCount, second: positioned.length - firstCount, p: posP },
    variable_: { tally: varTally, p: varP },
    orders: { cells: cells.size, paired: paired.length, agreed: agreed.length, unpaired },
  };
}

/** Did the judge claim a difference? Naming one counts, even if the box says no. */
function answeredDifference(t) {
  const a = t?.answer ?? {};
  if (a.anyDifference === true) return true;
  if (Array.isArray(a.differences) && a.differences.length) return true;
  // A preference on a pair of identical frames IS a claimed difference. Judges
  // reach for one out of politeness; the protocol says "neither" is a real
  // answer, and this is what makes saying so matter.
  return a.preferred === 'first' || a.preferred === 'second';
}

function side(t) {
  const p = t?.answer?.preferred;
  return p === 'first' || p === 'second' ? p : 'neither';
}

function describeTally(tally) {
  return Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' / ') || 'nothing';
}

/**
 * Two-sided sign test: P(a split at least this lopsided | fair coin).
 * Exact binomial, because a round is four to eight judges and the normal
 * approximation is wrong at that size in the direction that flatters us.
 */
export function signTestP(k, n) {
  if (!n) return null;
  const hi = Math.max(k, n - k);
  let tail = 0;
  for (let i = hi; i <= n; i++) tail += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * tail);
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function fmtP(p) {
  return p === null ? 'n/a' : p < 0.001 ? '<0.001' : p.toFixed(3);
}

/* -------------------------------------------------------------------- CLI */

function report(res) {
  const L = [];
  L.push(`variable   ${res.variable ?? '(unnamed)'}`);
  L.push(`VERDICT    ${res.verdict}`);
  L.push(`           ${res.because}`);
  L.push('');
  L.push(`floor      ${res.floor.falseDifferences}/${res.floor.nullPairs} null pairs called different`
       + (res.floor.offenders.length ? `  [${res.floor.offenders.join(', ')}]` : ''));
  L.push(`position   first ${res.position.first} / second ${res.position.second}   p=${fmtP(res.position.p)}`);
  L.push(`variable   ${describeTally(res.variable_.tally)}   p=${fmtP(res.variable_.p)}`);
  L.push(`power      ${res.power.judgements} judgements, best possible p=${fmtP(res.power.bestPossibleP)}`
       + (res.power.underpowered ? '  — TOO SMALL TO CONCLUDE' : ''));
  L.push(`orders     ${res.orders.agreed}/${res.orders.paired} cells agree across both orders`
       + (res.orders.unpaired.length ? `  (unpaired: ${res.orders.unpaired.join(', ')})` : ''));
  return L.join('\n');
}

/**
 * The retro-test. The road-wear round is the reason this file exists, so it is
 * the first thing the file is asked to score: if it does not call that one a
 * NULL, it is not worth running.
 */
const SELFTESTS = [
  {
    name: 'D28 as it actually happened: 4/4 on position, 2-2 on the variable',
    round: {
      variable: 'roadWear 1.0 vs 2.4',
      tasks: [
        real('cam1', 'heavy', 'light', 'first'),
        real('cam2', 'light', 'heavy', 'first'),
        real('cam3', 'heavy', 'light', 'first'),
        real('cam4', 'light', 'heavy', 'first'),
        nul('cam1'), nul('cam2'), nul('cam3'), nul('cam4'),
      ],
    },
    want: 'NULL',
  },
  {
    name: 'a real difference, both orders agreeing, clean floor',
    round: {
      variable: 'shadows off vs on',
      tasks: [
        real('cam1', 'on', 'off', 'first'),
        real('cam1r', 'off', 'on', 'second', 'cam1'),
        real('cam2', 'off', 'on', 'second'),
        real('cam2r', 'on', 'off', 'first', 'cam2'),
        real('cam3', 'on', 'off', 'first'),
        real('cam3r', 'off', 'on', 'second', 'cam3'),
        nul('cam1'), nul('cam2'), nul('cam3'),
      ],
    },
    want: 'VERDICT',
  },
  {
    name: 'judges inventing differences between a frame and itself',
    round: {
      variable: 'anything',
      tasks: [
        real('cam1', 'a', 'b', 'first'),
        real('cam1r', 'b', 'a', 'second', 'cam1'),
        { id: 'n1', kind: 'null', cell: 'cam1', first: 'a', second: 'a',
          answer: { anyDifference: true, differences: ['the second is warmer'], preferred: 'second' } },
        { id: 'n2', kind: 'null', cell: 'cam2', first: 'a', second: 'a',
          answer: { anyDifference: true, differences: ['sharper kerbs on the left'], preferred: 'first' } },
      ],

    },
    want: 'VOID',
  },
  {
    name: 'the two orders of a cell name different settings',
    round: {
      variable: 'bloom 0.4 vs 0.7',
      tasks: [
        real('cam1', 'hi', 'lo', 'first'),
        real('cam1r', 'lo', 'hi', 'first', 'cam1'),   // same side, so opposite setting
        real('cam2', 'hi', 'lo', 'first'),
        real('cam2r', 'lo', 'hi', 'second', 'cam2'),
        real('cam3', 'hi', 'lo', 'first'),
        real('cam3r', 'lo', 'hi', 'second', 'cam3'),
        nul('cam1'), nul('cam2'),
      ],
    },
    want: 'SPLIT',
  },
  {
    name: 'a round with no control at all cannot report a verdict',
    round: {
      variable: 'no floor taken',
      tasks: [
        real('cam1', 'on', 'off', 'first'),
        real('cam1r', 'off', 'on', 'second', 'cam1'),
        real('cam2', 'on', 'off', 'first'),
        real('cam2r', 'off', 'on', 'second', 'cam2'),
        real('cam3', 'on', 'off', 'first'),
        real('cam3r', 'off', 'on', 'second', 'cam3'),
      ],
    },
    want: 'VOID',
  },
];

function real(id, first, second, preferred, cell) {
  return { id, kind: 'real', cell: cell ?? id, first, second,
           answer: { anyDifference: true, differences: ['(stated)'], preferred, confidence: 0.8 } };
}
function nul(cell) {
  return { id: `${cell}-null`, kind: 'null', cell, first: 'base', second: 'base',
           answer: { anyDifference: false, differences: [], preferred: 'neither' } };
}

export function selftest() {
  let bad = 0;
  for (const t of SELFTESTS) {
    const got = score(t.round).verdict;
    const ok = got === t.want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${t.want.padEnd(7)} ${ok ? '' : `(got ${got}) `}${t.name}`);
  }
  console.log(bad ? `\n${bad} failing` : '\nall pass');
  return bad === 0;
}

if (process.argv[1] && process.argv[1].endsWith('ab-score.js')) {
  const arg = process.argv[2];
  if (!arg || arg === '--selftest') {
    process.exit(selftest() ? 0 : 1);
  } else {
    const fs = await import('node:fs');
    console.log(report(score(JSON.parse(fs.readFileSync(arg, 'utf8')))));
  }
}
