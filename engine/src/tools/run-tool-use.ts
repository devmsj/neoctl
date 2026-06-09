import { DEFAULT_TOOL_RESULT_BUDGET_CHARS, MAX_TOOL_RESULT_BUDGET_CHARS } from "../session/tool-result-memory.js";
import { createTextMessage, createToolResultMessage, type Message, type ToolUseRequest } from "../types/messages.js";
import { validateJsonSchema } from "./schema.js";
import { redactWithRegistry } from "../secrets/secret-redaction.js";
import type {
  CanUseTool,
  Tool,
  ToolPermissionDecision,
  ToolProgressEvent,
  ToolResult,
  ToolUseContext,
} from "./tool.js";

export interface ToolMessageUpdate {
  message: Message;
  context?: ToolUseContext;
  progress?: ToolProgressEvent;
}

export interface RunToolUseOptions {
  canUseTool?: CanUseTool;
  parentMessage?: Message;
}

export async function runToolUse(
  request: ToolUseRequest,
  context: ToolUseContext,
  options: RunToolUseOptions = {},
): Promise<ToolMessageUpdate[]> {
  const tool = context.tools.get(request.name) ?? context.tools.getByAlias?.(request.name);
  if (!tool) {
    return [{ message: createToolResultMessage(request, false, { error: `Unknown tool: ${request.name}` }) }];
  }

  if (context.abortSignal?.aborted) {
    return [{ message: createToolResultMessage(request, false, { error: "Tool use aborted before execution" }) }];
  }

  const updates: ToolMessageUpdate[] = [];
  const contextWithToolUseId = { ...context, toolUseId: request.id };
  const onProgress = (event: ToolProgressEvent) => {
    const progress = { ...event, toolUseId: event.toolUseId ?? request.id };
    context.emit(progress);
    const rendered = tool.renderToolProgressMessage?.(progress) ?? createTextMessage("progress", progress.message);
    updates.push({ message: rendered, progress });
  };

  try {
    const parsed = parseAndValidateInput(tool, request.input, contextWithToolUseId);
    if (!parsed.ok) return [{ message: createToolResultMessage(request, false, { error: parsed.message }) }];

    const customValidation = tool.validateInput
      ? await tool.validateInput(parsed.value, contextWithToolUseId)
      : { ok: true as const, value: parsed.value };
    if (!customValidation.ok) {
      return [{ message: createToolResultMessage(request, false, { error: customValidation.message }) }];
    }

    const decision = await resolvePermissionDecision(request, contextWithToolUseId, options.canUseTool);
    if (!decision.allowed) {
      return [{ message: createToolResultMessage(request, false, { error: decision.reason ?? "Tool use denied" }) }];
    }

    onProgress({ toolName: tool.name, message: `Running ${tool.name}` });
    const sanitizedInput = stripToolRuntimeInput(customValidation.value);
    const result = await callTool(tool, sanitizedInput, contextWithToolUseId, {
      canUseTool: options.canUseTool,
      parentMessage: options.parentMessage,
      onProgress,
    });

    const output = redactWithRegistry(contextWithToolUseId.secretRedactions, await processToolOutput(tool, request, result, contextWithToolUseId));
    const safeResult = { ...result, output: redactWithRegistry(contextWithToolUseId.secretRedactions, result.output), summary: redactWithRegistry(contextWithToolUseId.secretRedactions, result.summary) };
    const resultMessage = tool.renderToolResultMessage?.(safeResult, request) ?? createToolResultMessage(request, safeResult.ok, output);
    updates.push({ message: resultMessage, context: result.contextModifier?.(contextWithToolUseId) });

    for (const message of result.newMessages ?? []) {
      updates.push({ message });
    }

    return updates;
  } catch (error) {
    return [
      ...updates,
      {
        message: createToolResultMessage(request, false, {
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    ];
  }
}

export async function runToolUseToMessages(
  request: ToolUseRequest,
  context: ToolUseContext,
  options: RunToolUseOptions = {},
): Promise<Message[]> {
  return (await runToolUse(request, context, options)).map((update) => update.message);
}

function parseAndValidateInput<TInput>(
  tool: Tool<TInput>,
  input: unknown,
  context: ToolUseContext,
): { ok: true; value: TInput } | { ok: false; message: string } {
  const schemaInput = tool.metadata.ignoreUnknownInputProperties
    ? stripUnknownInputProperties(input, tool.inputSchema)
    : input;
  const schemaResult = validateJsonSchema(schemaInput, withToolResultBudgetSchema(tool.inputSchema));
  if (!schemaResult.ok) {
    const hint = tool.metadata.shouldDefer
      ? ` ${buildSchemaNotSentHint(tool.name)}`
      : "";
    return { ok: false, message: `${schemaResult.message}.${hint}`.trim() };
  }

  try {
    const validatedInput = stripToolRuntimeInput(schemaResult.value);
    const value = tool.validate ? tool.validate(validatedInput, context) : (validatedInput as TInput);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function resolvePermissionDecision(
  request: ToolUseRequest,
  context: ToolUseContext,
  canUseTool?: CanUseTool,
): Promise<ToolPermissionDecision> {
  if (!canUseTool) return { allowed: true };
  const decision = await canUseTool(request, context);
  if (typeof decision === "boolean") return { allowed: decision };
  return decision;
}

async function callTool<TInput>(
  tool: Tool<TInput>,
  input: TInput,
  context: ToolUseContext,
  options: {
    canUseTool?: CanUseTool;
    parentMessage?: Message;
    onProgress: (event: ToolProgressEvent) => void;
  },
): Promise<ToolResult> {
  if (tool.call) {
    return tool.call(input, context, options);
  }
  if (tool.execute) {
    return tool.execute(input, context);
  }
  return { ok: false, output: { error: `Tool ${tool.name} has no call implementation` } };
}

async function processToolOutput(tool: Tool, request: ToolUseRequest, result: ToolResult, context: ToolUseContext): Promise<unknown> {
  const mapped = tool.mapResult ? tool.mapResult(result, request) : result.output;
  const resultBudget = resolveToolResultBudget(request.input, tool.metadata.maxResultSizeChars);
  if (context.toolResultMemory) {
    const processed = await context.toolResultMemory.processToolResult(
      request.id,
      mapped,
      resultBudget,
    );
    if (processed.record) context.recordContentReplacements?.([processed.record]);
    return processed.output;
  }

  const maxSize = resultBudget;
  if (!maxSize) return mapped;

  const serialized = typeof mapped === "string" ? mapped : JSON.stringify(mapped);
  if (serialized.length <= maxSize) return mapped;

  return `[Tool result truncated by transport: original ${serialized.length} chars, showing first ${maxSize} chars${result.summary ? `, summary: ${result.summary}` : ""}]\n${serialized.slice(0, maxSize)}`;
}

function resolveToolResultBudget(input: unknown, defaultBudget: number | undefined): number | undefined {
  const effectiveDefault = Math.max(defaultBudget ?? 0, DEFAULT_TOOL_RESULT_BUDGET_CHARS);
  const requested = readMaxResultChars(input);
  if (requested === undefined) return effectiveDefault;
  if (!Number.isFinite(requested)) return effectiveDefault;
  const normalized = Math.floor(requested);
  if (normalized < 1) return effectiveDefault;
  return Math.min(normalized, MAX_TOOL_RESULT_BUDGET_CHARS);
}

function readMaxResultChars(input: unknown): number | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as { maxResultChars?: unknown }).maxResultChars;
  return typeof value === "number" ? value : undefined;
}

function stripToolRuntimeInput<TInput>(input: TInput): TInput {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("maxResultChars" in input)) return input;
  const { maxResultChars: _maxResultChars, ...rest } = input as Record<string, unknown>;
  return rest as TInput;
}

function buildSchemaNotSentHint(toolName: string): string {
  return `If ${toolName} is deferred, select it with ToolSearch before retrying.`;
}

function withToolResultBudgetSchema(schema: Tool["inputSchema"]): Tool["inputSchema"] {
  if (schema.type !== "object") return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      maxResultChars: { type: "number" },
    },
  };
}

function stripUnknownInputProperties(input: unknown, schema: Tool["inputSchema"]): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const effectiveSchema = withToolResultBudgetSchema(schema);
  if (effectiveSchema.type !== "object" || !effectiveSchema.properties || effectiveSchema.additionalProperties !== false) return input;

  let changed = false;
  const allowed = new Set(Object.keys(effectiveSchema.properties));
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      changed = true;
      continue;
    }
    output[key] = value;
  }
  return changed ? output : input;
}
