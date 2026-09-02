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
 * Cryptographically secure uniform float in [0, 1). Uses 53 bits of entropy,
 * matching IEEE-754 double mantissa precision.
 */
function secureUnitFloat() {
  const bytes = crypto.randomBytes(7); // 56 bits, we use 53
  let value = 0;
  for (let i = 0; i < 7; i++) value = value * 256 + bytes[i];
  // Reduce 56-bit value to a 53-bit mantissa fraction in [0, 1).
  const MAX = Math.pow(2, 56);
  return value / MAX;
}

module.exports = { secureInt, secureShuffle, secureSample, secureUnitFloat };
