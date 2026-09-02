const test = require('node:test');
const assert = require('node:assert/strict');
const fastKeno = require('../lib/fastKeno');
const gameMath = require('../lib/gameMath');

function makeEngine(overrides = {}) {
  let now = 0;
  const engine = new fastKeno.FastKenoEngine({
    bettingMs: 20000,
    drawingMs: 6000,
    resultMs: 6000,
    now: () => now,
    ...overrides
  });
  return { engine, setNow: (value) => { now = value; }, getNow: () => now };
}

test('round cycle length is the sum of the configured phases', () => {
  const { engine } = makeEngine();
  assert.equal(engine.cycleMs, 32000);
});

test('phase transitions follow the wall clock: betting -> drawing -> result', () => {
  const { engine } = makeEngine();
  assert.equal(engine.roundAt(0).phase, fastKeno.PHASE_BETTING);
  assert.equal(engine.roundAt(19999).phase, fastKeno.PHASE_BETTING);
  assert.equal(engine.roundAt(20000).phase, fastKeno.PHASE_DRAWING);
  assert.equal(engine.roundAt(25999).phase, fastKeno.PHASE_DRAWING);
  assert.equal(engine.roundAt(26000).phase, fastKeno.PHASE_RESULT);
  assert.equal(engine.roundAt(31999).phase, fastKeno.PHASE_RESULT);
  // Next round starts a fresh betting window.
  const next = engine.roundAt(32000);
  assert.equal(next.phase, fastKeno.PHASE_BETTING);
  assert.equal(next.index, 1);
});

test('round ids are stable and derived from the clock so clients can reconnect', () => {
  const { engine } = makeEngine();
  assert.equal(engine.roundAt(5000).id, engine.roundAt(19000).id);
  assert.notEqual(engine.roundAt(5000).id, engine.roundAt(40000).id);
  assert.equal(engine.roundAt(40000).id, 'fk-1');
});

test('wagers are only open during the betting window of the current round', () => {
  const { engine } = makeEngine();
  assert.equal(engine.isBettingOpen(0, 10000), true);
  assert.equal(engine.isBettingOpen(0, 20000), false, 'closed the instant the window ends');
  assert.equal(engine.isBettingOpen(0, 26000), false);
  assert.equal(engine.isBettingOpen(0, 40000), false, 'a past round can never be bet on again');
  assert.equal(engine.isBettingOpen(1, 10000), false, 'a future round can not be bet on early');
});

test('draw is never revealed before the round draw time', () => {
  const { engine } = makeEngine();
  assert.equal(engine.getDraw(0, 0), null);
  assert.equal(engine.getDraw(0, 19999), null);
  assert.equal(engine.getDraw(0, 25999), null, 'still hidden while drawing');
  const drawn = engine.getDraw(0, 26000);
  assert.ok(Array.isArray(drawn));
  assert.equal(drawn.length, gameMath.FAST_KENO_DRAWN);
});

test('a round is drawn exactly once and then cached', () => {
  let calls = 0;
  const { engine } = makeEngine({
    draw: () => { calls += 1; return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; }
  });
  const first = engine.getDraw(0, 26000);
  const second = engine.getDraw(0, 30000);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test('draws contain distinct in-range numbers', () => {
  for (let i = 0; i < 50; i++) {
    const drawn = fastKeno.defaultDraw();
    assert.equal(drawn.length, gameMath.FAST_KENO_DRAWN);
    assert.equal(new Set(drawn).size, gameMath.FAST_KENO_DRAWN);
    drawn.forEach((n) => {
      assert.ok(Number.isInteger(n) && n >= 1 && n <= gameMath.FAST_KENO_TOTAL);
    });
    const sorted = [...drawn].sort((a, b) => a - b);
    assert.deepEqual(drawn, sorted, 'draws are returned in ascending order');
  }
});

test('an externally persisted draw is adopted so restarts stay consistent', () => {
  const { engine } = makeEngine({ draw: () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  engine.rememberDraw(7, [40, 3, 12]);
  assert.deepEqual(engine.getDraw(7, 10 ** 9), [3, 12, 40]);
});

test('the draw cache is bounded so long-running servers do not leak memory', () => {
  const { engine } = makeEngine();
  for (let i = 0; i < 200; i++) engine.rememberDraw(i, [i + 1]);
  assert.ok(engine.drawCache.size <= engine.maxCachedRounds);
});

test('picks are validated, de-duplicated and sorted', () => {
  assert.deepEqual(fastKeno.normalisePicks([5, 1, 5, 3]), [1, 3, 5]);
  assert.deepEqual(fastKeno.normalisePicks(['7', 2]), [2, 7]);
});

test('invalid picks are rejected with a 400 status', () => {
  const invalid = [
    [],
    undefined,
    'not-an-array',
    [0],
    [gameMath.FAST_KENO_TOTAL + 1],
    [1.5],
    Array.from({ length: gameMath.FAST_KENO_MAX_PICKS + 1 }, (_, i) => i + 1)
  ];
  for (const picks of invalid) {
    assert.throws(() => fastKeno.normalisePicks(picks), (err) => err.status === 400, `should reject ${JSON.stringify(picks)}`);
  }
});

test('payout evaluation matches the versioned paytable, in integer cents', () => {
  const drawn = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const evaluation = fastKeno.evaluateBet([1, 2, 3, 40], drawn, 1000);
  assert.deepEqual(evaluation.matched, [1, 2, 3]);
  assert.equal(evaluation.hits, 3);
  assert.equal(evaluation.multiplier, gameMath.fastKenoPayoutMultiplier(4, 3));
  assert.equal(evaluation.payoutCents, Math.round(1000 * gameMath.fastKenoPayoutMultiplier(4, 3)));
  assert.ok(Number.isInteger(evaluation.payoutCents));
});

test('a losing ticket pays nothing', () => {
  const evaluation = fastKeno.evaluateBet([31, 32, 33], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 500);
  assert.equal(evaluation.hits, 0);
  assert.equal(evaluation.payoutCents, 0);
});

test('fast keno paytable probabilities sum to 1 and achieve the target RTP', () => {
  for (let n = 1; n <= gameMath.FAST_KENO_MAX_PICKS; n++) {
    const table = gameMath.FAST_KENO_TABLES[n];
    const total = table.probabilities.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `probabilities for n=${n} sum to ${total}`);
    assert.ok(
      Math.abs(table.achievedRtp - gameMath.TARGET_RTP) < 0.005,
      `n=${n} achieved RTP ${table.achievedRtp} too far from ${gameMath.TARGET_RTP}`
    );
    table.multipliers.forEach((m) => assert.ok(m >= 0));
  }
});

test('fast keno never pays for an unknown pick count', () => {
  assert.equal(gameMath.fastKenoPayoutMultiplier(0, 0), 0);
  assert.equal(gameMath.fastKenoPayoutMultiplier(gameMath.FAST_KENO_MAX_PICKS + 1, 5), 0);
});
