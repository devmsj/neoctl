import type { Message, ToolUseRequest } from "../types/messages";
import { runToolUse, type RunToolUseOptions, type ToolMessageUpdate } from "./run-tool-use";
import type { Tool, ToolUseContext } from "./tool";

export interface RunToolsResult {
  messages: Message[];
  context: ToolUseContext;
}

interface ParsedToolCall {
  request: ToolUseRequest;
  tool?: Tool;
  concurrencySafe: boolean;
}

export async function runTools(
  requests: readonly ToolUseRequest[],
  context: ToolUseContext,
  options: RunToolUseOptions = {},
): Promise<RunToolsResult> {
  let currentContext = context;
  const messages: Message[] = [];

  for (const batch of partitionToolCalls(requests, currentContext)) {
    if (batch.length === 1 && !batch[0].concurrencySafe) {
      const updates = await runToolUse(batch[0].request, currentContext, options);
      const applied = applyUpdates(updates, currentContext);
      currentContext = applied.context;
      messages.push(...applied.messages);
      continue;
    }

    const batchResults = await runToolsConcurrently(batch, currentContext, options);
    for (const item of batch) {
      const updates = batchResults.get(item.request.id) ?? [];
      const applied = applyUpdates(updates, currentContext);
      currentContext = applied.context;
      messages.push(...applied.messages);
    }
  }

  return { messages, context: currentContext };
}

export function partitionToolCalls(
  requests: readonly ToolUseRequest[],
  context: ToolUseContext,
): ParsedToolCall[][] {
  const batches: ParsedToolCall[][] = [];
  let concurrentBatch: ParsedToolCall[] = [];

  for (const request of requests) {
    const tool = context.tools.get(request.name) ?? context.tools.getByAlias?.(request.name);
    const parsed: ParsedToolCall = {
      request,
      tool,
      concurrencySafe: isConcurrencySafe(tool, request.input, context),
    };

    if (parsed.concurrencySafe) {
      concurrentBatch.push(parsed);
      continue;
    }

    if (concurrentBatch.length) {
      batches.push(concurrentBatch);
      concurrentBatch = [];
    }
    batches.push([parsed]);
  }

  if (concurrentBatch.length) batches.push(concurrentBatch);
  return batches;
}

async function runToolsConcurrently(
  batch: readonly ParsedToolCall[],
  context: ToolUseContext,
  options: RunToolUseOptions,
): Promise<Map<string, ToolMessageUpdate[]>> {
  const maxConcurrency = maxToolConcurrency();
  const results = new Map<string, ToolMessageUpdate[]>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < batch.length) {
      const item = batch[cursor];
      cursor += 1;
      results.set(item.request.id, await runToolUse(item.request, context, options));
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, batch.length) }, () => worker()));
  return results;
}

function applyUpdates(updates: readonly ToolMessageUpdate[], context: ToolUseContext): RunToolsResult {
  let currentContext = context;
  const messages: Message[] = [];
  for (const update of updates) {
    messages.push(update.message);
    if (update.context) currentContext = update.context;
  }
  return { messages, context: currentContext };
}

function isConcurrencySafe(tool: Tool | undefined, input: unknown, context: ToolUseContext): boolean {
  if (!tool) return true;
  if (tool.isConcurrencySafe) {
    try {
      return tool.isConcurrencySafe(input, context);
    } catch {
      return false;
    }
  }
  return tool.metadata.concurrent;
}

function maxToolConcurrency(): number {
  const raw = process.env.AGENT_MAX_TOOL_USE_CONCURRENCY ?? process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY;
  const parsed = raw ? Number(raw) : 10;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}
