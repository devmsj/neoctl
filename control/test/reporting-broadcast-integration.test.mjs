import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createControlServer } from '../server.mjs';
import { createControlSync } from '../../web/control-sync.mjs';

// Real client/server contract: pausing transcript upload must never pause model delivery.
test('paused reporting still acknowledges broadcasts; resume catches up without skipping bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-reporting-broadcast-'));
  const key = randomBytes(32).toString('base64');
  const server = await createControlServer({ dataDir: path.join(root, 'control'), adminToken: 'integration-admin-only', autoEnroll: true, sharedDeviceKey: key });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dataDir = path.join(root, 'desktop');
  const sessionsRoot = path.join(root, 'sessions');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(sessionsRoot, 'session-a'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'session-workspaces.json'), JSON.stringify({ 'session-a': { cwd: root } }));
  const transcript = path.join(sessionsRoot, 'session-a', 'transcript.jsonl');
  const first = '{"type":"title","title":"before pause"}\n';
  const added = '{"type":"title","title":"during pause"}\n';
  await fs.writeFile(transcript, first);
  const applied = [];
  const client = createControlSync({ config: { enabled: true, url, key }, dataDir, sessionsRoot,
    device: { machineCode: 'integration', hostname: 'paused-device', model: 'synthetic', platform: 'win32' },
    applyProfile: async profile => { applied.push(profile); } });
  t.after(async () => { await client.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const r = await fetch(`${url}/api/${route}`, { method, headers: { Authorization: 'Bearer integration-admin-only', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(r.ok, true, `${route}: ${r.status}`); return r.json();
  }
  for (let i = 0; i < 3; i++) assert.equal(await client.tick(), true);
  const deviceId = JSON.parse(await fs.readFile(path.join(dataDir, 'control-device.json'), 'utf8')).deviceId;
  const stored = async () => (await api(`sessions/${deviceId}/session-a`)).transcript;
  assert.equal(await stored(), first);
  const cursorFile = path.join(dataDir, 'control-sync-state.json');
  const cursorBefore = JSON.parse(await fs.readFile(cursorFile, 'utf8')).cursors['session-a'];
  await api(`devices/${deviceId}`, { reportingBlocked: true }, 'PATCH');
  await fs.appendFile(transcript, added);
  assert.equal(await client.tick(), true, 'in-flight transcript is discarded by server after pause');
  assert.equal(await stored(), first);
  assert.deepEqual(JSON.parse(await fs.readFile(cursorFile, 'utf8')).cursors['session-a'], cursorBefore);
  const profile = { provider: 'openai', values: { apiKey: 'synthetic-only-key', model: 'test-model' } };
  const archive = await api('profiles', { name: 'pause broadcast', profile });
  await api('broadcast', { profileId: archive.id });
  const pending = await api('state');
  assert.equal(pending.broadcastStatus.counts.pending, 1);
  assert.equal(pending.broadcastStatus.counts.succeeded, 0);
  assert.equal(await client.tick(), true);
  assert.deepEqual(applied, [profile]);
  const confirmed = await api('state');
  assert.equal(confirmed.broadcastStatus.id, pending.broadcastStatus.id);
  assert.equal(confirmed.broadcastStatus.counts.succeeded, 1, 'successful apply is acknowledged without another scheduled tick');
  assert.equal(confirmed.broadcastStatus.clients[0].deviceId, deviceId);
  assert.ok(confirmed.broadcastStatus.clients[0].acknowledgedAt);
  assert.equal(confirmed.devices[0].reportingBlocked, true);
  assert.equal(confirmed.devices[0].online, true);
  assert.equal(await stored(), first);
  await api(`devices/${deviceId}`, { reportingBlocked: false }, 'PATCH');
  for (let i = 0; i < 4; i++) assert.equal(await client.tick(), true);
  assert.equal(await stored(), first + added, 'resume must upload the exact missing bytes once');
  assert.equal(applied.length, 1);
  await api('broadcast', { profileId: null });
  assert.equal((await api('state')).broadcastStatus, null);
});
