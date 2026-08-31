import { createHash } from "node:crypto";
import type { PromptSection } from "../context/prompts.js";
import type { ToolDefinition } from "../tools/tool.js";
import type { Message, MessageBlock } from "../types/messages.js";
import type { PromptCacheDiagnostics, PromptCacheSectionMetric } from "../types/events.js";
import { estimateTextTokens } from "./context-metrics.js";
import { buildPromptCacheIdentity } from "./prompt-cache-key.js";

export interface BuildPromptCacheDiagnosticsInput {
  model?: string;
  systemPrompt: string;
  promptSections: readonly PromptSection[];
  tools: readonly ToolDefinition[];
  messages: readonly Message[];
}

export function buildPromptCacheDiagnostics(input: BuildPromptCacheDiagnosticsInput): PromptCacheDiagnostics {
  const promptSections = input.promptSections.map(sectionMetric);
  const toolsSerialized = serializeToolDefinitions(input.tools);
  const messagesSerialized = input.messages.map(serializeMessageForHash).join("\n");
  const identity = buildPromptCacheIdentity(input.systemPrompt, input.tools, input.model, input.messages);
  const implicitBreakpoints = input.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (message.role === "user" && !message.isMeta) || message.role === "tool_result");
  const currentBreakpoint = implicitBreakpoints.at(-1)?.index;
  const priorBreakpoint = implicitBreakpoints.at(-2)?.index;

  return {
    systemPromptHash: stableHash(input.systemPrompt),
    stableSystemPromptHash: stableHash(identity.stableSystemPrompt),
    dynamicSystemPromptHash: stableHash(identity.dynamicSystemPrompt),
    toolDefinitionsHash: stableHash(toolsSerialized),
    stablePrefixHash: identity.stablePrefixHash,
    promptCacheKey: identity.key,
    messagePrefixHash: stableHash(messagesSerialized),
    implicitBreakpointIndex: currentBreakpoint,
    implicitBreakpointHash: hashMessagesThrough(input.messages, currentBreakpoint),
    priorImplicitBreakpointHash: hashMessagesThrough(input.messages, priorBreakpoint),
    promptSections,
    stablePromptTokens: sumTokens(promptSections.filter((section) => section.cacheStable)),
    dynamicPromptTokens: sumTokens(promptSections.filter((section) => !section.cacheStable)),
    toolDefinitionTokens: estimateTextTokens(toolsSerialized),
    cacheablePrefixTokens: estimateTextTokens(identity.stableSystemPrompt) + estimateTextTokens(toolsSerialized) + estimateTextTokens(identity.stableRuntimeContext),
  };
}

function hashMessagesThrough(messages: readonly Message[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  return stableHash(messages.slice(0, index + 1).map(serializeMessageForHash).join("\n"));
}

function sectionMetric(section: PromptSection): PromptCacheSectionMetric {
  return {
    name: section.name,
    cacheStable: section.cacheStable !== false,
    estimatedTokens: estimateTextTokens(section.content),
    chars: section.content.length,
    hash: stableHash(section.content),
  };
}

function sumTokens(sections: readonly PromptCacheSectionMetric[]): number {
  return sections.reduce((total, section) => total + section.estimatedTokens, 0);
}

function serializeToolDefinitions(tools: readonly ToolDefinition[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: tool.strict ?? false,
  })));
}

function serializeMessageForHash(message: Message): string {
  return JSON.stringify({
    role: message.role,
    isMeta: message.isMeta === true,
    metadata: stableMetadataForHash(message.metadata),
    blocks: message.blocks.map(serializeBlockForHash),
  });
}

function serializeBlockForHash(block: MessageBlock): unknown {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking", text: block.text, signature: block.signature };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  if (block.type === "tool_result") return { type: "tool_result", toolUseId: block.toolUseId, name: block.name, ok: block.ok, output: block.output };
  return {
    type: "image",
    mimeType: block.mimeType,
    label: block.label,
    storage: block.storage,
    dataHash: block.data ? stableHash(block.data) : undefined,
  };
}

function stableMetadataForHash(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const ignored = new Set(["createdAt", "requestId"]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !ignored.has(key)).sort(([left], [right]) => left.localeCompare(right)));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
