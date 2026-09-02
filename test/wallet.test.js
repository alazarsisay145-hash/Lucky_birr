const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { createHmac } = require('node:crypto');

const JWT_SECRET = 'test-jwt-secret-32-chars-exactly!!';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(port, extraEnv = {}) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', JWT_SECRET, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return server;
}

async function stopServer(server) {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    wait(2000)
  ]);
}

function token(overrides = {}) {
  return jwt.sign({ id: '11111111-1111-1111-1111-111111111111', email: 'player@example.com', ...overrides }, JWT_SECRET, {
    expiresIn: '1h'
  });
}

async function withServer(port, fn, extraEnv) {
  const server = spawnServer(port, extraEnv);
  try {
    await wait(1400);
    await fn();
  } finally {
    await stopServer(server);
  }
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() };
}

test('wallet and Fast Keno wagering endpoints require authentication', async () => {
  await withServer(3140, async () => {
    const base = 'http://127.0.0.1:3140';
    const cases = [
      ['GET', '/api/wallet/summary'],
      ['GET', '/api/withdrawals'],
      ['POST', '/api/withdrawals/abc/cancel'],
      ['POST', '/api/games/fast-keno/bet'],
      ['GET', '/api/deposits/LB-DEP-x/status']
    ];
    for (const [method, path] of cases) {
      const resp = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(resp.status, 401, `${method} ${path} must require a token`);
    }
  });
});

test('admin-only wallet routes reject a non-admin token', async () => {
  await withServer(3141, async () => {
    const base = 'http://127.0.0.1:3141';
    for (const path of ['/api/admin/withdrawals/abc/complete', '/api/admin/withdrawals/abc/reject', '/api/admin/deposits/abc/approve', '/api/admin/deposits/abc/reject']) {
      const resp = await fetch(base + path, { method: 'POST', headers: authHeaders(), body: '{}' });
      assert.equal(resp.status, 403, `${path} must require admin`);
    }
  });
});

test('withdrawal validation rejects bad amounts, methods and account details', async () => {
  await withServer(3142, async () => {
    const base = 'http://127.0.0.1:3142';
    const bad = [
      { amount: 10, payment_method: 'telebirr', account_number: '0911234567', account_name: 'Abebe K' },
      { amount: 1000000, payment_method: 'telebirr', account_number: '0911234567', account_name: 'Abebe K' },
      { amount: 'lots', payment_method: 'telebirr', account_number: '0911234567', account_name: 'Abebe K' },
      { amount: 100, payment_method: 'paypal', account_number: '0911234567', account_name: 'Abebe K' },
      { amount: 100, payment_method: 'telebirr', account_number: 'abc', account_name: 'Abebe K' },
      { amount: 100, payment_method: 'telebirr', account_number: '0911234567', account_name: 'A' }
    ];
    for (const body of bad) {
      const resp = await fetch(base + '/api/withdrawals', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      assert.equal(resp.status, 400, `should reject ${JSON.stringify(body)}`);
      const data = await resp.json();
      assert.ok(data.error);
    }
  });
});

test('withdrawal limits are configurable through the environment', async () => {
  await withServer(3143, async () => {
    const resp = await fetch('http://127.0.0.1:3143/api/withdrawals', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ amount: 20, payment_method: 'telebirr', account_number: '0911234567', account_name: 'Abebe K' })
    });
    // 20 ETB is below the default 50 minimum but above the configured one, so
    // validation passes and the request only fails on the missing database.
    assert.equal(resp.status, 503);
  }, { WITHDRAW_MIN_ETB: '10', WITHDRAW_MAX_ETB: '100' });
});

test('deposit initialization enforces configured limits and currency', async () => {
  await withServer(3144, async () => {
    const base = 'http://127.0.0.1:3144';
    for (const body of [{ amount: 1 }, { amount: 10000000 }, { amount: 'free' }, { amount: 100, currency: 'USD' }]) {
      const resp = await fetch(base + '/api/deposits/initialize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      assert.equal(resp.status, 400, `should reject ${JSON.stringify(body)}`);
    }
  }, { CHAPA_SECRET_KEY: 'CHASECK_TEST-placeholder' });
});

test('transaction history validates filters and requires a token', async () => {
  await withServer(3145, async () => {
    const base = 'http://127.0.0.1:3145';
    const anonymous = await fetch(base + '/api/transactions');
    assert.equal(anonymous.status, 401);

    const badFilter = await fetch(base + '/api/transactions?filter=everything', { headers: authHeaders() });
    assert.equal(badFilter.status, 400);

    const badType = await fetch(base + '/api/transactions?type=free_money', { headers: authHeaders() });
    assert.equal(badType.status, 400);

    const okFilter = await fetch(base + '/api/transactions?filter=deposits', { headers: authHeaders() });
    assert.equal(okFilter.status, 503, 'valid filters pass validation and only fail on the missing database');
  });
});

const WEBHOOK_SECRET = 'webhook-secret-value';

// Chapa signs the raw request body with HMAC-SHA256 keyed on the webhook secret.
function chapaSignature(body, secret = WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

test('deposit callback rejects a wrong or missing webhook signature', async () => {
  await withServer(3146, async () => {
    const base = 'http://127.0.0.1:3146';
    const wrong = await fetch(base + '/api/deposits/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Chapa-Signature': 'not-the-secret' },
      body: JSON.stringify({ tx_ref: 'LB-DEP-abc-1', status: 'success' })
    });
    assert.equal(wrong.status, 403);

    const missing = await fetch(base + '/api/deposits/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_ref: 'LB-DEP-abc-1', status: 'success' })
    });
    assert.equal(missing.status, 403);
  }, { CHAPA_WEBHOOK_SECRET: WEBHOOK_SECRET });
});

test('deposit callback with a valid signature still rejects a malformed reference', async () => {
  const body = JSON.stringify({ tx_ref: '../../etc/passwd', status: 'success' });
  await withServer(3147, async () => {
    const resp = await fetch('http://127.0.0.1:3147/api/deposits/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Chapa-Signature': chapaSignature(body) },
      body
    });
    assert.equal(resp.status, 400);
  }, { CHAPA_WEBHOOK_SECRET: WEBHOOK_SECRET });
});

test('deposit callback accepts an HMAC signature over the exact request body', async () => {
  const body = JSON.stringify({ tx_ref: 'LB-DEP-abc-1', status: 'success' });
  await withServer(3154, async () => {
    const base = 'http://127.0.0.1:3154';
    const accepted = await fetch(base + '/api/deposits/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Chapa-Signature': chapaSignature(body) },
      body
    });
    // The signature passes, so the request reaches the database guard rather
    // than being rejected as unauthenticated.
    assert.equal(accepted.status, 503);

    // The same signature must not authenticate a different payload.
    const tampered = await fetch(base + '/api/deposits/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Chapa-Signature': chapaSignature(body) },
      body: JSON.stringify({ tx_ref: 'LB-DEP-attacker-1', status: 'success' })
    });
    assert.equal(tampered.status, 403);
  }, { CHAPA_WEBHOOK_SECRET: WEBHOOK_SECRET });
});

test('Fast Keno round state is public, server-timed and hides the draw while betting', async () => {
  await withServer(3148, async () => {
    const resp = await fetch('http://127.0.0.1:3148/api/games/fast-keno/state');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.ok);
    assert.ok(['betting', 'drawing', 'result'].includes(data.round.phase));
    assert.ok(data.round.ms_remaining >= 0);
    assert.match(data.round.id, /^fk-\d+$/);
    assert.equal(data.config.pool, 40);
    assert.equal(data.config.draw_count, 10);
    assert.equal(data.config.max_picks, 8);
    if (data.round.phase !== 'result') {
      assert.equal(data.round.drawn, null, 'numbers must not leak before the draw');
    }
    // No token supplied, so no personal bet data is returned.
    assert.equal(data.bet, null);
    assert.deepEqual(data.recent_bets, []);
  }, { FAST_KENO_BETTING_MS: '20000' });
});

test('Fast Keno rejects invalid stakes and picks before touching the database', async () => {
  await withServer(3149, async () => {
    const base = 'http://127.0.0.1:3149';
    const bad = [
      { bet_amount: 1, picks: [1, 2] },
      { bet_amount: 100000, picks: [1, 2] },
      { bet_amount: 10, picks: [] },
      { bet_amount: 10, picks: [0] },
      { bet_amount: 10, picks: [41] },
      { bet_amount: 10, picks: [1, 2, 3, 4, 5, 6, 7, 8, 9] }
    ];
    for (const body of bad) {
      const resp = await fetch(base + '/api/games/fast-keno/bet', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      assert.equal(resp.status, 400, `should reject ${JSON.stringify(body)}`);
    }
  });
});

test('Fast Keno rejects a wager aimed at a round that already closed', async () => {
  await withServer(3150, async () => {
    const resp = await fetch('http://127.0.0.1:3150/api/games/fast-keno/bet', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ bet_amount: 10, picks: [1, 2, 3], round_id: 'fk-1' })
    });
    assert.equal(resp.status, 409, 'a stale round id must never be settled against the live round');
    const data = await resp.json();
    assert.ok(data.error);
  });
});

test('Fast Keno bets are not accepted through the instant-game endpoint', async () => {
  await withServer(3151, async () => {
    const resp = await fetch('http://127.0.0.1:3151/api/games/bet', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ game: 'fast_keno', bet_amount: 10, picks: [1, 2] })
    });
    assert.equal(resp.status, 400);
  });
});

test('dice wagers are validated server-side', async () => {
  await withServer(3152, async () => {
    const base = 'http://127.0.0.1:3152';
    const bad = [
      { game: 'dice', bet_amount: 10, direction: 'sideways', target: 50 },
      { game: 'dice', bet_amount: 10, direction: 'under', target: 1 },
      { game: 'dice', bet_amount: 10, direction: 'over', target: 100 },
      { game: 'dice', bet_amount: 10, direction: 'under', target: 12.5 },
      { game: 'dice', bet_amount: 1, direction: 'under', target: 50 }
    ];
    for (const body of bad) {
      const resp = await fetch(base + '/api/games/bet', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      assert.equal(resp.status, 400, `should reject ${JSON.stringify(body)}`);
    }

    // A valid dice wager passes validation and only stops at the database.
    const valid = await fetch(base + '/api/games/bet', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ game: 'dice', bet_amount: 10, direction: 'under', target: 50 })
    });
    assert.equal(valid.status, 503);
  });
});

test('game rules disclosure includes Fast Keno and Dice paytables', async () => {
  await withServer(3153, async () => {
    const resp = await fetch('http://127.0.0.1:3153/api/games/rules');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.games.fast_keno);
    assert.ok(data.games.dice);
    assert.ok(data.games.fast_keno.paytables['3']);
    assert.ok(data.limits.fast_keno.min_bet > 0);
    assert.ok(data.limits.dice.max_bet > 0);
  });
});
