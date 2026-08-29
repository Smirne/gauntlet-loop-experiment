// D56: "sometimes I get eliminated while there are still active cars behind me".
//
// The source already explains how that is possible, and does it deliberately.
// The HUD's position number is an index into `standings`, which `compareEntries`
// sorts by `e.score`. Elimination does not use that order at all: it scans the
// running cars for the minimum `e.roadDistance` and takes that one out. Both
// choices are defended at their sites and both are right on their own terms —
// score carries the cut penalty, which belongs in the classification and would
// be brutal in a spatial rule; roadDistance is where the car actually is.
//
// What nothing defends is the pair. The player is shown one order and judged by
// another, and is never shown the second. So "there were cars behind me" is not
// a misreading — it is the game's own HUD, disagreeing with the game's own
// elimination.
//
// This measures how often the two disagree at the only moment it matters. For
// every elimination in a race it records:
//
//   hudPos        the victim's position number, i.e. what the HUD was showing
//   running       how many cars were still running
//   hudBehind     how many RUNNING cars the HUD ranked BEHIND the victim
//   roadRank      the victim's rank by roadDistance (always 1 of N from the back,
//                 by construction — kept as a check that the rule did what it says)
//   scoreGapToNextWorst / roadGapToNextWorst
//
// `hudBehind > 0` is the defect, stated in the player's own terms: the game told
// them N cars were behind, then eliminated them anyway.
//
// Driven by hand off a synthetic clock rather than on rAF, for the reason every
// tool here now does: the browser pane throttles rAF to roughly 0.1 s of race
// per composite, so a real race never finishes. `_tick` runs lateUpdate, so the
// director and the whole race analysis advance exactly as they would live.
//
//   const m = await import('/tools/elim-probe.js');
//   await m.race({ laps: 3 });          // one race
//   await m.many({ races: 6 });         // several, with a summary
//
// Nothing here changes the game. It only watches.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Snapshot the field at the instant of an elimination. */
function snapshot(race, victim) {
  const running = race.entries.filter((e) => !e.finished && !e.eliminated);
  // `victim` has already been flagged by the time the event fires, so it is not
  // in `running` any more — put it back for the comparison, which is about the
  // moment BEFORE it went.
  const field = running.slice();
  if (!field.includes(victim)) field.push(victim);

  const byScore = field.slice().sort((a, b) => b.score - a.score);
  const byRoad = field.slice().sort((a, b) => b.roadDistance - a.roadDistance);

  const hudIdx = byScore.indexOf(victim);
  const roadIdx = byRoad.indexOf(victim);

  const worseOnRoad = field.filter((e) => e !== victim && e.roadDistance < victim.roadDistance);

  return {
    at: +race.raceTime.toFixed(2),
    victim: victim.vehicle?.id ?? victim.name ?? '?',
    isPlayer: !!victim.isPlayer,
    running: field.length,
    // What the HUD was showing. `position` is set from the standings index, so
    // this is literally the number on screen.
    hudPos: victim.lastPosition && victim.position < 0 ? victim.lastPosition : hudIdx + 1,
    hudBehind: field.length - (hudIdx + 1),
    roadRank: roadIdx + 1,
    roadBehind: worseOnRoad.length,
    lap: victim.lap ?? null,
    roadDistance: Math.round(victim.roadDistance),
    leaderRoad: Math.round(byRoad[0]?.roadDistance ?? 0),
    gap: +(race.elimination?.gap ?? 0).toFixed(1),
    // The names the HUD had behind the victim, for a human to sanity-check.
    behindNames: byScore.slice(hudIdx + 1).map((e) => e.vehicle?.id ?? e.name ?? '?'),
  };
}

/**
 * Run one race to completion (or a tick cap) and collect every elimination.
 * @param {{laps?: number, maxTicks?: number, hz?: number}} [opts]
 */
export async function race(opts = {}) {
  const MG = window.MG;
  const engine = MG.engine;
  const r = MG.ctx.race;
  const bus = MG.ctx.bus;
  const hz = opts.hz ?? 60;
  const stepMs = 1000 / hz;
  const maxTicks = opts.maxTicks ?? 30000;

  const events = [];
  const off = bus.on('race:eliminated', (p) => {
    const victim = p?.entry || p?.victim;
    if (victim) { try { events.push(snapshot(r, victim)); } catch (err) { events.push({ error: String(err) }); } }
  });

  // GIVE THE PLAYER A DRIVER, or this measures nothing.
  //
  // main.js builds a Driver for every car EXCEPT car 0, because car 0 is you.
  // With no input source the player's car barely moves: measured, it finished a
  // 36-second stretch on roadDistance 581 against the leader's 2022, which makes
  // it last on BOTH orders and makes `hudBehind = 0` true for a reason that has
  // nothing to do with the question. The first run of this probe did exactly
  // that and returned six clean zeroes across six races — a null that looked
  // like an answer and was really a broken setup.
  //
  // So the player gets the same AI as everyone else, at mid-field skill. It is
  // then a real race, and the two orders have somewhere to disagree.
  let borrowedDriver = null;
  let wasAutoPoll;
  let inputWas;
  if (opts.autopilot !== false) {
    const player = MG.ctx.player;
    const already = (MG.ctx.drivers || []).some((d) => d.vehicle === player);
    if (player && !already) {
      const { Driver } = await import('/src/ai/Driver.js');
      borrowedDriver = new Driver(MG.ctx, player, {
        skill: opts.skill ?? 0.84, aggression: 0.45, consistency: 0.88, seed: opts.seed ?? 4242,
      });
      // NOT `engine.add`. It appends, which puts this driver AFTER the vehicles
      // in the registry, and that is a different loop from the one every real
      // driver runs in: main.js registers `...ctx.drivers` BEFORE
      // `...ctx.vehicles`, so a rival decides its steering and the car consumes
      // it in the same frame. Appended, the decision lands a frame late, the
      // feedback loop closes on stale state, and the steering saturates —
      // measured: throttle 0.98 with steer pinned at 1.0, the car grinding in
      // place at trackT 0.058 -> 0.101 over twelve seconds.
      //
      // So it is driven by hand, immediately before the tick that consumes it.
      // Same order as a rival, no registry surgery.
      //
      // And Input has to be told something else has the wheel, or nothing else
      // matters. Input does not merely fail to help — it ACTIVELY drives the
      // player every frame, `player.setControls(c)` with `this.raw.*`, which is
      // all zeros when no human is at the keyboard. That overwrote the driver
      // no matter where in the frame it ran, which is why disabling Vehicle's
      // `_pollInput` alone changed nothing and the car still crawled at a
      // quarter of the leader's pace through three separate attempts.
      //
      // The module documents the handoff at the top of the file — "Race can
      // hand the player to an autopilot (attract mode, headless capture); Input
      // asks before it writes, and zeroes the controls exactly once on the way
      // out." Not accepting is the supported way to take the wheel, so take it
      // that way rather than fighting for it.
      wasAutoPoll = player.autoPollInput;
      player.autoPollInput = false;
      inputWas = MG.ctx.input?.enabled;
      if (MG.ctx.input) MG.ctx.input.enabled = false;
    }
  }

  const wasRunning = engine.running;
  engine.stop();
  if (engine.paused) engine.resume('elimprobe');

  // Do not draw. This probe reads the race's own bookkeeping — scores, road
  // distances, standings — and none of that is downstream of a rendered pixel.
  // Leaving the render in costs about 4 ms a tick, which turns a three-lap race
  // into minutes of blocked main thread for no information at all. Stubbing it
  // makes the same race run in seconds.
  //
  // The limit this creates, stated rather than hidden: anything that only
  // happens at render time is absent here. That is fine for D56, which is a
  // disagreement between two numbers, and would NOT be fine for a timing
  // question — D58's stalls, for instance, are invisible under this stub.
  const origRender = engine.renderFrame;
  engine.renderFrame = function () { return this; };
  r.restart();
  if (opts.laps) r.totalLaps = opts.laps;
  r.start();

  let clock = performance.now();
  let ticks = 0;
  try {
    while (ticks < maxTicks) {
      clock += stepMs;
      if (borrowedDriver) {
        try { borrowedDriver.update(1 / hz, MG.ctx); } catch (_) { /* keep the race going */ }
      }
      engine._tick(clock);
      ticks++;
      if (r.state === 'finished' || r.state === 'results') break;
      // A player elimination ends the race for the player; keep going so the
      // rest of the field still runs, but do not spin forever.
      if (r.entries.every((e) => e.finished || e.eliminated)) break;
    }
  } finally {
    engine.renderFrame = origRender;
    off?.();
    if (borrowedDriver) {
      try { borrowedDriver.dispose?.(); } catch (_) { /* nothing owns it but us */ }
      if (wasAutoPoll !== undefined) MG.ctx.player.autoPollInput = wasAutoPoll;
      if (inputWas !== undefined && MG.ctx.input) MG.ctx.input.enabled = inputWas;
    }
    if (wasRunning) engine.start();
  }

  // Guard against the failure above ever reading as a result again: if the
  // player never got near the pace, the run did not test the thing.
  const pe = r.entries.find((e) => e.isPlayer);
  const lead = r.entries.reduce((m, e) => (e.roadDistance > (m?.roadDistance ?? -1) ? e : m), null);
  const pace = lead && lead.roadDistance > 0 ? +(pe.roadDistance / lead.roadDistance).toFixed(3) : null;

  return {
    ticks,
    seconds: +(ticks / hz).toFixed(1),
    playerPace: pace,          // 1.0 = level with the leader on the road
    competitive: pace !== null && pace > 0.55,
    state: r.state,
    totalLaps: r.totalLaps,
    eliminations: events,
    // The headline: eliminations where the HUD had someone behind the victim.
    disagreements: events.filter((e) => e.hudBehind > 0).length,
  };
}

/**
 * Several races, summarised. Each is a fresh `restart()`, so the AI takes a
 * different line and the field spreads differently.
 * @param {{races?: number, laps?: number}} [opts]
 */
export async function many(opts = {}) {
  const n = opts.races ?? 5;
  const all = [];
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    const one = await race({ laps: opts.laps, maxTicks: opts.maxTicks });
    all.push(one);
  }
  const evs = all.flatMap((x) => x.eliminations).filter((e) => !e.error);
  const disagree = evs.filter((e) => e.hudBehind > 0);
  const playerOut = evs.filter((e) => e.isPlayer);
  const playerDisagree = playerOut.filter((e) => e.hudBehind > 0);

  const degenerate = all.filter((x) => !x.competitive).length;
  return {
    races: n,
    // If this is not 0 the run is VOID, not null: a player that never kept pace
    // is last on every order and cannot exercise the disagreement at all.
    degenerateRaces: degenerate,
    voided: degenerate > 0,
    playerPace: all.map((x) => x.playerPace),
    eliminations: evs.length,
    // THE NUMBER. How often the game eliminated a car it had just told the
    // player was ahead of somebody.
    disagreements: disagree.length,
    disagreementRate: evs.length ? +(disagree.length / evs.length).toFixed(3) : null,
    worstHudBehind: evs.reduce((m, e) => Math.max(m, e.hudBehind), 0),
    playerEliminations: playerOut.length,
    playerDisagreements: playerDisagree.length,
    // CHECK, not a finding: the rule claims to take the car furthest back on the
    // road, so roadBehind must be 0 in every single event. Anything else means
    // the elimination scan itself is wrong and this whole reading is void.
    roadRuleViolations: evs.filter((e) => e.roadBehind > 0).length,
    sample: disagree.slice(0, 8),
    perRace: all.map((x) => ({ s: x.seconds, elim: x.eliminations.length, dis: x.disagreements })),
  };
}
