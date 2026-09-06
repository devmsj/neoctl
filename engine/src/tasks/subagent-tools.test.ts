import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalAgentTask } from '../agents/local-agent-task.js';
import { TaskStore } from './task-store.js';
import { createSubagentGetTool, createSubagentListTool, createSubagentMessageTool, createSubagentOutputTool, createSubagentStopTool, createSubagentResumeTool } from './subagent-tools.js';
import type { Tool, ToolUseContext } from '../tools/tool.js';

const call = async (tool: Tool<any>, input: unknown) => tool.call!(input, {} as ToolUseContext, {});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'neo-task-tools-'));
  const store = new TaskStore();
  const task = createLocalAgentTask({ taskId: 'task-test', agentId: 'agent-test', description: 'task', prompt: 'PRIVATE_PROMPT'.repeat(1000), outputFile: join(dir, 'task.txt') });
  store.upsert(task);
  return { store, task, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('default get/list are bounded and omit full prompt/result/usage; detail remains explicit', async () => {
  const f = fixture();
  try {
    f.task.status = 'completed';
    f.task.result = { agent_id: f.task.agentId, agent_type: 'test', content: 'LARGE_RESULT'.repeat(10000), total_duration_ms: 10, total_tool_use_count: 1, usage: { raw: 'USAGE'.repeat(10000) } };
    f.task.progress.lastText = 'x'.repeat(10000);
    const get = await call(createSubagentGetTool(f.store), { task_id: f.task.id });
    const summary = get.output as Record<string, any>;
    assert.equal(summary.run_generation, 1);
    assert.equal(summary.result_available, true);
    assert.equal(summary.prompt, undefined);
    assert.equal(summary.result, undefined);
    assert.ok(JSON.stringify(summary).length < 2500);
    const list = await call(createSubagentListTool(f.store), {});
    assert.ok(JSON.stringify(list.output).length < 2600);
    const detail = await call(createSubagentGetTool(f.store), { task_id: f.task.id, detail: true });
    assert.equal((detail.output as any).result.content, f.task.result.content);
    assert.equal((detail.output as any).prompt, f.task.prompt);
  } finally { f.cleanup(); }
});

test('running output never mistakes legacy previous result for current completion', async () => {
  const f = fixture();
  try {
    f.task.status = 'running'; f.task.runGeneration = 2;
    f.task.result = { agent_id: f.task.agentId, agent_type: 'test', content: 'OLD_COMPLETION', total_duration_ms: 1, total_tool_use_count: 0 };
    f.task.progress.lastText = 'current <progress>';
    const output = await call(createSubagentOutputTool(f.store), { task_id: f.task.id });
    assert.match(String(output.output), /<retrieval_status>not_ready/);
    assert.match(String(output.output), /<run_generation>2/);
    assert.match(String(output.output), /current &lt;progress&gt;/);
    assert.doesNotMatch(String(output.output), /OLD_COMPLETION/);
    const detail = await call(createSubagentGetTool(f.store), { task_id: f.task.id, detail: true });
    assert.equal((detail.output as any).result, undefined);
    assert.equal(f.task.notified, false);
  } finally { f.cleanup(); }
});

test('pending tasks are queued, terminal tasks explicitly require resume, never imply implementation', async () => {
  const f = fixture();
  try {
    for (const status of ['pending', 'running', 'completed', 'failed', 'killed'] as const) {
      f.task.status = status;
      const result = await call(createSubagentMessageTool(f.store), { target: f.task.agentId, message: 'extra requirement' });
      const output = result.output as any;
      const terminal = ['completed', 'failed', 'killed'].includes(status);
      assert.equal(output.status, terminal ? 'queued_for_resume' : 'queued');
      assert.equal(output.requires_resume, terminal);
      assert.equal(output.delivery_status, 'queued');
      assert.equal(typeof output.message_id, 'string');
      assert.ok(output.queued_at);
      assert.match(output.note, /not proof of implementation/);
    }
    assert.equal(f.task.pendingMessages.length, 5);
    f.task.status = 'running';
    f.store.deliverPendingMessages(f.task.id, f.task.runGeneration);
    const summary = (await call(createSubagentGetTool(f.store), { task_id: f.task.id })).output as any;
    assert.equal(summary.message_delivery.queued, 0);
    assert.equal(summary.message_delivery.delivered_this_run_retained, 5);
    assert.equal(summary.message_delivery.recent.length, 5);
    assert.equal(summary.message_delivery.recent[0].status, 'delivered');
    assert.equal(JSON.stringify(summary).includes('extra requirement'), false);
  } finally { f.cleanup(); }
});

test('calling parent scope survives A to B foreground switch without granting B or child access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'neo-task-scope-'));
  const a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const store = new TaskStore();
  const context = (dir?: string, isSubagent = false) => ({
    isSubagent, session: dir ? { sessionId: dir, sessionDir: dir } : undefined,
  }) as ToolUseContext;
  const invoke = (tool: Tool<any>, input: unknown, ctx = context(a)) => tool.call!(input, ctx, {});
  const make = (dir: string, id: string) => {
    store.bindSession(dir);
    const task = createLocalAgentTask({ taskId: `task-${id}`, agentId: `child-${id}`, description: id, prompt: id, outputFile: join(dir, 'output.txt') });
    store.upsert(task); store.registerName('worker', task.agentId); store.markRunning(task.id);
    return task;
  };
  try {
    const ta = make(a, 'a'), tb = make(b, 'b');
    const list = await invoke(createSubagentListTool(store), {});
    assert.deepEqual((list.output as any).tasks.map((task: any) => task.task_id), [ta.id]);
    assert.equal((await invoke(createSubagentGetTool(store), { task_id: ta.id })).ok, true);
    for (const tool of [createSubagentGetTool(store), createSubagentOutputTool(store), createSubagentStopTool(store)]) {
      assert.equal((await invoke(tool, { task_id: tb.id })).ok, false);
    }
    assert.equal((await invoke(createSubagentMessageTool(store), { target: 'worker', message: 'only A' })).ok, true);
    assert.equal(ta.pendingMessages.length, 1);
    assert.equal(tb.pendingMessages.length, 0);
    assert.equal((await invoke(createSubagentMessageTool(store), { target: tb.agentId, message: 'wrong owner' })).ok, false);
    assert.equal(store.activeSessionDir, b, 'tools must not switch global active view');

    const waiting = invoke(createSubagentOutputTool(store), { task_id: ta.id, block: true, timeout_ms: 1000 });
    store.bindSession(a); store.bindSession(b);
    store.fail(ta.id, 'A result');
    const output = await waiting;
    assert.equal(output.ok, true);
    assert.match(String(output.output), /A result/);
    assert.equal(ta.notified, true);
    assert.equal(tb.notified, false);

    let resumed = 0;
    const resume = createSubagentResumeTool(store, async () => { resumed++; return { ok: true }; });
    assert.equal((await invoke(resume, { task_id: ta.id })).ok, false, 'legacy foreground-bound handler rejected for detached A');
    store.fail(tb.id, 'B result');
    assert.equal((await invoke(resume, { task_id: tb.id })).ok, false, 'A cannot resume B');
    assert.equal(resumed, 0);
    store.bindSession(a);
    assert.equal((await invoke(resume, { task_id: ta.id })).ok, true);
    assert.equal(resumed, 1);
    const child = context(join(a, 'subagents', ta.agentId), true);
    assert.deepEqual((await invoke(createSubagentListTool(store), {}, child)).output, { tasks: [] });
    assert.equal((await invoke(createSubagentGetTool(store), { task_id: ta.id }, child)).ok, false);
    assert.equal((await invoke(createSubagentMessageTool(store), { target: ta.agentId, message: 'no parent escalation' }, child)).ok, false);
    assert.equal((await invoke(resume, { task_id: ta.id }, child)).ok, false);
    assert.equal((await invoke(resume, { task_id: ta.id }, { ...context(a), agentType: 'fork' })).ok, false);
    assert.equal(resumed, 1);
    assert.deepEqual((await invoke(createSubagentListTool(store), {}, context())).output, { tasks: [] }, 'missing context is unowned, not active');
    store.markRunning(ta.id);
    store.bindSession(b);
    assert.equal((await invoke(createSubagentStopTool(store), { task_id: ta.id })).ok, true);
    assert.equal(ta.status, 'killed', 'detached A can stop its own running child');
    assert.equal(tb.status, 'failed');
    assert.equal(store.activeSessionDir, b);
  } finally { store.flush(); rmSync(root, { recursive: true, force: true }); }
});
