// Build engine first. Source is opened read-only; all resume/cache writes go to a temporary copy.
// node tests/session/benchmark-history.mjs <transcript.jsonl> [copies=1,10] [prefixBytes]
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SessionStore } from '../../dist/session/session-store.js';
import { restoreWebHistoryLines } from '../../dist/web/index.js';
const [source, copies = '1,10', prefixBytes] = process.argv.slice(2);
if (!source) throw new Error('Provide a source transcript path (read-only).');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (await fs.readFile(source)).subarray(0, prefixBytes ? Number(prefixBytes) : undefined);
const sourceHash = createHash('sha256').update(bytes).digest('hex');
assert.equal(bytes.at(-1), 10, 'benchmark prefix must end on a durable newline');
const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-history-bench-'));
try {
  const baselineDir = path.join(rootDir, 'baseline'); await fs.mkdir(baselineDir);
  await fs.writeFile(path.join(baselineDir, 'transcript.jsonl'), bytes);
  const baseline = await SessionStore.open({ rootDir, sessionId: 'baseline', agentId: 'main', resume: true });
  const contextHash = hash(baseline.getInitialMessages());
  const displayHash = hash(baseline.getDisplayEntries());
  const results = [];
  for (const count of copies.split(',').map(Number)) {
    assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 1000);
    const sessionId = `copy-${count}`, dir = path.join(rootDir, sessionId); await fs.mkdir(dir);
    const handle = await fs.open(path.join(dir, 'transcript.jsonl'), 'wx');
    try { for (let i = 0; i < count; i++) await handle.writeFile(bytes); } finally { await handle.close(); }
    for (const pass of ['cold', 'warm']) {
      const started = performance.now();
      const store = await SessionStore.open({ rootDir, sessionId, agentId: 'main', resume: true, lazyDisplay: true });
      const openMs = performance.now() - started;
      if (count === 1) assert.equal(hash(store.getInitialMessages()), contextHash);
      const pageStart = performance.now(), page = store.getDisplayPage(), pageMs = performance.now() - pageStart;
      const renderStart = performance.now();
      const lines = restoreWebHistoryLines({ engine: { getDisplayEntries: () => page.entries, getTimingRecords: () => page.timings } });
      const renderMs = performance.now() - renderStart;
      results.push({ copies: count, transcriptBytes: count * bytes.length, pass, openMs, pageMs, renderMs, firstPageBytes: Buffer.byteLength(JSON.stringify(lines)), entries: page.entries.length });
      if (count === 1 && pass === 'warm') {
        let cursor, all = [], pages = 0;
        do { const p = store.getDisplayPage(cursor); all.unshift(...p.entries); cursor = p.before; pages++; if (!p.hasMore) break; } while (true);
        assert.equal(hash(all), displayHash); console.log(JSON.stringify({ fullHistoryHashMatch: true, entries: all.length, pages }));
      }
    }
  }
  const now = (await fs.readFile(source)).subarray(0, bytes.length);
  assert.equal(createHash('sha256').update(now).digest('hex'), sourceHash, 'original source prefix changed externally');
  console.log(JSON.stringify({ sourcePrefixUnchanged: true, contextHash, results }, null, 2));
} finally { await fs.rm(rootDir, { recursive: true, force: true }); }
