import { createTextMessage, type Message } from "../types/messages";

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
      const serialized = typeof block.output === "string" ? block.output : JSON.stringify(block.output);
      if (serialized.length <= maxSerializedLength) return block;
      changed = true;
      return {
        ...block,
        output: {
          truncated: true,
          originalLength: serialized.length,
          preview: serialized.slice(0, maxSerializedLength),
        },
      };
    });
    return changed ? { ...message, blocks, metadata: { ...message.metadata, budgeted: true } } : message;
  });
}

export function prependUserContext(messages: readonly Message[], userContext: Record<string, unknown>): Message[] {
  const entries = Object.entries(userContext);
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

export function appendSystemContext(systemPrompt: string, systemContext: Record<string, unknown>): string {
  const entries = Object.entries(systemContext);
  if (entries.length === 0) return systemPrompt;
  const rendered = entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  return `${systemPrompt}\n\n## System Context\n${rendered}`;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
