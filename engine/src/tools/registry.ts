import { DEFAULT_TOOL_RESULT_BUDGET_CHARS, MAX_TOOL_RESULT_BUDGET_CHARS } from "../session/tool-result-memory.js";
import type { JsonSchema, Tool, ToolDefinition, ToolUseContext } from "./tool.js";
import { resolveToolDescription } from "./tool.js";

export interface ToolPoolOptions {
  mode?: "default" | "simple" | "repl";
  denyTools?: readonly string[];
  includeDeferred?: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>();
  private readonly aliases = new Map<string, string>();

  register(tool: Tool<any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      if (!this.aliases.has(alias)) this.aliases.set(alias, tool.name);
    }
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name) ?? this.getByAlias(name);
  }

  getByAlias(name: string): Tool<any> | undefined {
    const canonical = this.aliases.get(name);
    return canonical ? this.tools.get(canonical) : undefined;
  }

  unregister(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    this.tools.delete(name);
    for (const alias of tool.aliases ?? []) {
      if (this.aliases.get(alias) === name) this.aliases.delete(alias);
    }
    return true;
  }

  definitions(context?: ToolUseContext, options: ToolPoolOptions = {}): ToolDefinition[] {
    return this.visibleTools(context, options).map((tool) => ({
      name: tool.name,
      description: appendToolResultBudgetDescription(resolveToolDescription(tool, context), tool),
      inputSchema: withToolResultBudgetInput(tool.inputSchema),
      strict: false,
    }));
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  list(context?: ToolUseContext, options: ToolPoolOptions = {}): Tool<any>[] {
    return this.visibleTools(context, options);
  }

  private visibleTools(context: ToolUseContext | undefined, options: ToolPoolOptions): Tool<any>[] {
    const deny = new Set(options.denyTools ?? []);
    return [...this.tools.values()]
      .filter((tool) => tool.metadata.visible)
      .filter((tool) => !deny.has(tool.name))
      .filter((tool) => options.includeDeferred || !tool.metadata.shouldDefer || tool.metadata.alwaysLoad)
      .filter((tool) => tool.isEnabled?.(context) ?? true)
      .sort(compareToolForPromptCache);
  }
}

export function assembleToolPool(
  builtInTools: readonly Tool<any>[],
  externalTools: readonly Tool<any>[] = [],
  options: ToolPoolOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const deny = new Set(options.denyTools ?? []);
  const ordered = [
    ...builtInTools.filter((tool) => !deny.has(tool.name)).sort(compareToolForPromptCache),
    ...externalTools.filter((tool) => !deny.has(tool.name)).sort(compareToolForPromptCache),
  ];
  const seen = new Set<string>();
  for (const tool of ordered) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    registry.register(tool);
  }
  return registry;
}

function compareToolForPromptCache(left: Tool<any>, right: Tool<any>): number {
  const leftMcp = left.metadata.isMcp ? 1 : 0;
  const rightMcp = right.metadata.isMcp ? 1 : 0;
  if (leftMcp !== rightMcp) return leftMcp - rightMcp;
  return left.name.localeCompare(right.name);
}

function appendToolResultBudgetDescription(description: string, tool: Tool<any>): string {
  const defaultBudget = Math.max(tool.metadata.maxResultSizeChars ?? 0, DEFAULT_TOOL_RESULT_BUDGET_CHARS);
  return `${description}\n\nTool result budget: by default, this tool's result is kept in model context up to ${defaultBudget} serialized characters. Pass optional maxResultChars on a single call to raise or lower that call's result budget; allowed range 1-${MAX_TOOL_RESULT_BUDGET_CHARS}. Larger results are saved to the session tool-results directory and replaced with a stable preview.`;
}

function withToolResultBudgetInput(schema: JsonSchema): JsonSchema {
  if (schema.type !== "object") return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      maxResultChars: {
        type: "number",
        description: `Optional per-call tool result budget in serialized characters. Default is the tool's documented budget; allowed range 1-${MAX_TOOL_RESULT_BUDGET_CHARS}. Use this only when a specific call needs more or less output retained in context.`,
      },
    },
  };
}
