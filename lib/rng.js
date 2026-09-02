'use strict';

/**
 * Cryptographically secure RNG helpers for monetary/demo-credit game outcomes.
 *
 * IMPORTANT: `Math.random()` must never be used to decide a game outcome that
 * affects a player's balance. Node's `crypto.randomInt` is used exclusively
 * here (CSPRNG backed). Test seams that allow deterministic outcomes are
 * exposed only for automated tests and must never be wired into production
 * request handling.
 */
const crypto = require('crypto');

/**
 * Returns a cryptographically secure integer in [min, max) (max exclusive).
 */
function secureInt(min, max) {
  return crypto.randomInt(min, max);
}

/**
 * Fisher-Yates shuffle using a CSPRNG. Returns a new array; input is not mutated.
 */
function secureShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Draws `count` distinct items from `pool` without replacement using a CSPRNG.
 */
function secureSample(pool, count) {
  return secureShuffle(pool).slice(0, count);
}

/**
 * Cryptographically secure uniform float in [0, 1). Uses `crypto.randomInt`,
 * which performs unbiased rejection sampling internally (unlike dividing raw
 * random bytes, which would introduce modulo/rounding bias).
 */
function secureUnitFloat() {
  const MAX = 2 ** 48 - 1; // crypto.randomInt supports ranges up to 2^48 - 1
  return secureInt(0, MAX) / MAX;
}

module.exports = { secureInt, secureShuffle, secureSample, secureUnitFloat };
