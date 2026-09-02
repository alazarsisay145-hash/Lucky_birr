const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const paymentDestinations = require('../lib/paymentDestinations');

const JWT_SECRET = 'test-jwt-secret-32-chars-exactly!!';
const ADMIN_EMAIL = 'boss@example.com';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(port, extraEnv = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      JWT_SECRET,
      ADMIN_EMAILS: ADMIN_EMAIL,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function withServer(port, fn, extraEnv) {
  const server = spawnServer(port, extraEnv);
  try {
    await wait(1400);
    await fn();
  } finally {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), wait(2000)]);
  }
}

function token(overrides = {}) {
  return jwt.sign(
    { id: '11111111-1111-1111-1111-111111111111', email: 'player@example.com', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function playerHeaders() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() };
}

function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token({ id: '22222222-2222-2222-2222-222222222222', email: ADMIN_EMAIL })
  };
}

function proofForm(overrides = {}, file = { bytes: 2048, type: 'image/png', name: 'proof.png' }) {
  const fd = new FormData();
  const body = {
    amount: '250',
    destination_id: 'telebirr',
    sender_reference: '0912345678',
    ...overrides
  };
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) fd.append(key, String(value));
  }
  if (file) {
    fd.append('screenshot', new Blob([Buffer.alloc(file.bytes, 1)], { type: file.type }), file.name);
  }
  return fd;
}

function uploadHeaders() {
  return { Authorization: 'Bearer ' + token() };
}

// ===== Configuration unit tests =====

test('the Telebirr destination 0936719379 is offered by default', () => {
  const { destinations, warnings } = paymentDestinations.loadDestinations({});
  assert.equal(warnings.length, 0);
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].type, 'telebirr');
  assert.equal(destinations[0].account_number, '0936719379');
});

test('configured bank destinations are validated and normalised', () => {
  const { destinations, warnings } = paymentDestinations.loadDestinations({
    MANUAL_PAYMENT_ACCOUNTS_JSON: JSON.stringify([
      { id: 'CBE', type: 'bank', bank_name: 'Commercial Bank of Ethiopia', account_holder: 'Example Holder', account_number: '1000123456789' },
      { id: 'broken', type: 'bank', bank_name: 'No Account' },
      { id: 'cbe', type: 'bank', bank_name: 'Duplicate', account_holder: 'Example Holder', account_number: '1000123456789' }
    ])
  });

  const ids = destinations.map((d) => d.id);
  assert.ok(ids.includes('cbe'), 'valid bank entry is kept and lower-cased');
  assert.ok(ids.includes('telebirr'), 'the Telebirr destination is always offered');
  assert.equal(destinations.filter((d) => d.id === 'cbe').length, 1, 'duplicate ids are dropped');
  assert.equal(warnings.length, 2, 'invalid and duplicate entries are reported');
  assert.ok(warnings.every((w) => !w.includes('1000123456789')), 'warnings never echo account numbers');
});

test('invalid destination JSON falls back to Telebirr instead of guessing bank details', () => {
  const { destinations, warnings } = paymentDestinations.loadDestinations({
    MANUAL_PAYMENT_ACCOUNTS_JSON: '{not json'
  });
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].account_number, '0936719379');
  assert.equal(warnings.length, 1);
});

test('Ethiopian phone validation accepts local and +251 formats only', () => {
  for (const good of ['0912345678', '0712345678', '+251912345678', '251912345678', '0936719379']) {
    assert.ok(paymentDestinations.isEthiopianPhone(good), `${good} should be valid`);
  }
  for (const bad of ['091234567', '09123456789', '0812345678', '+44912345678', 'abcdefghij', '']) {
    assert.ok(!paymentDestinations.isEthiopianPhone(bad), `${bad} should be rejected`);
  }
});

test('account numbers are masked down to the last four characters', () => {
  assert.equal(paymentDestinations.maskAccount('1000123456789'), '*********6789');
  assert.equal(paymentDestinations.maskAccount('123'), '***');
});

// ===== Authorization boundaries =====

test('manual wallet endpoints require authentication', async () => {
  await withServer(3160, async () => {
    const base = 'http://127.0.0.1:3160';
    const cases = [
      ['GET', '/api/payment/destinations'],
      ['GET', '/api/deposits/manual'],
      ['POST', '/api/deposits/manual'],
      ['GET', '/api/deposits/11111111-1111-1111-1111-111111111111/proof'],
      ['GET', '/api/admin/deposits'],
      ['GET', '/api/admin/withdrawals']
    ];
    for (const [method, path] of cases) {
      const resp = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined
      });
      assert.equal(resp.status, 401, `${method} ${path} must require a token`);
    }
  });
});

test('a normal player can not reach the admin review endpoints', async () => {
  await withServer(3161, async () => {
    const base = 'http://127.0.0.1:3161';
    const id = '33333333-3333-3333-3333-333333333333';
    const gets = ['/api/admin/deposits', '/api/admin/withdrawals'];
    for (const path of gets) {
      const resp = await fetch(base + path, { headers: playerHeaders() });
      assert.equal(resp.status, 403, `${path} must require admin`);
    }
    const posts = [
      `/api/admin/deposits/${id}/approve`,
      `/api/admin/deposits/${id}/reject`,
      `/api/admin/withdrawals/${id}/paid`,
      `/api/admin/withdrawals/${id}/processing`,
      `/api/admin/withdrawals/${id}/reject`
    ];
    for (const path of posts) {
      const resp = await fetch(base + path, { method: 'POST', headers: playerHeaders(), body: '{}' });
      assert.equal(resp.status, 403, `${path} must require admin`);
    }
  });
});

// ===== Destination endpoint =====

test('the destinations endpoint exposes only public payment details', async () => {
  await withServer(3162, async () => {
    const resp = await fetch('http://127.0.0.1:3162/api/payment/destinations', { headers: playerHeaders() });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.chapa_enabled, false, 'the automatic gateway stays disabled by default');
    const telebirr = data.destinations.find((d) => d.type === 'telebirr');
    assert.equal(telebirr.account_number, '0936719379');
    const bank = data.destinations.find((d) => d.id === 'demo-bank');
    assert.deepEqual(Object.keys(bank).sort(), ['account_holder', 'account_number', 'bank_name', 'id', 'instructions', 'type']);
    assert.ok(data.notice.length > 0, 'players are told the transfer is manual');
    assert.ok(data.limits.deposit_min > 0);
  }, {
    MANUAL_PAYMENT_ACCOUNTS_JSON: JSON.stringify([
      { id: 'demo-bank', type: 'bank', bank_name: 'Demo Bank', account_holder: 'Example Holder', account_number: '1000000000000' }
    ])
  });
});

// ===== Deposit proof submission =====

test('deposit proof submission validates the payload server-side', async () => {
  await withServer(3163, async () => {
    const base = 'http://127.0.0.1:3163/api/deposits/manual';
    const cases = [
      [proofForm({ amount: '1' }), 'amount below the minimum'],
      [proofForm({ amount: '999999999' }), 'amount above the maximum'],
      [proofForm({ amount: 'lots' }), 'non-numeric amount'],
      [proofForm({ destination_id: 'unknown-bank' }), 'unconfigured destination'],
      [proofForm({ sender_reference: 'x' }), 'missing sender reference'],
      [proofForm({ external_reference: '../../etc/passwd' }), 'path-like reference'],
      [proofForm({}, null), 'missing proof file']
    ];
    for (const [form, label] of cases) {
      const resp = await fetch(base, { method: 'POST', headers: uploadHeaders(), body: form });
      assert.equal(resp.status, 400, `should reject ${label}`);
      const data = await resp.json();
      assert.ok(data.error, `${label} returns an error message`);
    }
  });
});

test('only supported image types and sizes are accepted as proof', async () => {
  await withServer(3164, async () => {
    const base = 'http://127.0.0.1:3164/api/deposits/manual';

    const badType = await fetch(base, {
      method: 'POST',
      headers: uploadHeaders(),
      body: proofForm({}, { bytes: 1024, type: 'application/pdf', name: 'receipt.pdf' })
    });
    assert.equal(badType.status, 400, 'PDF uploads are rejected');

    const tooBig = await fetch(base, {
      method: 'POST',
      headers: uploadHeaders(),
      body: proofForm({}, { bytes: 7 * 1024 * 1024, type: 'image/png', name: 'huge.png' })
    });
    assert.equal(tooBig.status, 400, 'oversized uploads are rejected');

    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      const resp = await fetch(base, {
        method: 'POST',
        headers: uploadHeaders(),
        body: proofForm({}, { bytes: 2048, type, name: 'proof' })
      });
      // A valid payload passes validation and can only fail on the missing
      // database – and even then it never credits a balance.
      assert.equal(resp.status, 503, `${type} passes validation`);
    }
  });
});

test('a valid proof submission never reports a completed deposit', async () => {
  await withServer(3165, async () => {
    const resp = await fetch('http://127.0.0.1:3165/api/deposits/manual', {
      method: 'POST',
      headers: uploadHeaders(),
      body: proofForm({ external_reference: 'TX-12345', note: 'sent from my phone' })
    });
    assert.equal(resp.status, 503, 'without a database nothing is recorded');
    const data = await resp.json();
    assert.ok(!/successful/i.test(JSON.stringify(data)), 'no success-sounding deposit copy');
    assert.ok(!('balance' in data), 'the response never carries a balance');
  });
});

test('proof access rejects malformed ids before touching storage', async () => {
  await withServer(3166, async () => {
    const resp = await fetch('http://127.0.0.1:3166/api/deposits/..%2F..%2Fsecret/proof', { headers: playerHeaders() });
    assert.equal(resp.status, 400);
  });
});

test('admin review endpoints validate ids and status filters', async () => {
  await withServer(3167, async () => {
    const base = 'http://127.0.0.1:3167';
    const badFilter = await fetch(base + '/api/admin/deposits?status=everything', { headers: adminHeaders() });
    assert.equal(badFilter.status, 400);

    const badWdFilter = await fetch(base + '/api/admin/withdrawals?status=everything', { headers: adminHeaders() });
    assert.equal(badWdFilter.status, 400);

    const badId = await fetch(base + '/api/admin/deposits/not-a-uuid/approve', {
      method: 'POST',
      headers: adminHeaders(),
      body: '{}'
    });
    assert.equal(badId.status, 400);
  });
});

// ===== Withdrawals =====

test('Telebirr withdrawals require a valid Ethiopian mobile number', async () => {
  await withServer(3168, async () => {
    const base = 'http://127.0.0.1:3168/api/withdrawals';
    const bad = ['0812345678', '091234567', '12345678', '+44912345678'];
    for (const account_number of bad) {
      const resp = await fetch(base, {
        method: 'POST',
        headers: playerHeaders(),
        body: JSON.stringify({ amount: 100, destination_type: 'telebirr', account_number, account_name: 'Abebe K' })
      });
      assert.equal(resp.status, 400, `${account_number} must be rejected`);
    }

    const good = await fetch(base, {
      method: 'POST',
      headers: playerHeaders(),
      body: JSON.stringify({ amount: 100, destination_type: 'telebirr', account_number: '+251912345678', account_name: 'Abebe K' })
    });
    assert.equal(good.status, 503, 'a valid number passes validation');
  });
});

test('bank withdrawals require a bank name and a plausible account number', async () => {
  await withServer(3169, async () => {
    const base = 'http://127.0.0.1:3169/api/withdrawals';

    const noBank = await fetch(base, {
      method: 'POST',
      headers: playerHeaders(),
      body: JSON.stringify({ amount: 100, destination_type: 'bank', account_number: '1000123456789', account_name: 'Abebe K' })
    });
    assert.equal(noBank.status, 400);

    const badAccount = await fetch(base, {
      method: 'POST',
      headers: playerHeaders(),
      body: JSON.stringify({ amount: 100, destination_type: 'bank', bank_name: 'Demo Bank', account_number: 'abc', account_name: 'Abebe K' })
    });
    assert.equal(badAccount.status, 400);

    const unknownDestination = await fetch(base, {
      method: 'POST',
      headers: playerHeaders(),
      body: JSON.stringify({
        amount: 100,
        destination_type: 'bank',
        destination_id: 'nope',
        account_number: '1000123456789',
        account_name: 'Abebe K'
      })
    });
    assert.equal(unknownDestination.status, 400);

    const good = await fetch(base, {
      method: 'POST',
      headers: playerHeaders(),
      body: JSON.stringify({ amount: 100, destination_type: 'bank', bank_name: 'Demo Bank', account_number: '1000123456789', account_name: 'Abebe K' })
    });
    assert.equal(good.status, 503, 'a valid bank payout passes validation');
  });
});

test('the automatic Chapa gateway is disabled unless explicitly enabled', async () => {
  await withServer(3170, async () => {
    const base = 'http://127.0.0.1:3170';
    const init = await fetch(base + '/api/deposits/initialize', {
      method: 'POST',
      headers: playerHeaders(),
      body: JSON.stringify({ amount: 100 })
    });
    assert.equal(init.status, 503);
    const data = await init.json();
    assert.match(data.error, /manual/i);

    // A callback can never credit anything while the gateway is off.
    const callback = await fetch(base + '/api/deposits/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_ref: 'LB-DEP-abc-1', status: 'success' })
    });
    assert.equal(callback.status, 503);
  }, { CHAPA_SECRET_KEY: 'CHASECK_TEST-placeholder' });
});
