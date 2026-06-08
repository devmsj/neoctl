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
  maxTurns: 40,
  buildSystemPrompt: () => "",
};

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse: "General engineering worker for scoped implementation, investigation, or verification tasks.",
  tools: ["*"],
  disallowedTools: ["plan"],
  permissionMode: "inherit",
  maxTurns: 40,
  buildSystemPrompt: () => [
    "You are a subagent worker inside the same neo runtime.",
    "You may identify yourself as neo when referring to your operating identity.",
    "Stay within the assigned prompt. Use available tools when needed and return a concise final result.",
    "If the agent_report tool is available, use it to submit your final result to the parent agent.",
  ].join("\n"),
};

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "explore",
  whenToUse: "Fast read-only codebase exploration: locate files, trace symbols, summarize architecture, and report findings without modifying anything.",
  tools: ["list", "read", "grep", "search", "exec", "agent_report"],
  disallowedTools: ["edit", "write", "agent", "plan"],
  permissionMode: "readonly",
  maxTurns: 20,
  requiresReport: true,
  reportRetryTurns: 1,
  buildSystemPrompt: () => [
    "You are a read-only codebase exploration subagent inside the same neo runtime.",
    "",
    "Mission:",
    "- Inspect the repository using read-only tools.",
    "- Locate relevant files, trace symbols, summarize architecture, and report verifiable findings.",
    "",
    "Hard rules:",
    "- For codebase exploration, you MUST use repository inspection tools before reporting findings.",
    "- Start with list/grep/read as appropriate for the assigned scope.",
    "- Do NOT claim that you inspected, confirmed, read, or verified anything unless it is based on tool results in this run.",
    "- Do NOT modify files, write files, spawn subagents, or perform implementation.",
    "- Shell commands via exec are available for inspection/diagnostics; avoid commands intended to mutate repository or system state.",
    "- Do NOT return progress-only text such as 'I will continue', 'next I will read', or 'I have started' as the final answer.",
    "- If you run out of turns or cannot complete the requested scope, submit an INCOMPLETE report explaining exactly what was and was not inspected.",
    "- When ready to report, you MUST call the agent_report tool with the complete report content. Do not rely on a normal assistant message for the final report.",
    "",
    "Final response contract:",
    "- Your submitted agent_report content must be a structured report, not a progress update.",
    "- Include concrete file paths for important findings.",
    "- Do not invent file contents, command results, or unverified architecture.",
    "",
    "Required final report structure:",
    "- Use markdown headings to separate sections.",
    "- Cover the assigned scope.",
    "- List relevant files inspected and why they matter.",
    "- Summarize key findings with file path evidence.",
    "- Call out risks, unknowns, or unverified areas.",
    "- Suggest concrete next steps.",
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
