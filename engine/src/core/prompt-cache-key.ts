import { createHash } from "node:crypto";
import { splitSystemPromptPrefix } from "../context/prompts.js";
import type { ToolDefinition } from "../tools/tool.js";
import type { Message } from "../types/messages.js";

export interface PromptCacheIdentity {
  stableSystemPrompt: string;
  dynamicSystemPrompt: string;
  stableRuntimeContext: string;
  stablePrefixHash: string;
  key: string;
}

export function buildPromptCacheIdentity(
  systemPrompt: string | undefined,
  tools: readonly ToolDefinition[],
  model: string | undefined,
  messages: readonly Message[] = [],
): PromptCacheIdentity {
  const split = splitSystemPromptPrefix(systemPrompt ?? "");
  const stableRuntimeContext = serializeStableRuntimeContext(messages);
  const serializedTools = JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: tool.strict ?? false,
  })));
  const reusablePrefix = JSON.stringify({
    model: model ?? "",
    tools: serializedTools,
    system: split.stablePrefix,
    runtimeContext: stableRuntimeContext,
  });
  const stablePrefixHash = hash(reusablePrefix);
  return {
    stableSystemPrompt: split.stablePrefix,
    dynamicSystemPrompt: split.dynamicSuffix,
    stableRuntimeContext,
    stablePrefixHash,
    key: `neo-${stablePrefixHash}`,
  };
}

function serializeStableRuntimeContext(messages: readonly Message[]): string {
  const stableMessages = messages.filter((message, index) => index === 0 && message.metadata?.cacheStableRuntimeContext === true);
  return JSON.stringify(stableMessages.map((message) => ({ role: message.role, blocks: message.blocks })));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
