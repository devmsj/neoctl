import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../server.mjs';
import { seal, open } from '../protocol.mjs';

const identity = { machineCode: 'test-machine', hostname: 'test-host', model: 'test-model', platform: 'win32' };
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-enrollment-test-'));
  const key = randomBytes(32).toString('base64'), adminToken = randomBytes(32).toString('hex');
  let server, base;
  const close = async () => {
    if (!server?.listening) return;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  };
  const start = async () => {
    server = await createControlServer({ dataDir, adminToken, sharedDeviceKey: key, autoEnroll: true, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const request = async (route, body, { method = body === undefined ? 'GET' : 'POST', token, headers = {} } = {}) => {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const admin = async (route = '/api/state', body, method) => {
    const result = await request(route, body, { token: adminToken, method });
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
    return result.body;
  };
  const enrollment = async (deviceId = randomUUID(), extra = {}, encryptionKey = key, direction = 'up') => {
    const payload = { requestId: randomUUID(), sentAt: Date.now(), kind: 'enroll', device: identity, ...extra };
    return { deviceId, envelope: await seal(encryptionKey, deviceId, direction, payload) };
  };
  const enroll = async body => request('/enroll', body ?? await enrollment());
  return { key, adminToken, dataDir, request, admin, enrollment, enroll, restart: async () => { await close(); await start(); }, state: async () => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) };
}

test('auto-enrollment requires explicit enablement AND a shared device key', async t => {
  for (const options of [{ autoEnroll: false }, { autoEnroll: undefined }, { sharedDeviceKey: undefined }]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, options);
      assert.equal((await f.enroll()).status, 403);
      assert.deepEqual((await f.admin()).devices, []);
    });
  }
});

test('authenticated enrollment returns correlated down envelope, inherits broadcast and grants only device access', async t => {
  const f = await fixture(t);
  const profile = { provider: 'openai', values: { apiKey: 'test-only-key', model: 'model-a' } };
  const p = await f.admin('/api/profiles', { name: 'test', profile });
  await f.admin('/api/broadcast', { profileId: p.id });
  const body = await f.enrollment();
  const result = await f.enroll(body);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body), ['envelope']);
  const payload = await open(f.key, body.deviceId, 'up', body.envelope);
  assert.deepEqual(await open(f.key, body.deviceId, 'down', result.body.envelope), { requestId: payload.requestId, deviceId: body.deviceId, kind: 'enrolled' });
  await assert.rejects(open(f.key, body.deviceId, 'up', result.body.envelope));
  const devices = (await f.admin()).devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].hostname, identity.hostname);
  assert.equal(devices[0].pendingCommand.profileId, p.id);
  const syncPayload = { requestId: randomUUID(), sentAt: Date.now(), device: identity, deltas: [] };
  const synced = await f.request('/sync', { deviceId: body.deviceId, envelope: await seal(f.key, body.deviceId, 'up', syncPayload) });
  assert.equal(synced.status, 200);
  assert.deepEqual((await open(f.key, body.deviceId, 'down', synced.body.envelope)).command.profile, profile);
  for (const [route, body, method] of [['/api/state'], ['/api/devices', {}], ['/api/broadcast', { profileId: null }], [`/api/devices/${devices[0].deviceId}`, undefined, 'DELETE']]) {
    assert.equal((await f.request(route, body, { token: f.key, method })).status, 401);
  }
});

test('wrong keys, tampering, direction, IDs, timestamps, identity and kind cannot create devices', async t => {
  const f = await fixture(t);
  const wrong = randomBytes(32).toString('base64');
  const cases = [await f.enrollment(undefined, {}, wrong), await f.enrollment(undefined, {}, f.key, 'down')];
  for (const extra of [{ kind: 'sync' }, { kind: undefined }, { sentAt: Date.now() - 120001 }, { sentAt: Date.now() + 180000 }, { sentAt: 'now' }, { requestId: '../x' }, { device: {} }]) cases.push(await f.enrollment(undefined, extra));
  const wrongId = await f.enrollment(); wrongId.deviceId = randomUUID(); cases.push(wrongId);
  const invalidId = await f.enrollment(); invalidId.deviceId = '../escape'; cases.push(invalidId);
  const tampered = await f.enrollment(); tampered.envelope.ciphertext = Buffer.alloc(16).toString('base64'); cases.push(tampered);
  for (const body of cases) assert.equal((await f.enroll(body)).status, 400);
  assert.deepEqual((await f.admin()).devices, []);
  const crossOrigin = await f.request('/enroll', await f.enrollment(), { headers: { origin: 'https://attacker.invalid' } });
  assert.equal(crossOrigin.status, 403);
});

test('duplicate and concurrent enrollments never reset commands, device status, acks or replay history', async t => {
  const f = await fixture(t);
  const body = await f.enrollment();
  const attempts = await Promise.all(Array.from({ length: 8 }, () => f.enroll(body)));
  assert.ok(attempts.every(r => r.status === 200));
  assert.equal((await f.admin()).devices.length, 1);
  const p = await f.admin('/api/profiles', { name: 'target', profile: { provider: 'openai', values: { apiKey: 'test-only-key', model: 'model-b' } } });
  await f.admin('/api/dispatch', { profileId: p.id, deviceIds: [body.deviceId] });
  const command = (await f.state()).devices[0].pendingCommand;
  let payload = { requestId: randomUUID(), sentAt: Date.now(), device: identity, deltas: [] };
  const sync = async () => f.request('/sync', { deviceId: body.deviceId, envelope: await seal(f.key, body.deviceId, 'up', payload) });
  assert.equal((await sync()).status, 200);
  let before = await f.state();
  await f.enroll(body);
  await f.enroll(await f.enrollment(body.deviceId, { device: { ...identity, hostname: 'must-not-overwrite' } }));
  assert.deepEqual(await f.state(), before);
  assert.equal((await sync()).status, 409, 'enrollment must not clear sync replay history');
  payload = { ...payload, requestId: randomUUID(), ackCommandId: command.id };
  assert.equal((await sync()).status, 200);
  before = await f.state();
  assert.equal(before.devices[0].pendingCommand, null);
  assert.equal(before.devices[0].lastAckCommandId, command.id);
  await f.restart();
  assert.equal((await f.enroll(body)).status, 200);
  assert.deepEqual(await f.state(), before);
});

test('deletion persistently revokes both auto-enrolled and admin-created IDs across restart', async t => {
  const f = await fixture(t);
  const body = await f.enrollment(); await f.enroll(body);
  const adminCreated = await f.admin('/api/devices', { name: 'manual' });
  for (const deviceId of [body.deviceId, adminCreated.deviceId]) await f.admin(`/api/devices/${deviceId}`, undefined, 'DELETE');
  assert.deepEqual((await f.state()).revokedDeviceIds.sort(), [body.deviceId, adminCreated.deviceId].sort());
  for (let restart = 0; restart < 2; restart++) {
    for (const deviceId of [body.deviceId, adminCreated.deviceId]) {
      const denied = await f.enroll(await f.enrollment(deviceId));
      assert.equal(denied.status, 403);
      assert.equal((await open(f.key, deviceId, 'down', denied.body.envelope)).error, 'Device revoked');
      const payload = { requestId: randomUUID(), sentAt: Date.now(), device: identity, deltas: [] };
      assert.equal((await f.request('/sync', { deviceId, envelope: await seal(f.key, deviceId, 'up', payload) })).status, 400);
    }
    await f.restart();
  }
  assert.deepEqual((await f.admin()).devices, []);
});

test('device quota, enrollment request rate and authentication failure rate bound enrollment', async t => {
  await t.test('quota permits existing identity retry but not a second device', async t => {
    const f = await fixture(t, { limits: { devices: 1 } });
    const body = await f.enrollment();
    assert.equal((await f.enroll(body)).status, 200);
    assert.equal((await f.enroll()).status, 413);
    assert.equal((await f.enroll(body)).status, 200);
    assert.equal((await f.admin()).devices.length, 1);
  });
  await t.test('enrollment per-IP rate', async t => {
    const f = await fixture(t, { limits: { enrollPerMinute: 2 } });
    const body = await f.enrollment();
    assert.equal((await f.enroll(body)).status, 200);
    assert.equal((await f.enroll(body)).status, 200);
    assert.equal((await f.enroll(body)).status, 429);
  });
  await t.test('failed auth throttle cannot be bypassed with different IDs', async t => {
    const f = await fixture(t, { limits: { authFailuresPerMinute: 2 } });
    for (let i = 0; i < 2; i++) assert.equal((await f.enroll(await f.enrollment(undefined, {}, randomBytes(32).toString('base64')))).status, 400);
    assert.equal((await f.enroll()).status, 429);
    assert.deepEqual((await f.admin()).devices, []);
  });
});

test('legacy state gains durable revocation storage without resetting device records', async t => {
  const f = await fixture(t);
  await f.admin('/api/devices', { name: 'legacy' });
  const before = await f.state(); delete before.revokedDeviceIds;
  await writeFile(join(f.dataDir, 'state.json'), JSON.stringify(before));
  await f.restart();
  assert.deepEqual(await f.state(), { ...before, revokedDeviceIds: [] });
});

test('configuration rejects using a device key as the admin token', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'neo-enrollment-key-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32).toString('base64');
  await assert.rejects(createControlServer({ dataDir: dir, adminToken: key, sharedDeviceKey: key, autoEnroll: true }), /differ/);
});
