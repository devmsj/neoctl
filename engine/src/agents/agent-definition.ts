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
  /** Require an authoritative final result via subagent_report instead of normal assistant text. */
  requiresReport?: boolean;
  /** Report tool name used when requiresReport is enabled. Defaults to subagent_report. */
  reportToolName?: string;
  /** Number of extra short turns allowed to recover a missing report. */
  reportRetryTurns?: number;
  buildSystemPrompt?: (context?: ToolUseContext) => string;
}

export const SUBAGENT_COORDINATION_RULES = [
  "Communication boundary: you cannot communicate directly with sibling subagents, even if their names or IDs appear in the assignment or inherited history. Do not use subagent_message/list/get/output to contact or inspect siblings, and do not bypass this boundary through shared files, terminals, or other channels.",
  "The main agent is the sole coordinator. Send progress, questions, dependency blockers, and proposed interface changes to the main agent through subagent_report; do not claim a sibling has received or agreed to anything without a relayed confirmation from the main agent.",
  "Stay within the assigned goal, owned files/modules, allowed edits, exclusions, and agreed interface contracts. Do not modify another worker's scope or invent an unresolved contract. Report unclear ownership or missing inputs before dependent work.",
  "Use subagent_report status='draft' for non-blocking updates and continue only independent in-scope work. Draft reports do not pause execution. If a decision is required to proceed safely, use status='incomplete' with the precise question, evidence, and completed/untouched scope, then end this run; the main agent must explicitly resume you after deciding.",
  "Main-agent additions are delivered before a subsequent model request; apply them within the existing authorized scope. Report implementation and verification evidence rather than treating receipt of a message as completion.",
].join("\n");

export function buildSubagentSystemPrompt(agent: AgentDefinition, context?: ToolUseContext): string {
  return [agent.buildSystemPrompt?.(context), SUBAGENT_COORDINATION_RULES].filter(Boolean).join("\n\n");
}

export const FORK_BOILERPLATE_TAG = "<fork-child-agent>";

export const FORK_AGENT: AgentDefinition = {
  agentType: "fork",
  whenToUse: "Fork the current conversation into an isolated worker for scoped parallel work.",
  tools: ["*"],
  disallowedTools: ["plan_update"],
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
  disallowedTools: ["plan_update"],
  permissionMode: "inherit",
  requiresReport: true,
  reportRetryTurns: 1,
  buildSystemPrompt: () => [
    "You are a subagent worker inside the same neo runtime.",
    "Complete the assigned scope, then end with subagent_report status='completed' or status='incomplete'.",
    "If blocked or out of scope, use status='incomplete' and include what was and was not done.",
  ].join("\n"),
};

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "explore",
  whenToUse: "Fast read-only codebase exploration: locate files, trace symbols, summarize architecture, and report findings without modifying anything.",
  tools: ["file_list", "file_read", "file_search", "web_search", "terminal_run", "terminal_control", "subagent_report"],
  disallowedTools: ["file_edit", "file_write", "subagent_run", "plan_update"],
  permissionMode: "readonly",
  requiresReport: true,
  reportRetryTurns: 1,
  buildSystemPrompt: () => [
    "You are a read-only codebase exploration subagent.",
    "Use read-only tools to inspect the assigned scope; do not edit files or spawn agents.",
    "End with subagent_report status='completed' or status='incomplete'.",
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
