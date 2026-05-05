import type { ToolUseContext } from "../tools/tool";

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
  buildSystemPrompt?: (context?: ToolUseContext) => string;
}

export const FORK_BOILERPLATE_TAG = "<fork-child-agent>";

export const FORK_AGENT: AgentDefinition = {
  agentType: "fork",
  whenToUse: "Fork the current conversation into an isolated worker for scoped parallel work.",
  tools: ["*"],
  model: "inherit",
  permissionMode: "bubble",
  maxTurns: 200,
  buildSystemPrompt: () => "",
};

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse: "General engineering worker for scoped implementation, investigation, or verification tasks.",
  tools: ["*"],
  permissionMode: "inherit",
  maxTurns: 12,
  buildSystemPrompt: () => [
    "You are a subagent worker inside the same TypeScript scaffold runtime.",
    "Stay within the assigned prompt. Use available tools when needed and return a concise final result.",
  ].join("\n"),
};

export interface AgentCatalog {
  resolve(agentType?: string): AgentDefinition;
  list(): AgentDefinition[];
}

export class StaticAgentCatalog implements AgentCatalog {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor(definitions: readonly AgentDefinition[] = [GENERAL_PURPOSE_AGENT]) {
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
