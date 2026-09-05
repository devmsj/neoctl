import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createControlServer } from '../server.mjs';

test('management HTML references shipped assets and every JS element id exists', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const match of script.matchAll(/(?:getElementById|\$)\(['"]([A-Za-z][A-Za-z0-9_-]*)['"]\)/g)) {
    assert.equal(ids.has(match[1]), true, `missing UI element: ${match[1]}`);
  }
  assert.match(script, /neo-control-token/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(html, /app\.js/);
  assert.match(html, /style\.css/);
  assert.ok((await fs.stat(new URL('../public/style.css', import.meta.url))).size > 0);
});

test('static assets are served with restrictive CSP; administrator API requires authentication', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-control-ui-'));
  const server = await createControlServer({ dataDir, adminToken: 'ui-smoke-token' });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/app.js', '/style.css']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self'/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    await response.text();
  }
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer ui-smoke-token' } })).status, 200);
});
