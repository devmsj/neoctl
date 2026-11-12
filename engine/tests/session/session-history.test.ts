import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session/session-store.js";
import { reverseTranscriptLines, transcriptLines } from "../../src/session/transcript-reader.js";
import { createTextMessage } from "../../src/types/messages.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-history-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("byte readers agree for Unicode, CRLF, empty lines and records larger than a read block", () => fixture(async root => {
  const file = path.join(root, "lines");
  const text = ['中文😀'.repeat(18000), '', 'last'].join('\r\n') + '\r\n';
  await fs.writeFile(file, text);
  const forward = []; for await (const line of transcriptLines(file)) forward.push(line);
  const reverse = [...reverseTranscriptLines(file, Buffer.byteLength(text))].reverse();
  assert.deepEqual(reverse, forward);
  assert.deepEqual([...reverseTranscriptLines(file, forward[1].start)].reverse(), forward.slice(0, 1));
}));

test("lazy resume/cache preserves exact model context and all history across repeated compaction", () => fixture(async rootDir => {
  const options = { rootDir, agentId: 'main', sessionId: 'long' };
  const store = await SessionStore.open(options);
  store.recordTitle('title'); store.recordFastMode(true); store.recordContextWindowTokens(256000);
  for (let window = 0; window < 8; window++) {
    for (let i = 0; i < 12; i++) store.recordMessage(createTextMessage(i % 2 ? 'assistant' : 'user', `${window}:${i}:中文😀`));
    const summary = createTextMessage('system', `summary ${window}`);
    summary.isMeta = true; summary.metadata = { compactBoundary: true };
    store.recordCompactCheckpoint([summary], 'autocompact');
  }
  store.recordMessage(createTextMessage('user', 'last original user'));
  store.recordContentReplacements([{ kind: 'tool-result', toolUseId: 'call', replacement: 'kept' }]);
  const expected = store.getInitialMessages(), display = store.getDisplayEntries();
  for (let pass = 0; pass < 2; pass++) {
    const restored = await SessionStore.open({ ...options, resume: true, lazyDisplay: true });
    assert.deepEqual(restored.getInitialMessages(), expected);
    assert.deepEqual(restored.getDisplayEntries(), display);
    assert.equal(restored.snapshot().windowNumber, 9);
    assert.equal(restored.getFastMode(), true);
    assert.equal(restored.getTitle(), 'title');
    assert.equal(restored.getContextWindowTokens(), 256000);
    assert.equal(restored.toolResultMemory.state.replacements.get('call'), 'kept');
    let before, pages = [], count = 0;
    do {
      const page = restored.getDisplayPage(before, 7);
      assert.ok(before === undefined || page.before < before);
      pages.unshift(...page.entries); before = page.before; count++;
      if (!page.hasMore) break;
      assert.ok(count < 100);
    } while (true);
    assert.deepEqual(pages, display);
  }
  store.recordMessage(createTextMessage('assistant', 'appended after cache'));
  const appended = await SessionStore.open({ ...options, resume: true, lazyDisplay: true });
  assert.deepEqual(appended.getInitialMessages(), store.getInitialMessages());
}));

test("history reset hides prior entries, invalid cursors fail, active appends keep previous pages stable", () => fixture(async rootDir => {
  const options = { rootDir, agentId: 'main', sessionId: 's', lazyDisplay: true };
  const store = await SessionStore.open(options);
  store.recordMessage(createTextMessage('user', 'before reset'));
  store.reset();
  for (let i = 0; i < 10; i++) store.recordMessage(createTextMessage('user', `${i}`));
  const first = store.getDisplayPage(undefined, 3);
  const older = store.getDisplayPage(first.before, 3);
  store.recordMessage(createTextMessage('assistant', 'newest'));
  assert.deepEqual(store.getDisplayPage(first.before, 3), older);
  assert.equal(store.getDisplayEntries().length, 11);
  assert.throws(() => store.getDisplayPage(-1), /Invalid history cursor/);
  assert.throws(() => store.getDisplayPage(1.5), /Invalid history cursor/);
  const restored = await SessionStore.open({ ...options, resume: true });
  assert.deepEqual(restored.getDisplayEntries(), store.getDisplayEntries());
}));

test("page edges keep parallel tool uses and results together", () => fixture(async rootDir => {
  const store = await SessionStore.open({ rootDir, agentId: 'main', sessionId: 's', lazyDisplay: true });
  const use = createTextMessage('assistant', '');
  use.blocks = ['a', 'b'].map(id => ({ type: 'tool_use' as const, id, name: 'file_read', input: { path: id } }));
  store.recordMessage(createTextMessage('user', 'before')); store.recordMessage(use);
  for (const id of ['a', 'b']) {
    const result = createTextMessage('tool_result', ''); result.blocks = [{ type: 'tool_result', toolUseId: id, name: 'file_read', ok: true, output: id }];
    store.recordMessage(result);
  }
  const page = store.getDisplayPage(undefined, 1);
  assert.equal(page.entries.length, 3);
  assert.equal(page.entries[0].type === 'message' && page.entries[0].message.id, use.id);
  assert.equal(store.getDisplayPage(page.before).entries.length, 1);
}));


test("cache checksum corruption falls back to authoritative history", () => fixture(async rootDir => {
  const options = { rootDir, agentId: 'main', sessionId: 's', lazyDisplay: true };
  const store = await SessionStore.open(options);
  store.recordMessage(createTextMessage('user', 'must survive'));
  await store.flushResumeCache();
  const cache = (await fs.readdir(store.sessionDir)).find(name => name.startsWith('resume-cache-'))!;
  const filename = path.join(store.sessionDir, cache);
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  saved.payload = saved.payload.replace('must survive', 'corrupted');
  await fs.writeFile(filename, JSON.stringify(saved));
  const restored = await SessionStore.open({ ...options, resume: true });
  assert.deepEqual(restored.getInitialMessages(), store.getInitialMessages());
}));

test("a stale writer cannot cache away messages from another writer", () => fixture(async rootDir => {
  const options = { rootDir, agentId: 'main', sessionId: 's', lazyDisplay: true };
  const first = await SessionStore.open(options);
  first.recordMessage(createTextMessage('user', 'first'));
  await first.flushResumeCache();
  const second = await SessionStore.open({ ...options, resume: true });
  first.recordMessage(createTextMessage('user', 'other writer'));
  second.recordMessage(createTextMessage('user', 'second'));
  await first.flushResumeCache(); await second.flushResumeCache();
  const restored = await SessionStore.open({ ...options, resume: true });
  assert.equal(restored.getInitialMessages().length, 3);
  assert.equal(restored.getDisplayEntries().length, 3);
}));

test("flushed cache after compaction and replacement equals an uncached replay", () => fixture(async rootDir => {
  const options = { rootDir, agentId: 'main', sessionId: 's', lazyDisplay: true };
  const store = await SessionStore.open(options);
  store.recordMessage(createTextMessage('user', 'old'));
  store.recordCompactCheckpoint([createTextMessage('system', 'summary')], 'autocompact');
  store.recordMessage(createTextMessage('assistant', 'new'));
  store.recordFastMode(true); store.recordTitle('cached title');
  store.recordContentReplacements([{ kind: 'tool-result', toolUseId: 'call', replacement: 'kept' }]);
  await store.flushResumeCache();
  const warm = await SessionStore.open({ ...options, resume: true });
  const full = await SessionStore.open({ ...options, resume: true, lazyDisplay: false });
  assert.deepEqual(warm.getInitialMessages(), full.getInitialMessages());
  assert.deepEqual(warm.getDisplayEntries(), full.getDisplayEntries());
  assert.equal(warm.snapshot().windowId, full.snapshot().windowId);
  assert.equal(warm.toolResultMemory.state.replacements.get('call'), 'kept');
  assert.equal(warm.getTitle(), full.getTitle());
}));
