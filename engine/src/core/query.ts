import { InMemoryAppState } from "../app/app-state";
import type { Compactor, ContextBudgetOptions, CompactionResult } from "../context/compaction";
import { DeterministicCompactor } from "../context/compaction";
import type { ContextManager, RuntimeContext } from "../context/context-manager";
import { DefaultContextManager } from "../context/context-manager";
import type { ModelGateway, ModelStreamEvent } from "../model/model-gateway";
import { ModelAPIError } from "../model/errors";
import type { ToolRegistry } from "../tools/registry";
import { runTools } from "../tools/tool-orchestration";
import type { CanUseTool, ToolUseContext } from "../tools/tool";
import type { AgentEvent } from "../types/events";
import { createTextMessage, type Message, type ToolUseRequest } from "../types/messages";
import {
  appendSystemContext,
  applyToolResultBudget,
  getMessagesAfterCompactBoundary,
  prependUserContext,
} from "./message-pipeline";
import {
  createInitialState,
  nextTracking,
  type QueryState,
  type TerminalReason,
} from "./state";

export interface QueryOptions {
  agentId: string;
  model?: string;
  fallbackModel?: string;
  queryOrigin?: string;
  maxOutputTokensOverride?: number;
  maxTurns?: number;
  skipCacheWrite?: boolean;
  taskBudget?: { total: number };
  abortSignal?: AbortSignal;
}

export interface QueryDependencies {
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
  maxToolResultSerializedLength?: number;
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
  const compactor = dependencies.compactor ?? new DeterministicCompactor();
  const appState = new InMemoryAppState(options.agentId);
  const maxTurns = options.maxTurns ?? 12;
  let state = initialState;
  let toolContext: ToolUseContext = {
    agentId: options.agentId,
    abortSignal: options.abortSignal,
    tools: dependencies.tools,
    appState,
    emit: () => undefined,
  };

  while (true) {
    if (options.abortSignal?.aborted) return "aborted_streaming";
    if (state.turnCount >= maxTurns) return "max_turns";

    state = beginTurn(state);
    toolContext = { ...toolContext, queryTracking: state.queryTracking, messages: state.messages };
    yield { type: "state", phase: state.phase, detail: `turn ${state.turnCount + 1} started (${state.transition.reason})` };

    const context = await contextManager.build({
      agentId: options.agentId,
      messages: state.messages,
      enabledTools: dependencies.tools.definitions(toolContext).map((tool) => tool.name),
      toolUseContext: toolContext,
    });
    const prepared = await prepareMessagesForQuery(state, context, dependencies, compactor);
    if (prepared.compaction?.changed) {
      state = { ...state, messages: prepared.compactedMessages };
      yield { type: "state", phase: "compacting", detail: `${prepared.compaction.reason} freed ${prepared.compaction.tokensFreed ?? 0} chars` };
      for (const message of prepared.compactedMessages.filter((message) => message.metadata?.compactBoundary === true)) {
        yield { type: "message", message };
      }
    }

    const modelOutput = yield* callModelForTurn(state, context, prepared.messagesForQuery, dependencies, options, toolContext);
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

    state = buildNextTurnState(state, {
      assistantMessages,
      toolResults: toolResult.messages,
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
): Promise<PreparedMessages> {
  const baseMessages = state.modelInputMessages ?? getMessagesAfterCompactBoundary(state.messages);
  const budgeted = applyToolResultBudget(baseMessages, {
    maxSerializedLength: dependencies.maxToolResultSerializedLength,
  });
  const compaction = await compactor.compact(budgeted, dependencies.contextBudget);
  const compactedMessages = compaction.messages;
  return {
    messagesForQuery: prependUserContext(compactedMessages, context.userContext),
    compactedMessages,
    compaction: compaction.changed ? compaction : undefined,
  };
}

async function* callModelForTurn(
  state: QueryState,
  context: RuntimeContext,
  messagesForQuery: Message[],
  dependencies: QueryDependencies,
  options: QueryOptions,
  toolContext: ToolUseContext,
): AsyncGenerator<AgentEvent, { terminal?: TerminalReason; output?: ModelTurnOutput; reactiveCompact?: QueryState }, void> {
  const assistantMessages: Message[] = [];
  const toolUses: ToolUseRequest[] = [];
  let previousResponseId = state.previousResponseId;
  let incompleteReason: string | undefined;
  let activeModel = state.currentModel ?? options.model;

  yield { type: "state", phase: "compacting", detail: "messages prepared for model" };
  yield { type: "state", phase: "calling_model", detail: activeModel ? `model stream opened (${activeModel})` : "model stream opened" };

  try {
    for await (const event of dependencies.modelGateway.stream({
      model: activeModel,
      fallbackModel: state.fallbackModel ?? options.fallbackModel,
      messages: messagesForQuery,
      systemPrompt: appendSystemContext(context.systemPrompt, context.systemContext),
      tools: dependencies.tools.definitions(toolContext),
      stream: true,
      maxOutputTokens: state.maxOutputTokensOverride ?? options.maxOutputTokensOverride,
      previousResponseId: state.previousResponseId,
      queryOrigin: options.queryOrigin,
      cancellation: options.abortSignal,
    })) {
      if (options.abortSignal?.aborted) return { terminal: "aborted_streaming" };
      const handled = yield* handleModelEvent(event, assistantMessages, toolUses);
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
      const compactor = dependencies.compactor ?? new DeterministicCompactor();
      const normalized = error instanceof Error ? error : new Error(String(error));
      const compacted = await (compactor.reactiveCompact?.(state.messages, normalized, dependencies.contextBudget) ?? compactor.compact(state.messages, dependencies.contextBudget));
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

  return { output: { assistantMessages, toolUses, previousResponseId, incompleteReason } };
}

async function* handleModelEvent(
  event: ModelStreamEvent,
  assistantMessages: Message[],
  toolUses: ToolUseRequest[],
): AsyncGenerator<AgentEvent, { previousResponseId?: string; incompleteReason?: string }, void> {
  if (event.type === "assistant_delta") {
    yield { type: "assistant.delta", text: event.text };
    return {};
  }

  if (event.type === "assistant_message") {
    assistantMessages.push(event.message);
    for (const toolUse of extractToolUses(event.message)) toolUses.push(toolUse);
    yield { type: "message", message: event.message };
    return {};
  }

  if (event.type === "tool_use") {
    toolUses.push(event.toolUse);
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
    if (event.usage) yield { type: "usage", usage: event.usage };
    return { previousResponseId: event.responseId };
  }

  if (event.type === "response_incomplete") {
    if (event.usage) yield { type: "usage", usage: event.usage };
    return { previousResponseId: event.responseId, incompleteReason: event.reason };
  }

  if (event.type === "error") {
    yield { type: "error", error: event.error };
    return {};
  }

  return {};
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

  const result = await runTools(toolUses, context, { canUseTool: dependencies.canUseTool });

  for (const message of result.messages) {
    context.appState.appendMessage(message);
    yield { type: "message", message };
  }

  for (const toolUse of toolUses) {
    const resultMessage = result.messages.find((message) =>
      message.blocks.some((block) => block.type === "tool_result" && block.toolUseId === toolUse.id),
    );
    yield { type: "tool.finished", toolUse, ok: resultMessage ? toolResultOk(resultMessage) : false };
  }

  return { messages: result.messages, context: result.context };
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
    modelInputMessages: input.previousResponseId ? input.toolResults : undefined,
    previousResponseId: input.previousResponseId,
    turnCount: state.turnCount + 1,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    transition: { reason: "next_turn" },
  };
}

function extractToolUses(message: Message): ToolUseRequest[] {
  return message.blocks
    .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
}

function toolResultOk(message: Message): boolean {
  return message.blocks.every((block) => block.type !== "tool_result" || block.ok);
}

function terminalForModelError(error: unknown): TerminalReason {
  if (error instanceof ModelAPIError) {
    if (error.category === "context_length") return "prompt_too_long";
    if (error.category === "user_abort") return "aborted_streaming";
    if (error.category === "max_output_tokens") return "model_error";
  }
  return "model_error";
}

function isContextLengthError(error: unknown): boolean {
  return error instanceof ModelAPIError && error.category === "context_length";
}
