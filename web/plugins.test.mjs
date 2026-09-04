import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadNeoPlugins } from '../engine/dist/index.js';
import { createWebPluginHost } from './plugins.mjs';

const plugins = [
  { id: 'beta', name: 'Beta', version: '1.0.0', defaultEnabled: false, tools: [{ name: 'beta_tool' }] },
  { id: 'alpha', name: 'Alpha', version: '1.0.0', defaultEnabled: true, tools: [{ name: 'alpha_tool' }], promptSections: [{ name: 'Alpha', content: 'alpha', cacheStable: true }] },
];

test('plugin host uses deterministic ordering and default switches', () => {
  const host = createWebPluginHost({ plugins });
  assert.deepEqual(host.ids, ['alpha']);
  assert.deepEqual(host.tools.map((tool) => tool.name), ['alpha_tool']);
  assert.deepEqual(host.promptSections.map((section) => section.name), ['Alpha']);
});

test('plugin host supports all, none, and explicit allow lists', () => {
  assert.deepEqual(createWebPluginHost({ plugins, enabled: 'all' }).ids, ['alpha', 'beta']);
  assert.deepEqual(createWebPluginHost({ plugins, enabled: 'none' }).ids, []);
  assert.deepEqual(createWebPluginHost({ plugins, enabled: 'beta' }).ids, ['beta']);
  assert.throws(() => createWebPluginHost({ plugins, enabled: 'missing' }), /unknown web plugin/);
});

test('plugin host rejects tool name conflicts', () => {
  assert.throws(() => createWebPluginHost({
    plugins: [
      { id: 'one', name: 'One', version: '1.0.0', tools: [{ name: 'same' }] },
      { id: 'two', name: 'Two', version: '1.0.0', tools: [{ name: 'same' }] },
    ],
    enabled: 'all',
  }), /duplicate tool name/);
});

test('core loader discovers the plugin resource directory', async () => {
  const catalog = await loadNeoPlugins({
    directories: path.resolve('plugins'),
    appDataDir: path.resolve('.neoctl-web', 'test-plugin-data'),
    env: {},
  });
  assert.deepEqual(catalog.map((plugin) => plugin.id), ['downloads', 'xhs-artifact']);
  assert.deepEqual(catalog.flatMap((plugin) => plugin.tools.map((tool) => tool.name)), [
    'expose_downloads',
    'open_xhs_artifact_editor',
    'read_xhs_artifact',
  ]);
  const host = createWebPluginHost({ plugins: catalog });
  assert.deepEqual(host.ids, ['downloads', 'xhs-artifact']);
  const runtimePlugin = host.runtimePlugins('session-1').externalPlugins.find((plugin) => plugin.id === 'xhs-artifact');
  assert.equal(typeof runtimePlugin.presentToolResult, 'function');
});
