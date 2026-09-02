const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const INDEX_PATH = path.join(__dirname, '..', 'Index.html');

function readGameShell() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
}

function extractInlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function invalidJsonResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }
  };
}

// Boots Index.html in a DOM so click/submit handlers execute exactly like a browser.
function bootShell({ fetchImpl, storedToken } = {}) {
  const calls = [];
  const consoleErrors = [];
  const dom = new JSDOM(readGameShell(), {
    runScripts: 'dangerously',
    url: 'https://lucky-birr.onrender.com/',
    pretendToBeVisual: true,
    beforeParse(window) {
      if (storedToken) {
        window.localStorage.setItem('AUTH_TOKEN', storedToken);
      } else {
        window.localStorage.clear();
      }
      window.AudioContext = function AudioContextStub() {};
      window.fetch = (url, options = {}) => {
        calls.push({ url, options });
        if (url === '/readyz') return Promise.resolve(jsonResponse({ ok: true, checks: { database: true, jwt: true } }));
        if (typeof fetchImpl === 'function') return fetchImpl(url, options);
        return Promise.resolve(jsonResponse({ ok: true }));
      };
      window.console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
      window.console.warn = () => {};
    }
  });

  const { window } = dom;
  return {
    window,
    document: window.document,
    calls,
    consoleErrors,
    authCalls: (endpoint) => calls.filter((c) => c.url === endpoint),
    close: () => window.close()
  };
}

function flush(times = 8) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

function fillLogin(doc, email = 'player@example.com', password = 'Password1') {
  doc.getElementById('loginEmail').value = email;
  doc.getElementById('loginPassword').value = password;
}

function fillRegister(doc) {
  doc.getElementById('regFullName').value = 'Abebe Kebede';
  doc.getElementById('regEmail').value = 'player@example.com';
  doc.getElementById('regPhone').value = '0911234567';
  doc.getElementById('regPassword').value = 'Password1';
  doc.getElementById('regConfirm').value = 'Password1';
}

function tap(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
}

test('inline Index.html JavaScript parses without syntax errors', () => {
  const scripts = extractInlineScripts(readGameShell());
  assert.ok(scripts.length > 0, 'Index.html must contain at least one inline script');
  for (const source of scripts) {
    assert.doesNotThrow(() => new vm.Script(source), 'inline Index.html script must parse');
  }
});

test('auth markup uses semantic forms with submit buttons', () => {
  const html = readGameShell();
  assert.match(html, /<form class="auth-form" id="loginForm"/);
  assert.match(html, /<form class="auth-form" id="registerForm"/);
  assert.match(html, /id="loginBtn" type="submit"/);
  assert.match(html, /id="registerBtn" type="submit"/);
});

test('shell boots without runtime errors and exposes enabled auth controls', async () => {
  const app = bootShell();
  try {
    await flush();
    assert.equal(typeof app.window.doLogin, 'function');
    assert.equal(typeof app.window.doRegister, 'function');
    assert.equal(app.document.getElementById('loginBtn').disabled, false);
    assert.equal(app.document.getElementById('authFatalStatus').classList.contains('show'), false);
  } finally {
    app.close();
  }
});

test('tapping Sign In sends exactly one POST to /api/auth/login and closes the overlay', async () => {
  const app = bootShell({
    fetchImpl: () => Promise.resolve(jsonResponse({
      ok: true,
      token: 'jwt-token',
      user: { email: 'player@example.com', fullName: 'Abebe Kebede', balance: 100, isAdmin: false }
    }))
  });
  try {
    fillLogin(app.document);
    tap(app.document.getElementById('loginBtn'));
    await flush();

    const loginCalls = app.authCalls('/api/auth/login');
    assert.equal(loginCalls.length, 1, 'exactly one login request must be sent');
    assert.equal(loginCalls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(loginCalls[0].options.body), {
      email: 'player@example.com',
      password: 'Password1'
    });
    assert.ok(app.document.getElementById('authOverlay').classList.contains('hidden'));
    assert.equal(app.window.localStorage.getItem('AUTH_TOKEN'), 'jwt-token');
  } finally {
    app.close();
  }
});

test('pressing Enter in the login form submits exactly one login request', async () => {
  const app = bootShell({
    fetchImpl: () => Promise.resolve(jsonResponse({ ok: false, error: 'Invalid email or password' }, 401))
  });
  try {
    fillLogin(app.document);
    app.document.getElementById('loginForm').dispatchEvent(
      new app.window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flush();
    assert.equal(app.authCalls('/api/auth/login').length, 1);
  } finally {
    app.close();
  }
});

test('invalid credentials show a visible error and restore the button', async () => {
  const app = bootShell({
    fetchImpl: () => Promise.resolve(jsonResponse({ ok: false, error: 'Invalid email or password' }, 401))
  });
  try {
    fillLogin(app.document);
    tap(app.document.getElementById('loginBtn'));
    await flush();

    const error = app.document.getElementById('loginError');
    assert.equal(error.textContent, 'Invalid email or password');
    assert.ok(error.classList.contains('show'));
    const btn = app.document.getElementById('loginBtn');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Sign In');
    assert.equal(btn.hasAttribute('aria-busy'), false);
  } finally {
    app.close();
  }
});

test('non-JSON login response shows a safe error and restores the button', async () => {
  const app = bootShell({ fetchImpl: () => Promise.resolve(invalidJsonResponse(500)) });
  try {
    fillLogin(app.document);
    tap(app.document.getElementById('loginBtn'));
    await flush();

    const error = app.document.getElementById('loginError');
    assert.ok(error.textContent.length > 0, 'a visible message must be shown');
    assert.ok(error.classList.contains('show'));
    assert.equal(app.document.getElementById('loginBtn').disabled, false);
  } finally {
    app.close();
  }
});

test('network failure shows a visible error and restores the button', async () => {
  const app = bootShell({ fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
  try {
    fillLogin(app.document);
    tap(app.document.getElementById('loginBtn'));
    await flush();

    assert.match(app.document.getElementById('loginError').textContent, /Network error/);
    assert.equal(app.document.getElementById('loginBtn').disabled, false);
    assert.equal(app.document.getElementById('loginBtn').textContent, 'Sign In');
  } finally {
    app.close();
  }
});

test('aborted (timed out) login shows a timeout message and restores the button', async () => {
  const app = bootShell({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      if (options.signal) {
        options.signal.addEventListener('abort', () => reject(abortError));
      }
      // Simulate the browser aborting immediately.
      setImmediate(() => reject(abortError));
    })
  });
  try {
    fillLogin(app.document);
    tap(app.document.getElementById('loginBtn'));
    await flush();

    assert.match(app.document.getElementById('loginError').textContent, /took too long/);
    assert.equal(app.document.getElementById('loginBtn').disabled, false);
    assert.equal(app.document.getElementById('loginBtn').textContent, 'Sign In');
  } finally {
    app.close();
  }
});

test('repeated taps while a login is in flight send only one request', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const app = bootShell({ fetchImpl: () => pending });
  try {
    fillLogin(app.document);
    const btn = app.document.getElementById('loginBtn');
    tap(btn);
    tap(btn);
    tap(btn);
    await flush(2);
    assert.equal(app.authCalls('/api/auth/login').length, 1, 'duplicate taps must not duplicate requests');

    release(jsonResponse({ ok: false, error: 'Invalid email or password' }, 401));
    await flush();
    assert.equal(btn.disabled, false);
  } finally {
    app.close();
  }
});

test('missing credentials never fire a request and surface a message', async () => {
  const app = bootShell();
  try {
    tap(app.document.getElementById('loginBtn'));
    await flush(2);
    assert.equal(app.authCalls('/api/auth/login').length, 0);
    assert.match(app.document.getElementById('loginError').textContent, /required/i);
  } finally {
    app.close();
  }
});

test('Register link switches screens and Create Account sends one register request', async () => {
  const app = bootShell({
    fetchImpl: () => Promise.resolve(jsonResponse({
      ok: true,
      token: 'jwt-token',
      user: { email: 'player@example.com', fullName: 'Abebe Kebede', balance: 0, isAdmin: false }
    }))
  });
  try {
    tap(app.document.getElementById('goToRegister'));
    assert.ok(app.document.getElementById('screenRegisterAuth').classList.contains('active'));
    assert.equal(app.document.getElementById('screenLoginAuth').classList.contains('active'), false);

    fillRegister(app.document);
    tap(app.document.getElementById('registerBtn'));
    await flush();

    const registerCalls = app.authCalls('/api/auth/register');
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(registerCalls[0].options.body), {
      email: 'player@example.com',
      phone: '0911234567',
      password: 'Password1',
      fullName: 'Abebe Kebede'
    });
    assert.ok(app.document.getElementById('authOverlay').classList.contains('hidden'));

    tap(app.document.getElementById('goToLogin'));
    assert.ok(app.document.getElementById('screenLoginAuth').classList.contains('active'));
  } finally {
    app.close();
  }
});

test('failed registration restores the Create Account button', async () => {
  const app = bootShell({
    fetchImpl: () => Promise.resolve(jsonResponse({ ok: false, error: 'Email already registered' }, 400))
  });
  try {
    tap(app.document.getElementById('goToRegister'));
    fillRegister(app.document);
    tap(app.document.getElementById('registerBtn'));
    await flush();

    assert.equal(app.document.getElementById('registerError').textContent, 'Email already registered');
    const btn = app.document.getElementById('registerBtn');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Create Account');
  } finally {
    app.close();
  }
});

test('a rejected stored session falls back to the auth overlay', async () => {
  const app = bootShell({
    storedToken: 'stale-token',
    fetchImpl: (url) => {
      if (url === '/api/auth/me') return Promise.resolve(jsonResponse({ ok: false, error: 'Invalid token' }, 401));
      return Promise.resolve(jsonResponse({ ok: true }));
    }
  });
  try {
    await flush();
    assert.equal(app.authCalls('/api/auth/me').length, 1);
    assert.equal(app.window.localStorage.getItem('AUTH_TOKEN'), null);
    assert.equal(app.document.getElementById('authOverlay').classList.contains('hidden'), false);
    assert.equal(app.document.getElementById('loginBtn').disabled, false);
  } finally {
    app.close();
  }
});

test('passwords are never written to the console', async () => {
  const app = bootShell({
    fetchImpl: () => Promise.resolve(jsonResponse({ ok: false, error: 'Invalid email or password' }, 401))
  });
  try {
    fillLogin(app.document, 'player@example.com', 'SuperSecret1');
    tap(app.document.getElementById('loginBtn'));
    await flush();
    assert.ok(app.consoleErrors.length > 0, 'a diagnostic should still be logged');
    for (const line of app.consoleErrors) {
      assert.ok(!line.includes('SuperSecret1'), `console output leaked a password: ${line}`);
    }
  } finally {
    app.close();
  }
});
