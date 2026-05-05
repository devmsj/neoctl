import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "../types/messages";
import { FileToolResultMemory, type ContentReplacementRecord, type ToolResultMemory } from "./tool-result-memory";

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
    const sessionId = options.sessionId ?? createSessionId();
    const sessionDir = path.join(resolveSessionRoot(options), sessionId);
    const transcriptPath = path.join(sessionDir, "transcript.jsonl");
    const loaded = options.resume ? await loadTranscript(transcriptPath) : { messages: [], replacements: [] };
    await fsp.mkdir(sessionDir, { recursive: true });
    return new SessionStore(options, sessionId, loaded);
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

async function loadTranscript(transcriptPath: string): Promise<{ messages: Message[]; replacements: ContentReplacementRecord[] }> {
  const text = await fsp.readFile(transcriptPath, "utf8").catch(() => "");
  const messages: Message[] = [];
  const replacements: ContentReplacementRecord[] = [];
  if (!text.trim()) return { messages, replacements };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionTranscriptEntry;
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
  return { messages, replacements };
}

function resolveSessionRoot(options: SessionStoreOptions): string {
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
