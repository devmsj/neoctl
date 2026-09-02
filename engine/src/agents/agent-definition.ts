import type { ToolUseContext } from "../tools/tool.js";

export type AgentIsolation = "shared" | "worktree" | "remote";
export type AgentPermissionMode = "inherit" | "readonly" | "workspace-write" | "bubble";

export interface AgentDefinition {
  agentType: string;
  whenToUse: string;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  skills?: readonly string[];
  mcpServers?: readonly string[];
  color?: string;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high";
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  criticalSystemReminder?: string;
  requiredMcpServers?: readonly string[];
  background?: boolean;
  initialPrompt?: string;
  memory?: "user" | "project" | "local";
  isolation?: AgentIsolation;
  omitProjectMemory?: boolean;
  /** Require an authoritative final result via agent_report instead of normal assistant text. */
  requiresReport?: boolean;
  /** Report tool name used when requiresReport is enabled. Defaults to agent_report. */
  reportToolName?: string;
  /** Number of extra short turns allowed to recover a missing report. */
  reportRetryTurns?: number;
  buildSystemPrompt?: (context?: ToolUseContext) => string;
}

export const FORK_BOILERPLATE_TAG = "<fork-child-agent>";

export const FORK_AGENT: AgentDefinition = {
  agentType: "fork",
  whenToUse: "Fork the current conversation into an isolated worker for scoped parallel work.",
  tools: ["*"],
  disallowedTools: ["plan"],
  model: "inherit",
  permissionMode: "bubble",
  requiresReport: true,
  reportRetryTurns: 1,
  buildSystemPrompt: () => "",
};

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse: "General engineering worker for scoped implementation, investigation, or verification tasks.",
  tools: ["*"],
  disallowedTools: ["plan"],
  permissionMode: "inherit",
  requiresReport: true,
  reportRetryTurns: 1,
  buildSystemPrompt: () => [
    "You are a subagent worker inside the same neo runtime.",
    "Complete the assigned scope, then end with agent_report status='completed' or status='incomplete'.",
    "If blocked or out of scope, use status='incomplete' and include what was and was not done.",
  ].join("\n"),
};

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "explore",
  whenToUse: "Fast read-only codebase exploration: locate files, trace symbols, summarize architecture, and report findings without modifying anything.",
  tools: ["list", "read", "grep", "search", "exec_command", "write_stdin", "agent_report"],
  disallowedTools: ["edit", "write", "agent", "plan"],
  permissionMode: "readonly",
  requiresReport: true,
  reportRetryTurns: 1,
  buildSystemPrompt: () => [
    "You are a read-only codebase exploration subagent.",
    "Use read-only tools to inspect the assigned scope; do not edit files or spawn agents.",
    "End with agent_report status='completed' or status='incomplete'.",
    "Report files inspected, findings with file-path evidence, risks/unknowns, and next steps.",
  ].join("\n"),
};

export interface AgentCatalog {
  resolve(agentType?: string): AgentDefinition;
  list(): AgentDefinition[];
}

export class StaticAgentCatalog implements AgentCatalog {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor(definitions: readonly AgentDefinition[] = [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]) {
    for (const definition of definitions) this.definitions.set(definition.agentType, definition);
  }

  resolve(agentType?: string): AgentDefinition {
    if (!agentType) return this.definitions.get(GENERAL_PURPOSE_AGENT.agentType) ?? GENERAL_PURPOSE_AGENT;
    const definition = this.definitions.get(agentType);
    if (!definition) throw new Error(`Unknown agent type: ${agentType}`);
    return definition;
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.agentType.localeCompare(right.agentType));
  }
}

export function isForkChildContext(context: ToolUseContext): boolean {
  if (context.agentType === FORK_AGENT.agentType) return true;
  return Boolean(context.messages?.some((message) =>
    message.blocks.some((block) => block.type === "text" && block.text.includes(FORK_BOILERPLATE_TAG)),
  ));
}

export function buildForkChildPrompt(directive: string): string {
  return [
    FORK_BOILERPLATE_TAG,
    "You are a worker, not the main agent.",
    "Do not spawn subagents from this fork child.",
    "Do not ask follow-up questions. Stay strictly within the directive.",
    "Final report must start with `Scope:`.",
    "",
    directive,
  ].join("\n");
}
