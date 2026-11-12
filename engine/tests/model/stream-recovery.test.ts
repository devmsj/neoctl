import { createServer } from "node:http";
import { once } from "node:events";
import { OpenAIAdapter } from "../../src/model/openai-adapter.js";
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResponsesStream } from '../../src/model/openai-responses-mapper.js';
import { normalizeChatStream } from '../../src/model/openai-chat-mapper.js';
import { normalizeAnthropicStream } from '../../src/model/anthropic-mapper.js';
import { streamWithRetry } from '../../src/model/retry-runner.js';
import { ModelAPIError } from '../../src/model/errors.js';
import type { ModelStreamEvent } from '../../src/model/model-gateway.js';

const encoder = new TextEncoder();
const created = { type: 'response.created', response: { id: 'r' } };
const completed = { type: 'response.completed', response: { id: 'r', status: 'completed' } };
function stream(events: unknown[], fail = false) {
  let index = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < events.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
    else if (fail) controller.error(new Error('connection reset'));
    else controller.close();
  } });
}
async function collect(source: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const e of source) events.push(e);
  return events;
}
for (const api of ['responses', 'chat'] as const) {
  const map = (events: unknown[], fail = false) => api === 'responses'
    ? normalizeResponsesStream(stream(events, fail), { model: 'test' })
    : normalizeChatStream(stream(events, fail), { model: 'test' });
  for (const kind of ['empty', 'text', 'tool'] as const) test(`${api}: ${kind} EOF is retryable, never completed`, async () => {
    const frames = kind === 'empty' ? [] : api === 'responses'
      ? [created, kind === 'text' ? { type: 'response.output_text.delta', delta: 'partial' } : { type: 'response.output_item.added', item: { type: 'function_call', call_id: 't', name: 'probe', arguments: '{' } }]
      : [{ choices: [{ delta: kind === 'text' ? { content: 'partial' } : { tool_calls: [{ index: 0, id: 't', function: { name: 'probe', arguments: '{' } }] } }] }];
    const events: ModelStreamEvent[] = [];
    await assert.rejects(async () => { for await (const event of map(frames)) events.push(event); }, (e: unknown) => e instanceof ModelAPIError && e.retryable);
    assert(!events.some(e => e.type === 'response_completed' || e.type === 'tool_use'));
  });
  test(`${api}: completed response survives transport failure during trailer`, async () => {
    const frames = api === 'responses' ? [created, { type: 'response.output_text.delta', delta: 'complete' }, completed]
      : [{ choices: [{ delta: { content: 'complete' }, finish_reason: 'stop' }] }];
    const events = await collect(map(frames, true));
    assert.equal(events.filter(e => e.type === 'response_completed').length, 1);
    assert(events.some(e => e.type === 'assistant_message'));
  });
}
test('Responses failed event is a retryable server error, not completion', async () => {
  await assert.rejects(collect(normalizeResponsesStream(stream([created, { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'upstream failed' } } }]), { model: 'test' })),
    (e: unknown) => e instanceof ModelAPIError && e.category === 'server_error' && e.retryable);
});
test('Claude premature EOF is retryable while malformed blocks stay protocol failures', async () => {
  await assert.rejects(collect(normalizeAnthropicStream(stream([{ type: 'message_start', message: { id: 'm', usage: {} } }]), 'claude-test')), (e: unknown) => e instanceof ModelAPIError && e.retryable);
  await assert.rejects(collect(normalizeAnthropicStream(stream([{ type: 'message_stop' }]), 'claude-test')), (e: unknown) => e instanceof ModelAPIError && !e.retryable);
});
test('Chat keeps trailing usage and maps length to incomplete without Responses chaining', async () => {
  const events = await collect(normalizeChatStream(stream([{ id: 'chat-id', choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }]), { model: 'test' }));
  const end = events.find(e => e.type === 'response_incomplete');
  assert.equal(end?.type === 'response_incomplete' && end.reason, 'max_output_tokens');
  assert.equal(end?.type === 'response_incomplete' && end.responseId, undefined);
  assert.equal(end?.type === 'response_incomplete' && end.usage?.outputTokens, 4);
  assert(!events.some(e => e.type === 'response_completed'));
});
test('retry commits only successful attempt tools/messages, keeps immediate previews and one budget', async () => {
  let calls = 0;
  const events = await collect(streamWithRetry(async function* () {
    calls++;
    yield { type: 'response_started', responseId: `r${calls}` };
    yield { type: 'assistant_delta', text: `attempt${calls}` };
    yield { type: 'tool_use', toolUse: { id: `t${calls}`, name: 'probe', input: {} } };
    if (calls < 3) throw new Error('reset');
    yield { type: 'response_completed' };
  }, { provider: 'test', maxRetries: 2, delayMs: 0 }));
  assert.equal(calls, 3);
  assert.deepEqual(events.filter(e => e.type === 'retrying').map(e => [e.attempt, e.resetOutput]), [[1, true], [2, true]]);
  assert.deepEqual(events.filter(e => e.type === 'tool_use').map(e => e.toolUse.id), ['t3']);
  assert.equal(events.filter(e => e.type === 'assistant_delta').length, 3);
});
test('idle timeout cancels reader and response completion releases lock', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(`data: ${JSON.stringify(created)}\n\n`)); }, cancel() { cancelled = true; } });
  await assert.rejects(collect(normalizeResponsesStream(source, { model: 'test', streamIdleTimeoutMs: 5 })), /idle/);
  assert(cancelled); assert.equal(source.locked, false);
  const valid = stream([completed]); await collect(normalizeResponsesStream(valid, { model: 'test' })); assert.equal(valid.locked, false);
});


test('Chat malformed completed tool JSON cannot be swallowed as a trailer failure', async () => {
  await assert.rejects(collect(normalizeChatStream(stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'probe', arguments: '{' } }] }, finish_reason: 'tool_calls' }] }]), { model: 'test' })), /not valid JSON/);
});

test('usage from failed attempts is not counted as a committed successful response', async () => {
  let attempts = 0;
  const events = await collect(streamWithRetry(async function* () {
    attempts++;
    yield { type: 'usage', usage: { outputTokens: attempts } };
    if (attempts === 1) throw new Error('reset');
    yield { type: 'response_completed' };
  }, { provider: 'test', maxRetries: 1, delayMs: 0 }));
  assert.deepEqual(events.filter(e => e.type === 'usage').map(e => e.usage.outputTokens), [2]);
});


test('incomplete response discards the executable batch even when one item completed', async () => {
  const events = await collect(streamWithRetry(async function* () {
    yield { type: 'tool_use', toolUse: { id: 't', name: 'probe', input: {} } };
    yield { type: 'response_incomplete', reason: 'max_output_tokens' };
  }, { provider: 'test', delayMs: 0 }));
  assert(!events.some(e => e.type === 'tool_use')); assert(events.some(e => e.type === 'response_incomplete'));
});


for (const endpoint of ['responses', 'chat'] as const) test(`${endpoint}: actual adapter retries an HTTP EOF with unchanged 5s countdown`, async () => {
  let calls = 0; const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body)); calls++;
    const events = endpoint === 'responses'
      ? [created, { type: 'response.output_text.delta', delta: calls === 1 ? 'failed' : 'success' }, ...(calls === 1 ? [] : [completed])]
      : [{ choices: [{ delta: { content: calls === 1 ? 'failed' : 'success' }, ...(calls === 1 ? {} : { finish_reason: 'stop' }) }] }];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const adapter = new OpenAIAdapter({ model: 'test', endpoint, apiKey: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    const events = await collect(adapter.stream({ messages: [], tools: [], stream: true }));
    assert.equal(calls, 2); assert.deepEqual(bodies[0], bodies[1]);
    const retry = events.find(e => e.type === 'retrying'); assert.ok(retry?.type === 'retrying');
    assert.equal(retry.attempt, 1); assert.equal(retry.delayMs, 5000); assert.equal(retry.resetOutput, true);
    const finals = events.filter(e => e.type === 'assistant_message');
    assert.equal(finals.length, 1); assert(JSON.stringify(finals).includes('success')); assert(!JSON.stringify(finals).includes('failed'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
