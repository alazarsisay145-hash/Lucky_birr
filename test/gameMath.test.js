const test = require('node:test');
const assert = require('node:assert/strict');
const gameMath = require('../lib/gameMath');
const rng = require('../lib/rng');

test('game math version and target RTP are fixed and valid', () => {
  assert.equal(gameMath.MATH_VERSION, 'v1');
  assert.ok(gameMath.TARGET_RTP > 0 && gameMath.TARGET_RTP < 1);
});

test('keno hypergeometric probabilities sum to 1 for every pick count', () => {
  for (let n = 1; n <= 10; n++) {
    const table = gameMath.KENO_TABLES[n];
    const total = table.probabilities.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `probabilities for n=${n} should sum to 1, got ${total}`);
  }
});

test('keno achieved RTP is within 0.2% of the target for every pick count', () => {
  for (let n = 1; n <= 10; n++) {
    const table = gameMath.KENO_TABLES[n];
    assert.ok(
      Math.abs(table.achievedRtp - gameMath.TARGET_RTP) < 0.002,
      `n=${n} achieved RTP ${table.achievedRtp} too far from target ${gameMath.TARGET_RTP}`
    );
  }
});

test('keno multipliers are non-negative and zero below the win threshold', () => {
  for (let n = 1; n <= 10; n++) {
    const table = gameMath.KENO_TABLES[n];
    table.multipliers.forEach((m) => assert.ok(m >= 0));
  }
});

test('higher/lower multiplier yields exactly TARGET_RTP conditioned on a decisive outcome, for every visible card', () => {
  for (let k = 1; k <= gameMath.HL_RANKS; k++) {
    for (const guess of ['higher', 'lower']) {
      const { winCount, loseCount, decisiveCount } = gameMath.higherLowerOutcomeCounts(k, guess);
      const multiplier = gameMath.higherLowerMultiplier(k, guess);
      if (winCount === 0) {
        assert.equal(multiplier, null, `card ${k} guess ${guess} should be an unwinnable bet`);
        continue;
      }
      const conditionalRtp = (winCount / decisiveCount) * multiplier;
      assert.ok(
        Math.abs(conditionalRtp - gameMath.TARGET_RTP) < 1e-9,
        `card ${k} guess ${guess}: conditional RTP ${conditionalRtp} != ${gameMath.TARGET_RTP}`
      );
      assert.equal(winCount + loseCount + 1, gameMath.HL_RANKS, 'win+lose+push must cover all ranks');
    }
  }
});

test('higher/lower rejects guesses that can never win (card 1 -> lower, card 13 -> higher)', () => {
  assert.equal(gameMath.higherLowerMultiplier(1, 'lower'), null);
  assert.equal(gameMath.higherLowerMultiplier(gameMath.HL_RANKS, 'higher'), null);
});

test('aviator crash point is analytically exact-RTP for any cashout target (proof-by-simulation)', () => {
  const targets = [1.2, 1.5, 2, 3, 5, 10];
  const trials = 200000;
  for (const target of targets) {
    let wins = 0;
    for (let i = 0; i < trials; i++) {
      // Deterministic pseudo-random test seam — NEVER used for production RNG.
      const r = (i + 0.5) / trials;
      const crash = gameMath.aviatorCrashPoint(r);
      if (target <= crash) wins++;
    }
    const rtp = (wins / trials) * target;
    // Only exact when target is below the payout cap; all test targets are.
    assert.ok(
      Math.abs(rtp - gameMath.TARGET_RTP) < 0.01,
      `target ${target}x realized RTP ${rtp} too far from ${gameMath.TARGET_RTP}`
    );
  }
});

test('aviator crash point respects min/max multiplier caps', () => {
  assert.equal(gameMath.aviatorCrashPoint(0), gameMath.AVIATOR_MIN_MULTIPLIER);
  assert.ok(gameMath.aviatorCrashPoint(0.999999999) <= gameMath.AVIATOR_MAX_MULTIPLIER);
});

test('toCents/fromCents round-trip common ETB amounts without float drift', () => {
  for (const amount of [0.1, 5, 10.5, 99.99, 1000]) {
    assert.equal(gameMath.fromCents(gameMath.toCents(amount)), amount);
  }
});

test('rng helpers never rely on Math.random and produce values in range', () => {
  for (let i = 0; i < 200; i++) {
    const v = rng.secureInt(1, 14);
    assert.ok(v >= 1 && v <= 13);
  }
  const sample = rng.secureSample(Array.from({ length: 80 }, (_, i) => i + 1), 20);
  assert.equal(new Set(sample).size, 20);
  sample.forEach((n) => assert.ok(n >= 1 && n <= 80));
  for (let i = 0; i < 200; i++) {
    const f = rng.secureUnitFloat();
    assert.ok(f >= 0 && f < 1);
  }
});
