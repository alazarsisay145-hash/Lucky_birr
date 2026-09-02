'use strict';

/**
 * Fast Keno round lifecycle.
 *
 * Rounds are *shared* between all players and run on a fixed, wall-clock
 * derived cycle so that every server process (and every reconnecting client)
 * agrees on which round is currently open without any coordination:
 *
 *   |<-- betting -->|<-- drawing -->|<-- result -->|  (repeat)
 *   0              B              B+D            cycle
 *
 * The round index is derived from `Math.floor(now / cycleMs)`, which makes the
 * schedule fully deterministic and recoverable after a restart or a client
 * refresh. Only the *draw* is random, and it is generated server-side by the
 * CSPRNG in lib/rng.js exactly once per round, then persisted so that late
 * settlement and reconnecting clients observe the same numbers.
 *
 * This module deliberately contains no database or Express code so that the
 * state machine can be unit-tested with an injected clock.
 */

const rng = require('./rng');
const gameMath = require('./gameMath');

const PHASE_BETTING = 'betting';
const PHASE_DRAWING = 'drawing';
const PHASE_RESULT = 'result';

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
}

class FastKenoEngine {
  constructor(options = {}) {
    this.bettingMs = positiveInt(options.bettingMs, 20000);
    this.drawingMs = positiveInt(options.drawingMs, 6000);
    this.resultMs = positiveInt(options.resultMs, 6000);
    this.cycleMs = this.bettingMs + this.drawingMs + this.resultMs;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.draw = typeof options.draw === 'function' ? options.draw : defaultDraw;
    // Bounded cache of already-generated draws, keyed by round index.
    this.drawCache = new Map();
    this.maxCachedRounds = 50;
  }

  /** Index of the round that contains `timestamp`. */
  roundIndexAt(timestamp) {
    return Math.floor(timestamp / this.cycleMs);
  }

  roundId(index) {
    return `fk-${index}`;
  }

  /**
   * Full timing/phase description of a round. `phase` is derived purely from
   * the clock, so wagers can be rejected the moment the betting window closes
   * without relying on any client-supplied timing.
   */
  roundAt(timestamp = this.now()) {
    const index = this.roundIndexAt(timestamp);
    const opensAt = index * this.cycleMs;
    const closesAt = opensAt + this.bettingMs;
    const drawnAt = closesAt + this.drawingMs;
    const endsAt = opensAt + this.cycleMs;
    let phase = PHASE_BETTING;
    if (timestamp >= drawnAt) phase = PHASE_RESULT;
    else if (timestamp >= closesAt) phase = PHASE_DRAWING;
    return {
      index,
      id: this.roundId(index),
      phase,
      opensAt,
      closesAt,
      drawnAt,
      endsAt,
      msRemaining: Math.max(0, (phase === PHASE_BETTING ? closesAt : phase === PHASE_DRAWING ? drawnAt : endsAt) - timestamp)
    };
  }

  /** True when a wager may still be accepted for `roundIndex` right now. */
  isBettingOpen(roundIndex, timestamp = this.now()) {
    const round = this.roundAt(timestamp);
    return round.index === roundIndex && round.phase === PHASE_BETTING;
  }

  /** True once the numbers for `roundIndex` are allowed to be revealed. */
  isDrawn(roundIndex, timestamp = this.now()) {
    const drawnAt = roundIndex * this.cycleMs + this.bettingMs + this.drawingMs;
    return timestamp >= drawnAt;
  }

  /**
   * Returns the drawn numbers for a round, generating them with the CSPRNG on
   * first use. Never returns numbers before the round's draw time so that a
   * player can not learn the outcome while betting is still open.
   */
  getDraw(roundIndex, timestamp = this.now()) {
    if (!this.isDrawn(roundIndex, timestamp)) return null;
    const cached = this.drawCache.get(roundIndex);
    if (cached) return cached;
    const drawn = this.draw();
    this.rememberDraw(roundIndex, drawn);
    return drawn;
  }

  /**
   * Adopts an externally persisted draw (e.g. loaded back from the database
   * after a restart) so that settlement stays consistent across processes.
   */
  rememberDraw(roundIndex, drawn) {
    const numbers = [...drawn].sort((a, b) => a - b);
    this.drawCache.set(roundIndex, numbers);
    while (this.drawCache.size > this.maxCachedRounds) {
      const oldest = this.drawCache.keys().next().value;
      this.drawCache.delete(oldest);
    }
    return numbers;
  }
}

function defaultDraw() {
  const pool = Array.from({ length: gameMath.FAST_KENO_TOTAL }, (_, i) => i + 1);
  return rng.secureSample(pool, gameMath.FAST_KENO_DRAWN).sort((a, b) => a - b);
}

/**
 * Validates a set of player picks. Returns a normalised, de-duplicated,
 * ascending array or throws an Error carrying a 400 `status`.
 */
function normalisePicks(rawPicks) {
  const picks = Array.isArray(rawPicks) ? [...new Set(rawPicks.map(Number))] : [];
  const valid = picks.every((n) => Number.isInteger(n) && n >= 1 && n <= gameMath.FAST_KENO_TOTAL);
  if (!valid || picks.length < 1 || picks.length > gameMath.FAST_KENO_MAX_PICKS) {
    const err = new Error(
      `Pick 1–${gameMath.FAST_KENO_MAX_PICKS} distinct numbers between 1 and ${gameMath.FAST_KENO_TOTAL}`
    );
    err.status = 400;
    throw err;
  }
  return picks.sort((a, b) => a - b);
}

/** Server-side payout evaluation for a settled Fast Keno bet. */
function evaluateBet(picks, drawn, stakeCents) {
  const drawnSet = new Set(drawn);
  const matched = picks.filter((n) => drawnSet.has(n));
  const multiplier = gameMath.fastKenoPayoutMultiplier(picks.length, matched.length);
  const payoutCents = Math.round(stakeCents * multiplier);
  return { matched, hits: matched.length, multiplier, payoutCents };
}

module.exports = {
  FastKenoEngine,
  normalisePicks,
  evaluateBet,
  defaultDraw,
  PHASE_BETTING,
  PHASE_DRAWING,
  PHASE_RESULT
};
