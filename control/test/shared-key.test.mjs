import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createControlServer } from '../server.mjs';
import { seal, open } from '../protocol.mjs';

test('shared key migrates existing devices, isolates IDs, survives restart and rejects revoked IDs', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-shared-'));
  let server, base;
  async function stop() { if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); server = null; } }
  t.after(async () => { await stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function start(sharedDeviceKey) {
    server = await createControlServer({ dataDir, adminToken: 'test-admin', sharedDeviceKey });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function admin(route, method = 'GET', body) {
    const r = await fetch(base + '/api/' + route, { method, headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(r.ok); return r.json();
  }
  async function sync(d, text = '') {
    const requestId = randomUUID();
    const payload = { requestId, sentAt: Date.now(), device: { machineCode: d.deviceId, hostname: 'test', model: 'test', platform: 'test' }, deltas: text ? [{ sessionId: 'same-session', file: 'transcript.jsonl', offset: 0, data: Buffer.from(text).toString('base64') }] : [] };
    const r = await fetch(base + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: d.deviceId, envelope: await seal(d.key, d.deviceId, 'up', payload) }) });
    if (r.ok) { const reply = await open(d.key, d.deviceId, 'down', (await r.json()).envelope); assert.equal(reply.requestId, requestId); }
    return r.status;
  }
  await start();
  const old = await admin('devices', 'POST', { name: 'existing' });
  assert.equal(await sync(old, 'existing history\n'), 200);
  await stop();
  const sharedDeviceKey = randomBytes(32).toString('base64');
  await start(sharedDeviceKey);
  assert.equal(await sync(old), 400);
  const migrated = { ...old, key: sharedDeviceKey };
  assert.equal(await sync(migrated), 200);
  const second = await admin('devices', 'POST', { name: 'second' });
  assert.equal(second.key, sharedDeviceKey);
  assert.notEqual(second.deviceId, old.deviceId);
  assert.equal(await sync(second, 'second history\n'), 200);
  assert.equal((await admin(`sessions/${old.deviceId}/same-session`)).transcript, 'existing history\n');
  assert.equal((await admin(`sessions/${second.deviceId}/same-session`)).transcript, 'second history\n');
  assert.equal(JSON.stringify(await admin('state')).includes(sharedDeviceKey), false);
  await admin(`devices/${second.deviceId}`, 'DELETE');
  assert.equal(await sync(second), 400);
  await stop(); await start(sharedDeviceKey);
  assert.equal(await sync(migrated), 200);
  assert.equal(await sync(second), 400);
  const third = await admin('devices', 'POST', { name: 'third' });
  assert.equal(third.key, sharedDeviceKey);
});

test('invalid shared key fails closed before starting', async () => {
  for (const key of ['', 'password', randomBytes(31).toString('base64'), ' '.repeat(44)]) {
    await assert.rejects(createControlServer({ adminToken: 'test', sharedDeviceKey: key }), /CONTROL_SHARED_DEVICE_KEY/);
  }
});
