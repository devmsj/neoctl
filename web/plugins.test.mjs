import assert from 'node:assert/strict';
import test from 'node:test';
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
      { id: 'one', tools: [{ name: 'same' }] },
      { id: 'two', tools: [{ name: 'same' }] },
    ],
    enabled: 'all',
  }), /duplicate tool name/);
});
