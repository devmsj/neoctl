import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "../types/messages.js";
import { getNeoctlHome } from "../paths.js";
import { FileToolResultMemory, type ContentReplacementRecord, type ToolResultMemory } from "./tool-result-memory.js";

export type SessionTitleKind = "initial" | "refinement";

export type SessionTranscriptEntry =
  | { type: "message"; sessionId: string; agentId: string; message: Message }
  | { type: "content-replacement"; sessionId: string; agentId: string; replacements: ContentReplacementRecord[] }
  | { type: "title"; sessionId: string; agentId: string; title: string; createdAt: string; kind?: SessionTitleKind }
  | { type: "compact"; sessionId: string; agentId: string; createdAt: string }
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
  private readonly contentReplacements: ContentReplacementRecord[];
  private title?: string;
  private titleKind?: SessionTitleKind;
  private hasInitialTitle = false;
  private hasTitleRefinement = false;

  private constructor(options: SessionStoreOptions, sessionId: string, loaded: LoadedTranscript) {
    this.agentId = options.agentId;
    this.sessionId = sessionId;
    this.sessionDir = path.join(resolveSessionRoot(options), sessionId);
    this.transcriptPath = path.join(this.sessionDir, "transcript.jsonl");
    this.resumedMessages = loaded.messages;
    this.contentReplacements = loaded.replacements;
    this.title = loaded.title;
    this.titleKind = loaded.titleKind;
    this.hasInitialTitle = loaded.hasInitialTitle;
    this.hasTitleRefinement = loaded.hasTitleRefinement;
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

  recordMessage(message: Message): void {
    if (!shouldPersistMessage(message)) return;
    this.appendEntry({ type: "message", sessionId: this.sessionId, agentId: this.agentId, message });
  }

  recordCompactBoundary(): void {
    this.resumedMessages.length = 0;
    this.contentReplacements.length = 0;
    this.appendEntry({ type: "compact", sessionId: this.sessionId, agentId: this.agentId, createdAt: new Date().toISOString() });
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
    this.contentReplacements.length = 0;
    this.title = undefined;
    this.titleKind = undefined;
    this.hasInitialTitle = false;
    this.hasTitleRefinement = false;
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
    };
  }

  private appendEntry(entry: SessionTranscriptEntry): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.appendFileSync(this.transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

interface LoadedTranscript {
  messages: Message[];
  replacements: ContentReplacementRecord[];
  entries: number;
  title?: string;
  titleKind?: SessionTitleKind;
  hasInitialTitle: boolean;
  hasTitleRefinement: boolean;
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
        loaded.replacements.length = 0;
        loaded.title = undefined;
        loaded.titleKind = undefined;
        loaded.hasInitialTitle = false;
        loaded.hasTitleRefinement = false;
      }
      if (entry.type === "compact") {
        loaded.messages.length = 0;
        loaded.replacements.length = 0;
      }
      if (entry.type === "message") loaded.messages.push(entry.message);
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
    } catch {
      // Skip malformed lines so a partial write does not make the session unusable.
    }
  }
  return loaded;
}

function createEmptyLoadedTranscript(): LoadedTranscript {
  return { messages: [], replacements: [], entries: 0, hasInitialTitle: false, hasTitleRefinement: false };
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
