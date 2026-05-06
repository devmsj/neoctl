import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "../types/messages.js";
import { FileToolResultMemory, type ContentReplacementRecord, type ToolResultMemory } from "./tool-result-memory.js";

export type SessionTranscriptEntry =
  | { type: "message"; sessionId: string; agentId: string; message: Message }
  | { type: "content-replacement"; sessionId: string; agentId: string; replacements: ContentReplacementRecord[] }
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

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  updatedAt?: string;
  entryCount: number;
  messages: number;
  contentReplacements: number;
}

export interface SessionStoreSnapshot {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  resumedMessages: number;
  contentReplacements: number;
}

export class SessionStore {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly transcriptPath: string;
  readonly toolResultMemory: ToolResultMemory;
  private readonly agentId: string;
  private readonly resumedMessages: Message[];
  private readonly contentReplacements: ContentReplacementRecord[];

  private constructor(options: SessionStoreOptions, sessionId: string, loaded: { messages: Message[]; replacements: ContentReplacementRecord[] }) {
    this.agentId = options.agentId;
    this.sessionId = sessionId;
    this.sessionDir = path.join(resolveSessionRoot(options), sessionId);
    this.transcriptPath = path.join(this.sessionDir, "transcript.jsonl");
    this.resumedMessages = loaded.messages;
    this.contentReplacements = loaded.replacements;
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
    const loaded = options.resume ? await loadTranscript(transcriptPath, options.agentId) : { messages: [], replacements: [] };
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
          return {
            sessionId,
            sessionDir,
            transcriptPath,
            updatedAt: stat.mtime.toISOString(),
            updatedAtMs: stat.mtimeMs,
            entryCount: loaded.entries,
            messages: loaded.messages.length,
            contentReplacements: loaded.replacements.length,
          };
        }),
    );

    return summaries
      .filter(isSessionSummaryWithUpdatedAtMs)
      .filter((summary) => !options.agentId || summary.entryCount > 0)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .slice(0, Math.max(0, options.limit ?? Number.POSITIVE_INFINITY))
      .map(({ updatedAtMs: _updatedAtMs, ...summary }) => summary);
  }

  getInitialMessages(): Message[] {
    return this.resumedMessages.map(cloneMessage);
  }

  recordMessage(message: Message): void {
    if (!shouldPersistMessage(message)) return;
    this.appendEntry({ type: "message", sessionId: this.sessionId, agentId: this.agentId, message });
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
    this.appendEntry({ type: "reset", sessionId: this.sessionId, agentId: this.agentId, createdAt: new Date().toISOString() });
  }

  snapshot(): SessionStoreSnapshot {
    return {
      sessionId: this.sessionId,
      sessionDir: this.sessionDir,
      transcriptPath: this.transcriptPath,
      resumedMessages: this.resumedMessages.length,
      contentReplacements: this.contentReplacements.length,
    };
  }

  private appendEntry(entry: SessionTranscriptEntry): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.appendFileSync(this.transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
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

async function loadTranscript(transcriptPath: string, agentId?: string): Promise<{ messages: Message[]; replacements: ContentReplacementRecord[]; entries: number }> {
  const text = await fsp.readFile(transcriptPath, "utf8").catch(() => "");
  const messages: Message[] = [];
  const replacements: ContentReplacementRecord[] = [];
  let entries = 0;
  if (!text.trim()) return { messages, replacements, entries };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionTranscriptEntry;
      if (agentId && "agentId" in entry && entry.agentId !== agentId) continue;
      entries += 1;
      if (entry.type === "reset") {
        messages.length = 0;
        replacements.length = 0;
      }
      if (entry.type === "message") messages.push(entry.message);
      if (entry.type === "content-replacement") replacements.push(...entry.replacements);
    } catch {
      // Skip malformed lines so a partial write does not make the session unusable.
    }
  }
  return { messages, replacements, entries };
}

function resolveSessionRoot(options: Pick<SessionStoreOptions, "cwd" | "rootDir">): string {
  if (options.rootDir) return path.resolve(options.rootDir);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return path.join(cwd, ".agent", "sessions");
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

function normalizeRequestedSessionId(sessionId: string | undefined): string | undefined {
  const normalized = sessionId?.trim();
  return normalized ? normalized : undefined;
}
