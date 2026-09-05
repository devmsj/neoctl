import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { createControlServer } from '../server.mjs';
import { seal, open } from '../protocol.mjs';

// Run explicitly with: node --test control/test/commands.test.mjs
// No external services, dependencies, fixtures, helper files, or fixed ports.
const TEST_OPTIONS = { timeout: 30_000 };
const profileValue = (model = 'test-model') => ({
  provider: 'openai',
  values: {
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/v1',
    model,
    endpoint: 'responses',
  },
});

function assert2xx(response, context) {
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${context}: expected 2xx, got ${response.status}; ${JSON.stringify(response.body)}`,
  );
}

function assertCommand(reply, profile, context = 'sync') {
  assert.ok(reply.command && typeof reply.command === 'object', `${context}: command missing`);
  assert.equal(typeof reply.command.id, 'string', `${context}: command id must be a string`);
  assert.ok(reply.command.id.length > 0, `${context}: command id must not be empty`);
  assert.deepEqual(reply.command.profile, profile, `${context}: profile must pass through unchanged`);
  return reply.command;
}

function assertNoCommand(reply, context = 'sync') {
  // Optional command may be absent or explicitly null, but not an empty object.
  assert.ok(reply.command == null, `${context}: unexpected command ${JSON.stringify(reply.command)}`);
}

function assertRejected(response) {
  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx sync rejection, got ${response.status}`,
  );
  assert.deepEqual(response.body, { error: 'request rejected' });
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-control-commands-'));
  const adminToken = randomUUID();
  let server;
  let origin;

  async function stop() {
    if (!server?.listening) return;
    const current = server;
    await new Promise((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
      current.closeIdleConnections?.();
    });
    server = undefined;
  }

  // Register cleanup before server creation so failed setup still removes dataDir.
  t.after(async () => {
    try {
      await stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  async function start() {
    server = await createControlServer({ adminToken, dataDir });
    assert.ok(server instanceof Server, 'factory must return a native http.Server');
    assert.equal(server.listening, false, 'the caller owns listen()');
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  }

  async function request(method, path, body, admin = true) {
    const headers = { Connection: 'close' };
    if (admin) headers.Authorization = `Bearer ${adminToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let parsed;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        assert.fail(`${method} ${path}: non-JSON response (${response.status}): ${text}`);
      }
    }
    return { status: response.status, body: parsed };
  }

  async function admin(method, path, body) {
    const response = await request(method, path, body);
    assert2xx(response, `${method} ${path}`);
    return response.body;
  }

  async function device(name = 'test-device') {
    const result = await admin('POST', '/api/devices', { name });
    assert.equal(typeof result.deviceId, 'string');
    assert.ok(result.deviceId.length > 0);
    assert.equal(typeof result.key, 'string');
    assert.ok(result.key.length > 0);
    return result;
  }

  async function profile(name = 'test-profile') {
    const value = profileValue(name);
    const result = await admin('POST', '/api/profiles', { name, profile: value });
    assert.equal(typeof result.id, 'string');
    assert.ok(result.id.length > 0);
    assert.equal(result.name, name);
    assert.deepEqual(result.profile, value);
    return result;
  }

  async function state() {
    const result = await admin('GET', '/api/state');
    // Collection representations/entry fields are deliberately not assumed.
    for (const field of ['devices', 'profiles', 'broadcastProfileId', 'sessions']) {
      assert.ok(Object.hasOwn(result, field), `state must contain ${field}`);
    }
    return result;
  }

  async function rawSync(deviceCredentials, {
    ackCommandId,
    key = deviceCredentials.key,
    direction = 'up',
  } = {}) {
    const requestId = randomUUID();
    const payload = {
      requestId, sentAt: Date.now(),
      device: {
        machineCode: `machine-${deviceCredentials.deviceId}`,
        hostname: 'commands-test-host',
        model: 'test-machine',
        platform: 'win32',
      },
      deltas: [],
    };
    if (ackCommandId !== undefined) payload.ackCommandId = ackCommandId;
    const envelope = await seal(key, deviceCredentials.deviceId, direction, payload);
    const response = await request('POST', '/sync', {
      deviceId: deviceCredentials.deviceId,
      envelope,
    }, false);
    return { response, requestId };
  }

  async function sync(deviceCredentials, ackCommandId) {
    const { response, requestId } = await rawSync(deviceCredentials, { ackCommandId });
    assert2xx(response, 'POST /sync');
    // Require the transport wrapper; never accept a bare encrypted envelope.
    assert.ok(response.body && typeof response.body === 'object' && !Array.isArray(response.body));
    assert.deepEqual(Object.keys(response.body).sort(), ['envelope']);

    const { envelope } = response.body;
    assert.ok(envelope && typeof envelope === 'object' && !Array.isArray(envelope));
    const reply = await open(
      deviceCredentials.key, deviceCredentials.deviceId, 'down', envelope,
    );
    assert.equal(reply.requestId, requestId, 'encrypted response must match this request');
    assert.deepEqual(reply.acks, [], 'no deltas were submitted');
    return reply;
  }

  await start();
  return {
    admin,
    device,
    profile,
    state,
    sync,
    rawSync,
    broadcast: (profileId) => admin('POST', '/api/broadcast', { profileId }),
    dispatch: (profileId, devices) => admin('POST', '/api/dispatch', {
      profileId,
      deviceIds: devices.map((entry) => entry.deviceId),
    }),
    deleteDevice: (id) => admin('DELETE', `/api/devices/${encodeURIComponent(id)}`),
    deleteProfile: (id) => admin('DELETE', `/api/profiles/${encodeURIComponent(id)}`),
    restart: async () => {
      await stop();
      await start(); // Same admin token and dataDir; a new server instance/port.
    },
  };
}

test('broadcast reaches every current device and devices created afterwards', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  const online = await f.device('already-synced');
  const offline = await f.device('not-yet-synced');
  assertNoCommand(await f.sync(online));

  await f.broadcast(p.id);
  assert.equal((await f.state()).broadcastProfileId, p.id);
  assertCommand(await f.sync(online), p.profile);
  assertCommand(await f.sync(offline), p.profile);
  const newcomer = await f.device('created-after-broadcast');
  assertCommand(await f.sync(newcomer), p.profile);
});

test('dispatch reaches only its targets, not other current or future devices', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  const targetA = await f.device('target-a');
  const targetB = await f.device('target-b');
  const bystander = await f.device('bystander');
  await f.dispatch(p.id, [targetA, targetB]);

  assertCommand(await f.sync(targetA), p.profile);
  assertCommand(await f.sync(targetB), p.profile);
  assertNoCommand(await f.sync(bystander));
  assertNoCommand(await f.sync(await f.device('future-bystander')));
  assert.equal((await f.state()).broadcastProfileId, null);
});

test('global latest wins: a later dispatch supersedes broadcast only for targets', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const broadcastProfile = await f.profile('broadcast-model');
  const directProfile = await f.profile('direct-model');
  const target = await f.device('target');
  const bystander = await f.device('bystander');

  await f.broadcast(broadcastProfile.id);
  const oldTarget = assertCommand(await f.sync(target), broadcastProfile.profile);
  const oldBystander = assertCommand(await f.sync(bystander), broadcastProfile.profile);
  await f.dispatch(directProfile.id, [target]);
  const latest = assertCommand(await f.sync(target), directProfile.profile);
  assert.notEqual(latest.id, oldTarget.id, 'superseding command needs a new id');
  assert.equal(assertCommand(await f.sync(target), directProfile.profile).id, latest.id);
  assert.equal(assertCommand(await f.sync(bystander), broadcastProfile.profile).id, oldBystander.id);
  assertCommand(await f.sync(await f.device('new-device')), broadcastProfile.profile);
});

test('global latest wins: a later broadcast supersedes an earlier dispatch', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const directProfile = await f.profile('direct-model');
  const broadcastProfile = await f.profile('broadcast-model');
  const target = await f.device('target');
  const bystander = await f.device('bystander');

  await f.dispatch(directProfile.id, [target]);
  const old = assertCommand(await f.sync(target), directProfile.profile);
  assertNoCommand(await f.sync(bystander));
  await f.broadcast(broadcastProfile.id);
  const latest = assertCommand(await f.sync(target), broadcastProfile.profile);
  assert.notEqual(latest.id, old.id);
  assert.equal(assertCommand(await f.sync(target), broadcastProfile.profile).id, latest.id);
  assertCommand(await f.sync(bystander), broadcastProfile.profile);
  assertCommand(await f.sync(await f.device('new-device')), broadcastProfile.profile);
});

for (const [oldSource, latestSource] of [
  ['broadcast', 'broadcast'],
  ['broadcast', 'dispatch'],
  ['dispatch', 'broadcast'],
  ['dispatch', 'dispatch'],
]) {
  test(`${oldSource} -> ${latestSource}: stale ack cannot clear the latest command`, TEST_OPTIONS, async (t) => {
    const f = await fixture(t);
    const device = await f.device('stale-ack-target');
    const oldProfile = await f.profile('old-model');
    const latestProfile = await f.profile('latest-model');
    if (oldSource === 'broadcast') await f.broadcast(oldProfile.id);
    else await f.dispatch(oldProfile.id, [device]);
    const old = assertCommand(await f.sync(device), oldProfile.profile);

    if (latestSource === 'broadcast') await f.broadcast(latestProfile.id);
    else await f.dispatch(latestProfile.id, [device]);
    // The first sync after supersession carries a delayed ack of the old command.
    const latest = assertCommand(await f.sync(device, old.id), latestProfile.profile, 'stale ack response');
    assert.notEqual(latest.id, old.id);
    assert.equal(assertCommand(await f.sync(device), latestProfile.profile).id, latest.id);
    assert.equal(assertCommand(await f.sync(device, old.id), latestProfile.profile).id, latest.id);

    await f.restart();
    assert.equal(
      assertCommand(await f.sync(device, old.id), latestProfile.profile, 'stale ack after restart').id,
      latest.id,
      'stale ack must not clear or replace the persisted latest command',
    );
    assertNoCommand(await f.sync(device, latest.id), 'only the latest ack clears the command');
    assertNoCommand(await f.sync(device, old.id), 'stale ack must not resurrect a cleared command');
    await f.restart();
    assertNoCommand(await f.sync(device), 'latest ack remains persisted');
  });
}

for (const source of ['broadcast', 'dispatch']) {
  test(`${source}: unacked sync retries retain the command id; ack survives restart`, TEST_OPTIONS, async (t) => {
    const f = await fixture(t);
    const p = await f.profile();
    const acknowledged = await f.device('will-ack');
    const pending = await f.device('will-not-ack');
    if (source === 'broadcast') await f.broadcast(p.id);
    else await f.dispatch(p.id, [acknowledged, pending]);

    const first = assertCommand(await f.sync(acknowledged), p.profile);
    // Each call uses a fresh requestId and fresh seal, not a replayed envelope.
    for (let i = 0; i < 3; i += 1) {
      assert.equal(assertCommand(await f.sync(acknowledged), p.profile).id, first.id);
    }
    const stillPending = assertCommand(await f.sync(pending), p.profile);
    assertNoCommand(await f.sync(acknowledged, first.id), 'ack response');
    assertNoCommand(await f.sync(acknowledged), 'after ack');

    await f.restart();
    assertNoCommand(await f.sync(acknowledged), 'ack must remain persisted');
    assertNoCommand(await f.sync(acknowledged), 'repeated sync after restart');
    assert.equal(
      assertCommand(await f.sync(pending), p.profile).id,
      stillPending.id,
      'restart must preserve unacked commands too, not merely discard all commands',
    );
    const newcomerReply = await f.sync(await f.device('post-restart-device'));
    if (source === 'broadcast') assertCommand(newcomerReply, p.profile);
    else assertNoCommand(newcomerReply);
  });
}

test('revoking broadcast cancels delivered/unseen pending broadcasts but not a later dispatch', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const p = await f.profile('broadcast-model');
  const direct = await f.profile('direct-model');
  const delivered = await f.device('broadcast-delivered-unacked');
  const unseen = await f.device('broadcast-never-delivered');
  const target = await f.device('direct-target');
  await f.broadcast(p.id);
  assertCommand(await f.sync(delivered), p.profile);
  await f.dispatch(direct.id, [target]);
  const directCommand = assertCommand(await f.sync(target), direct.profile);

  // Suggested scope: revocation cancels only broadcast-origin commands,
  // including already delivered but unacked ones; it does not issue an undo.
  await f.broadcast(null);
  assert.equal((await f.state()).broadcastProfileId, null);
  assertNoCommand(await f.sync(delivered));
  assertNoCommand(await f.sync(unseen));
  assertNoCommand(await f.sync(await f.device('after-revocation')));
  assert.equal(assertCommand(await f.sync(target), direct.profile).id, directCommand.id);

  await f.restart();
  assert.equal((await f.state()).broadcastProfileId, null);
  assertNoCommand(await f.sync(delivered), 'revocation must survive restart');
  assertNoCommand(await f.sync(unseen));
  assertNoCommand(await f.sync(await f.device('after-revocation-and-restart')));
  assert.equal(assertCommand(await f.sync(target), direct.profile).id, directCommand.id);
});

test('deleting a device rejects fresh syncs made with its old key, including after restart', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const removed = await f.device('to-delete');
  const survivor = await f.device('survivor');
  const p = await f.profile();
  await f.broadcast(p.id);
  assertCommand(await f.sync(removed), p.profile);
  await f.deleteDevice(removed.deviceId);

  assertRejected((await f.rawSync(removed)).response);
  assertCommand(await f.sync(survivor), p.profile);
  await f.restart();
  assertRejected((await f.rawSync(removed)).response);
  assertCommand(await f.sync(survivor), p.profile);
});

for (const source of ['broadcast', 'dispatch']) {
  test(`deleting a profile ${source === 'broadcast' ? 'cancels broadcast references' : 'preserves independent dispatch snapshots'}`, TEST_OPTIONS, async (t) => {
    const f = await fixture(t);
    const deleted = await f.profile('deleted-model');
    const retained = await f.profile('retained-model');
    const delivered = await f.device('delivered-unacked');
    const unseen = await f.device('not-yet-delivered');
    const independent = await f.device('independent-command');
    if (source === 'broadcast') await f.broadcast(deleted.id);
    else await f.dispatch(deleted.id, [delivered, unseen]);
    const deliveredCommand = assertCommand(await f.sync(delivered), deleted.profile);
    await f.dispatch(retained.id, [independent]);
    const retainedCommand = assertCommand(await f.sync(independent), retained.profile);

    // Broadcast references are cancelled; explicit dispatches own independent snapshots.
    await f.deleteProfile(deleted.id);
    let unseenCommand;
    if (source === 'broadcast') {
      assertNoCommand(await f.sync(delivered));
      assertNoCommand(await f.sync(unseen));
    } else {
      assert.equal(assertCommand(await f.sync(delivered), deleted.profile).id, deliveredCommand.id);
      unseenCommand = assertCommand(await f.sync(unseen), deleted.profile);
    }
    assertNoCommand(await f.sync(await f.device('after-profile-delete')));
    assert.equal(assertCommand(await f.sync(independent), retained.profile).id, retainedCommand.id);

    await f.restart();
    if (source === 'broadcast') {
      assertNoCommand(await f.sync(delivered), 'deleted broadcast must not be resurrected');
      assertNoCommand(await f.sync(unseen));
    } else {
      assert.equal(assertCommand(await f.sync(delivered), deleted.profile).id, deliveredCommand.id);
      assert.equal(assertCommand(await f.sync(unseen), deleted.profile).id, unseenCommand.id);
      assertNoCommand(await f.sync(delivered, deliveredCommand.id));
      assertNoCommand(await f.sync(unseen, unseenCommand.id));
      await f.restart();
      assertNoCommand(await f.sync(delivered));
      assertNoCommand(await f.sync(unseen));
    }
    assertNoCommand(await f.sync(await f.device('after-profile-delete-and-restart')));
    assert.equal(assertCommand(await f.sync(independent), retained.profile).id, retainedCommand.id);
  });
}

for (const source of ['broadcast', 'dispatch']) {
  test(`editing a profile ${source === 'broadcast' ? 'renews selected broadcast' : 'does not mutate pending dispatch snapshots'}`, TEST_OPTIONS, async t => {
    const f = await fixture(t);
    const p = await f.profile('original-model');
    const device = await f.device();
    if (source === 'broadcast') await f.broadcast(p.id);
    else await f.dispatch(p.id, [device]);
    const original = assertCommand(await f.sync(device), p.profile);
    const revised = profileValue('revised-model');
    const saved = await f.admin('POST', '/api/profiles', { id: p.id, name: p.name, profile: revised });
    assert.deepEqual(saved.profile, revised);
    const expected = source === 'broadcast' ? revised : p.profile;
    const pending = assertCommand(await f.sync(device), expected);
    if (source === 'broadcast') assert.notEqual(pending.id, original.id);
    else assert.equal(pending.id, original.id);
    await f.restart();
    assert.equal(assertCommand(await f.sync(device), expected).id, pending.id);
    assertNoCommand(await f.sync(device, pending.id));
    assertNoCommand(await f.sync(device));
  });
}

test('sync authentication failures are generic plaintext 4xx responses', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  assertRejected((await f.rawSync(device, { key: randomBytes(32).toString('base64') })).response);
  assertRejected((await f.rawSync(device, { direction: 'down' })).response);
  assertNoCommand(await f.sync(device), 'invalid requests must not disable a valid device');
});
