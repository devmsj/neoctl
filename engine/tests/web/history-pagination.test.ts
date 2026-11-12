import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/session/session-store.js';
import { WebRepl, restoreWebHistoryLines } from '../../src/web/index.js';
import { createTextMessage, createToolResultMessage } from '../../src/types/messages.js';

test('paged web history preserves rendering, tool pairing and snapshot boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-web-pages-'));
  try {
    const store = await SessionStore.open({ rootDir: root, agentId: 'main', sessionId: 's', lazyDisplay: true });
    for (let i = 0; i < 140; i++) {
      store.recordMessage(createTextMessage('user', `user ${i}`));
      const call = { id: `call-${i}`, name: 'file_read', input: { path: `p${i}` } };
      const use = createTextMessage('assistant', ''); use.blocks = [{ type: 'tool_use', ...call }]; store.recordMessage(use);
      store.recordTiming({ version: 1, id: `timing-${i}`, runId: `run-${i}`, kind: 'tool', status: 'running', toolUseId: call.id, startedAt: new Date().toISOString() });
      store.recordMessage(createToolResultMessage(call, true, { content: `output ${i}`, totalLines: 1 }));
      store.recordTiming({ version: 1, id: `timing-${i}`, runId: `run-${i}`, kind: 'tool', status: 'finished', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), toolUseId: call.id, durationMs: i + 10 });
    }
    const engine = {
      getDisplayEntries: () => store.getDisplayEntries(), getDisplayPage: (before?: number) => store.getDisplayPage(before),
      getLastCompactOffset: () => store.getLastCompactOffset(), getDemoMode: () => store.getDemoMode(),
      snapshot: () => ({ session: store.snapshot() }), getTimingRecords: () => store.getTimings(),
      isFastMode: () => false, getAppPrompt: () => ({}), onSessionTitleChange: () => () => {},
    };
    const runtime = { engine, usage: { snapshot: () => ({}), reset() {} }, taskStore: { subscribe: () => () => {}, list: () => [] },
      execProcessManager: { subscribe: () => () => {}, subscribeOutput: () => () => {}, list: () => [] } };
    const repl = new WebRepl(runtime as never);
    const snapshot = repl.snapshot(); assert.ok(snapshot.history?.hasMore); assert.ok(snapshot.lines.length < 100);
    let cursor = snapshot.history!, lines: any[] = [...snapshot.lines];
    while (cursor.hasMore) { const page = repl.history(cursor.before, cursor.epoch); lines.unshift(...page.lines); cursor = page; }
    const omit = ({ id, historyOffset, ...line }: any) => line;
    assert.deepEqual(lines.map(omit), restoreWebHistoryLines(runtime as never));
    assert.deepEqual(repl.snapshot().lines, snapshot.lines, 'paging does not inflate live snapshots');
    assert.throws(() => repl.history(1, 'wrong epoch'), /History changed/);
    await store.flushResumeCache();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
