import fs from "node:fs/promises";
import path from "node:path";
import type { Message, MessageBlock } from "../types/messages.js";

export const TOOL_RESULTS_SUBDIR = "tool-results";
export const PERSISTED_OUTPUT_TAG = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSING_TAG = "</persisted-output>";
export const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";

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
  state: ContentReplacementState;
  processToolResult(toolUseId: string, output: unknown, thresholdChars?: number): Promise<{ output: unknown; record?: ContentReplacementRecord }>;
  applyBudget(messages: readonly Message[], options?: { maxSerializedLength?: number; skipToolNames?: ReadonlySet<string> }): Promise<{ messages: Message[]; records: ContentReplacementRecord[] }>;
}

export class FileToolResultMemory implements ToolResultMemory {
  readonly state: ContentReplacementState;
  private readonly thresholdChars: number;
  private readonly previewChars: number;
  private readonly toolResultsDir: string;

  constructor(private readonly options: ToolResultMemoryOptions, initialRecords: readonly ContentReplacementRecord[] = []) {
    this.thresholdChars = options.thresholdChars ?? 16000;
    this.previewChars = options.previewChars ?? 2000;
    this.toolResultsDir = path.join(options.sessionDir, TOOL_RESULTS_SUBDIR);
    this.state = createContentReplacementState(initialRecords);
  }

  async processToolResult(toolUseId: string, output: unknown, thresholdChars = this.thresholdChars): Promise<{ output: unknown; record?: ContentReplacementRecord }> {
    const existing = this.state.replacements.get(toolUseId);
    if (existing !== undefined) return { output: existing };

    const serialized = serializeToolOutput(output);
    if (serialized.length <= thresholdChars) return { output };

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

      const frozenSize = frozen.reduce((sum, candidate) => sum + candidate.size, 0);
      const freshSize = fresh.reduce((sum, candidate) => sum + candidate.size, 0);
      const selected = frozenSize + freshSize > maxSerializedLength
        ? selectFreshToReplace(fresh, frozenSize, maxSerializedLength)
        : [];
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
    const preview = generatePreview(serialized, this.previewChars);
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

function selectFreshToReplace(fresh: readonly ToolResultCandidate[], frozenSize: number, limit: number): ToolResultCandidate[] {
  const selected: ToolResultCandidate[] = [];
  let remaining = frozenSize + fresh.reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of [...fresh].sort((left, right) => right.size - left.size)) {
    if (remaining <= limit) break;
    selected.push(candidate);
    remaining -= candidate.size;
  }
  return selected;
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

export function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function safeToolUseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "tool-result";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
