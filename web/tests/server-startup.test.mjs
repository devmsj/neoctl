import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const removedFiles = [
  'control-sync.mjs', 'control-protocol.mjs', 'control-transcript.mjs',
  'control-viewer.html', 'vite.control.config.js',
  'src/control-viewer.js', 'src/ControlSessionViewer.vue',
];

test('web entrypoint and package no longer load remote-control modules or ship its viewer', async () => {
  for (const file of removedFiles) {
    await assert.rejects(fs.access(path.join(webRoot, file)), { code: 'ENOENT' }, file);
  }
  const source = await fs.readFile(path.join(webRoot, 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /NEO_DESKTOP_CONTROL_CONFIG|createControlSync|createLoginApplier|control-sync|controlEnabled|controlRepls|WeakRef/);
  const pkg = JSON.parse(await fs.readFile(path.join(webRoot, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg.scripts, 'test:control'), false);
  for (const file of pkg.files) assert.ok(!removedFiles.includes(file), file);
  const entry = await fs.readFile(path.join(webRoot, 'src/main.js'), 'utf8');
  assert.doesNotMatch(entry, /ControlSessionViewer|control-viewer|control-transcript/);
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

// Both proxy-only and embedded runtime startup stay offline. Model/control URLs
// point to a loopback mock; HOME, sessions, env and web data are all temporary.
for (const embedded of [false, true]) {
  test(`obsolete launcher settings cannot enroll or sync; ${embedded ? 'embedded runtime settings persist' : 'local settings and chat proxy work'}`, { timeout: 20_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-web-startup-'));
    const requests = [];
    let child;
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, session: { sessionId: 'mock-local-session' } }));
    });
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    });
    const upstreamPort = await listen(upstream);
    const reservation = http.createServer();
    const port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const runtimeReservation = http.createServer();
    const runtimePort = embedded ? await listen(runtimeReservation) : upstreamPort;
    if (embedded) await new Promise(resolve => runtimeReservation.close(resolve));
    const plugins = path.join(root, 'plugins');
    const dist = path.join(root, 'dist');
    await fs.mkdir(plugins);
    await fs.mkdir(dist);
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Local web fixture</title>');
    const oldState = path.join(root, 'control-sync-state.json');
    await fs.writeFile(oldState, 'user data must remain untouched');
    const isolationConfig = path.join(root, 'isolation.json');
    await fs.writeFile(isolationConfig, '{"enabled":false}');
    const envFile = path.join(root, '.env.neo');
    await fs.writeFile(envFile, `MODEL_PROVIDER=openai\nOPENAI_API_KEY=offline-initial-key\nOPENAI_MODEL=offline-initial-model\nOPENAI_BASE_URL=http://127.0.0.1:${upstreamPort}\n`);
    child = spawn(process.execPath, ['server.mjs', '--core', 'local'], {
      cwd: webRoot,
      env: {
        ...process.env,
        APP_HOST: '127.0.0.1', APP_PORT: String(port), DIST_DIR: dist,
        NEO_EXECUTION_BACKEND: 'local', NEO_CORE_SOURCE: 'local', NEO_EMBED_RUNTIME: String(embedded),
        NEO_RUNTIME_TARGET: `http://127.0.0.1:${runtimePort}`,
        NEO_WEB_DATA_DIR: root, NEO_WORKSPACE_ROOT: path.join(root, 'workspaces'),
        NEO_WEB_PLUGIN_DIR: plugins, NEO_WEB_PLUGIN_DATA_DIR: root, NEO_WEB_PLUGINS: 'none',
        NEO_WEB_PLUGIN_SETTINGS_FILE: path.join(root, 'plugins.json'),
        NEO_WEB_TOOL_SETTINGS_FILE: path.join(root, 'tools.json'),
        NEO_CPA_CONFIG_FILE: path.join(root, 'cpa-config.json'),
        NEO_MEMORY_MONITOR_FILE: path.join(root, 'memory-monitor.json'),
        NEO_PROMPT_LIBRARY_FILE: path.join(root, 'prompt-library.json'),
        NEO_UPLOADS_DIR: path.join(root, 'uploads'), NEO_ISOLATION_CONFIG: isolationConfig,
        NEO_ENV_FILE: envFile, HOME: root, USERPROFILE: root,
        AGENT_SESSION_DIR: path.join(root, 'sessions'), AGENT_SESSION_RESUME: '0',
        AGENT_SESSION_ID: 'offline-startup-session',
        // Only regression-test input, never a production compatibility path.
        NEO_DESKTOP_CONTROL_CONFIG: JSON.stringify({ enabled: true, url: `http://127.0.0.1:${upstreamPort}`, key: Buffer.alloc(32, 1).toString('base64') }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    // Core logs the same prefix first; wait for the public app's own port.
    const readyLine = `neo web listening on http://127.0.0.1:${port}, dist=`;
    for (let attempt = 0; attempt < 100 && !log.includes(readyLine); attempt++) {
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(log.includes(readyLine), log);
    const base = `http://127.0.0.1:${port}`;
    const request = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) });
    assert.match(await (await request('/')).text(), /Local web fixture/);
    const memory = await (await request('/api/memory')).json();
    assert.ok(memory.current.rss > 0);
    assert.deepEqual(await (await request('/api/prompt-library')).json(), { items: [] });
    const state = await request('/api/state?tabId=startup');
    assert.equal(state.status, 200);
    assert.ok((await state.json()).session.sessionId);
    const settings = { provider: 'openai', values: { apiKey: 'offline-test-key', model: 'offline-model', baseUrl: `http://127.0.0.1:${upstreamPort}` } };
    const initial = await request('/api/login?tabId=startup');
    assert.equal(initial.status, 200);
    if (embedded) {
      const form = await initial.json();
      assert.equal(form.envPath, envFile);
      assert.equal(form.values.model, 'offline-initial-model');
    }
    const saved = await request('/api/login?tabId=startup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).ok, true);
    if (embedded) {
      const updated = await (await request('/api/login?tabId=startup')).json();
      assert.equal(updated.values.model, 'offline-model');
      assert.equal(updated.values.apiKey, 'offline-test-key');
      const persisted = await fs.readFile(envFile, 'utf8');
      assert.match(persisted, /OPENAI_MODEL=offline-model/);
      assert.match(persisted, /OPENAI_API_KEY=offline-test-key/);
      // Never submit to a real model; the proxy-only branch below mocks chat.
    } else {
      const chat = { text: 'mocked local chat only' };
      const response = await request('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chat) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    await delay(1200);
    assert.deepEqual(requests, embedded ? [] : [
      { method: 'GET', url: '/api/state?tabId=startup', body: '' },
      { method: 'GET', url: '/api/login?tabId=startup', body: '' },
      { method: 'POST', url: '/api/login?tabId=startup', body: JSON.stringify(settings) },
      { method: 'POST', url: '/api/submit', body: JSON.stringify({ text: 'mocked local chat only' }) },
    ]);
    assert.equal(await fs.readFile(oldState, 'utf8'), 'user data must remain untouched');
    for (const file of ['control-device.json', 'control-sync-diagnostic.json']) {
      await assert.rejects(fs.access(path.join(root, file)), { code: 'ENOENT' });
    }
  });
}
