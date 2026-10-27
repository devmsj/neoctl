import assert from "node:assert/strict";
import { ModelAPIError } from "../../src/model/errors.js";
import test from "node:test";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ModelDrivenCompactor, type Compactor } from "../../src/context/compaction.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { WebRepl, type WebRuntime } from "../../src/web/index.js";
import type { ModelGateway, ModelRequest } from "../../src/model/model-gateway.js";
import { createTextMessage } from "../../src/types/messages.js";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const drain = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) { /* drain */ } };
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), "must settle without releasing the blocked compactor");
}
function replFor(engine: QueryEngine) {
  const repl = new WebRepl({ engine, initialMetrics: {}, usage: { reset() {}, add() {} },
    taskStore: { subscribe() {}, list: () => [], isTerminal: () => false },
    execProcessManager: { subscribe() {}, subscribeOutput() {}, list: () => [] },
  } as unknown as WebRuntime);
  (repl as unknown as { publishRuntimeContext(): void }).publishRuntimeContext = () => undefined;
  return repl;
}

for (const mode of ["auto", "reactive", "manual", "queued"] as const) {
  test(`${mode} compaction pause discards late summary and resumes before the model call`, { timeout: 10000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'neo-compact-pause-')));
    const opened = gate(), release = gate();
    t.after(async () => { release.resolve(); await rm(root, { recursive: true, force: true }); });
    const requests: ModelRequest[] = [];
    let summaries = 0, ordinary = 0, queue = false;
    let engine!: QueryEngine;
    const gateway: ModelGateway = { async *stream(request) {
      requests.push(request);
      if (request.queryOrigin === 'compact') {
        const n = ++summaries;
        if (n === 1) { opened.resolve(); yield { type: 'assistant_delta', text: 'LIVE SUMMARY' }; await release.promise; }
        yield { type: 'assistant_message', message: createTextMessage('assistant', n === 1 ? 'STALE SUMMARY' : 'FRESH SUMMARY') };
        yield { type: 'response_completed', responseId: `summary-${n}` };
      } else {
        ordinary++;
        if (mode === 'reactive' && ordinary === 1) throw new ModelAPIError({ category: 'context_length', provider: 'fake', message: 'maximum context length exceeded' });
        yield { type: 'assistant_message', message: createTextMessage('assistant', 'done') };
      }
    } };
    const tools = new ToolRegistry();
    const modelCompactor = new ModelDrivenCompactor(gateway);
    const compactor: Compactor = { async compact(messages, budget) {
      if (mode === 'auto' && summaries === 0) return modelCompactor.manualCompact(messages, { ...budget, onCompactionStart: () => budget?.onCompactionStart?.('autocompact') });
      if (mode === 'queued' && !queue) { queue = true; await engine.updateSessionSettings({ compact: true }); }
      return { messages: [...messages], changed: false };
    }, manualCompact: (m,b) => modelCompactor.manualCompact(m,b), reactiveCompact: (m,e,b) => modelCompactor.reactiveCompact(m,e,b) };
    engine = new QueryEngine({ modelGateway: gateway, tools, compactor,
      contextManager: { async build() { return { systemPrompt: 'test', promptSections: [], userContext: { currentDate: '2026-10-22' }, systemContext: { cwd: root, platform: process.platform } }; } },
      session: { rootDir: root, sessionId: 'session', resume: false } });
    const repl = replFor(engine);
    let manual: Promise<unknown> | undefined;
    if (mode === 'manual') {
      await drain(engine.sendUserText('original task'));
      manual = repl.compactSession();
    } else if (mode === 'queued') {
      // Queue through the real busy settings path, then enter the next run's beforeTurn.
      await drain(engine.sendUserText('original task'));
      await repl.submit('continue original task');
    } else await repl.submit('original task');
    await opened.promise;
    await waitFor(() => repl.snapshot().status.compactionText === 'LIVE SUMMARY');
    assert.equal(repl.snapshot().status.phase, 'compacting');
    assert.ok(!repl.snapshot().lines.some(line => line.text.includes('LIVE SUMMARY')), 'summary progress must not become assistant chat or prompt history');
    const before = JSON.stringify(engine.getHistoryMessages());
    const userCount = engine.getHistoryMessages().filter(m => m.role === 'user' && !m.isMeta).length;
    const ordinaryBefore = ordinary;
    assert.equal(repl.pauseRun().ok, true);
    assert.equal(repl.snapshot().busy, false);
    assert.equal(requests.find(r => r.queryOrigin === 'compact')?.cancellation?.aborted, true);
    assert.equal(engine.getExecutionState()?.resumeCompaction, true);
    await waitFor(() => !(engine as unknown as { running: boolean }).running);
    if (manual) await manual;
    assert.equal(JSON.stringify(engine.getHistoryMessages()), before);
    const journal = engine.snapshot().session!.transcriptPath;
    assert.equal((await readFile(journal, 'utf8')).split('\n').filter(l => l && JSON.parse(l).type === 'compact').length, 0);
    assert.equal(repl.continueRun().ok, true);
    await waitFor(() => summaries === 2 && !repl.snapshot().busy);
    assert.equal(ordinary, ordinaryBefore + 1);
    assert.equal(engine.getExecutionState()?.resumeCompaction, undefined);
    assert.equal(engine.getHistoryMessages().filter(m => m.role === 'user' && !m.isMeta).length, userCount);
    assert.match(JSON.stringify(engine.getHistoryMessages()), /FRESH SUMMARY/);
    const stable = JSON.stringify(engine.getHistoryMessages());
    release.resolve(); await new Promise(r => setTimeout(r, 30));
    assert.equal(JSON.stringify(engine.getHistoryMessages()), stable);
    assert.ok(!stable.includes('STALE SUMMARY'));
    assert.equal((await readFile(journal, 'utf8')).split('\n').filter(l => l && JSON.parse(l).type === 'compact').length, 1);
  });
}

test('pending compaction survives restart and retries before any normal request', { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'neo-compact-restart-')));
  const entered = gate(), release = gate();
  t.after(async () => { release.resolve(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const first = new QueryEngine({ tools: new ToolRegistry(), modelGateway: { async *stream() { throw new Error('not reached'); } },
    compactor: { async compact(messages, b) { b?.onCompactionStart?.('autocompact'); entered.resolve(); await release.promise; return { messages: [...messages], changed: false }; } },
    session: { rootDir: root, sessionId: 'resume', resume: false } });
  const running = drain(first.sendUserText('preserve this', { abortSignal: controller.signal })).catch(() => undefined);
  await entered.promise;
  // Reopen while persisted state still says running, as after an unexpected process exit.
  const order: string[] = [];
  const second = new QueryEngine({ tools: new ToolRegistry(), modelGateway: { async *stream() { order.push('model'); yield { type: 'assistant_message', message: createTextMessage('assistant', 'done') }; } },
    compactor: { async compact(m) { return { messages: [...m], changed: false }; }, async manualCompact(m) { order.push('compact'); return { messages: [...m], changed: false }; } },
    session: { rootDir: root, sessionId: 'resume', resume: true } });
  await second.initialize();
  assert.equal(second.getExecutionState()?.status, 'interrupted');
  assert.equal(second.getExecutionState()?.resumeCompaction, true);
  controller.abort(); await running;
  await drain(second.continueExecution());
  assert.deepEqual(order, ['compact', 'model']);
  assert.equal(second.getExecutionState()?.resumeCompaction, undefined);
});
