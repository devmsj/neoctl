import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
process.env.NEO_CORE_SOURCE = 'local';
const { browseWorkspace, createWorkspaceRuntimeManager, discoverWorkspaceLocations, materializeWorkspace, reserveWorkspace, resolveWorkspaceInput, SessionWorkspaceRegistry } = await import('../runtime-workspaces.mjs');
import { QueryEngine, ToolRegistry, TaskStore } from '../../engine/dist/index.js';
import { ExecProcessManager } from '../../engine/dist/tools/builtins/exec-process-manager.js';
import { SessionUsageTracker } from '../../engine/dist/web/index.js';

test('reserving a workspace does not create its directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-reserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const candidate = await reserveWorkspace(root);

  await assert.rejects(stat(candidate), { code: 'ENOENT' });
});

test('materializing a reserved workspace creates it on demand', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claimed = new Set();
  const candidate = await reserveWorkspace(root, claimed);

  const actual = await materializeWorkspace(root, candidate, claimed);

  assert.equal(actual, candidate);
  assert.equal((await stat(actual)).isDirectory(), true);
});

test('materializing avoids a collision created after reservation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claimed = new Set();
  const candidate = await reserveWorkspace(root, claimed);
  await mkdir(candidate);

  const actual = await materializeWorkspace(root, candidate, claimed);

  assert.notEqual(actual, candidate);
  assert.equal((await stat(actual)).isDirectory(), true);
});

test('preallocated workspace state survives a registry reload', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.neoctl-web', 'session-workspaces.json');
  const workspaceRoot = path.join(root, 'workspace');
  const candidate = await reserveWorkspace(workspaceRoot);

  await new SessionWorkspaceRegistry(file, workspaceRoot).set('session-1', candidate, { materialized: false });
  const restored = await new SessionWorkspaceRegistry(file, workspaceRoot).entry('session-1');

  assert.deepEqual(restored, {
    cwd: candidate,
    materialized: false,
    cwdHistory: [candidate],
    cwdNoticePending: false,
  });
  await assert.rejects(stat(candidate), { code: 'ENOENT' });
});

test('cwd history and pending notice survive a registry reload', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'registry.json');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await mkdir(first);
  await mkdir(second);

  await new SessionWorkspaceRegistry(file, root).set('session-1', second, {
    cwdHistory: [first, second],
    cwdNoticePending: true,
  });
  const restored = await new SessionWorkspaceRegistry(file, root).entry('session-1');

  assert.deepEqual(restored?.cwdHistory, [first, second]);
  assert.equal(restored?.cwdNoticePending, true);
});

test('workspace input tolerates either slash style and browsing returns directories only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-browse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'child'));
  const tolerant = path.join(root, 'child').split(path.sep).join(path.sep === '/' ? '\\' : '/');

  const resolved = resolveWorkspaceInput(tolerant, root);
  const result = await browseWorkspace(resolved, root);

  assert.equal(result.cwd, path.join(root, 'child'));
  assert.deepEqual(result.entries, []);
});

test('browsing a reserved workspace falls back without creating it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-browse-reserved-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await reserveWorkspace(root);

  await assert.rejects(stat(candidate), { code: 'ENOENT' });
  const result = await browseWorkspace(candidate, candidate);

  assert.equal(result.cwd, root);
  assert.equal(result.requested, candidate);
  assert.equal(result.fallback, true);
  assert.equal(result.locations.some((item) => item.kind === 'home'), true);
  assert.equal(Array.isArray(result.entries), true);
  await assert.rejects(stat(candidate), { code: 'ENOENT' });
});

test('demo submission does not materialize a workspace or replace the active engine', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-demo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new ToolRegistry(), taskStore = new TaskStore();
  let calls = 0;
  const modelGateway = { async *stream() { calls++; throw new Error('real model must not run'); } };
  const manager = createWorkspaceRuntimeManager({ projectRoot: root, workspaceRoot: path.join(root, 'workspaces'), registryFile: path.join(root, 'registry.json') });
  const cwd = path.join(root, 'workspaces', 'reserved');
  const engine = new QueryEngine({ modelGateway, tools, cwd, session: { rootDir: path.join(root, 'sessions'), resume: false } });
  await engine.initialize();
  taskStore.bindSession(engine.snapshot().session.sessionDir);
  await engine.recordDisplayMessage({ id: 'marker', role: 'system', blocks: [], createdAt: new Date().toISOString(), isMeta: true, metadata: { demoMode: 'neo.demo.v1' } });
  const runtime = { engine, tools, taskStore, execProcessManager: new ExecProcessManager(), usage: new SessionUsageTracker(), initialMetrics: await engine.contextMetrics(), envPath: path.join(root, '.env') };
  const repl = manager.createRepl(runtime);
  await repl.submit('record-only input');
  assert.equal(runtime.engine, engine);
  assert.equal(repl.snapshot().demoMode, true);
  assert.ok(repl.snapshot().lines.some(line => line.text === 'record-only input'));
  await assert.rejects(stat(cwd), { code: 'ENOENT' });
  assert.equal(calls, 0);
  await new Promise(resolve => setImmediate(resolve));
});

test('workspace locations expose human-friendly roots', async () => {
  const locations = await discoverWorkspaceLocations();

  assert.equal(locations.some((item) => item.kind === 'home'), true);
  assert.equal(locations.some((item) => process.platform === 'win32' ? item.kind === 'drive' : item.kind === 'root'), true);
});
