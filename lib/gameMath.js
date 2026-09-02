'use strict';

/**
 * Versioned, documented game math for Lucky Birr's server-authoritative games.
 *
 * Design goals (see problem statement / README "Game Math" section):
 *  - Fixed, globally applied paytables/weights. No per-player personalization.
 *  - Target theoretical RTP is 95% (5% house edge) by default, configurable
 *    only at deploy time via `TARGET_RTP`, never per-request or per-user.
 *  - All monetary math is done in integer minor units (cents) to avoid
 *    floating point drift; only the final amount is converted to ETB.
 *  - RTP is computed analytically/exactly here (not simulated) so it can be
 *    asserted in tests and exposed via the /api/games/rules disclosure route.
 *
 * MATH_VERSION must be bumped whenever a paytable/weight changes. Historical
 * versions should be kept (not mutated) so that old rounds remain auditable
 * against the math version that was active when they were played.
 */

const MATH_VERSION = 'v1';

const RAW_TARGET_RTP = Number(process.env.TARGET_RTP);
const TARGET_RTP = Number.isFinite(RAW_TARGET_RTP) && RAW_TARGET_RTP > 0 && RAW_TARGET_RTP < 1
  ? RAW_TARGET_RTP
  : 0.95;

if (process.env.TARGET_RTP && !(Number.isFinite(RAW_TARGET_RTP) && RAW_TARGET_RTP > 0 && RAW_TARGET_RTP < 1)) {
  // Fail loud in logs rather than silently running with a bad house edge.
  console.warn(`Invalid TARGET_RTP="${process.env.TARGET_RTP}" (must be a number in (0,1)). Falling back to 0.95.`);
}

// ---------------------------------------------------------------------------
// Exact combinatorics helpers (BigInt-backed, no floating point overflow)
// ---------------------------------------------------------------------------

function combBig(n, k) {
  if (k < 0 || k > n || n < 0) return 0n;
  const kk = Math.min(k, n - k);
  let res = 1n;
  for (let i = 0; i < kk; i++) {
    res = (res * BigInt(n - i)) / BigInt(i + 1);
  }
  return res;
}

// High-precision BigInt ratio -> Number conversion (12 significant digits).
function ratioToNumber(numerator, denominator) {
  if (denominator === 0n) return 0;
  const SCALE = 10n ** 15n;
  return Number((numerator * SCALE) / denominator) / 1e15;
}

/**
 * Exact hypergeometric probability of drawing exactly `hits` matches when
 * `picks` numbers are chosen from a pool of `total`, and `drawn` are pulled
 * without replacement.
 */
function hypergeomProb(picks, drawn, total, hits) {
  const num = combBig(picks, hits) * combBig(total - picks, drawn - hits);
  const den = combBig(total, drawn);
  return ratioToNumber(num, den);
}

// ---------------------------------------------------------------------------
// KENO — pick 1-10 numbers from 1-80, 20 drawn without replacement.
// Paytable is built once per pick-count `n` at module load using a fixed,
// documented "shape" (0 below a hit threshold, doubling above it) scaled so
// that the exact expected value matches TARGET_RTP as closely as integer
// multipliers allow. The *achieved* RTP (after integer rounding) is computed
// exactly and exposed so it can be asserted in tests / shown in-app — we do
// not claim a false precision.
// ---------------------------------------------------------------------------

const KENO_TOTAL = 80;
const KENO_DRAWN = 20;

function buildKenoTable(n) {
  // Must beat roughly half your picks to win. Clamped so the threshold is
  // always reachable (n=1 would otherwise never pay out).
  const threshold = Math.max(1, Math.min(n, Math.ceil(n / 2) + 1));
  const probs = [];
  const shape = [];
  for (let h = 0; h <= n; h++) {
    probs[h] = hypergeomProb(n, KENO_DRAWN, KENO_TOTAL, h);
    shape[h] = h >= threshold ? Math.pow(2, h - threshold) : 0;
  }
  let expShape = 0;
  for (let h = 0; h <= n; h++) expShape += probs[h] * shape[h];
  const scale = expShape > 0 ? TARGET_RTP / expShape : 0;
  // Round to cent-level precision (2 decimals) rather than whole integers so
  // that low-tier-count tables (e.g. picking a single number) can still land
  // close to TARGET_RTP instead of being forced to 0.75x/1.00x-style jumps.
  const multipliers = shape.map((s) => Math.round(s * scale * 100) / 100);
  let achievedRtp = 0;
  for (let h = 0; h <= n; h++) achievedRtp += probs[h] * multipliers[h];
  return { picks: n, multipliers, probabilities: probs, achievedRtp };
}

const KENO_TABLES = {};
for (let n = 1; n <= 10; n++) KENO_TABLES[n] = buildKenoTable(n);

function kenoPayoutMultiplier(pickCount, hits) {
  const table = KENO_TABLES[pickCount];
  if (!table) return 0;
  return table.multipliers[hits] || 0;
}

// ---------------------------------------------------------------------------
// HIGHER / LOWER — draw ranks 1-13 (Ace low .. King) with replacement.
// Equal rank is an explicit push (stake fully refunded, no win/loss).
// For each visible card `k` and guess direction, the payout multiplier is
// solved analytically so that, conditioned on a decisive (non-push) outcome,
// the expected return is exactly TARGET_RTP — independent of which card is
// showing. This correctly accounts for the visible card's conditional
// probability instead of using one flat multiplier for every card.
// ---------------------------------------------------------------------------

const HL_RANKS = 13;

function higherLowerOutcomeCounts(prevCard, guess) {
  const higherCount = HL_RANKS - prevCard;
  const lowerCount = prevCard - 1;
  const winCount = guess === 'higher' ? higherCount : lowerCount;
  const loseCount = guess === 'higher' ? lowerCount : higherCount;
  const pushCount = 1; // equal rank
  return { winCount, loseCount, pushCount, decisiveCount: winCount + loseCount };
}

/**
 * Fair-minus-edge payout multiplier (applied to stake) for a given visible
 * card and guess. Returns null when the guess cannot possibly win (winCount
 * === 0) — callers must reject such bets rather than silently accepting a
 * guaranteed non-winning wager.
 */
function higherLowerMultiplier(prevCard, guess) {
  const { winCount, decisiveCount } = higherLowerOutcomeCounts(prevCard, guess);
  if (winCount === 0) return null;
  // E[payout | decisive] = (winCount/decisiveCount) * multiplier = TARGET_RTP
  return (TARGET_RTP * decisiveCount) / winCount;
}

// ---------------------------------------------------------------------------
// AVIATOR — provably-fair style crash multiplier.
// crash = max(1, m / (1 - r)), r ~ Uniform(0, 1) from a CSPRNG, m = TARGET_RTP.
// Analytic proof: for any target cashout c >= 1,
//   P(crash >= c) = P(r >= 1 - m/c) = m/c  (valid because m < 1 <= c)
//   E[payout] = stake * c * P(win) = stake * c * (m/c) = stake * m
// So the exact theoretical RTP is TARGET_RTP for every cashout target a
// player can choose — this is why the constant house edge holds regardless
// of play style. A payout cap bounds the tail (documented, slightly reduces
// realized RTP for extreme cashout targets above the cap).
// ---------------------------------------------------------------------------

const AVIATOR_MAX_MULTIPLIER = 100; // payout cap
const AVIATOR_MIN_MULTIPLIER = 1;

function aviatorCrashPoint(unitFloat) {
  const raw = TARGET_RTP / (1 - unitFloat);
  const crash = Math.max(AVIATOR_MIN_MULTIPLIER, raw);
  return Math.round(Math.min(AVIATOR_MAX_MULTIPLIER, crash) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Integer minor-unit (cent) helpers — avoid floating point money math.
// ---------------------------------------------------------------------------

function toCents(etbAmount) {
  return Math.round(Number(etbAmount) * 100);
}

function fromCents(cents) {
  return Math.round(cents) / 100;
}

module.exports = {
  MATH_VERSION,
  TARGET_RTP,
  KENO_TOTAL,
  KENO_DRAWN,
  KENO_TABLES,
  kenoPayoutMultiplier,
  HL_RANKS,
  higherLowerOutcomeCounts,
  higherLowerMultiplier,
  AVIATOR_MAX_MULTIPLIER,
  AVIATOR_MIN_MULTIPLIER,
  aviatorCrashPoint,
  toCents,
  fromCents,
  hypergeomProb,
  combBig
};
