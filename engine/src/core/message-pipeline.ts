import { createTextMessage, type Message, type MessageBlock } from "../types/messages.js";
import { buildImageRegistry, extractRegistryFromBoundary, mergeImageRegistries, type ImageRegistry } from "./image-registry.js";

export interface ToolResultBudgetOptions {
  maxSerializedLength?: number;
}

export function getMessagesAfterCompactBoundary(messages: readonly Message[]): Message[] {
  const lastBoundary = findLastIndex(messages, (message) => message.metadata?.compactBoundary === true);
  if (lastBoundary < 0) return [...messages];
  let start = lastBoundary;
  while (start > 0 && messages[start - 1].metadata?.compactPreservedUser === true) start -= 1;
  return messages.slice(start);
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
  const contextMessage = createUserContextMessage(userContext);
  if (!contextMessage) return [...messages];
  return [contextMessage, ...messages];
}

export function insertUserContextBeforeLatestUser<T extends object>(messages: readonly Message[], userContext: T): Message[] {
  const contextMessage = createUserContextMessage(userContext);
  if (!contextMessage) return [...messages];
  const latestUserIndex = findLastIndex(messages, (message) => message.role === "user" && !message.isMeta);
  if (latestUserIndex < 0) return [...messages, contextMessage];
  return [
    ...messages.slice(0, latestUserIndex),
    contextMessage,
    ...messages.slice(latestUserIndex),
  ];
}

export function createUserContextMessage<T extends object>(userContext: T): Message | undefined {
  const entries = Object.entries(userContext).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  const contextText = renderObjectEntries(entries);
  return {
    ...createTextMessage("user", `User context:\n${contextText}`),
    isMeta: true,
    metadata: { userContext: true },
  };
}

export function createRuntimeContextMessage<TUser extends object, TSystem extends object>(userContext: TUser, systemContext: TSystem): Message | undefined {
  const parts: string[] = [];
  const userEntries = Object.entries(userContext).filter(([, value]) => value !== undefined);
  const systemEntries = Object.entries(systemContext).filter(([, value]) => value !== undefined);
  if (userEntries.length > 0) parts.push(`User context:\n${renderObjectEntries(userEntries)}`);
  if (systemEntries.length > 0) parts.push(`System context:\n${renderObjectEntries(systemEntries)}`);
  if (parts.length === 0) return undefined;
  return {
    ...createTextMessage("user", parts.join("\n\n")),
    isMeta: true,
    metadata: { runtimeContext: true, userContext: userEntries.length > 0, systemContext: systemEntries.length > 0 },
  };
}

export function prependRuntimeContext<TUser extends object, TSystem extends object>(messages: readonly Message[], userContext: TUser, systemContext: TSystem): Message[] {
  const contextMessage = createRuntimeContextMessage(userContext, systemContext);
  if (!contextMessage) return [...messages];
  return [contextMessage, ...messages];
}

export function applyRuntimeContextForPromptCache<TUser extends object, TSystem extends object>(messages: readonly Message[], userContext: TUser, systemContext: TSystem): Message[] {
  const { stableSystemContext, dynamicSystemContext } = splitSystemContextForPromptCache(systemContext);
  const stableContext = createRuntimeContextMessage(userContext, stableSystemContext);
  const dynamicContext = createRuntimeContextMessage({}, dynamicSystemContext);
  const stableContextMessage = stableContext
    ? { ...stableContext, metadata: { ...stableContext.metadata, cacheStableRuntimeContext: true } }
    : undefined;
  const dynamicContextMessage = dynamicContext
    ? { ...dynamicContext, metadata: { ...dynamicContext.metadata, cacheStableRuntimeContext: false } }
    : undefined;
  const stableMessages = [stableContextMessage, ...messages].filter((message): message is Message => Boolean(message));
  if (!dynamicContextMessage) return stableMessages;
  const latestUserIndex = findLastIndex(stableMessages, (message) => message.role === "user" && !message.isMeta);
  if (latestUserIndex < 0) return [...stableMessages, dynamicContextMessage];
  return [
    ...stableMessages.slice(0, latestUserIndex),
    dynamicContextMessage,
    ...stableMessages.slice(latestUserIndex),
  ];
}

export function insertRuntimeContextBeforeLatestUser<TUser extends object, TSystem extends object>(messages: readonly Message[], userContext: TUser, systemContext: TSystem): Message[] {
  const contextMessage = createRuntimeContextMessage(userContext, systemContext);
  if (!contextMessage) return [...messages];
  const latestUserIndex = findLastIndex(messages, (message) => message.role === "user" && !message.isMeta);
  if (latestUserIndex < 0) return [...messages, contextMessage];
  return [
    ...messages.slice(0, latestUserIndex),
    contextMessage,
    ...messages.slice(latestUserIndex),
  ];
}

export function appendSystemContext<T extends object>(systemPrompt: string, systemContext: T): string {
  const entries = Object.entries(systemContext).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return systemPrompt;
  const rendered = renderObjectEntries(entries);
  return `${systemPrompt}\n\n## System Context\n${rendered}`;
}

function splitSystemContextForPromptCache<TSystem extends object>(systemContext: TSystem): { stableSystemContext: Record<string, unknown>; dynamicSystemContext: Record<string, unknown> } {
  const entries = Object.entries(systemContext).filter(([, value]) => value !== undefined);
  return {
    stableSystemContext: Object.fromEntries(entries.filter(([key]) => key !== "cwd")),
    dynamicSystemContext: Object.fromEntries(entries.filter(([key]) => key === "cwd")),
  };
}

function renderObjectEntries(entries: readonly [string, unknown][]): string {
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function buildStableToolResultPreview(serialized: string, maxSerializedLength: number): string {
  const previewLength = Math.max(0, maxSerializedLength - 120);
  return `[Tool result truncated for context budget: original ${serialized.length} chars, showing first ${previewLength} chars]\n${serialized.slice(0, previewLength)}`;
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/**
 * Build a complete ImageRegistry from the current message set,
 * merging any registry persisted in a compact boundary with images from recent messages.
 */
export function getImageRegistryFromMessages(messages: readonly Message[]): ImageRegistry {
  const metadataRegistry = extractImageRegistriesFromMetadata(messages);
  const boundaryRegistry = extractRegistryFromBoundary(messages);
  const currentRegistry = buildImageRegistry(messages);
  const previousRegistry = metadataRegistry.images.length > 0
    ? metadataRegistry
    : boundaryRegistry;
  return previousRegistry
    ? mergeImageRegistries(previousRegistry, currentRegistry)
    : currentRegistry;
}

function extractImageRegistriesFromMetadata(messages: readonly Message[]): ImageRegistry {
  let registry: ImageRegistry = { images: [] };
  for (const message of messages) {
    const candidate = message.metadata?.imageRegistry as ImageRegistry | undefined;
    if (!candidate?.images?.length) continue;
    registry = mergeImageRegistries(registry, candidate);
  }
  return registry;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
