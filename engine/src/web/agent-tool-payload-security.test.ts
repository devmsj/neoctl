import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readToolCallDetail, redactToolDetail } from './tool-call-detail.js';
import type { Message } from '../types/messages.js';
import { TaskStore } from '../tasks/task-store.js';
import { createLocalAgentTask } from '../agents/local-agent-task.js';
import { createAgentContentDetailResolver } from './agent-content-detail.js';

const hidden = 'LEGACY_PRIVATE_REPORT';
const input = { task_id: 'task-safe', run_generation: 3, prompt: 'User delegation', description: 'User purpose' };
function entries(name: string, output: unknown, ok = true) {
  return [
    { type: 'message', message: { id: 'use', role: 'assistant', createdAt: '2026-09-07T00:00:00Z', blocks: [{ type: 'tool_use', id: 'call', name, input }] } },
    { type: 'message', message: { id: 'result', role: 'tool_result', createdAt: '2026-09-07T00:00:00Z', blocks: [{ type: 'tool_result', toolUseId: 'call', name, ok, output }] } },
  ] as { type: string; message: Message }[];
}
async function detail(name: string, output: unknown, ok = true, sessionDir?: string) {
  const d = await readToolCallDetail({ sessionId: 'owner', expectedSessionId: 'owner', toolUseId: 'call', entries: entries(name, output, ok), sessionDir });
  assert.ok(d); return d;
}
for (const name of ['subagent_run', 'subagent_get', 'subagent_output']) {
  test(`${name}: legacy body denied, identity/input/status retained`, async () => {
    const d = await detail(name, { ...input, status: 'completed', content: hidden, message: hidden, progress: { last_text: hidden }, result: { content: hidden }, run_history: [{ run_generation: 1, result: { content: hidden } }] }, false);
    assert.ok(!JSON.stringify(d).includes(hidden));
    const data = JSON.parse(d.result.text);
    assert.equal(data.task_id, input.task_id); assert.equal(data.run_generation, 3);
    assert.equal(data.status, 'completed'); assert.equal(data.prompt, input.prompt);
    assert.equal(JSON.parse(d.input.text).description, input.description);
    assert.notEqual(d.result.state, 'complete'); assert.match(d.result.reason, /来源|provenance/);
  });
}
for (const output of [hidden, JSON.stringify(hidden), JSON.stringify({ result: { content: hidden } }), `<output>${hidden}</output>`]) {
  test(`legacy plain/XML/serialized body rejected: ${output.slice(0, 20)}`, async () => {
    const d = await detail('subagent_output', output, false);
    assert.ok(!JSON.stringify(d).includes(hidden)); assert.notEqual(d.result.state, 'complete');
  });
}
test('protocol XML preserves fixed task/run header, not report/error body', async () => {
  const xml = `<retrieval_status>ready</retrieval_status>\n<task_id>task-safe</task_id>\n<task_type>local_agent</task_type>\n<status>failed</status>\n<run_generation>3</run_generation>\n<pending_messages>0</pending_messages>\n<requires_resume>false</requires_resume>\n<agent_id>agent-safe</agent_id>\n<output>${hidden}</output>\n<error>${hidden}</error>`;
  const d = await detail('subagent_output', xml);
  assert.ok(!JSON.stringify(d).includes(hidden));
  const data = JSON.parse(d.result.text); assert.equal(data.task_id, 'task-safe'); assert.equal(String(data.run_generation), '3');
});
test('valid provenance is local to content, not siblings/previous generation', async () => {
  for (const displaySource of ['agent_report', 'visible_text']) {
    const d = await detail('subagent_get', { task_id: 'task-safe', run_generation: 3, content: hidden, result: { displaySource, content: 'PUBLIC REPORT', status: 'incomplete', message: hidden }, run_history: [{ result: { content: hidden } }] });
    assert.ok(d.result.text.includes('PUBLIC REPORT')); assert.ok(!JSON.stringify(d).includes(hidden));
    const direct = await detail('subagent_run', { displaySource, content: 'PUBLIC REPORT', status: 'completed' });
    assert.equal(direct.result.state, 'complete'); assert.ok(direct.result.text.includes('PUBLIC REPORT'));
  }
});
test('control-tool failure reason and delivery facts are not report prose', async () => {
  const output = { task_id: 'task-safe', run_generation: 3, status: 'failed', delivery_status: 'not_queued', pending_messages: 0, error: 'Unknown task task-safe', message: 'Message was not queued' };
  const d = await detail('subagent_message', output, false);
  assert.equal(d.error.text, output.error); assert.deepEqual(JSON.parse(d.result.text), redactToolDetail(output));
});
test('non-agent tools retain ordinary content', async () => {
  const d = await detail('file_read', { content: hidden }); assert.ok(d.result.text.includes(hidden)); assert.equal(d.result.state, 'complete');
});
test('persisted result is filtered after reference restoration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-payload-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'tool-results')); const file = path.join(dir, 'tool-results', 'call.json');
  await fs.writeFile(file, JSON.stringify({ task_id: 'task-safe', result: { content: hidden } }));
  const d = await detail('subagent_get', `<persisted-output>\nFull output saved to: ${file}\n${hidden}`, true, dir);
  assert.ok(!JSON.stringify(d).includes(hidden)); assert.equal(JSON.parse(d.result.text).task_id, 'task-safe'); assert.notEqual(d.result.state, 'complete');
});

for (const persisted of [false, true]) {
  test(`agent tool timeline shares provenance boundary (persisted=${persisted})`, async t => {
    const ownerDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-payload-timeline-')));
    const store = new TaskStore();
    const task = createLocalAgentTask({ taskId: 'task-safe', agentId: 'agent-safe', prompt: 'User delegation', description: 'User purpose' });
    task.runGeneration = 3; store.attachTask(task, ownerDir);
    t.after(async () => { store.flush(); await fs.rm(ownerDir, { recursive: true, force: true }); });
    const child = path.join(ownerDir, 'subagents', task.agentId);
    await fs.mkdir(path.join(child, 'tool-results'), { recursive: true });
    const value = { task_id: 'nested-task', run_generation: 2, result: { content: hidden }, run_history: [{ result: { displaySource: 'agent_report', content: 'PUBLIC ARCHIVE' } }] };
    const file = path.join(child, 'tool-results', 'call.json');
    await fs.writeFile(file, JSON.stringify(value));
    const output = persisted ? `<persisted-output>\nFull output saved to: ${file}\n${hidden}` : value;
    const rows = entries('subagent_get', output).map(e => ({ ...e, sessionId: task.agentId, agentId: task.agentId, runGeneration: 3 }));
    await fs.writeFile(path.join(child, 'transcript.jsonl'), rows.map(e => JSON.stringify(e) + '\n').join(''));
    const resolver = createAgentContentDetailResolver();
    const page = await resolver.timeline({ ownerSessionId: 'owner', ownerSessionDir: ownerDir, taskStore: store, redact: value => value }, { taskId: task.taskId, runGeneration: 3, pageChars: 16000 });
    assert.notEqual(page.state, 'unavailable', page.reason);
    assert.ok(!JSON.stringify(page).includes(hidden));
    const item = page.items?.find(i => i.kind === 'tool_result'); assert.ok(item);
    assert.equal(item.content.state, 'unavailable');
    const data = JSON.parse(item.content.text); assert.equal(data.task_id, 'nested-task'); assert.equal(data.run_generation, 2);
    assert.ok(item.content.text.includes('PUBLIC ARCHIVE'));
  });
}

test('top-level structured agent failures remain readable, nested report errors do not', async () => {
  for (const name of ['subagent_get', 'subagent_run', 'subagent_output']) {
    const d = await detail(name, { task_id: 'task-safe', error: 'Unknown task or provider failure', result: { error: hidden } }, false);
    assert.equal(d.error.text, 'Unknown task or provider failure');
    assert.ok(!JSON.stringify(d).includes(hidden));
  }
});
