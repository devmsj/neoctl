import { InMemoryAppState } from "../app/app-state.js";
import type { Compactor, ContextBudgetOptions, CompactionResult } from "../context/compaction.js";
import { ModelDrivenCompactor, withCompactionReport } from "../context/compaction.js";
import type { ContextManager, RuntimeContext } from "../context/context-manager.js";
import { DefaultContextManager } from "../context/context-manager.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent, ReasoningConfig } from "../model/model-gateway.js";
import { ModelAPIError } from "../model/errors.js";
import { AGENT_REPORT_TOOL_NAME } from "../agents/agent-report-tool.js";
import { supportsImageInput } from "../model/context-window.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runTools, type RunToolsEvent } from "../tools/tool-orchestration.js";
import type { CanUseTool, ToolUseContext } from "../tools/tool.js";
import type { AgentEvent } from "../types/events.js";
import { createTaskNotificationMessage, createTextMessage, createThinkingMessage, withoutThinkingBlocks, type Message, type MessageBlock, type ToolUseRequest } from "../types/messages.js";
import {
  applyToolResultBudget,
  ensureToolResultPairing,
  getMessagesAfterCompactBoundary,
  applyRuntimeContextForPromptCache,
  insertUserContextBeforeLatestUser,
} from "./message-pipeline.js";
import {
  createInitialState,
  MAX_REACTIVE_COMPACT_ATTEMPTS,
  nextTracking,
  type QueryState,
  type TerminalReason,
} from "./state.js";
import { AssistantOutputFilter } from "./assistant-output-filter.js";
import { buildContextMetrics, computeStaticTokens } from "./context-metrics.js";
import { buildPromptCacheDiagnostics } from "./prompt-cache-telemetry.js";
import { readImageNoteForStoragePathSync, type ImageRetention } from "./image-notes.js";
import { buildImageRegistry } from "./image-registry.js";

export interface QueryOptions {
  agentId: string;
  model?: string;
  reasoning?: ReasoningConfig | null;
  queryOrigin?: string;
  serviceTier?: ModelRequest["serviceTier"];
  maxOutputTokensOverride?: number;
  contextWindowTokensOverride?: number;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /** Stop the query loop immediately after a successful agent_report tool result. */
  stopOnAgentReport?: boolean;
  /** Tool name that counts as the final subagent report. */
  agentReportToolName?: string;
  /** Force model tool selection for this query run. Used for protocol finalization turns. */
  toolChoice?: ModelRequest["toolChoice"];
  /** Resolved workspace root for tools (e.g. subagent `cwd` from parent `agent` tool). */
  workspaceCwd?: string;
  /** Ephemeral request-scoped context inserted beside the latest user message. */
  requestContext?: Record<string, unknown>;
  /**
   * Native cooperative yield point checked after a complete model turn and its
   * tool results have been appended. Returning true stops before the next model
   * turn, so callers can enqueue another user input without aborting a tool or
   * cutting through provider streaming.
   */
  stopAfterTurn?: (state: QueryState) => boolean;
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
  session?: ToolUseContext["session"];
  secrets?: ToolUseContext["secrets"];
  secretRedactions?: ToolUseContext["secretRedactions"];
  recordContentReplacements?: ToolUseContext["recordContentReplacements"];
  taskNotificationSource?: TaskNotificationSource;
  exportToolCalls?: (calls: ToolUseRequest[]) => void;
  applyCompaction?: (result: CompactionResult) => void | Promise<void>;
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
    options: {
      mainLoopModel: options.model,
      modelGateway: dependencies.modelGateway,
      reasoning: options.reasoning,
    },
    toolResultMemory: dependencies.toolResultMemory,
    session: dependencies.session,
    secrets: dependencies.secrets,
    secretRedactions: dependencies.secretRedactions,
    recordContentReplacements: dependencies.recordContentReplacements,
    emit: () => undefined,
  };

  while (true) {
    if (options.abortSignal?.aborted) return "aborted_streaming";
    if (maxTurns !== undefined && state.turnCount >= maxTurns) return "max_turns";

    state = beginTurn(state);
    toolContext = {
      ...toolContext,
      queryTracking: state.queryTracking,
      messages: state.messages,
      options: {
        ...toolContext.options,
        mainLoopModel: state.currentModel ?? options.model,
        modelGateway: dependencies.modelGateway,
        reasoning: options.reasoning,
      },
    };
    yield { type: "state", phase: state.phase, detail: `turn ${state.turnCount + 1} started (${state.transition.reason})` };

    const context = await contextManager.build({
      agentId: options.agentId,
      messages: state.messages,
      cwd: options.workspaceCwd,
      enabledTools: dependencies.tools.definitions(toolContext).map((tool) => tool.name),
      toolUseContext: toolContext,
    });
    const toolDefinitions = dependencies.tools.definitions(toolContext);
    const systemPrompt = context.systemPrompt;
    const requestContextForTurn = options.requestContext;
    const prepared = await prepareMessagesForQuery(state, context, dependencies, compactor, {
      model: state.currentModel ?? options.model,
      contextWindowTokensOverride: options.contextWindowTokensOverride,
      systemPrompt,
      toolDefinitions,
      toolUseContext: toolContext,
      requestContext: requestContextForTurn,
    });
    if (prepared.compaction?.changed) {
      state = { ...state, messages: prepared.compactedMessages };
      await dependencies.applyCompaction?.(prepared.compaction);
      if (prepared.compaction.report) yield { type: "context.compacted", compaction: prepared.compaction.report };
      yield { type: "state", phase: "compacting", detail: formatCompactionDetail(prepared.compaction) };
      if (!dependencies.applyCompaction) {
        for (const message of prepared.compactedMessages.filter((message) => message.metadata?.compactBoundary === true)) {
          yield { type: "message", message };
        }
      }
    }

    const modelOutput = yield* callModelForTurn(state, context, prepared.messagesForQuery, dependencies, options, toolContext, {
      systemPrompt,
      toolDefinitions,
      metrics: prepared.metrics,
    });
    if (requestContextForTurn) options.requestContext = undefined;
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

    const allToolResults = [...toolResult.messages, ...taskNotifications];
    state = buildNextTurnState(state, {
      assistantMessages,
      toolResults: allToolResults,
      previousResponseId,
    });
    if (options.stopOnAgentReport && hasSuccessfulAgentReport(allToolResults, options.agentReportToolName)) return "completed";
    if (options.stopAfterTurn?.(state)) return "turn_yielded";
  }
}

function beginTurn(state: QueryState): QueryState {
  return {
    ...state,
    phase: "preparing",
    queryTracking: nextTracking(state.queryTracking),
  };
}

function hasSuccessfulAgentReport(messages: readonly Message[], reportToolName = AGENT_REPORT_TOOL_NAME): boolean {
  return messages.some((message) =>
    message.blocks.some((block) => {
      if (block.type !== "tool_result" || block.name !== reportToolName || !block.ok) return false;
      const output = block.output;
      if (!output || typeof output !== "object") return false;
      const status = (output as { status?: unknown }).status;
      const final = (output as { final?: unknown }).final;
      return final === true || status === "completed" || status === "incomplete";
    }),
  );
}

async function prepareMessagesForQuery(
  state: QueryState,
  context: RuntimeContext,
  dependencies: QueryDependencies,
  compactor: Compactor,
  telemetry: { model?: string; contextWindowTokensOverride?: number; systemPrompt: string; toolDefinitions: ReturnType<ToolRegistry["definitions"]>; toolUseContext?: ToolUseContext; requestContext?: Record<string, unknown> },
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

  const staticTokens = computeStaticTokens(telemetry.systemPrompt, telemetry.toolDefinitions);
  const pairedBudgetedWithRuntimeContext = applyRequestContext(
    applyRuntimeContextForPromptCache(pairedBudgeted, context.userContext, context.systemContext),
    telemetry.requestContext,
  );

  const metricsBeforeCompact = buildContextMetrics({
    model: telemetry.model,
    contextWindowTokensOverride: telemetry.contextWindowTokensOverride,
    messages: pairedBudgetedWithRuntimeContext,
    systemPrompt: telemetry.systemPrompt,
    tools: telemetry.toolDefinitions,
    cachedToolsAndPromptTokens: staticTokens,
    cacheDiagnostics: buildPromptCacheDiagnostics({
      model: telemetry.model,
      systemPrompt: telemetry.systemPrompt,
      promptSections: context.promptSections,
      tools: telemetry.toolDefinitions,
      messages: pairedBudgetedWithRuntimeContext,
    }),
  });
  const compaction = withCompactionReport(await compactor.compact(pairedBudgeted, {
    ...dependencies.contextBudget,
    estimatedInputTokens: metricsBeforeCompact.estimatedInputTokens,
    contextWindowTokens: metricsBeforeCompact.contextWindowTokens,
  }), pairedBudgeted.length);
  const compactedMessages = ensureToolResultPairing(compaction.messages);
  const retentionAppliedMessages = applyImageRetention(compactedMessages);
  const messagesForQuery = applyRequestContext(
    applyRuntimeContextForPromptCache(retentionAppliedMessages, context.userContext, context.systemContext),
    telemetry.requestContext,
  );
  const metrics = buildContextMetrics({
    model: telemetry.model,
    contextWindowTokensOverride: telemetry.contextWindowTokensOverride,
    messages: messagesForQuery,
    systemPrompt: telemetry.systemPrompt,
    tools: telemetry.toolDefinitions,
    cachedToolsAndPromptTokens: staticTokens,
    cacheDiagnostics: buildPromptCacheDiagnostics({
      model: telemetry.model,
      systemPrompt: telemetry.systemPrompt,
      promptSections: context.promptSections,
      tools: telemetry.toolDefinitions,
      messages: messagesForQuery,
    }),
  });
  return {
    messagesForQuery,
    compactedMessages,
    compaction: compaction.changed ? compaction : undefined,
    metrics,
  };
}

function applyRequestContext(messages: readonly Message[], requestContext: Record<string, unknown> | undefined): Message[] {
  return requestContext && Object.keys(requestContext).length > 0
    ? insertUserContextBeforeLatestUser(messages, requestContext)
    : [...messages];
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
  const modelMessages = withoutThinkingBlocks(adaptMessagesForModelCapabilities(messagesForQuery, activeModel));

  yield { type: "state", phase: "preparing", detail: "messages prepared for model" };
  yield { type: "context.metrics", metrics: telemetry.metrics };
  yield { type: "state", phase: "calling_model", detail: activeModel ? `model stream opened (${activeModel})` : "model stream opened" };

  try {
    for await (const event of dependencies.modelGateway.stream({
      model: activeModel,
      messages: modelMessages,
      systemPrompt: telemetry.systemPrompt,
      tools: telemetry.toolDefinitions,
      toolChoice: options.toolChoice,
      stream: true,
      maxOutputTokens: state.maxOutputTokensOverride ?? options.maxOutputTokensOverride,
      reasoning: options.reasoning,
      previousResponseId: state.previousResponseId,
      queryOrigin: options.queryOrigin,
      serviceTier: options.serviceTier,
      cancellation: options.abortSignal,
    })) {
      if (options.abortSignal?.aborted) {
        const thinkingMessage = finalizeThinkingMessage(assistantMessages, thinkingParts);
        if (thinkingMessage) yield { type: "message", message: thinkingMessage };
        return { terminal: "aborted_streaming" };
      }
      const handled = yield* handleModelEvent(event, assistantMessages, toolUses, outputFilter, thinkingParts);
      previousResponseId = handled.previousResponseId ?? previousResponseId;
      incompleteReason = handled.incompleteReason ?? incompleteReason;

    }
  } catch (error) {
    const attempts = state.reactiveCompactAttempts ?? 0;
    if (isContextLengthError(error) && attempts < MAX_REACTIVE_COMPACT_ATTEMPTS) {
      const compactor = dependencies.compactor ?? new ModelDrivenCompactor(dependencies.modelGateway);
      const normalized = error instanceof Error ? error : new Error(String(error));
      const reactiveMetrics = buildContextMetrics({
        model: activeModel,
        contextWindowTokensOverride: options.contextWindowTokensOverride,
        messages: state.messages,
        systemPrompt: telemetry.systemPrompt,
        tools: telemetry.toolDefinitions,
      });

      const escalationFactor = attempts + 1;
      const baseSummaryMax = dependencies.contextBudget?.summaryMaxChars ?? 6000;
      const escalatedSummaryMax = Math.max(1000, baseSummaryMax - escalationFactor * 1500);

      const reactiveBudget: ContextBudgetOptions = {
        ...dependencies.contextBudget,
        estimatedInputTokens: reactiveMetrics.estimatedInputTokens,
        contextWindowTokens: reactiveMetrics.contextWindowTokens,
        summaryMaxChars: escalatedSummaryMax,
      };
      const compacted = withCompactionReport(
        await (compactor.reactiveCompact?.(state.messages, normalized, reactiveBudget) ?? compactor.compact(state.messages, reactiveBudget)),
        state.messages.length,
      );
      if (!compacted.changed) {
        yield { type: "error", error: normalized };
        return { terminal: terminalForModelError(normalized) };
      }
      await dependencies.applyCompaction?.(compacted);
      if (compacted.report) yield { type: "context.compacted", compaction: compacted.report };
      yield { type: "state", phase: "compacting", detail: `reactive compact retry ${attempts + 1}/${MAX_REACTIVE_COMPACT_ATTEMPTS} after prompt-too-long` };
      if (!dependencies.applyCompaction) {
        for (const message of compacted.messages.filter((message) => message.metadata?.compactBoundary === true)) {
          yield { type: "message", message };
        }
      }
      return {
        reactiveCompact: {
          ...state,
          messages: compacted.messages,
          modelInputMessages: compacted.messages,
          hasAttemptedReactiveCompact: attempts + 1 >= MAX_REACTIVE_COMPACT_ATTEMPTS,
          reactiveCompactAttempts: attempts + 1,
          turnCount: state.turnCount + 1,
          transition: { reason: "reactive_compact_retry", detail: `attempt ${attempts + 1}: ${normalized.message}` },
        },
      };
    }

    const thinkingMessage = finalizeThinkingMessage(assistantMessages, thinkingParts);
    if (thinkingMessage) yield { type: "message", message: thinkingMessage };
    const terminal = terminalForModelError(error);
    yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
    return { terminal };
  }

  if (options.abortSignal?.aborted) {
    const thinkingMessage = finalizeThinkingMessage(assistantMessages, thinkingParts);
    if (thinkingMessage) yield { type: "message", message: thinkingMessage };
    return { terminal: "aborted_streaming" };
  }

  // Some providers end a tool-calling turn without a finalized text message.
  // Release the filter's safety hold-back before the tool boundary so the UI
  // does not defer the last part of the assistant's pre-tool narration.
  const heldBackText = outputFilter.flush();
  if (heldBackText) yield { type: "assistant.delta", text: heldBackText };

  if (toolUses.length) dependencies.exportToolCalls?.(toolUses);
  const syntheticToolUseMessage = appendSyntheticToolUseMessage(assistantMessages, toolUses);
  if (syntheticToolUseMessage) yield { type: "message", message: syntheticToolUseMessage };
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

function formatUnsupportedImagePlaceholder(block: { mimeType: string; label?: string; storage?: { path: string; format: string } }): string {
  const label = block.label?.trim();
  const storage = block.storage?.path ? ` Stored ${block.storage.format} payload: ${block.storage.path}. Use the load_image tool with this image label/id on a vision-capable model for visual inspection, or view/read only for the stored base64 text.` : "";
  const suffix = `[image ${block.mimeType} omitted: current model does not support image input.${storage}]`;
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
    const heldBackText = outputFilter.flush();
    if (heldBackText) yield { type: "assistant.delta", text: heldBackText };
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
    const thinkingMessage = finalizeThinkingMessage(assistantMessages, thinkingParts);
    if (thinkingMessage) yield { type: "message", message: thinkingMessage };
    yield { type: "error", error: event.error };
    return {};
  }

  return {};
}

function finalizeThinkingMessage(assistantMessages: Message[], thinkingParts: string[]): Message | undefined {
  const text = thinkingParts.join("").trim();
  if (!text) return undefined;
  const providerFinalizedThinking = assistantMessages.some((message) =>
    message.blocks.some((block) => block.type === "thinking"),
  );
  thinkingParts.length = 0;
  if (providerFinalizedThinking) return undefined;
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
  for (const [index, toolUse] of toolUses.entries()) yield { type: "tool.started", toolUse, index, total: toolUses.length };

  if (options.abortSignal?.aborted) return { terminal: "aborted_tools", messages: [], context };

  const events = new AsyncEventQueue<RunToolsEvent>(2048, compactRunToolsQueue);
  const closeOnAbort = () => events.close();
  options.abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  const running = abortable(
    runTools(toolUses, context, {
      canUseTool: dependencies.canUseTool,
      onEvent: (event) => events.push(event),
    }).finally(() => events.close()),
    options.abortSignal,
  );

  try {
    for await (const event of events) {
      if (event.type === "progress") {
        yield { type: "tool.progress", toolUse: event.request, progress: event.progress, index: event.index, total: event.total };
        continue;
      }
      const messages = event.updates.map((update) => update.message);
      yield { type: "tool.result.available", toolUse: event.request, ok: event.ok, messages, index: event.index, total: event.total };
      yield { type: "tool.finished", toolUse: event.request, ok: event.ok, index: event.index, total: event.total };
    }
  } finally {
    options.abortSignal?.removeEventListener("abort", closeOnAbort);
  }

  const result = await running;
  if (!result.completed) return { terminal: "aborted_tools", messages: [], context };

  for (const message of result.value.messages) {
    context.appState.appendMessage(message);
    yield { type: "message", message };
  }

  const succeeded = toolUses.filter((toolUse) => {
    const resultMessage = result.value.messages.find((message) =>
      message.blocks.some((block) => block.type === "tool_result" && block.toolUseId === toolUse.id),
    );
    return resultMessage ? toolResultOk(resultMessage) : false;
  }).length;
  yield { type: "tool.batch.completed", total: toolUses.length, succeeded, failed: toolUses.length - succeeded };

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

function compactRunToolsQueue(values: RunToolsEvent[], incoming: RunToolsEvent): boolean {
  if (incoming.type === "progress") {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const existing = values[index];
      if (existing.type === "settled" && existing.request.id === incoming.request.id) break;
      if (existing.type !== "progress" || existing.request.id !== incoming.request.id) continue;
      if (existing.progress.channel !== incoming.progress.channel || existing.progress.key !== incoming.progress.key) break;
      values[index] = incoming;
      return true;
    }
  }
  const disposable = values.findIndex((event) => event.type === "progress");
  if (disposable < 0) return false;
  values.splice(disposable, 1);
  values.push(incoming);
  return true;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(
    private readonly maxValues = Number.POSITIVE_INFINITY,
    private readonly compact?: (values: T[], incoming: T) => boolean,
  ) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else if (this.values.length < this.maxValues || !this.compact?.(this.values, value)) this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
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
    reactiveCompactAttempts: 0,
    maxOutputTokensOverride: undefined,
    transition: { reason: "next_turn" },
  };
}

function appendSyntheticToolUseMessage(assistantMessages: Message[], toolUses: ToolUseRequest[]): Message | undefined {
  const missing = toolUses.filter((toolUse) =>
    !assistantMessages.some((message) =>
      message.blocks.some((block) => block.type === "tool_use" && block.id === toolUse.id),
    ),
  );
  if (!missing.length) return undefined;

  const message: Message = {
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
  };
  assistantMessages.push(message);
  return message;
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
  return `${compaction.reason ?? "compact"} reduced context by ${compaction.charsFreed ?? compaction.tokensFreed ?? 0} chars`;
}

function applyImageRetention(messages: readonly Message[]): Message[] {
  let changed = false;
  let assistantTurnsSinceImage = 0;
  const next = [...messages];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") assistantTurnsSinceImage += 1;
    if (!message.blocks.some((block) => block.type === "image")) continue;

    const retentionPolicy = resolveMessageImageRetention(message);
    if (!retentionPolicy) continue;
    const { retention, ttlTurns } = retentionPolicy;
    const shouldKeepPixels = retention === "pinned" || (retention === "while_relevant" && assistantTurnsSinceImage <= ttlTurns) || (retention === "next_turn" && assistantTurnsSinceImage <= 1);
    if (shouldKeepPixels) continue;

    const imageRegistry = buildImageRegistry([message]);
    const blocks: MessageBlock[] = message.blocks.flatMap((block) => {
      if (block.type !== "image") return [block];
      const label = block.label ?? "image";
      const entry = imageRegistry.images.find((image) => image.label === block.label || image.storagePath === block.storage?.path);
      const ref = entry?.id ?? label;
      return [{ type: "text", text: `[image pixels omitted after ${retention} retention expired: ${label}; use load_image with ${ref} if visual inspection is needed]` }];
    });
    next[index] = {
      ...message,
      blocks,
      metadata: { ...message.metadata, imagePixelsOmittedByRetention: true, imageRegistry },
    };
    changed = true;
  }

  return changed ? next : [...messages];
}

function resolveMessageImageRetention(message: Message): { retention: ImageRetention; ttlTurns: number } | undefined {
  const metadataRetention = message.metadata?.imageRetention;
  const noteRetention = retentionFromImageNotes(message);
  const retention = isImageRetention(metadataRetention) ? metadataRetention : noteRetention;
  if (!retention) return undefined;
  const metadataTtl = message.metadata?.imageTtlTurns;
  const noteTtl = ttlFromImageNotes(message);
  const ttlTurns = noteTtl ?? (typeof metadataTtl === "number" && Number.isFinite(metadataTtl)
    ? Math.max(1, Math.min(12, Math.round(metadataTtl)))
    : 4);
  return { retention, ttlTurns };
}

function retentionFromImageNotes(message: Message): ImageRetention | undefined {
  for (const block of message.blocks) {
    if (block.type !== "image" || !block.storage?.path) continue;
    const note = readImageNoteForStoragePathSync(block.storage.path);
    if (isImageRetention(note?.retention)) return note.retention;
  }
  return undefined;
}

function ttlFromImageNotes(message: Message): number | undefined {
  for (const block of message.blocks) {
    if (block.type !== "image" || !block.storage?.path) continue;
    const note = readImageNoteForStoragePathSync(block.storage.path);
    if (typeof note?.ttlTurns === "number" && Number.isFinite(note.ttlTurns)) return Math.max(1, Math.min(12, Math.round(note.ttlTurns)));
  }
  return undefined;
}

function isImageRetention(value: unknown): value is ImageRetention {
  return value === "next_turn" || value === "while_relevant" || value === "pinned";
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
    return createTaskNotificationMessage({
      taskId: task.taskId,
      agentId: task.agentId,
      status: task.status,
      type: task.type,
      content: task.content,
    });
  });
}
