import { DefaultContextManager, type ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway, ModelUsage } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool, Tool, ToolUseContext } from "../tools/tool.js";
import type { AgentEvent } from "../types/events.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { AgentDefinition } from "../agents/agent-definition.js";
import { buildForkChildPrompt, FORK_AGENT } from "../agents/agent-definition.js";
import type { AgentToolResult } from "../agents/local-agent-task.js";
import { query } from "./query.js";

export interface RunAgentDependencies {
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
  maxToolResultSerializedLength?: number;
}

export interface RunAgentOptions {
  agentId: string;
  agent: AgentDefinition;
  prompt: string;
  parentContext?: ToolUseContext;
  parentMessages?: readonly Message[];
  dependencies: RunAgentDependencies;
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  fork?: boolean;
  existingMessages?: Message[];
}

export interface RunAgentCompleted {
  result: AgentToolResult;
  messages: Message[];
  terminalReason?: string;
}

export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent, RunAgentCompleted, void> {
  const startedAt = Date.now();
  const messages = options.existingMessages?.length
    ? [...options.existingMessages, ...buildResumeMessages(options)]
    : buildInitialAgentMessages(options);
  const agentMessages: Message[] = [];
  let terminalReason: string | undefined;
  let lastUsage: ModelUsage | undefined;

  const dependencies = {
    modelGateway: options.dependencies.modelGateway,
    tools: resolveAgentTools(options.dependencies.tools, options.agent),
    contextManager: createAgentContextManager(options),
    compactor: options.dependencies.compactor,
    contextBudget: options.dependencies.contextBudget,
    canUseTool: options.dependencies.canUseTool,
    maxToolResultSerializedLength: options.dependencies.maxToolResultSerializedLength,
  };

  for await (const event of query(messages, dependencies, {
    agentId: options.agentId,
    model: resolveAgentModel(options.agent, options.model),
    fallbackModel: options.fallbackModel,
    maxTurns: options.maxTurns ?? options.agent.maxTurns,
    queryOrigin: "subagent",
    abortSignal: options.abortSignal,
  })) {
    if (event.type === "message") agentMessages.push(event.message);
    if (event.type === "usage") lastUsage = event.usage;
    if (event.type === "terminal") terminalReason = event.reason;
    yield event;
  }

  return {
    result: finalizeAgentTool({
      agentId: options.agentId,
      agentType: options.agent.agentType,
      messages: agentMessages,
      durationMs: Date.now() - startedAt,
      usage: lastUsage,
    }),
    messages: agentMessages,
    terminalReason,
  };
}

export function resolveAgentTools(parentTools: ToolRegistry, agent: AgentDefinition): ToolRegistry {
  const registry = new ToolRegistry();
  const allowed = agent.tools;
  const disallowed = new Set(agent.disallowedTools ?? []);

  for (const tool of parentTools.list(undefined, { includeDeferred: true }) as Tool[]) {
    if (disallowed.has(tool.name)) continue;
    if (allowed && !allowed.includes("*") && !allowed.includes(tool.name)) continue;
    registry.register(tool);
  }

  return registry;
}

export function finalizeAgentTool(input: {
  agentId: string;
  agentType: string;
  messages: readonly Message[];
  durationMs: number;
  usage?: ModelUsage;
}): AgentToolResult {
  return {
    agent_id: input.agentId,
    agent_type: input.agentType,
    content: extractFinalText(input.messages),
    total_duration_ms: input.durationMs,
    total_tokens: input.usage?.totalTokens,
    total_tool_use_count: countToolUses(input.messages),
    usage: input.usage,
  };
}

function buildInitialAgentMessages(options: RunAgentOptions): Message[] {
  const prompt = options.fork ? buildForkChildPrompt(options.prompt) : options.prompt;
  const messages: Message[] = [];
  if (options.fork && options.parentMessages?.length) {
    messages.push(...options.parentMessages.map(cloneMessage));
  }
  if (options.agent.initialPrompt) messages.push(createTextMessage("user", options.agent.initialPrompt));
  messages.push(createTextMessage("user", prompt));
  return messages;
}

function buildResumeMessages(options: RunAgentOptions): Message[] {
  return [createTextMessage("user", `[Resumed] ${options.prompt}`)];
}

function createAgentContextManager(options: RunAgentOptions): ContextManager {
  const parent = options.dependencies.contextManager;
  if (!parent) return new DefaultContextManager({ cwd: options.parentContext?.appState.snapshot().cwd });

  return {
    async build(input) {
      const runtime = await parent.build({
        ...input,
        omitProjectMemory: options.agent.omitProjectMemory ?? input.omitProjectMemory,
        agentPrompt: options.agent.buildSystemPrompt?.(options.parentContext),
        agentPromptMode: options.agent.agentType === FORK_AGENT.agentType ? "proactive_append" : "replace",
      });
      return runtime;
    },
  };
}

function resolveAgentModel(agent: AgentDefinition, override?: string): string | undefined {
  if (override) return override;
  if (!agent.model || agent.model === "inherit") return undefined;
  return agent.model;
}

function extractFinalText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "assistant") continue;
    const text = messages[index].blocks
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function countToolUses(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.blocks.filter((block) => block.type === "tool_use").length, 0);
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    blocks: message.blocks.map((block) => ({ ...block })),
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}
