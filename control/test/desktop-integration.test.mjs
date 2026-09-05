import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createControlServer } from '../server.mjs';
import { createControlSync } from '../../web/control-sync.mjs';
import { open } from '../protocol.mjs';

// Exercises the actual production client and server together, not matching mocks.
test('Desktop/Control: encrypted delta, restart, missing cursor, command acknowledgement and revocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-control-integration-'));
  const key = randomBytes(32).toString('base64');
  const server = await createControlServer({ dataDir: path.join(root, 'server'), adminToken: 'integration-only-token', autoEnroll: true, sharedDeviceKey: key });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${url}/api/${route}`, {
      method, headers: { Authorization: 'Bearer integration-only-token', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.ok, true, `${method} ${route}: ${response.status}`);
    return response.json();
  }
  const device = { key };
  assert.equal((await api('state')).devices.length, 0);
  const desktop = path.join(root, 'desktop');
  const sessionsRoot = path.join(desktop, 'sessions');
  const sessionId = 'desktop-session-01';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const config = { enabled: true, url, key };
  const registryFile = path.join(desktop, 'session-workspaces.json');
  await fs.writeFile(registryFile, JSON.stringify({ [sessionId]: { cwd: desktop, materialized: true } }));
  const transcriptPath = path.join(sessionsRoot, sessionId, 'transcript.jsonl');
  const first = Array.from({ length: 500 }, (_, i) => JSON.stringify({
    type: 'message', sessionId, agentId: 'main',
    message: { id: `m-${i}`, role: 'user', createdAt: '2026-09-05T00:00:00Z', blocks: [{ type: 'text', text: `唯一内容-${i}-🔐` }] },
  })).join('\n') + '\n';
  await fs.writeFile(transcriptPath, first);
  const requests = [];
  const applied = [];
  let enrollments = 0;
  function client(overrides = {}) {
    const sync = createControlSync({ config, dataDir: desktop, sessionsRoot, registryFile, ...overrides,
      device: { machineCode: 'test-machine', hostname: 'desktop', model: 'test-model', platform: 'win32' },
      applyProfile: async profile => { applied.push(structuredClone(profile)); },
      fetchImpl: async (input, init) => {
        const request = JSON.parse(init.body);
        assert.equal(init.body.includes('唯一内容'), false);
        device.deviceId ||= request.deviceId;
        assert.equal(request.deviceId, device.deviceId);
        const payload = await open(key, request.deviceId, 'up', request.envelope);
        if (new URL(input).pathname === '/enroll') {
          enrollments++;
          assert.equal(payload.kind, 'enroll');
        } else requests.push(payload);
        return fetch(input, init);
      },
    });
    clients.push(sync);
    return sync;
  }
  const stored = async () => (await api(`sessions/${device.deviceId}/${sessionId}`)).transcript;
  let sync = client();
  for (let i = 0; i < 8; i++) assert.equal(await sync.tick(), true, `initial delta ${i}`);
  assert.equal(await stored(), first);
  assert.equal(enrollments, 1);
  assert.equal((await api('state')).devices.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(desktop, 'control-device.json'), 'utf8')), { deviceId: device.deviceId });
  await assert.rejects(fs.stat(path.join(desktop, 'control-pairing.json')), { code: 'ENOENT' });
  const priorBytes = requests.reduce((sum, r) => sum + r.deltas.reduce((n, d) => n + Buffer.from(d.data, 'base64').length, 0), 0);
  assert.equal(priorBytes, Buffer.byteLength(first));
  const second = JSON.stringify({ type: 'title', sessionId, agentId: 'main', title: '新标题' }) + '\n';
  await fs.appendFile(transcriptPath, second);
  assert.equal(await sync.tick(), true);
  assert.equal(await stored(), first + second);
  assert.equal(requests.at(-1).deltas.reduce((n, d) => n + Buffer.from(d.data, 'base64').length, 0), Buffer.byteLength(second));
  await sync.stop();
  sync = client();
  assert.equal(await sync.tick(), true);
  assert.equal(requests.at(-1).deltas.every(d => d.data === ''), true, 'restart must not resend confirmed history');
  await sync.stop();
  // Client cursor loss should safely re-verify old byte ranges, never duplicate or wedge.
  await fs.rm(path.join(desktop, 'control-sync-state.json'), { force: true });
  sync = client();
  for (let i = 0; i < 8; i++) assert.equal(await sync.tick(), true, `cursor recovery ${i}`);
  assert.equal(await stored(), first + second);
  const profile = { provider: 'openai', values: { apiKey: 'test-only', model: 'gpt-5.6', baseUrl: 'https://example.invalid/v1', endpoint: 'responses' } };
  for (const invalid of [{ ...profile, values: { ...profile.values, timeoutMs: 42 } },
    { ...profile, values: { ...profile.values, apiKey: 'x'.repeat(8193) } }]) {
    const invalidResponse = await fetch(`${url}/api/profiles`, { method: 'POST',
      headers: { Authorization: 'Bearer integration-only-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'invalid contract', profile: invalid }) });
    assert.equal(invalidResponse.status, 400, 'server must reject values the Desktop cannot apply');
  }
  const archive = await api('profiles', { name: 'test profile', profile });
  await api('dispatch', { profileId: archive.id, deviceIds: [device.deviceId] });
  assert.equal(await sync.tick(), true);
  assert.deepEqual(applied, [profile]);
  assert.equal(await sync.tick(), true);
  assert.equal(applied.length, 1);
  const state = await api('state');
  assert.equal(state.devices[0].online, true);
  assert.equal(state.devices[0].pendingCommand, null);
  const disabled = client({ config: { ...config, enabled: false } });
  const count = requests.length;
  assert.equal(await disabled.tick(), false);
  assert.equal(requests.length, count, 'disabled config must make no network request');
  // Remote data conflict after cursor loss freezes the file rather than spinning or overwriting.
  await sync.stop();
  await fs.rm(path.join(desktop, 'control-sync-state.json'), { force: true });
  const conflicting = first.replace('唯一内容-0-', '不同内容-0-');
  await fs.writeFile(transcriptPath, conflicting + second);
  sync = client();
  assert.equal(await sync.tick(), true);
  const cursorState = JSON.parse(await fs.readFile(path.join(desktop, 'control-sync-state.json'), 'utf8'));
  assert.equal(cursorState.cursors[sessionId].blocked, true);
  assert.equal(await sync.tick(), true);
  assert.equal(requests.at(-1).deltas.length, 0, 'conflicting file must stop uploading');
  assert.equal(await stored(), first + second, 'remote data must not be overwritten');
  await api(`devices/${device.deviceId}`, undefined, 'DELETE');
  assert.equal(await sync.tick(), false, 'revoked device must not authenticate');
  assert.equal(await sync.tick(), false, 're-enrollment must not bypass revocation');
  await sync.stop();
  assert.equal(await client().tick(), false, 'restart must not bypass revocation');
});

test('packaged protocol copy stays byte-for-byte identical', async () => {
  assert.equal(await fs.readFile(new URL('../protocol.mjs', import.meta.url), 'utf8'),
    await fs.readFile(new URL('../../web/control-protocol.mjs', import.meta.url), 'utf8'));
});
