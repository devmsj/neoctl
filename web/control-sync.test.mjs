import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { seal, open } from './control-protocol.mjs';
import { createControlSync, createLoginApplier, loginProfile, validateControlConfig, sessionStoreRoot } from './control-sync.mjs';

const device = { machineCode: 'a'.repeat(64), hostname: 'test-host', model: 'test-model', platform: 'win32' };
const profile = { provider: 'openai', values: { apiKey: 'secret-model-key', model: 'test-model' } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-control-sync-'));
  const sessionsRoot = path.join(directory, 'sessions');
  const key = randomBytes(32).toString('base64');
  let deviceId;
  const requests = [], enrollments = [], paths = [], wire = [], stored = new Map(), clients = [];
  let handler, enrollHandler;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      assert.equal(req.method, 'POST');
      if (!['/sync', '/enroll'].includes(req.url)) { res.writeHead(404).end(); return; }
      paths.push(req.url);
      wire.push(raw);
      const body = JSON.parse(raw);
      assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'envelope']);
      assert.match(body.deviceId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      deviceId ||= body.deviceId;
      assert.equal(body.deviceId, deviceId);
      const payload = await open(key, deviceId, 'up', body.envelope);
      assert.match(payload.requestId, /^[a-f0-9-]{36}$/);
      assert.ok(!requests.some((request) => request.requestId === payload.requestId));
      assert.deepEqual(payload.device, device);
      if (req.url === '/enroll') {
        assert.equal(payload.kind, 'enroll');
        assert.equal(typeof payload.sentAt, 'number');
        assert.deepEqual(Object.keys(payload).sort(), ['device', 'kind', 'requestId', 'sentAt']);
        enrollments.push(payload);
        if (enrollHandler) return await enrollHandler(payload, res);
        return await replyEnroll(res, payload);
      }
      assert.ok(enrollments.length > 0);
      requests.push(payload);
      if (handler) return await handler(payload, res);
      await reply(res, payload);
    } catch (error) { res.writeHead(500).end(); }
  });
  async function replyEnroll(res, payload, overrides = {}, direction = 'down') {
    res.end(JSON.stringify({ envelope: await seal(key, deviceId, direction, { requestId: payload.requestId, deviceId, kind: 'enrolled', ...overrides }) }));
  }
  async function reply(res, payload, overrides = {}) {
    const acks = payload.deltas.map((delta) => {
      assert.equal(delta.file, 'transcript.jsonl');
      const previous = stored.get(delta.sessionId) || Buffer.alloc(0);
      const incoming = Buffer.from(delta.data, 'base64');
      if (delta.offset <= previous.length) {
        const overlap = Math.min(incoming.length, previous.length - delta.offset);
        assert.ok(previous.subarray(delta.offset, delta.offset + overlap).equals(incoming.subarray(0, overlap)));
        if (delta.offset + incoming.length > previous.length) stored.set(delta.sessionId, Buffer.concat([previous, incoming.subarray(overlap)]));
      }
      return { sessionId: delta.sessionId, file: delta.file, offset: Math.min((stored.get(delta.sessionId) || previous).length, delta.offset + incoming.length) };
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ envelope: await seal(key, deviceId, 'down', { requestId: payload.requestId, acks, ...overrides }) }));
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = { enabled: true, url: `http://127.0.0.1:${server.address().port}`, key };
  const registryFile = path.join(directory, 'session-workspaces.json');
  await fs.writeFile(registryFile, '{}');
  function client(extra = {}) {
    const instance = createControlSync({ config, dataDir: directory, sessionsRoot, device, ...options, ...extra });
    clients.push(instance);
    return instance;
  }
  t.after(async () => {
    await Promise.all(clients.map((instance) => instance.stop()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory, sessionsRoot, config, requests, enrollments, paths, wire, stored, client, reply, replyEnroll,
    get deviceId() { return deviceId; },
    setEnrollHandler(value) { enrollHandler = value; },
    setHandler(value) { handler = value; },
    async transcript(id, data, append = false) {
      const filename = path.join(sessionsRoot, id, 'transcript.jsonl');
      const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
      registry[id] = { cwd: directory, materialized: true };
      await fs.writeFile(registryFile, JSON.stringify(registry));
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs[append ? 'appendFile' : 'writeFile'](filename, data);
      return filename;
    },
    async state() { return JSON.parse(await fs.readFile(path.join(directory, 'control-sync-state.json'), 'utf8')); },
  };
}

test('encrypted wire, byte deltas, incomplete UTF-8 tail and restart cursor recovery', async (t) => {
  const f = await fixture(t);
  const initial = '{"text":"初始记录"}\n';
  await f.transcript('session1', initial);
  const client = f.client();
  assert.equal(await client.tick(), true);
  assert.equal(f.requests[0].deltas[0].offset, 0);
  assert.equal(f.stored.get('session1').toString(), initial);
  assert.ok(!f.wire[0].includes('初始记录'));
  assert.ok(!f.wire[0].includes('test-host'));
  assert.ok(!f.wire[0].includes('requestId'));
  await f.transcript('session1', '{"text":"新增"}', true);
  await client.tick();
  assert.equal(f.requests[1].deltas[0].data, '');
  await f.transcript('session1', '\n', true);
  await client.tick();
  assert.equal(f.requests[2].deltas[0].offset, Buffer.byteLength(initial));
  assert.equal(Buffer.from(f.requests[2].deltas[0].data, 'base64').toString(), '{"text":"新增"}\n');
  await client.stop();
  const restarted = f.client();
  await restarted.tick();
  assert.equal(f.requests[3].deltas[0].data, '');
  assert.equal(f.requests[3].deltas[0].offset, f.stored.get('session1').length);
});

test('response requestId replay cannot advance cursor or apply command', async (t) => {
  let applications = 0;
  const f = await fixture(t, { applyProfile: async () => { applications++; } });
  await f.transcript('s1', 'private\n');
  f.setHandler((payload, res) => f.reply(res, payload, { requestId: 'wrong-id', command: { id: 'command1', profile } }));
  const client = f.client();
  assert.equal(await client.tick(), false);
  assert.equal(applications, 0);
  await assert.rejects(f.state(), { code: 'ENOENT' });
  f.setHandler(undefined);
  assert.equal(await client.tick(), true);
  assert.equal(f.requests[1].deltas[0].offset, 0);
  assert.equal((await f.state()).cursors.s1.offset, 8);
});

test('lost ack is idempotent and server-lost offsets rewind even on empty heartbeat probes', async (t) => {
  const f = await fixture(t);
  await f.transcript('s1', 'first\nsecond\n');
  const client = f.client();
  f.setHandler((payload, res) => f.reply(res, payload, { requestId: 'lost-ack' }));
  await client.tick();
  f.setHandler(undefined);
  await client.tick();
  assert.equal(f.stored.get('s1').toString(), 'first\nsecond\n');
  assert.equal(f.requests[1].deltas[0].offset, 0);
  f.stored.set('s1', Buffer.from('first\n'));
  await client.tick();
  assert.equal((await f.state()).cursors.s1.offset, 6);
  await client.tick();
  assert.equal(f.requests.at(-1).deltas[0].offset, 6);
  assert.equal(Buffer.from(f.requests.at(-1).deltas[0].data, 'base64').toString(), 'second\n');
  assert.equal(f.stored.get('s1').toString(), 'first\nsecond\n');
});

test('configuration failures never ack; successful command id persists and is not reapplied on restart', async (t) => {
  let fails = true, applications = 0;
  const f = await fixture(t, { applyProfile: async () => { applications++; if (fails) throw new Error('secret failure'); } });
  f.setHandler((payload, res) => f.reply(res, payload, { command: { id: 'command1', profile } }));
  const client = f.client();
  assert.equal(await client.tick(), false);
  assert.equal((await f.state()).ackCommandId, null);
  assert.equal(f.requests[0].ackCommandId, undefined);
  fails = false;
  assert.equal(await client.tick(), true);
  assert.equal(f.requests[1].ackCommandId, undefined);
  assert.equal((await f.state()).ackCommandId, 'command1');
  await client.stop();
  await f.client().tick();
  assert.equal(f.requests[2].ackCommandId, 'command1');
  assert.equal(applications, 2);
});

test('absent/disabled/invalid in-memory config sends nothing even with legacy files and environment opt-in', async (t) => {
  const f = await fixture(t);
  const pairingFile = path.join(f.directory, 'control-pairing.json');
  await fs.writeFile(pairingFile, JSON.stringify({ ...f.config, deviceId: 'old-device' }));
  t.mock.method(fs, 'readFile', new Proxy(fs.readFile, { apply(target, receiver, args) {
    assert.notEqual(path.resolve(args[0]), pairingFile, 'must never read legacy pairing file');
    return Reflect.apply(target, receiver, args);
  } }));
  for (const config of [undefined, null, {}, { ...f.config, enabled: false }, { ...f.config, key: 'invalid' }]) {
    const client = f.client({ config, pairingFile }).start();
    assert.equal(await client.tick(), false);
    await client.stop();
  }
  assert.equal(await f.client({ dataDir: undefined }).tick(), false);
  assert.equal(f.paths.length, 0);
  await assert.rejects(fs.stat(path.join(f.directory, 'control-device.json')), { code: 'ENOENT' });
  assert.equal(await f.client({ pairingFile }).tick(), true);
  assert.deepEqual(f.paths, ['/enroll', '/sync']);
});

test('stop during in-flight exchange prevents command and cursor acceptance', async (t) => {
  let applied = false;
  const f = await fixture(t, { applyProfile: async () => { applied = true; } });
  await f.transcript('s1', 'row\n');
  const client = f.client();
  f.setHandler(async (payload, res) => {
    void client.stop();
    await f.reply(res, payload, { command: { id: 'c1', profile } });
  });
  assert.equal(await client.tick(), false);
  assert.equal(applied, false);
  await assert.rejects(f.state(), { code: 'ENOENT' });
});

test('errors are silent, bounded diagnostics exclude sensitive details, polls never overlap', async (t) => {
  const f = await fixture(t, { timeoutMs: 100 });
  let logs = 0;
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, () => { logs++; });
  f.setHandler(async (_payload, res) => { await sleep(150); if (!res.destroyed) res.writeHead(503).end('sensitive upstream error'); });
  const client = f.client();
  const first = client.tick();
  assert.equal(client.tick(), first);
  assert.equal(await first, false);
  assert.equal(f.requests.length, 1);
  assert.equal(logs, 0);
  const diagnostic = JSON.parse(await fs.readFile(path.join(f.directory, 'control-sync-diagnostic.json'), 'utf8'));
  assert.deepEqual(Object.keys(diagnostic).sort(), ['at', 'code']);
  assert.equal(diagnostic.code, 'SYNC_RETRY');
});

test('truncation and acknowledged-tail replacement freeze only conflicting transcript across restart', async (t) => {
  const f = await fixture(t);
  await f.transcript('s1', 'original-long\n');
  await f.transcript('s2', 'unchanged\n');
  const client = f.client();
  await client.tick();
  await f.transcript('s1', 'short\n');
  await f.transcript('s2', 'next\n', true);
  await client.tick();
  assert.equal((await f.state()).cursors.s1.blocked, true);
  assert.ok(f.requests.at(-1).deltas.every((delta) => delta.sessionId !== 's1'));
  assert.equal(f.stored.get('s2').toString(), 'unchanged\nnext\n');
  await client.stop();
  await f.transcript('s1', 'long-enough-new-content\n');
  await f.client().tick();
  assert.ok(f.requests.at(-1).deltas.every((delta) => delta.sessionId !== 's1'));
});

test('large backlogs stay below 256KB on wire and rotate fairly among sessions', async (t) => {
  const f = await fixture(t);
  const large = `${'中'.repeat(60_000)}\n`;
  for (let index = 0; index < 9; index++) await f.transcript(`s${index}`, large);
  const client = f.client();
  for (let index = 0; index < 3; index++) assert.equal(await client.tick(), true);
  for (const raw of f.wire) assert.ok(Buffer.byteLength(raw) <= 256 * 1024);
  assert.equal(new Set(f.requests.flatMap((payload) => payload.deltas.map((delta) => delta.sessionId))).size, 9);
});

test('unregistered CLI history is never uploaded; missing registry fails closed', async (t) => {
  const f = await fixture(t);
  await f.transcript('desktop1', 'desktop\n');
  await fs.mkdir(path.join(f.sessionsRoot, 'cli-private'), { recursive: true });
  await fs.writeFile(path.join(f.sessionsRoot, 'cli-private', 'transcript.jsonl'), 'PRIVATE CLI\n');
  const client = f.client();
  assert.equal(await client.tick(), true);
  assert.deepEqual(f.requests[0].deltas.map(d => d.sessionId), ['desktop1']);
  assert.equal(f.stored.has('cli-private'), false);
  await fs.rm(path.join(f.directory, 'session-workspaces.json'));
  await client.tick();
  assert.deepEqual(f.requests.at(-1).deltas, []);
});

test('lost local state re-verifies large acknowledged history without duplicates', async (t) => {
  const f = await fixture(t);
  const text = '0123456789\n'.repeat(12000);
  await f.transcript('desktop1', text);
  const client = f.client();
  for (let i = 0; i < 6; i++) assert.equal(await client.tick(), true);
  assert.equal(f.stored.get('desktop1').toString(), text);
  await client.stop();
  await fs.rm(path.join(f.directory, 'control-sync-state.json'));
  const restarted = f.client();
  for (let i = 0; i < 6; i++) assert.equal(await restarted.tick(), true);
  assert.equal(f.stored.get('desktop1').toString(), text);
  assert.equal((await f.state()).cursors.desktop1.offset, Buffer.byteLength(text));
});

test('untrusted environment keys, unsafe URLs and invalid config keys rejected', () => {
  assert.throws(() => loginProfile({ provider: 'openai', values: { NODE_OPTIONS: '--import evil.mjs' } }));
  assert.throws(() => loginProfile({ provider: 'openai', values: { apiKey: 'value\nNODE_OPTIONS=evil' } }));
  assert.throws(() => loginProfile({ provider: 'other', values: {} }));
  const base = { enabled: true, key: randomBytes(32).toString('base64') };
  for (const url of ['http://example.com', 'file:///tmp/file', 'https://user:pass@example.com', 'http://127.0.0.1.evil.test', 'https://example.com/?token=secret']) assert.equal(validateControlConfig({ ...base, url }), null);
  for (const url of ['https://example.com/control', 'http://127.0.0.1:8080', 'http://[::1]:8080']) assert.ok(validateControlConfig({ ...base, url }));
  assert.ok(validateControlConfig({ ...base, url: 'http://117.89.250.136:8787', allowHttp: true }));
  assert.equal(validateControlConfig({ ...base, url: 'http://example.com', allowHttp: 'true' }), null);
  assert.equal(validateControlConfig({ ...base, url: 'file:///tmp/file', allowHttp: true }), null);
  assert.equal(validateControlConfig({ ...base, url: 'https://example.com', key: 'short' }), null);
  assert.equal(sessionStoreRoot({}), path.join(os.homedir(), '.neoctl', 'sessions'));
  assert.equal(sessionStoreRoot({ AGENT_SESSION_DIR: './custom-sessions' }), path.resolve('./custom-sessions'));
});

test('login adapter maps real Engine form, persists through HTTP login, updates all runtimes, and propagates failures', async (t) => {
  const requests = [];
  let failHttp = false, failRepl = false, getRequests = 0;
  const active = [{ async saveLogin(provider, values) { requests.push({ target: 'repl1', provider, values }); return { ok: !failRepl }; } }];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { getRequests++; return res.writeHead(405).end(); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ target: 'http', ...JSON.parse(Buffer.concat(chunks).toString()) });
    res.end(JSON.stringify({ ok: !failHttp }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const apply = createLoginApplier({ runtimeUrl: `http://127.0.0.1:${server.address().port}`, getActiveRepls: () => active });
  for (const values of [{ model: 'new-model' }, { apiKey: 'new-key' }, { apiKey: ' ', model: 'new-model' }, { apiKey: 'new-key', model: ' ' }]) {
    await assert.rejects(apply({ provider: 'openai', values }), /PROFILE_INVALID/);
  }
  assert.equal(requests.length, 0);
  await apply({ provider: 'openai', values: { apiKey: 'new-key', model: 'new-model' } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].values.model, 'new-model');
  assert.equal(getRequests, 0);
  assert.deepEqual(requests[0].values, { apiKey: 'new-key', model: 'new-model', baseUrl: '', endpoint: '', reasoningEffort: '', reasoningSummary: '', maxOutputTokens: '', timeoutMs: '', streamIdleTimeoutMs: '', maxRetries: '' });
  assert.equal(requests[0].values.unrelated, undefined);
  assert.deepEqual(requests[0].values, requests[1].values);
  failRepl = true;
  await assert.rejects(apply(profile), /LOGIN_FAILED/);
  failHttp = true;
  const before = requests.length;
  await assert.rejects(apply(profile), /LOGIN_FAILED/);
  assert.equal(requests.length, before + 1);
});

test('automatic enrollment persists only random UUID, reuses ID on restart and ignores config deviceId', async (t) => {
  const f = await fixture(t);
  await assert.rejects(fs.stat(path.join(f.directory, 'control-pairing.json')), { code: 'ENOENT' });
  const client = f.client({ config: { ...f.config, deviceId: 'externally-chosen' } });
  assert.equal(await client.tick(), true);
  const file = path.join(f.directory, 'control-device.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved, { deviceId: f.deviceId });
  assert.notEqual(saved.deviceId, 'externally-chosen');
  assert.equal(await client.tick(), true);
  assert.equal(f.enrollments.length, 1);
  await client.stop();
  assert.equal(await f.client().tick(), true);
  assert.equal(f.enrollments.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
  assert.deepEqual(f.paths, ['/enroll', '/sync', '/sync', '/enroll', '/sync']);
  for (const name of await fs.readdir(f.directory)) {
    if (name.endsWith('.json')) assert.ok(!(await fs.readFile(path.join(f.directory, name), 'utf8')).includes(f.config.key));
  }
  for (const raw of f.wire) {
    for (const secret of ['test-host', 'test-model', 'machineCode', f.config.key, 'requestId']) assert.ok(!raw.includes(secret));
  }
});

test('invalid enrollment acknowledgements, wrong AES direction and oversized responses cannot start sync', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  const badReplies = [
    (p, r) => f.replyEnroll(r, p, { requestId: 'replayed' }),
    (p, r) => f.replyEnroll(r, p, { deviceId: 'another-device' }),
    (p, r) => f.replyEnroll(r, p, { kind: 'sync' }),
    (p, r) => f.replyEnroll(r, p, {}, 'up'),
    (_p, r) => r.end(JSON.stringify({ kind: 'enrolled' })),
    (_p, r) => { r.write('x'.repeat(128 * 1024)); r.end('x'.repeat(129 * 1024)); },
    (_p, r) => r.writeHead(503).end('upstream failure'),
  ];
  for (const handler of badReplies) {
    f.setEnrollHandler(handler);
    assert.equal(await client.tick(), false);
    assert.equal(f.requests.length, 0);
    await assert.rejects(f.state(), { code: 'ENOENT' });
  }
  assert.equal(new Set(f.enrollments.map(p => p.requestId)).size, badReplies.length);
  f.setEnrollHandler(undefined);
  assert.equal(await client.tick(), true);
  assert.equal(f.requests.length, 1);
});

test('oversized encrypted requests never leave client; oversized sync reply cannot apply command', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.client({ device: { ...device, model: 'x'.repeat(256 * 1024) } }).tick(), false);
  assert.equal(f.paths.length, 0);
  f.setHandler((_p, r) => r.end('x'.repeat(256 * 1024 + 1)));
  assert.equal(await f.client().tick(), false);
  await assert.rejects(f.state(), { code: 'ENOENT' });
});

test('unknown device sync response causes re-enrollment with same persisted UUID', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  f.setHandler((_p, r) => r.writeHead(403).end());
  assert.equal(await client.tick(), false);
  f.setHandler(undefined);
  assert.equal(await client.tick(), true);
  assert.deepEqual(f.paths, ['/enroll', '/sync', '/enroll', '/sync']);
});

test('config snapshot cannot be retargeted by caller mutation', async (t) => {
  const f = await fixture(t);
  const config = { ...f.config };
  const client = f.client({ config });
  config.url = 'http://127.0.0.1:1';
  config.key = randomBytes(32).toString('base64');
  assert.equal(await client.tick(), true);
});

test('corrupt persisted UUID fails closed without creating a new remote device', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'control-device.json');
  await fs.writeFile(file, JSON.stringify({ deviceId: 'bad-id' }));
  assert.equal(await f.client().tick(), false);
  assert.equal(f.paths.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { deviceId: 'bad-id' });
});

test('background start returns immediately and retries are exponentially bounded with unreferenced timers', async (t) => {
  const f = await fixture(t);
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unreferenced: false, unref() { this.unreferenced = true; } };
    scheduled.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let calls = 0;
  const client = f.client({ pollMs: 1000, fetchImpl: async () => { calls++; throw new Error('private detail'); } });
  assert.equal(client.start(), client);
  assert.equal(calls, 0);
  for (let i = 0; i < 8; i++) await scheduled[i].callback();
  assert.deepEqual(scheduled.map(timer => timer.delay), [0, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  assert.ok(scheduled.every(timer => timer.unreferenced));
  assert.equal(calls, 8);
  assert.equal(f.requests.length, 0);
  await client.stop();
});

test('server consumes private config before core imports/children, defaults off and serves UI while enrollment hangs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-control-server-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const engine = path.join(directory, 'stub-engine');
  await fs.mkdir(path.join(engine, 'dist', 'web'), { recursive: true });
  await fs.mkdir(path.join(directory, 'dist'));
  await fs.writeFile(path.join(directory, 'dist', 'index.html'), 'UI_READY');
  await fs.writeFile(path.join(engine, 'package.json'), JSON.stringify({ type: 'module', version: 'test' }));
  await fs.writeFile(path.join(engine, 'dist', 'index.js'), `
    import { execFileSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { Server } from 'node:http';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      this.once('listening', () => writeFileSync(process.env.PROBE_FILE + '.port', String(this.address().port)));
      return listen.apply(this, args);
    };
    const inherited = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.NEO_DESKTOP_CONTROL_CONFIG))'], { encoding: 'utf8' });
    writeFileSync(process.env.PROBE_FILE, JSON.stringify({ own: process.env.NEO_DESKTOP_CONTROL_CONFIG ?? null, inherited }));
    export class QueryEngine {}
    export async function loadNeoPlugins() { return []; }
  `);
  await fs.writeFile(path.join(engine, 'dist', 'web', 'index.js'), `
    export class WebRepl {}
    export class WebRuntimeRouter {}
    export function createWebRuntime() {}
    export function runWebServer() {}
  `);
  const key = randomBytes(32).toString('base64');
  const requests = [];
  const control = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const payload = await open(key, body.deviceId, 'up', body.envelope);
    requests.push({ url: req.url, body, payload });
    // Deliberately never respond: must not delay UI readiness/requests.
  });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  t.after(async () => { control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); });
  const config = { enabled: true, url: `http://127.0.0.1:${control.address().port}`, key };
  const legacyFile = path.join(directory, 'external-pairing.json');
  await fs.writeFile(legacyFile, JSON.stringify({ ...config, deviceId: 'legacy' }));
  for (const [name, raw] of [['absent', undefined], ['malformed', '{bad JSON'], ['enabled', JSON.stringify(config)]]) {
    await t.test(name, async () => {
      const dataDir = path.join(directory, name);
      const probeFile = path.join(directory, `${name}-probe.json`);
      const env = { ...process.env, APP_HOST: '127.0.0.1', APP_PORT: '0', NEO_EMBED_RUNTIME: 'false',
        NEO_CORE_SOURCE: 'local', NEO_LOCAL_ENGINE_ROOT: engine, NEO_WEB_DATA_DIR: dataDir,
        DIST_DIR: path.join(directory, 'dist'), PROBE_FILE: probeFile, NEO_DESKTOP_CONTROL_FILE: legacyFile };
      delete env.NEO_DESKTOP_CONTROL_CONFIG;
      if (raw !== undefined) env.NEO_DESKTOP_CONTROL_CONFIG = raw;
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      // APP_PORT=0 log reflects requested port, so discover listener via an isolated
      // preload which reports the actual bound address without touching app behavior.
      try {
        const deadline = Date.now() + 10_000;
        while (!output.includes('neo web listening') && Date.now() < deadline && child.exitCode === null) await sleep(20);
        assert.ok(output.includes('neo web listening'), `${output}\n${error}`);
        assert.deepEqual(JSON.parse(await fs.readFile(probeFile, 'utf8')), { own: null, inherited: 'undefined' });
        if (name === 'enabled') {
          while (!requests.length && Date.now() < deadline) await sleep(20);
          assert.equal(requests.length, 1);
          assert.equal(requests[0].url, '/enroll');
          assert.equal(requests[0].payload.kind, 'enroll');
          const port = await fs.readFile(probeFile + '.port', 'utf8');
          const ui = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
          assert.equal(ui.status, 200);
          assert.equal(await ui.text(), 'UI_READY');
          const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'control-device.json'), 'utf8'));
          assert.deepEqual(saved, { deviceId: requests[0].body.deviceId });
          assert.ok(!output.includes(key) && !error.includes(key));
        } else {
          await sleep(100);
          assert.equal(requests.length, 0);
          await assert.rejects(fs.stat(path.join(dataDir, 'control-device.json')), { code: 'ENOENT' });
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        }
      }
    });
  }
});
