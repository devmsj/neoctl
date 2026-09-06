import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAgentTools } from '../core/run-agent.js';
import { GENERAL_PURPOSE_AGENT, FORK_AGENT, EXPLORE_AGENT } from './agent-definition.js';
import { createAgentTool, resumeAgentTask, type AgentToolRuntime } from './agent-tool.js';
import { createSubagentResumeTool } from '../tasks/subagent-tools.js';
import { TaskStore } from '../tasks/task-store.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolUseContext } from '../tools/tool.js';

test('all child agent definitions exclude run/resume, even explicit or wildcard allowlists', () => {
  const parent = new ToolRegistry();
  parent.register(createAgentTool());
  parent.register(createSubagentResumeTool());
  for (const agent of [GENERAL_PURPOSE_AGENT, FORK_AGENT, EXPLORE_AGENT, { ...GENERAL_PURPOSE_AGENT, tools: ['*'], disallowedTools: [] }, { ...GENERAL_PURPOSE_AGENT, tools: ['subagent_run', 'subagent_resume'] }]) {
    const child = resolveAgentTools(parent, agent);
    assert.equal(child.get('subagent_run'), undefined);
    assert.equal(child.get('subagent_resume'), undefined);
    assert.ok(child.get('subagent_report'));
  }
  assert.ok(parent.get('subagent_run'));
  assert.ok(parent.get('subagent_resume'));
});

test('runtime rejects nested delegation in every mode and resume before launching work', async () => {
  const store = new TaskStore();
  const runtime = { taskStore: store } as AgentToolRuntime;
  const context = { isSubagent: true, agentId: 'child', messages: [] } as unknown as ToolUseContext;
  for (const mode of [undefined, 'sync', 'background', 'fork', 'explore'] as const) {
    const result = await createAgentTool(runtime).call!({ prompt: 'nested', mode, subagent_type: 'general-purpose' }, context, {});
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.output), /cannot delegate/);
  }
  let invoked = false;
  const result = await createSubagentResumeTool(store, async () => { invoked = true; return { ok: true }; }).call!({ task_id: 'any' }, context, {});
  assert.equal(result.ok, false); assert.equal(invoked, false);
  assert.equal((await resumeAgentTask('any', undefined, runtime, store, context)).ok, false);
  assert.equal(store.list().length, 0);
});
