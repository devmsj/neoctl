import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from './isolation-auth.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('production startup embeds protected runtime without opening an unguarded core port', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-isolation-startup-'));
  const port = await freePort(), upstream = await freePort();
  const configFile = path.join(root, 'isolation.json');
  await fs.writeFile(configFile, JSON.stringify({ enabled: true, users: [{ username: 'Tester', passwordHash: await hashPassword('StartupTestOnly') }] }));
  const child = spawn(process.execPath, ['server.mjs', '--core', 'local'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, NEO_EXECUTION_BACKEND: 'local', NEO_CORE_SOURCE: 'local', APP_HOST: '127.0.0.1', APP_PORT: String(port), NEO_RUNTIME_TARGET: `http://127.0.0.1:${upstream}`, NEO_WEB_DATA_DIR: root, NEO_WORKSPACE_ROOT: path.join(root, 'work'), NEO_ISOLATION_CONFIG: configFile, NEO_WEB_PLUGINS: 'none' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (await listening(port)) { ready = true; break; }
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, log);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal(await listening(upstream), false);
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Tester', password: 'StartupTestOnly' }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const memory = await (await fetch(base + '/api/memory', { headers: { cookie } })).json();
  assert.ok(memory.current.rss > 0);
  assert.ok(memory.history.length > 0);
  const state = await fetch(base + '/api/state?tabId=startup', { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.ok((await state.json()).session.sessionId);
  assert.equal(await listening(upstream), false);
});
