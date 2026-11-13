import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
    workspacePaths: [candidate],
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

test('workspace slash input is literal for idle, queued, immediate and continuation paths', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'neo-web-literal-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const tools=new ToolRegistry(),taskStore=new TaskStore(),engine=new QueryEngine({modelGateway:{async *stream(){throw Error('must not call model')}},tools,cwd:root,session:{rootDir:path.join(root,'sessions'),resume:false}})
 await engine.initialize();taskStore.bindSession(engine.snapshot().session.sessionDir)
 const runtime={engine,tools,taskStore,execProcessManager:new ExecProcessManager(),usage:new SessionUsageTracker(),initialMetrics:await engine.contextMetrics(),envPath:path.join(root,'.env')}
 const manager=createWorkspaceRuntimeManager({projectRoot:root,registryFile:path.join(root,'registry.json')})
 const repl=manager.createRepl(runtime);assert.equal(repl.replCommandsEnabled,false)
 assert.deepEqual(repl.snapshot(true).catalog.commands,[])
 const sent=[];engine.sendUserText=async function*(text){sent.push(text)}
 for(const text of ['/new','/reset','/login','/help','/unknown']){await repl.handleCommandOrPrompt(text);assert.equal(sent.at(-1),text)}
 const initial=engine.snapshot().session.sessionId;assert.equal(repl.snapshot().lines.filter(l=>l.kind==='user').length,5);assert.equal(engine.snapshot().session.sessionId,initial)
 repl.busy=true;repl.runControl=()=>({canResume:false});await repl.submit('/new');assert.equal(repl.queuedInput,'/new');assert.equal(engine.snapshot().session.sessionId,initial)
 repl.busy=false;const started=[];repl.startRun=(text)=>started.push(text);await repl.submitImmediately('/reset');assert.deepEqual(started,['/reset'])
 repl.runControl=()=>({canResume:true});let continuation;repl.continueRun=(text)=>{continuation=text;return{ok:true}};await repl.submit('/help');assert.equal(continuation,'/help')
})

test('deferred workspace sync does not replay line deltas already in its snapshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-web-sync-delta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new ToolRegistry(), taskStore = new TaskStore();
  const engine = new QueryEngine({ modelGateway: { async *stream() { throw new Error('must not call model'); } }, tools, cwd: root, session: { rootDir: path.join(root, 'sessions'), resume: false } });
  await engine.initialize();
  taskStore.bindSession(engine.snapshot().session.sessionDir);
  const runtime = { engine, tools, taskStore, execProcessManager: new ExecProcessManager(), usage: new SessionUsageTracker(), initialMetrics: await engine.contextMetrics(), envPath: path.join(root, '.env') };
  const repl = createWorkspaceRuntimeManager({ projectRoot: root, registryFile: path.join(root, 'registry.json') }).createRepl(runtime);
  repl.publishRuntimeContext = () => undefined;
  const frames = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writeHead() {},
    write(frame) {
      const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
      if (event && data) frames.push({ event, data: JSON.parse(data) });
      return true;
    },
  });
  repl.subscribe(response);
  t.after(() => { clearTimeout(repl.pendingDeltaTimer); response.emit('close'); });
  const text = 'Ciallo, how can I help?';
  // A buffered provider can deliver the whole reply inside one 25 ms delta window.
  repl.handleEvent({ type: 'assistant.delta', text });
  repl.handleEvent({ type: 'message', message: { id: 'a1', role: 'assistant', createdAt: new Date().toISOString(), blocks: [{ type: 'text', text }] } });
  await new Promise(resolve => setTimeout(resolve, 60));
  // Browser semantics: sync replaces rows, line.append ignores known IDs, text appends concatenate.
  const lines = new Map();
  for (const { event, data } of frames) {
    if (event === 'sync') { lines.clear(); for (const line of data.lines || []) lines.set(line.id, { ...line }); }
    if (event !== 'delta') continue;
    for (const op of data.operations) {
      if (op.type === 'line.append' && !lines.has(op.line.id)) lines.set(op.line.id, { ...op.line });
      if (op.type === 'line.text.append') lines.get(op.id).text += op.text;
      if (op.type === 'line.patch') Object.assign(lines.get(op.id), op.patch);
    }
  }
  assert.deepEqual([...lines.values()].filter(line => line.kind === 'assistant').map(line => line.text), [text]);
});

test('replacement, unmapped and cold-started sessions reserve a workspace instead of projectRoot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-workspace-unmapped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspaces'), registryFile = path.join(root, 'registry.json'), sessionRoot = path.join(root, 'sessions');
  const inWorkspaceRoot = value => { const rel = path.relative(workspaceRoot, value); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const modelGateway = { async *stream() { throw new Error('must not call model'); } };
  const tools = new ToolRegistry(), taskStore = new TaskStore();
  const manager = createWorkspaceRuntimeManager({ projectRoot: root, workspaceRoot, registryFile });
  const initialCwd = await reserveWorkspace(workspaceRoot);
  const engine = new QueryEngine({ modelGateway, tools, cwd: initialCwd, session: { rootDir: sessionRoot, resume: false } });
  await engine.initialize();
  taskStore.bindSession(engine.snapshot().session.sessionDir);
  const runtime = { engine, tools, taskStore, execProcessManager: new ExecProcessManager(), usage: new SessionUsageTracker(), initialMetrics: await engine.contextMetrics(), envPath: path.join(root, '.env') };
  const repl = manager.createRepl(runtime);
  const first = engine.snapshot().session.sessionId;
  // Production registers the first session's reserved path, which is what keeps later stamps unique.
  await new SessionWorkspaceRegistry(registryFile, workspaceRoot).set(first, initialCwd, { materialized: false, cwdHistory: [initialCwd] });

  // Deleting the active session: the replacement gets its own lazy workspace and a registry entry.
  const deletion = await repl.deleteSession(first);
  assert.equal(deletion.ok, true);
  const replacement = deletion.replacementSessionId;
  assert.ok(replacement && replacement !== first);
  const replacementCwd = repl.snapshot().cwd;
  assert.ok(inWorkspaceRoot(replacementCwd), `replacement cwd ${replacementCwd} must live under the workspace root`);
  assert.notEqual(replacementCwd, initialCwd);
  await assert.rejects(stat(replacementCwd), { code: 'ENOENT' });
  // The registry reader caches after its first load; read through a fresh instance each time.
  const readEntry = (file, id) => new SessionWorkspaceRegistry(file, workspaceRoot).entry(id);
  assert.deepEqual(await readEntry(registryFile, replacement), { cwd: replacementCwd, workspacePaths: [replacementCwd], materialized: false, cwdHistory: [replacementCwd], cwdNoticePending: false });

  // Resuming a session nobody registered (older/foreign transcript) reserves a workspace too.
  const foreign = new QueryEngine({ modelGateway, tools, cwd: root, session: { rootDir: sessionRoot, resume: false } });
  await foreign.initialize();
  const foreignId = foreign.snapshot().session.sessionId;
  const resumed = await repl.resumeSession(foreignId);
  assert.equal(resumed.ok, true);
  assert.ok(inWorkspaceRoot(resumed.cwd), `resumed cwd ${resumed.cwd} must live under the workspace root`);
  assert.equal(repl.snapshot().cwd, resumed.cwd);
  const foreignEntry = await readEntry(registryFile, foreignId);
  assert.equal(foreignEntry?.cwd, resumed.cwd);
  assert.equal(foreignEntry?.materialized, false);
  await assert.rejects(stat(resumed.cwd), { code: 'ENOENT' });

  // Cold start by session id without a mapping (page reload) must not hand out projectRoot either.
  const seen = [];
  const cold = createWorkspaceRuntimeManager({ projectRoot: root, workspaceRoot, registryFile: path.join(root, 'cold-registry.json'), createRuntime: async options => { seen.push(options); return { engine: { snapshot: () => ({ session: { sessionId: options.sessionId } }) } }; } });
  await cold.createRuntime({ sessionId: 'unmapped-session', resume: true });
  assert.ok(inWorkspaceRoot(seen[0].cwd), `cold-start cwd ${seen[0].cwd} must live under the workspace root`);
  assert.deepEqual(seen[0].workspacePaths, [seen[0].cwd]);
  const coldEntry = await readEntry(path.join(root, 'cold-registry.json'), 'unmapped-session');
  assert.equal(coldEntry?.cwd, seen[0].cwd);
  assert.equal(coldEntry?.materialized, false);
  await cold.createRuntime({});
  assert.equal(seen[1].cwd, root, 'the bare scope keeps projectRoot');
});

test('workspace locations expose human-friendly roots', async () => {
  const locations = await discoverWorkspaceLocations();

  assert.equal(locations.some((item) => item.kind === 'home'), true);
  assert.equal(locations.some((item) => process.platform === 'win32' ? item.kind === 'drive' : item.kind === 'root'), true);
});
