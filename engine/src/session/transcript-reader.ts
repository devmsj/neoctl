import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Byte positions, never UTF-16 offsets. A page is a stable prefix despite concurrent appends. */
export interface TranscriptLine { text: string; start: number; end: number }
const BLOCK = 64 * 1024;
export function* reverseTranscriptLines(file: string, before: number, floor = 0): Generator<TranscriptLine> {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || before > stat.size || floor < 0) throw new Error("Unsafe session transcript page");
    let cursor = before, pending = Buffer.alloc(0), end = before;
    while (cursor > floor) {
      const start = Math.max(floor, cursor - BLOCK), buf = Buffer.allocUnsafe(cursor - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      if (n !== buf.length) throw new Error("Session transcript changed while reading");
      pending = Buffer.concat([buf, pending]); cursor = start;
      let right = pending.length;
      for (let i = right - 1; i >= 0; i--) {
        if (pending[i] !== 10) continue;
        const lineStart = start + i + 1;
        if (lineStart < end) yield { text: pending.subarray(i + 1, right).toString("utf8").replace(/\r$/u, ""), start: lineStart, end };
        end = lineStart; right = i;
      }
      pending = pending.subarray(0, right);
    }
    if (pending.length) yield { text: pending.toString("utf8").replace(/\r$/u, ""), start: floor, end };
  } finally { fs.closeSync(fd); }
}

export async function* transcriptLines(file: string): AsyncGenerator<TranscriptLine> {
  let handle;
  try { handle = await fsp.open(file, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe session transcript");
    let pending = Buffer.alloc(0), offset = 0, position = 0;
    while (position < stat.size) {
      const buf = Buffer.allocUnsafe(Math.min(BLOCK, stat.size - position));
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (!bytesRead) throw new Error("Session transcript changed while reading");
      position += bytesRead; pending = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
      let start = 0, end;
      while ((end = pending.indexOf(10, start)) !== -1) {
        yield { text: pending.subarray(start, end).toString("utf8").replace(/\r$/u, ""), start: offset + start, end: offset + end + 1 };
        start = end + 1;
      }
      offset += start; pending = pending.subarray(start);
    }
    if (pending.length) yield { text: pending.toString("utf8").replace(/\r$/u, ""), start: offset, end: stat.size };
  } finally { await handle.close(); }
}

/** Disposable acceleration only. The append-only JSONL remains authoritative. */
export function transcriptStamp(stat: fs.Stats): string { return [process.platform === "win32" ? 0 : stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].join(":"); }
function cachePath(file: string, agent: string): string {
  return path.join(path.dirname(file), `resume-cache-${createHash("sha256").update(agent).digest("hex").slice(0, 16)}.json`);
}
export async function readResumeCache<T>(file: string, agent: string): Promise<T | undefined> {
  try {
    const stat = await fsp.lstat(file), cache = cachePath(file, agent), cachedStat = await fsp.lstat(cache);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !cachedStat.isFile() || cachedStat.isSymbolicLink() || cachedStat.nlink !== 1) return;
    const saved = JSON.parse(await fsp.readFile(cache, "utf8"));
    if (saved.version !== 2 || saved.stamp !== transcriptStamp(stat) || saved.agent !== agent || typeof saved.payload !== "string") return;
    if (createHash("sha256").update(saved.payload).digest("hex") !== saved.checksum) return;
    if (transcriptStamp(await fsp.lstat(file)) !== transcriptStamp(stat)) return;
    return JSON.parse(saved.payload) as T;
  } catch { return; }
}
export async function writeResumeCache(file: string, agent: string, state: unknown, expected?: fs.Stats): Promise<void> {
  const target = cachePath(file, agent), temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (expected && transcriptStamp(expected) !== transcriptStamp(stat))) return;
    const payload = JSON.stringify(state), checksum = createHash("sha256").update(payload).digest("hex");
    await fsp.writeFile(temp, JSON.stringify({ version: 2, agent, stamp: transcriptStamp(stat), payload, checksum }), { flag: "wx" });
    await fsp.rename(temp, target);
  } catch { /* read-only storage/cache failures must never prevent opening durable history */ }
  finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
}
