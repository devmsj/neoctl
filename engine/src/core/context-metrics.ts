import type { ToolDefinition } from "../tools/tool.js";
import type { ContextMetrics } from "../types/events.js";
import type { Message, MessageBlock } from "../types/messages.js";
import { resolveContextWindowTokens } from "../model/context-window.js";

export function buildContextMetrics(input: {
  model?: string;
  messages: readonly Message[];
  systemPrompt: string;
  tools: readonly ToolDefinition[];
}): ContextMetrics {
  const serialized = [
    input.systemPrompt,
    ...input.messages.map(serializeMessageForMetrics),
    JSON.stringify(input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }))),
  ].join("\n");
  const estimatedChars = serialized.length;
  const estimatedInputTokens = estimateTextTokens(serialized);
  const window = resolveContextWindowTokens(input.model);
  return {
    model: input.model,
    estimatedInputTokens,
    estimatedChars,
    messageCount: input.messages.length,
    toolCount: input.tools.length,
    contextWindowTokens: window.tokens,
    contextWindowSource: window.source,
    contextUsageRatio: window.tokens ? estimatedInputTokens / window.tokens : undefined,
    modelMetadata: window.model
      ? {
          id: window.model.id,
          provider: window.model.provider,
          maxOutputTokens: window.model.maxOutputTokens,
          knowledgeCutoff: window.model.knowledgeCutoff,
          reasoning: window.model.reasoning,
          source: window.model.source,
        }
      : undefined,
  };
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let asciiRun = 0;

  for (const char of text) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      tokens += 1;
      continue;
    }
    if (/\s/.test(char)) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      continue;
    }
    asciiRun += 1;
  }

  tokens += Math.ceil(asciiRun / 4);
  return Math.max(1, tokens);
}

function serializeMessageForMetrics(message: Message): string {
  return `${message.role}: ${message.blocks.map(serializeBlockForMetrics).join("\n")}`;
}

function serializeBlockForMetrics(block: MessageBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.text;
  if (block.type === "tool_use") return `tool_use ${block.name} ${JSON.stringify(block.input)}`;
  return `tool_result ${block.name} ${JSON.stringify(block.output)}`;
}
