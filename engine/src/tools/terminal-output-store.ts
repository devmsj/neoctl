import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TERMINAL_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const TERMINAL_OUTPUT_RETENTION_MS = 5 * 60 * 1000;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
export type TerminalOutputStream = "stdout" | "stderr";
export type OutputAvailability = "available" | "expired" | "evicted" | "lost" | "io-error";
/** Text fields must already be redacted. Oversized fields are rejected, never silently shortened. */
export interface TerminalRunMetadata {
  startedAt: number; processId?: number | null; tty?: boolean;
  sessionId?: string; status?: string;
  command?: string; cwd?: string; shell?: string; description?: string;
  /** Explicitly bounded metadata previews, never claimed as full original parameters. */
  truncatedFields?: Array<"command" | "cwd" | "shell" | "description">;
}
/** Only facts supplied by the process owner. null means not provided; no status inference. */
export interface TerminalExitFacts {
  /** Original manager status, not inferred from exitCode. */
  status?: string;
  finishedAt: number;
  exitCode: number | null;
  signal: string | number | null;
  terminationReason: string | null;
  durationMs: number | null;
}
export interface StreamTotals { observedBytes: number; storedBytes: number }
export interface TerminalRunRecord {
  version: 1;
  ownerSessionId: string;
  runId: string;
  metadata: TerminalRunMetadata;
  lifecycle: "running" | "terminal" | "lost";
  exit: TerminalExitFacts | null;
  lostAt: number | null;
  expiresAt: number | null;
  availability: OutputAvailability;
  truncated: boolean;
  byteLimit: number;
  streams: Record<TerminalOutputStream, StreamTotals>;
}
export type StoreFailureReason = "invalid-input" | "unsafe-path" | "not-found" | "conflict" | "io-error";
export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: StoreFailureReason };
export interface RunView { record: TerminalRunRecord; persistence: "stored" | "memory-only" }
export interface OutputPage extends RunView {
  stream: TerminalOutputStream;
  /** Byte offsets into this stream only. null text is unavailable, not empty output. */
  offset: number;
  nextOffset: number;
  text: string | null;
  endOfStoredOutput: boolean;
}
const redactedBrand: unique symbol = Symbol("redacted-terminal-increment");
export interface RedactedTerminalChunk {
  readonly [redactedBrand]: true;
  readonly stream: TerminalOutputStream;
  readonly offset: number;
  readonly text: string;
}
/**
 * Trust-boundary attestation, NOT a redactor. Call only after an authorized streaming
 * redactor has emitted a complete Unicode increment (including its final flush).
 * offset counts UTF-8 bytes emitted by that redactor, separately for each stream.
 * Never wrap raw process data, drain results, previews or cumulative snapshots here.
 */
export function redactedTerminalChunk(stream: TerminalOutputStream, offset: number, text: string): RedactedTerminalChunk {
  return Object.freeze({ [redactedBrand]: true as const, stream, offset, text });
}
export interface TerminalOutputStoreOptions {
  /** Existing trusted session root. Default owner directory is its direct owner-ID child. */
  sessionsRoot: string;
  /** Trusted runtime resolver, never user input. Allows real nested child-session directories. */
  resolveOwnerSessionDir?: (ownerSessionId: string) => string | undefined;
  now?: () => number;
  /** Tests may lower the budget; production cannot raise the approved 64 MiB cap. */
  maxBytesPerRun?: number;
}
interface Entry { record: TerminalRunRecord; persisted: boolean }
interface Owner { dir: string; entries: Map<string, Entry> }
class StoreError extends Error { constructor(readonly reason: StoreFailureReason) { super(reason); } }
function fail(reason: StoreFailureReason): never { throw new StoreError(reason); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && value !== "." && value !== ".."
    && !/[\\/:*?"<>|\x00-\x1f]/u.test(value) && !/[. ]$/u.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function directory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(dir), dir)) fail("unsafe-path");
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function fileStat(file: string): fs.BigIntStats {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !samePath(fs.realpathSync(file), file)) fail("unsafe-path");
  return stat;
}
function optionalFile(file: string): void { try { fileStat(file); } catch (error) { if (!missing(error)) throw error; } }
function runFolder(runId: string): string { return `r-${createHash("sha256").update(runId).digest("hex")}`; }
const textLimits = { command: 4096, cwd: 2048, shell: 256, description: 2048, status: 120, sessionId: 160 } as const;
function metadataDTO(value: TerminalRunMetadata): TerminalRunMetadata {
  const result: TerminalRunMetadata = { startedAt: value.startedAt };
  if (value.truncatedFields !== undefined) result.truncatedFields = [...value.truncatedFields];
  if (value.processId !== undefined) result.processId = value.processId;
  if (value.tty !== undefined) result.tty = value.tty;
  for (const key of Object.keys(textLimits) as (keyof typeof textLimits)[]) if (value[key] !== undefined) result[key] = value[key];
  return result;
}
function validMetadata(value: TerminalRunMetadata): boolean {
  return !!value && integer(value.startedAt) && (value.processId === undefined || value.processId === null || integer(value.processId))
    && (value.tty === undefined || typeof value.tty === "boolean")
    && (value.truncatedFields === undefined || (Array.isArray(value.truncatedFields) && value.truncatedFields.length <= 4
      && new Set(value.truncatedFields).size === value.truncatedFields.length
      && value.truncatedFields.every((key) => ["command", "cwd", "shell", "description"].includes(key))))
    && Object.entries(textLimits).every(([key, limit]) => {
      const text = value[key as keyof typeof textLimits];
      return text === undefined || (typeof text === "string" && Buffer.byteLength(text) <= limit);
    }) && (value.sessionId === undefined || identifier(value.sessionId));
}
function validExit(value: TerminalExitFacts): boolean {
  return !!value && (value.status === undefined || (typeof value.status === "string" && Buffer.byteLength(value.status) <= 120)) && integer(value.finishedAt) && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && (value.signal === null || (typeof value.signal === "string" && value.signal.length <= 120) || Number.isSafeInteger(value.signal))
    && (value.terminationReason === null || (typeof value.terminationReason === "string" && value.terminationReason.length <= 120))
    && (value.durationMs === null || integer(value.durationMs));
}
function exitDTO(value: TerminalExitFacts): TerminalExitFacts {
  return { ...(value.status !== undefined ? { status: value.status } : {}), finishedAt: value.finishedAt, exitCode: value.exitCode, signal: value.signal,
    terminationReason: value.terminationReason, durationMs: value.durationMs };
}
/** Retain only a complete UTF-8 prefix; never invent replacement characters at page/cap boundaries. */
function prefixLength(bytes: Buffer, limit: number): number {
  let end = Math.min(bytes.length, limit);
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Independent, synchronous, single-writer store; no manager/UI/session imports or timers.
 * One instance per sessionsRoot/process. Call restoreSession for authorized sessions at startup,
 * saved output survives process-slot release and has no time-based expiry.
 * Uses the project's lstat/realpath + wx/fsync/rename pattern. Like existing stores, it assumes
 * no hostile concurrent directory mutation by another process with the same OS permissions.
 */
export class TerminalOutputStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly resolveOwnerDir: (id: string) => string | undefined;
  private readonly owners = new Map<string, Owner>();

  constructor(options: TerminalOutputStoreOptions) {
    this.root = path.resolve(options.sessionsRoot);
    this.now = options.now ?? Date.now;
    this.resolveOwnerDir = options.resolveOwnerSessionDir ?? ((id) => path.join(this.root, id));
    this.limit = options.maxBytesPerRun ?? TERMINAL_OUTPUT_MAX_BYTES;
    if (!integer(this.limit) || this.limit > TERMINAL_OUTPUT_MAX_BYTES) throw new Error("Invalid terminal output byte budget");
  }

  /** Explicit authorized recovery only: does not enumerate the sessions root. */
  restoreSession(ownerSessionId: string, ownerSessionDir: string): StoreResult<{ records: RunView[]; rejected: number }> {
    return this.guard(() => {
      const owner = this.bind(ownerSessionId, ownerSessionDir);
      let rejected = 0;
      let names: string[] = [];
      try { names = fs.readdirSync(this.storageDir(owner, false)); }
      catch (error) { if (!missing(error)) throw error; }
      for (const name of names) {
        if (!/^r-[a-f0-9]{64}$/.test(name)) continue;
        try {
          const dir = path.join(this.storageDir(owner, false), name);
          directory(dir);
          const raw = JSON.parse(this.readFile(path.join(dir, "metadata.json"), MAX_METADATA_BYTES).toString("utf8"));
          const record = this.decode(raw, ownerSessionId, name);
          if (owner.entries.has(record.runId)) continue;
          const entry = { record, persisted: true };
          owner.entries.set(record.runId, entry);
          if (record.lifecycle === "running") {
            record.lifecycle = "lost";
            record.lostAt = this.clock();
            // No actual exit is known. Recovered output is immediately revoked, not renewed.
            record.availability = "lost";
            this.save(owner, entry);
          }
          this.maintain(owner, entry);
        } catch { rejected++; }
      }
      return { records: [...owner.entries.values()].map((entry) => this.view(entry)), rejected };
    });
  }

  start(ownerSessionId: string, ownerSessionDir: string, runId: string, metadata: TerminalRunMetadata): StoreResult<RunView> {
    return this.guard(() => {
      if (!identifier(runId) || !validMetadata(metadata)) fail("invalid-input");
      if (!this.owners.has(ownerSessionId)) {
        const restored = this.restoreSession(ownerSessionId, ownerSessionDir);
        if (!restored.ok) fail(restored.reason);
      }
      const owner = this.bind(ownerSessionId, ownerSessionDir);
      if (owner.entries.has(runId)) fail("conflict");
      const record: TerminalRunRecord = {
        version: 1, ownerSessionId, runId,
        metadata: metadataDTO(metadata),
        lifecycle: "running", exit: null, lostAt: null, expiresAt: null, availability: "available", truncated: false,
        byteLimit: this.limit, streams: { stdout: { observedBytes: 0, storedBytes: 0 }, stderr: { observedBytes: 0, storedBytes: 0 } },
      };
      const entry: Entry = { record, persisted: false };
      // Never overwrite an unreadable/corrupt record or a prior identity.
      const parent = this.storageDir(owner, true);
      const dir = path.join(parent, runFolder(runId));
      try { fs.lstatSync(dir); fail("conflict"); } catch (error) { if (!missing(error)) throw error; }
      owner.entries.set(runId, entry);
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        for (const stream of ["stdout", "stderr"] as const) this.withFile(path.join(dir, `${stream}.txt`), "create", () => undefined);
        this.persist(owner, entry);
      } catch (error) { this.unavailable(owner, entry, error); }
      return this.view(entry);
    });
  }

  append(ownerSessionId: string, runId: string, chunk: RedactedTerminalChunk): StoreResult<RunView & { duplicate: boolean }> {
    return this.guard(() => {
      const [owner, entry] = this.entry(ownerSessionId, runId);
      const r = entry.record;
      if (!chunk || chunk[redactedBrand] !== true || !["stdout", "stderr"].includes(chunk.stream)
          || !integer(chunk.offset) || typeof chunk.text !== "string"
          || Buffer.from(chunk.text, "utf8").toString("utf8") !== chunk.text) fail("invalid-input");
      if (r.lifecycle !== "running") fail("conflict");
      const bytes = Buffer.from(chunk.text, "utf8");
      const totals = r.streams[chunk.stream];
      if (!integer(chunk.offset + bytes.length)) fail("invalid-input");
      if (chunk.offset < totals.observedBytes && chunk.offset + bytes.length <= totals.observedBytes) {
        return { ...this.view(entry), duplicate: true };
      }
      if (chunk.offset !== totals.observedBytes) fail("conflict");
      totals.observedBytes += bytes.length;
      entry.persisted = false; // Running counters are checkpointed at finalize, not per chunk.
      if (r.availability === "available") {
        const room = r.byteLimit - r.streams.stdout.storedBytes - r.streams.stderr.storedBytes;
        const count = r.truncated ? 0 : prefixLength(bytes, room);
        if (count < bytes.length) r.truncated = true;
        try {
          const file = path.join(this.runDir(owner, r), `${chunk.stream}.txt`);
          this.withFile(file, "write", (fd) => {
            if (fs.fstatSync(fd).size !== totals.storedBytes) fail("io-error");
            let written = 0;
            while (written < count) {
              const n = fs.writeSync(fd, bytes, written, count - written, totals.storedBytes + written);
              if (!n) fail("io-error");
              written += n;
            }
          });
          totals.storedBytes += count;
        } catch (error) { this.unavailable(owner, entry, error); }
      }
      return { ...this.view(entry), duplicate: false };
    });
  }

  finalize(ownerSessionId: string, runId: string, facts: TerminalExitFacts): StoreResult<RunView> {
    return this.guard(() => {
      if (!validExit(facts)) fail("invalid-input");
      const [owner, entry] = this.entry(ownerSessionId, runId);
      const r = entry.record;
      if (facts.finishedAt < r.metadata.startedAt || r.lifecycle === "lost") fail("conflict");
      const exit = exitDTO(facts);
      if (r.exit && JSON.stringify(r.exit) !== JSON.stringify(exit)) fail("conflict");
      r.lifecycle = "terminal";
      r.exit = exit;
      r.expiresAt = null;
      if (r.availability === "available") {
        try {
          for (const stream of ["stdout", "stderr"] as const) {
            this.withFile(path.join(this.runDir(owner, r), `${stream}.txt`), "write", (fd) => {
              if (fs.fstatSync(fd).size !== r.streams[stream].storedBytes) fail("io-error");
              fs.fsyncSync(fd);
            });
          }
        } catch (error) { this.unavailable(owner, entry, error); }
      }
      this.save(owner, entry);
      this.maintain(owner, entry);
      return this.view(entry);
    });
  }

  /** Release a manager slot without removing durable output. */
  evict(ownerSessionId: string, runId: string): StoreResult<RunView> {
    return this.guard(() => {
      const [owner, entry] = this.entry(ownerSessionId, runId);
      // Releasing a process slot does not delete its saved output.
      this.maintain(owner, entry);
      return this.view(entry);
    });
  }

  read(ownerSessionId: string, runId: string, page: { stream: TerminalOutputStream; offset?: number; limitBytes?: number }): StoreResult<OutputPage> {
    return this.guard(() => {
      const offset = page.offset ?? 0;
      const limit = page.limitBytes ?? 64 * 1024;
      if (!["stdout", "stderr"].includes(page.stream) || !integer(offset) || !integer(limit) || limit < 4 || limit > MAX_PAGE_BYTES) fail("invalid-input");
      const [owner, entry] = this.entry(ownerSessionId, runId);
      this.maintain(owner, entry);
      let text: string | null = null;
      let nextOffset = offset;
      const stored = entry.record.streams[page.stream].storedBytes;
      if (entry.record.availability === "available") {
        if (offset > stored) fail("invalid-input");
        try {
          const file = path.join(this.runDir(owner, entry.record), `${page.stream}.txt`);
          text = this.withFile(file, "read", (fd) => {
            if (fs.fstatSync(fd).size !== stored) fail("io-error");
            const bytes = Buffer.alloc(Math.min(limit + 1, stored - offset));
            let read = 0;
            while (read < bytes.length) {
              const count = fs.readSync(fd, bytes, read, bytes.length - read, offset + read);
              if (!count) fail("io-error");
              read += count;
            }
            if (bytes.length && (bytes[0]! & 0xc0) === 0x80) fail("invalid-input");
            const end = prefixLength(bytes, limit);
            nextOffset += end;
            const value = bytes.subarray(0, end).toString("utf8");
            if (!Buffer.from(value).equals(bytes.subarray(0, end))) fail("io-error");
            return value;
          });
        } catch (error) {
          if (error instanceof StoreError && error.reason === "invalid-input") throw error;
          this.unavailable(owner, entry, error);
        }
      }
      return { ...this.view(entry), stream: page.stream, offset, nextOffset, text, endOfStoredOutput: text !== null && nextOffset === stored };
    });
  }

  /** Metadata only. Never contains text, previews or arbitrary filesystem references. */
  listHistory(ownerSessionId: string, pagination: { offset?: number; limit?: number } = {}): StoreResult<{ records: RunView[]; nextOffset: number | null }> {
    return this.guard(() => {
      const owner = this.owner(ownerSessionId);
      const offset = pagination.offset ?? 0;
      const limit = pagination.limit ?? 50;
      if (!integer(offset) || !integer(limit) || limit < 1 || limit > 200) fail("invalid-input");
      const entries = [...owner.entries.values()].filter((e) => e.record.lifecycle !== "running")
        .sort((a, b) => a.record.metadata.startedAt - b.record.metadata.startedAt || a.record.runId.localeCompare(b.record.runId));
      const selected = entries.slice(offset, offset + limit);
      for (const entry of selected) this.maintain(owner, entry);
      return { records: selected.map((entry) => this.view(entry)), nextOffset: offset + selected.length < entries.length ? offset + selected.length : null };
    });
  }

  /** Only registered owners and validated records; no recursive rm or root-wide scanning. */
  sweep(): StoreResult<{ checked: number }> {
    return this.guard(() => {
      let checked = 0;
      for (const owner of this.owners.values()) for (const entry of owner.entries.values()) { this.maintain(owner, entry); checked++; }
      return { checked };
    });
  }

  private clock(): number { const now = this.now(); if (!integer(now)) fail("invalid-input"); return now; }
  private bind(id: string, dir: string): Owner {
    if (!identifier(id) || !path.isAbsolute(dir)) fail("invalid-input");
    const expected = this.resolveOwnerDir(id);
    if (!expected || !samePath(path.resolve(dir), path.resolve(expected))) fail("invalid-input");
    this.checkOwnerDir(path.resolve(dir));
    const current = this.owners.get(id);
    // Reject case-alias owners on case-insensitive filesystems, not just textual duplicate IDs.
    for (const [other, value] of this.owners) if (other !== id && samePath(value.dir, path.resolve(dir))) fail("conflict");
    if (current) { if (!samePath(current.dir, path.resolve(dir))) fail("conflict"); return current; }
    const owner = { dir: path.resolve(dir), entries: new Map<string, Entry>() };
    this.owners.set(id, owner);
    return owner;
  }
  private checkOwnerDir(dir: string): void {
    const relative = path.relative(this.root, dir);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("unsafe-path");
    directory(this.root);
    let current = this.root;
    for (const part of relative.split(path.sep)) { current = path.join(current, part); directory(current); }
  }
  private owner(id: string): Owner {
    if (!identifier(id)) fail("invalid-input");
    const owner = this.owners.get(id);
    if (!owner) fail("not-found");
    this.checkOwnerDir(owner.dir);
    return owner;
  }
  private entry(id: string, runId: string): [Owner, Entry] {
    if (!identifier(runId)) fail("invalid-input");
    const owner = this.owner(id);
    const entry = owner.entries.get(runId);
    if (!entry) fail("not-found");
    return [owner, entry];
  }
  private storageDir(owner: Owner, create: boolean): string {
    this.checkOwnerDir(owner.dir);
    const dir = path.join(owner.dir, "terminal-output");
    if (create) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    directory(dir);
    return dir;
  }
  private runDir(owner: Owner, record: TerminalRunRecord): string {
    const dir = path.join(this.storageDir(owner, false), runFolder(record.runId));
    directory(dir);
    return dir;
  }
  private withFile<T>(file: string, mode: "read" | "write" | "create", action: (fd: number) => T): T {
    const before = mode === "create" ? undefined : fileStat(file);
    const flags = mode === "create" ? fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      : mode === "write" ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
    const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      // bigint preserves Windows file IDs; path lstat dev is 0 on this Node/Windows runtime.
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || (before && ((process.platform !== "win32" && before.dev !== stat.dev) || before.ino !== stat.ino))) fail("unsafe-path");
      const result = action(fd);
      const after = fileStat(file);
      if ((process.platform !== "win32" && after.dev !== stat.dev) || after.ino !== stat.ino) fail("unsafe-path");
      return result;
    } finally { fs.closeSync(fd); }
  }
  private readFile(file: string, max: number): Buffer {
    return this.withFile(file, "read", (fd) => {
      if (fs.fstatSync(fd).size > max) fail("invalid-input");
      return fs.readFileSync(fd);
    });
  }
  private persist(owner: Owner, entry: Entry): void {
    const dir = this.runDir(owner, entry.record);
    const target = path.join(dir, "metadata.json");
    optionalFile(target);
    const data = JSON.stringify(entry.record) + "\n";
    if (Buffer.byteLength(data) > MAX_METADATA_BYTES) fail("invalid-input");
    const temporary = path.join(dir, `.metadata-${randomUUID()}.tmp`);
    try {
      this.withFile(temporary, "create", (fd) => { fs.writeFileSync(fd, data, "utf8"); fs.fsyncSync(fd); });
      this.runDir(owner, entry.record); optionalFile(target); fileStat(temporary);
      fs.renameSync(temporary, target);
      entry.persisted = true;
    } finally {
      // Only our exact temporary name, under revalidated directories.
      try { this.runDir(owner, entry.record); fileStat(temporary); fs.unlinkSync(temporary); } catch { /* fail closed */ }
    }
  }
  private save(owner: Owner, entry: Entry): void {
    entry.persisted = false;
    try { this.persist(owner, entry); } catch { if (entry.record.availability === "available") entry.record.availability = "io-error"; }
  }
  private unavailable(owner: Owner, entry: Entry, _error: unknown): void {
    entry.record.availability = "io-error";
    this.save(owner, entry);
  }
  private maintain(owner: Owner, entry: Entry): void {
    const r = entry.record;
    let changed = false;
    if (r.expiresAt !== null) { r.expiresAt = null; changed = true; }
    // Migrate old metadata only when both original streams still exist intact.
    // Deleted output is not recreated or confused with an empty command result.
    if (r.availability === "expired" || r.availability === "evicted") {
      try {
        for (const stream of ["stdout", "stderr"] as const) {
          this.withFile(path.join(this.runDir(owner, r), `${stream}.txt`), "read", fd => {
            if (fs.fstatSync(fd).size !== r.streams[stream].storedBytes) fail("io-error");
          });
        }
        r.availability = "available";
        changed = true;
      } catch { /* Previously deleted output cannot be recovered by changing metadata. */ }
    }
    if (changed) this.save(owner, entry);
  }
  private view(entry: Entry): RunView { return { record: structuredClone(entry.record), persistence: entry.persisted ? "stored" : "memory-only" }; }
  private guard<T>(action: () => T): StoreResult<T> {
    try { return { ok: true, value: action() }; }
    catch (error) { return { ok: false, reason: error instanceof StoreError ? error.reason : missing(error) ? "not-found" : "io-error" }; }
  }
  private decode(raw: TerminalRunRecord, owner: string, folder: string): TerminalRunRecord {
    if (!raw || raw.version !== 1 || raw.ownerSessionId !== owner || !identifier(raw.runId) || runFolder(raw.runId) !== folder
        || !validMetadata(raw.metadata) || !["running", "terminal", "lost"].includes(raw.lifecycle)
        || !["available", "expired", "evicted", "lost", "io-error"].includes(raw.availability)
        || typeof raw.truncated !== "boolean" || !integer(raw.byteLimit) || raw.byteLimit > TERMINAL_OUTPUT_MAX_BYTES
        || !raw.streams || !["stdout", "stderr"].every((s) => {
          const t = raw.streams[s as TerminalOutputStream];
          return t && integer(t.observedBytes) && integer(t.storedBytes) && t.storedBytes <= t.observedBytes;
        }) || raw.streams.stdout.storedBytes + raw.streams.stderr.storedBytes > raw.byteLimit
        || (raw.lifecycle === "terminal" ? !validExit(raw.exit!) || raw.exit!.finishedAt < raw.metadata.startedAt
          || (raw.expiresAt !== null && raw.expiresAt !== raw.exit!.finishedAt + TERMINAL_OUTPUT_RETENTION_MS) || raw.lostAt !== null
          : raw.exit !== null || raw.expiresAt !== null || (raw.lifecycle === "lost" ? !integer(raw.lostAt) : raw.lostAt !== null))) fail("invalid-input");
    // Explicit DTO: persisted input never becomes arbitrary paths/output fields or runtime state.
    return { version: 1, ownerSessionId: owner, runId: raw.runId,
      metadata: metadataDTO(raw.metadata),
      lifecycle: raw.lifecycle, exit: raw.exit === null ? null : exitDTO(raw.exit), lostAt: raw.lostAt, expiresAt: raw.expiresAt,
      availability: raw.availability, truncated: raw.truncated, byteLimit: raw.byteLimit,
      streams: { stdout: { observedBytes: raw.streams.stdout.observedBytes, storedBytes: raw.streams.stdout.storedBytes },
        stderr: { observedBytes: raw.streams.stderr.observedBytes, storedBytes: raw.streams.stderr.storedBytes } } };
  }
}
