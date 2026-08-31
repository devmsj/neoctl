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

test('never exposes more than 60 samples', async () => {
  let time = Date.parse('2026-08-31T00:00:00.000Z');
  const monitor = createMemoryMonitor({
    sampleMs: 1,
    retentionMs: 1_000,
    publicSamples: 10_000,
    maxPersistedSamples: 1_000,
    now: () => time++,
    memoryUsage: () => ({ rss: time, heapUsed: 40, heapTotal: 80, external: 10, arrayBuffers: 5 }),
    heapStatistics: () => ({ heap_size_limit: 1_000 }),
  });

  for (let index = 0; index < 80; index += 1) await monitor.sample();
  assert.equal(monitor.getPublicState().history.length, 60);
});

test('caps persisted history by sample count and serialized bytes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'neo-memory-monitor-size-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const storageFile = path.join(root, 'memory.json');
  let time = Date.parse('2026-08-31T00:00:00.000Z');
  const monitor = createMemoryMonitor({
    storageFile,
    sampleMs: 1,
    retentionMs: 100_000,
    maxPersistedSamples: 25,
    maxPersistedBytes: 1_024,
    now: () => time++,
    memoryUsage: () => ({ rss: time, heapUsed: 40, heapTotal: 80, external: 10, arrayBuffers: 5 }),
    heapStatistics: () => ({ heap_size_limit: 1_000 }),
  });

  for (let index = 0; index < 80; index += 1) await monitor.sample();
  const info = await fsp.stat(storageFile);
  const persisted = JSON.parse(await fsp.readFile(storageFile, 'utf8'));
  assert.ok(info.size <= 1_024);
  assert.ok(persisted.samples.length <= 25);
  assert.equal(monitor.getPublicState().current.rss, persisted.samples.at(-1).rss);
});
