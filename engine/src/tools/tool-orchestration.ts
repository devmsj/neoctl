import type { Message, ToolUseRequest } from "../types/messages.js";
import { runToolUse, type RunToolUseOptions, type ToolMessageUpdate } from "./run-tool-use.js";
import type { Tool, ToolProgressEvent, ToolUseContext } from "./tool.js";

export interface RunToolsResult {
  messages: Message[];
  context: ToolUseContext;
}

export type RunToolsEvent =
  | { type: "progress"; index: number; total: number; request: ToolUseRequest; progress: ToolProgressEvent }
  | { type: "settled"; index: number; total: number; request: ToolUseRequest; updates: ToolMessageUpdate[]; ok: boolean };

export interface RunToolsOptions extends RunToolUseOptions {
  onEvent?: (event: RunToolsEvent) => void;
}

interface ParsedToolCall {
  request: ToolUseRequest;
  tool?: Tool;
  concurrencySafe: boolean;
}

export async function runTools(
  requests: readonly ToolUseRequest[],
  context: ToolUseContext,
  options: RunToolsOptions = {},
): Promise<RunToolsResult> {
  let currentContext = context;
  const messages: Message[] = [];
  const indexes = new Map(requests.map((request, index) => [request.id, index]));

  for (const batch of partitionToolCalls(requests, currentContext)) {
    if (batch.length === 1 && !batch[0].concurrencySafe) {
      const item = batch[0];
      const updates = await runToolUseWithEvents(item, currentContext, options, indexes.get(item.request.id) ?? 0, requests.length);
      options.onEvent?.({ type: "settled", index: indexes.get(item.request.id) ?? 0, total: requests.length, request: item.request, updates, ok: updatesOk(updates) });
      const applied = applyUpdates(updates, currentContext);
      currentContext = applied.context;
      messages.push(...applied.messages);
      continue;
    }

    const batchResults = await runToolsConcurrently(batch, currentContext, options, indexes, requests.length);
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
  options: RunToolsOptions,
  indexes: ReadonlyMap<string, number>,
  total: number,
): Promise<Map<string, ToolMessageUpdate[]>> {
  const maxConcurrency = maxToolConcurrency();
  const results = new Map<string, ToolMessageUpdate[]>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < batch.length) {
      const item = batch[cursor];
      cursor += 1;
      const index = indexes.get(item.request.id) ?? 0;
      const updates = await runToolUseWithEvents(item, context, options, index, total);
      results.set(item.request.id, updates);
      options.onEvent?.({ type: "settled", index, total, request: item.request, updates, ok: updatesOk(updates) });
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, batch.length) }, () => worker()));
  return results;
}

async function runToolUseWithEvents(
  item: ParsedToolCall,
  context: ToolUseContext,
  options: RunToolsOptions,
  index: number,
  total: number,
): Promise<ToolMessageUpdate[]> {
  let sequence = 0;
  const contextWithEvents: ToolUseContext = {
    ...context,
    emit(progress) {
      const normalized = { ...progress, toolUseId: progress.toolUseId ?? item.request.id, sequence: progress.sequence ?? ++sequence };
      options.onEvent?.({ type: "progress", index, total, request: item.request, progress: normalized });
      context.emit(normalized);
    },
  };
  return runToolUse(item.request, contextWithEvents, options);
}

function updatesOk(updates: readonly ToolMessageUpdate[]): boolean {
  return updates.every((update) => update.message.blocks.every((block) => block.type !== "tool_result" || block.ok));
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
