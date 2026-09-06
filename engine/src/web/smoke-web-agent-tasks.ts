import assert from 'node:assert/strict';
import { createLocalAgentTask, type AgentToolResult } from '../agents/local-agent-task.js';
import { WebRepl, type WebRuntime } from './index.js';

const task = createLocalAgentTask({ taskId: 'task_ui', agentId: 'agent_ui', description: 'UI regression', prompt: 'private prompt' });
task.status = 'running';
task.runGeneration = 2;
const result: AgentToolResult = { agent_id: task.agentId, agent_type: 'general', content: 'old report', total_duration_ms: 0, total_tool_use_count: 0, usage: { secret: 'private usage' } };
task.result = result;
task.runHistory = [{ runGeneration: 1, status: 'completed', result, progress: task.progress, archivedAt: new Date().toISOString() }];
const tasks = [task];
const runtime = {
  taskStore: { list: () => tasks, subscribe: () => () => undefined, isTerminal: (value: typeof task) => ['completed', 'failed', 'killed'].includes(value.status) },
  execProcessManager: { list: () => [], subscribe: () => () => undefined, subscribeOutput: () => () => undefined },
  engine: { getDisplayEntries: () => [], getHistoryMessages: () => [], snapshot: () => ({ messages: 0, session: { sessionId: 'ui-smoke' } }), isFastMode: () => false, getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => undefined },
  initialMetrics: {},
} as unknown as WebRuntime;
const repl = new WebRepl(runtime);
const snapshot = () => repl.snapshot() as { backgroundTaskCount: number; backgroundTasks: any[]; agentTaskHistory: any[] };
let view = snapshot();
assert.equal(view.backgroundTaskCount, 1);
assert.equal(view.backgroundTasks[0].runGeneration, 2);
assert.equal(view.backgroundTasks[0].result, undefined);
assert.equal(view.backgroundTasks[0].runHistory[0].result.content, 'old report');
assert.equal(JSON.stringify(view.backgroundTasks).includes('private prompt'), false);
assert.equal(JSON.stringify(view.backgroundTasks).includes('private usage'), false);
task.status = 'completed';
task.result = { ...result, content: 'current report' };
view = snapshot();
assert.equal(view.backgroundTaskCount, 0);
assert.equal(view.agentTaskHistory[0].result.content, 'current report');
task.result = { ...result, content: 'x'.repeat(10000) };
task.runGeneration = 6;
task.runHistory = Array.from({length: 5}, (_, i) => ({ runGeneration: i + 1, status: 'completed', result: task.result, progress: task.progress, archivedAt: task.updatedAt }));
task.messageReceipts = Array.from({length: 128}, (_, i) => ({ id: `receipt_${i}`, messageId: `message_${i}`, status: 'delivered', queuedAt: task.createdAt, deliveredAt: task.updatedAt, runGeneration: 6 }));
task.progress.lastActivity = '2026-01-01T00:00:00.000Z';
const compact = snapshot().agentTaskHistory[0];
assert.equal(compact.result.content.length, 1500);
assert.equal(compact.result.truncated, true);
assert.equal(compact.runHistory.length, 3);
assert.equal(compact.runHistory[0].result.content.length, 600);
assert.equal(compact.runHistory[0].result.truncated, true);
assert.equal(compact.messageReceipts.length, 20);
assert.equal(compact.deliveredRetainedThisRun, 128);
assert.equal(compact.progress.lastActivity, task.progress.lastActivity);
assert.ok(JSON.stringify(compact).length < 10000);
for (let i = 0; i < 25; i++) tasks.push({ ...task, id: `task_${i}`, taskId: `task_${i}` });
assert.equal(snapshot().agentTaskHistory.length, 20);
console.log('web agent tasks smoke ok: active/history split, generation, stale result suppression, bounded projection, no prompt/usage');
