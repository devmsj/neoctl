import { createTextMessage, createToolResultMessage, type Message, type ToolUseRequest } from "../types/messages.js";
import { validateJsonSchema } from "./schema.js";
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
    const result = await callTool(tool, customValidation.value, contextWithToolUseId, {
      canUseTool: options.canUseTool,
      parentMessage: options.parentMessage,
      onProgress,
    });

    const output = await processToolOutput(tool, request, result, contextWithToolUseId);
    const resultMessage = tool.renderToolResultMessage?.(result, request) ?? createToolResultMessage(request, result.ok, output);
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
  const schemaResult = validateJsonSchema(input, tool.inputSchema);
  if (!schemaResult.ok) {
    const hint = tool.metadata.shouldDefer
      ? ` ${buildSchemaNotSentHint(tool.name)}`
      : "";
    return { ok: false, message: `${schemaResult.message}.${hint}`.trim() };
  }

  try {
    const value = tool.validate ? tool.validate(schemaResult.value, context) : (schemaResult.value as TInput);
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
  if (context.toolResultMemory) {
    const processed = await context.toolResultMemory.processToolResult(
      request.id,
      mapped,
      tool.metadata.maxResultSizeChars,
    );
    if (processed.record) context.recordContentReplacements?.([processed.record]);
    return processed.output;
  }

  const maxSize = tool.metadata.maxResultSizeChars;
  if (!maxSize) return mapped;

  const serialized = typeof mapped === "string" ? mapped : JSON.stringify(mapped);
  if (serialized.length <= maxSize) return mapped;

  return `[Tool result truncated by transport: original ${serialized.length} chars, showing first ${maxSize} chars${result.summary ? `, summary: ${result.summary}` : ""}]\n${serialized.slice(0, maxSize)}`;
}

function buildSchemaNotSentHint(toolName: string): string {
  return `If ${toolName} is deferred, select it with ToolSearch before retrying.`;
}
