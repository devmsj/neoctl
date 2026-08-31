import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebPluginSettings } from './plugin-settings.mjs';

test('persists global and per-session plugin choices', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'neo-plugin-settings-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'plugins.json');
  const settings = await createWebPluginSettings(file);
  await settings.setGlobalEnabled(['xhs-artifact']);
  await settings.setSessionOverrides('session-1', { downloads: false, 'xhs-artifact': true });

  const restored = await createWebPluginSettings(file);
  assert.deepEqual(restored.globalEnabledIds(), ['xhs-artifact']);
  assert.deepEqual(restored.sessionOverrides('session-1'), { downloads: false, 'xhs-artifact': true });
  await restored.setSessionOverrides('session-1', {});
  assert.deepEqual(restored.sessionOverrides('session-1'), {});
});
