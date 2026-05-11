import { InMemoryAppState } from "../app/app-state.js";
import type { Compactor, ContextBudgetOptions, CompactionResult } from "../context/compaction.js";
import { ModelDrivenCompactor } from "../context/compaction.js";
import type { ContextManager, RuntimeContext } from "../context/context-manager.js";
import { DefaultContextManager } from "../context/context-manager.js";
import type { ModelGateway, ModelStreamEvent, ReasoningConfig } from "../model/model-gateway.js";
import { ModelAPIError } from "../model/errors.js";
import { supportsImageInput } from "../model/context-window.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runTools } from "../tools/tool-orchestration.js";
import type { CanUseTool, ToolUseContext } from "../tools/tool.js";
import type { AgentEvent } from "../types/events.js";
import { createTextMessage, createThinkingMessage, type Message, type MessageBlock, type ToolUseRequest } from "../types/messages.js";
import {
  appendSystemContext,
  applyToolResultBudget,
  ensureToolResultPairing,
  getMessagesAfterCompactBoundary,
  prependUserContext,
} from "./message-pipeline.js";
import {
  createInitialState,
  nextTracking,
  type QueryState,
  type TerminalReason,
} from "./state.js";
import { AssistantOutputFilter } from "./assistant-output-filter.js";
import { buildContextMetrics } from "./context-metrics.js";

export interface QueryOptions {
  agentId: string;
  model?: string;
  fallbackModel?: string;
  reasoning?: ReasoningConfig | null;
  queryOrigin?: string;
  maxOutputTokensOverride?: number;
  maxTurns?: number;
  skipCacheWrite?: boolean;
  taskBudget?: { total: number };
  abortSignal?: AbortSignal;
  /** Resolved workspace root for tools (e.g. subagent `cwd` from parent `agent` tool). */
  workspaceCwd?: string;
}

export interface QueryDependencies {
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
  maxToolResultSerializedLength?: number;
  toolResultMemory?: ToolUseContext["toolResultMemory"];
  recordContentReplacements?: ToolUseContext["recordContentReplacements"];
  taskNotificationSource?: TaskNotificationSource;
  exportToolCalls?: (calls: ToolUseRequest[]) => void;
}

export interface TaskNotificationSource {
  collectUnnotifiedCompletions(): { taskId: string; agentId: string; status: string; type: string; content: string }[];
  markNotified(taskId: string): void;
}

interface ModelTurnOutput {
  assistantMessages: Message[];
  toolUses: ToolUseRequest[];
  previousResponseId?: string;
  incompleteReason?: string;
}

interface PreparedMessages {
  messagesForQuery: Message[];
  compactedMessages: Message[];
  compaction?: CompactionResult;
  metrics: ReturnType<typeof buildContextMetrics>;
}

export async function* query(
  messages: Message[],
  dependencies: QueryDependencies,
  options: QueryOptions,
): AsyncGenerator<AgentEvent, TerminalReason, void> {
  const initialState = createInitialState(messages, {
    model: options.model,
    fallbackModel: options.fallbackModel,
  });
  initialState.maxOutputTokensOverride = options.maxOutputTokensOverride;

  const terminal = yield* queryLoop(initialState, dependencies, options);
  yield { type: "terminal", reason: terminal };
  return terminal;
}

async function* queryLoop(
  initialState: QueryState,
  dependencies: QueryDependencies,
  options: QueryOptions,
): AsyncGenerator<AgentEvent, TerminalReason, void> {
  const contextManager = dependencies.contextManager ?? new DefaultContextManager();
  const compactor = dependencies.compactor ?? new ModelDrivenCompactor(dependencies.modelGateway);
  const appState = new InMemoryAppState(options.agentId, options.workspaceCwd);
  const maxTurns = options.maxTurns;
  let state = initialState;
  let toolContext: ToolUseContext = {
    agentId: options.agentId,
    abortSignal: options.abortSignal,
    tools: dependencies.tools,
    appState,
    toolResultMemory: dependencies.toolResultMemory,
    recordContentReplacements: dependencies.recordContentReplacements,
    emit: () => undefined,
  };

  while (true) {
    if (options.abortSignal?.aborted) return "aborted_streaming";
    if (maxTurns !== undefined && state.turnCount >= maxTurns) return "max_turns";

    state = beginTurn(state);
    toolContext = { ...toolContext, queryTracking: state.queryTracking, messages: state.messages };
    yield { type: "state", phase: state.phase, detail: `turn ${state.turnCount + 1} started (${state.transition.reason})` };

    const context = await contextManager.build({
      agentId: options.agentId,
      messages: state.messages,
      cwd: options.workspaceCwd,
      enabledTools: dependencies.tools.definitions(toolContext).map((tool) => tool.name),
      toolUseContext: toolContext,
    });
    const toolDefinitions = dependencies.tools.definitions(toolContext);
    const systemPrompt = appendSystemContext(context.systemPrompt, context.systemContext);
    const prepared = await prepareMessagesForQuery(state, context, dependencies, compactor, {
      model: state.currentModel ?? options.model,
      systemPrompt,
      toolDefinitions,
      toolUseContext: toolContext,
    });
    if (prepared.compaction?.changed) {
      state = { ...state, messages: prepared.compactedMessages };
      yield { type: "state", phase: "compacting", detail: formatCompactionDetail(prepared.compaction) };
      for (const message of prepared.compactedMessages.filter((message) => message.metadata?.compactBoundary === true)) {
        yield { type: "message", message };
      }
    }

    const modelOutput = yield* callModelForTurn(state, context, prepared.messagesForQuery, dependencies, options, toolContext, {
      systemPrompt,
      toolDefinitions,
      metrics: prepared.metrics,
    });
    if (modelOutput.reactiveCompact) {
      state = modelOutput.reactiveCompact;
      continue;
    }
    if (modelOutput.terminal) return modelOutput.terminal;
    if (!modelOutput.output) return "model_error";

    const { assistantMessages, toolUses, previousResponseId, incompleteReason } = modelOutput.output;

    if (toolUses.length === 0) {
      const recovery = maybeRecoverWithoutTools(state, incompleteReason, assistantMessages, previousResponseId, options);
      if (recovery) {
        state = recovery;
        continue;
      }
      return "completed";
    }

    const toolResult = yield* executeToolsForTurn(toolUses, dependencies, options, toolContext);
    if (toolResult.terminal) return toolResult.terminal;
    toolContext = toolResult.context;

    const taskNotifications = collectTaskNotifications(dependencies.taskNotificationSource);
    for (const notification of taskNotifications) {
      yield { type: "message", message: notification };
    }

    state = buildNextTurnState(state, {
      assistantMessages,
      toolResults: [...toolResult.messages, ...taskNotifications],
      previousResponseId,
    });
  }
}

function beginTurn(state: QueryState): QueryState {
  return {
    ...state,
    phase: "preparing",
    queryTracking: nextTracking(state.queryTracking),
  };
}

async function prepareMessagesForQuery(
  state: QueryState,
  context: RuntimeContext,
  dependencies: QueryDependencies,
  compactor: Compactor,
  telemetry: { model?: string; systemPrompt: string; toolDefinitions: ReturnType<ToolRegistry["definitions"]>; toolUseContext?: ToolUseContext },
): Promise<PreparedMessages> {
  const baseMessages = state.modelInputMessages ?? getMessagesAfterCompactBoundary(state.messages);
  const budgetResult = telemetry.toolUseContext?.toolResultMemory
    ? await telemetry.toolUseContext.toolResultMemory.applyBudget(baseMessages, {
        maxSerializedLength: dependencies.maxToolResultSerializedLength,
      })
    : {
        messages: applyToolResultBudget(baseMessages, {
          maxSerializedLength: dependencies.maxToolResultSerializedLength,
        }),
        records: [],
      };
  if (budgetResult.records.length) telemetry.toolUseContext?.recordContentReplacements?.(budgetResult.records);
  const budgeted = budgetResult.messages;
  const pairedBudgeted = ensureToolResultPairing(budgeted);
  const metricsBeforeCompact = buildContextMetrics({
    model: telemetry.model,
    messages: prependUserContext(pairedBudgeted, context.userContext),
    systemPrompt: telemetry.systemPrompt,
    tools: telemetry.toolDefinitions,
  });
  const compaction = await compactor.compact(pairedBudgeted, {
    ...dependencies.contextBudget,
    estimatedInputTokens: metricsBeforeCompact.estimatedInputTokens,
    contextWindowTokens: metricsBeforeCompact.contextWindowTokens,
  });
  const compactedMessages = ensureToolResultPairing(compaction.messages);
  const messagesForQuery = prependUserContext(compactedMessages, context.userContext);
  const metrics = buildContextMetrics({
    model: telemetry.model,
    messages: messagesForQuery,
    systemPrompt: telemetry.systemPrompt,
    tools: telemetry.toolDefinitions,
  });
  return {
    messagesForQuery,
    compactedMessages,
    compaction: compaction.changed ? compaction : undefined,
    metrics,
  };
}

async function* callModelForTurn(
  state: QueryState,
  context: RuntimeContext,
  messagesForQuery: Message[],
  dependencies: QueryDependencies,
  options: QueryOptions,
  toolContext: ToolUseContext,
  telemetry: { systemPrompt: string; toolDefinitions: ReturnType<ToolRegistry["definitions"]>; metrics: ReturnType<typeof buildContextMetrics> },
): AsyncGenerator<AgentEvent, { terminal?: TerminalReason; output?: ModelTurnOutput; reactiveCompact?: QueryState }, void> {
  const assistantMessages: Message[] = [];
  const toolUses: ToolUseRequest[] = [];
  const outputFilter = new AssistantOutputFilter();
  const thinkingParts: string[] = [];
  let previousResponseId = state.previousResponseId;
  let incompleteReason: string | undefined;
  let activeModel = state.currentModel ?? options.model;
  const modelMessages = adaptMessagesForModelCapabilities(messagesForQuery, activeModel);

  yield { type: "state", phase: "compacting", detail: "messages prepared for model" };
  yield { type: "context.metrics", metrics: telemetry.metrics };
  yield { type: "state", phase: "calling_model", detail: activeModel ? `model stream opened (${activeModel})` : "model stream opened" };

  try {
    for await (const event of dependencies.modelGateway.stream({
      model: activeModel,
      fallbackModel: state.fallbackModel ?? options.fallbackModel,
      messages: modelMessages,
      systemPrompt: telemetry.systemPrompt,
      tools: telemetry.toolDefinitions,
      stream: true,
      maxOutputTokens: state.maxOutputTokensOverride ?? options.maxOutputTokensOverride,
      reasoning: options.reasoning,
      previousResponseId: state.previousResponseId,
      queryOrigin: options.queryOrigin,
      cancellation: options.abortSignal,
    })) {
      if (options.abortSignal?.aborted) return { terminal: "aborted_streaming" };
      const handled = yield* handleModelEvent(event, assistantMessages, toolUses, outputFilter, thinkingParts);
      previousResponseId = handled.previousResponseId ?? previousResponseId;
      incompleteReason = handled.incompleteReason ?? incompleteReason;

      if (event.type === "fallback_started") {
        activeModel = event.toModel;
        assistantMessages.length = 0;
        toolUses.length = 0;
        yield { type: "message", message: createTextMessage("progress", `Fallback model started: ${event.fromModel} -> ${event.toModel}`) };
      }
    }
  } catch (error) {
    if (isContextLengthError(error) && !state.hasAttemptedReactiveCompact) {
      const compactor = dependencies.compactor ?? new ModelDrivenCompactor(dependencies.modelGateway);
      const normalized = error instanceof Error ? error : new Error(String(error));
      const reactiveMetrics = buildContextMetrics({
        model: activeModel,
        messages: state.messages,
        systemPrompt: telemetry.systemPrompt,
        tools: telemetry.toolDefinitions,
      });
      const reactiveBudget: ContextBudgetOptions = {
        ...dependencies.contextBudget,
        estimatedInputTokens: reactiveMetrics.estimatedInputTokens,
        contextWindowTokens: reactiveMetrics.contextWindowTokens,
      };
      const compacted = await (compactor.reactiveCompact?.(state.messages, normalized, reactiveBudget) ?? compactor.compact(state.messages, reactiveBudget));
      yield { type: "state", phase: "compacting", detail: "reactive compact retry after prompt-too-long" };
      for (const message of compacted.messages.filter((message) => message.metadata?.compactBoundary === true)) {
        yield { type: "message", message };
      }
      return {
        reactiveCompact: {
          ...state,
          messages: compacted.messages,
          modelInputMessages: compacted.messages,
          hasAttemptedReactiveCompact: true,
          turnCount: state.turnCount + 1,
          transition: { reason: "reactive_compact_retry", detail: normalized.message },
        },
      };
    }

    const terminal = terminalForModelError(error);
    yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
    return { terminal };
  }

  if (options.abortSignal?.aborted) return { terminal: "aborted_streaming" };

  if (toolUses.length) dependencies.exportToolCalls?.(toolUses);
  appendSyntheticToolUseMessage(assistantMessages, toolUses);
  return { output: { assistantMessages, toolUses, previousResponseId, incompleteReason } };
}

function adaptMessagesForModelCapabilities(messages: Message[], model: string | undefined): Message[] {
  if (supportsImageInput(model) !== false) return messages;

  let changed = false;
  const adapted = messages.map((message) => {
    let messageChanged = false;
    const blocks = message.blocks.map((block): MessageBlock => {
      if (block.type !== "image") return block;
      changed = true;
      messageChanged = true;
      return {
        type: "text",
        text: formatUnsupportedImagePlaceholder(block),
      };
    });

    return messageChanged
      ? {
          ...message,
          blocks,
          metadata: { ...message.metadata, imageInputDowngraded: true },
        }
      : message;
  });

  return changed ? adapted : messages;
}

function formatUnsupportedImagePlaceholder(block: { mimeType: string; label?: string }): string {
  const label = block.label?.trim();
  const suffix = `[image ${block.mimeType} omitted: current model does not support image input]`;
  return label ? `${label} ${suffix}` : suffix;
}

async function* handleModelEvent(
  event: ModelStreamEvent,
  assistantMessages: Message[],
  toolUses: ToolUseRequest[],
  outputFilter: AssistantOutputFilter,
  thinkingParts: string[],
): AsyncGenerator<AgentEvent, { previousResponseId?: string; incompleteReason?: string }, void> {
  if (event.type === "assistant_delta") {
    const text = outputFilter.push(event.text);
    if (text) yield { type: "assistant.delta", text };
    return {};
  }

  if (event.type === "thinking_delta") {
    thinkingParts.push(event.text);
    yield { type: "thinking.delta", text: event.text };
    return {};
  }

  if (event.type === "assistant_message") {
    const message = outputFilter.sanitizeMessage(event.message);
    assistantMessages.push(message);
    for (const toolUse of extractToolUses(message)) toolUses.push(toolUse);
    yield { type: "message", message };
    return {};
  }

  if (event.type === "tool_use") {
    toolUses.push(event.toolUse);
    return {};
  }

  if (event.type === "tool_call_delta") {
    yield {
      type: "tool_call.delta",
      callId: event.callId,
      name: event.name,
      argumentsDelta: event.argumentsDelta,
    };
    return {};
  }

  if (event.type === "usage") {
    yield { type: "usage", usage: event.usage };
    return {};
  }

  if (event.type === "retrying") {
    yield { type: "retrying", attempt: event.attempt, delayMs: event.delayMs, error: event.error };
    return {};
  }

  if (event.type === "response_completed") {
    const thinkingMessage = finalizeThinkingMessage(assistantMessages, thinkingParts);
    if (thinkingMessage) yield { type: "message", message: thinkingMessage };
    if (event.usage) yield { type: "usage", usage: event.usage };
    return { previousResponseId: event.responseId };
  }

  if (event.type === "response_incomplete") {
    const thinkingMessage = finalizeThinkingMessage(assistantMessages, thinkingParts);
    if (thinkingMessage) yield { type: "message", message: thinkingMessage };
    if (event.usage) yield { type: "usage", usage: event.usage };
    return { previousResponseId: event.responseId, incompleteReason: event.reason };
  }

  if (event.type === "error") {
    yield { type: "error", error: event.error };
    return {};
  }

  return {};
}

function finalizeThinkingMessage(assistantMessages: Message[], thinkingParts: string[]): Message | undefined {
  const text = thinkingParts.join("").trim();
  if (!text) return undefined;
  const alreadyIncluded = assistantMessages.some((message) =>
    message.blocks.some((block) => block.type === "thinking" && (block.text === text || block.text.startsWith(text) || text.startsWith(block.text))),
  );
  thinkingParts.length = 0;
  if (alreadyIncluded) return undefined;
  const message = createThinkingMessage(text);
  assistantMessages.push(message);
  return message;
}

async function* executeToolsForTurn(
  toolUses: ToolUseRequest[],
  dependencies: QueryDependencies,
  options: QueryOptions,
  context: ToolUseContext,
): AsyncGenerator<AgentEvent, { terminal?: TerminalReason; messages: Message[]; context: ToolUseContext }, void> {
  yield { type: "state", phase: "running_tools", detail: `${toolUses.length} tool call(s)` };
  for (const toolUse of toolUses) yield { type: "tool.started", toolUse };

  if (options.abortSignal?.aborted) return { terminal: "aborted_tools", messages: [], context };

  const result = await abortable(runTools(toolUses, context, { canUseTool: dependencies.canUseTool }), options.abortSignal);
  if (!result.completed) return { terminal: "aborted_tools", messages: [], context };

  for (const message of result.value.messages) {
    context.appState.appendMessage(message);
    yield { type: "message", message };
  }

  for (const toolUse of toolUses) {
    const resultMessage = result.value.messages.find((message) =>
      message.blocks.some((block) => block.type === "tool_result" && block.toolUseId === toolUse.id),
    );
    yield { type: "tool.finished", toolUse, ok: resultMessage ? toolResultOk(resultMessage) : false };
  }

  return { messages: result.value.messages, context: result.value.context };
}

function maybeRecoverWithoutTools(
  state: QueryState,
  incompleteReason: string | undefined,
  assistantMessages: Message[],
  previousResponseId: string | undefined,
  options: QueryOptions,
): QueryState | undefined {
  if (incompleteReason === "max_output_tokens" && state.maxOutputTokensRecoveryCount === 0) {
    return {
      ...state,
      messages: [...state.messages, ...assistantMessages],
      modelInputMessages: [createTextMessage("user", "Continue from the exact point where the previous response stopped.")],
      previousResponseId,
      maxOutputTokensOverride: Math.max(options.maxOutputTokensOverride ?? 0, 64000),
      maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1,
      turnCount: state.turnCount + 1,
      transition: { reason: "max_output_tokens_escalate", detail: incompleteReason },
    };
  }
  return undefined;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<{ completed: true; value: T } | { completed: false }> {
  if (!signal) return promise.then((value) => ({ completed: true, value }));
  if (signal.aborted) return Promise.resolve({ completed: false });

  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ completed: false });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ completed: true, value });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function buildNextTurnState(
  state: QueryState,
  input: {
    assistantMessages: Message[];
    toolResults: Message[];
    previousResponseId?: string;
  },
): QueryState {
  const allMessages = [...state.messages, ...input.assistantMessages, ...input.toolResults];
  return {
    ...state,
    phase: "injecting_context",
    messages: allMessages,
    modelInputMessages: undefined,
    previousResponseId: undefined,
    turnCount: state.turnCount + 1,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    transition: { reason: "next_turn" },
  };
}

function appendSyntheticToolUseMessage(assistantMessages: Message[], toolUses: ToolUseRequest[]): void {
  const missing = toolUses.filter((toolUse) =>
    !assistantMessages.some((message) =>
      message.blocks.some((block) => block.type === "tool_use" && block.id === toolUse.id),
    ),
  );
  if (!missing.length) return;

  assistantMessages.push({
    id: `tool-use-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    createdAt: new Date().toISOString(),
    blocks: missing.map((toolUse) => ({
      type: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    })),
    isMeta: true,
    metadata: { syntheticToolUse: true },
  });
}

function extractToolUses(message: Message): ToolUseRequest[] {
  return message.blocks
    .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
}

function toolResultOk(message: Message): boolean {
  return message.blocks.every((block) => block.type !== "tool_result" || block.ok);
}

function formatCompactionDetail(compaction: CompactionResult): string {
  if (compaction.reason === "microcompact" && compaction.summary) return compaction.summary;
  return `${compaction.reason ?? "compact"} reduced context by ${compaction.tokensFreed ?? 0} chars`;
}

function terminalForModelError(error: unknown): TerminalReason {
  if (error instanceof ModelAPIError) {
    if (error.category === "context_length") return "prompt_too_long";
    if (error.category === "user_abort") return "aborted_streaming";
    if (error.category === "unsupported_image_input") return "image_error";
    if (error.category === "max_output_tokens") return "model_error";
  }
  return "model_error";
}

function isContextLengthError(error: unknown): boolean {
  return error instanceof ModelAPIError && error.category === "context_length";
}

function collectTaskNotifications(source?: TaskNotificationSource): Message[] {
  if (!source) return [];
  const completed = source.collectUnnotifiedCompletions();
  return completed.map((task) => {
    source.markNotified(task.taskId);
    return createTextMessage(
      "user",
      `<task-notification task_id="${task.taskId}" agent_id="${task.agentId}" status="${task.status}" type="${task.type}">\n${task.content}\n</task-notification>`,
    );
  });
}
