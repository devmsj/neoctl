import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebPluginHost } from '../plugins.mjs';
import { createWebPluginSettings } from '../plugin-settings.mjs';
import { createPluginManager } from '../plugin-manager.mjs';
import { loadNeoPlugins, createTextMessage } from '../../engine/dist/index.js';
import { createWebRuntime, WebRepl } from '../../engine/dist/web/index.js';

test('real web runtime keeps current tools leased and refreshes main/child prompts after a live uninstall', async t => {
  const { root, manager } = await fixture(t);
  const settings = await createWebPluginSettings();
  const host = await manager.createHost({ settings });
  const runtime = await createWebRuntime({ cwd: root, sessionRootDir: path.join(root, 'sessions'), sessionId: 'live', ...host.runtimePlugins('live') });
  const source = path.join(root, 'source'); await packageAt(source);
  await manager.install(source);
  let calls = 0;
  const requests = [];
  runtime.engine.setModelProvider({ model: 'test', modelGateway: { async *stream(request) {
    requests.push(request);
    if (++calls === 1) {
      await manager.uninstall('sample');
      yield { type: 'tool_use', toolUse: { id: 'live-call', name: 'sample_tool', input: {} } };
    } else yield { type: 'assistant_message', message: createTextMessage('assistant', 'done') };
  } } });
  const events = [];
  for await (const event of runtime.engine.sendUserText('test')) events.push(event);
  assert.ok(requests[0].tools.some(tool => tool.name === 'sample_tool'));
  assert.ok(!requests[1].tools.some(tool => tool.name === 'sample_tool'));
  const result = events.filter(event => event.type === 'message').flatMap(event => event.message.blocks).find(block => block.type === 'tool_result' && block.name === 'sample_tool');
  assert.equal(result?.ok, true);
  const child = runtime.agentRuntime.acquireTurnResources('live');
  assert.equal(child.tools.get('sample_tool'), undefined); child.release();
  // Settings can be saved while busy, but applied registrations wait for the next safe boundary.
  await manager.install(source);
  const repl = Object.create(WebRepl.prototype);
  Object.assign(repl, { runtime, busy: true, publishRuntimeContext() {} });
  const changed = await repl.setSessionPlugins({ sample: 'disabled' });
  assert.equal(changed.ok, true);
  assert.deepEqual(settings.sessionOverrides('live'), { sample: false });
});

const plugin = (id = 'sample', extra = {}) => ({ id, name: id, version: '1', tools: [{ name: `${id}_tool` }], ...extra });
async function post(host, pathname, body) {
  let response, status;
  await host.route({ method: 'POST' }, {}, new URL(pathname, 'http://localhost'), {
    readJsonBody: async () => body, sendJson: (_res, value, code = 200) => { response = value; status = code; },
  });
  return { response, status };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-plugin-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const builtins = path.join(root, 'builtins'); await fs.mkdir(builtins);
  const directory = path.join(root, 'installed');
  const manager = await createPluginManager({ directory, builtInDirectory: builtins, loadPlugins: loadNeoPlugins });
  return { root, builtins, directory, manager };
}
async function packageAt(directory, version = '1', toolName = 'sample_tool') {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'neo-plugin.json'), JSON.stringify({ protocol: 'neo-plugin/v1', id: 'sample', name: 'Sample', version, entry: 'index.mjs' }));
  await fs.writeFile(path.join(directory, 'dependency.mjs'), `export const version = ${JSON.stringify(version)};`);
  await fs.writeFile(path.join(directory, 'index.mjs'), `import { version } from './dependency.mjs';
export function createPlugin(context) { return { tools: [{ name: '${toolName}', description: version, inputSchema: { type: 'object' }, metadata: { visible: true }, async call() { return { ok: true, output: { version, data: context.appDataDir } }; } }] }; }`);
}

test('global switches are immediate for history routes and existing runtime resolvers; instances survive re-enable', async () => {
  const settings = await createWebPluginSettings();
  let calls = 0;
  const source = plugin('sample', { route: () => { calls++; return true; } });
  const host = createWebPluginHost({ plugins: [source], settings });
  const runtime = host.runtimePlugins('existing');
  const tools = runtime.externalPlugins[0].tools;
  const url = new URL('http://localhost/old-resource');
  assert.equal(await host.route({ method: 'GET' }, {}, url), true);
  assert.equal((await post(host, '/api/plugins/global', { enabledIds: [] })).status, 200);
  assert.equal(host.snapshot().restartRequired, false);
  assert.equal(await host.route({ method: 'GET' }, {}, url), false);
  assert.equal(runtime.resolveExternalPlugins()[0].globallyEnabled, false);
  await post(host, '/api/plugins/global', { enabledIds: ['sample'] });
  assert.equal(runtime.resolveExternalPlugins()[0].tools, tools);
  assert.equal(await host.route({ method: 'HEAD' }, {}, url), true);
  assert.equal(calls, 2);
});

test('failed persistent switch leaves active state untouched; invalid requests do not disable everything', async () => {
  const host = createWebPluginHost({ plugins: [plugin()], settings: { globalEnabledIds() {}, async setGlobalEnabled() { throw Error('disk full'); } } });
  assert.equal((await post(host, '/api/plugins/global', { enabledIds: [] })).status, 400);
  assert.deepEqual(host.ids, ['sample']);
  assert.equal((await post(host, '/api/plugins/global', {})).status, 400);
  assert.deepEqual(host.ids, ['sample']);
});

test('uninstall drains model and HTTP stream leases and disposes once, while new routes close immediately', async () => {
  let disposed = 0;
  const host = createWebPluginHost({ plugins: [plugin('sample', { route: () => true, dispose() { disposed++; } })] });
  const turn = host.runtimePlugins('a').acquirePluginSnapshot();
  const res = new EventEmitter();
  await host.route({ method: 'GET' }, res, new URL('http://localhost/media'));
  const drain = host.prepare([])();
  assert.deepEqual(host.ids, []);
  assert.equal(await host.route({ method: 'GET' }, {}, new URL('http://localhost/media')), false);
  await Promise.resolve(); assert.equal(disposed, 0);
  turn.release(); turn.release();
  await Promise.resolve(); assert.equal(disposed, 0);
  res.emit('finish'); res.emit('close');
  await drain; assert.equal(disposed, 1);
});

test('unchanged instance is not disposed by catalog replacement; host conflicts reject before publication', async () => {
  let disposed = 0;
  const original = plugin('sample', { dispose() { disposed++; } });
  const host = createWebPluginHost({ plugins: [original] });
  await host.prepare([original, plugin('other')])();
  assert.equal(disposed, 0);
  host.reserveToolNames(['builtin']);
  assert.throws(() => host.prepare([plugin('bad', { tools: [{ name: 'builtin' }] })]), /conflicts/);
  assert.deepEqual(host.ids, ['other', 'sample']);
});

test('concurrent settings updates merge and failed persistence never publishes in-memory state', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'settings.json');
  const settings = await createWebPluginSettings(file);
  await Promise.all([settings.setGlobalEnabled(['sample']), settings.setSessionOverrides('a', { sample: false }), settings.setSessionOverrides('b', { sample: true })]);
  const restored = await createWebPluginSettings(file);
  assert.deepEqual(restored.globalEnabledIds(), ['sample']);
  assert.deepEqual(restored.sessionOverrides('a'), { sample: false });
  assert.deepEqual(restored.sessionOverrides('b'), { sample: true });
  await fs.rm(file); await fs.mkdir(file);
  await assert.rejects(settings.setGlobalEnabled([]));
  assert.deepEqual(settings.globalEnabledIds(), ['sample']);
});

test('install updates existing empty hosts, independently isolates users, reloads dependencies and persists uninstall', async t => {
  const { root, builtins, directory, manager } = await fixture(t);
  const settings = await createWebPluginSettings();
  const a = await manager.createHost({ settings }, { appDataDir: path.join(root, 'a') });
  const b = await manager.createHost({ settings }, { appDataDir: path.join(root, 'b') });
  const resolver = a.runtimePlugins('already-open');
  const source = path.join(root, 'source');
  await packageAt(source);
  await manager.install(source);
  const first = resolver.resolveExternalPlugins()[0];
  assert.equal(first.tools[0].description, '1');
  assert.notEqual(first.tools[0], b.runtimePlugins().externalPlugins[0].tools[0]);
  assert.equal((await first.tools[0].call()).output.data, path.join(root, 'a'));
  await settings.setGlobalEnabled([]);
  assert.deepEqual(a.ids, []); assert.deepEqual(b.ids, []);
  await settings.setGlobalEnabled(['sample']);
  const lease = resolver.acquirePluginSnapshot();
  await packageAt(source, '2');
  await manager.install(source);
  assert.equal(resolver.resolveExternalPlugins()[0].tools[0].description, '2');
  assert.equal(lease.plugins[0].tools[0].description, '1');
  lease.release();
  await manager.uninstall('sample');
  assert.deepEqual(a.ids, []); assert.deepEqual(b.ids, []);
  const restarted = await createPluginManager({ directory, builtInDirectory: builtins, loadPlugins: loadNeoPlugins });
  assert.deepEqual((await restarted.createHost({ settings })).ids, []);
});

test('invalid installs preserve old catalog and reserved names; built-in removal survives restart without touching source', async t => {
  const { root, builtins, directory, manager } = await fixture(t);
  const host = await manager.createHost();
  host.reserveToolNames(['reserved']);
  const source = path.join(root, 'source'); await packageAt(source);
  await manager.install(source);
  await packageAt(source, 'bad', 'reserved');
  await assert.rejects(manager.install(source), /conflicts/);
  assert.equal(host.runtimePlugins().externalPlugins[0].version, '1');
  await fs.writeFile(path.join(source, 'index.mjs'), 'not valid javascript');
  await assert.rejects(manager.install(source));
  assert.equal(host.runtimePlugins().externalPlugins[0].version, '1');
  // Separate manager exercises the built-in tombstone (never deletes shipped package files).
  const builtinSource = path.join(builtins, 'sample'); await packageAt(builtinSource);
  const builtInManager = await createPluginManager({ directory: directory + '-builtin', builtInDirectory: builtins, loadPlugins: loadNeoPlugins });
  const builtinHost = await builtInManager.createHost();
  await builtInManager.uninstall('sample');
  assert.deepEqual(builtinHost.ids, []);
  await fs.access(path.join(builtinSource, 'index.mjs'));
  const restarted = await createPluginManager({ directory: directory + '-builtin', builtInDirectory: builtins, loadPlugins: loadNeoPlugins });
  assert.deepEqual((await restarted.createHost()).ids, []);
});
