import path from "node:path";
import { DefaultContextManager, type ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway, ModelUsage } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool, Tool, ToolUseContext } from "../tools/tool.js";
import type { AgentEvent } from "../types/events.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { AgentDefinition } from "../agents/agent-definition.js";
import { buildForkChildPrompt, EXPLORE_AGENT, FORK_AGENT } from "../agents/agent-definition.js";
import { AGENT_REPORT_TOOL_NAME, createAgentReportTool, type AgentReportOutput } from "../agents/agent-report-tool.js";
import type { AgentToolResult } from "../agents/local-agent-task.js";
import { SessionStore } from "../session/session-store.js";
import { query } from "./query.js";

export interface RunAgentDependencies {
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
  maxToolResultSerializedLength?: number;
  toolResultMemory?: ToolUseContext["toolResultMemory"];
  recordContentReplacements?: ToolUseContext["recordContentReplacements"];
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
  const initialMessages = options.existingMessages?.length
    ? [...options.existingMessages, ...buildResumeMessages(options)]
    : buildInitialAgentMessages(options);
  const childSession = await createChildAgentSession(options);
  if (childSession && !options.existingMessages?.length) {
    for (const message of initialMessages) childSession.recordMessage(message);
  }
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
    toolResultMemory: childSession?.toolResultMemory ?? options.dependencies.toolResultMemory ?? options.parentContext?.toolResultMemory,
    session: childSession ? { sessionId: childSession.sessionId, sessionDir: childSession.sessionDir } : options.parentContext?.session,
    recordContentReplacements: childSession
      ? (records: Parameters<NonNullable<ToolUseContext["recordContentReplacements"]>>[0]) => childSession.recordContentReplacements(records)
      : options.dependencies.recordContentReplacements ?? options.parentContext?.recordContentReplacements,
    secrets: options.parentContext?.secrets,
    secretRedactions: options.parentContext?.secretRedactions,
  };

  const runQuery = async function* (
    messages: Message[],
    maxTurns?: number,
    toolChoice?: { type: "function"; name: string },
  ): AsyncGenerator<AgentEvent, void, void> {
    for await (const event of query(messages, dependencies, {
      agentId: options.agentId,
      model: resolveAgentModel(options.agent, options.model),
      fallbackModel: options.fallbackModel,
      maxTurns,
      queryOrigin: "subagent",
      abortSignal: options.abortSignal,
      workspaceCwd: options.workspaceCwd,
      stopOnAgentReport: options.agent.requiresReport === true,
      agentReportToolName: options.agent.reportToolName,
      toolChoice,
    })) {
      if (event.type === "message") {
        agentMessages.push(event.message);
        childSession?.recordMessage(event.message);
      }
      if (event.type === "tool.started") totalToolUseCount += 1;
      if (event.type === "usage") lastUsage = event.usage;
      if (event.type === "terminal") terminalReason = event.reason;
      yield event;
    }
  };

  yield* runQuery(initialMessages, resolveSubagentMaxTurns(options));

  if (options.agent.requiresReport === true && !extractFinalAgentReport(agentMessages, options.agent.reportToolName)) {
    const retryTurns = options.agent.reportRetryTurns ?? 1;
    if (retryTurns > 0 && !options.abortSignal?.aborted) {
      const recoveryMessages = [...initialMessages, ...agentMessages, createTextMessage("user", buildReportRequiredReminder())];
      yield* runQuery(recoveryMessages, Math.max(2, retryTurns + 1), { type: "function", name: options.agent.reportToolName ?? AGENT_REPORT_TOOL_NAME });
    }
  }

  return {
    result: finalizeAgentTool({
      agentId: options.agentId,
      agentType: options.agent.agentType,
      agent: options.agent,
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

  if (!registry.get(AGENT_REPORT_TOOL_NAME)) {
    registry.register(createAgentReportTool());
  }

  return registry;
}

export function finalizeAgentTool(input: {
  agentId: string;
  agentType: string;
  agent?: AgentDefinition;
  messages: readonly Message[];
  durationMs: number;
  usage?: ModelUsage;
  totalToolUseCount?: number;
}): AgentToolResult {
  const report = extractFinalAgentReport(input.messages, input.agent?.reportToolName);
  const latestDraft = report ? undefined : extractLatestAgentReport(input.messages, input.agent?.reportToolName);
  const content = report?.report ?? latestDraft?.report ?? extractFinalText(input.messages);
  const totalToolUseCount = input.totalToolUseCount ?? countToolUses(input.messages);
  const validationError = !report && input.agentType === EXPLORE_AGENT.agentType
    ? validateExploreFinalText(content, totalToolUseCount)
    : undefined;
  const requiresReport = input.agent?.requiresReport === true;
  const missingRequiredReport = requiresReport && !report;

  return {
    agent_id: input.agentId,
    agent_type: input.agentType,
    content: missingRequiredReport
      ? formatMissingRequiredReportResult(content)
      : validationError
        ? formatIncompleteExploreResult(validationError, content)
        : content,
    status: missingRequiredReport ? "incomplete" : report?.status === "completed" || report?.status === "incomplete" ? report.status : undefined,
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

async function createChildAgentSession(options: RunAgentOptions): Promise<SessionStore | undefined> {
  const parentSession = options.parentContext?.session;
  if (!parentSession?.sessionDir) return undefined;
  return SessionStore.open({
    agentId: options.agentId,
    sessionId: options.agentId,
    rootDir: path.join(parentSession.sessionDir, "subagents"),
    resume: false,
  });
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
  return options.maxTurns;
}

function resolveAgentModel(agent: AgentDefinition, override?: string): string | undefined {
  if (override) return override;
  if (!agent.model || agent.model === "inherit") return undefined;
  return agent.model;
}

function buildReportRequiredReminder(): string {
  return [
    "REQUIRED FINALIZATION:",
    "",
    "You reached the end of your subagent run without submitting a final agent_report.",
    "Only agent_report content is visible to the parent as your report.",
    "You must now call agent_report with status='completed' or status='incomplete'.",
    "Do not continue investigating.",
    "Do not call any other tool unless agent_report is unavailable.",
    "Do not respond with normal assistant text.",
    "",
    "If your work is incomplete, blocked, or you would otherwise ask the parent a question, call agent_report with status='incomplete' and explain exactly what is blocking completion plus what was and was not done.",
  ].join("\n");
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

function extractFinalAgentReport(messages: readonly Message[], reportToolName = AGENT_REPORT_TOOL_NAME): AgentReportOutput | undefined {
  const report = extractLatestAgentReport(messages, reportToolName, { finalOnly: true });
  return report;
}

function extractLatestAgentReport(
  messages: readonly Message[],
  reportToolName = AGENT_REPORT_TOOL_NAME,
  options: { finalOnly?: boolean } = {},
): AgentReportOutput | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    for (const block of message.blocks) {
      if (block.type !== "tool_result" || block.name !== reportToolName || !block.ok) continue;
      const output = block.output;
      if (!output || typeof output !== "object") continue;
      const report = (output as { report?: unknown }).report;
      if (typeof report !== "string" || !report.trim()) continue;
      const rawStatus = (output as { status?: unknown }).status;
      const status = rawStatus === "completed" || rawStatus === "incomplete" ? rawStatus : "draft";
      const final = (output as { final?: unknown }).final === true || status === "completed" || status === "incomplete";
      if (options.finalOnly && !final) continue;
      return { report: report.trim(), status, final };
    }
  }
  return undefined;
}

function validateExploreFinalText(content: string, toolUseCount: number): string | undefined {
  const text = content.trim();
  if (!text) return "Explore agent returned empty content.";
  if (toolUseCount === 0) return "Explore agent completed without using any read-only inspection tools.";
  if (isProgressOnlyExploreText(text)) return "Explore agent returned progress-only text instead of a final report.";

  if (countMarkdownSections(text) < 3) {
    return "Explore agent final report is not structured with enough markdown sections.";
  }
  if (!hasListItem(text)) {
    return "Explore agent final report is missing list-based details.";
  }
  if (!hasLikelyFilePath(text)) {
    return "Explore agent final report is missing file path evidence.";
  }

  return undefined;
}

function countMarkdownSections(text: string): number {
  return text.match(/(?:^|\n)#{2,6}\s+\S/g)?.length ?? 0;
}

function hasListItem(text: string): boolean {
  return /(?:^|\n)\s*[-*]\s+\S/.test(text);
}

function hasLikelyFilePath(text: string): boolean {
  return /(?:^|\n)\s*[-*]\s+(?:[A-Za-z]:)?[^\n:]{0,160}(?:[\\/][^\n:]+|\.[A-Za-z0-9]{1,12})(?::|\s+-|\s+—|\s+–|\s|$)/.test(text);
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

function formatMissingRequiredReportResult(content: string): string {
  const lastOutput = content.trim() || "<empty>";
  return [
    "INCOMPLETE: Subagent ended without a final agent_report.",
    "",
    "## Protocol diagnostic",
    "- This agent is configured with requiresReport=true.",
    "- No final agent_report tool result was submitted, even after the runtime finalization turn.",
    "- The parent should treat this as an incomplete partial report, not a completed result.",
    "",
    "## Partial output",
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
