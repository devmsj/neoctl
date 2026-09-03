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
