import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMemoryMonitor } from './memory-monitor.mjs';

test('persists a bounded rolling time window and exposes recent samples', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'neo-memory-monitor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const storageFile = path.join(root, 'memory.json');
  let time = Date.parse('2026-08-31T00:00:00.000Z');
  let rss = 100;
  const monitor = createMemoryMonitor({
    storageFile,
    sampleMs: 1_000,
    retentionMs: 3_000,
    publicSamples: 2,
    now: () => time,
    memoryUsage: () => ({ rss, heapUsed: 40, heapTotal: 80, external: 10, arrayBuffers: 5 }),
    heapStatistics: () => ({ heap_size_limit: 1_000 }),
  });

  await monitor.sample();
  time += 2_000;
  rss = 200;
  await monitor.sample();
  time += 2_000;
  rss = 300;
  await monitor.sample();

  const state = monitor.getPublicState();
  assert.equal(state.current.rss, 300);
  assert.deepEqual(state.history.map((entry) => entry.rss), [200, 300]);
  const persisted = JSON.parse(await fsp.readFile(storageFile, 'utf8'));
  assert.deepEqual(persisted.samples.map((entry) => entry.rss), [200, 300]);
  assert.equal(persisted.retentionMs, 3_000);
});
