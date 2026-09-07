// Real HTTP server/router/WebRepl/resolver; real preloaded TaskStore and disk JSONL.
// No production patches. Run: npx tsx src/web/smoke-agent-content-http.ts
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runWebServer, WebRepl, type WebRuntime } from './index.js';
import { TaskStore } from '../tasks/task-store.js';
import { createLocalAgentTask, type LocalAgentTask } from '../agents/local-agent-task.js';
import { InMemorySecretRedactionRegistry } from '../secrets/secret-redaction.js';
import { redactToolDetail } from './tool-call-detail.js';
import type { AgentContentPage, AgentTimelineItem } from './agent-content-detail.js';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'obs-agent-http-')));
const dirs = new Map(['A', 'B'].map(id => [id, path.join(root, `actual-${id}`)]));
const store = new TaskStore();
const ownerStores = new Map([['A', store], ['B', new TaskStore()]]);
const allTasks = () => [...ownerStores.values()].flatMap(s => s.list());
const secrets = new InMemorySecretRedactionRegistry();
const secret = 'HTTP_AGENT_RUNTIME_SECRET_7295'; secrets.record('agent_http', secret);
let assertions = 0; let requests = 0; let modelCalls = 0; let mutations = 0; let runtimeCreations = 0;
let switchDuringRead = false;
let server: http.Server | undefined; let base = '';
const originalCreateServer = http.createServer;
const findings: string[] = []; const defects: string[] = []; const phases: string[] = [];
const sanitized = (text: string): string => redactToolDetail(secrets.redact(redactToolDetail(text))) as string;
type AgentStateTask = Pick<LocalAgentTask, 'taskId' | 'runGeneration' | 'status' | 'progress' | 'startedAt' | 'completedAt' | 'durationMs' | 'createdAt' | 'updatedAt' | 'runHistory' | 'result' | 'error'>;
type AgentState = { session: { sessionId: string }; lines: unknown[]; backgroundTasks: AgentStateTask[]; agentTaskHistory: AgentStateTask[] };
function check(v: unknown, reason: string): asserts v { assert.ok(v, reason); assertions++; }
function eq(a: unknown, b: unknown, reason: string) { assert.deepEqual(a, b, reason); assertions++; }
const deny = () => { mutations++; throw new Error('GET attempted mutation/recovery'); };
const model = () => { modelCalls++; throw new Error('GET attempted model/submit'); };
const transcript = (owner: string, agent = 'agent_shared') => path.join(dirs.get(owner)!, 'subagents', agent, 'transcript.jsonl');
let serial = 0;
function entry(text: string, runGeneration = 3, agentId = 'agent_shared', visible = true) {
  return { type: 'message', sessionId: agentId, agentId, runGeneration, message: { id: `m${++serial}`, role: 'assistant', createdAt: '2026-09-07T00:00:00Z', blocks: [{ type: 'text', text, ...(visible ? { displayChannel: 'visible' } : {}) }] } };
}
const jsonl = (values: unknown[]) => values.map(v => JSON.stringify(v) + '\n').join('');
async function snapshot(): Promise<unknown[]> {
  const out: unknown[] = [];
  async function walk(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const p = path.join(dir, name); const s = await fs.lstat(p);
      out.push([path.relative(root, p), s.size, s.mtimeMs, s.mode, s.isDirectory() ? 'dir' : createHash('sha256').update(await fs.readFile(p)).digest('hex')]);
      if (s.isDirectory()) await walk(p);
    }
  }
  await walk(root); return out;
}
async function start() {
  const probe = originalCreateServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address(); check(addr && typeof addr === 'object', 'port allocated');
  await new Promise<void>(r => probe.close(() => r()));
  (http as unknown as { createServer: Function }).createServer = (...args: unknown[]) => server = (originalCreateServer as Function)(...args) as http.Server;
  try {
    await runWebServer(['--host', '127.0.0.1', '--port', String(addr.port)], {
      createRuntime: async config => {
        runtimeCreations++;
        const id = config?.sessionId ?? 'A';
        const session = dirs.has(id) ? { sessionId: id, sessionDir: dirs.get(id) } : undefined;
        return {
          taskStore: ownerStores.get(id) ?? store, execProcessManager: { subscribe: () => () => {}, subscribeOutput: () => () => {}, list: () => [] }, envPath: path.join(root, 'fixture.env'), initialMetrics: {},
          engine: {
            snapshot: () => ({ session, messages: 0 }), getDisplayEntries: () => [], getHistoryMessages: () => [],
            redactDisplayValue: (v: unknown) => {
              if (switchDuringRead) { switchDuringRead = false; store.getInSession('task_A', dirs.get('A'))!.runGeneration++; }
              return secrets.redact(v);
            },
            isFastMode: () => false, getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => {},
            submit: model, query: model, appendMessage: deny,
          }, model: { generate: model },
        } as unknown as WebRuntime;
      },
      createRepl: runtime => { const repl = new WebRepl(runtime); repl.submit = model as WebRepl['submit']; return repl; },
    });
  } finally { (http as unknown as { createServer: Function }).createServer = originalCreateServer; }
  check(server?.listening, 'real server listening'); base = `http://127.0.0.1:${addr.port}`;
}
function url(changes: Record<string, string> = {}) {
  return `${base}/api/agent-content?${new URLSearchParams({ sessionId: 'A', taskId: 'task_A', runGeneration: '3', view: 'timeline', pageChars: '1024', ...changes })}`;
}
async function request(target: string, init?: RequestInit) { requests++; return fetch(target, { ...init, signal: AbortSignal.timeout(15_000) }); }
async function page(changes: Record<string, string> = {}) {
  const response = await request(url(changes)); eq(response.status, 200, 'raw page HTTP200');
  eq(response.headers.get('cache-control'), 'no-store', 'not cacheable');
  const p = await response.json() as AgentContentPage;
  eq(p.ownerSessionId, changes.sessionId ?? 'A', 'owner response identity'); eq(p.taskId, changes.taskId ?? 'task_A', 'task response identity');
  const requestedRun = Number(changes.runGeneration ?? '3');
  eq(p.runGeneration, Number.isFinite(requestedRun) ? requestedRun : null, 'run response identity (nonfinite JSON numbers become null)');
  check(!('ok' in p) && !('value' in p), 'raw AgentContentPage, not wrapper'); return p;
}
async function state(owner = 'A') {
  const response = await request(`${base}/api/state?${new URLSearchParams({ sessionId: owner })}`);
  eq(response.status, 200, 'real snapshot HTTP200');
  const body = await response.json() as AgentState;
  eq(body.session.sessionId, owner, 'snapshot owner');
  eq(body.lines, [], 'GET does not publish transcript lines');
  return body;
}
async function drain(changes: Record<string, string> = {}) {
  const pages: AgentContentPage[] = [];
  for (let i = 0; i < 200; i++) {
    const p = await page(changes); pages.push(p); check(p.state !== 'unavailable', p.reason);
    if (!p.nextCursor) return pages;
    changes = { ...changes, cursor: p.nextCursor, refresh: 'false' };
  }
  throw new Error('pagination stuck');
}
function join(items: AgentTimelineItem[]) {
  const values = new Map<string, string>();
  for (const item of items) { const prev = values.get(item.id) ?? ''; eq(item.content.offset, prev.length, 'fragment no gaps/duplicates'); values.set(item.id, prev + item.content.text); }
  return [...values.values()];
}
try {
  for (const [id, dir] of dirs) {
    await fs.mkdir(dir, { recursive: true });
    const task = createLocalAgentTask({ taskId: `task_${id}`, agentId: 'agent_shared', prompt: (`DELEGATION_${id} ${secret} 汉😀\n`).repeat(150), description: 'd'.repeat(2200) });
    task.status = 'failed'; task.runGeneration = 3; task.error = `ACTUAL_FAIL ${secret}`;
    task.createdAt = '2026-09-01T00:00:00.000Z'; task.updatedAt = '2026-09-07T00:10:00.000Z';
    task.progress.lastText = `LEGACY_LAST_TEXT_${id}_FORBIDDEN`;
    task.progress.visibleText = { channel: 'visible', redactionVersion: 1, runGeneration: 3, text: `LIVE_${id} ${secret}`, truncated: true };
    task.startedAt = '2026-09-07T00:00:00.000Z'; task.completedAt = '2026-09-07T00:00:01.000Z'; task.durationMs = 1000;
    task.result = { agent_id: task.agentId, agent_type: 'test', displaySource: 'agent_report', content: (`CURRENT_PARTIAL_${id} ${secret} 😀\n`).repeat(130), status: 'incomplete', total_duration_ms: 1000, total_tool_use_count: 0 };
    task.runHistory = [{ runGeneration: 2, status: 'completed', startedAt: '2026-09-06T00:00:00.000Z', completedAt: '2026-09-06T00:00:02.500Z', durationMs: 2500,
      result: { ...task.result, content: (`ARCHIVE_${id} ${secret}\n`).repeat(100), status: 'completed' }, progress: task.progress, archivedAt: task.completedAt }];
    const writer = new TaskStore(); writer.attachTask(task, dir); writer.flush();
    await fs.writeFile(transcript(id), id === 'A' ? jsonl([
      ...Array.from({ length: 80 }, () => entry('OLD_FORBIDDEN'.repeat(5000), 1)),
      entry('HIDDEN_FORBIDDEN', 3, 'agent_shared', false),
      { ...entry('SYSTEM_FORBIDDEN'), message: { ...entry('').message, role: 'system', blocks: [{ type: 'text', displayChannel: 'visible', text: 'SYSTEM_FORBIDDEN' }] } },
      entry((`BODY_A ${secret} Bearer fixturebearer 汉😀\n`).repeat(500)),
      ...Array.from({ length: 35 }, (_, i) => entry(`visible-${i}\n`)),
      { type: 'message', sessionId: 'agent_shared', agentId: 'agent_shared', runGeneration: 3, message: { id: 'tool-use', role: 'assistant', blocks: [{ type: 'tool_use', id: 'call_one', name: 'file_read', input: { path: '/real/object', offset: 0, api_key: 'STRUCT_SECRET' } }] } },
      { type: 'message', sessionId: 'agent_shared', agentId: 'agent_shared', runGeneration: 3, message: { id: 'tool-result', role: 'tool_result', blocks: [{ type: 'tool_result', toolUseId: 'call_one', name: 'file_read', ok: false, output: { error: 'REAL_TOOL_ERROR', content: secret } }] } },
    ]) : jsonl([entry('BODY_B_ONLY')]));
    // Preloading can recover/write; explicitly outside HTTP read boundary.
    eq(ownerStores.get(id)!.loadSession(dir).loaded, 1, `real disk preload ${id}`);
  }
  const second = createLocalAgentTask({ taskId: 'task_second', agentId: 'agent_second', prompt: 'SECOND_ONLY', description: '' });
  second.status = 'completed'; second.runGeneration = 3;
  second.progress.lastText = 'SECOND_LEGACY_FORBIDDEN';
  second.progress.visibleText = { channel: 'visible', runGeneration: 2, text: 'STALE_VISIBLE_FORBIDDEN', truncated: false }; store.attachTask(second, dirs.get('A'));
  await fs.writeFile(transcript('A', 'agent_second'), jsonl([entry('SECOND_ONLY', 3, 'agent_second')]));
  await fs.writeFile(path.join(root, 'fixture.env'), ''); store.flush();
  const a = store.getInSession('task_A', dirs.get('A'))!;
  const initialTask = JSON.stringify(a);
  for (const method of ['bindSession', 'loadSession', 'activateSession', 'prepareResume', 'upsert', 'updateProgress', 'markRunning', 'complete', 'fail', 'kill', 'queueMessage', 'queueMessageInSession', 'appendMessage', 'flush']) {
    for (const ownerStore of ownerStores.values()) (ownerStore as unknown as Record<string, unknown>)[method] = deny;
  }
  const before = await snapshot(); await start();
  const first = await page(); eq(first.state, 'partial', 'filtered scan empty partial'); eq(first.items, [], 'empty page is not EOF'); check(first.nextCursor, 'empty partial continues');
  const remaining = await drain({ cursor: first.nextCursor });
  check(remaining.length > 1, 'timeline spans multiple pages');
  check(remaining.every(p => p.snapshotId === first.snapshotId && p.upperBoundBytes === first.upperBoundBytes), 'all timeline pages retain snapshot identity and upper bound');
  const items = remaining.flatMap(p => p.items ?? []); const joined = join(items);
  eq(joined.length, 38, '>24/8 entries and tool steps retained');
  eq(joined[0], sanitized((`BODY_A ${secret} Bearer fixturebearer 汉😀\n`).repeat(500)), 'long single JSONL exact full redacted body');
  eq(items.find(i => i.kind === 'tool_use')?.object?.text, '/real/object', 'real tool object');
  eq(items.find(i => i.kind === 'tool_result')?.status, 'failed', 'actual tool failure');
  const all = JSON.stringify(remaining);
  for (const forbidden of [secret, 'HIDDEN_FORBIDDEN', 'SYSTEM_FORBIDDEN', 'OLD_FORBIDDEN', 'STRUCT_SECRET', 'fixturebearer', 'BODY_B_ONLY']) check(!all.includes(forbidden), `denied ${forbidden}`);
  const retry1 = await page({ cursor: first.nextCursor }); const retry2 = await page({ cursor: first.nextCursor }); eq(retry1.items, retry2.items, 'same HTTP cursor retry idempotent');
  phases.push('real-http-empty-partial-long-line-visible-tools');

  for (const view of ['delegation', 'report']) {
    const pages = await drain({ view }); check(pages.length > 1, `${view} multipage`);
    const field = (p: AgentContentPage) => view === 'report' ? p.report!.content : p.delegation!.prompt;
    let result = ''; for (const p of pages) { eq(field(p).offset, result.length, `${view} offset`); result += field(p).text; }
    eq(result, sanitized(view === 'report' ? a.result!.content : a.prompt), `${view} exact redacted source`);
    if (view === 'report') { eq(pages[0]!.report!.source, 'task.result', 'current source'); eq(pages[0]!.report!.taskStatus, 'failed', 'partial is not success'); eq(pages[0]!.report!.reportStatus, 'incomplete', 'saved incomplete status'); eq(pages[0]!.report!.error.text, sanitized(`ACTUAL_FAIL ${secret}`), 'real error'); }
    else eq(pages[0]!.delegation!.description.state, 'truncated', 'description explicit truncation');
    check(!JSON.stringify(pages).includes(secret), `${view} secret absent across wire pages`);
    for (const scope of [{ sessionId: 'B', taskId: 'task_B' }, { taskId: 'task_second' }, { runGeneration: '2' }] as Record<string, string>[]) {
      eq((await page({ view, cursor: pages[0]!.nextCursor!, ...scope })).state, 'unavailable', `${view} cross-owner/task/run cursor rejected`);
    }
    eq((await page({ view, refresh: 'true', cursor: pages[0]!.nextCursor! })).state, 'unavailable', `${view} incremental refresh rejected; reread without cursor`);
    eq((await page({ view })).snapshotId === pages[0]!.snapshotId, false, `${view} fresh read creates new snapshot`);
    const p = await page({ view: view === 'report' ? 'delegation' : 'report', cursor: pages[0]!.nextCursor! }); eq(p.state, 'unavailable', 'cross-view cursor rejected');
  }
  eq((await page({ refresh: 'true' })).state, 'unavailable', 'timeline refresh requires drained cursor');
  eq((await page({ refresh: 'true', cursor: first.nextCursor })).state, 'unavailable', 'timeline partial cursor cannot refresh');
  const archives = await drain({ view: 'report', runGeneration: '2' });
  eq(archives.map(p => p.report!.content.text).join(''), sanitized(a.runHistory![0]!.result!.content), 'exact archive paginated');
  eq(archives[0]!.report!.source, 'runHistory', 'archive source');
  eq((await page({ view: 'report', runGeneration: '1' })).state, 'missing', 'evicted run missing never current');
  eq(JSON.stringify(a), initialTask, 'GET task timing/partial/source unchanged');
  eq((await page({ view: 'report', taskId: 'task_second' })).state, 'missing', 'no saved report does not invoke a model');
  phases.push('delegation-report-current-archive-evicted-partial');

  // Snapshot endpoint shares the real router/runtime/store; no direct private projection calls.
  const sourceBeforeState = JSON.stringify(allTasks());
  const currentState = await state();
  const projected = currentState.agentTaskHistory.find(t => t.taskId === a.taskId)!;
  check(projected, 'current failed task in snapshot history');
  eq(projected.progress.visibleText, secrets.redact(a.progress.visibleText), 'only current visible generation is redacted and preserved, including truncated flag');
  check(!('lastText' in projected.progress), 'legacy lastText field not public');
  check(!JSON.stringify(currentState).includes('LEGACY_LAST_TEXT_'), 'legacy lastText content not public');
  const projectedSecond = currentState.agentTaskHistory.find(t => t.taskId === second.taskId)!;
  check(projectedSecond && !('visibleText' in projectedSecond.progress), 'prior-generation visibleText omitted');
  check(!JSON.stringify(currentState).includes('STALE_VISIBLE_FORBIDDEN'), 'stale visible body not elsewhere in snapshot');
  for (const field of ['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'durationMs'] as const) eq(projected[field], a[field], `snapshot exact actual ${field}`);
  eq(projected.runHistory?.[0]?.startedAt, a.runHistory![0]!.startedAt, 'archive actual start, not current start');
  eq(projected.runHistory?.[0]?.completedAt, a.runHistory![0]!.completedAt, 'archive actual end');
  eq(projected.runHistory?.[0]?.durationMs, 2500, 'archive actual frozen duration');
  for (const field of ['startedAt', 'completedAt', 'durationMs'] as const) check(!(field in projectedSecond), `unknown ${field} not fabricated from creation/update`);
  const stateB = await state('B');
  eq(stateB.agentTaskHistory.map(t => t.taskId), ['task_B'], 'snapshot owner B excludes A tasks');
  check(!JSON.stringify(currentState).includes('LIVE_B'), 'snapshot A excludes B visible preview');
  eq((await state()).agentTaskHistory.find(t => t.taskId === a.taskId)?.durationMs, 1000, 'terminal duration frozen across reads');
  // Collect a wire-level defect without aborting remaining security/refresh tests.
  if (JSON.stringify(currentState).includes(secret)) defects.push('/api/state publishes registered runtime secret in agent current/archive result or error; visibleText itself is redacted. agentTaskSnapshot result/error projections need runtime redaction.');
  eq(JSON.stringify(allTasks()), sourceBeforeState, 'snapshot did not mutate any loaded task');
  const savedProgress = a.progress;
  const savedStatus = a.status;
  try {
    a.status = 'running'; a.progress = { ...savedProgress, visibleText: { ...savedProgress.visibleText!, runGeneration: 2, text: 'STALE_ACTIVE_FORBIDDEN' } };
    let active = (await state()).backgroundTasks.find(t => t.taskId === a.taskId)!;
    check(active && !('visibleText' in active.progress) && !('lastText' in active.progress), 'active task cannot fall back to stale preview or legacy text');
    eq(active.result, undefined, 'active snapshot does not publish stale terminal result');
    a.progress = { ...savedProgress, visibleText: { ...savedProgress.visibleText!, channel: 'hidden' as 'visible' } };
    active = (await state()).backgroundTasks.find(t => t.taskId === a.taskId)!;
    check(!('visibleText' in active.progress), 'unapproved preview channel omitted even for current generation');
    a.progress = { ...savedProgress, visibleText: { ...savedProgress.visibleText!, redactionVersion: undefined, text: secret.slice(-10) + 'x'.repeat(3990) } };
    active = (await state()).backgroundTasks.find(t => t.taskId === a.taskId)!;
    check(!('visibleText' in active.progress), 'legacy clipped preview without redaction provenance never published');
    check(!JSON.stringify(active).includes(secret.slice(-10)), 'legacy secret suffix cannot survive exact registry matching');
    a.progress = savedProgress;
    active = (await state()).backgroundTasks.find(t => t.taskId === a.taskId)!;
    eq(active.progress.visibleText, secrets.redact(savedProgress.visibleText), 'active current visible generation is available');
    eq(active.startedAt, a.startedAt, 'active actual start not creation/update time');
  } finally { a.progress = savedProgress; a.status = savedStatus; }
  eq(JSON.stringify(allTasks()), sourceBeforeState, 'fixture-only snapshot changes fully restored');
  phases.push('http-snapshot-current-visible-no-lastText-real-current-archive-timing');

  // Redact whole scalar values BEFORE bounding the public snapshot, never a credential prefix.
  const savedScalars = { result: a.result, error: a.error, runHistory: a.runHistory };
  try {
    const current = 'x'.repeat(1480) + secret + ' tail';
    const archived = 'y'.repeat(580) + secret + ' tail';
    a.result = { ...a.result!, content: current }; a.error = current;
    a.runHistory = [{ ...a.runHistory![0], result: { ...a.runHistory![0].result!, content: archived }, error: archived }];
    const projected = (await state()).agentTaskHistory.find(t => t.taskId === a.taskId)!;
    eq(projected.result!.content, secrets.redact(current).slice(0, 1500), 'current report redacted before clipping');
    eq(projected.error, secrets.redact(current).slice(0, 1500), 'current error redacted before clipping');
    eq(projected.runHistory![0].result!.content, secrets.redact(archived).slice(0, 600), 'archive report redacted before clipping');
    eq(projected.runHistory![0].error, secrets.redact(archived).slice(0, 600), 'archive error redacted before clipping');
    check(!JSON.stringify(projected).includes(secret.slice(0, 20)), 'no clipped credential prefix in snapshot');
  } finally { Object.assign(a, savedScalars); }
  eq(JSON.stringify(allTasks()), sourceBeforeState, 'scalar redaction regression leaves sources intact');
  phases.push('snapshot-secret-boundary-before-current-archive-clipping');

  // Legacy saved results are not proof of a public channel, even on successful tasks.
  try {
    a.result = { ...savedScalars.result!, displaySource: undefined, content: 'LEGACY_PRIVATE_REPORT_FORBIDDEN' };
    a.runHistory = [{ ...savedScalars.runHistory![0], result: { ...savedScalars.runHistory![0].result!, displaySource: undefined, content: 'LEGACY_PRIVATE_ARCHIVE_FORBIDDEN' } }];
    const wire = await state();
    check(!JSON.stringify(wire).includes('LEGACY_PRIVATE_'), 'snapshot suppresses current and archive unproven report text');
    for (const generation of ['3', '2']) {
      const legacy = await page({ view: 'report', runGeneration: generation });
      eq(legacy.state, 'unavailable', 'unproven legacy report is unavailable, not complete/missing');
      check(!JSON.stringify(legacy).includes('LEGACY_PRIVATE_'), 'full reader never publishes unproven legacy report');
    }
  } finally { Object.assign(a, savedScalars); }
  eq(JSON.stringify(allTasks()), sourceBeforeState, 'legacy provenance checks never mutate source');
  phases.push('legacy-current-archive-report-provenance-unavailable');

  const count = runtimeCreations;
  eq((await request(url({ sessionId: 'never-created' }), { headers: { Origin: 'https://evil.invalid' } })).status, 403, 'origin denied before runtime');
  eq(runtimeCreations, count, '403 cannot create runtime');
  eq((await request(url(), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-site denied');
  eq((await request(url(), { headers: { Origin: base } })).status, 200, 'same-origin allowed');
  for (const query of [{ sessionId: 'B' }, { taskId: 'missing' }, { sessionId: 'unknown' }, { view: 'hidden' }, { sessionId: '' }] as Record<string, string>[]) eq((await request(url(query))).status, 404, 'invalid owner/task/view404');
  eq(join((await page({ sessionId: 'B', taskId: 'task_B' })).items ?? []), ['BODY_B_ONLY'], 'same child agentId isolated by owner');
  for (const query of [{ sessionId: 'B', taskId: 'task_B' }, { taskId: 'task_second' }, { runGeneration: '2' }, { cursor: first.nextCursor.slice(0, -8) + 'tampered' }] as Record<string, string>[]) {
    eq((await page({ cursor: first.nextCursor, ...query })).state, 'unavailable', 'cross-owner/task/run or tampered cursor denied');
  }
  // tabId takes runtime routing priority, but agentContent must still match actual runtime session.
  await page({ tabId: 'shared-tab' });
  eq((await request(url({ tabId: 'shared-tab', sessionId: 'B', taskId: 'task_B' }))).status, 404, 'tab-scoped A runtime cannot serve B');
  const injected = await page({ ownerSessionDir: dirs.get('B')!, ownerSessionId: 'B', agentId: 'agent_second', path: transcript('B'), sessionDir: dirs.get('B')! });
  eq(injected.items, [], 'extra owner/path params cannot replace trusted scope');
  eq((await request(url({ sessionId: 'B', taskId: 'task_A', ownerSessionDir: dirs.get('A')! }))).status, 404, 'forged owner path cannot override B scope');
  for (const changes of [{ runGeneration: '0' }, { runGeneration: 'NaN' }, { runGeneration: '3.5' }, { pageChars: '1' }, { pageChars: '65537' }] as Record<string, string>[]) eq((await page(changes)).state, 'unavailable', 'invalid numeric request rejected');
  const duplicate = await request(url({ sessionId: 'B' }) + '&sessionId=A&taskId=task_B'); eq(duplicate.status, 404, 'duplicate scope cannot bypass first owner/task check');
  // Record actual wire normalization, not falsely claim resolver rejects these at HTTP boundary.
  eq((await request(url({ refresh: 'not-a-boolean' }))).status, 404, 'malformed refresh boolean rejected at HTTP boundary');
  findings.push('HTTP discards unknown ownerSessionDir/ownerSessionId/agentId/path/sessionDir keys before resolver. Tested they cannot override trusted scope; strict unknown-key rejection documented for resolver does not apply to raw URL.');
  phases.push('403-404-cursor-scope-query-injection');
  eq(await snapshot(), before, 'all GET phases no file writes/creation or mtime changes');

  // Fixture appends are outside measured GET boundary; existing cursor upper bound stays fixed.
  const refreshCursor = remaining.at(-1)!.refreshCursor!;
  const tail = JSON.stringify(entry('TAIL_COMPLETE'));
  await fs.appendFile(transcript('A'), jsonl([entry('APPENDED'), entry('LATE_OLD', 2)]) + tail.slice(0, 60));
  let frozen = await snapshot();
  const refresh = await page({ cursor: refreshCursor, refresh: 'true' });
  eq(join(refresh.items ?? []), ['APPENDED'], 'incremental refresh only newly appended correct run'); eq(refresh.pendingTail, true, 'pending JSONL tail');
  eq(await snapshot(), frozen, 'refresh did not repair/write tail');
  await fs.appendFile(transcript('A'), tail.slice(60) + '\n'); frozen = await snapshot();
  const tailPage = await page({ cursor: refresh.refreshCursor!, refresh: 'true' }); eq(join(tailPage.items ?? []), ['TAIL_COMPLETE'], 'tail complete once');
  const empty = await page({ cursor: tailPage.refreshCursor!, refresh: 'true' }); eq(empty.items, [], 'empty refresh stable');
  // Retry old snapshot after growth still excludes newly appended data.
  const old = await drain({ cursor: first.nextCursor }); eq(join(old.flatMap(p => p.items ?? [])), joined, 'old snapshot frozen during growth');
  eq(await snapshot(), frozen, 'refresh and historical cursor GET no writes');
  phases.push('fixed-upper-growth-refresh-pending-tail');

  // Scalar rereads are fresh requests, never incremental timeline refresh.
  const savedResult = a.result!; const savedPrompt = a.prompt;
  try {
    for (const view of ['delegation', 'report']) {
      const start = await page({ view }); check(start.nextCursor, `${view} source-change fixture cursor`);
      if (view === 'report') a.result = { ...savedResult, content: '' }; else a.prompt = '';
      eq((await page({ view, cursor: start.nextCursor })).state, 'unavailable', `${view} changed source rejects old cursor`);
      const reread = await page({ view }); eq(reread.state, 'complete', `${view} empty saved source is complete, not missing`);
      const content = view === 'report' ? reread.report!.content : reread.delegation!.prompt;
      eq(content.text, '', `${view} genuine empty content`); eq(content.totalChars, 0, `${view} genuine empty length`);
      if (view === 'report') eq(reread.report!.reportStatus, 'incomplete', 'empty incomplete report not upgraded to success');
      a.result = savedResult; a.prompt = savedPrompt;
    }
  } finally { a.result = savedResult; a.prompt = savedPrompt; }
  eq(await snapshot(), frozen, 'scalar source-change GETs no disk writes');
  phases.push('scalar-source-change-rejected-empty-fresh-reread');

  const liveBefore = JSON.stringify(a);
  for (const view of ['timeline', 'delegation', 'report']) {
    switchDuringRead = true;
    try {
      const race = await page({ view, ...(view === 'timeline' ? { cursor: first.nextCursor } : {}) });
      eq(switchDuringRead, false, `${view} fixture really switched during sanitizing read`);
      eq(race.state, 'unavailable', `${view} mid-read generation switch rejected`);
      for (const field of ['report', 'delegation', 'items']) check(!(field in race), `${view} no late ${field} content`);
    } finally { if (!switchDuringRead) a.runGeneration--; switchDuringRead = false; }
    eq(JSON.stringify(a), liveBefore, `${view} only fixture injected generation change`);
  }
  eq(await snapshot(), frozen, 'race rejection no disk writes');
  eq(JSON.stringify(a), initialTask, 'all phases preserve original current task');
  eq(modelCalls, 0, 'zero model calls'); eq(mutations, 0, 'zero mutation/load/bind calls');
  phases.push('mid-read-generation-guard-zero-model-zero-write');
} finally {
  (http as unknown as { createServer: Function }).createServer = originalCreateServer;
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(JSON.stringify({ ok: defects.length === 0, assertions, requests, runtimeCreations, modelCalls, mutations, phases, findings, defects, cleanup: 'HTTP closed; temporary root removed' }, null, 2));
// Fail after cleanup and full coverage, rather than silently accept a production defect.
if (defects.length) process.exitCode = 1;
