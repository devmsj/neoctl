import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CompactionReason, CompactionReport } from "../context/compaction.js";
import type { AppPromptValue } from "../app/app-prompt.js";
import type { Message } from "../types/messages.js";
import { getNeoctlHome } from "../paths.js";
import { FileToolResultMemory, type ContentReplacementRecord, type ToolResultMemory } from "./tool-result-memory.js";

export type SessionTitleKind = "initial" | "refinement";

export type SessionTranscriptEntry =
  | { type: "message"; sessionId: string; agentId: string; message: Message }
  | { type: "content-replacement"; sessionId: string; agentId: string; replacements: ContentReplacementRecord[] }
  | { type: "title"; sessionId: string; agentId: string; title: string; createdAt: string; kind?: SessionTitleKind }
  | { type: "app-prompt"; sessionId: string; agentId: string; createdAt: string; appPrompt?: AppPromptValue }
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
  fastMode: boolean;
  contextWindowTokens?: number;
  windowNumber: number;
  lastCompaction?: CompactionReport;
  firstWindowId: string;
  previousWindowId?: string;
  windowId: string;
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
  private readonly agentId: string;
  private readonly resumedMessages: Message[];
  private readonly displayEntries: SessionDisplayEntry[];
  private readonly contentReplacements: ContentReplacementRecord[];
  private title?: string;
  private titleKind?: SessionTitleKind;
  private hasInitialTitle = false;
  private hasTitleRefinement = false;
  private appPrompt?: AppPromptValue;
  private fastMode = false;
  private contextWindowTokens?: number;
  private lastCompaction?: CompactionReport;
  private windowNumber: number;
  private firstWindowId: string;
  private previousWindowId?: string;
  private windowId: string;

  private constructor(options: SessionStoreOptions, sessionId: string, loaded: LoadedTranscript) {
    this.agentId = options.agentId;
    this.sessionId = sessionId;
    this.sessionDir = path.join(resolveSessionRoot(options), sessionId);
    this.transcriptPath = path.join(this.sessionDir, "transcript.jsonl");
    this.resumedMessages = loaded.messages;
    this.displayEntries = loaded.displayEntries;
    this.contentReplacements = loaded.replacements;
    this.title = loaded.title;
    this.titleKind = loaded.titleKind;
    this.hasInitialTitle = loaded.hasInitialTitle;
    this.hasTitleRefinement = loaded.hasTitleRefinement;
    this.appPrompt = loaded.appPrompt;
    this.fastMode = loaded.fastMode;
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
    const transcriptPath = path.join(sessionDir, "transcript.jsonl");
    const loaded = options.resume ? await loadTranscript(transcriptPath, options.agentId) : createEmptyLoadedTranscript();
    await fsp.mkdir(sessionDir, { recursive: true });
    return new SessionStore(options, sessionId, loaded);
  }

  static async list(options: SessionListOptions = {}): Promise<SessionSummary[]> {
    const root = resolveSessionRoot(options);
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const sessionId = entry.name;
          const sessionDir = path.join(root, sessionId);
          const transcriptPath = path.join(sessionDir, "transcript.jsonl");
          const stat = await fsp.stat(transcriptPath).catch(() => undefined);
          if (!stat) return undefined;
          const loaded = await loadTranscript(transcriptPath, options.agentId);
          const summary: SessionSummaryWithUpdatedAtMs = {
            sessionId,
            sessionDir,
            transcriptPath,
            updatedAt: stat.mtime.toISOString(),
            updatedAtMs: stat.mtimeMs,
            entryCount: loaded.entries,
            messages: loaded.messages.length,
            contentReplacements: loaded.replacements.length,
          };
          if (loaded.title) summary.title = loaded.title;
          return summary;
        }),
    );

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
    const stat = await fsp.stat(sessionDir).catch(() => undefined);
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error(`session path is not a directory: ${sessionDir}`);
    await fsp.rm(sessionDir, { recursive: true, force: true });
    return true;
  }

  getInitialMessages(): Message[] {
    return this.resumedMessages.map(cloneMessage);
  }

  getDisplayEntries(): SessionDisplayEntry[] {
    return this.displayEntries.map(cloneDisplayEntry);
  }

  recordMessage(message: Message): void {
    if (!shouldPersistMessage(message)) return;
    const stored = cloneMessage(message);
    this.resumedMessages.push(stored);
    this.displayEntries.push({ type: "message", message: cloneMessage(stored) });
    this.appendEntry({ type: "message", sessionId: this.sessionId, agentId: this.agentId, message });
  }

  /** @deprecated Prefer recordCompactCheckpoint so replacement history is one durable entry. */
  recordCompactBoundary(): void {
    const createdAt = new Date().toISOString();
    this.resumedMessages.length = 0;
    this.contentReplacements.length = 0;
    this.lastCompaction = undefined;
    this.displayEntries.push({ type: "compact", createdAt });
    this.appendEntry({ type: "compact", sessionId: this.sessionId, agentId: this.agentId, createdAt });
  }

  recordCompactCheckpoint(messages: readonly Message[], reason?: CompactionReason, report?: CompactionReport): void {
    const replacementMessages = messages.filter(shouldPersistMessage).map(cloneMessage);
    const previousWindowId = this.windowId;
    const windowId = randomUUID();
    const createdAt = new Date().toISOString();
    this.windowNumber += 1;
    this.previousWindowId = previousWindowId;
    this.windowId = windowId;
    this.resumedMessages.length = 0;
    this.resumedMessages.push(...replacementMessages.map(cloneMessage));
    this.contentReplacements.length = 0;
    this.lastCompaction = report ? cloneCompactionReport(report) : undefined;
    this.displayEntries.push({
      type: "compact",
      createdAt,
      reason,
      ...(this.lastCompaction ? { report: cloneCompactionReport(this.lastCompaction) } : {}),
    });
    this.appendEntry({
      type: "compact",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt,
      replacementMessages,
      reason,
      ...(this.lastCompaction ? { report: cloneCompactionReport(this.lastCompaction) } : {}),
      windowNumber: this.windowNumber,
      firstWindowId: this.firstWindowId,
      previousWindowId,
      windowId,
    });
  }

  recordTitle(title: string, kind: SessionTitleKind = "initial"): void {
    const normalized = normalizeTitle(title);
    if (!normalized || (normalized === this.title && kind === this.titleKind)) return;
    this.title = normalized;
    this.titleKind = kind;
    if (kind === "initial") this.hasInitialTitle = true;
    if (kind === "refinement") {
      this.hasInitialTitle = true;
      this.hasTitleRefinement = true;
    }
    this.appendEntry({ type: "title", sessionId: this.sessionId, agentId: this.agentId, title: normalized, kind, createdAt: new Date().toISOString() });
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
    this.appPrompt = appPrompt ? cloneAppPrompt(appPrompt) : undefined;
    this.appendEntry({
      type: "app-prompt",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt: new Date().toISOString(),
      ...(this.appPrompt ? { appPrompt: this.appPrompt } : {}),
    });
  }

  getFastMode(): boolean {
    return this.fastMode;
  }

  recordFastMode(enabled: boolean): void {
    const next = enabled === true;
    if (next === this.fastMode) return;
    this.fastMode = next;
    this.appendEntry({
      type: "fast-mode",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt: new Date().toISOString(),
      enabled: next,
    });
  }

  getContextWindowTokens(): number | undefined {
    return this.contextWindowTokens;
  }

  recordContextWindowTokens(tokens: number): void {
    if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("context window tokens must be a positive integer");
    if (tokens === this.contextWindowTokens) return;
    this.contextWindowTokens = tokens;
    this.appendEntry({
      type: "context-window",
      sessionId: this.sessionId,
      agentId: this.agentId,
      createdAt: new Date().toISOString(),
      tokens,
    });
  }

  recordContentReplacements(replacements: readonly ContentReplacementRecord[]): void {
    if (replacements.length === 0) return;
    this.contentReplacements.push(...replacements);
    this.appendEntry({
      type: "content-replacement",
      sessionId: this.sessionId,
      agentId: this.agentId,
      replacements: [...replacements],
    });
  }

  reset(): void {
    this.resumedMessages.length = 0;
    this.displayEntries.length = 0;
    this.contentReplacements.length = 0;
    this.title = undefined;
    this.titleKind = undefined;
    this.hasInitialTitle = false;
    this.hasTitleRefinement = false;
    this.lastCompaction = undefined;
    this.windowNumber = 1;
    this.firstWindowId = randomUUID();
    this.previousWindowId = undefined;
    this.windowId = this.firstWindowId;
    this.appendEntry({ type: "reset", sessionId: this.sessionId, agentId: this.agentId, createdAt: new Date().toISOString() });
  }

  snapshot(): SessionStoreSnapshot {
    return {
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
      contextWindowTokens: this.contextWindowTokens,
      windowNumber: this.windowNumber,
      ...(this.lastCompaction ? { lastCompaction: cloneCompactionReport(this.lastCompaction) } : {}),
      firstWindowId: this.firstWindowId,
      previousWindowId: this.previousWindowId,
      windowId: this.windowId,
      ...(this.appPrompt ? { appPrompt: cloneAppPrompt(this.appPrompt) } : {}),
    };
  }

  private appendEntry(entry: SessionTranscriptEntry): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.appendFileSync(this.transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

interface LoadedTranscript {
  messages: Message[];
  displayEntries: SessionDisplayEntry[];
  replacements: ContentReplacementRecord[];
  entries: number;
  title?: string;
  titleKind?: SessionTitleKind;
  hasInitialTitle: boolean;
  hasTitleRefinement: boolean;
  appPrompt?: AppPromptValue;
  fastMode: boolean;
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

async function loadTranscript(transcriptPath: string, agentId?: string): Promise<LoadedTranscript> {
  const text = await fsp.readFile(transcriptPath, "utf8").catch(() => "");
  const loaded = createEmptyLoadedTranscript();
  if (!text.trim()) return loaded;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionTranscriptEntry;
      if (agentId && "agentId" in entry && entry.agentId !== agentId) continue;
      loaded.entries += 1;
      if (entry.type === "reset") {
        loaded.messages.length = 0;
        loaded.displayEntries.length = 0;
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
        loaded.displayEntries.push({
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
      if (entry.type === "message") {
        const message = cloneMessage(entry.message);
        loaded.messages.push(message);
        loaded.displayEntries.push({ type: "message", message: cloneMessage(message) });
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
      if (entry.type === "fast-mode") loaded.fastMode = entry.enabled === true;
      if (entry.type === "context-window" && Number.isInteger(entry.tokens) && entry.tokens > 0) loaded.contextWindowTokens = entry.tokens;
    } catch {
      // Skip malformed lines so a partial write does not make the session unusable.
    }
  }
  return loaded;
}

function createEmptyLoadedTranscript(): LoadedTranscript {
  return {
    messages: [],
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
  return normalized ? normalized : undefined;
}

function cloneAppPrompt(appPrompt: AppPromptValue): AppPromptValue {
  return { ...appPrompt };
}
