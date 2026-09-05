import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { createControlServer } from '../server.mjs';
import { seal, open } from '../protocol.mjs';

const deviceInfo = { machineCode: 'integration-machine', hostname: '测试-host', model: 'test-model', platform: 'win32' };

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

async function fixture(t, limits = {}, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-control-server-test-'));
  const adminToken = randomBytes(32).toString('hex');
  let server;
  let base;
  t.after(async () => {
    try { await close(server); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  async function start() {
    server = await createControlServer({ adminToken, dataDir, limits, ...options });
    assert.ok(server instanceof Server, 'factory must return a native http.Server');
    assert.equal(server.listening, false, 'caller owns listen()');
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => { server.off('error', onError); resolve(); });
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${adminToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
    return { status: response.status, headers: response.headers, json, text };
  }
  async function admin(path, options = {}) {
    const result = await request(path, options);
    assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status} ${result.text}`);
    return result.json;
  }
  async function addDevice(name = 'integration device') {
    const device = await admin('/api/devices', { method: 'POST', body: { name } });
    assert.equal(typeof device.deviceId, 'string');
    assert.ok(device.deviceId);
    assert.equal(Buffer.from(device.key, 'base64').length, 32);
    return device;
  }
  async function sync(device, deltas = [], extra = {}) {
    const payload = { requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas, ...extra };
    const envelope = await seal(device.key, device.deviceId, 'up', payload);
    const response = await request('/sync', { method: 'POST', auth: false, body: { deviceId: device.deviceId, envelope } });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(Object.keys(response.json), ['envelope']);
    const decrypted = await open(device.key, device.deviceId, 'down', response.json.envelope);
    assert.equal(decrypted.requestId, payload.requestId);
    assert.ok(Array.isArray(decrypted.acks));
    return decrypted;
  }
  await start();
  return { request, admin, addDevice, sync, dataDir, get base() { return base; }, async restart() { await close(server); await start(); } };
}

function delta(sessionId, file, offset, text) {
  return { sessionId, file, offset, data: Buffer.from(text).toString('base64') };
}
function ack(response, sessionId, file, offset) {
  assert.deepEqual(response.acks, [{ sessionId, file, offset }]);
}

test('createControlServer rejects absent or empty adminToken', { timeout: 15000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-control-no-token-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const adminToken of [undefined, '']) {
    await assert.rejects(async () => {
      const server = await createControlServer({ dataDir, ...(adminToken === undefined ? {} : { adminToken }) });
      await close(server);
    }, 'an admin token is mandatory');
  }
});

test('admin authentication protects reads and mutations; hostile origins are rejected', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const device = await f.addDevice();
  const endpoints = [
    ['/api/state', 'GET'],
    ['/api/devices', 'POST', { name: 'unauthorized' }],
    [`/api/devices/${device.deviceId}`, 'PATCH', { name: 'unauthorized' }],
    [`/api/devices/${device.deviceId}`, 'DELETE'],
    ['/api/profiles', 'POST', { name: 'unauthorized', profile: {} }],
    ['/api/profiles/nonexistent', 'DELETE'],
    ['/api/broadcast', 'POST', { profileId: null }],
    ['/api/dispatch', 'POST', { profileId: 'nonexistent', deviceIds: [device.deviceId] }],
    [`/api/sessions/${device.deviceId}/test-session`, 'GET'],
  ];
  for (const [path, method, body] of endpoints) {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
      const result = await f.request(path, { method, body, auth: false, headers });
      assert.ok([401, 403].includes(result.status), `${method} ${path} must authenticate before accessing data; got ${result.status}`);
    }
  }
  for (const origin of ['https://attacker.example', 'null']) {
    for (const [path, method, body] of [['/api/state', 'GET'], ['/api/devices', 'POST', { name: 'cross-origin' }]]) {
      const result = await f.request(path, { method, body, headers: { origin } });
      assert.ok(result.status >= 400 && result.status < 500, `hostile Origin ${origin} must be rejected, got ${result.status}`);
      assert.notEqual(result.headers.get('access-control-allow-origin'), '*');
      assert.notEqual(result.headers.get('access-control-allow-origin'), origin);
    }
  }
  await f.admin('/api/state', { headers: { origin: f.base } });
  const state = await f.admin('/api/state');
  assert.equal(state.devices.length, 1, 'rejected requests must not create/delete devices');
});

test('device/profile CRUD and selected broadcast state survive restart', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const initial = await f.admin('/api/state');
  assert.deepEqual(initial.devices, []);
  assert.deepEqual(initial.profiles, []);
  assert.deepEqual(initial.sessions, []);
  assert.equal(initial.broadcastProfileId, null);
  const device = await f.addDevice('original');
  await f.admin(`/api/devices/${device.deviceId}`, { method: 'PATCH', body: { name: '重命名' } });
  const profile = { provider: 'openai', values: { apiKey: 'integration-test-key', model: 'integration-model', baseUrl: 'https://example.invalid/v1', endpoint: 'responses' } };
  const record = await f.admin('/api/profiles', { method: 'POST', body: { id: 'integration-profile', name: '测试配置', profile } });
  assert.equal(record.id, 'integration-profile');
  assert.equal(record.name, '测试配置');
  assert.deepEqual(record.profile, profile);
  const generated = await f.admin('/api/profiles', { method: 'POST', body: { name: 'generated id', profile } });
  assert.equal(typeof generated.id, 'string');
  assert.ok(generated.id);
  assert.notEqual(generated.id, record.id);
  await f.admin('/api/broadcast', { method: 'POST', body: { profileId: record.id } });
  await f.restart();
  const state = await f.admin('/api/state');
  assert.ok(state.devices.some(item => (item.deviceId ?? item.id) === device.deviceId && item.name === '重命名'));
  assert.ok(state.profiles.some(item => item.id === record.id && item.name === record.name));
  assert.equal(state.broadcastProfileId, record.id);
  await f.admin('/api/broadcast', { method: 'POST', body: { profileId: null } });
  await f.admin(`/api/profiles/${record.id}`, { method: 'DELETE' });
  await f.admin(`/api/profiles/${generated.id}`, { method: 'DELETE' });
  await f.admin(`/api/devices/${device.deviceId}`, { method: 'DELETE' });
  await f.restart();
  const empty = await f.admin('/api/state');
  assert.deepEqual(empty.devices, []);
  assert.deepEqual(empty.profiles, []);
  assert.equal(empty.broadcastProfileId, null);
});

test('delta byte offsets, retries, gaps, restart, and exact UTF-8 session reads', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const device = await f.addDevice();
  const sessionId = 'session-utf8';
  const file = 'transcript.jsonl';
  const first = '{"text":"你好 🌍"}\n';
  const second = '{"text":"second"}\n';
  const firstBytes = Buffer.byteLength(first);
  ack(await f.sync(device, [delta(sessionId, file, 0, first)]), sessionId, file, firstBytes);
  ack(await f.sync(device, [delta(sessionId, file, 0, first)]), sessionId, file, firstBytes);
  ack(await f.sync(device, [delta(sessionId, file, firstBytes + 20, 'gap')]), sessionId, file, firstBytes);
  assert.deepEqual((await f.sync(device, [delta(sessionId, file, 1, 'different overlapping bytes')])).acks, [{sessionId, file, offset: 1, conflict: true}]);
  const meta = '{"title":"会话",';
  ack(await f.sync(device, [delta(sessionId, 'meta.json', 0, meta)]), sessionId, 'meta.json', Buffer.byteLength(meta));
  let session = await f.admin(`/api/sessions/${device.deviceId}/${sessionId}`);
  assert.equal(session.meta, null, 'incomplete JSON metadata is null');
  assert.equal(session.transcript, first);
  const tail = '"count":2}';
  const combined = await f.sync(device, [delta(sessionId, file, firstBytes, second), delta(sessionId, 'meta.json', Buffer.byteLength(meta), tail)]);
  assert.equal(combined.acks.length, 2);
  assert.ok(combined.acks.some(item => item.sessionId === sessionId && item.file === file && item.offset === Buffer.byteLength(first + second)));
  assert.ok(combined.acks.some(item => item.sessionId === sessionId && item.file === 'meta.json' && item.offset === Buffer.byteLength(meta + tail)));
  await f.restart();
  ack(await f.sync(device, [delta(sessionId, file, 0, first)]), sessionId, file, firstBytes);
  const third = '{"text":"after restart"}\n';
  ack(await f.sync(device, [delta(sessionId, file, Buffer.byteLength(first + second), third)]), sessionId, file, Buffer.byteLength(first + second + third));
  session = await f.admin(`/api/sessions/${device.deviceId}/${sessionId}`);
  assert.deepEqual(session.meta, { title: '会话', count: 2 });
  assert.equal(session.transcript, first + second + third, 'retries and wrong offsets never overwrite or duplicate bytes');
});

test('identical request replay is rejected and device session storage is isolated', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const a = await f.addDevice('A');
  const b = await f.addDevice('B');
  const sessionId = 'same-session';
  const textA = '{"owner":"A"}\n';
  const textB = '{"owner":"B"}\n';
  const payload = { requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas: [delta(sessionId, 'transcript.jsonl', 0, textA)] };
  const envelope = await seal(a.key, a.deviceId, 'up', payload);
  for (let retry = 0; retry < 2; retry++) {
    const response = await f.request('/sync', { method: 'POST', auth: false, body: { deviceId: a.deviceId, envelope } });
    assert.equal(response.status, retry === 0 ? 200 : 409, response.text);
    const result = await open(a.key, a.deviceId, 'down', response.json.envelope);
    assert.equal(result.requestId, payload.requestId);
    if (retry === 0) ack(result, sessionId, 'transcript.jsonl', Buffer.byteLength(textA));
    else assert.equal(result.error, 'Replay rejected');
  }
  await f.sync(b, [delta(sessionId, 'transcript.jsonl', 0, textB)]);
  for (const [device, text] of [[a, textA], [b, textB]]) {
    const session = await f.admin(`/api/sessions/${device.deviceId}/${sessionId}`);
    assert.equal(session.transcript, text);
    assert.equal(session.meta, null, 'missing metadata is null');
  }
});

test('authenticated validation failures remain encrypted, including traversal paths', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const device = await f.addDevice();
  const badDeltas = [
    delta('session-safe', 'secret.txt', 0, 'forbidden'),
    delta('session-safe', '../meta.json', 0, '{}'),
    delta('session-safe', '..\\meta.json', 0, '{}'),
    delta('session-safe', '/meta.json', 0, '{}'),
    delta('session-safe', 'C:\\meta.json', 0, '{}'),
    delta('session-safe', 'transcript.jsonl:stream', 0, '{}'),
    delta('../escaped', 'meta.json', 0, '{}'),
    delta('..\\escaped', 'meta.json', 0, '{}'),
    delta('/escaped', 'meta.json', 0, '{}'),
    delta('C:\\escaped', 'meta.json', 0, '{}'),
  ];
  const payloads = badDeltas.map(item => ({ requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas: [item] }));
  payloads.push({ requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas: 'not-an-array' });
  for (const payload of payloads) {
    const envelope = await seal(device.key, device.deviceId, 'up', payload);
    const response = await f.request('/sync', { method: 'POST', auth: false, body: { deviceId: device.deviceId, envelope } });
    assert.equal(response.status, 400, `bad payload ${JSON.stringify(payload)}: ${response.text}`);
    assert.deepEqual(Object.keys(response.json), ['envelope']);
    assert.ok(response.json.envelope);
    assert.equal(Object.hasOwn(response.json, 'error'), false, 'error details must not be plaintext');
    const error = await open(device.key, device.deviceId, 'down', response.json.envelope);
    assert.ok(error && Object.hasOwn(error, 'error'), 'decrypted response identifies validation error');
  }
  const good = await f.sync(device, [delta('session-safe', 'transcript.jsonl', 0, 'safe\n')]);
  ack(good, 'session-safe', 'transcript.jsonl', 5);
  const session = await f.admin(`/api/sessions/${device.deviceId}/session-safe`);
  assert.equal(session.transcript, 'safe\n');
  assert.equal(session.meta, null, 'rejected traversal cannot populate the valid metadata file');
});

async function rejectedSync(f, device, deltas, status) {
  const payload = { requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas };
  const envelope = await seal(device.key, device.deviceId, 'up', payload);
  const response = await f.request('/sync', { method: 'POST', auth: false, body: { deviceId: device.deviceId, envelope } });
  assert.equal(response.status, status, response.text);
  assert.deepEqual(Object.keys(response.json), ['envelope']);
  assert.equal(Object.hasOwn(response.json, 'error'), false);
  const error = await open(device.key, device.deviceId, 'down', response.json.envelope);
  assert.equal(error.requestId, payload.requestId);
  assert.ok(error.error);
  assert.deepEqual(error.acks, []);
}

test('small request and device quotas reject excess without mutating state', { timeout: 15000 }, async t => {
  const f = await fixture(t, { requestBytes: 1024, devices: 1 });
  const device = await f.addDevice();
  const excess = await f.request('/api/devices', { method: 'POST', body: { name: 'excess' } });
  assert.equal(excess.status, 413);
  const oversized = await f.request('/api/devices', { method: 'POST', body: { name: 'x'.repeat(2048) } });
  assert.equal(oversized.status, 413);
  const syncOversized = await f.request('/sync', { method: 'POST', auth: false, body: { deviceId: device.deviceId, envelope: 'x'.repeat(2048) } });
  assert.equal(syncOversized.status, 413);
  assert.deepEqual(syncOversized.json, { error: 'request rejected' });
  await f.restart();
  assert.equal((await f.admin('/api/state')).devices.length, 1);
  assert.deepEqual((await f.sync(device)).acks, []);
});

test('small delta byte/count quotas reject before appending and allow boundary writes', { timeout: 15000 }, async t => {
  const f = await fixture(t, { deltaBytes: 4, deltas: 1 });
  const device = await f.addDevice();
  await rejectedSync(f, device, [delta('quota-session', 'transcript.jsonl', 0, '12345')], 413);
  await rejectedSync(f, device, [delta('quota-session', 'transcript.jsonl', 0, 'ab'), delta('quota-session', 'transcript.jsonl', 2, 'cd')], 400);
  ack(await f.sync(device, [delta('quota-session', 'transcript.jsonl', 0, '1234')]), 'quota-session', 'transcript.jsonl', 4);
  assert.equal((await f.admin(`/api/sessions/${device.deviceId}/quota-session`)).transcript, '1234');
});

for (const quota of ['diskBytes', 'fileBytes', 'sessionsPerDevice']) {
  test(`small ${quota} quota refuses excess and survives restart`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { [quota]: quota === 'sessionsPerDevice' ? 1 : 4 });
    const device = await f.addDevice();
    await f.sync(device, [delta('quota-session', 'transcript.jsonl', 0, '1234')]);
    const bad = quota === 'sessionsPerDevice'
      ? delta('other-session', 'transcript.jsonl', 0, 'x')
      : quota === 'diskBytes'
        ? delta('quota-session', 'meta.json', 0, '{}')
        : delta('quota-session', 'transcript.jsonl', 4, 'x');
    assert.deepEqual((await f.sync(device, [bad])).acks, [{ sessionId: bad.sessionId, file: bad.file, offset: bad.offset, error: 'QUOTA_EXCEEDED', retryable: false }]);
    await f.restart();
    assert.deepEqual((await f.sync(device, [bad])).acks, [{ sessionId: bad.sessionId, file: bad.file, offset: bad.offset, error: 'QUOTA_EXCEEDED', retryable: false }]);
    ack(await f.sync(device, [delta('quota-session', 'transcript.jsonl', 0, '1234')]), 'quota-session', 'transcript.jsonl', 4);
    const saved = await f.admin(`/api/sessions/${device.deviceId}/quota-session`);
    assert.equal(saved.transcript, '1234');
    assert.equal(saved.meta, null);
    assert.equal((await f.admin('/api/state')).sessions.length, 1);
  });
}

test('undecryptable sync requests return only the generic plaintext 400 error', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const device = await f.addDevice();
  const payload = { requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas: [] };
  const good = await seal(device.key, device.deviceId, 'up', payload);
  const corrupt = structuredClone(good);
  const bytes = Buffer.from(corrupt.ciphertext, 'base64');
  bytes[0] ^= 1;
  corrupt.ciphertext = bytes.toString('base64');
  const bodies = [
    { deviceId: device.deviceId, envelope: corrupt },
    { deviceId: device.deviceId, envelope: await seal(randomBytes(32).toString('base64'), device.deviceId, 'up', payload) },
    { deviceId: device.deviceId, envelope: await seal(device.key, device.deviceId, 'down', payload) },
    { deviceId: 'unknown-device', envelope: good },
    { deviceId: device.deviceId, envelope: {} },
  ];
  for (const body of bodies) {
    const response = await f.request('/sync', { method: 'POST', auth: false, body });
    assert.equal(response.status, 400, response.text);
    assert.deepEqual(response.json, { error: 'request rejected' });
  }
  const valid = await f.sync(device);
  assert.deepEqual(valid.acks, [], 'bad requests must not poison later valid sync');
});

test('sentAt window and durable request deduplication do not refresh heartbeat', async t => {
  const f = await fixture(t);
  const d = await f.addDevice();
  const payload = { requestId: randomUUID(), sentAt: Date.now(), device: deviceInfo, deltas: [] };
  async function send(value) {
    const envelope = await seal(d.key, d.deviceId, 'up', value);
    const res = await f.request('/sync', { method: 'POST', auth: false, body: { deviceId: d.deviceId, envelope } });
    const reply = await open(d.key, d.deviceId, 'down', res.json.envelope);
    return { ...res, reply };
  }
  assert.equal((await send(payload)).status, 200);
  const seen = (await f.admin('/api/state')).devices[0].lastSeen;
  assert.equal((await send(payload)).status, 409);
  await f.restart();
  assert.equal((await send(payload)).status, 409);
  for (const sentAt of [undefined, Date.now() - 121000, Date.now() + 121000]) {
    assert.equal((await send({ ...payload, requestId: randomUUID(), sentAt })).status, 400);
  }
  const state = await f.admin('/api/state');
  assert.equal(state.devices[0].lastSeen, seen);
  assert.equal(Object.hasOwn(state.devices[0], 'key'), false);
  assert.equal(Object.hasOwn(state.devices[0], 'recentRequests'), false);
});

test('sync rate limiting is encrypted and bounded per device', async t => {
  const f = await fixture(t, { syncPerMinute: 1 });
  const d = await f.addDevice();
  await f.sync(d);
  await rejectedSync(f, d, [], 429);
});

test('HTTPS public origin is explicit, forwarding headers never grant origin trust', async t => {
  const f = await fixture(t, {}, { publicOrigin: 'https://control.example' });
  assert.equal((await f.request('/api/devices', { method: 'POST', body: {}, headers: { origin: 'https://control.example' } })).status, 201);
  assert.equal((await f.request('/api/state', { headers: { origin: f.base } })).status, 200);
  assert.equal((await f.request('/api/state', { headers: { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } })).status, 403);
  await assert.rejects(createControlServer({ adminToken: 'test', publicOrigin: 'https://control.example/path' }));
});

test('profile accepts only openai camelCase model fields and requires apiKey/model', async t => {
  const f = await fixture(t);
  const valid = { provider: 'openai', values: { apiKey: 'test-key', model: 'test-model', baseUrl: 'https://api.example/v1', endpoint: 'responses', reasoningEffort: 'medium', reasoningSummary: 'auto', maxOutputTokens: '2048', timeoutMs: '10000', streamIdleTimeoutMs: '1000', maxRetries: '2' } };
  assert.equal((await f.request('/api/profiles', { method: 'POST', body: { name: 'valid', profile: valid } })).status, 201);
  for (const profile of [
    {}, { ...valid, provider: 'other' }, { ...valid, unexpected: true },
    { ...valid, values: { model: 'test' } }, { ...valid, values: { apiKey: 'test' } },
    { ...valid, values: { ...valid.values, OPENAI_API_KEY: 'test' } },
    { ...valid, values: { ...valid.values, AGENT_SESSION_DIR: '/tmp' } },
    { ...valid, values: { ...valid.values, baseUrl: 'file:///tmp' } },
    { ...valid, values: { ...valid.values, timeoutMs: {} } },
  ]) assert.equal((await f.request('/api/profiles', { method: 'POST', body: { name: 'bad', profile } })).status, 400);
});

test('overlap confirms only compared bytes; probes rewind; conflicts never advance', async t => {
  const f = await fixture(t);
  const d = await f.addDevice();
  const sessionId = 'confirmed', file = 'transcript.jsonl';
  ack(await f.sync(d, [delta(sessionId, file, 0, 'abcdefgh')]), sessionId, file, 8);
  ack(await f.sync(d, [delta(sessionId, file, 0, 'abc')]), sessionId, file, 3);
  ack(await f.sync(d, [delta(sessionId, file, 0, '')]), sessionId, file, 0);
  ack(await f.sync(d, [delta(sessionId, file, 20, '')]), sessionId, file, 8);
  ack(await f.sync(d, [delta(sessionId, file, 6, 'ghij')]), sessionId, file, 8);
  ack(await f.sync(d, [delta(sessionId, file, 8, 'ij')]), sessionId, file, 10);
  assert.deepEqual((await f.sync(d, [delta(sessionId, file, 2, 'BAD')])).acks, [{ sessionId, file, offset: 2, conflict: true }]);
  assert.equal((await f.admin(`/api/sessions/${d.deviceId}/${sessionId}`)).transcript, 'abcdefghij');
  ack(await f.sync(d, [delta('missing', file, 200, '')]), 'missing', file, 0);
});

test('viewer static assets are public with restrictive CSP but content APIs remain authenticated', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'control-viewer-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Viewer</title>');
  await writeFile(join(dir, 'assets', 'viewer-123.js'), 'export const viewer = true;');
  const f = await fixture(t, {}, { viewerDir: dir });
  for (const route of ['/viewer/', '/viewer', '/viewer/assets/viewer-123.js']) {
    const res = await f.request(route, { auth: false });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /img-src 'self' data:/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await f.request('/viewer/assets/state.json', { auth: false })).status, 404);
  assert.equal((await f.request('/api/sessions/device/session', { auth: false })).status, 401);
});

test('default HTTP body ceiling is 256 KiB including envelope encoding', async t => {
  const f = await fixture(t);
  const d = await f.addDevice();
  const res = await f.request('/sync', { method: 'POST', auth: false, body: { deviceId: d.deviceId, envelope: 'x'.repeat(256 * 1024) } });
  assert.equal(res.status, 413);
  assert.deepEqual(res.json, { error: 'request rejected' });
});


test('broadcast status tracks durable current revisions, overrides and lifecycle', async t => {
  const f = await fixture(t);
  const post = (url, body) => f.admin(url, { method: 'POST', body });
  const status = async () => (await f.admin('/api/state')).broadcastStatus;
  const profile = { id: 'tracked', name: 'Tracked', profile: { provider: 'openai', values: { apiKey: 'secret-profile-key', model: 'gpt-test' } } };
  assert.equal(await status(), null);
  const a = await f.addDevice('A'), b = await f.addDevice('B');
  await post('/api/profiles', profile);
  await post('/api/broadcast', { profileId: profile.id });
  let first = await status();
  assert.deepEqual(first.counts, { total: 2, pending: 2, succeeded: 0, superseded: 0 });
  assert.deepEqual(Object.keys(first).sort(), ['clients', 'counts', 'createdAt', 'id', 'profileId']);
  assert.deepEqual(Object.keys(first.clients[0]).sort(), ['acknowledgedAt', 'deviceId', 'name', 'online', 'status']);
  assert.ok(!JSON.stringify(first).includes(a.key));
  assert.ok(!JSON.stringify(first).includes('secret-profile-key'));
  const old = (await f.sync(a)).command.id;
  assert.equal((await status()).counts.succeeded, 0, 'delivery alone is not success');
  await f.sync(a, [], { ackCommandId: old });
  first = await status();
  assert.equal(first.counts.succeeded, 1);
  assert.equal(typeof first.clients.find(c => c.deviceId === a.deviceId).acknowledgedAt, 'number');
  await f.restart();
  assert.deepEqual(await status(), first);
  await post('/api/broadcast', { profileId: profile.id });
  const second = await status();
  assert.notEqual(second.id, first.id);
  await f.sync(a, [], { ackCommandId: old });
  assert.equal((await status()).counts.succeeded, 0);
  const beforeEdit = (await f.sync(a)).command.id;
  profile.profile.values.model = 'edited-model';
  await post('/api/profiles', profile);
  const edited = await status();
  assert.notEqual(edited.id, second.id);
  const editReply = await f.sync(a, [], { ackCommandId: beforeEdit });
  assert.equal(editReply.command.profile.values.model, 'edited-model');
  assert.equal((await status()).counts.succeeded, 0);
  await f.sync(a, [], { ackCommandId: editReply.command.id });
  await post('/api/dispatch', { profileId: profile.id, deviceIds: [a.deviceId, b.deviceId] });
  assert.deepEqual((await status()).counts, { total: 2, pending: 0, succeeded: 0, superseded: 2 });
  await f.sync(a, [], { ackCommandId: editReply.command.id });
  const direct = (await f.sync(a)).command.id;
  await f.sync(a, [], { ackCommandId: direct });
  assert.equal((await status()).counts.superseded, 2);
  const c = await f.addDevice('C');
  assert.equal((await status()).id, edited.id);
  assert.equal((await status()).counts.pending, 1);
  const inherited = (await f.sync(c)).command;
  assert.equal(inherited.profile.values.model, 'edited-model');
  await f.sync(c, [], { ackCommandId: inherited.id });
  await f.admin('/api/devices/' + b.deviceId, { method: 'DELETE' });
  assert.deepEqual((await status()).counts, { total: 2, pending: 0, succeeded: 1, superseded: 1 });
  const beforeRestart = await status();
  await f.restart();
  assert.deepEqual(await status(), beforeRestart);
  await post('/api/broadcast', { profileId: null });
  assert.equal(await status(), null);
  await f.sync(c, [], { ackCommandId: inherited.id });
  assert.equal(await status(), null);
  const d = await f.addDevice('D');
  assert.equal((await f.sync(d)).command, undefined);
  await f.restart();
  assert.equal(await status(), null);
});

test('per-delta quota ACK isolates full sessions and survives restart', async t => {
  const f = await fixture(t, { fileBytes: 4, diskBytes: 20, sessionsPerDevice: 2 });
  const d = await f.addDevice();
  await f.sync(d, [delta('full', 'transcript.jsonl', 0, '1234')]);
  const reply = await f.sync(d, [delta('full', 'transcript.jsonl', 4, '5'), delta('good', 'transcript.jsonl', 0, 'ok')]);
  assert.deepEqual(reply.acks, [
    { sessionId: 'full', file: 'transcript.jsonl', offset: 4, error: 'QUOTA_EXCEEDED', retryable: false },
    { sessionId: 'good', file: 'transcript.jsonl', offset: 2 },
  ]);
  await f.restart();
  const again = await f.sync(d, [delta('third', 'meta.json', 0, '{}'), delta('good', 'transcript.jsonl', 2, '!')]);
  assert.deepEqual(again.acks, [
    { sessionId: 'third', file: 'meta.json', offset: 0, error: 'QUOTA_EXCEEDED', retryable: false },
    { sessionId: 'good', file: 'transcript.jsonl', offset: 3 },
  ]);
  assert.equal((await f.admin('/api/sessions/' + d.deviceId + '/good')).transcript, 'ok!');
});


test('reporting pause persists, preserves history and permits heartbeat and broadcast ACK', async t => {
  const key = randomBytes(32).toString('base64');
  const f = await fixture(t, {}, { sharedDeviceKey: key, autoEnroll: true });
  const d = await f.addDevice();
  const devicePath = '/api/devices/' + d.deviceId;
  const patch = body => f.admin(devicePath, { method: 'PATCH', body });
  const state = () => f.admin('/api/state');
  assert.equal((await state()).devices[0].reportingBlocked, false);
  assert.equal((await f.sync(d, [delta('history', 'transcript.jsonl', 0, 'old')])).reportingBlocked, false);
  assert.equal((await patch({ reportingBlocked: true })).reportingBlocked, true);
  for (const body of [{}, { reportingBlocked: 'true' }, { reportingBlocked: null }, { reportingBlocked: 1 },
    { reportingBlocked: false, extra: true }, { name: 'invalid', reportingBlocked: [] }]) {
    assert.equal((await f.request(devicePath, { method: 'PATCH', body })).status, 400);
    assert.equal((await state()).devices[0].reportingBlocked, true);
  }
  assert.equal((await patch({ name: 'Paused' })).reportingBlocked, true);
  await f.admin('/api/profiles', { method: 'POST', body: { id: 'pause-test', name: 'Profile', profile: {
    provider: 'openai', values: { apiKey: 'secret', model: 'model' },
  } } });
  await f.admin('/api/broadcast', { method: 'POST', body: { profileId: 'pause-test' } });
  const deltas = [delta('new-session', 'transcript.jsonl', 0, 'private'), delta('history', 'transcript.jsonl', 3, 'tail')];
  const reply = await f.sync(d, deltas);
  assert.equal(reply.reportingBlocked, true);
  assert.deepEqual(reply.acks, []);
  assert.ok(reply.command);
  const acknowledged = await f.sync(d, [], { ackCommandId: reply.command.id });
  assert.deepEqual(acknowledged.acks, []);
  assert.equal(acknowledged.reportingBlocked, true);
  assert.equal(acknowledged.command, undefined);
  assert.equal((await state()).broadcastStatus.counts.succeeded, 1);
  assert.equal((await state()).devices[0].online, true);
  assert.equal((await state()).devices[0].device.hostname, deviceInfo.hostname);
  assert.deepEqual(await readdir(join(f.dataDir, 'sessions', d.deviceId)), ['history']);
  assert.equal((await f.admin('/api/sessions/' + d.deviceId + '/history')).transcript, 'old');
  const enrollment = { requestId: randomUUID(), sentAt: Date.now(), kind: 'enroll', device: deviceInfo };
  const enrolled = await f.request('/enroll', { method: 'POST', auth: false, body: {
    deviceId: d.deviceId, envelope: await seal(key, d.deviceId, 'up', enrollment),
  } });
  assert.equal(enrolled.status, 200);
  assert.equal((await state()).devices[0].reportingBlocked, true);
  await f.restart();
  assert.equal((await state()).devices[0].reportingBlocked, true);
  assert.equal((await f.sync(d, deltas)).reportingBlocked, true);
  assert.deepEqual(await readdir(join(f.dataDir, 'sessions', d.deviceId)), ['history']);
  const unauthenticated = await f.request('/sync', { method: 'POST', auth: false,
    body: { deviceId: d.deviceId, envelope: {} } });
  assert.deepEqual(unauthenticated.json, { error: 'request rejected' });
  assert.equal((await patch({ name: 'Resumed', reportingBlocked: false })).reportingBlocked, false);
  const resumed = await f.sync(d, deltas);
  assert.equal(resumed.reportingBlocked, false);
  assert.deepEqual(resumed.acks, [
    { sessionId: 'new-session', file: 'transcript.jsonl', offset: 7 },
    { sessionId: 'history', file: 'transcript.jsonl', offset: 7 },
  ]);
  assert.equal((await f.admin('/api/sessions/' + d.deviceId + '/history')).transcript, 'oldtail');
  await f.restart();
  assert.equal((await f.sync(d)).reportingBlocked, false);
});

test('legacy device reporting flag migrates to persistent false', async t => {
  const f = await fixture(t);
  await f.addDevice();
  const statePath = join(f.dataDir, 'state.json');
  const old = JSON.parse(await readFile(statePath, 'utf8'));
  delete old.devices[0].reportingBlocked;
  await writeFile(statePath, JSON.stringify(old));
  await f.restart();
  assert.equal((await f.admin('/api/state')).devices[0].reportingBlocked, false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).devices[0].reportingBlocked, false);
});
