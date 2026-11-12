import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QueryEngine } from '../../src/core/query-engine.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { streamWithRetry } from '../../src/model/retry-runner.js';
import { createTextMessage } from '../../src/types/messages.js';
import type { ModelGateway, ModelStreamEvent } from '../../src/model/model-gateway.js';
import type { AgentEvent } from '../../src/types/events.js';

function engine(gateway: ModelGateway, tools = new ToolRegistry(), rootDir?: string) {
  return new QueryEngine({ model: 'gpt-5', contextWindowTokensOverride: 100000, tools, modelGateway: gateway,
    compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    contextManager: { async build() { return { systemPrompt: 'test', promptSections: [], userContext: {}, systemContext: { cwd: "test", platform: "win32" } }; } },
    session: rootDir ? { rootDir, sessionId: 'test', enabled: true } : { enabled: false },
  });
}
async function drain(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const e of source) events.push(e); return events; }
const terminal = (events: AgentEvent[]) => [...events].reverse().find(e => e.type === 'terminal')?.reason;

test('retry discards partial text/thinking/tools and executes only the successful batch once', async () => {
  let attempts = 0, turns = 0, executions = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'probe', description: 'test', inputSchema: { type: 'object' }, metadata: { readOnly: true, concurrent: true, visible: true }, async call() { executions++; return { ok: true, output: 'ok' }; } });
  const e = engine({ stream() {
    if (++turns > 1) return (async function* (): AsyncIterable<ModelStreamEvent> { yield { type: 'assistant_message', message: createTextMessage('assistant', 'finished') }; })();
    return streamWithRetry(async function* () {
      attempts++;
      yield { type: 'assistant_delta', text: attempts === 1 ? 'BAD_DRAFT' : 'GOOD_DRAFT', displayChannel: 'visible' };
      yield { type: 'thinking_delta', text: attempts === 1 ? 'BAD_THINKING' : 'GOOD_THINKING' };
      yield { type: 'tool_call_started', callId: `t${attempts}`, name: 'probe' };
      yield { type: 'tool_use', toolUse: { id: `t${attempts}`, name: 'probe', input: { description: "Run the test probe" } } };
      if (attempts === 1) throw new Error('reset');
      yield { type: 'response_completed' };
    }, { provider: 'test', delayMs: 0, maxRetries: 1 });
  } }, tools);
  const events = await drain(e.sendUserText('test'));
  assert.equal(terminal(events), 'completed'); assert.equal(executions, 1); assert.equal(attempts, 2);
  const history = JSON.stringify(e.getHistoryMessages());
  assert(!history.includes('BAD_DRAFT')); assert(!history.includes('BAD_THINKING')); assert(!history.includes('"id":"t1"'));
  assert(history.includes('GOOD_DRAFT')); assert(history.includes('GOOD_THINKING'));
  assert.equal(events.filter(e => e.type === 'tool_call.ready').length, 1);
});

test('settled tool is persisted before available event and survives cancellation/reload without duplicates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-tool-settlement-'));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  try {
    const tools = new ToolRegistry();
    tools.register({ name: 'probe', description: 'test', inputSchema: { type: 'object' }, metadata: { readOnly: true, concurrent: true, visible: true }, async call(_input, ctx) {
      if (ctx.toolUseId === 'slow') await gate;
      return { ok: true, output: ctx.toolUseId };
    } });
    const gateway: ModelGateway = { async *stream() { for (const id of ['fast', 'slow']) yield { type: 'tool_use', toolUse: { id, name: 'probe', input: { description: "Run the test probe" } } }; yield { type: 'response_completed' }; } };
    const e = engine(gateway, tools, root), controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of e.sendUserText('test', { abortSignal: controller.signal })) {
      events.push(event);
      if (event.type === 'tool.result.available' && event.toolUse.id === 'fast') {
        assert.equal(e.getHistoryMessages().flatMap(m => m.blocks).filter(b => b.type === 'tool_result' && b.toolUseId === 'fast').length, 1);
        controller.abort();
      }
    }
    release();
    assert.equal(terminal(events), 'aborted_tools');
    assert.equal(e.getHistoryMessages().flatMap(m => m.blocks).filter(b => b.type === 'tool_result' && b.toolUseId === 'fast').length, 1);
    const { SessionStore } = await import('../../src/session/session-store.js');
    const store = await SessionStore.open({ rootDir: root, agentId: 'main', sessionId: 'test', resume: true });
    assert.equal(store.getInitialMessages().flatMap(m => m.blocks).filter(b => b.type === 'tool_result' && b.toolUseId === 'fast').length, 1);
    await store.flushResumeCache();
  } finally { release(); await fs.rm(root, { recursive: true, force: true }); }
});

test('repeated output limit does not report success; continuation without response ID retains input', async () => {
  let calls = 0;
  const e = engine({ async *stream(request) {
    calls++;
    if (calls === 2) { assert(JSON.stringify(request.messages).includes('ORIGINAL_INPUT')); assert.equal(request.previousResponseId, undefined); }
    yield { type: 'assistant_message', message: createTextMessage('assistant', 'partial') };
    yield { type: 'response_incomplete', reason: 'max_output_tokens' };
  } });
  const events = await drain(e.sendUserText('ORIGINAL_INPUT'));
  assert.equal(calls, 2); assert.equal(terminal(events), 'model_error');
});

test('pause_turn continues once with current history, never reports a second pause as success', async () => {
  let calls = 0;
  const e = engine({ async *stream() { calls++; yield { type: 'assistant_message', message: createTextMessage('assistant', 'paused') }; yield { type: 'response_completed', stopReason: 'pause_turn' }; } });
  const events = await drain(e.sendUserText('test')); assert.equal(calls, 2); assert.equal(terminal(events), 'model_error');
});

test('pause during retry countdown sends no second request', async () => {
  let calls = 0; const controller = new AbortController();
  const e = engine({ stream() { return streamWithRetry(async function* () { calls++; yield { type: 'response_started', responseId: 'r' }; throw new Error('reset'); }, { provider: 'test', signal: controller.signal }); } });
  const events: AgentEvent[] = [];
  for await (const event of e.sendUserText('test', { abortSignal: controller.signal })) { events.push(event); if (event.type === 'retrying') controller.abort(); }
  assert.equal(calls, 1); assert.equal(terminal(events), 'aborted_streaming');
});


test('parallel settlement order matches persisted history and the next model input', async () => {
  const tools = new ToolRegistry(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  tools.register({ name: 'probe', description: 'test', inputSchema: { type: 'object' }, metadata: { readOnly: true, concurrent: true, visible: true }, async call(_input, ctx) {
    if (ctx.toolUseId === 'first') await gate;
    return { ok: true, output: ctx.toolUseId };
  } });
  let turns = 0; let nextOrder: string[] = [];
  const e = engine({ async *stream(request) {
    if (++turns === 1) {
      for (const id of ['first', 'second']) yield { type: 'tool_use', toolUse: { id, name: 'probe', input: { description: "Run the test probe" } } };
    } else nextOrder = request.messages.flatMap(m => m.blocks).filter(b => b.type === 'tool_result').map(b => b.toolUseId);
    yield { type: 'response_completed' };
  } }, tools);
  for await (const event of e.sendUserText('test')) if (event.type === 'tool.result.available' && event.toolUse.id === 'second') release();
  const historyOrder = e.getHistoryMessages().flatMap(m => m.blocks).filter(b => b.type === 'tool_result').map(b => b.toolUseId);
  assert.deepEqual(nextOrder, ['second', 'first']); assert.deepEqual(historyOrder, nextOrder);
});

test('retry exhaustion preserves last draft as interrupted, never executes buffered calls', async () => {
  let attempts = 0, executed = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'probe', description: 'test', inputSchema: { type: 'object' }, metadata: { readOnly: true, concurrent: true, visible: true }, async call() { executed++; return { ok: true, output: 'ok' }; } });
  const e = engine({ stream() { return streamWithRetry(async function* () {
    attempts++; yield { type: 'assistant_delta', text: `LAST_${attempts}`, displayChannel: 'visible' };
    yield { type: 'tool_use', toolUse: { id: `t${attempts}`, name: 'probe', input: { description: "Run the test probe" } } };
    throw new Error('reset');
  }, { provider: 'test', maxRetries: 2, delayMs: 0 }); } }, tools);
  const events = await drain(e.sendUserText('test'));
  assert.equal(attempts, 3); assert.equal(executed, 0); assert.equal(terminal(events), 'model_error');
  assert.equal(e.getExecutionState()?.status, 'interrupted');
  const history = JSON.stringify(e.getHistoryMessages()); assert(history.includes('LAST_3')); assert(!history.includes('LAST_1'));
});
