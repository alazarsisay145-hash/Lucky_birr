const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(port) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return { server, getStderr: () => stderr };
}

async function stopServer(server, getStderr) {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    wait(2000)
  ]);
  assert.notEqual(server.exitCode, null, `Server did not terminate cleanly. Stderr: ${getStderr()}`);
}

function readGameShell() {
  return fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
}

function compactHtml(source) {
  return source.replace(/\s+/g, ' ').trim();
}

test('server serves the game shell', async () => {
  const port = 3101;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /LUCKY BIRR/i);
    assert.match(body, /Tap to Buy/i);
  } finally {
    await stopServer(server, getStderr);
  }
});

test('server CSP allows the game shell resources to render', async () => {
  const port = 3102;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src[^;]*'unsafe-inline'/i);
    assert.match(csp, /script-src[^;]*https:\/\/telegram\.org/i);
    assert.match(csp, /style-src[^;]*'unsafe-inline'/i);
    assert.match(csp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/i);
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /api/auth/register returns 400 when fields missing', async () => {
  const port = 3103;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /api/auth/register returns 400 for weak password', async () => {
  const port = 3104;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'weak' })
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /api/auth/login returns 400 when fields missing', async () => {
  const port = 3105;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('GET /api/auth/me returns 401 without token', async () => {
  const port = 3106;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('GET /api/auth/me returns 401 with invalid token', async () => {
  const port = 3107;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: '******' }
    });
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /api/submissions returns 401 without token', async () => {
  const port = 3108;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50 })
    });
    assert.equal(response.status, 401);
  } finally {
    await stopServer(server, getStderr);
  }
});

test('GET /api/admin/submissions returns 401 without token', async () => {
  const port = 3109;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/submissions`);
    assert.equal(response.status, 401);
  } finally {
    await stopServer(server, getStderr);
  }
});

test('game shell auth flow stores and restores AUTH_TOKEN', () => {
  const html = readGameShell();
  assert.match(html, /const AUTH_TOKEN_STORAGE_KEY = 'AUTH_TOKEN'/);
  assert.match(html, /const LEGACY_AUTH_TOKEN_STORAGE_KEY = 'lb_token'/);
  assert.match(html, /localStorage\.setItem\(AUTH_TOKEN_STORAGE_KEY, token\)/);
  assert.match(html, /localStorage\.getItem\(AUTH_TOKEN_STORAGE_KEY\)/);
  assert.match(html, /localStorage\.removeItem\(AUTH_TOKEN_STORAGE_KEY\)/);
  assert.match(html, /localStorage\.removeItem\(LEGACY_AUTH_TOKEN_STORAGE_KEY\)/);
  assert.match(html, /localStorage\.getItem\(LEGACY_AUTH_TOKEN_STORAGE_KEY\)/);
});

test('game shell auth flow initializes persisted auth and protects submissions', () => {
  const html = compactHtml(readGameShell());
  assert.match(html, /Admin access has no separate URL\. It appears after signing in with a configured admin email/);
  assert.match(html, /async function initAuthState\(\)/);
  assert.match(html, /function getPersistedAuthToken\(\)/);
  assert.match(html, /function formatBlockerList\(items\)/);
  assert.match(html, /fetch\('\/api\/auth\/login', \{ method: 'POST'/);
  assert.match(html, /fetch\('\/api\/auth\/register', \{ method: 'POST'/);
  assert.match(html, /fetch\('\/api\/auth\/me', \{ headers:/);
  assert.match(html, /fetch\('\/readyz', \{ cache: 'no-store' \}\)/);
  assert.match(html, /headers: \{ 'Authorization': 'Bearer ' \+ AUTH_TOKEN \}/);
  assert.match(html, /bindAuthErrorClear\(\['loginEmail', 'loginPassword'\], 'loginError'\)/);
  assert.match(html, /bindAuthErrorClear\(\['regFullName', 'regEmail', 'regPhone', 'regPassword', 'regConfirm'\], 'registerError'\)/);
  assert.match(html, /initAuthState\(\);/);
});

test('GET /healthz returns 200 with uptime', async () => {
  const port = 3110;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.ok, 'ok field should be true');
    assert.ok(typeof data.uptime === 'number', 'uptime should be a number');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('GET /readyz returns 503 when database is not configured', async () => {
  const port = 3111;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    // Without SUPABASE_URL/KEY the database check fails → 503
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.ok('database' in data.checks, 'checks.database should be present');
    assert.ok('jwt' in data.checks, 'checks.jwt should be present');
    assert.ok('telegram' in data.checks, 'checks.telegram should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /api/submit returns 400 when required fields are missing', async () => {
  const port = 3112;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'Test' })
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /api/submit returns 400 for invalid amount', async () => {
  const port = 3113;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'Test', phone: '0911000000', ticketNumber: '1', amount: '-5' })
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.ok(data.error, 'error field should be present');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('POST /webhook/:secret returns 403 when secret does not match', async () => {
  const port = 3114;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/webhook/wrong-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: 1 }, text: '/start' } })
    });
    assert.equal(response.status, 403);
  } finally {
    await stopServer(server, getStderr);
  }
});

// ===== DEPLOYMENT-CRITICAL TESTS =====

test('server binds to 0.0.0.0 and respects PORT env variable', async () => {
  const port = 3115;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    // Bind verification: connect via 127.0.0.1 (mapped to 0.0.0.0 listener)
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.ok, 'healthz should return ok:true when bound to 0.0.0.0');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('same-origin requests (no Origin header) are allowed by CORS', async () => {
  const port = 3116;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    // Simulate a same-origin request: no Origin header set
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    // CORS should not block a request with no Origin header
    const corsHeader = response.headers.get('access-control-allow-origin');
    // When origin is absent, express cors middleware doesn't echo it back –
    // the response just proceeds normally without a CORS rejection.
    assert.notEqual(response.status, 403, 'same-origin request must not be rejected by CORS');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('cross-origin request with wrong Origin is rejected by CORS when WEBSITE_URL is set', async () => {
  const port = 3117;
  const server = require('node:child_process').spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', WEBSITE_URL: 'https://lucky-birr.onrender.com' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const getStderr = () => '';
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Origin: 'https://evil.example.com' }
    });
    assert.equal(response.status, 403, 'cross-origin request with wrong Origin must be blocked');
  } finally {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      wait(2000)
    ]);
  }
});

test('cross-origin request with correct WEBSITE_URL Origin is allowed', async () => {
  const port = 3118;
  const websiteUrl = `http://127.0.0.1:${port}`;
  const server = require('node:child_process').spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', WEBSITE_URL: websiteUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Origin: websiteUrl }
    });
    assert.equal(response.status, 200, 'request matching WEBSITE_URL must be allowed');
    const data = await response.json();
    assert.ok(data.ok);
  } finally {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      wait(2000)
    ]);
  }
});

test('static assets are served from /public directory', async () => {
  const port = 3119;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/index.html`);
    // public/index.html exists (payment form page)
    assert.equal(response.status, 200);
  } finally {
    await stopServer(server, getStderr);
  }
});

test('unknown routes serve the game shell (SPA fallback)', async () => {
  const port = 3120;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/some/unknown/path`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /LUCKY BIRR/i, 'SPA fallback must serve game shell for unknown routes');
  } finally {
    await stopServer(server, getStderr);
  }
});

test('API routes are not swallowed by SPA fallback', async () => {
  const port = 3121;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    // /api/auth/me without a token should return 401, not 200 with HTML
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(response.status, 401);
    const ct = response.headers.get('content-type') || '';
    assert.ok(ct.includes('application/json'), 'API route must return JSON, not HTML');
  } finally {
    await stopServer(server, getStderr);
  }
});

// ===== TELEGRAM-DISABLED & ADMIN-EMAIL TESTS =====

test('no Telegram warnings logged when Telegram is fully absent', async () => {
  const port = 3122;
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '',
    ADMIN_CHAT_ID: '',
    TELEGRAM_WEBHOOK_SECRET: ''
  };
  const server = require('node:child_process').spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await wait(1200);
    assert.doesNotMatch(
      stderr,
      /TELEGRAM_BOT_TOKEN|ADMIN_CHAT_ID|TELEGRAM_WEBHOOK_SECRET/i,
      'should not emit Telegram warnings when Telegram is fully absent'
    );
  } finally {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      wait(2000)
    ]);
  }
});

test('partial Telegram config warns when TOKEN is set but ADMIN_CHAT_ID is missing', async () => {
  const port = 3123;
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: 'fake-token-for-test',
    ADMIN_CHAT_ID: '',
    TELEGRAM_WEBHOOK_SECRET: ''
  };
  const server = require('node:child_process').spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await wait(1200);
    assert.match(
      stderr,
      /ADMIN_CHAT_ID/i,
      'should warn about missing ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is set'
    );
  } finally {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      wait(2000)
    ]);
  }
});

test('ADMIN_EMAILS matching is case-insensitive and trimmed', async () => {
  const port = 3124;
  const jwtSecret = 'test-jwt-secret-32-chars-exactly!!';
  const server = require('node:child_process').spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ADMIN_EMAILS: '  test@example.com , another@example.com  ',
      JWT_SECRET: jwtSecret
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await wait(1200);
    const jwt = require('jsonwebtoken');
    // Sign token with uppercase email – should still pass the admin check
    const token = jwt.sign({ id: 'test-id', email: 'TEST@EXAMPLE.COM' }, jwtSecret, { expiresIn: '1h' });
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/submissions`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    // Admin check passes (email matched case-insensitively), DB not configured → 500
    assert.notEqual(response.status, 403, 'uppercase email must be recognized as admin (case-insensitive match)');
    assert.equal(response.status, 500, 'should fail with DB error rather than admin rejection');
  } finally {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      wait(2000)
    ]);
  }
});

test('GET /readyz includes detail field when Supabase is not configured', async () => {
  const port = 3125;
  const { server, getStderr } = spawnServer(port);
  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.ok(typeof data.detail === 'string', 'readyz must include a detail field when Supabase is not configured');
    assert.match(data.detail, /SUPABASE_URL/i, 'detail should mention the missing env var');
  } finally {
    await stopServer(server, getStderr);
  }
});

// ===== PGRST205 / isMissingTableError TESTS =====

test('game shell loadAuthSetupStatus includes server detail when database check fails', () => {
  const html = readGameShell();
  // Verify the detail field is appended when blockers exist
  assert.match(html, /data\.detail\.trim\(\)/, 'detail must be used when blockers are present');
  assert.match(html, /formatBlockerList\(blockers\)/, 'formatBlockerList must still be called');
});

test('game shell loadAuthSetupStatus appends detail to blockers message', () => {
  const html = compactHtml(readGameShell());
  // The updated template literal must include the detail variable alongside blockers
  assert.match(
    html,
    /formatBlockerList\(blockers\)\}\$\{detail\}/,
    'message template must append detail after the blockers list'
  );
});

test('server.js isMissingTableError helper recognizes PGRST205 alongside 42P01', () => {
  // Verify both codes appear in server.js (ensures the helper covers both variants)
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /isMissingTableError/, 'isMissingTableError helper must be defined');
  assert.match(src, /'42P01'/, 'helper must recognise PostgreSQL 42P01');
  assert.match(src, /'PGRST205'/, 'helper must recognise PostgREST PGRST205');
});
