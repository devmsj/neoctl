import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { TaskStore } from '../tasks/task-store.js';
import { createLocalAgentTask } from '../agents/local-agent-task.js';
import { createAgentContentDetailResolver, type AgentContentOwner, type AgentContentRequest, type AgentContentPage, type AgentTimelineItem } from './agent-content-detail.js';

function runtimeRedact(v: unknown): unknown {
  if (typeof v === 'string') return v.split('RUNTIME_CREDENTIAL').join('[runtime-redacted]');
  if (Array.isArray(v)) return v.map(runtimeRedact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, runtimeRedact(x)]));
  return v;
}
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'obs04-reader-')));
  const ownerDir = path.join(root, 'owner'); await fs.mkdir(ownerDir);
  const store = new TaskStore();
  const task = createLocalAgentTask({ taskId: 'task_one', agentId: 'agent_one', prompt: 'DELEGATED RUNTIME_CREDENTIAL', description: 'safe task' });
  task.status = 'completed'; task.runGeneration = 2;
  task.result = { agent_id: task.agentId, agent_type: 'reader', displaySource: 'agent_report', content: 'CURRENT REPORT', status: 'incomplete', total_duration_ms: 0, total_tool_use_count: 0 };
  task.runHistory = [{ runGeneration: 1, status: 'failed', result: { ...task.result, content: 'OLD REPORT', status: 'completed' }, error: 'actual failure RUNTIME_CREDENTIAL', progress: { totalEvents: 0, totalToolUseCount: 0 }, archivedAt: '2026-09-07T00:00:00Z' }];
  store.attachTask(task, ownerDir);
  const child = path.join(ownerDir, 'subagents', task.agentId);
  const transcript = path.join(child, 'transcript.jsonl'); await fs.writeFile(transcript, '');
  const owner: AgentContentOwner = { ownerSessionId: 'owner', ownerSessionDir: ownerDir, taskStore: store, redact: runtimeRedact };
  const resolver = createAgentContentDetailResolver();
  const request: AgentContentRequest = { taskId: task.id, runGeneration: 2, pageChars: 256 };
  let serial = 0;
  const entry = (blocks: unknown[], role = 'assistant', run: number | undefined = 2, extra: object = {}) => ({ type: 'message', sessionId: task.agentId, agentId: task.agentId, ...(run === undefined ? {} : { runGeneration: run }), message: { id: `m${++serial}`, role, createdAt: '2026-09-07T00:00:00Z', blocks }, ...extra });
  const visible = (text: string, run = 2) => entry([{ type: 'text', displayChannel: 'visible', text }], 'assistant', run);
  const write = (entries: unknown[]) => fs.writeFile(transcript, entries.map(e => JSON.stringify(e) + '\n').join(''));
  t.after(async () => { store.flush(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, task, child, transcript, owner, resolver, request, entry, visible, write };
}
async function drain(read: (r: AgentContentRequest) => Promise<AgentContentPage>, req: AgentContentRequest) {
  const pages: AgentContentPage[] = [];
  for (let i = 0; i < 3000; i++) {
    const p = await read(req); pages.push(p);
    assert.notEqual(p.state, 'unavailable', p.reason);
    if (!p.nextCursor) return pages;
    req = { ...req, cursor: p.nextCursor, refresh: false };
  }
  throw new Error('pagination did not terminate');
}
function joined(items: AgentTimelineItem[]): string[] {
  const values = new Map<string, string>();
  for (const item of items) {
    const before = values.get(item.id) ?? '';
    assert.equal(item.content.offset, before.length, 'no duplicate/omitted fragment');
    values.set(item.id, before + item.content.text);
  }
  return [...values.values()];
}
async function diskSnapshot(dir: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name); const s = await fs.lstat(file);
    out.push([file, s.size, s.mtimeMs, s.mode, s.isDirectory() ? await diskSnapshot(file) : createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
  }
  return out;
}

test('real task/transcript: visible exact run only; >24/8 entries; multi-block/empty/tool facts; no writes', async t => {
  const f = await fixture(t);
  f.task.progress.lastText = 'FORBIDDEN_LAST_TEXT';
  const entries: unknown[] = [f.visible('OLD', 1), f.visible('INHERITED', 2)];
  delete (entries[1] as { runGeneration?: number }).runGeneration;
  entries.push(f.entry([{ type: 'text', text: 'UNKNOWN' }, { type: 'thinking', text: 'HIDDEN' }, { type: 'text', displayChannel: 'hidden', text: 'HIDDEN' }]));
  entries.push(f.entry([{ type: 'text', displayChannel: 'visible', text: 'SYSTEM' }], 'system'));
  entries.push({ type: 'compact', runGeneration: 2, replacementMessages: [f.visible('COMPACT')] });
  entries.push(f.entry([{ type: 'text', displayChannel: 'visible', text: 'CROSS_OWNER' }], 'assistant', 2, { sessionId: 'other' }));
  for (let i = 0; i < 40; i++) entries.push(f.visible(`正文-${i} ${'x'.repeat(40)}`));
  entries.push(f.entry([{ type: 'text', displayChannel: 'visible', text: '' }, { type: 'text', displayChannel: 'visible', text: 'SECOND BLOCK' }]));
  entries.push(f.entry([{ type: 'tool_use', id: 'call_one', name: 'file_read', input: { path: '/real/file', offset: 0, api_key: 'STRUCT_SECRET', systemPrompt: 'SYSTEM_CONTEXT', nested: { password: 'NESTED_SECRET' }, value: 'RUNTIME_CREDENTIAL' } }]));
  entries.push(f.entry([{ type: 'tool_result', toolUseId: 'call_one', name: 'file_read', ok: false, output: { error: 'real failure RUNTIME_CREDENTIAL', content: 'ACTUAL_RESULT', truncated: true } }], 'tool_result'));
  await f.write(entries);
  const before = await diskSnapshot(f.root); const live = JSON.stringify(f.task);
  const pages = await drain(r => f.resolver.timeline(f.owner, r), f.request);
  const items = pages.flatMap(p => p.items ?? []); const strings = joined(items);
  assert.equal(strings.length, 44); assert.equal(strings[40], ''); assert.equal(strings[41], 'SECOND BLOCK');
  assert.equal(items.find(i => i.kind === 'tool_use')?.object?.text, '/real/file');
  assert.equal(items.find(i => i.kind === 'tool_result')?.status, 'failed');
  assert.equal(items.find(i => i.kind === 'tool_result')?.content.state, 'truncated');
  const serialized = JSON.stringify(pages);
  for (const denied of ['OLD', 'INHERITED', 'UNKNOWN', 'HIDDEN', 'SYSTEM_CONTEXT', 'COMPACT', 'CROSS_OWNER', 'FORBIDDEN_LAST_TEXT', 'STRUCT_SECRET', 'NESTED_SECRET', 'RUNTIME_CREDENTIAL']) assert.ok(!serialized.includes(denied), denied);
  assert.ok(serialized.includes('ACTUAL_RESULT'));
  await f.resolver.delegation(f.owner, f.request); await f.resolver.report(f.owner, f.request);
  assert.deepEqual(await diskSnapshot(f.root), before); assert.equal(JSON.stringify(f.task), live);
});

test('long single JSONL entry fragments after redaction, UTF-8/emoji, idempotent retry', async t => {
  const f = await fixture(t);
  const long = ('汉字😀' + 'x'.repeat(301) + 'RUNTIME_CREDENTIAL Bearer topsecret\n').repeat(700);
  await f.write([f.visible(long), f.visible('AFTER')]);
  const req = { ...f.request, pageChars: 8192 };
  const first = await f.resolver.timeline(f.owner, req); assert.ok(first.nextCursor);
  const a = await f.resolver.timeline(f.owner, { ...req, cursor: first.nextCursor });
  const b = await f.resolver.timeline(f.owner, { ...req, cursor: first.nextCursor });
  assert.deepEqual(a.items, b.items);
  const pages = await drain(r => f.resolver.timeline(f.owner, r), req);
  const strings = joined(pages.flatMap(p => p.items ?? []));
  assert.equal(strings[0], long.replaceAll('RUNTIME_CREDENTIAL', '[runtime-redacted]').replaceAll('Bearer topsecret', 'Bearer [已脱敏]'));
  assert.equal(strings[1], 'AFTER');
  for (const p of pages) for (const i of p.items ?? []) assert.ok(!/[\uD800-\uDBFF]$/.test(i.content.text));
});

test('fixed upper bound, append, pending tail, incremental refresh, late other-run data', async t => {
  const f = await fixture(t); await f.write([f.visible('a'.repeat(600)), f.visible('ORIGINAL')]);
  const first = await f.resolver.timeline(f.owner, f.request);
  const partial = JSON.stringify(f.visible('TAIL'));
  await fs.appendFile(f.transcript, JSON.stringify(f.visible('APPENDED')) + '\n' + JSON.stringify(f.visible('OTHER_RUN', 1)) + '\n' + partial.slice(0, 50));
  const rest = await drain(r => f.resolver.timeline(f.owner, r), { ...f.request, cursor: first.nextCursor });
  assert.deepEqual(joined([...(first.items ?? []), ...rest.flatMap(p => p.items ?? [])]), ['a'.repeat(600), 'ORIGINAL']);
  const refresh = await f.resolver.timeline(f.owner, { ...f.request, cursor: rest.at(-1)!.refreshCursor, refresh: true });
  assert.deepEqual(joined(refresh.items ?? []), ['APPENDED']); assert.equal(refresh.pendingTail, true);
  await fs.appendFile(f.transcript, partial.slice(50) + '\n');
  const tail = await f.resolver.timeline(f.owner, { ...f.request, cursor: refresh.refreshCursor, refresh: true });
  assert.deepEqual(joined(tail.items ?? []), ['TAIL']);
  const empty = await f.resolver.timeline(f.owner, { ...f.request, cursor: tail.refreshCursor, refresh: true });
  assert.deepEqual(empty.items, []);
});

test('owner/task/run/method/tampered cursor isolation and stale file identity', async t => {
  const f = await fixture(t); await f.write([f.visible('x'.repeat(700))]);
  const first = await f.resolver.timeline(f.owner, f.request); const cursor = first.nextCursor!;
  for (const [owner, req] of [
    [{ ...f.owner, ownerSessionId: 'other' }, { ...f.request, cursor }],
    [f.owner, { ...f.request, runGeneration: 1, cursor }],
    [f.owner, { ...f.request, cursor: cursor.slice(0, -5) + 'XXXXX' }],
    [f.owner, { ...f.request, agentId: 'other' }],
    [f.owner, { ...f.request, runGeneration: 0 }],
  ] as [AgentContentOwner, AgentContentRequest][]) assert.equal((await f.resolver.timeline(owner, req)).state, 'unavailable');
  assert.equal((await f.resolver.timeline({ ...f.owner, ownerSessionDir: f.root }, f.request)).state, 'missing');
  assert.equal((await f.resolver.report(f.owner, { ...f.request, cursor })).state, 'unavailable');
  await fs.rename(f.transcript, f.transcript + '.old'); await f.write([f.visible('replacement'.repeat(100))]);
  assert.equal((await f.resolver.timeline(f.owner, { ...f.request, cursor })).state, 'unavailable');
});

test('report exact archive/current/evicted/duplicate/missing/empty and safe task delegation pagination', async t => {
  const f = await fixture(t);
  f.task.prompt = '委派 RUNTIME_CREDENTIAL '.repeat(100); f.task.description = 'd'.repeat(3000);
  let pages = await drain(r => f.resolver.delegation(f.owner, r), f.request);
  assert.equal(pages.map(p => p.delegation?.prompt.text).join(''), f.task.prompt.replaceAll('RUNTIME_CREDENTIAL', '[runtime-redacted]'));
  assert.equal(pages[0]?.delegation?.description.state, 'truncated');
  let p = await f.resolver.report(f.owner, { ...f.request, runGeneration: 1 });
  assert.equal(p.report?.content.text, 'OLD REPORT'); assert.equal(p.report?.source, 'runHistory'); assert.equal(p.report?.taskStatus, 'failed'); assert.equal(p.report?.error.text, 'actual failure [runtime-redacted]');
  p = await f.resolver.report(f.owner, f.request); assert.equal(p.report?.reportStatus, 'incomplete');
  f.task.result!.content = 'report😀'.repeat(1000);
  pages = await drain(r => f.resolver.report(f.owner, r), f.request);
  assert.equal(pages.map(p => p.report?.content.text).join(''), f.task.result!.content);
  const cursor = pages[0]!.nextCursor; f.task.result!.content = 'changed';
  assert.equal((await f.resolver.report(f.owner, { ...f.request, cursor })).state, 'unavailable');
  f.task.runHistory = []; await fs.writeFile(path.join(f.child, 'output.txt'), 'prompt: WRONG\nresult: WRONG');
  p = await f.resolver.report(f.owner, { ...f.request, runGeneration: 1 }); assert.equal(p.state, 'missing'); assert.equal(p.report, undefined);
  f.task.result!.content = ''; p = await f.resolver.report(f.owner, f.request); assert.equal(p.state, 'complete'); assert.equal(p.report?.content.totalChars, 0);
  f.task.result = undefined; f.task.status = 'killed'; f.task.error = 'stopped';
  p = await f.resolver.report(f.owner, f.request); assert.equal(p.state, 'missing'); assert.equal(p.report?.taskStatus, 'killed'); assert.equal(p.report?.error.text, 'stopped');
  f.task.runHistory = [1, 2].map(() => ({ runGeneration: 1, status: 'failed' as const, progress: f.task.progress, archivedAt: '' }));
  assert.equal((await f.resolver.report(f.owner, { ...f.request, runGeneration: 1 })).state, 'unavailable');
});

for (const target of ['child', 'subagents', 'owner', 'tool-results'] as const) test(`reject junction: ${target}`, async t => {
  const f = await fixture(t); await f.write([f.visible('NEVER')]);
  const dir = target === 'child' ? f.child : target === 'subagents' ? path.dirname(f.child) : target === 'owner' ? f.owner.ownerSessionDir : path.join(f.child, 'tool-results');
  if (target === 'tool-results') await fs.mkdir(dir);
  await fs.rename(dir, dir + '-real');
  await fs.symlink(dir + '-real', dir, process.platform === 'win32' ? 'junction' : 'dir');
  if (target !== 'tool-results') assert.equal((await f.resolver.timeline(f.owner, f.request)).state, 'unavailable');
  else {
    const ref = path.join(dir, 'call_one.txt'); await fs.writeFile(path.join(dir + '-real', 'call_one.txt'), 'NEVER');
    await f.write([f.entry([{ type: 'tool_use', id: 'call_one', name: 'file_read', input: {} }]), f.entry([{ type: 'tool_result', toolUseId: 'call_one', name: 'file_read', ok: true, output: `<persisted-output>\nFull output saved to: ${ref}\n` }], 'tool_result')]);
    const p = await f.resolver.timeline(f.owner, f.request); assert.equal(p.items?.find(i => i.kind === 'tool_result')?.content.state, 'unavailable');
  }
});

for (const target of ['transcript.jsonl', 'task.json'] as const) test(`reject hardlink: ${target}`, async t => {
  const f = await fixture(t); await f.write([f.visible('NEVER')]);
  await fs.link(path.join(f.child, target), path.join(f.root, 'hardlink'));
  assert.equal((await f.resolver.timeline(f.owner, f.request)).state, 'unavailable');
  if (target === 'task.json') assert.equal((await f.resolver.report(f.owner, f.request)).state, 'unavailable');
});

test('tool-result child-only refs, real full output, hardlinks, collisions, old-run and absent files', async t => {
  const f = await fixture(t); const dir = path.join(f.child, 'tool-results'); await fs.mkdir(dir);
  const ref = path.join(dir, 'call_one.json'); await fs.writeFile(ref, JSON.stringify({ content: 'REAL STORED RESULT', password: 'REF_SECRET', value: 'RUNTIME_CREDENTIAL' }));
  const use = () => f.entry([{ type: 'tool_use', id: 'call_one', name: 'file_read', input: { path: '/object' } }]);
  const result = (file: string) => f.entry([{ type: 'tool_result', toolUseId: 'call_one', name: 'file_read', ok: true, output: `<persisted-output>\nFull output saved to: ${file}\nPRIVATE_PREVIEW` }], 'tool_result');
  const readResult = async () => (await f.resolver.timeline(f.owner, { ...f.request, pageChars: 4096 })).items?.find(i => i.kind === 'tool_result')?.content;
  await f.write([use(), result(ref)]); let content = await readResult(); assert.equal(content?.state, 'complete'); assert.match(content!.text, /REAL STORED RESULT/); assert.ok(!content!.text.includes('REF_SECRET')); assert.ok(!content!.text.includes('RUNTIME_CREDENTIAL'));
  await fs.link(ref, path.join(f.root, 'ref-link')); assert.equal((await readResult())?.state, 'unavailable'); await fs.unlink(path.join(f.root, 'ref-link'));
  await f.write([use(), result(path.join(f.root, 'foreign.json'))]); assert.equal((await readResult())?.state, 'unavailable');
  await f.write([use(), result(ref), f.entry([{ type: 'tool_use', id: 'call/one', name: 'file_read', input: {} }])]); assert.equal((await readResult())?.state, 'unavailable');
  await f.write([use(), result(ref)]); f.task.runGeneration = 3; assert.equal((await readResult())?.state, 'unavailable'); f.task.runGeneration = 2;
  await fs.unlink(ref); assert.equal((await readResult())?.state, 'unavailable');
});

test('fresh preloaded TaskStore reads disk report without reader recovery/write; mid-read generation rejected', async t => {
  const f = await fixture(t); await f.write([f.visible('VISIBLE')]);
  const fresh = new TaskStore();
  assert.equal(fresh.loadSession(f.owner.ownerSessionDir).loaded, 1); // Host setup, intentionally outside read boundary.
  const before = await diskSnapshot(f.root);
  const p = await f.resolver.report({ ...f.owner, taskStore: fresh }, { ...f.request, runGeneration: 1 });
  assert.equal(p.report?.content.text, 'OLD REPORT');
  assert.deepEqual(await diskSnapshot(f.root), before);
  let changed = false;
  const owner = { ...f.owner, redact: (v: unknown) => {
    if (!changed) { changed = true; f.task.runGeneration++; }
    return runtimeRedact(v);
  } };
  const late = await f.resolver.timeline(owner, f.request);
  assert.equal(late.state, 'unavailable'); assert.equal(late.items, undefined);
});

test('corrupt and oversized JSONL fail explicitly; filtered scan yields without skipping', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.transcript, '{bad}\n'); assert.equal((await f.resolver.timeline(f.owner, f.request)).state, 'unavailable');
  await fs.writeFile(f.transcript, '{' + 'x'.repeat(16 * 1024 * 1024) + '\n'); const p = await f.resolver.timeline(f.owner, f.request); assert.equal(p.state, 'unavailable'); assert.match(p.reason, /16 MiB/);
  await f.write([...Array.from({ length: 80 }, () => f.visible('OLD'.repeat(20000), 1)), f.visible('FOUND')]);
  const pages = await drain(r => f.resolver.timeline(f.owner, r), f.request); assert.ok(pages.length >= 2); assert.deepEqual(joined(pages.flatMap(p => p.items ?? [])), ['FOUND']);
});


test('unproven legacy current/archive reports are unavailable, never recovered from output or messages', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.child, 'output.txt'), 'UNPROVEN_PRIVATE_OUTPUT');
  f.task.result!.content = 'UNPROVEN_PRIVATE_CURRENT';
  f.task.runHistory![0]!.result!.content = 'UNPROVEN_PRIVATE_OLD';
  delete f.task.result!.displaySource;
  delete f.task.runHistory![0]!.result!.displaySource;
  for (const runGeneration of [1, 2]) {
    const page = await f.resolver.report(f.owner, { ...f.request, runGeneration });
    assert.equal(page.state, 'unavailable');
    assert.equal(page.report?.content.state, 'unavailable');
    assert(!JSON.stringify(page).includes('UNPROVEN_PRIVATE'));
    assert.match(page.reason, /来源/);
  }
});
