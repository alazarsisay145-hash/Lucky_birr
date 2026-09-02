const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'Index.html');

function readShell() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
}

function extractInlineScripts(html) {
  const scripts = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match) {
    scripts.push(match[1]);
    match = pattern.exec(html);
  }
  return scripts;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function invalidJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    }
  };
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Boots Index.html inside jsdom with a recording fetch stub.
 * `routes` maps a URL to a handler receiving (init) and returning a response
 * (or throwing to simulate a network failure).
 */
function bootShell({ routes = {}, mutateHtml } = {}) {
  let html = readShell();
  if (mutateHtml) html = mutateHtml(html);

  const calls = [];
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.join(' ')));

  const defaultRoutes = {
    '/readyz': () => jsonResponse(200, { ok: true, checks: { database: true, jwt: true } }),
    '/api/auth/me': () => jsonResponse(401, { error: 'Unauthorized' })
  };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://lucky-birr.onrender.com/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (url, init = {}) => {
        calls.push({ url, init });
        const handler = routes[url] || defaultRoutes[url];
        if (!handler) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return Promise.resolve()
          .then(() => handler(init));
      };
      window.AudioContext = function AudioContextStub() {
        throw new Error('audio unavailable');
      };
    }
  });

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    calls,
    consoleErrors,
    jsdomErrors,
    authCalls: () => calls.filter((call) => String(call.url).startsWith('/api/auth/')),
    close: () => dom.window.close()
  };
}

function flush(times = 6) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

function fillLogin(document, email = 'player@example.com', password = 'Secret123') {
  document.getElementById('loginEmail').value = email;
  document.getElementById('loginPassword').value = password;
}

function fillRegister(document) {
  document.getElementById('regFullName').value = 'Abebe Kebede';
  document.getElementById('regEmail').value = 'new@example.com';
  document.getElementById('regPhone').value = '0911234567';
  document.getElementById('regPassword').value = 'Secret123';
  document.getElementById('regConfirm').value = 'Secret123';
}

test('inline Index.html scripts are syntactically valid JavaScript', () => {
  const scripts = extractInlineScripts(readShell());
  assert.ok(scripts.length > 0, 'expected at least one inline script in Index.html');
  scripts.forEach((source, index) => {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: `Index.html#inline-${index}` }),
      `inline script #${index} in Index.html failed to parse`
    );
  });
});

test('auth markup uses semantic forms with submit buttons', () => {
  const html = readShell();
  assert.match(html, /<form class="auth-form" id="loginForm"/);
  assert.match(html, /<form class="auth-form" id="registerForm"/);
  assert.match(html, /id="loginBtn" type="submit"/);
  assert.match(html, /id="registerBtn" type="submit"/);
  assert.doesNotMatch(html, /onclick="doLogin\(\)"/);
  assert.doesNotMatch(html, /onclick="doRegister\(\)"/);
});

test('clicking Sign In issues exactly one POST /api/auth/login and opens the app', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => jsonResponse(200, {
        ok: true,
        token: 'jwt-token',
        user: { id: '1', email: 'player@example.com', fullName: 'Player One', balance: 500, isAdmin: false }
      })
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    ctx.document.getElementById('loginBtn').click();
    await flush();

    const loginCalls = ctx.calls.filter((call) => call.url === '/api/auth/login');
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(loginCalls[0].init.body), {
      email: 'player@example.com',
      password: 'Secret123'
    });
    assert.ok(loginCalls[0].init.signal, 'expected an AbortController signal for the timeout');

    assert.ok(ctx.document.getElementById('authOverlay').classList.contains('hidden'));
    const btn = ctx.document.getElementById('loginBtn');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Sign In');
  } finally {
    ctx.close();
  }
});

test('submitting the login form (Enter key equivalent) does not reload the page', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => jsonResponse(401, { error: 'Invalid credentials' })
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    const submitEvent = new ctx.window.Event('submit', { bubbles: true, cancelable: true });
    ctx.document.getElementById('loginForm').dispatchEvent(submitEvent);
    await flush();

    assert.equal(submitEvent.defaultPrevented, true);
    assert.equal(ctx.calls.filter((call) => call.url === '/api/auth/login').length, 1);
  } finally {
    ctx.close();
  }
});

test('invalid credentials show a visible error and restore the button', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => jsonResponse(401, { error: 'Invalid credentials' })
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    ctx.document.getElementById('loginBtn').click();
    await flush();

    const error = ctx.document.getElementById('loginError');
    assert.ok(error.classList.contains('show'));
    assert.equal(error.textContent, 'Invalid credentials');
    const btn = ctx.document.getElementById('loginBtn');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Sign In');
    assert.equal(btn.getAttribute('aria-busy'), null);
  } finally {
    ctx.close();
  }
});

test('a non-JSON response still shows a visible error and restores the button', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => invalidJsonResponse(502)
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    ctx.document.getElementById('loginBtn').click();
    await flush();

    const error = ctx.document.getElementById('loginError');
    assert.ok(error.classList.contains('show'));
    assert.ok(error.textContent.length > 0);
    assert.equal(ctx.document.getElementById('loginBtn').disabled, false);
  } finally {
    ctx.close();
  }
});

test('a timed out request reports a timeout message and restores the button', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => { throw abortError(); }
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    ctx.document.getElementById('loginBtn').click();
    await flush();

    const error = ctx.document.getElementById('loginError');
    assert.ok(error.classList.contains('show'));
    assert.match(error.textContent, /timed out/i);
    const btn = ctx.document.getElementById('loginBtn');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Sign In');
  } finally {
    ctx.close();
  }
});

test('a network failure reports an error and restores the button', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => { throw new TypeError('Failed to fetch'); }
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    ctx.document.getElementById('loginBtn').click();
    await flush();

    const error = ctx.document.getElementById('loginError');
    assert.ok(error.classList.contains('show'));
    assert.match(error.textContent, /Network error/i);
    assert.equal(ctx.document.getElementById('loginBtn').disabled, false);
  } finally {
    ctx.close();
  }
});

test('repeated taps while a request is in flight send only one request', async () => {
  let resolveLogin;
  const pending = new Promise((resolve) => { resolveLogin = resolve; });
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => pending
    }
  });
  try {
    await flush();
    fillLogin(ctx.document);
    const btn = ctx.document.getElementById('loginBtn');
    btn.click();
    await flush(2);
    btn.disabled = false; // simulate an assistive/mobile tap that ignores disabled state
    btn.click();
    btn.click();
    await flush(2);

    assert.equal(ctx.calls.filter((call) => call.url === '/api/auth/login').length, 1);

    resolveLogin(jsonResponse(401, { error: 'Invalid credentials' }));
    await flush();
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Sign In');
  } finally {
    ctx.close();
  }
});

test('empty credentials do not issue a request but show an error', async () => {
  const ctx = bootShell();
  try {
    await flush();
    ctx.document.getElementById('loginBtn').click();
    await flush();

    assert.equal(ctx.calls.filter((call) => call.url === '/api/auth/login').length, 0);
    assert.equal(ctx.document.getElementById('loginError').textContent, 'Email and password are required');
    assert.equal(ctx.document.getElementById('loginBtn').disabled, false);
  } finally {
    ctx.close();
  }
});

test('clicking Create Account issues exactly one POST /api/auth/register', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/register': () => jsonResponse(201, {
        ok: true,
        token: 'jwt-token',
        user: { id: '2', email: 'new@example.com', fullName: 'Abebe Kebede', balance: 0, isAdmin: false }
      })
    }
  });
  try {
    await flush();
    ctx.document.getElementById('goRegisterLink').click();
    assert.ok(ctx.document.getElementById('screenRegisterAuth').classList.contains('active'));
    assert.equal(ctx.document.getElementById('screenLoginAuth').classList.contains('active'), false);

    fillRegister(ctx.document);
    ctx.document.getElementById('registerBtn').click();
    await flush();

    const registerCalls = ctx.calls.filter((call) => call.url === '/api/auth/register');
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(registerCalls[0].init.body), {
      email: 'new@example.com',
      phone: '0911234567',
      password: 'Secret123',
      fullName: 'Abebe Kebede'
    });
    assert.ok(ctx.document.getElementById('authOverlay').classList.contains('hidden'));
  } finally {
    ctx.close();
  }
});

test('register and sign-in screens can be switched back and forth', async () => {
  const ctx = bootShell();
  try {
    await flush();
    ctx.document.getElementById('goRegisterLink').click();
    assert.ok(ctx.document.getElementById('screenRegisterAuth').classList.contains('active'));
    ctx.document.getElementById('goLoginLink').click();
    assert.ok(ctx.document.getElementById('screenLoginAuth').classList.contains('active'));
    assert.equal(ctx.document.getElementById('screenRegisterAuth').classList.contains('active'), false);
  } finally {
    ctx.close();
  }
});

test('an unrelated missing element cannot disable authentication', async () => {
  const ctx = bootShell({
    routes: {
      '/api/auth/login': () => jsonResponse(200, {
        ok: true,
        token: 'jwt-token',
        user: { id: '1', email: 'player@example.com', fullName: 'Player One', balance: 10, isAdmin: false }
      })
    },
    mutateHtml: (html) => html
      .replace('id="depositModal"', 'id="depositModalRenamed"')
      .replace('id="paymentAmount"', 'id="paymentAmountRenamed"')
  });
  try {
    await flush();
    fillLogin(ctx.document);
    ctx.document.getElementById('loginBtn').click();
    await flush();

    assert.equal(ctx.calls.filter((call) => call.url === '/api/auth/login').length, 1);
    assert.ok(ctx.document.getElementById('authOverlay').classList.contains('hidden'));
  } finally {
    ctx.close();
  }
});

test('missing auth forms surface a visible fatal startup message', async () => {
  const ctx = bootShell({
    mutateHtml: (html) => html.replace('id="loginForm"', 'id="loginFormRenamed"')
  });
  try {
    await flush();
    const fatal = ctx.document.getElementById('authFatalError');
    assert.ok(fatal.classList.contains('show'));
    assert.match(fatal.textContent, /reload the page/i);
  } finally {
    ctx.close();
  }
});
