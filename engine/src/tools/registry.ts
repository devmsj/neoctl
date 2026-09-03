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
  private readonly disabledTools = new Set<string>();

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
    const tool = this.resolve(name);
    return tool && !this.disabledTools.has(tool.name) ? tool : undefined;
  }

  getByAlias(name: string): Tool<any> | undefined {
    const tool = this.resolveAlias(name);
    return tool && !this.disabledTools.has(tool.name) ? tool : undefined;
  }

  unregister(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    this.tools.delete(name);
    this.disabledTools.delete(name);
    for (const alias of tool.aliases ?? []) {
      if (this.aliases.get(alias) === name) this.aliases.delete(alias);
    }
    return true;
  }

  definitions(context?: ToolUseContext, options: ToolPoolOptions = {}): ToolDefinition[] {
    return this.visibleTools(context, options).map((tool) => ({
      name: tool.name,
      description: resolveToolDescription(tool, context),
      inputSchema: withToolResultBudgetInput(tool.inputSchema, tool),
      strict: false,
    }));
  }

  names(options: { includeDisabled?: boolean } = {}): string[] {
    return [...this.tools.keys()]
      .filter((name) => options.includeDisabled || !this.disabledTools.has(name))
      .sort();
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const tool = this.resolve(name);
    if (!tool) return false;
    if (enabled) this.disabledTools.delete(tool.name);
    else this.disabledTools.add(tool.name);
    return true;
  }

  isEnabled(name: string): boolean | undefined {
    const tool = this.resolve(name);
    return tool ? !this.disabledTools.has(tool.name) : undefined;
  }

  private resolve(name: string): Tool<any> | undefined {
    return this.tools.get(name) ?? this.resolveAlias(name);
  }

  private resolveAlias(name: string): Tool<any> | undefined {
    const canonical = this.aliases.get(name);
    return canonical ? this.tools.get(canonical) : undefined;
  }

  list(context?: ToolUseContext, options: ToolPoolOptions = {}): Tool<any>[] {
    return this.visibleTools(context, options);
  }

  private visibleTools(context: ToolUseContext | undefined, options: ToolPoolOptions): Tool<any>[] {
    const deny = new Set(options.denyTools ?? []);
    return [...this.tools.values()]
      .filter((tool) => tool.metadata.visible)
      .filter((tool) => !this.disabledTools.has(tool.name))
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

function withToolResultBudgetInput(schema: JsonSchema, tool: Tool<any>): JsonSchema {
  if (schema.type !== "object") return schema;
  const defaultBudget = Math.max(tool.metadata.maxResultSizeChars ?? 0, DEFAULT_TOOL_RESULT_BUDGET_CHARS);
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      maxResultChars: {
        type: "number",
        description: `Override result budget for this call. Default ${defaultBudget}; range 1-${MAX_TOOL_RESULT_BUDGET_CHARS} serialized characters.`,
      },
    },
  };
}
