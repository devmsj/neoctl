import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

/** List-only facts. Never retain message bodies, image data or restored runtime state. */
export interface TranscriptSummary {
  entryCount: number;
  messages: number;
  contentReplacements: number;
  title?: string;
}
/** Fold state up to the end of the last complete line; the transcript is append-only. */
interface ScanState { offset: number; lines: number; state: TranscriptSummary }
/** tail: hash of the bytes just before offset, proving a persisted prefix still matches the transcript. */
interface IndexEntry extends ScanState { identity: string; tail: string }
interface CachedSummary extends IndexEntry { stamp: string; summary: TranscriptSummary }
const cache = new Map<string, CachedSummary>();
const pending = new Map<string, Promise<TranscriptSummary>>();
const MAX_CACHE_ENTRIES = 2048;
const CHUNK = 1024 * 1024;
const TAIL_BYTES = 4096;
/** Disposable list acceleration beside the session folders (never inside one, so deletion never races it). */
const INDEX_FILE = ".neo-list-summary.json";
const indexes = new Map<string, Promise<Map<string, IndexEntry>>>();
const loadedIndexes = new Map<string, Map<string, IndexEntry>>();
const dirtyIndexes = new Set<string>();
let indexTimer: ReturnType<typeof setTimeout> | undefined;

function stamp(stat: Stats): string {
  return [stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function identity(stat: Stats): string { return [process.platform === "win32" ? 0 : stat.dev, stat.ino, stat.birthtimeMs].join(":"); }
function keyFor(file: string, agentId?: string): string { return JSON.stringify([file, agentId ?? null]); }
function rootOf(file: string): string { return path.dirname(path.dirname(file)); }
const emptyScan = (): ScanState => ({ offset: 0, lines: 0, state: { entryCount: 0, messages: 0, contentReplacements: 0 } });

export function forgetTranscriptSummary(file: string): void {
  for (const key of cache.keys()) if (JSON.parse(key)[0] === file) cache.delete(key);
  const index = loadedIndexes.get(rootOf(file));
  if (index) for (const key of index.keys()) if (JSON.parse(key)[0] === file) { index.delete(key); scheduleIndexSave(rootOf(file)); }
}

export async function readTranscriptSummary(file: string, stat: Stats, agentId?: string): Promise<TranscriptSummary> {
  const key = keyFor(file, agentId), version = stamp(stat);
  const cached = cache.get(key);
  if (cached?.stamp === version) {
    cache.delete(key); cache.set(key, cached);
    return { ...cached.summary };
  }
  const pendingKey = JSON.stringify([key, version]);
  const existing = pending.get(pendingKey);
  if (existing) return { ...await existing };
  const operation = (async () => {
    // Continue from the last complete line of the same file instead of rescanning the whole archive.
    const base = cached ?? (await indexFor(rootOf(file))).get(key);
    const usable = base && base.identity === identity(stat) && stat.size >= base.offset ? base : undefined;
    const scanned = await scanTranscriptSummary(file, stat.size, agentId, usable && { offset: usable.offset, lines: usable.lines, state: { ...usable.state }, tail: usable.tail });
    // Only bytes below stat.size were read, so concurrent appends cannot mix in; reject a replaced/truncated file.
    const after = await fsp.lstat(file).catch(() => undefined);
    if (after?.isFile() && !after.isSymbolicLink() && after.nlink === 1 && identity(after) === identity(stat) && after.size >= stat.size) {
      const { summary, ...entry } = scanned;
      cache.delete(key); cache.set(key, { ...entry, summary, identity: identity(stat), stamp: version });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      const index = await indexFor(rootOf(file)), saved = index.get(key);
      if (saved?.offset !== entry.offset || saved.identity !== identity(stat)) {
        index.set(key, { ...entry, state: { ...entry.state }, identity: identity(stat) });
        scheduleIndexSave(rootOf(file));
      }
    }
    return scanned.summary;
  })();
  pending.set(pendingKey, operation);
  try { return { ...await operation }; }
  finally { pending.delete(pendingKey); }
}

/** Bounded chunks: never one whole-file string (V8 limit) or one long synchronous parse loop. */
async function scanTranscriptSummary(file: string, size: number, agentId: string | undefined, base?: ScanState & { tail: string }): Promise<ScanState & { tail: string; summary: TranscriptSummary }> {
  const handle = await fsp.open(file, "r");
  try {
    const tailBefore = async (offset: number) => {
      const start = Math.max(0, offset - TAIL_BYTES), bytes = Buffer.alloc(offset - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      return createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex");
    };
    let scan: ScanState = base && await tailBefore(base.offset) === base.tail ? base : emptyScan();
    let position = scan.offset, pending = Buffer.alloc(0);
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0, end;
      while ((end = pending.indexOf(10, start)) !== -1) {
        applySummaryLine(scan.state, pending.toString("utf8", start, end), ++scan.lines, true, file, agentId);
        start = end + 1;
      }
      scan.offset += start; pending = pending.subarray(start);
    }
    const summary = { ...scan.state };
    if (pending.length) applySummaryLine(summary, pending.toString("utf8"), scan.lines + 1, false, file, agentId);
    return { offset: scan.offset, lines: scan.lines, state: scan.state, tail: await tailBefore(scan.offset), summary };
  } finally { await handle.close(); }
}

function indexFor(root: string): Promise<Map<string, IndexEntry>> {
  let index = indexes.get(root);
  if (!index) {
    index = fsp.readFile(path.join(root, INDEX_FILE), "utf8")
      .then(text => { const saved = JSON.parse(text); return saved?.version === 1 && saved.entries && typeof saved.entries === "object" ? Object.entries(saved.entries) : []; })
      .catch(() => [])
      .then(entries => {
        const map = new Map<string, IndexEntry>();
        for (const [key, value] of entries as [string, IndexEntry][]) if (isIndexEntry(value)) map.set(key, value);
        loadedIndexes.set(root, map);
        return map;
      });
    indexes.set(root, index);
  }
  return index;
}

function isIndexEntry(value: IndexEntry): boolean {
  const s = value?.state;
  return !!s && typeof value.identity === "string" && typeof value.tail === "string"
    && Number.isSafeInteger(value.offset) && value.offset >= 0 && Number.isSafeInteger(value.lines) && value.lines >= 0
    && [s.entryCount, s.messages, s.contentReplacements].every(n => Number.isSafeInteger(n) && n >= 0)
    && (s.title === undefined || typeof s.title === "string");
}

function scheduleIndexSave(root: string): void {
  dirtyIndexes.add(root);
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = undefined;
    for (const dirty of [...dirtyIndexes]) { dirtyIndexes.delete(dirty); void saveIndex(dirty); }
  }, 1000);
  indexTimer.unref?.();
}

async function saveIndex(root: string): Promise<void> {
  const index = loadedIndexes.get(root);
  if (!index) return;
  const target = path.join(root, INDEX_FILE), temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(index) }), { flag: "wx" });
    await fsp.rename(temp, target);
  } catch { /* acceleration only: read-only or removed roots still list from transcripts */ }
  finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
}

function applySummaryLine(summary: TranscriptSummary, text: string, lineNumber: number, complete: boolean, file: string, agentId?: string): void {
  {
    const line = text.replace(/\r$/u, "");
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || typeof entry.type !== "string" || typeof entry.agentId !== "string") {
        throw new Error("Invalid entry");
      }
    } catch (cause) {
      // A writer's partial final line is not a list failure. Repair belongs to resume, never listing.
      if (!complete) return;
      throw new Error(`Malformed session transcript at ${file}:${lineNumber}`, { cause });
    }
    if (agentId && entry.agentId !== agentId) return;
    summary.entryCount++;
    switch (entry.type) {
      case "reset":
        summary.messages = 0; summary.contentReplacements = 0; delete summary.title;
        break;
      case "compact":
        summary.messages = Array.isArray(entry.replacementMessages) ? entry.replacementMessages.length : 0;
        summary.contentReplacements = 0;
        break;
      case "message":
        if (entry.message?.metadata?.displayOnly !== true) summary.messages++;
        break;
      case "content-replacement":
        if (Array.isArray(entry.replacements)) summary.contentReplacements += entry.replacements.length;
        break;
      case "title": {
        const title = typeof entry.title === "string" ? entry.title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
        if (title) summary.title = title;
        break;
      }
    }
  }
}
