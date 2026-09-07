import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskStore } from '../tasks/task-store.js';
import { createLocalAgentTask } from '../agents/local-agent-task.js';
import { createAgentContentDetailResolver } from './agent-content-detail.js';
import { createTextMessage } from '../types/messages.js';

test('parent messages: queued, delivered in durable log, resume, pagination and owner isolation', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neo-parent-messages-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore();
  const task = createLocalAgentTask({ taskId: 'parent-messages', agentId: 'child', prompt: 'task', description: 'test' });
  task.runGeneration = 2;
  store.attachTask(task, root);
  const queued = createTextMessage('user', '待处理消息😀'.repeat(200));
  const delivered = createTextMessage('user', '主代理已发送的消息');
  const inherited = createTextMessage('user', 'INHERITED_NOT_A_MESSAGE');
  const resumed = createTextMessage('user', '继续检查示例');
  resumed.metadata = { agentMessageKind: 'resume' };
  task.pendingMessages = [queued];
  task.messages = [inherited];
  task.messageReceipts = [
    { id: 'r1', messageId: delivered.id, status: 'delivered', queuedAt: '2026-09-07T00:00:00Z', runGeneration: 2 },
    { id: 'r2', messageId: queued.id, status: 'queued', queuedAt: '2026-09-07T00:00:02Z', runGeneration: 2 },
  ];
  const entries = [delivered, inherited, resumed].map(message => ({ type: 'message', sessionId: task.agentId, agentId: task.agentId, runGeneration: 2, message }));
  const file = path.join(root, 'subagents', task.agentId, 'transcript.jsonl');
  await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const before = await fs.readFile(file, 'utf8');
  const owner = { ownerSessionId: 'owner', ownerSessionDir: root, taskStore: store, redact: (v: unknown) => v };
  const reader = createAgentContentDetailResolver();
  let cursor: string | undefined; let text = ''; let pages = 0;
  do {
    const page = await reader.messages(owner, { taskId: task.id, runGeneration: 2, pageChars: 256, cursor });
    assert.notEqual(page.state, 'unavailable', page.reason);
    text += page.messages!.content.text; cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.ok(pages > 1);
  const result = JSON.parse(text);
  assert.equal(result.length, 3);
  assert.ok(result.some((m: { text: string; status: string }) => m.text === delivered.blocks.filter(b => b.type === 'text').map(b => b.text).join('') && m.status === 'delivered'));
  assert.ok(result.some((m: { text: string; status: string }) => m.text.includes('待处理消息') && m.status === 'queued'));
  assert.ok(result.some((m: { text: string }) => m.text === '继续检查示例'));
  assert.ok(!text.includes('INHERITED_NOT_A_MESSAGE'));
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(task.pendingMessages.length, 1);
  const wrongOwner = await reader.messages({ ...owner, ownerSessionDir: path.join(root, 'other') }, { taskId: task.id, runGeneration: 2 });
  assert.equal(wrongOwner.state, 'missing');
  const old = await reader.messages(owner, { taskId: task.id, runGeneration: 1 });
  assert.deepEqual(JSON.parse(old.messages!.content.text), []);
});
