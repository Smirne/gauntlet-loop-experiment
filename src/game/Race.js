// game/Race.js — the rules.
//
// State machine, checkpoint validation, lap and sector timing, live ordering,
// elimination, and a five-round championship. Everything that decides who is
// winning lives here, and nothing here draws anything.
//
// Design notes worth reading before changing this file:
//
// * CUTTING IS IMPOSSIBLE BY CONSTRUCTION. Track lays ~20 checkpoints around
//   the lap at uniform arc length and gives an exact `checkpointIndexAt(t)`.
//   A car may only advance its validated checkpoint by exactly one at a time.
//   Cut the infield and your projected t jumps two gates forward — the counter
//   does not follow, the lap does not complete, and you have to go back for the
//   gate you missed. No trigger volumes, no tunnelling, no false negatives.
//
// * ORDERING IS A SINGLE MONOTONE SCALAR. `entry.score` is
//   validatedGates * gateLength + distanceSinceLastGate. It never wraps at the
//   start line, it cannot be gamed by cutting, and sorting by it gives exactly
//   "lap, then checkpoint, then distance to the next one" for free.
//
// * ALL TIMING RUNS IN fixedUpdate. main.js fast-forwards review captures by
//   calling engine.stepFixed() in a loop with no rendered frames at all, so
//   anything that only advanced in update() would silently not happen.
//
// No imports. Race must survive every peer being a stub, including Settings.

/* ------------------------------------------------------------------ constants */

export const RaceState = Object.freeze({
  ATTRACT: 'attract',
  GRID: 'grid',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
  RESULTS: 'results',
});

/** Classic eight-place table. Position 1 gets 10, last scoring place gets 1. */
export const POINTS = Object.freeze([10, 8, 6, 5, 4, 3, 2, 1]);

/** One extra for the fastest lap of the race, if you finish. */
export const FASTEST_LAP_POINT = 1;

/** Difficulty ramp across the season, not the order they appear on disk. */
export const CHAMPIONSHIP_TRACKS = Object.freeze(['kitchen', 'pool', 'garden', 'bedroom', 'workbench']);

const RECORDS_KEY = 'microgauntlet.records.v1';
const CHAMPIONSHIP_KEY = 'microgauntlet.championship.v1';

const GRID_HOLD = 1.1;          // seconds on the grid before the lights start
const COUNTDOWN_STEP = 1.0;     // seconds per light
const GO_HOLD = 0.65;           // how long "GO" stays up after the start
const RESULTS_DELAY = 3.2;      // seconds between the last car finishing and results
const AI_GRACE = 26;            // seconds the field gets to finish after the player
const MIN_LAP = 4.0;            // a "lap" quicker than this is a bookkeeping artefact
const ANALYSIS_HZ = 30;         // ranking / wrong-way / elimination cadence
const WRONGWAY_ARM = 0.55;      // seconds pointing backwards before we say so
const ATTRACT_AUTOSTART = 7.5;  // seconds of establishing shot when there is no menu

// Elimination tuning. Playtested and softened: the shipped numbers took five of
// eight cars out inside 60 s of a 3-lap race, and a player who made one ordinary
// mistake was gone before they had learned the circuit. Micro Machines-style
// elimination should be a threat you can feel closing, not a coin flip on the
// opening lap.
//
// The gap was max(span*3, trackLength*0.2) = 371 u on kitchen, i.e. a fifth of
// the lap, with a 6 s cooldown and no grace period at all.
const ELIM_MIN_REMAINING = 3;   // never eliminate down to a two-car procession
const ELIM_COOLDOWN = 9.0;      // seconds between eliminations
const ELIM_HIDE_DELAY = 1.1;    // the car is already off-screen; this is just a beat
const ELIM_SCREENS = 4.5;       // how many camera-fulls behind counts as "a screen ahead"
const ELIM_LAP_FRACTION = 0.34; // ...or this much of the lap, whichever is larger
// No elimination at all until the leader has a lap in. A bad start is the most
// recoverable thing in a race and the least fair thing to be knocked out for:
// on the opening lap the field is still bunched from the grid, so a spin that
// costs two seconds can read as a third of a lap of "gap" that simply is not
// there yet.
const ELIM_GRACE_LAPS = 1;

/* -------------------------------------------------------------------- helpers */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function wrap01(t) { const x = t - Math.floor(t); return x < 0 ? x + 1 : x; }

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem(RECORDS_KEY);
    return s;
  } catch (_) {
    return null;
  }
}

function readJson(key, fallback) {
  const store = safeStorage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  const store = safeStorage();
  if (!store) return;
  try { store.setItem(key, JSON.stringify(value)); }
  catch (err) { console.warn('[Race] could not persist', key, err); }
}

/**
 * m:ss.mmm, or s.mmm under a minute. Chunky and monospace-friendly — the HUD
 * and the results table both print exactly this.
 */
export function formatTime(seconds, { forceMinutes = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  const ms = Math.floor((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60);
  const mm = String(ms).padStart(3, '0');
  if (m > 0 || forceMinutes) return `${m}:${String(s).padStart(2, '0')}.${mm}`;
  return `${s}.${mm}`;
}

/** +0.412 / -1.088 / — . Deltas are always signed; that is the whole point. */
export function formatDelta(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  return sign + formatTime(Math.abs(seconds));
}

export function ordinal(n) {
  const i = Math.round(n);
  const mod100 = i % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${i}TH`;
  switch (i % 10) {
    case 1: return `${i}ST`;
    case 2: return `${i}ND`;
    case 3: return `${i}RD`;
    default: return `${i}TH`;
  }
}

/* ---------------------------------------------------------------------- entry */

/** One car's race. Everything the HUD, results screen and AI want to read. */
class Entry {
  constructor(vehicle, index) {
    this.vehicle = vehicle;
    this.index = index;
    this.id = vehicle?.id ?? `car${index}`;
    this.name = vehicle?.driverName ?? (vehicle?.isPlayer ? 'YOU' : `CPU ${index}`);
    this.isPlayer = !!vehicle?.isPlayer;
    this.carLabel = vehicle?.spec?.label ?? vehicle?.modelId ?? '';
    this.gridPosition = index + 1;
    this.reset();
  }

  reset() {
    this.lap = 0;                 // laps completed
    this.cp = 0;                  // last validated checkpoint index
    this.gates = 0;               // validated gates since the flag dropped
    this.started = false;         // has crossed the line once
    this.score = 0;               // monotone progress metric, world units
    this.t = 0;                   // spline parameter, cached from the vehicle
    this.position = this.gridPosition;
    this.lastPosition = this.gridPosition;
    this.bestPosition = this.gridPosition;

    this.lapStartTime = 0;
    this.lastLap = 0;
    this.bestLap = 0;
    this.lapTimes = [];
    this.lapInvalid = false;      // cut a gate this lap: no personal best from it
    this.cutWarnings = 0;

    this.sector = 0;
    this.sectorStartTime = 0;
    this.sectorTimes = [0, 0, 0];
    this.bestSectors = [0, 0, 0];
    this.lastSectorDelta = 0;

    this.finished = false;
    this.finishOrder = 0;
    this.finishTime = 0;
    this.eliminated = false;
    this.eliminatedAt = 0;
    this.dnf = false;

    this.gapToLeader = 0;         // seconds, estimated
    this.gapToAhead = 0;
    this.lapsDown = 0;
    this.wrongWay = false;
    this._wrongWayTimer = 0;
    this._hideTimer = 0;

    this.points = 0;
    this.fastestLapOfRace = false;
  }

  /** 1-based lap for display: "LAP 2/3". */
  get displayLap() {
    return this.lap + 1;
  }
}

/* ----------------------------------------------------------------------- race */

export class Race {
  name = 'race';

  constructor(ctx = {}) {
    this.ctx = ctx;

    this.state = RaceState.ATTRACT;
    this.previousState = null;
    this.stateTime = 0;
    this.raceTime = 0;            // seconds since the flag dropped
    this.clockRunning = false;
    this.paused = false;

    /** @type {Entry[]} grid order, stable */
    this.entries = [];
    /** @type {Entry[]} live running order, index 0 is the leader */
    this.standings = [];
    this.player = null;
    this.leader = null;

    this.totalLaps = 3;
    this.mode = 'circuit';        // 'circuit' | 'elimination' | 'timeTrial'
    this.trackId = ctx?.track?.id ?? '';
    this.trackName = ctx?.track?.title ?? '';

    this.countdownValue = 0;      // 3, 2, 1, then 0 for GO
    this.countdownLabel = '';
    this.finalLapCalled = false;
    this.fastestLap = { time: 0, entry: null };
    this.results = [];

    this.records = { bestLap: 0, bestSectors: [0, 0, 0], bestRace: 0, car: '' };
    this.championship = null;

    this.elimination = {
      enabled: true,
      gap: 0,                     // world units; resolved from the camera at start
      lastAt: -999,
      count: 0,
    };

    this._checkpointCount = 0;
    this._gateLength = 0;
    this._sectorGates = [0, 0, 0];
    this._hasSectors = false;
    this._hasFrontEnd = false;
    this._closed = false;
    this._nextFinishOrder = 1;
    this._nextElimOrder = 0;
    this._analysisAccum = 0;
    this._resultsTimer = 0;
    this._playerFinishedAt = 0;
    this._autopilot = null;
    this._autopilotWanted = false;
    this._bootChecked = false;
    this._ffSteps = 0;
    this._ffAccum = 0;
    this._ffLimit = 6;
    this._offBus = [];
    this._sortFn = (a, b) => compareEntries(a, b);
  }

  /* ------------------------------------------------------------------- init */

  async init() {
    const ctx = this.ctx;
    const track = ctx?.track;

    this.trackId = track?.id ?? '';
    this.trackName = track?.title ?? track?.def?.name ?? '';
    this.totalLaps = resolveLaps(ctx);
    this._ffLimit = Math.max(6, (ctx?.settings?.physics?.maxCatchUpSteps ?? 5) + 1);

    this._buildEntries();
    this._resolveCheckpoints();
    this.records = this._loadRecords();
    this.championship = this._loadChampionship();

    const bus = ctx?.bus;
    if (bus?.on) {
      this._offBus.push(bus.on('input:pause', () => this.togglePause()));
      this._offBus.push(bus.on('input:restart', () => this.restart()));
      this._offBus.push(bus.on('vehicle:respawn', (p) => this._onRespawn(p)));
    }

    this._enterState(RaceState.ATTRACT, { silent: true });
    this._holdField(true);
    return this;
  }

  _buildEntries() {
    const vehicles = Array.isArray(this.ctx?.vehicles) ? this.ctx.vehicles : [];
    this.entries.length = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const e = new Entry(vehicles[i], i);
      this.entries.push(e);
      if (e.isPlayer) this.player = e;
    }
    if (!this.player && this.entries.length) this.player = this.entries[0];
    this.standings = this.entries.slice();
    this.leader = this.standings[0] || null;
    this._nextElimOrder = this.entries.length;
  }

  _resolveCheckpoints() {
    const track = this.ctx?.track;
    const cps = Array.isArray(track?.checkpoints) ? track.checkpoints : [];
    this._checkpointCount = cps.length;
    const length = Number(track?.length) || 0;
    this._gateLength = this._checkpointCount > 0 ? length / this._checkpointCount : 0;
    const n = this._checkpointCount;
    // Sectors need enough gates that each third lands on a distinct one.
    this._hasSectors = n >= 6;
    this._sectorGates = this._hasSectors
      ? [0, Math.round(n / 3), Math.round((2 * n) / 3)]
      : [-1, -1, -1];
    if (!n) {
      console.warn('[Race] track exposes no checkpoints; lap counting is disabled');
    }
  }

  /* ------------------------------------------------------------ state machine */

  /**
   * Put the field on the grid and run the lights.
   * @param {{skipCountdown?:boolean, laps?:number, mode?:string, attract?:boolean,
   *          autopilot?:boolean}} [opts]
   */
  start(opts = {}) {
    const ctx = this.ctx;
    if (opts.laps) this.totalLaps = Math.max(1, opts.laps | 0);
    else this.totalLaps = resolveLaps(ctx);
    if (opts.mode) this.mode = opts.mode;

    if (!this.entries.length) this._buildEntries();
    if (!this._checkpointCount) this._resolveCheckpoints();

    this.raceTime = 0;
    this.clockRunning = false;
    this._closed = false;
    this.finalLapCalled = false;
    this.fastestLap.time = 0;
    this.fastestLap.entry = null;
    this.results.length = 0;
    this._nextFinishOrder = 1;
    this._nextElimOrder = this.entries.length;
    this._resultsTimer = 0;
    this._playerFinishedAt = 0;
    this.elimination.lastAt = -999;
    this.elimination.count = 0;
    this.elimination.gap = this._resolveEliminationGap();

    for (const e of this.entries) {
      e.reset();
      const v = e.vehicle;
      try {
        v?.repair?.();
        v?._placeOnGrid?.();
        if (v?.group) v.group.visible = true;
        if (v) v.eliminated = false;
      } catch (err) {
        console.warn('[Race] could not reset', e.name, err);
      }
      // Project fresh from the position: the cars have only just been moved to
      // the grid, so their own cached trackT is still whatever it was before,
      // and seeding the gate counter wrong would offset the ordering scalar for
      // the whole race.
      e.t = this._trackTOf(v);
      e.cp = this._gateFor(e.t);
      e.position = e.gridPosition;
      e.lastPosition = e.gridPosition;
    }
    this._rank(true);
    this._holdField(true);

    this._autopilotWanted = opts.autopilot ?? this._wantsAutopilot();
    if (this._autopilotWanted) this._ensureAutopilot();
    else this._autopilot = null;

    this.ctx?.bus?.emit?.('race:reset', { track: this.trackId, laps: this.totalLaps });

    if (opts.attract) {
      this._enterState(RaceState.ATTRACT);
      return this;
    }
    if (opts.skipCountdown) {
      this._enterState(RaceState.GRID, { silent: true });
      this._go();
      return this;
    }
    this._enterState(RaceState.GRID);
    return this;
  }

  /** Alias for callers that reach for begin(). main.js probes both. */
  begin(opts) { return this.start(opts); }

  restart() {
    if (this.state === RaceState.ATTRACT) return this;
    return this.start({ skipCountdown: false });
  }

  reset() {
    this.start({ attract: true });
    return this;
  }

  _enterState(next, { silent = false } = {}) {
    if (next === this.state) return;
    this.previousState = this.state;
    this.state = next;
    this.stateTime = 0;
    if (!silent) {
      this.ctx?.bus?.emit?.('race:state', { from: this.previousState, to: next, race: this });
    }
  }

  /** Freeze or release every car in the field. */
  _holdField(hold) {
    for (const e of this.entries) {
      const v = e.vehicle;
      if (!v) continue;
      if (e.eliminated) continue;
      try {
        if (hold) v.freeze?.();
        else v.unfreeze?.();
      } catch (_) { /* a stub vehicle is still a valid vehicle */ }
    }
  }

  _go() {
    this._holdField(false);
    this.clockRunning = true;
    this.raceTime = 0;
    this.countdownValue = 0;
    this.countdownLabel = 'GO';
    for (const e of this.entries) {
      e.lapStartTime = 0;
      e.sectorStartTime = 0;
    }
    this._enterState(RaceState.RACING);
    this.ctx?.bus?.emit?.('race:countdown', { value: 0, label: 'GO', track: this.trackId });
    this.ctx?.bus?.emit?.('race:start', {
      track: this.trackId, name: this.trackName, laps: this.totalLaps, field: this.entries.length,
    });
  }

  /* ------------------------------------------------------------------- pause */

  pause() {
    if (this.paused) return this;
    this.paused = true;
    this.ctx?.engine?.pause?.('race');
    this.ctx?.bus?.emit?.('race:pause', { paused: true });
    return this;
  }

  resume() {
    if (!this.paused) return this;
    this.paused = false;
    this.ctx?.engine?.resume?.('race');
    this.ctx?.bus?.emit?.('race:pause', { paused: false });
    return this;
  }

  togglePause() {
    if (this.state === RaceState.ATTRACT || this.state === RaceState.RESULTS) return this;
    return this.paused ? this.resume() : this.pause();
  }

  /**
   * Whether Input should be driving the player right now. False on the grid,
   * during results, and whenever an autopilot has the wheel.
   */
  acceptsInput() {
    if (this._autopilot) return false;
    if (this.paused) return false;
    return this.state === RaceState.RACING || this.state === RaceState.FINISHED
      || this.state === RaceState.COUNTDOWN;
  }

  /** Input calls this on any real human press: the demo driver stands down. */
  notifyPlayerInput() {
    if (this._autopilot) {
      this._autopilot = null;
      this._autopilotWanted = false;
      this.ctx?.bus?.emit?.('race:autopilot', { on: false });
    }
    // Any key skips the establishing shot when there is no front end to do it.
    if (this.state === RaceState.ATTRACT && !this._hasFrontEnd) {
      this.start({ skipCountdown: false });
    }
    return this;
  }

  /* -------------------------------------------------------------- fixed step */

  fixedUpdate(fdt, ctx) {
    if (ctx) this.ctx = ctx;
    if (!(fdt > 0)) return;

    this.stateTime += fdt;
    if (this.clockRunning) this.raceTime += fdt;

    // Safety net for any caller that drives fixedUpdate in a tight loop without
    // ever running the update phase: the AI thinks in update(), so the field
    // would sit on the grid in every headless shot. Detect the burst and pump
    // the drivers ourselves at a plausible frame rate. The threshold sits above
    // the engine's catch-up cap so a hitching frame in normal play cannot trip
    // it.
    //
    // Dormant on the current capture path. main.js fast-forwards through
    // engine.stepOnce(), which runs fixedUpdate and update in order, and
    // update() zeroes the counter — so it never reaches the limit. It used to
    // fire because main.js called engine.stepFixed(), a method Engine does not
    // have; the optional call no-opped and nothing was stepped at all. Keep the
    // net, but do not trust it to be exercised.
    if (++this._ffSteps > this._ffLimit) this._headlessDrive(fdt);

    switch (this.state) {
      case RaceState.ATTRACT:
        this._holdIdle();
        break;

      case RaceState.GRID:
        if (this.stateTime >= GRID_HOLD) {
          this._enterState(RaceState.COUNTDOWN);
          this.countdownValue = Math.max(1, this.ctx?.settings?.gameplay?.countdown ?? 3);
          this.countdownLabel = String(this.countdownValue);
          this.ctx?.bus?.emit?.('race:countdown', {
            value: this.countdownValue, label: this.countdownLabel, track: this.trackId,
          });
        }
        break;

      case RaceState.COUNTDOWN: {
        const start = Math.max(1, this.ctx?.settings?.gameplay?.countdown ?? 3);
        const elapsed = this.stateTime;
        const shown = Math.max(0, start - Math.floor(elapsed / COUNTDOWN_STEP));
        if (shown !== this.countdownValue) {
          this.countdownValue = shown;
          if (shown > 0) {
            this.countdownLabel = String(shown);
            this.ctx?.bus?.emit?.('race:countdown', {
              value: shown, label: this.countdownLabel, track: this.trackId,
            });
          }
        }
        if (elapsed >= start * COUNTDOWN_STEP) this._go();
        break;
      }

      case RaceState.RACING:
      case RaceState.FINISHED:
        this._simulate(fdt);
        break;

      case RaceState.RESULTS:
      default:
        break;
    }

    // Eliminated cars are hidden a beat after the flag, by which point they are
    // a long way off the bottom of frame and nobody sees them go.
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e.eliminated || e._hideTimer <= 0) continue;
      e._hideTimer -= fdt;
      if (e._hideTimer <= 0 && e.vehicle?.group) e.vehicle.group.visible = false;
    }
  }

  update(dt, ctx) {
    if (ctx) this.ctx = ctx;
    this._ffSteps = 0;
    this._ffAccum = 0;

    // ctx.menu is constructed after us, so the "is there a front end?" question
    // can only be answered once the first frame runs.
    if (!this._bootChecked) {
      this._bootChecked = true;
      this._autoArm();
    }

    if (this._autopilot && (this.state === RaceState.RACING || this.state === RaceState.FINISHED)) {
      try { this._autopilot.update?.(dt, this.ctx); }
      catch (err) { this._autopilot = null; console.warn('[Race] autopilot failed', err); }
    }

    if (this.state === RaceState.FINISHED) {
      this._resultsTimer += dt;
      if (this._resultsTimer >= RESULTS_DELAY) this.showResults();
    }
  }

  /** With no Menu module in the build, the game has to start itself. */
  _autoArm() {
    const menu = this.ctx?.menu;
    const hasFrontEnd = !!menu && (typeof menu.show === 'function' || typeof menu.open === 'function');
    this._hasFrontEnd = hasFrontEnd;
    if (this.state !== RaceState.ATTRACT) return;
    if (this._wantsAutopilot()) this._ensureAutopilot();
  }

  _holdIdle() {
    // The attract state is an establishing shot over a dressed grid. Without a
    // front end to hand off to, it rolls straight into a race.
    if (this._hasFrontEnd) return;
    if (this.stateTime >= ATTRACT_AUTOSTART) this.start({ skipCountdown: false });
  }

  _wantsAutopilot() {
    const params = this.ctx?.params;
    if (!params?.get) return false;
    if (params.get('autopilot') === '1') return true;
    // A fast-forwarded review capture wants a moving player car, not a parked
    // hero in the middle of the shot.
    return params.has('t');
  }

  /**
   * Borrow the AI driver class from a car that already has one. main.js
   * constructs the drivers but never exports the constructor, and a dynamic
   * import would not resolve before a synchronous fast-forward runs.
   */
  _ensureAutopilot() {
    if (this._autopilot || !this.ctx?.player) return;
    const peer = this.ctx?.drivers?.[0];
    const Ctor = peer && peer.constructor;
    if (typeof Ctor !== 'function') return;
    try {
      this._autopilot = new Ctor(this.ctx, this.ctx.player, {
        skill: 0.88, aggression: 0.55, consistency: 0.94, seed: 0x5eed,
      });
      this.ctx.bus?.emit?.('race:autopilot', { on: true });
    } catch (err) {
      this._autopilot = null;
      console.warn('[Race] could not build an autopilot', err);
    }
  }

  _headlessDrive(fdt) {
    this._ffAccum += fdt;
    const step = 1 / 30;
    if (this._ffAccum < step) return;
    const dt = this._ffAccum;
    this._ffAccum = 0;
    const drivers = this.ctx?.drivers;
    if (Array.isArray(drivers)) {
      for (let i = 0; i < drivers.length; i++) {
        try { drivers[i]?.update?.(dt, this.ctx); } catch (_) { /* one bad driver, not a dead capture */ }
      }
    }
    if (this._autopilot) {
      try { this._autopilot.update?.(dt, this.ctx); } catch (_) { this._autopilot = null; }
    }
  }

  /* ---------------------------------------------------------------- the race */

  _simulate(fdt) {
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.finished || e.eliminated) continue;
      this._advanceEntry(e);
    }

    this._analysisAccum += fdt;
    const step = 1 / ANALYSIS_HZ;
    if (this._analysisAccum >= step) {
      const dt = this._analysisAccum;
      this._analysisAccum = 0;
      this._rank(false);
      this._analyse(dt);
      this._checkElimination();
      this._checkRaceOver();
    }
  }

  /** Which gate a spline parameter falls in, per the track's own mapping. */
  _gateFor(t) {
    const track = this.ctx?.track;
    if (!track || !this._checkpointCount) return 0;
    try { return track.checkpointIndexAt(t) | 0; } catch (_) { return 0; }
  }

  /**
   * Spline parameter for a car, projected fresh from its world position.
   * The hot path uses the vehicle's own cached trackT (it projects once per
   * physics tick already); this is for the moments where that cache is stale —
   * a grid reset or a respawn teleport.
   */
  _trackTOf(vehicle) {
    const track = this.ctx?.track;
    if (!track || !vehicle?.position) return Number(vehicle?.trackT) || 0;
    try {
      if (typeof track.nearestT === 'function') return track.nearestT(vehicle.position);
    } catch (_) { /* fall through */ }
    return Number(vehicle.trackT) || 0;
  }

  /**
   * Checkpoint validation. One gate forward at a time, one gate back at a time,
   * and nothing else counts. Everything downstream — laps, sectors, ordering —
   * is derived from this single rule.
   */
  _advanceEntry(e) {
    const track = this.ctx?.track;
    const n = this._checkpointCount;
    const v = e.vehicle;
    if (!v) return;
    if (!track || !n) {
      // Degraded track (no checkpoint ring): still produce a usable order so
      // the HUD is not stuck showing everyone in first place.
      e.score = Number(v.lapDistance) || 0;
      return;
    }

    let t = v.trackT;
    if (!Number.isFinite(t)) t = this._trackTOf(v);
    e.t = t;

    const idx = this._gateFor(t);
    if (idx !== e.cp) {
      const delta = ((idx - e.cp) % n + n) % n;
      if (delta === 1) {
        this._validateGate(e, idx);
      } else if (delta === n - 1) {
        // Genuinely going backwards (a spin, a reverse out of a wall). Give the
        // gate back so the re-pass re-validates rather than double-counting.
        e.gates--;
        if (e.cp === 0 && e.started && e.lap > 0) e.lap--;
        e.cp = idx;
      } else {
        // More than one gate away: the car is somewhere it did not drive to.
        //
        // This used to refuse to move `e.cp` at all, which made it a one-way
        // trap (D14). With cp frozen at gate k and the car already past k+1,
        // delta can never be 1 again, so `e.gates` — and with it the ordering
        // scalar — never advanced again for the rest of the race, while `e.t`
        // went on reporting real progress. Measured: a car second on the road
        // scoring dead last on four gates against the leaders' eleven, then
        // eliminated for it. Because that car is usually the player, the race
        // ended there too.
        //
        // Re-sync so ordering keeps tracking reality, and credit nothing for
        // the span that was skipped. The cut costs exactly what it skipped,
        // permanently, and the lap it happened on cannot set a personal best.
        // Cutting therefore still gains nothing — which is the rule section 5
        // of ARCHITECTURE.md exists to protect. Freezing a car out of the
        // classification was never part of that rule.
        if (!e.lapInvalid) {
          e.lapInvalid = true;
          e.cutWarnings++;
          this.ctx?.bus?.emit?.('race:cut', { vehicle: v, entry: e, from: e.cp, to: idx });
        }
        e.cp = idx;
      }
    }

    // Ordering scalar. Distance past the last validated gate is clamped to two
    // gate lengths so a car sitting beyond a gate it never validated cannot
    // out-score one that did.
    const gateT = track.checkpoints[e.cp]?.t ?? 0;
    const along = wrap01(t - gateT) * (track.length || 0);
    const capped = Math.min(along, this._gateLength * 2);
    e.score = e.gates * this._gateLength + capped;
  }

  _validateGate(e, idx) {
    e.cp = idx;
    e.gates++;

    if (this._hasSectors && e.started) {
      const sectorIdx = this._sectorGates.indexOf(idx);
      // Gate 0 closes sector 3, gate n/3 closes sector 1, gate 2n/3 closes 2.
      if (sectorIdx >= 0) this._completeSector(e, (sectorIdx + 2) % 3);
    }

    if (idx === 0) {
      if (!e.started) {
        // Crossing the line for the first time starts lap one; it does not
        // complete one. Cars are gridded behind the line.
        e.started = true;
        e.lapStartTime = this.raceTime;
        e.sectorStartTime = this.raceTime;
        e.sector = 0;
      } else {
        this._completeLap(e);
      }
    }

    this.ctx?.bus?.emit?.('race:checkpoint', {
      vehicle: e.vehicle, entry: e, index: idx, gates: e.gates, lap: e.lap,
    });
  }

  _completeSector(e, sector) {
    const now = this.raceTime;
    const time = now - e.sectorStartTime;
    e.sectorStartTime = now;
    if (!(time > 0.4)) return;
    e.sectorTimes[sector] = time;
    const prevBest = e.bestSectors[sector];
    const improved = prevBest === 0 || time < prevBest;
    if (improved && !e.lapInvalid) e.bestSectors[sector] = time;
    e.lastSectorDelta = prevBest > 0 ? time - prevBest : 0;
    e.sector = (sector + 1) % 3;

    this.ctx?.bus?.emit?.('race:sector', {
      vehicle: e.vehicle, entry: e, sector, time, delta: e.lastSectorDelta,
      best: improved, isPlayer: e.isPlayer,
    });

    if (e.isPlayer && improved && !e.lapInvalid) {
      const rec = this.records.bestSectors;
      if (!(rec[sector] > 0) || time < rec[sector]) {
        rec[sector] = time;
        this._saveRecords();
      }
    }
  }

  _completeLap(e) {
    const now = this.raceTime;
    const lapTime = now - e.lapStartTime;
    e.lapStartTime = now;
    e.lap++;

    let personalBest = false;
    let raceBest = false;
    if (lapTime > MIN_LAP) {
      e.lastLap = lapTime;
      e.lapTimes.push(lapTime);
      if (!e.lapInvalid) {
        if (e.bestLap === 0 || lapTime < e.bestLap) { e.bestLap = lapTime; personalBest = true; }
        if (this.fastestLap.time === 0 || lapTime < this.fastestLap.time) {
          if (this.fastestLap.entry) this.fastestLap.entry.fastestLapOfRace = false;
          this.fastestLap.time = lapTime;
          this.fastestLap.entry = e;
          e.fastestLapOfRace = true;
          raceBest = true;
        }
      }
    }
    const wasInvalid = e.lapInvalid;
    e.lapInvalid = false;

    this.ctx?.bus?.emit?.('race:lap', {
      vehicle: e.vehicle, entry: e, lap: e.lap, totalLaps: this.totalLaps,
      lapTime, best: e.bestLap, personalBest, raceBest, invalid: wasInvalid,
      isPlayer: e.isPlayer, position: e.position,
    });

    if (e.isPlayer && personalBest && lapTime > MIN_LAP) {
      if (!(this.records.bestLap > 0) || lapTime < this.records.bestLap) {
        this.records.bestLap = lapTime;
        this.records.car = e.carLabel;
        this._saveRecords();
        this.ctx?.bus?.emit?.('race:record', {
          kind: 'lap', time: lapTime, track: this.trackId, entry: e,
        });
      }
    }

    if (e.lap >= this.totalLaps) {
      this._finishEntry(e);
      return;
    }
    if (e.lap === this.totalLaps - 1) {
      this.ctx?.bus?.emit?.('race:finalLap', {
        vehicle: e.vehicle, entry: e, isPlayer: e.isPlayer, leader: e === this.leader,
      });
      if (!this.finalLapCalled && e === this.leader) {
        this.finalLapCalled = true;
        this.ctx?.bus?.emit?.('race:whiteFlag', { entry: e, laps: this.totalLaps });
      }
    }
  }

  _finishEntry(e) {
    if (e.finished) return;
    e.finished = true;
    e.finishTime = this.raceTime;
    e.finishOrder = this._nextFinishOrder++;
    e.position = e.finishOrder;

    // Coast to a stop rather than stopping dead — a car that freezes on the
    // line reads as a bug, not as a finish.
    try {
      e.vehicle?.setControls?.({ throttle: 0, brake: 0.35, steer: 0, handbrake: 0, boost: 0 });
    } catch (_) { /* ignore */ }

    if (e.isPlayer) {
      this._playerFinishedAt = this.raceTime;
      if (!(this.records.bestRace > 0) || e.finishTime < this.records.bestRace) {
        this.records.bestRace = e.finishTime;
        this._saveRecords();
        this.ctx?.bus?.emit?.('race:record', {
          kind: 'race', time: e.finishTime, track: this.trackId, entry: e,
        });
      }
    }

    this.ctx?.bus?.emit?.('race:carFinished', {
      vehicle: e.vehicle, entry: e, position: e.finishOrder, time: e.finishTime,
      isPlayer: e.isPlayer, ordinal: ordinal(e.finishOrder),
    });
  }

  /* -------------------------------------------------------------- ordering */

  _rank(silent) {
    const order = this.standings;
    order.length = 0;
    for (let i = 0; i < this.entries.length; i++) order.push(this.entries[i]);
    order.sort(this._sortFn);

    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      const pos = i + 1;
      if (e.position !== pos) {
        e.lastPosition = e.position;
        e.position = pos;
        if (pos < e.bestPosition) e.bestPosition = pos;
        if (!silent && !e.finished && !e.eliminated) {
          this.ctx?.bus?.emit?.('race:position', {
            vehicle: e.vehicle, entry: e, position: pos, previous: e.lastPosition,
            gained: e.lastPosition - pos, isPlayer: e.isPlayer,
          });
          if (pos < e.lastPosition) {
            const passed = order[pos] || null;   // the car now directly behind
            this.ctx?.bus?.emit?.('race:overtake', {
              vehicle: e.vehicle, entry: e, over: passed?.vehicle || null, overEntry: passed,
              position: pos, isPlayer: e.isPlayer,
            });
          }
        }
      }
    }
    this.leader = order[0] || null;
  }

  /** Wrong-way detection and gap estimates, run at ANALYSIS_HZ. */
  _analyse(dt) {
    const track = this.ctx?.track;
    const order = this.standings;
    const leader = this.leader;

    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      const v = e.vehicle;
      if (!v) continue;

      if (!e.finished && !e.eliminated && track?.sampleAt && v.forward) {
        const s = track.sampleAt(e.t);
        const dot = v.forward.x * s.tangent.x + v.forward.y * s.tangent.y + v.forward.z * s.tangent.z;
        const speed = v.speed || 0;
        // Reversing out of a wall is not "wrong way"; driving the circuit
        // backwards at speed is. Both the alignment and the pace have to agree.
        if (dot < -0.4 && speed > 14) e._wrongWayTimer += dt;
        else e._wrongWayTimer = Math.max(0, e._wrongWayTimer - dt * 2.2);

        const on = e._wrongWayTimer > WRONGWAY_ARM;
        if (on !== e.wrongWay) {
          e.wrongWay = on;
          this.ctx?.bus?.emit?.('race:wrongway', { vehicle: v, entry: e, on, isPlayer: e.isPlayer });
        }
      } else if (e.wrongWay) {
        e.wrongWay = false;
        this.ctx?.bus?.emit?.('race:wrongway', { vehicle: v, entry: e, on: false, isPlayer: e.isPlayer });
      }

      // Gaps in seconds, from distance over a floored closing speed. Exactly
      // how a timing screen does it, and it degrades gracefully at a standstill.
      if (leader && e !== leader) {
        const ref = Math.max(24, ((leader.vehicle?.speed || 0) + (v.speed || 0)) * 0.5);
        e.gapToLeader = (leader.score - e.score) / ref;
        const ahead = order[i - 1];
        e.gapToAhead = ahead ? (ahead.score - e.score) / ref : 0;
        e.lapsDown = this._gateLength > 0 && this._checkpointCount > 0
          ? Math.floor((leader.gates - e.gates) / this._checkpointCount)
          : 0;
      } else {
        e.gapToLeader = 0;
        e.gapToAhead = 0;
        e.lapsDown = 0;
      }
    }
  }

  /* ----------------------------------------------------------- elimination */

  /**
   * Micro Machines' one great idea: fall a screen behind and you are out of the
   * race. Taken literally at this camera height it would wipe half the field on
   * lap one, so "a screen" means ELIM_SCREENS camera-fulls of track, measured
   * from the Director's actual framing rather than guessed at.
   */
  _resolveEliminationGap() {
    const settings = this.ctx?.settings?.gameplay;
    if (Number.isFinite(settings?.eliminationGap) && settings.eliminationGap > 0) {
      return settings.eliminationGap;
    }
    let span = 0;
    try { span = Number(this.ctx?.director?.screenSpan?.()) || 0; } catch (_) { span = 0; }
    if (!(span > 0)) span = 56;   // widest framing of the default chase camera
    const trackLength = Number(this.ctx?.track?.length) || 1800;
    // Never less than a third of the lap, or a short circuit would eliminate
    // cars that are simply in traffic.
    return Math.max(span * ELIM_SCREENS, trackLength * ELIM_LAP_FRACTION);
  }

  _checkElimination() {
    if (this.mode === 'timeTrial') return;
    if (!this.elimination.enabled) return;
    if (this.state !== RaceState.RACING) return;
    if (this.ctx?.settings?.gameplay?.elimination === false) return;
    if (this.raceTime - this.elimination.lastAt < ELIM_COOLDOWN) return;
    // Opening-lap grace. Measured against the LEADER's lap, not the clock, so
    // it scales with the circuit instead of assuming a lap length.
    if ((this.leader?.lap ?? 0) < ELIM_GRACE_LAPS) return;

    // NOTE (D14, second order): this judges "who is off the back" on the
    // validated score, which carries the cut penalty. A car that takes one
    // moderate cut loses more score than the elimination gap on this circuit,
    // so it can be eliminated while sitting mid-pack in plain view.
    //
    // The obvious fix — judge on road position (`lap + t`) instead, since
    // elimination is a spatial rule — does not work as written: cars are
    // gridded BEHIND the line, so before their first crossing `t` is ~0.98 with
    // `lap` still 0, and they read as nearly a full lap AHEAD of anyone who has
    // already crossed. That inverts leader and last on the opening lap and
    // eliminates half the field inside 30 s. Measured, not predicted.
    //
    // Doing this properly needs a monotone distance-travelled signal rather
    // than a wrapped parameter. Left alone deliberately until that is
    // established; the freeze that made this acute is fixed above.
    const order = this.standings;
    let running = 0;
    let last = null;
    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      if (e.finished || e.eliminated) continue;
      running++;
      last = e;
    }
    if (running <= ELIM_MIN_REMAINING || !last) return;

    const leader = this.leader;
    if (!leader || leader === last) return;
    // Only ever the car in last place, and only against the leader's progress.
    if (leader.score - last.score < this.elimination.gap) return;

    this._eliminate(last, leader);
  }

  _eliminate(e, by) {
    e.eliminated = true;
    e.eliminatedAt = this.raceTime;
    e.finishTime = this.raceTime;   // so the results table can still show a gap
    e.finishOrder = this._nextElimOrder--;
    e.position = e.finishOrder;
    e._hideTimer = ELIM_HIDE_DELAY;
    this.elimination.lastAt = this.raceTime;
    this.elimination.count++;

    try {
      e.vehicle?.freeze?.();
      if (e.vehicle) e.vehicle.eliminated = true;
    } catch (_) { /* ignore */ }

    // The leader banks a point for the knockout, exactly as the original does.
    if (by) by.points += 1;

    this.ctx?.bus?.emit?.('race:eliminated', {
      vehicle: e.vehicle, entry: e, by: by?.vehicle || null, byEntry: by || null,
      position: e.finishOrder, isPlayer: e.isPlayer,
    });
    this._rank(true);
  }

  /* --------------------------------------------------------------- finishing */

  _checkRaceOver() {
    if (this.state === RaceState.RESULTS) return;

    let running = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e.finished && !e.eliminated) running++;
    }

    if (this.state === RaceState.RACING) {
      const playerDone = !this.player || this.player.finished || this.player.eliminated;
      if (playerDone) {
        this._enterState(RaceState.FINISHED);
        this._resultsTimer = 0;
        this.ctx?.bus?.emit?.('race:chequered', {
          entry: this.player, position: this.player?.position ?? 0,
        });
      }
      if (running === 0) this.finish();
      return;
    }

    if (this.state === RaceState.FINISHED) {
      // Classify anyone still circulating once the flag has been out a while,
      // so a stuck AI can never hold the results screen hostage.
      if (running === 0 || this.raceTime - this._playerFinishedAt > AI_GRACE) {
        for (const e of this.entries) {
          if (e.finished || e.eliminated) continue;
          e.dnf = true;
          e.finished = true;
          e.finishTime = this.raceTime;
          e.finishOrder = this._nextFinishOrder++;
        }
        this.finish();
      }
    }
  }

  /** Close the books: points, championship, results payload. */
  finish() {
    if (this._closed) return this;
    this._closed = true;
    this.clockRunning = false;

    // Classify anyone still circulating when the books close (the player's
    // chequered flag ends the race, it does not wait for the tail of the field).
    for (const e of this.entries) {
      if (e.finished || e.eliminated) continue;
      e.finished = true;
      e.finishTime = this.raceTime;
      e.finishOrder = this._nextFinishOrder++;
    }
    this._rank(true);

    const results = [];
    const winner = this.standings[0];
    for (let i = 0; i < this.standings.length; i++) {
      const e = this.standings[i];
      const scoring = !e.eliminated && !e.dnf;
      const base = scoring && i < POINTS.length ? POINTS[i] : 0;
      const bonus = e.fastestLapOfRace && scoring ? FASTEST_LAP_POINT : 0;
      // e.points may already hold knockout points banked during the race.
      e.points += base + bonus;
      results.push({
        position: i + 1,
        name: e.name,
        car: e.carLabel,
        isPlayer: e.isPlayer,
        time: e.finishTime,
        bestLap: e.bestLap,
        laps: e.lap,
        points: e.points,
        placePoints: base,
        bonusPoints: bonus,
        eliminated: e.eliminated,
        dnf: e.dnf,
        fastestLap: e.fastestLapOfRace,
        gap: !winner || e === winner ? 0 : e.finishTime - winner.finishTime,
        entry: e,
      });
    }
    this.results = results;

    this._recordChampionshipRound(results);

    this.ctx?.bus?.emit?.('race:finish', {
      results, player: this.player, track: this.trackId, name: this.trackName,
      fastestLap: this.fastestLap.time, fastestLapBy: this.fastestLap.entry?.name || '',
      championship: this.championship,
    });
    if (this.state !== RaceState.FINISHED) {
      this._enterState(RaceState.FINISHED);
      this._resultsTimer = 0;
    }
    return this;
  }

  showResults() {
    if (this.state === RaceState.RESULTS) return this;
    if (!this._closed) this.finish();
    this._holdField(true);
    this._enterState(RaceState.RESULTS);
    this.ctx?.bus?.emit?.('race:results', {
      results: this.results, player: this.player, championship: this.championship,
      nextTrack: this.nextChampionshipTrack(),
    });
    return this;
  }

  /* ------------------------------------------------------------------ records */

  _loadRecords() {
    const all = readJson(RECORDS_KEY, {});
    const rec = all[this.trackId];
    const out = { bestLap: 0, bestSectors: [0, 0, 0], bestRace: 0, car: '' };
    if (rec && typeof rec === 'object') {
      if (Number.isFinite(rec.bestLap) && rec.bestLap > 0) out.bestLap = rec.bestLap;
      if (Number.isFinite(rec.bestRace) && rec.bestRace > 0) out.bestRace = rec.bestRace;
      if (typeof rec.car === 'string') out.car = rec.car;
      if (Array.isArray(rec.bestSectors)) {
        for (let i = 0; i < 3; i++) {
          const v = rec.bestSectors[i];
          if (Number.isFinite(v) && v > 0) out.bestSectors[i] = v;
        }
      }
    }
    return out;
  }

  _saveRecords() {
    if (!this.trackId) return;
    const all = readJson(RECORDS_KEY, {});
    all[this.trackId] = {
      bestLap: this.records.bestLap,
      bestSectors: this.records.bestSectors.slice(),
      bestRace: this.records.bestRace,
      car: this.records.car,
    };
    writeJson(RECORDS_KEY, all);
  }

  clearRecords() {
    writeJson(RECORDS_KEY, {});
    this.records = { bestLap: 0, bestSectors: [0, 0, 0], bestRace: 0, car: '' };
    return this;
  }

  /* ------------------------------------------------------------- championship */

  _loadChampionship() {
    const raw = readJson(CHAMPIONSHIP_KEY, null);
    const c = {
      active: false,
      order: CHAMPIONSHIP_TRACKS.slice(),
      round: 0,
      points: {},
      rounds: [],
    };
    if (raw) {
      if (Array.isArray(raw.order) && raw.order.length) c.order = raw.order.slice();
      if (Number.isInteger(raw.round)) c.round = clamp(raw.round, 0, c.order.length);
      if (raw.points && typeof raw.points === 'object') {
        for (const k in raw.points) {
          const v = raw.points[k];
          if (Number.isFinite(v)) c.points[k] = v;
        }
      }
      if (Array.isArray(raw.rounds)) c.rounds = raw.rounds.slice(0, 16);
      c.active = !!raw.active;
    }
    return c;
  }

  _saveChampionship() {
    if (!this.championship) return;
    writeJson(CHAMPIONSHIP_KEY, {
      active: this.championship.active,
      order: this.championship.order,
      round: this.championship.round,
      points: this.championship.points,
      rounds: this.championship.rounds,
    });
  }

  /** Begin a fresh season. `order` defaults to the shipped five-track ramp. */
  startChampionship(opts = {}) {
    this.championship = {
      active: true,
      order: Array.isArray(opts.order) && opts.order.length ? opts.order.slice() : CHAMPIONSHIP_TRACKS.slice(),
      round: 0,
      points: {},
      rounds: [],
    };
    this._saveChampionship();
    this.ctx?.bus?.emit?.('championship:start', { championship: this.championship });
    return this.championship;
  }

  endChampionship() {
    if (!this.championship) return this;
    this.championship.active = false;
    this._saveChampionship();
    this.ctx?.bus?.emit?.('championship:end', {
      championship: this.championship, standings: this.championshipStandings(),
    });
    return this;
  }

  _recordChampionshipRound(results) {
    const c = this.championship;
    if (!c || !c.active) return;
    const expected = c.order[c.round];
    // Racing a track out of sequence must not corrupt the season.
    if (expected && this.trackId && expected !== this.trackId) return;

    const row = { track: this.trackId, name: this.trackName, standings: [] };
    for (const r of results) {
      c.points[r.name] = (c.points[r.name] || 0) + r.points;
      row.standings.push({ name: r.name, position: r.position, points: r.points });
    }
    c.rounds.push(row);
    c.round = Math.min(c.order.length, c.round + 1);
    if (c.round >= c.order.length) c.active = false;
    this._saveChampionship();
    this.ctx?.bus?.emit?.('championship:round', {
      championship: c, round: row, standings: this.championshipStandings(),
    });
  }

  /** [{ name, points, position, isPlayer }] sorted by points. */
  championshipStandings() {
    const c = this.championship;
    if (!c) return [];
    const playerName = this.player?.name || 'YOU';
    const rows = Object.keys(c.points).map((name) => ({
      name, points: c.points[name], isPlayer: name === playerName, position: 0,
    }));
    rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    for (let i = 0; i < rows.length; i++) rows[i].position = i + 1;
    return rows;
  }

  /** The track id for the next round, or null when the season is done. */
  nextChampionshipTrack() {
    const c = this.championship;
    if (!c || !c.active) return null;
    return c.order[c.round] || null;
  }

  /**
   * Loading a track means a page load in this build (main.js binds one track
   * per boot), so the front end navigates using this.
   */
  nextChampionshipUrl() {
    const id = this.nextChampionshipTrack();
    if (!id) return null;
    const params = new URLSearchParams(globalThis.location?.search || '');
    params.set('track', id);
    params.set('skipmenu', '1');
    return `${globalThis.location?.pathname || './'}?${params.toString()}`;
  }

  /* ---------------------------------------------------------------- queries */

  entryFor(vehicle) {
    if (!vehicle) return null;
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].vehicle === vehicle) return this.entries[i];
    }
    return null;
  }

  positionOf(vehicle) {
    return this.entryFor(vehicle)?.position ?? 0;
  }

  /** Seconds between two entries, positive when `b` is behind `a`. */
  gapBetween(a, b) {
    if (!a || !b) return 0;
    const ref = Math.max(24, ((a.vehicle?.speed || 0) + (b.vehicle?.speed || 0)) * 0.5);
    return (a.score - b.score) / ref;
  }

  get fieldSize() { return this.entries.length; }
  get racing() { return this.state === RaceState.RACING; }
  get playerLap() { return this.player ? Math.min(this.player.lap + 1, this.totalLaps) : 1; }
  get playerPosition() { return this.player?.position ?? 0; }
  get finalLap() { return this.player ? this.player.lap === this.totalLaps - 1 : false; }

  formatTime(s, opts) { return formatTime(s, opts); }
  formatDelta(s) { return formatDelta(s); }
  ordinal(n) { return ordinal(n); }

  /** Compact snapshot for the debug overlay. */
  snapshot() {
    return {
      state: this.state,
      time: +this.raceTime.toFixed(2),
      lap: `${this.playerLap}/${this.totalLaps}`,
      pos: `${this.playerPosition}/${this.entries.length}`,
      best: this.player?.bestLap ? formatTime(this.player.bestLap) : '—',
      gates: this.player?.gates ?? 0,
      elim: this.elimination.count,
      autopilot: !!this._autopilot,
    };
  }

  _onRespawn(p) {
    // A respawn teleports the car; resync its gate so the ordering scalar does
    // not read the jump as a cut.
    const e = this.entryFor(p?.vehicle);
    if (!e) return;
    const idx = this._gateFor(this._trackTOf(e.vehicle));
    const n = this._checkpointCount || 1;
    const delta = ((idx - e.cp) % n + n) % n;
    // Respawning always puts a car back where it already was, so a small
    // backwards correction is legitimate and a large forward jump is not.
    //
    // The re-sync is unconditional (D14). This was the second site of the same
    // one-way trap, and the more likely trigger of the two: the old `else` left
    // cp frozen on exactly the large-jump case, so a car that went off and
    // respawned was silently removed from the classification for the rest of
    // the race. Flag the lap for a big forward jump — that part was right — but
    // always let the gate ring track where the car actually is. It earns no
    // gate credit for the jump either way, so nothing is gained by taking one.
    if (delta > 1 && delta < n - 2) e.lapInvalid = true;
    e.cp = idx;
  }

  dispose() {
    for (const off of this._offBus) { try { off(); } catch (_) { /* ignore */ } }
    this._offBus.length = 0;
    this._autopilot = null;
    return this;
  }
}

/* ------------------------------------------------------------------ statics */

/**
 * Classification tier. Elimination assigns a `finishOrder` just as finishing
 * does, so testing that field alone conflated the two and sorted an eliminated
 * car *above* every car still circulating — which put a car with two gates and
 * one lap-zero cut in P1, and made `this.leader` (standings[0]) that same car.
 * Every elimination gap is then measured against a wrong leader.
 */
function classRank(e) {
  if (e.eliminated) return 2;    // out of the race: always below the runners
  if (e.finishOrder) return 0;   // took the flag
  return 1;                      // still circulating
}

function compareEntries(a, b) {
  const ra = classRank(a);
  const rb = classRank(b);
  if (ra !== rb) return ra - rb;
  // Runners are ordered by validated progress; both settled tiers are already
  // numbered in finishing order (eliminations count down from the back, so the
  // car that survived longest carries the lowest number of the group).
  if (ra === 1) return b.score - a.score;
  return a.finishOrder - b.finishOrder;
}

function resolveLaps(ctx) {
  const track = ctx?.track;
  const fromTrack = track?.laps ?? track?.def?.laps;
  if (Number.isFinite(fromTrack) && fromTrack > 0) return fromTrack | 0;
  const fromSettings = ctx?.settings?.gameplay?.laps;
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings | 0;
  return 3;
}

export function makeRace(ctx) { return new Race(ctx); }

export default Race;
