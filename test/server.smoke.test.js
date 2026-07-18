const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('server serves the game shell', async () => {
  const port = 3101;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await wait(1200);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /LUCKY BIRR/i);
    assert.match(body, /Tap to Buy/i);
  } finally {
    server.kill('SIGTERM');
    await wait(300);
    assert.equal(server.killed, true, `Server did not terminate cleanly. Stderr: ${stderr}`);
  }
});
