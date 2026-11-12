import fs from "node:fs";
import { transcriptLines, reverseTranscriptLines, readResumeCache, writeResumeCache, transcriptStamp } from "./transcript-reader.js";
import { readTranscriptSummary, forgetTranscriptSummary } from "./session-summary.js";
import { isExecutionState, type ExecutionState } from "../core/execution-state.js";
import { isTimingRecord, restoredTiming, type TimingRecord } from "../core/query-timing.js";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CompactionReason, CompactionReport } from "../context/compaction.js";
import type { AppPromptValue } from "../app/app-prompt.js";
import { validateSessionPromptState, type SessionPromptState } from "../core/session-settings-prompt.js";
import type { Message } from "../types/messages.js";
import { getNeoctlHome } from "../paths.js";
import { FileToolResultMemory, type ContentReplacementRecord, type ToolResultMemory } from "./tool-result-memory.js";

export type SessionTitleKind = "initial" | "refinement";

export type SessionTranscriptEntry =
  | { type: "execution"; sessionId: string; agentId: string; execution: ExecutionState }
  | { type: "timing"; sessionId: string; agentId: string; timing: TimingRecord; runGeneration?: number }
  | { type: "message"; sessionId: string; agentId: string; message: Message; runGeneration?: number }
  | { type: "content-replacement"; sessionId: string; agentId: string; replacements: ContentReplacementRecord[] }
  | { type: "title"; sessionId: string; agentId: string; title: string; createdAt: string; kind?: SessionTitleKind }
  | { type: "app-prompt"; sessionId: string; agentId: string; createdAt: string; appPrompt?: AppPromptValue }
  | { type: "session-prompt"; sessionId: string; agentId: string; createdAt: string; prompt: SessionPromptState }
  | { type: "model-selection-cleared"; sessionId: string; agentId: string; cleared: boolean }
  | { type: "fast-mode"; sessionId: string; agentId: string; createdAt: string; enabled: boolean }
  | { type: "context-window"; sessionId: string; agentId: string; createdAt: string; tokens: number }
  | {
      type: "compact";
      sessionId: string;
      agentId: string;
      createdAt: string;
      replacementMessages?: Message[];
      reason?: CompactionReason;
      report?: CompactionReport;
      windowNumber?: number;
      firstWindowId?: string;
      previousWindowId?: string;
      windowId?: string;
    }
  | { type: "reset"; sessionId: string; agentId: string; createdAt: string };

export interface SessionStoreOptions {
  cwd?: string;
  agentId: string;
  sessionId?: string;
  rootDir?: string;
  resume?: boolean;
  toolResultThresholdChars?: number;
  /** Keep archival display bodies on disk; model context is always restored in full. */
  lazyDisplay?: boolean;
}

export interface SessionListOptions {
  cwd?: string;
  agentId?: string;
  rootDir?: string;
  limit?: number;
}

export interface SessionDeleteOptions {
  cwd?: string;
  sessionId: string;
  rootDir?: string;
}

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  title?: string;
  updatedAt?: string;
  entryCount: number;
  messages: number;
  contentReplacements: number;
}

export type SessionDisplayEntry =
  | { type: "message"; message: Message }
  | { type: "compact"; createdAt: string; reason?: CompactionReason; report?: CompactionReport };

export interface SessionStoreSnapshot {
  createdAt?: string;
  updatedAt?: string;
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  title?: string;
  titleKind?: SessionTitleKind;
  hasInitialTitle: boolean;
  hasTitleRefinement: boolean;
  resumedMessages: number;
  contentReplacements: number;
  appPrompt?: AppPromptValue;
  sessionPrompt?: SessionPromptState;
  fastMode: boolean;
  modelSelectionCleared?: boolean;
  contextWindowTokens?: number;
  windowNumber: number;
  lastCompaction?: CompactionReport;
  firstWindowId: string;
  previousWindowId?: string;
  windowId: string;
}

export interface SessionDisplayPage {
  entries: SessionDisplayEntry[];
  offsets: number[];
  timings: TimingRecord[];
  before: number;
  hasMore: boolean;
  epoch: string;
}

export interface SessionTitleState {
  title?: string;
  kind?: SessionTitleKind;
  hasInitialTitle: boolean;
  hasRefinement: boolean;
}

export class SessionStore {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly transcriptPath: string;
  readonly toolResultMemory: ToolResultMemory;
  private writeFailed = false;
  private readonly lazyDisplay: boolean;
  private displayStart = 0;
  private displayCount = 0;
  private demoMode?: string;
  private lastCompactOffset = -1;
  private cacheSourceStamp?: string;
  private cacheInvalid = false;
  private cacheTimer?: ReturnType<typeof setTimeout>;
  private cacheWrite: Promise<void> = Promise.resolve();
  private updatedAt?: string;
  private createdAt?: string;
  private execution?: ExecutionState;
  private readonly agentId: string;
  private readonly resumedMessages: Message[];
  private readonly displayEntries: SessionDisplayEntry[];
  private readonly contentReplacements: ContentReplacementRecord[];
  private title?: string;
  private titleKind?: SessionTitleKind;
  private hasInitialTitle = false;
  private hasTitleRefinement = false;
  private appPrompt?: AppPromptValue;
  private sessionPrompt?: SessionPromptState;
  private fastMode = false;
  private modelSelectionCleared = false;
  private contextWindowTokens?: number;
  private lastCompaction?: CompactionReport;
  private windowNumber: number;
  private firstWindowId: string;
  private previousWindowId?: string;
  private windowId: string;

  private readonly timings = new Map<string, TimingRecord>();

  private constructor(options: SessionStoreOptions, sessionId: string, loaded: LoadedTranscript) {
    this.agentId = options.agentId;
    this.lazyDisplay = options.lazyDisplay === true;
    this.displayStart = loaded.displayStart;
    this.displayCount = loaded.displayCount;
    this.demoMode = loaded.demoMode;
    this.lastCompactOffset = loaded.lastCompactOffset;
    this.sessionId = sessionId;
    this.sessionDir = path.join(resolveSessionRoot(options), sessionId);
    this.transcriptPath = path.join(this.sessionDir, "transcript.jsonl");
    this.resumedMessages = loaded.messages;
    this.execution = loaded.execution;
    for (const record of loaded.timings.values()) this.timings.set(record.id, restoredTiming(record));
    this.displayEntries = loaded.displayEntries;
    this.contentReplacements = loaded.replacements;
    this.title = loaded.title;
    this.titleKind = loaded.titleKind;
    this.hasInitialTitle = loaded.hasInitialTitle;
    this.hasTitleRefinement = loaded.hasTitleRefinement;
    this.appPrompt = loaded.appPrompt;
    this.sessionPrompt = loaded.sessionPrompt;
    this.fastMode = loaded.fastMode;
    this.modelSelectionCleared = loaded.modelSelectionCleared ?? false;
    this.contextWindowTokens = loaded.contextWindowTokens;
    this.lastCompaction = loaded.lastCompaction ? cloneCompactionReport(loaded.lastCompaction) : undefined;
    this.windowNumber = loaded.windowNumber;
    this.firstWindowId = loaded.firstWindowId ?? randomUUID();
    this.previousWindowId = loaded.previousWindowId;
    this.windowId = loaded.windowId ?? this.firstWindowId;
    this.toolResultMemory = new FileToolResultMemory(
      {
        sessionDir: this.sessionDir,
        thresholdChars: options.toolResultThresholdChars,
      },
      loaded.replacements,
    );
  }

  static async open(options: SessionStoreOptions): Promise<SessionStore> {
    const requestedSessionId = normalizeRequestedSessionId(options.sessionId);
    const sessionId =
      options.resume && (!requestedSessionId || requestedSessionId === "latest")
        ? (await findLatestSessionId(options)) ?? createSessionId()
        : requestedSessionId ?? createSessionId();
    const sessionDir = path.join(resolveSessionRoot(options), sessionId);
    checkSessionPaths(sessionDir);
    const transcriptPath = path.join(sessionDir, "transcript.jsonl");
    const loaded = options.resume
      ? await loadTranscript(transcriptPath, options.agentId, { repairUnterminatedTail: true, lazyDisplay: options.lazyDisplay })
      : createEmptyLoadedTranscript();
    await fsp.mkdir(sessionDir, { recursive: true });
    checkSessionPaths(sessionDir);
    const store = new SessionStore(options, sessionId, loaded);
    // Read once on open, never stat the transcript on streaming snapshots.
    const transcriptStat = await fsp.stat(transcriptPath).catch(() => undefined);
    store.cacheSourceStamp = loaded.sourceStamp;
    store.cacheInvalid = options.resume ? loaded.sourceStamp !== (transcriptStat && transcriptStamp(transcriptStat)) : !!transcriptStat?.size;
    store.updatedAt = transcriptStat?.mtime.toISOString();
    store.createdAt = (transcriptStat ?? await fsp.stat(sessionDir)).birthtime.toISOString();
    return store;
  }

  static async list(options: SessionListOptions = {}): Promise<SessionSummary[]> {
    const root = resolveSessionRoot(options);
    checkSessionDirectory(root);
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    const directories = entries.filter((entry) => entry.isDirectory());
    const summaries: (SessionSummaryWithUpdatedAtMs | undefined)[] = new Array(directories.length);
    let cursor = 0;
    // Bound disk reads and transient JSON allocations; warm lists only stat files.
    await Promise.all(Array.from({ length: Math.min(8, directories.length) }, async () => {
      while (cursor < directories.length) {
        const index = cursor++;
        const sessionId = normalizeRequestedSessionId(directories[index]!.name)!;
        const sessionDir = path.join(root, sessionId);
        checkSessionPaths(sessionDir);
        const transcriptPath = path.join(sessionDir, "transcript.jsonl");
        const stat = await fsp.lstat(transcriptPath).catch(() => undefined);
        if (!stat) { forgetTranscriptSummary(transcriptPath); continue; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("Unsafe session transcript");
        const facts = await readTranscriptSummary(transcriptPath, stat, options.agentId);
        summaries[index] = {
          sessionId, sessionDir, transcriptPath,
          updatedAt: stat.mtime.toISOString(), updatedAtMs: stat.mtimeMs,
          ...facts,
        };
      }
    }));

    return summaries
      .filter(isSessionSummaryWithUpdatedAtMs)
      .filter((summary) => !options.agentId || summary.entryCount > 0)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .slice(0, Math.max(0, options.limit ?? Number.POSITIVE_INFINITY))
      .map(({ updatedAtMs: _updatedAtMs, ...summary }) => summary);
  }

  static async delete(options: SessionDeleteOptions): Promise<boolean> {
    const sessionId = normalizeRequestedSessionId(options.sessionId);
    if (!sessionId || sessionId === "latest") throw new Error("a concrete session id is required");
    if (path.basename(sessionId) !== sessionId || sessionId.includes("/") || sessionId.includes("\\")) {
      throw new Error(`invalid session id: ${options.sessionId}`);
    }
    const sessionDir = path.join(resolveSessionRoot(options), sessionId);
    checkSessionPaths(sessionDir);
    const stat = await fsp.stat(sessionDir).catch(() => undefined);
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error(`session path is not a directory: ${sessionDir}`);
    await fsp.rm(sessionDir, { recursive: true, force: true });
    forgetTranscriptSummary(path.join(sessionDir, "transcript.jsonl"));
    return true;
  }

  getInitialMessages(): Message[] {
    return this.resumedMessages.map(cloneMessage);
  }

  getDisplayEntries(): SessionDisplayEntry[] {
    if (!this.lazyDisplay) return this.displayEntries.map(cloneDisplayEntry);
    const entries: SessionDisplayEntry[] = [];
    const size = fs.existsSync(this.transcriptPath) ? fs.statSync(this.transcriptPath).size : 0;
    if (size) for (const line of reverseTranscriptLines(this.transcriptPath, size, this.displayStart)) {
      if (!line.text.trim()) continue;
      const entry = parseTranscriptEntry(line.text, this.transcriptPath, line.start);
      if (entry.agentId !== this.agentId) continue;
      const display = displayEntry(entry);
      if (display) entries.push(display);
    }
    return entries.reverse();
  }

  getDisplayCount(): number { return this.displayCount; }
  getDemoMode(): string | undefined { return this.demoMode; }
  getLastCompactOffset(): number { return this.lastCompactOffset; }

  /** Pages end at message boundaries. Tool result/use pairs are kept together across a page edge. */
  getDisplayPage(before?: number, limit = 100, maxBytes = 512 * 1024): SessionDisplayPage {
    checkSessionPaths(this.sessionDir);
    const stat = fs.existsSync(this.transcriptPath) ? fs.statSync(this.transcriptPath) : undefined;
    const size = stat?.size ?? 0;
    const epoch = `${stat?.ino ?? 0}:${stat?.birthtimeMs ?? 0}:${this.displayStart}`;
    let cursor = before ?? size;
    if (!Number.isSafeInteger(cursor) || cursor < this.displayStart || cursor > size) throw new Error("Invalid history cursor");
    const entries: SessionDisplayEntry[] = [], offsets: number[] = [], timings = new Map<string, TimingRecord>();
    const pendingTools = new Set<string>();
    let bytes = 0, scanned = 0;
    if (size) for (const line of reverseTranscriptLines(this.transcriptPath, cursor, this.displayStart)) {
      cursor = line.start; scanned += line.end - line.start;
      if (!line.text.trim()) continue;
      const entry = parseTranscriptEntry(line.text, this.transcriptPath, line.start);
      if (entry.agentId !== this.agentId) continue;
      if (entry.type === "timing" && isTimingRecord(entry.timing) && !timings.has(entry.timing.id)) timings.set(entry.timing.id, restoredTiming(entry.timing));
      const display = displayEntry(entry);
      if (display) {
        entries.push(display); offsets.push(line.start); bytes += line.end - line.start;
        if (entry.type === "message") for (const block of entry.message.blocks) {
          if (block.type === "tool_result") pendingTools.add(block.toolUseId);
          if (block.type === "tool_use") pendingTools.delete(block.id);
        }
      }
      if (((entries.length >= limit || bytes >= maxBytes) && !pendingTools.size) || (scanned >= 4 * 1024 * 1024 && !pendingTools.size)) break;
    }
    return { entries: entries.reverse(), offsets: offsets.reverse(), timings: [...timings.values()], before: cursor, hasMore: cursor > this.displayStart, epoch };
  }

  /** Separate transcript facts: never part of resumedMessages or the model context. */
  getExecutionState(): ExecutionState | undefined {
    return this.execution ? { ...this.execution } : undefined;
  }

  recordExecutionState(execution: ExecutionState): void {
    this.appendEntry({ type: "execution", sessionId: this.sessionId, agentId: this.agentId, execution });
    this.execution = { ...execution };
  }

  recordTiming(record: TimingRecord, runGeneration?: number): void {
    if (!isTimingRecord(record)) throw new Error("Invalid timing record");
    const timing = { ...record };
    this.appendEntry({ type: "timing", sessionId: this.sessionId, agentId: this.agentId, timing,
      ...(Number.isSafeInteger(runGeneration) && runGeneration! > 0 ? { runGeneration } : {}) });
    if (!this.lazyDisplay) this.timings.set(timing.id, timing);
  }

  getTimings(): TimingRecord[] {
    if (!this.lazyDisplay) return [...this.timings.values()].map(record => ({ ...record }));
    const records = new Map<string, TimingRecord>();
    const size = fs.existsSync(this.transcriptPath) ? fs.statSync(this.transcriptPath).size : 0;
    if (size) for (const line of reverseTranscriptLines(this.transcriptPath, size, this.displayStart)) {
      if (!line.text.trim()) continue;
      const entry = parseTranscriptEntry(line.text, this.transcriptPath, line.start);
      if (entry.agentId === this.agentId && entry.type === "timing" && !records.has(entry.timing.id)) records.set(entry.timing.id, restoredTiming(entry.timing));
    }
    return [...records.values()].reverse();
  }

  recordMessage(message: Message, provenance?: { runGeneration?: number }): void {
    if (!shouldPersistMessage(message)) return;
    const stored = cloneMessage(message);
    // Only explicit run output receives provenance; legacy/initial context stays untagged.
    const generation = provenance?.runGeneration;
    const run = Number.isSafeInteger(generation) && generation! > 0 ? { runGeneration: generation } : {};
    this.appendEntry({ type: "message", sessionId: this.sessionId, agentId: this.agentId, message: stored, ...run });
    if (stored.metadata?.displayOnly !== true) this.resumedMessages.push(stored);
    this.displayCount++;
    if (typeof stored.metadata?.demoMode === "string") this.demoMode = stored.metadata.demoMode;
    if (!this.lazyDisplay) this.displayEntries.push({ type: "message", message: cloneMessage(stored) });
  }

  /** @deprecated Prefer recordCompactCheckpoint so replacement history is one durable entry. */
  recordCompactBoundary(): void {
    const createdAt = new Date().toISOString();
    this.appendEntry({ type: "compact", sessionId: this.sessionId, agentId: this.agentId, createdAt });
    this.resumedMessages.length = 0;
    this.contentReplacements.length = 0;
    this.lastCompaction = undefined;
    this.displayCount++;
    if (!this.lazyDisplay) this.displayEntries.push({ type: "compact", createdAt });
  }

  recordCompactCheckpoint(messages: readonly Message[], reason?: CompactionReason, report?: CompactionReport): void {
    const replacementMessages = messages.filter(shouldPersistMessage).map(cloneMessage);
    const previousWindowId = this.windowId;
    const windowId = randomUUID();
    const createdAt = new Date().toISOString();
    const nextWindowNumber = this.windowNumber + 1;
    const nextReport = report ? cloneCompactionReport(report) : undefined;
    this.appendEntry({
      type: "compact",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt,
      replacementMessages,
      reason,
      ...(nextReport ? { report: cloneCompactionReport(nextReport) } : {}),
      windowNumber: nextWindowNumber,
      firstWindowId: this.firstWindowId,
      previousWindowId,
      windowId,
    });
    this.windowNumber = nextWindowNumber;
    this.previousWindowId = previousWindowId;
    this.windowId = windowId;
    this.resumedMessages.length = 0;
    this.resumedMessages.push(...replacementMessages.map(cloneMessage));
    this.contentReplacements.length = 0;
    this.lastCompaction = nextReport;
    this.displayCount++;
    if (!this.lazyDisplay) this.displayEntries.push({
      type: "compact",
      createdAt,
      reason,
      ...(nextReport ? { report: cloneCompactionReport(nextReport) } : {}),
    });
  }

  recordTitle(title: string, kind: SessionTitleKind = "initial"): void {
    const normalized = normalizeTitle(title);
    if (!normalized || (normalized === this.title && kind === this.titleKind)) return;
    this.appendEntry({ type: "title", sessionId: this.sessionId, agentId: this.agentId, title: normalized, kind, createdAt: new Date().toISOString() });
    this.title = normalized;
    this.titleKind = kind;
    if (kind === "initial") this.hasInitialTitle = true;
    if (kind === "refinement") {
      this.hasInitialTitle = true;
      this.hasTitleRefinement = true;
    }
  }

  getTitle(): string | undefined {
    return this.title;
  }

  getTitleState(): SessionTitleState {
    return {
      title: this.title,
      kind: this.titleKind,
      hasInitialTitle: this.hasInitialTitle,
      hasRefinement: this.hasTitleRefinement,
    };
  }

  getAppPrompt(): AppPromptValue | undefined {
    return this.appPrompt ? cloneAppPrompt(this.appPrompt) : undefined;
  }

  recordAppPrompt(appPrompt: AppPromptValue | null | undefined): void {
    const nextAppPrompt = appPrompt ? cloneAppPrompt(appPrompt) : undefined;
    this.appendEntry({
      type: "app-prompt",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt: new Date().toISOString(),
      ...(nextAppPrompt ? { appPrompt: nextAppPrompt } : {}),
    });
    this.appPrompt = nextAppPrompt;
  }

  getSessionPrompt(): SessionPromptState | undefined {
    return this.sessionPrompt ? { ...this.sessionPrompt } : undefined;
  }

  recordSessionPrompt(prompt: SessionPromptState): void {
    validateSessionPromptState(prompt);
    if (!prompt.revision.trim()) throw new Error("session prompt revision is required");
    const stored = { ...prompt };
    this.appendEntry({ type: "session-prompt", sessionId: this.sessionId, agentId: this.agentId, createdAt: new Date().toISOString(), prompt: stored });
    this.sessionPrompt = stored;
  }

  getModelSelectionCleared(): boolean { return this.modelSelectionCleared; }
  recordModelSelectionCleared(cleared: boolean): void {
    if (this.modelSelectionCleared === cleared) return;
    this.appendEntry({ type: "model-selection-cleared", sessionId: this.sessionId, agentId: this.agentId, cleared });
    this.modelSelectionCleared = cleared;
  }

  getFastMode(): boolean {
    return this.fastMode;
  }

  recordFastMode(enabled: boolean): void {
    const next = enabled === true;
    if (next === this.fastMode) return;
    this.appendEntry({
      type: "fast-mode",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt: new Date().toISOString(),
      enabled: next,
    });
    this.fastMode = next;
  }

  getContextWindowTokens(): number | undefined {
    return this.contextWindowTokens;
  }

  recordContextWindowTokens(tokens: number): void {
    if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("context window tokens must be a positive integer");
    if (tokens === this.contextWindowTokens) return;
    this.appendEntry({
      type: "context-window",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt: new Date().toISOString(),
      tokens,
    });
    this.contextWindowTokens = tokens;
  }

  recordContentReplacements(replacements: readonly ContentReplacementRecord[]): void {
    if (replacements.length === 0) return;
    const storedReplacements = replacements.map((replacement) => ({ ...replacement }));
    this.appendEntry({
      type: "content-replacement",
      sessionId: this.sessionId,
      agentId: this.agentId,
      replacements: storedReplacements,
    });
    this.contentReplacements.push(...storedReplacements);
  }

  reset(): void {
    const firstWindowId = randomUUID();
    this.appendEntry({ type: "reset", sessionId: this.sessionId, agentId: this.agentId, createdAt: new Date().toISOString() });
    this.resumedMessages.length = 0;
    this.execution = undefined;
    this.displayEntries.length = 0;
    this.displayCount = 0; this.demoMode = undefined;
    this.timings.clear();
    this.contentReplacements.length = 0;
    this.title = undefined;
    this.titleKind = undefined;
    this.hasInitialTitle = false;
    this.hasTitleRefinement = false;
    this.lastCompaction = undefined;
    this.windowNumber = 1;
    this.firstWindowId = firstWindowId;
    this.previousWindowId = undefined;
    this.windowId = firstWindowId;
  }

  snapshot(): SessionStoreSnapshot {
    return {
      updatedAt: this.updatedAt,
      createdAt: this.createdAt,
      sessionId: this.sessionId,
      sessionDir: this.sessionDir,
      transcriptPath: this.transcriptPath,
      title: this.title,
      titleKind: this.titleKind,
      hasInitialTitle: this.hasInitialTitle,
      hasTitleRefinement: this.hasTitleRefinement,
      resumedMessages: this.resumedMessages.length,
      contentReplacements: this.contentReplacements.length,
      fastMode: this.fastMode,
      ...(this.sessionPrompt ? { sessionPrompt: { ...this.sessionPrompt } } : {}),
      contextWindowTokens: this.contextWindowTokens,
      windowNumber: this.windowNumber,
      ...(this.lastCompaction ? { lastCompaction: cloneCompactionReport(this.lastCompaction) } : {}),
      firstWindowId: this.firstWindowId,
      previousWindowId: this.previousWindowId,
      windowId: this.windowId,
      ...(this.appPrompt ? { appPrompt: cloneAppPrompt(this.appPrompt) } : {}),
    };
  }

  /** Debounced cache, never a replacement for the fsynced transcript. */
  async flushResumeCache(): Promise<void> {
    if (!this.lazyDisplay || this.writeFailed || this.cacheInvalid) return;
    clearTimeout(this.cacheTimer); this.cacheTimer = undefined;
    const stat = fs.statSync(this.transcriptPath);
    if (transcriptStamp(stat) !== this.cacheSourceStamp) { this.cacheInvalid = true; return; }
    const state = JSON.parse(JSON.stringify({
      messages: this.resumedMessages, displayEntries: [], replacements: this.contentReplacements,
      entries: 0, displayStart: this.displayStart, displayCount: this.displayCount, demoMode: this.demoMode,
      lastCompactOffset: this.lastCompactOffset, execution: this.execution,
      title: this.title, titleKind: this.titleKind, hasInitialTitle: this.hasInitialTitle, hasTitleRefinement: this.hasTitleRefinement,
      appPrompt: this.appPrompt, sessionPrompt: this.sessionPrompt, fastMode: this.fastMode,
      modelSelectionCleared: this.modelSelectionCleared, contextWindowTokens: this.contextWindowTokens,
      lastCompaction: this.lastCompaction, windowNumber: this.windowNumber, firstWindowId: this.firstWindowId,
      previousWindowId: this.previousWindowId, windowId: this.windowId,
    }));
    this.cacheWrite = this.cacheWrite.catch(() => undefined).then(() => writeResumeCache(this.transcriptPath, this.agentId, state, stat));
    await this.cacheWrite;
  }

  private appendEntry(entry: SessionTranscriptEntry): void {
    if (this.writeFailed) throw new Error("Session transcript writes disabled after write failure; reopen the session");
    const text = JSON.stringify(entry) + "\n";
    checkSessionPaths(this.sessionDir);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    checkSessionPaths(this.sessionDir);
    let descriptor: number | undefined;
    let writtenStat: fs.Stats | undefined;
    try {
      descriptor = fs.openSync(this.transcriptPath, "a");
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink > 1) throw new Error("Unsafe session transcript");
      if (this.cacheSourceStamp ? transcriptStamp(stat) !== this.cacheSourceStamp : stat.size !== 0) this.cacheInvalid = true;
      fs.writeFileSync(descriptor, text, "utf8");
      fs.fsyncSync(descriptor);
      writtenStat = fs.fstatSync(descriptor);
      if (writtenStat.size !== stat.size + Buffer.byteLength(text)) this.cacheInvalid = true;
      this.cacheSourceStamp = transcriptStamp(writtenStat);
      this.updatedAt = new Date().toISOString();
      if (entry.type === "reset") { this.displayStart = stat.size + Buffer.byteLength(text); this.lastCompactOffset = -1; }
      if (entry.type === "compact") this.lastCompactOffset = stat.size;
      if (this.lazyDisplay) {
        clearTimeout(this.cacheTimer);
        this.cacheTimer = setTimeout(() => { void this.flushResumeCache().catch(() => undefined); }, 500);
        this.cacheTimer.unref();
      }
    } catch (error) {
      // Reopen to repair a partial tail; never turn it into a corrupt complete line.
      this.writeFailed = true;
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
          // Windows publishes last-write timestamps on close. Reject intervening appends/replacement.
          const closed = fs.statSync(this.transcriptPath);
          if (!writtenStat || closed.size !== writtenStat.size || closed.ino !== writtenStat.ino || (process.platform !== "win32" && closed.dev !== writtenStat.dev)) this.cacheInvalid = true;
          this.cacheSourceStamp = transcriptStamp(closed);
        }
        catch (error) { this.writeFailed = true; throw error; }
      }
    }
  }
}

interface LoadedTranscript {
  sourceStamp?: string;
  displayStart: number;
  displayCount: number;
  demoMode?: string;
  lastCompactOffset: number;
  execution?: ExecutionState;
  timings: Map<string, TimingRecord>;
  messages: Message[];
  displayEntries: SessionDisplayEntry[];
  replacements: ContentReplacementRecord[];
  entries: number;
  title?: string;
  titleKind?: SessionTitleKind;
  hasInitialTitle: boolean;
  hasTitleRefinement: boolean;
  appPrompt?: AppPromptValue;
  sessionPrompt?: SessionPromptState;
  fastMode: boolean;
  modelSelectionCleared?: boolean;
  contextWindowTokens?: number;
  lastCompaction?: CompactionReport;
  windowNumber: number;
  firstWindowId?: string;
  previousWindowId?: string;
  windowId?: string;
}

interface SessionSummaryWithUpdatedAtMs extends SessionSummary {
  updatedAt: string;
  updatedAtMs: number;
}

function isSessionSummaryWithUpdatedAtMs(summary: SessionSummaryWithUpdatedAtMs | undefined): summary is SessionSummaryWithUpdatedAtMs {
  return summary !== undefined;
}

async function findLatestSessionId(options: SessionStoreOptions): Promise<string | undefined> {
  const [latest] = await SessionStore.list({ cwd: options.cwd, rootDir: options.rootDir, agentId: options.agentId, limit: 1 });
  return latest?.sessionId;
}

interface LoadTranscriptOptions {
  lazyDisplay?: boolean;
  repairUnterminatedTail?: boolean;
}

async function loadTranscript(transcriptPath: string, agentId?: string, options: LoadTranscriptOptions = {}): Promise<LoadedTranscript> {
  const originalStat = await fsp.stat(transcriptPath).catch(() => undefined);
  if (options.lazyDisplay && agentId) {
    const cached = await readResumeCache<Omit<LoadedTranscript, "timings">>(transcriptPath, agentId);
    if (cached && Array.isArray(cached.messages) && Array.isArray(cached.replacements) && Number.isSafeInteger(cached.displayStart) && Number.isSafeInteger(cached.displayCount)) {
      return { ...cached, sourceStamp: originalStat && transcriptStamp(originalStat), displayEntries: [], timings: new Map() };
    }
  }
  const loaded = createEmptyLoadedTranscript();
  let lineNumber = 0;
  for await (const line of transcriptLines(transcriptPath)) {
    lineNumber++;
    if (!line.text.trim()) continue;
    let entry: SessionTranscriptEntry;
    try { entry = parseTranscriptEntry(line.text, transcriptPath, lineNumber); }
    catch (error) {
      // Repair only an incomplete last line, never silently discard a corrupt durable record.
      const handle = await fsp.open(transcriptPath, "r");
      let complete: boolean;
      try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, line.end - 1); complete = byte[0] === 10; }
      finally { await handle.close(); }
      if (complete || !options.repairUnterminatedTail) throw error;
      await truncateAndSync(transcriptPath, line.start); break;
    }
    if (agentId && entry.agentId !== agentId) continue;
    loaded.entries += 1;
    if (entry.type === "reset") {
      loaded.displayStart = line.end; loaded.displayCount = 0; loaded.demoMode = undefined; loaded.lastCompactOffset = -1;
      loaded.execution = undefined;
      loaded.messages.length = 0;
      loaded.displayEntries.length = 0;
      loaded.timings.clear();
      loaded.replacements.length = 0;
      loaded.title = undefined;
      loaded.titleKind = undefined;
      loaded.hasInitialTitle = false;
      loaded.hasTitleRefinement = false;
      loaded.lastCompaction = undefined;
      loaded.windowNumber = 1;
      loaded.firstWindowId = undefined;
      loaded.previousWindowId = undefined;
      loaded.windowId = undefined;
    }
    if (entry.type === "compact") {
      loaded.displayCount++; loaded.lastCompactOffset = line.start;
      if (loaded.execution) delete loaded.execution.resumeCompaction;
      loaded.messages.length = 0;
      loaded.replacements.length = 0;
      if (entry.replacementMessages) loaded.messages.push(...entry.replacementMessages.map(cloneMessage));
      const boundaryReport = entry.replacementMessages
        ?.slice()
        .reverse()
        .find((message) => message.metadata?.compactBoundary === true)
        ?.metadata?.compactionReport as CompactionReport | undefined;
      loaded.lastCompaction = entry.report
        ? cloneCompactionReport(entry.report)
        : boundaryReport ? cloneCompactionReport(boundaryReport) : undefined;
      if (!options.lazyDisplay) loaded.displayEntries.push({
        type: "compact",
        createdAt: entry.createdAt,
        reason: entry.reason,
        ...(loaded.lastCompaction ? { report: cloneCompactionReport(loaded.lastCompaction) } : {}),
      });
      if (entry.windowNumber !== undefined) loaded.windowNumber = entry.windowNumber;
      if (entry.firstWindowId) loaded.firstWindowId = entry.firstWindowId;
      loaded.previousWindowId = entry.previousWindowId;
      if (entry.windowId) loaded.windowId = entry.windowId;
    }
    if (entry.type === "execution" && isExecutionState(entry.execution)) loaded.execution = { ...entry.execution };
    if (entry.type === "timing") {
      if (!isTimingRecord(entry.timing)) throw new Error("Invalid persisted timing record");
      if (!options.lazyDisplay) loaded.timings.set(entry.timing.id, { ...entry.timing });
    }
    if (entry.type === "message") {
      const message = entry.message;
      loaded.displayCount++;
      if (typeof message.metadata?.demoMode === "string") loaded.demoMode = message.metadata.demoMode;
      if (message.metadata?.displayOnly !== true) loaded.messages.push(message);
      if (!options.lazyDisplay) loaded.displayEntries.push({ type: "message", message });
    }
    if (entry.type === "content-replacement") loaded.replacements.push(...entry.replacements);
    if (entry.type === "title") {
      const normalizedTitle = normalizeTitle(entry.title);
      if (normalizedTitle) {
        const kind = entry.kind ?? "initial";
        loaded.title = normalizedTitle;
        loaded.titleKind = kind;
        if (kind === "initial") loaded.hasInitialTitle = true;
        if (kind === "refinement") {
          loaded.hasInitialTitle = true;
          loaded.hasTitleRefinement = true;
        }
      }
    }
    if (entry.type === "app-prompt") loaded.appPrompt = entry.appPrompt ? cloneAppPrompt(entry.appPrompt) : undefined;
    if (entry.type === "session-prompt") {
      const prompt = entry.prompt;
      if (!prompt || typeof prompt.revision !== "string" || !prompt.revision.trim() || (prompt.content !== null && typeof prompt.content !== "string")) {
        throw new Error("invalid persisted session prompt");
      }
      validateSessionPromptState(prompt);
      loaded.sessionPrompt = { ...prompt };
    }
    if (entry.type === "fast-mode") loaded.fastMode = entry.enabled === true;
    if (entry.type === "model-selection-cleared") loaded.modelSelectionCleared = entry.cleared === true;
    if (entry.type === "context-window" && Number.isInteger(entry.tokens) && entry.tokens > 0) loaded.contextWindowTokens = entry.tokens;
  }
  // Normalize an otherwise valid unterminated final record before future append.
  const endStat = await fsp.stat(transcriptPath).catch(() => undefined);
  if (endStat?.size && options.repairUnterminatedTail) {
    const handle = await fsp.open(transcriptPath, "r"); const byte = Buffer.alloc(1);
    try { await handle.read(byte, 0, 1, endStat.size - 1); } finally { await handle.close(); }
    if (byte[0] !== 10) await appendAndSync(transcriptPath, "\n");
  }
  if (options.lazyDisplay && agentId) {
    const { timings: _timings, ...state } = loaded;
    await writeResumeCache(transcriptPath, agentId, state, originalStat);
  }
  loaded.sourceStamp = originalStat && transcriptStamp(originalStat);
  return loaded;
}

function displayEntry(entry: SessionTranscriptEntry): SessionDisplayEntry | undefined {
  if (entry.type === "message") return { type: "message", message: entry.message };
  if (entry.type !== "compact") return;
  const boundary = entry.replacementMessages?.slice().reverse().find(m => m.metadata?.compactBoundary === true);
  const report = entry.report ?? boundary?.metadata?.compactionReport as CompactionReport | undefined;
  return { type: "compact", createdAt: entry.createdAt, reason: entry.reason, ...(report ? { report: cloneCompactionReport(report) } : {}) };
}

function parseTranscriptEntry(line: string, transcriptPath: string, lineNumber: number): SessionTranscriptEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Malformed session transcript at ${transcriptPath}:${lineNumber}`, { cause: error });
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string" || typeof (value as { agentId?: unknown }).agentId !== "string") {
    throw new Error(`Invalid session transcript entry at ${transcriptPath}:${lineNumber}`);
  }
  return value as SessionTranscriptEntry;
}

async function appendAndSync(filePath: string, text: string): Promise<void> {
  const handle = await fsp.open(filePath, "a");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateAndSync(filePath: string, length: number): Promise<void> {
  const handle = await fsp.open(filePath, "r+");
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function createEmptyLoadedTranscript(): LoadedTranscript {
  return {
    displayStart: 0, displayCount: 0, lastCompactOffset: -1,
    messages: [],
    timings: new Map(),
    displayEntries: [],
    replacements: [],
    entries: 0,
    hasInitialTitle: false,
    hasTitleRefinement: false,
    fastMode: false,
    windowNumber: 1,
  };
}

function resolveSessionRoot(options: Pick<SessionStoreOptions, "cwd" | "rootDir">): string {
  if (options.rootDir) return path.resolve(options.rootDir);
  return path.join(getNeoctlHome(), "sessions");
}

function createSessionId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}

function cloneCompactionReport(report: CompactionReport): CompactionReport {
  return { ...report };
}

function cloneDisplayEntry(entry: SessionDisplayEntry): SessionDisplayEntry {
  if (entry.type === "message") return { type: "message", message: cloneMessage(entry.message) };
  return {
    type: "compact",
    createdAt: entry.createdAt,
    reason: entry.reason,
    ...(entry.report ? { report: cloneCompactionReport(entry.report) } : {}),
  };
}

function shouldPersistMessage(message: Message): boolean {
  if (message.role === "progress") return false;
  if (message.metadata?.systemInit === true) return false;
  return true;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}

function normalizeRequestedSessionId(sessionId: string | undefined): string | undefined {
  const normalized = sessionId?.trim();
  if (!normalized) return undefined;
  if (normalized === "." || normalized === ".." || /[\\/:*?"<>|\x00-\x1f]/u.test(normalized)
      || /[. ]$/u.test(normalized) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized)) {
    throw new Error("invalid session id: " + sessionId);
  }
  return normalized;
}

function cloneAppPrompt(appPrompt: AppPromptValue): AppPromptValue {
  return { ...appPrompt };
}

/** Caller-selected roots remain supported; check root/session boundaries, not ancestor aliases. */
function checkSessionPaths(sessionDir: string): void {
  checkSessionDirectory(path.dirname(sessionDir));
  checkSessionDirectory(sessionDir);
  try {
    const stat = fs.lstatSync(path.join(sessionDir, "transcript.jsonl"));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("Unsafe session transcript");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function checkSessionDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe session directory");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}
