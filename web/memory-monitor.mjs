import fsp from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';

const DEFAULT_SAMPLE_MS = 60_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_PUBLIC_SAMPLES = 60;
const MAX_PUBLIC_SAMPLES = 60;
const DEFAULT_MAX_PERSISTED_SAMPLES = 1_440;
const DEFAULT_MAX_PERSISTED_BYTES = 256 * 1024;

export function createMemoryMonitor({
  storageFile,
  sampleMs = DEFAULT_SAMPLE_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  publicSamples = DEFAULT_PUBLIC_SAMPLES,
  maxPersistedSamples = DEFAULT_MAX_PERSISTED_SAMPLES,
  maxPersistedBytes = DEFAULT_MAX_PERSISTED_BYTES,
  memoryUsage = () => process.memoryUsage(),
  heapStatistics = () => v8.getHeapStatistics(),
  now = () => Date.now(),
} = {}) {
  const normalizedSampleMs = positiveInteger(sampleMs, DEFAULT_SAMPLE_MS);
  const normalizedRetentionMs = Math.max(normalizedSampleMs, positiveInteger(retentionMs, DEFAULT_RETENTION_MS));
  const persistedSampleLimit = Math.max(2, positiveInteger(maxPersistedSamples, DEFAULT_MAX_PERSISTED_SAMPLES));
  const persistedByteLimit = Math.max(1_024, positiveInteger(maxPersistedBytes, DEFAULT_MAX_PERSISTED_BYTES));
  const maxSamples = Math.min(persistedSampleLimit, Math.max(2, Math.ceil(normalizedRetentionMs / normalizedSampleMs) + 1));
  const publicLimit = Math.min(MAX_PUBLIC_SAMPLES, Math.max(2, positiveInteger(publicSamples, DEFAULT_PUBLIC_SAMPLES)));
  let samples = [];
  let timer;
  let writeQueue = Promise.resolve();

  async function start() {
    samples = (await readSamples(storageFile, persistedByteLimit)).slice(-maxSamples);
    await sample();
    timer = setInterval(() => { void sample(); }, normalizedSampleMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  async function sample() {
    const timestamp = now();
    const usage = memoryUsage();
    const heap = heapStatistics();
    const next = {
      at: new Date(timestamp).toISOString(),
      rss: byteValue(usage.rss),
      heapUsed: byteValue(usage.heapUsed),
      heapTotal: byteValue(usage.heapTotal),
      heapLimit: byteValue(heap.heap_size_limit),
      external: byteValue(usage.external),
      arrayBuffers: byteValue(usage.arrayBuffers),
    };
    const cutoff = timestamp - normalizedRetentionMs;
    samples = [...samples, next]
      .filter((entry) => Date.parse(entry.at) >= cutoff)
      .slice(-maxSamples);
    const persisted = serializePersistedState({
      version: 1,
      sampleMs: normalizedSampleMs,
      retentionMs: normalizedRetentionMs,
      maxPersistedSamples: maxSamples,
      maxPersistedBytes: persistedByteLimit,
      samples,
    }, persistedByteLimit);
    samples = persisted.samples;
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => writeSamples(storageFile, persisted.text));
    await writeQueue;
    return next;
  }

  function getPublicState() {
    return {
      sampleMs: normalizedSampleMs,
      retentionMs: normalizedRetentionMs,
      maxPersistedSamples: maxSamples,
      maxPersistedBytes: persistedByteLimit,
      current: samples.at(-1) || null,
      history: samples.slice(-publicLimit),
    };
  }

  return { start, stop, sample, getPublicState };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function byteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

async function readSamples(storageFile, maxBytes) {
  if (!storageFile) return [];
  try {
    const info = await fsp.stat(storageFile);
    if (info.size > maxBytes) {
      console.warn(`memory monitor data exceeds ${maxBytes} bytes; resetting history`);
      return [];
    }
    const parsed = JSON.parse(await fsp.readFile(storageFile, 'utf8'));
    return Array.isArray(parsed?.samples) ? parsed.samples.map(normalizeSample).filter(Boolean) : [];
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`failed to read memory monitor data: ${error.message || error}`);
    return [];
  }
}

function normalizeSample(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(Date.parse(value.at))) return null;
  return {
    at: new Date(Date.parse(value.at)).toISOString(),
    rss: byteValue(value.rss),
    heapUsed: byteValue(value.heapUsed),
    heapTotal: byteValue(value.heapTotal),
    heapLimit: byteValue(value.heapLimit),
    external: byteValue(value.external),
    arrayBuffers: byteValue(value.arrayBuffers),
  };
}

function serializePersistedState(value, maxBytes) {
  let samples = value.samples;
  let text = `${JSON.stringify({ ...value, samples })}\n`;
  while (Buffer.byteLength(text, 'utf8') > maxBytes && samples.length > 1) {
    const excessRatio = maxBytes / Buffer.byteLength(text, 'utf8');
    const keep = Math.max(1, Math.min(samples.length - 1, Math.floor(samples.length * excessRatio * 0.95)));
    samples = samples.slice(-keep);
    text = `${JSON.stringify({ ...value, samples })}\n`;
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`memory monitor state exceeds ${maxBytes} bytes`);
  return { samples, text };
}

async function writeSamples(storageFile, text) {
  if (!storageFile) return;
  await fsp.mkdir(path.dirname(storageFile), { recursive: true });
  const temporary = `${storageFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, text, 'utf8');
  await fsp.rename(temporary, storageFile);
}
