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
  assert.match(html, /async function initAuthState\(\)/);
  assert.match(html, /function getPersistedAuthToken\(\)/);
  assert.match(html, /fetch\('\/api\/auth\/login', \{ method: 'POST'/);
  assert.match(html, /fetch\('\/api\/auth\/register', \{ method: 'POST'/);
  assert.match(html, /fetch\('\/api\/auth\/me', \{ headers:/);
  assert.match(html, /headers: \{ 'Authorization': 'Bearer ' \+ AUTH_TOKEN \}/);
  assert.match(html, /bindAuthErrorClear\(\['loginEmail', 'loginPassword'\], 'loginError'\)/);
  assert.match(html, /bindAuthErrorClear\(\['regFullName', 'regEmail', 'regPhone', 'regPassword', 'regConfirm'\], 'registerError'\)/);
  assert.match(html, /initAuthState\(\);/);
});
