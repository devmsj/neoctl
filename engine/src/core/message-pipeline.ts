import { createTextMessage, type Message, type MessageBlock } from "../types/messages";

export interface ToolResultBudgetOptions {
  maxSerializedLength?: number;
}

export function getMessagesAfterCompactBoundary(messages: readonly Message[]): Message[] {
  const lastBoundary = findLastIndex(messages, (message) => message.metadata?.compactBoundary === true);
  if (lastBoundary < 0) return [...messages];
  return messages.slice(lastBoundary);
}

export function applyToolResultBudget(
  messages: readonly Message[],
  options: ToolResultBudgetOptions = {},
): Message[] {
  const maxSerializedLength = options.maxSerializedLength ?? 16000;
  return messages.map((message) => {
    if (message.role !== "tool_result") return message;
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== "tool_result") return block;
      const serialized = serializeToolOutput(block.output);
      if (serialized.length <= maxSerializedLength) return block;
      changed = true;
      return {
        ...block,
        output: buildStableToolResultPreview(serialized, maxSerializedLength),
      };
    });
    return changed ? { ...message, blocks, metadata: { ...message.metadata, budgeted: true } } : message;
  });
}

export function ensureToolResultPairing(messages: readonly Message[]): Message[] {
  const toolUses = new Map<string, { id: string; name: string; input: unknown }>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") toolUses.set(block.id, { id: block.id, name: block.name, input: block.input });
      if (block.type === "tool_result") toolResultIds.add(block.toolUseId);
    }
  }

  const knownToolUseIds = new Set(toolUses.keys());
  let changed = false;
  const repaired: Message[] = [];

  for (const message of messages) {
    const blocks = message.blocks.filter((block) => {
      if (block.type === "tool_result" && !knownToolUseIds.has(block.toolUseId)) {
        changed = true;
        return false;
      }
      return true;
    });

    if (blocks.length === 0) {
      changed = true;
      continue;
    }

    repaired.push(blocks.length === message.blocks.length ? message : { ...message, blocks, metadata: { ...message.metadata, pairingRepaired: true } });

    const missingResults = blocks
      .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => block.type === "tool_use" && !toolResultIds.has(block.id))
      .map((block) => ({
        type: "tool_result" as const,
        toolUseId: block.id,
        name: block.name,
        ok: false,
        output: `Tool call ${block.id} (${block.name}) did not have a recorded result. A synthetic failure result was inserted to keep model tool history valid.`,
      }));

    if (missingResults.length > 0) {
      changed = true;
      repaired.push({
        id: `synthetic-tool-result-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: "tool_result",
        createdAt: new Date().toISOString(),
        blocks: missingResults,
        isMeta: true,
        metadata: { syntheticToolResult: true, pairingRepaired: true },
      });
    }
  }

  return changed ? repaired : [...messages];
}

export function hasValidToolResultPairing(messages: readonly Message[]): boolean {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") toolUseIds.add(block.id);
      if (block.type === "tool_result") toolResultIds.add(block.toolUseId);
    }
  }
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) return false;
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) return false;
  }
  return true;
}

export function prependUserContext<T extends object>(messages: readonly Message[], userContext: T): Message[] {
  const entries = Object.entries(userContext).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return [...messages];
  const contextText = entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  return [
    {
      ...createTextMessage("user", `User context:\n${contextText}`),
      metadata: { userContext: true },
    },
    ...messages,
  ];
}

export function appendSystemContext<T extends object>(systemPrompt: string, systemContext: T): string {
  const entries = Object.entries(systemContext).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return systemPrompt;
  const rendered = entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  return `${systemPrompt}\n\n## System Context\n${rendered}`;
}

function buildStableToolResultPreview(serialized: string, maxSerializedLength: number): string {
  const previewLength = Math.max(0, maxSerializedLength - 120);
  return `[Tool result truncated for context budget: original ${serialized.length} chars, showing first ${previewLength} chars]\n${serialized.slice(0, previewLength)}`;
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
