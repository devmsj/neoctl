import fs from "node:fs/promises";
import path from "node:path";
import type { Message, MessageBlock } from "../types/messages.js";
import { PERSISTED_OUTPUT_TAG } from "./tool-result-memory.js";
import type { SessionStoreSnapshot, SessionTranscriptEntry } from "./session-store.js";
import { resolveImageBlockDataLengthSync } from "../core/image-storage.js";

const DEFAULT_MAX_TOOL_RESULT_LINES = 500;

export interface SessionPromptExportSnapshot {
  model?: string;
  reasoning?: unknown;
  systemPrompt?: string;
  baseSystemPrompt?: string;
  promptSections?: unknown;
  appPrompt?: unknown;
  userContext?: unknown;
  systemContext?: unknown;
  userContextPrompt?: string;
  toolDefinitions?: unknown;
  commands?: readonly string[];
  agents?: readonly string[];
  skills?: readonly string[];
  plugins?: readonly string[];
}

export interface SessionMarkdownExportOptions {
  outputPath: string;
  session: SessionStoreSnapshot;
  agentId?: string;
  promptSnapshot?: SessionPromptExportSnapshot;
  engineSnapshot?: unknown;
  exportedAt?: string;
  maxToolResultLines?: number;
}

export interface SessionMarkdownExportResult {
  outputPath: string;
  bytes: number;
  entries: number;
  messages: number;
}

type ParsedTranscriptLine =
  | { lineNumber: number; ok: true; entry: SessionTranscriptEntry }
  | { lineNumber: number; ok: false; raw: string; error: string };

export async function writeSessionMarkdownExport(options: SessionMarkdownExportOptions): Promise<SessionMarkdownExportResult> {
  const outputPath = normalizeOutputPath(options.outputPath);
  const entries = await readTranscriptEntries(options.session.transcriptPath);
  const markdown = await renderSessionMarkdown({
    ...options,
    outputPath,
    entries,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    maxToolResultLines: options.maxToolResultLines ?? DEFAULT_MAX_TOOL_RESULT_LINES,
  });

  await ensureOutputParentDirectory(outputPath);
  await fs.writeFile(outputPath, markdown, "utf8");
  const stat = await fs.stat(outputPath);
  return {
    outputPath,
    bytes: stat.size,
    entries: entries.length,
    messages: entries.filter((line) => line.ok && line.entry.type === "message").length,
  };
}

function normalizeOutputPath(rawPath: string): string {
  const unquoted = stripSurroundingQuotes(rawPath.trim());
  if (!unquoted) throw new Error("/export requires an absolute markdown file path");
  if (!path.isAbsolute(unquoted)) throw new Error(`/export requires an absolute path: ${rawPath}`);
  return path.resolve(unquoted);
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

async function ensureOutputParentDirectory(outputPath: string): Promise<void> {
  const directory = path.dirname(outputPath);
  const parsed = path.parse(outputPath);
  if (directory === parsed.root) return;
  await fs.mkdir(directory, { recursive: true });
}

async function readTranscriptEntries(transcriptPath: string): Promise<ParsedTranscriptLine[]> {
  const text = await fs.readFile(transcriptPath, "utf8");
  const entries: ParsedTranscriptLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    try {
      entries.push({ lineNumber: index + 1, ok: true, entry: JSON.parse(raw) as SessionTranscriptEntry });
    } catch (error) {
      entries.push({
        lineNumber: index + 1,
        ok: false,
        raw,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries;
}

async function renderSessionMarkdown(input: SessionMarkdownExportOptions & { entries: ParsedTranscriptLine[]; maxToolResultLines: number }): Promise<string> {
  const lines: string[] = [];
  const title = input.session.title ? ` — ${input.session.title}` : "";
  lines.push(`# Neo Session Export${title}`);
  lines.push("");
  lines.push("## Export Metadata");
  lines.push(`- Exported at: ${input.exportedAt}`);
  lines.push(`- Agent: ${input.agentId ?? "<unknown>"}`);
  lines.push(`- Session ID: ${input.session.sessionId}`);
  if (input.session.title) lines.push(`- Session title: ${input.session.title}`);
  if (input.session.titleKind) lines.push(`- Session title kind: ${input.session.titleKind}`);
  lines.push(`- Session directory: ${inlineCode(input.session.sessionDir)}`);
  lines.push(`- Transcript: ${inlineCode(input.session.transcriptPath)}`);
  lines.push(`- Export file: ${inlineCode(input.outputPath)}`);
  lines.push(`- Transcript entries: ${input.entries.length}`);
  lines.push(`- Messages: ${input.entries.filter((line) => line.ok && line.entry.type === "message").length}`);
  lines.push(`- Tool result display cap: ${input.maxToolResultLines} lines per tool result`);
  lines.push("");

  renderPromptSnapshot(lines, input.promptSnapshot);
  renderJsonSection(lines, "Engine Snapshot", input.engineSnapshot);

  lines.push("---");
  lines.push("");
  lines.push("## Transcript");
  lines.push("");

  for (let index = 0; index < input.entries.length; index += 1) {
    const line = input.entries[index];
    lines.push("---");
    lines.push("");
    lines.push(`## Entry ${index + 1} (transcript line ${line.lineNumber})`);
    lines.push("");
    if (!line.ok) {
      lines.push("- Type: malformed JSONL entry");
      lines.push(`- Error: ${line.error}`);
      lines.push("");
      lines.push(fenced(line.raw, "json"));
      lines.push("");
      continue;
    }
    await renderTranscriptEntry(lines, line.entry, input.session.sessionDir, input.maxToolResultLines);
  }

  return `${lines.join("\n").replace(/[ \t]+$/gm, "")}\n`;
}

function renderPromptSnapshot(lines: string[], snapshot: SessionPromptExportSnapshot | undefined): void {
  lines.push("## Prompt Context Snapshot");
  lines.push("");
  if (!snapshot) {
    lines.push("No prompt context snapshot was available at export time.");
    lines.push("");
    return;
  }

  lines.push("### Model Settings");
  lines.push(`- Model: ${snapshot.model ?? "<default>"}`);
  lines.push(`- Reasoning: ${formatInlineValue(snapshot.reasoning ?? "<default>")}`);
  lines.push("");

  if (snapshot.systemPrompt !== undefined) {
    lines.push("### Effective System Prompt");
    lines.push("");
    lines.push(fenced(snapshot.systemPrompt, "text"));
    lines.push("");
  }
  if (snapshot.baseSystemPrompt !== undefined && snapshot.baseSystemPrompt !== snapshot.systemPrompt) {
    lines.push("### Base System Prompt (before runtime system context)");
    lines.push("");
    lines.push(fenced(snapshot.baseSystemPrompt, "text"));
    lines.push("");
  }
  if (snapshot.userContextPrompt !== undefined) {
    lines.push("### Injected User Context Prompt");
    lines.push("");
    lines.push(fenced(snapshot.userContextPrompt, "text"));
    lines.push("");
  }

  renderJsonSection(lines, "Prompt Sections", snapshot.promptSections);
  renderJsonSection(lines, "App Prompt", snapshot.appPrompt);
  renderJsonSection(lines, "System Context", snapshot.systemContext);
  renderJsonSection(lines, "User Context", snapshot.userContext);
  renderJsonSection(lines, "Tool Definitions", snapshot.toolDefinitions);
  renderJsonSection(lines, "REPL Commands", snapshot.commands);
  renderJsonSection(lines, "Agents", snapshot.agents);
  renderJsonSection(lines, "Skills", snapshot.skills);
  renderJsonSection(lines, "Plugins", snapshot.plugins);
}

function renderJsonSection(lines: string[], title: string, value: unknown): void {
  if (value === undefined) return;
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(fenced(stableStringify(value), "json"));
  lines.push("");
}

async function renderTranscriptEntry(lines: string[], entry: SessionTranscriptEntry, sessionDir: string, maxToolResultLines: number): Promise<void> {
  lines.push(`- Type: ${entry.type}`);
  lines.push(`- Agent: ${"agentId" in entry ? entry.agentId : "<unknown>"}`);
  lines.push(`- Session: ${"sessionId" in entry ? entry.sessionId : "<unknown>"}`);

  if (entry.type === "message") {
    renderMessageHeader(lines, entry.message);
    for (let index = 0; index < entry.message.blocks.length; index += 1) {
      await renderMessageBlock(lines, entry.message.blocks[index], index + 1, sessionDir, maxToolResultLines);
    }
    return;
  }

  if (entry.type === "content-replacement") {
    lines.push("");
    lines.push("### Content Replacements");
    lines.push("");
    lines.push(fenced(stableStringify(entry.replacements), "json"));
    lines.push("");
    return;
  }

  if (entry.type === "title") {
    lines.push(`- Created at: ${entry.createdAt}`);
    lines.push(`- Kind: ${entry.kind ?? "initial"}`);
    lines.push(`- Title: ${entry.title}`);
    lines.push("");
    return;
  }

  if (entry.type === "compact" || entry.type === "reset") {
    lines.push(`- Created at: ${entry.createdAt}`);
    if (entry.type === "compact") {
      if (entry.reason) lines.push(`- Reason: ${entry.reason}`);
      if (entry.report) {
        lines.push("");
        lines.push("### Compaction Report");
        lines.push("");
        lines.push(fenced(stableStringify(entry.report), "json"));
      }
    }
    lines.push("");
  }
}

function renderMessageHeader(lines: string[], message: Message): void {
  lines.push(`- Message role: ${message.role}`);
  lines.push(`- Message ID: ${message.id}`);
  lines.push(`- Created at: ${message.createdAt}`);
  if (message.providerMessageId) lines.push(`- Provider message ID: ${message.providerMessageId}`);
  if (message.requestId) lines.push(`- Request ID: ${message.requestId}`);
  if (message.isMeta !== undefined) lines.push(`- Meta message: ${message.isMeta}`);
  if (message.isApiErrorMessage !== undefined) lines.push(`- API error message: ${message.isApiErrorMessage}`);
  if (message.usage !== undefined) {
    lines.push("- Usage:");
    lines.push(indentBlock(stableStringify(message.usage), "  "));
  }
  if (message.metadata !== undefined) {
    lines.push("- Metadata:");
    lines.push(indentBlock(stableStringify(message.metadata), "  "));
  }
  lines.push("");
}

async function renderMessageBlock(lines: string[], block: MessageBlock, index: number, sessionDir: string, maxToolResultLines: number): Promise<void> {
  lines.push(`### Block ${index}: ${block.type}`);
  lines.push("");

  if (block.type === "text") {
    lines.push(fenced(block.text, "text"));
    lines.push("");
    return;
  }

  if (block.type === "thinking") {
    lines.push("Stored model thinking/reasoning block:");
    if (block.signature) lines.push(`- Signature: ${block.signature}`);
    lines.push("");
    lines.push(fenced(block.text, "text"));
    lines.push("");
    return;
  }

  if (block.type === "tool_use") {
    lines.push(`- Tool: ${block.name}`);
    lines.push(`- Tool use ID: ${block.id}`);
    lines.push("");
    lines.push("Input:");
    lines.push(fenced(stableStringify(block.input), "json"));
    lines.push("");
    return;
  }

  if (block.type === "tool_result") {
    lines.push(`- Tool: ${block.name}`);
    lines.push(`- Tool use ID: ${block.toolUseId}`);
    lines.push(`- OK: ${block.ok}`);
    lines.push("");
    const output = await renderToolResultOutput(block.output, sessionDir, maxToolResultLines);
    if (output.sourcePath) lines.push(`- Persisted full output source: ${inlineCode(output.sourcePath)}`);
    if (output.truncated) lines.push(`- Truncated: showing first ${output.shownLines} of ${output.totalLines} lines`);
    lines.push("Output:");
    lines.push(fenced(output.text, output.language));
    lines.push("");
    return;
  }

  if (block.type === "image") {
    lines.push(`- MIME type: ${block.mimeType}`);
    if (block.label) lines.push(`- Label: ${block.label}`);
    lines.push(`- Data bytes (base64 chars): ${resolveImageBlockDataLengthSync(block)}`);
    lines.push("- Data omitted from markdown body for readability.");
    lines.push("");
  }
}

async function renderToolResultOutput(output: unknown, sessionDir: string, maxLines: number): Promise<{ text: string; language: string; truncated: boolean; shownLines: number; totalLines: number; sourcePath?: string }> {
  const persistedPath = typeof output === "string" ? extractPersistedOutputPath(output) : undefined;
  if (persistedPath) {
    const sourcePath = path.isAbsolute(persistedPath) ? persistedPath : path.resolve(sessionDir, persistedPath);
    const persisted = await fs.readFile(sourcePath, "utf8").catch(() => undefined);
    if (persisted !== undefined) {
      const text = maybePrettyJson(persisted);
      const limited = limitLines(text, maxLines);
      return { ...limited, language: looksLikeJson(text) ? "json" : "text", sourcePath };
    }
  }

  const text = typeof output === "string" ? output : stableStringify(output);
  const limited = limitLines(text, maxLines);
  return { ...limited, language: typeof output === "string" && !looksLikeJson(text) ? "text" : "json", sourcePath: persistedPath };
}

function extractPersistedOutputPath(output: string): string | undefined {
  if (!output.startsWith(PERSISTED_OUTPUT_TAG)) return undefined;
  const match = /^Output too large \([^\n]+\)\. Full output saved to:\s*(.+)$/m.exec(output);
  return match?.[1]?.trim();
}

function maybePrettyJson(text: string): string {
  if (!looksLikeJson(text)) return text;
  try {
    return stableStringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function limitLines(text: string, maxLines: number): { text: string; truncated: boolean; shownLines: number; totalLines: number } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false, shownLines: lines.length, totalLines: lines.length };
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    shownLines: maxLines,
    totalLines: lines.length,
  };
}

function fenced(content: string, language: string): string {
  const fence = chooseFence(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

function chooseFence(content: string): string {
  const matches = content.match(/`{3,}/g) ?? [];
  const max = matches.reduce((value, match) => Math.max(value, match.length), 2);
  return "`".repeat(max + 1);
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function indentBlock(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function formatInlineValue(value: unknown): string {
  if (typeof value === "string") return value;
  return inlineCode(stableStringify(value));
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return nested.toString();
    if (typeof nested === "function") return `[Function ${nested.name || "anonymous"}]`;
    if (nested instanceof Set) return [...nested];
    if (nested instanceof Map) return Object.fromEntries(nested.entries());
    if (nested && typeof nested === "object") {
      if (seen.has(nested)) return "[Circular]";
      seen.add(nested);
    }
    return nested;
  }, 2);
}
