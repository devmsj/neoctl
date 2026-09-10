import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebToolSettings } from './tool-settings.mjs';

test('persists global and per-session tool overrides', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'neo-tool-settings-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'tools.json');
  const settings = await createWebToolSettings(file);
  await settings.setGlobalOverrides({ read: false, search: true, invalid: 'nope' });
  await settings.setSessionOverrides('session-1', { read: true, search: false, inherit: null });

  const restored = await createWebToolSettings(file);
  assert.deepEqual(restored.globalOverrides(), { read: false, search: true });
  assert.deepEqual(restored.sessionOverrides('session-1'), { read: true, search: false });
  await restored.setSessionOverrides('session-1', {});
  assert.deepEqual(restored.sessionOverrides('session-1'), {});
});

test('concurrent writes retain both global and session updates and failed writes do not publish state', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'neo-tool-atomic-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'tools.json');
  const settings = await createWebToolSettings(file);
  await Promise.all([
    settings.setGlobalOverrides({ read: false }),
    settings.setSessionOverrides('a', { read: true }),
    settings.setSessionOverrides('b', { search: false }),
  ]);
  assert.deepEqual((await createWebToolSettings(file)).snapshot(), settings.snapshot());
  assert.deepEqual(settings.sessionOverrides('a'), { read: true });
  assert.deepEqual(settings.sessionOverrides('b'), { search: false });
  const before = settings.snapshot();
  await fsp.rm(file);
  await fsp.mkdir(file); // rename cannot replace a directory
  await assert.rejects(settings.setGlobalOverrides({ read: true }));
  assert.deepEqual(settings.snapshot(), before);
  await fsp.rm(file, { recursive: true });
  await settings.setGlobalOverrides({ search: true });
  assert.deepEqual(settings.globalOverrides(), { search: true });
});
