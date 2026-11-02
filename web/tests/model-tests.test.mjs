import test from 'node:test';
import assert from 'node:assert/strict';
import { runIndependentModelTests } from '../src/model-tests.mjs';
const payload = () => ({ revision: 'r1', composition: { main: { model: 'model-a' } }, selection: ['main', 'vision', 'exa'], imageConsent: false });
const result = id => ({ results: [{ id, ok: true, detail: 'ok', durationMs: 1 }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('independent requests start concurrently and publish as they finish using one snapshot', async () => {
  const pending = new Map(), calls = [], results = [], input = payload();
  let finished = false;
  const running = runIndependentModelTests({ payload: input, onResult: r => results.push(r), request: (url, body) => {
    calls.push({ url, body }); return new Promise(resolve => pending.set(body.selection[0], resolve));
  } }).then(() => { finished = true; });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url === '/test' && call.body.selection.length === 1));
  input.composition.main.model = 'changed'; input.selection.push('image');
  assert.ok(calls.every(call => call.body.composition.main.model === 'model-a'));
  pending.get('exa')(result('exa')); await tick();
  assert.deepEqual(results.map(r => r.id), ['exa']); assert.equal(finished, false);
  pending.get('vision')(result('vision')); await tick();
  assert.deepEqual(results.map(r => r.id), ['exa', 'vision']); assert.equal(finished, false);
  pending.get('main')(result('main')); await running; assert.equal(results.length, 3);
});

test('HTTP errors and malformed responses affect only the corresponding item', async () => {
  const results = [];
  await runIndependentModelTests({ payload: payload(), onResult: r => results.push(r), request: async (_, body) => {
    const id = body.selection[0]; if (id === 'main') throw new Error('HTTP 502');
    return id === 'vision' ? { results: [] } : result(id);
  } });
  assert.equal(results.find(r => r.id === 'main').detail, 'HTTP 502');
  assert.equal(results.find(r => r.id === 'vision').ok, false);
  assert.equal(results.find(r => r.id === 'exa').ok, true);
});

test('cancel aborts pending requests but preserves completed results; a new run is independent', async () => {
  const controller = new AbortController(), results = [];
  const running = runIndependentModelTests({ payload: payload(), signal: controller.signal, onResult: r => results.push(r), request: async (_, body, signal) => {
    if (body.selection[0] === 'exa') return result('exa');
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await tick(); assert.equal(results[0].id, 'exa'); controller.abort(); await running;
  assert.equal(results.find(r => r.id === 'exa').ok, true);
  assert.equal(results.filter(r => r.cancelled).length, 2);
  const next = [];
  await runIndependentModelTests({ payload: payload(), onResult: r => next.push(r), request: async (_, body) => result(body.selection[0]) });
  assert.ok(next.every(r => r.ok));
});
