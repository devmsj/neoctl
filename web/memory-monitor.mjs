import fsp from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';

const DEFAULT_SAMPLE_MS = 60_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_PUBLIC_SAMPLES = 60;

export function createMemoryMonitor({
  storageFile,
  sampleMs = DEFAULT_SAMPLE_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  publicSamples = DEFAULT_PUBLIC_SAMPLES,
  memoryUsage = () => process.memoryUsage(),
  heapStatistics = () => v8.getHeapStatistics(),
  now = () => Date.now(),
} = {}) {
  const normalizedSampleMs = positiveInteger(sampleMs, DEFAULT_SAMPLE_MS);
  const normalizedRetentionMs = Math.max(normalizedSampleMs, positiveInteger(retentionMs, DEFAULT_RETENTION_MS));
  const maxSamples = Math.min(10_080, Math.max(2, Math.ceil(normalizedRetentionMs / normalizedSampleMs) + 1));
  const publicLimit = Math.max(2, positiveInteger(publicSamples, DEFAULT_PUBLIC_SAMPLES));
  let samples = [];
  let timer;
  let writeQueue = Promise.resolve();

  async function start() {
    samples = await readSamples(storageFile);
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
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => writeSamples(storageFile, {
        version: 1,
        sampleMs: normalizedSampleMs,
        retentionMs: normalizedRetentionMs,
        samples,
      }));
    await writeQueue;
    return next;
  }

  function getPublicState() {
    return {
      sampleMs: normalizedSampleMs,
      retentionMs: normalizedRetentionMs,
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

async function readSamples(storageFile) {
  if (!storageFile) return [];
  try {
    const parsed = JSON.parse(await fsp.readFile(storageFile, 'utf8'));
    return Array.isArray(parsed?.samples) ? parsed.samples.filter(validSample) : [];
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`failed to read memory monitor data: ${error.message || error}`);
    return [];
  }
}

function validSample(value) {
  return value && typeof value === 'object' && Number.isFinite(Date.parse(value.at));
}

async function writeSamples(storageFile, value) {
  if (!storageFile) return;
  await fsp.mkdir(path.dirname(storageFile), { recursive: true });
  const temporary = `${storageFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await fsp.rename(temporary, storageFile);
}
