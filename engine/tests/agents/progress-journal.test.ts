import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalAgentTask, updateProgressFromEvent, updateProgressFromMessage } from '../../src/agents/local-agent-task.js';
import { TaskStore } from '../../src/tasks/task-store.js';
import { loadTasks, persistTask } from '../../src/tasks/task-persistence.js';
import { createSubagentGetTool, createSubagentListTool } from '../../src/tasks/subagent-tools.js';
import type { ToolUseContext } from '../../src/tools/tool.js';
import type { Message } from '../../src/types/messages.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'neo-progress-'));
  const store = new TaskStore();
  store.bindSession(dir);
  const task = createLocalAgentTask({ taskId: 'task-p', agentId: 'agent-p', description: 'p', prompt: 'p', outputFile: join(dir, 'tasks', 'task-p.txt') });
  store.upsert(task);
  store.markRunning(task.taskId);
  const ctx = (isSubagent = false) => ({ isSubagent, session: { sessionId: dir, sessionDir: dir } }) as ToolUseContext;
  return { dir, store, task, ctx, cleanup: () => { store.flush(); rmSync(dir, { recursive: true, force: true }); } };
}

const toolResult = (task: any, name: string, ok: boolean, description?: string) => updateProgressFromEvent(task,
  { type: 'tool.result.available', toolUse: { id: `${name}-${Math.random()}`, name, input: { description } }, ok } as any, task.runGeneration);

const report = (text: string, status = 'draft'): Message => ({ id: `m-${Math.random()}`, role: 'tool_result', createdAt: new Date().toISOString(),
  blocks: [{ type: 'tool_result', toolUseId: 'r', name: 'subagent_report', ok: true, output: { report: text, status } } as any] });

test('ordinary tool churn is tallied, never pushed; reports and failures are pushed exactly once', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 200; i += 1) toolResult(f.task, 'file_read', true);
    f.store.updateProgress(f.task);
    assert.deepEqual(f.store.collectProgressUpdates(f.dir), [], '200 successful calls must not wake the main agent');

    updateProgressFromMessage(f.task, report('Step 1 done; next: step 2'));
    toolResult(f.task, 'terminal_run', false, 'Run unit tests');
    f.store.updateProgress(f.task);
    const [update, ...rest] = f.store.collectProgressUpdates(f.dir);
    assert.equal(rest.length, 0);
    assert.match(update.content, /report \(draft\): Step 1 done; next: step 2/);
    assert.match(update.content, /file_read×200/);
    assert.match(update.content, /latest failure: terminal_run — Run unit tests/);
    assert.ok(update.content.length < 400, 'a 200-call burst stays one compact line');
    assert.deepEqual(f.store.collectProgressUpdates(f.dir), [], 'consumed updates never repeat');

    toolResult(f.task, 'file_read', true);
    updateProgressFromMessage(f.task, report('Step 2 done'));
    const [next] = f.store.collectProgressUpdates(f.dir);
    assert.doesNotMatch(next.content, /Step 1/);
    assert.match(next.content, /file_read×1\b/);
  } finally { f.cleanup(); }
});

test('main-agent reads consume; subagent reads and list never hide updates', async () => {
  const f = fixture();
  try {
    updateProgressFromMessage(f.task, report('milestone A'));
    f.store.updateProgress(f.task);
    const list = (await createSubagentListTool(f.store).call!({}, f.ctx(), {})).output as any;
    assert.equal(list.tasks[0].has_new_report, true);
    const peek = (await createSubagentGetTool(f.store).call!({ task_id: f.task.taskId }, f.ctx(true), {})).output as any;
    assert.match(peek.progress.since_last_check, /milestone A/);
    const read = (await createSubagentGetTool(f.store).call!({ task_id: f.task.taskId }, f.ctx(), {})).output as any;
    assert.match(read.progress.since_last_check, /milestone A/);
    const again = (await createSubagentGetTool(f.store).call!({ task_id: f.task.taskId }, f.ctx(), {})).output as any;
    assert.match(again.progress.since_last_check, /No change since your last check/);
    assert.deepEqual(f.store.collectProgressUpdates(f.dir), [], 'an explicit read already delivered it');
  } finally { f.cleanup(); }
});

test('wait_ms resolves on the next milestone instead of polling, and on timeout', async () => {
  const f = fixture();
  try {
    const started = Date.now();
    const pending = createSubagentGetTool(f.store).call!({ task_id: f.task.taskId, wait_ms: 5000 }, f.ctx(), {});
    setTimeout(() => { toolResult(f.task, 'file_read', true); f.store.updateProgress(f.task); }, 20);
    setTimeout(() => { updateProgressFromMessage(f.task, report('woke')); f.store.updateProgress(f.task); }, 60);
    const output = (await pending).output as any;
    assert.match(output.progress.since_last_check, /woke/);
    assert.ok(Date.now() - started < 2000);
    const idle = Date.now();
    const timedOut = (await createSubagentGetTool(f.store).call!({ task_id: f.task.taskId, wait_ms: 50 }, f.ctx(), {})).output as any;
    assert.ok(Date.now() - idle >= 40);
    assert.match(timedOut.progress.since_last_check, /No change/);
  } finally { f.cleanup(); }
});

test('journal and read cursor survive restart; a resumed run starts a fresh journal', () => {
  const f = fixture();
  try {
    updateProgressFromMessage(f.task, report('before restart'));
    f.store.updateProgress(f.task);
    assert.equal(f.store.collectProgressUpdates(f.dir).length, 1);
    updateProgressFromMessage(f.task, report('unread'));
    persistTask(f.task);
    const loaded = loadTasks(f.dir).tasks.find((task) => task.taskId === f.task.taskId)!;
    assert.equal(loaded.progress.journal?.milestones.length, 2);
    const restored = new TaskStore();
    restored.bindSession(f.dir);
    restored.upsert({ ...loaded, status: 'running' } as any, { persist: false });
    const [update] = restored.collectProgressUpdates(f.dir);
    assert.match(update.content, /unread/);
    assert.doesNotMatch(update.content, /before restart/);

    f.store.complete(f.task.taskId, { agent_id: f.task.agentId, agent_type: 't', content: 'done', total_duration_ms: 1, total_tool_use_count: 0 } as any);
    f.store.markNotified(f.task.taskId);
    f.store.prepareResume(f.task.taskId, new AbortController());
    f.store.markRunning(f.task.taskId, f.task.runGeneration);
    updateProgressFromMessage(f.task, report('second run'));
    f.store.updateProgress(f.task);
    const [resumed] = f.store.collectProgressUpdates(f.dir);
    assert.match(resumed.content, /second run/);
    assert.doesNotMatch(resumed.content, /unread|before restart/);
  } finally { f.cleanup(); }
});
