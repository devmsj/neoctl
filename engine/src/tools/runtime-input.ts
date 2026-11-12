import { DEFAULT_TOOL_RESULT_BUDGET_CHARS, MAX_TOOL_RESULT_BUDGET_CHARS } from "../session/tool-result-memory.js";
import type { JsonSchema, Tool } from "./tool.js";

/** Shared model-facing and execution schema for framework-owned call fields. */
export function withToolRuntimeInput(schema: JsonSchema, tool: Tool<any>): JsonSchema {
  const defaultBudget = Math.max(tool.metadata.maxResultSizeChars ?? 0, DEFAULT_TOOL_RESULT_BUDGET_CHARS);
  const { description: _nativeDescription, ...properties } = schema.properties ?? {};
  return {
    ...schema,
    type: "object",
    properties: {
      description: { type: "string", description: "Purpose of this tool call.", minLength: 1, pattern: "\\S" },
      ...properties,
      maxResultChars: {
        type: "number",
        description: `Override result budget for this call. Default ${defaultBudget}; range 1-${MAX_TOOL_RESULT_BUDGET_CHARS} serialized characters.`,
      },
    },
    required: [...new Set([...(schema.required ?? []), "description"])],
  };
}

/** Keep native description parameters; do not leak injected fields to plugins/MCP. */
export function stripToolRuntimeInput<T>(input: T, tool: Tool<any>): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { maxResultChars: _budget, ...rest } = input as Record<string, unknown>;
  if (!Object.hasOwn(tool.inputSchema.properties ?? {}, "description")) delete rest.description;
  return rest as T;
}
