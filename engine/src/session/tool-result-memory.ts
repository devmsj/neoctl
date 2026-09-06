import fs from "node:fs/promises";
import path from "node:path";
import type { Message, MessageBlock } from "../types/messages.js";

export const TOOL_RESULTS_SUBDIR = "tool-results";
export const PERSISTED_OUTPUT_TAG = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSING_TAG = "</persisted-output>";
export const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";
export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 48000;
export const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 8000;
export const MAX_TOOL_RESULT_BUDGET_CHARS = 200000;

export interface ContentReplacementState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export interface ContentReplacementRecord {
  kind: "tool-result";
  toolUseId: string;
  replacement: string;
}

export interface ToolResultMemoryOptions {
  sessionDir: string;
  thresholdChars?: number;
  previewChars?: number;
}

export interface PersistedToolResult {
  filepath: string;
  originalSize: number;
  isJson: boolean;
  preview: string;
  hasMore: boolean;
}

export interface ToolResultMemory {
  /** Effective per-result threshold, when provided by the implementation. */
  readonly thresholdChars?: number;
  state: ContentReplacementState;
  processToolResult(toolUseId: string, output: unknown, thresholdChars?: number): Promise<{ output: unknown; record?: ContentReplacementRecord }>;
  applyBudget(messages: readonly Message[], options?: { maxSerializedLength?: number; skipToolNames?: ReadonlySet<string> }): Promise<{ messages: Message[]; records: ContentReplacementRecord[] }>;
}

export class FileToolResultMemory implements ToolResultMemory {
  readonly state: ContentReplacementState;
  readonly thresholdChars: number;
  private readonly previewChars: number;
  private readonly toolResultsDir: string;

  constructor(private readonly options: ToolResultMemoryOptions, initialRecords: readonly ContentReplacementRecord[] = []) {
    this.thresholdChars = options.thresholdChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS;
    this.previewChars = options.previewChars ?? DEFAULT_TOOL_RESULT_PREVIEW_CHARS;
    this.toolResultsDir = path.join(options.sessionDir, TOOL_RESULTS_SUBDIR);
    this.state = createContentReplacementState(initialRecords);
  }

  async processToolResult(toolUseId: string, output: unknown, thresholdChars = this.thresholdChars): Promise<{ output: unknown; record?: ContentReplacementRecord }> {
    const existing = this.state.replacements.get(toolUseId);
    if (existing !== undefined) return { output: existing };

    const serialized = serializeToolOutput(output);
    if (serialized.length <= thresholdChars) {
      this.state.seenIds.add(toolUseId);
      return { output };
    }

    const persisted = await this.persistToolResult(toolUseId, output, serialized);
    const replacement = buildLargeToolResultMessage(persisted);
    this.state.seenIds.add(toolUseId);
    this.state.replacements.set(toolUseId, replacement);
    return {
      output: replacement,
      record: {
        kind: "tool-result",
        toolUseId,
        replacement,
      },
    };
  }

  async applyBudget(messages: readonly Message[], options: { maxSerializedLength?: number; skipToolNames?: ReadonlySet<string> } = {}): Promise<{ messages: Message[]; records: ContentReplacementRecord[] }> {
    const maxSerializedLength = options.maxSerializedLength ?? this.thresholdChars;
    const skipToolNames = options.skipToolNames ?? new Set<string>();
    const records: ContentReplacementRecord[] = [];
    const replacementMap = new Map<string, string>();
    const candidatesByGroup = collectCandidatesByGroup(messages, skipToolNames);

    for (const candidates of candidatesByGroup) {
      const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, this.state);

      for (const candidate of mustReapply) {
        replacementMap.set(candidate.toolUseId, candidate.replacement);
      }

      if (fresh.length === 0) {
        for (const candidate of candidates) this.state.seenIds.add(candidate.toolUseId);
        continue;
      }

      const selected = fresh.filter((candidate) => candidate.size > maxSerializedLength);
      const selectedIds = new Set(selected.map((candidate) => candidate.toolUseId));

      for (const candidate of candidates) {
        if (!selectedIds.has(candidate.toolUseId)) this.state.seenIds.add(candidate.toolUseId);
      }

      for (const candidate of selected) {
        this.state.seenIds.add(candidate.toolUseId);
        const persisted = await this.persistToolResult(candidate.toolUseId, candidate.output, candidate.serialized);
        const replacement = buildLargeToolResultMessage(persisted);
        this.state.replacements.set(candidate.toolUseId, replacement);
        replacementMap.set(candidate.toolUseId, replacement);
        records.push({ kind: "tool-result", toolUseId: candidate.toolUseId, replacement });
      }
    }

    if (replacementMap.size === 0) return { messages: [...messages], records };
    return {
      messages: replaceToolResultOutputs(messages, replacementMap),
      records,
    };
  }

  private async persistToolResult(toolUseId: string, output: unknown, serialized: string): Promise<PersistedToolResult> {
    await fs.mkdir(this.toolResultsDir, { recursive: true });
    const isJson = typeof output !== "string";
    const filepath = path.join(this.toolResultsDir, `${safeToolUseId(toolUseId)}.${isJson ? "json" : "txt"}`);
    try {
      await fs.writeFile(filepath, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }
    const previewSource = formatToolOutputPreview(output, serialized);
    const preview = generatePreview(previewSource, this.previewChars);
    return {
      filepath,
      originalSize: serialized.length,
      isJson,
      preview: preview.preview,
      hasMore: preview.hasMore,
    };
  }
}

export function createContentReplacementState(records: readonly ContentReplacementRecord[] = []): ContentReplacementState {
  return {
    seenIds: new Set(records.map((record) => record.toolUseId)),
    replacements: new Map(records.map((record) => [record.toolUseId, record.replacement])),
  };
}

export function reconstructContentReplacementState(messages: readonly Message[], records: readonly ContentReplacementRecord[]): ContentReplacementState {
  const state = createContentReplacementState(records);
  for (const message of messages) {
    if (message.role !== "tool_result") continue;
    for (const block of message.blocks) {
      if (block.type === "tool_result") state.seenIds.add(block.toolUseId);
    }
  }
  return state;
}

interface ToolResultCandidate {
  messageIndex: number;
  blockIndex: number;
  toolUseId: string;
  name: string;
  output: unknown;
  serialized: string;
  size: number;
}

interface CandidatePartition {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>;
  frozen: ToolResultCandidate[];
  fresh: ToolResultCandidate[];
}

function collectCandidatesByGroup(messages: readonly Message[], skipToolNames: ReadonlySet<string>): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = [];
  let current: ToolResultCandidate[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  messages.forEach((message, messageIndex) => {
    if (message.role === "assistant" || message.role === "user" || message.role === "system") flush();
    if (message.role !== "tool_result") return;

    message.blocks.forEach((block, blockIndex) => {
      if (block.type !== "tool_result") return;
      if (skipToolNames.has(block.name)) {
        flush();
        return;
      }
      const serialized = serializeToolOutput(block.output);
      if (isContentAlreadyPersisted(serialized) || serialized === TOOL_RESULT_CLEARED_MESSAGE || serialized.trim() === "") return;
      current.push({
        messageIndex,
        blockIndex,
        toolUseId: block.toolUseId,
        name: block.name,
        output: block.output,
        serialized,
        size: serialized.length,
      });
    });
  });

  flush();
  return groups;
}

function partitionByPriorDecision(candidates: readonly ToolResultCandidate[], state: ContentReplacementState): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (partition, candidate) => {
      const replacement = state.replacements.get(candidate.toolUseId);
      if (replacement !== undefined) {
        partition.mustReapply.push({ ...candidate, replacement });
      } else if (state.seenIds.has(candidate.toolUseId)) {
        partition.frozen.push(candidate);
      } else {
        partition.fresh.push(candidate);
      }
      return partition;
    },
    { mustReapply: [], frozen: [], fresh: [] },
  );
}

function replaceToolResultOutputs(messages: readonly Message[], replacementMap: ReadonlyMap<string, string>): Message[] {
  return messages.map((message) => {
    if (message.role !== "tool_result") return message;
    let changed = false;
    const blocks: MessageBlock[] = message.blocks.map((block) => {
      if (block.type !== "tool_result") return block;
      const replacement = replacementMap.get(block.toolUseId);
      if (replacement === undefined) return block;
      changed = true;
      return { ...block, output: replacement };
    });
    return changed ? { ...message, blocks, metadata: { ...message.metadata, toolResultPersisted: true } } : message;
  });
}

function isContentAlreadyPersisted(content: string): boolean {
  return content.startsWith(PERSISTED_OUTPUT_TAG);
}

export function buildLargeToolResultMessage(result: PersistedToolResult): string {
  return [
    PERSISTED_OUTPUT_TAG,
    `Output too large (${result.originalSize} chars). Full output saved to: ${result.filepath}`,
    "",
    `Preview (first ${result.preview.length} chars):`,
    result.preview,
    result.hasMore ? "..." : "",
    PERSISTED_OUTPUT_CLOSING_TAG,
  ].filter((line) => line !== undefined).join("\n");
}

function generatePreview(content: string, maxChars: number): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) return { preview: content, hasMore: false };
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}

function formatToolOutputPreview(output: unknown, fallback: string): string {
  if (typeof output === "string") return output;
  if (!isRecord(output)) return fallback;
  if (isReadOutputLike(output)) return formatReadOutputPreview(output);
  if (isGrepOutputLike(output)) return formatGrepOutputPreview(output);
  if (isTextEditOutputLike(output)) return formatTextEditOutputPreview(output);
  return fallback;
}

function isReadOutputLike(output: Record<string, unknown>): boolean {
  return typeof output.path === "string" && typeof output.content === "string" && typeof output.startLine === "number";
}

function formatReadOutputPreview(output: Record<string, unknown>): string {
  const lines = ["read result", `file: ${output.path}`];
  if (typeof output.startLine === "number" && typeof output.endLine === "number" && typeof output.totalLines === "number") {
    const more = [output.hasMoreBefore === true ? "more before" : undefined, output.hasMoreAfter === true ? "more after" : undefined]
      .filter((value): value is string => Boolean(value))
      .join(", ");
    lines.push(`range: lines ${output.startLine}-${output.endLine} of ${output.totalLines}${more ? ` (${more})` : ""}`);
  }
  lines.push("content:");
  lines.push(typeof output.content === "string" ? output.content.trimEnd() : "");
  return lines.join("\n");
}

function isTextEditOutputLike(output: Record<string, unknown>): boolean {
  return (
    typeof output.path === "string" &&
    typeof output.operation === "string" &&
    typeof output.replacements === "number" &&
    typeof output.bytesBefore === "number" &&
    typeof output.bytesAfter === "number" &&
    Array.isArray(output.patch)
  );
}

function formatTextEditOutputPreview(output: Record<string, unknown>): string {
  const operation = typeof output.operation === "string" ? output.operation : "write";
  const pathValue = typeof output.path === "string" ? output.path : "";
  const replacements = typeof output.replacements === "number" ? output.replacements : 0;
  const bytesBefore = typeof output.bytesBefore === "number" ? output.bytesBefore : undefined;
  const bytesAfter = typeof output.bytesAfter === "number" ? output.bytesAfter : undefined;
  const lineEnding = typeof output.lineEnding === "string" ? output.lineEnding : undefined;
  const encoding = typeof output.encoding === "string" ? output.encoding : undefined;
  const patch = Array.isArray(output.patch) ? output.patch.filter(isPatchHunkPreviewLike) : [];

  const lines = [
    `${operation} result`,
    `file: ${pathValue}`,
    `changes: ${replacements === 1 ? "1 replacement" : `${replacements} replacements`}`,
  ];
  const details = [
    bytesBefore !== undefined && bytesAfter !== undefined ? `${bytesBefore} -> ${bytesAfter} bytes` : undefined,
    lineEnding ? `line endings: ${lineEnding}` : undefined,
    encoding ? `encoding: ${encoding}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (details.length > 0) lines.push(details.join(" · "));

  if (patch.length > 0) {
    lines.push("patch:");
    for (const hunk of patch.slice(0, 3)) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines.slice(0, 12)) lines.push(line);
      if (hunk.lines.length > 12) lines.push(`... ${hunk.lines.length - 12} more patch lines`);
    }
    if (patch.length > 3) lines.push(`... ${patch.length - 3} more patch hunks`);
  } else {
    lines.push("patch: no changes");
  }
  return lines.join("\n");
}

function isPatchHunkPreviewLike(value: unknown): value is { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } {
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function isGrepOutputLike(output: Record<string, unknown>): boolean {
  return typeof output.query === "string" && Array.isArray(output.matches);
}

function formatGrepOutputPreview(output: Record<string, unknown>): string {
  const matches = Array.isArray(output.matches) ? output.matches.filter(isGrepMatchPreviewLike) : [];
  const returnedMatches = typeof output.returnedMatches === "number" ? output.returnedMatches : matches.length;
  const totalMatchesKnown = typeof output.totalMatchesKnown === "number" ? output.totalMatchesKnown : undefined;
  const transportTruncation = isRecord(output.transportTruncation) ? output.transportTruncation : undefined;
  const omittedMatches = typeof transportTruncation?.omittedMatches === "number" ? transportTruncation.omittedMatches : undefined;
  const countParts = [
    `${returnedMatches} shown`,
    totalMatchesKnown !== undefined ? `${totalMatchesKnown} known` : undefined,
    output.truncated === true ? "truncated" : undefined,
    omittedMatches !== undefined && omittedMatches > 0 ? `${omittedMatches} omitted` : undefined,
  ].filter((value): value is string => Boolean(value));

  const lines = [
    "grep result",
    `query: ${output.query}`,
  ];
  if (typeof output.grepPath === "string") lines.push(`path: ${output.grepPath}`);
  lines.push(`matches: ${countParts.join(" · ")}`);
  if (matches.length === 0) {
    lines.push("no matches");
    return lines.join("\n");
  }
  lines.push("results:");
  for (const match of matches) {
    const column = match.column !== undefined ? `:${match.column}` : "";
    lines.push(`  ${match.file}:${match.line}${column}: ${match.text}`);
  }
  return lines.join("\n");
}

function isGrepMatchPreviewLike(value: unknown): value is { file: string; line: number; column?: number; text: string } {
  if (!isRecord(value)) return false;
  return (
    typeof value.file === "string" &&
    typeof value.line === "number" &&
    typeof value.text === "string" &&
    (value.column === undefined || typeof value.column === "number")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function safeToolUseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "tool-result";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
