import { DefaultContextManager, type ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway, ModelUsage } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool, Tool, ToolUseContext } from "../tools/tool.js";
import type { AgentEvent } from "../types/events.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { AgentDefinition } from "../agents/agent-definition.js";
import { buildForkChildPrompt, EXPLORE_AGENT, FORK_AGENT } from "../agents/agent-definition.js";
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
  /** Resolved absolute cwd for file/exec tools in this subagent session. */
  workspaceCwd?: string;
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
  let totalToolUseCount = 0;

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
    maxTurns: resolveSubagentMaxTurns(options),
    queryOrigin: "subagent",
    abortSignal: options.abortSignal,
    workspaceCwd: options.workspaceCwd,
  })) {
    if (event.type === "message") agentMessages.push(event.message);
    if (event.type === "tool.started") totalToolUseCount += 1;
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
      totalToolUseCount,
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
  totalToolUseCount?: number;
}): AgentToolResult {
  const content = extractFinalText(input.messages);
  const totalToolUseCount = input.totalToolUseCount ?? countToolUses(input.messages);
  const validationError = input.agentType === EXPLORE_AGENT.agentType
    ? validateExploreFinalText(content, totalToolUseCount)
    : undefined;

  return {
    agent_id: input.agentId,
    agent_type: input.agentType,
    content: validationError ? formatIncompleteExploreResult(validationError, content) : content,
    total_duration_ms: input.durationMs,
    total_tokens: input.usage?.totalTokens,
    total_tool_use_count: totalToolUseCount,
    usage: input.usage,
  };
}

function shouldAppendAgentPrompt(agent: AgentDefinition): boolean {
  return agent.agentType === FORK_AGENT.agentType || agent.agentType === EXPLORE_AGENT.agentType;
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
  const inheritedCwd = options.workspaceCwd ?? options.parentContext?.appState.snapshot().cwd;
  if (!parent) return new DefaultContextManager({ cwd: inheritedCwd });

  return {
    async build(input) {
      const runtime = await parent.build({
        ...input,
        cwd: options.workspaceCwd ?? input.cwd,
        omitProjectMemory: options.agent.omitProjectMemory ?? input.omitProjectMemory,
        agentPrompt: options.agent.buildSystemPrompt?.(options.parentContext),
        agentPromptMode: shouldAppendAgentPrompt(options.agent) ? "proactive_append" : "replace",
      });
      return runtime;
    },
  };
}

function resolveSubagentMaxTurns(options: RunAgentOptions): number | undefined {
  if (options.maxTurns !== undefined) return options.maxTurns;
  const raw = process.env.AGENT_SUBAGENT_MAX_TURNS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return options.agent.maxTurns;
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

function validateExploreFinalText(content: string, toolUseCount: number): string | undefined {
  const text = content.trim();
  if (!text) return "Explore agent returned empty content.";
  if (toolUseCount === 0) return "Explore agent completed without using any read-only inspection tools.";
  if (isProgressOnlyExploreText(text)) return "Explore agent returned progress-only text instead of a final report.";

  const requiredSections = [
    /(?:^|\n)##\s*Scope\b/i,
    /(?:^|\n)##\s*Relevant files inspected\b/i,
    /(?:^|\n)##\s*Key findings\b/i,
    /(?:^|\n)##\s*Risks\s*\/\s*unknowns\b/i,
    /(?:^|\n)##\s*Suggested next steps\b/i,
  ];
  if (!requiredSections.every((pattern) => pattern.test(text))) {
    return "Explore agent final report is missing required sections.";
  }

  return undefined;
}

function isProgressOnlyExploreText(text: string): boolean {
  const progressPatterns = [
    /接下来/,
    /继续(?:读取|探索|检查|补齐)/,
    /我(?:会|将)继续/,
    /先补齐/,
    /I\s+will\s+continue/i,
    /next\s+I\s+will/i,
    /I\s+have\s+started/i,
    /continu(?:e|ing)\s+(?:to|with)/i,
  ];
  return progressPatterns.some((pattern) => pattern.test(text));
}

function formatIncompleteExploreResult(error: string, content: string): string {
  const lastOutput = content.trim() || "<empty>";
  return [
    `INCOMPLETE: ${error}`,
    "",
    "Last assistant output:",
    lastOutput,
  ].join("\n");
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
