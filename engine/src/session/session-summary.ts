import fsp from "node:fs/promises";
import type { Stats } from "node:fs";

/** List-only facts. Never retain message bodies, image data or restored runtime state. */
export interface TranscriptSummary {
  entryCount: number;
  messages: number;
  contentReplacements: number;
  title?: string;
}
interface CachedSummary { stamp: string; summary: TranscriptSummary }
const cache = new Map<string, CachedSummary>();
const pending = new Map<string, Promise<TranscriptSummary>>();
const MAX_CACHE_ENTRIES = 2048;

function stamp(stat: Stats): string {
  return [stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function keyFor(file: string, agentId?: string): string { return JSON.stringify([file, agentId ?? null]); }

export function forgetTranscriptSummary(file: string): void {
  for (const key of cache.keys()) if (JSON.parse(key)[0] === file) cache.delete(key);
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
    const summary = await scanTranscriptSummary(file, agentId);
    // A writer may have appended while reading. Do not cache a mixed snapshot.
    const after = await fsp.lstat(file).catch(() => undefined);
    if (after?.isFile() && !after.isSymbolicLink() && after.nlink === 1 && stamp(after) === version) {
      cache.delete(key); cache.set(key, { stamp: version, summary });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    return summary;
  })();
  pending.set(pendingKey, operation);
  try { return { ...await operation }; }
  finally { pending.delete(pendingKey); }
}

async function scanTranscriptSummary(file: string, agentId?: string): Promise<TranscriptSummary> {
  const summary: TranscriptSummary = { entryCount: 0, messages: 0, contentReplacements: 0 };
  const text = await fsp.readFile(file, "utf8");
  let start = 0, lineNumber = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start), complete = end !== -1;
    const line = text.slice(start, complete ? end : text.length).replace(/\r$/u, "");
    start = complete ? end + 1 : text.length;
    lineNumber++;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || typeof entry.type !== "string" || typeof entry.agentId !== "string") {
        throw new Error("Invalid entry");
      }
    } catch (cause) {
      // A writer's partial final line is not a list failure. Repair belongs to resume, never listing.
      if (!complete) break;
      throw new Error(`Malformed session transcript at ${file}:${lineNumber}`, { cause });
    }
    if (agentId && entry.agentId !== agentId) continue;
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
  return summary;
}
