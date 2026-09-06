import { resolve } from "node:path";
import { ModelAPIError } from "../model/errors.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { QueryEngine } from "../core/query-engine.js";
import { buildContextMetrics, estimateTextTokens } from "../core/context-metrics.js";
import { buildPromptCacheIdentity } from "../core/prompt-cache-key.js";
import { resolveContextWindowTokens } from "../model/context-window.js";
import { applyRuntimeContextForPromptCache, applyToolResultBudget, ensureToolResultPairing, getMessagesAfterCompactBoundary, hasValidToolResultPairing, insertUserContextBeforeLatestUser } from "../core/message-pipeline.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTextMessage, createThinkingMessage, createToolResultMessage } from "../types/messages.js";
import { CLEARED_TOOL_RESULT_CONTENT, DeterministicCompactor, ManualOnlyCompactor, microCompactIfNeeded, ModelDrivenCompactor, withCompactionReport } from "./compaction.js";
import { AdditionalPromptContextManager, DefaultContextManager } from "./context-manager.js";
import { buildEffectiveSystemPrompt, splitSystemPromptPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./prompts.js";

class CapturingGateway implements ModelGateway {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { type: "assistant_message", message: createTextMessage("assistant", "ok") };
    yield { type: "response_completed", responseId: `capture_${this.requests.length}`, stopReason: "completed" };
  }
}

class ContextOverflowThenSuccessGateway implements ModelGateway {
  calls = 0;
  sawBoundaryOnRetry = false;
  sawUserContext = false;
  sawSystemContext = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.sawUserContext ||= request.messages.some((message) => message.metadata?.userContext === true);
    this.sawSystemContext ||= request.messages.some((message) => message.metadata?.systemContext === true);

    if (this.calls === 1) {
      throw new ModelAPIError({
        category: "context_length",
        provider: "fake",
        message: "context length exceeded",
        retryable: false,
      });
    }

    this.sawBoundaryOnRetry = request.messages.some((message) => message.metadata?.compactBoundary === true);
    yield { type: "assistant_message", message: createTextMessage("assistant", "compacted") };
    yield { type: "response_completed", responseId: "resp_context", stopReason: "completed" };
  }
}

class SummaryGateway implements ModelGateway {
  compactCalls = 0;
  requestText = "";
  lastRequest?: ModelRequest;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin !== "compact") throw new Error(`Unexpected query origin: ${request.queryOrigin}`);
    this.compactCalls += 1;
    this.lastRequest = request;
    this.requestText += JSON.stringify(request.messages);
    yield {
      type: "assistant_delta",
      text: "目标：提高压缩摘要质量。\n关键路径：C:\\Users\\qyq\\Desktop\\work\\codex\n当前状态：已完成调查。\n下一步：finish validation. AUTHORITY_SUMMARY_END",
    };
    yield { type: "response_completed", responseId: "compact_1", stopReason: "completed" };
  }
}

class SequenceSummaryGateway implements ModelGateway {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const text = this.requests.length === 1
      ? "Goal: original goal. Status: investigation pending. OLDER_CHECKPOINT"
      : "Goal: corrected goal. Status: implementation approved and in progress. LATEST_CHECKPOINT";
    yield { type: "assistant_delta", text };
    yield { type: "response_completed", responseId: `compact_${this.requests.length}`, stopReason: "completed" };
  }
}

class ThresholdAutoCompactGateway implements ModelGateway {
  compactCalls = 0;
  modelCalls = 0;
  sawBoundary = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin === "compact") {
      this.compactCalls += 1;
      yield { type: "assistant_delta", text: "Goal: preserve the current request. Status: ready after automatic compaction." };
      yield { type: "response_completed", responseId: "compact_threshold", stopReason: "completed" };
      return;
    }
    this.modelCalls += 1;
    this.sawBoundary = request.messages.some((message) => message.metadata?.compactBoundary === true);
    yield { type: "assistant_message", message: createTextMessage("assistant", "automatic compact succeeded") };
    yield { type: "response_completed", responseId: "response_threshold", stopReason: "completed" };
  }
}

async function main(): Promise<void> {
  const prompt = buildEffectiveSystemPrompt([
    { name: "Stable", content: "cache me", cacheStable: true },
    { name: "Dynamic", content: "session only", cacheStable: false },
  ]);
  const split = splitSystemPromptPrefix(prompt);
  const promptOk =
    prompt.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) &&
    split.stablePrefix.includes("cache me") &&
    split.dynamicSuffix.includes("session only");

  const contextManager = new DefaultContextManager({ currentDate: () => "2026-05-05" });
  const sessionDir = resolve(".neo-session-stable");
  const toolUseContext = { session: { sessionId: "stable", sessionDir }, agentId: "main" } as never;
  const runtime = await contextManager.build({ agentId: "main", messages: [createTextMessage("user", "hello")], toolUseContext });
  const extendedRuntime = await new AdditionalPromptContextManager(contextManager, [{
    name: "Web Plugin",
    content: "stable plugin contract",
    cacheStable: true,
  }]).build({ agentId: "main", messages: [createTextMessage("user", "hello")] });
  const extensionOk =
    extendedRuntime.promptSections.some((section) => section.name === "Web Plugin" && section.cacheStable === true) &&
    splitSystemPromptPrefix(extendedRuntime.systemPrompt).stablePrefix.includes("stable plugin contract");
  const firstHistory = [createTextMessage("user", "first")];
  const secondHistory = [...firstHistory, createTextMessage("assistant", "answer"), createTextMessage("user", "second")];
  const runtimeContextMessages = applyRuntimeContextForPromptCache(firstHistory, runtime.userContext, runtime.systemContext);
  const nextRuntimeContextMessages = applyRuntimeContextForPromptCache(secondHistory, runtime.userContext, runtime.systemContext);
  const changedCwdMessages = applyRuntimeContextForPromptCache(secondHistory, runtime.userContext, { ...runtime.systemContext, cwd: `${runtime.systemContext.cwd}-next` });
  const changedSessionMessages = applyRuntimeContextForPromptCache(secondHistory, runtime.userContext, { ...runtime.systemContext, sessionDir: `${sessionDir}-next` });
  const cwdTransitionMessages = insertUserContextBeforeLatestUser(changedCwdMessages, { cwdTransition: { paths: ["A", "B", "C"], current: "C" } });
  const lastRuntimeBlock = runtimeContextMessages.at(-1)?.blocks[0];
  const firstRuntimeBlock = runtimeContextMessages[0]?.blocks[0];
  const nextFirstRuntimeBlock = nextRuntimeContextMessages[0]?.blocks[0];
  const changedFirstRuntimeBlock = changedCwdMessages[0]?.blocks[0];
  const changedSessionRuntimeBlock = changedSessionMessages[0]?.blocks[0];
  const cwdTransitionBlock = cwdTransitionMessages.at(-2)?.blocks[0];
  const cacheIdentity = buildPromptCacheIdentity(runtime.systemPrompt, [], "fake", runtimeContextMessages);
  const changedCwdIdentity = buildPromptCacheIdentity(runtime.systemPrompt, [], "fake", changedCwdMessages);
  const changedSessionIdentity = buildPromptCacheIdentity(runtime.systemPrompt, [], "fake", changedSessionMessages);
  const toolBudgetPromptOccurrences = runtime.systemPrompt.split("Tool results use a default context budget").length - 1;
  const contextOk =
    toolBudgetPromptOccurrences === 1 &&
    runtime.systemPrompt.includes("48000 serialized characters") &&
    runtime.systemPrompt.includes("within 1-200000") &&
    runtime.userContext.currentDate === "2026-05-05" &&
    Boolean(runtime.systemContext.cwd) &&
    runtime.systemContext.sessionDir === sessionDir &&
    !runtime.systemPrompt.includes("## System Context") &&
    runtimeContextMessages[0]?.metadata?.userContext === true &&
    runtimeContextMessages[0]?.metadata?.systemContext === true &&
    firstRuntimeBlock?.type === "text" &&
    nextFirstRuntimeBlock?.type === "text" &&
    changedFirstRuntimeBlock?.type === "text" &&
    changedSessionRuntimeBlock?.type === "text" &&
    firstRuntimeBlock.text === nextFirstRuntimeBlock.text &&
    firstRuntimeBlock.text === changedFirstRuntimeBlock.text &&
    firstRuntimeBlock.text !== changedSessionRuntimeBlock.text &&
    firstRuntimeBlock.text.split(`sessionDir: ${sessionDir}`).length - 1 === 1 &&
    cacheIdentity.key === changedCwdIdentity.key &&
    cacheIdentity.key !== changedSessionIdentity.key &&
    changedCwdMessages.at(-2)?.metadata?.cacheStableRuntimeContext === false &&
    cwdTransitionBlock?.type === "text" &&
    cwdTransitionBlock.text.includes('"paths":["A","B","C"]') === true &&
    lastRuntimeBlock?.type === "text" &&
    lastRuntimeBlock.text === "first";

  const recoveryGateway = new CapturingGateway();
  const recoveryEngine = new QueryEngine({
    modelGateway: recoveryGateway,
    tools: new ToolRegistry(),
    session: { enabled: false },
  });
  let recoveryConsumed = 0;
  recoveryEngine.noteRecoverableSubagents(() => { recoveryConsumed += 1; });
  const preAborted = new AbortController();
  preAborted.abort();
  for await (const _event of recoveryEngine.sendUserText("aborted before model", { abortSignal: preAborted.signal })) { /* consume */ }
  for await (const _event of recoveryEngine.sendUserText("first recovery turn")) { /* consume */ }
  for await (const _event of recoveryEngine.sendUserText("second turn")) { /* consume */ }
  const recoveryFirstText = JSON.stringify(recoveryGateway.requests[0]?.messages ?? []);
  const recoverySecondText = JSON.stringify(recoveryGateway.requests[1]?.messages ?? []);
  const recoveryHintOk =
    recoveryGateway.requests.length === 2 &&
    recoveryConsumed === 1 &&
    recoveryFirstText.split("Interrupted subagents can be resumed.").length - 1 === 1 &&
    !recoverySecondText.includes("Interrupted subagents can be resumed.") &&
    !JSON.stringify(recoveryGateway.requests[0]?.messages[0]).includes("Interrupted subagents can be resumed.");

  const toolResult = createToolResultMessage({ id: "call_big", name: "big", input: {} }, true, "x".repeat(120));
  const budgeted = applyToolResultBudget([toolResult], { maxSerializedLength: 20 });
  const budgetOk = budgeted[0].metadata?.budgeted === true;

  const compactor = new DeterministicCompactor();
  const longHistory = Array.from({ length: 12 }, (_, index) => createTextMessage(index % 2 ? "assistant" : "user", `${index}: ${"x".repeat(600)}`));
  const compacted = await compactor.compact(longHistory, {
    snipMaxChars: 2000,
    microCompactMaxChars: 1800,
    autoCompactMaxChars: 1500,
    keepRecentMessages: 4,
  });
  const reportedCompaction = withCompactionReport(compacted, longHistory.length);
  const compactBoundary = reportedCompaction.messages.find((message) => message.metadata?.compactBoundary === true);
  const preservedUsers = reportedCompaction.messages.filter((message) => message.metadata?.compactPreservedUser === true);
  const compactReportOk =
    reportedCompaction.report?.sourceMessages === longHistory.length &&
    reportedCompaction.report.preservedUserMessages === preservedUsers.length &&
    reportedCompaction.report.newWindowMessages === reportedCompaction.messages.length &&
    reportedCompaction.report.summary.length > 0 &&
    reportedCompaction.report.continuationState.length > 0 &&
    compactBoundary?.metadata?.compactionReport !== undefined;
  const compactOk =
    compacted.changed &&
    compactBoundary?.role === "system" &&
    reportedCompaction.messages.at(-1)?.metadata?.compactBoundary === true &&
    reportedCompaction.messages.slice(0, -1).every((message) => message.role === "user" && message.isMeta !== true) &&
    getMessagesAfterCompactBoundary(reportedCompaction.messages).length === reportedCompaction.messages.length &&
    JSON.stringify(compactBoundary).includes("Internal continuation state") &&
    !JSON.stringify(compactBoundary).includes("Conversation summary");

  const metaUser = { ...createTextMessage("user", "runtime metadata"), isMeta: true, metadata: { runtimeContext: true } };
  const imageUser = {
    ...createTextMessage("user", "latest request with image"),
    blocks: [
      { type: "text" as const, text: "latest request with image" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=", label: "latest-image" },
    ],
  };
  const oversizedUser = createTextMessage("user", `old oversized request ${"long-token ".repeat(120)}`);
  const budgetHistory = [
    oversizedUser,
    createTextMessage("assistant", "assistant content must not survive"),
    createToolResultMessage({ id: "budget-tool", name: "file_read", input: {} }, true, "tool content must not survive"),
    metaUser,
    imageUser,
  ];
  const budgetCompacted = await compactor.manualCompact(budgetHistory, { keepRecentTokenBudget: 80, summaryMaxChars: 2000 });
  const budgetPreserved = budgetCompacted.messages.slice(0, -1);
  const budgetPreservedTokens = budgetPreserved.reduce((total, message) => total + estimateTextTokens(message.blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return `[image ${block.label ?? "unlabeled"} ${block.mimeType}; estimated visual token chars=340; pixels are not text-summarized]`;
    return "";
  }).join("\n")), 0);
  const budgetWindowOk =
    budgetCompacted.messages.at(-1)?.metadata?.compactBoundary === true &&
    budgetPreserved.every((message) => message.role === "user" && message.isMeta !== true) &&
    budgetPreserved[0]?.id === oversizedUser.id &&
    budgetPreserved.at(-1)?.id === imageUser.id &&
    budgetPreserved.some((message) => message.blocks.some((block) => block.type === "image" && block.label === "latest-image")) &&
    budgetPreserved.some((message) => message.blocks.some((block) => block.type === "text" && block.text.includes("truncated for compaction token budget"))) &&
    budgetCompacted.summary?.includes("assistant content must not survive") === true &&
    budgetCompacted.summary.includes("tool content must not survive") &&
    budgetPreservedTokens <= 80 &&
    !JSON.stringify(budgetPreserved).includes("assistant content must not survive") &&
    !JSON.stringify(budgetPreserved).includes("tool content must not survive") &&
    !JSON.stringify(budgetPreserved).includes("runtime metadata");

  const defaultBudgetHistory = [
    createTextMessage("user", `default budget boundary ${"token-word ".repeat(30_000)}`),
    createTextMessage("assistant", "not preserved"),
  ];
  const defaultBudgetCompacted = await compactor.manualCompact(defaultBudgetHistory, { summaryMaxChars: 500 });
  const defaultBudgetTokens = defaultBudgetCompacted.messages.slice(0, -1)
    .reduce((total, message) => total + estimateTextTokens(message.blocks.map((block) => block.type === "text" ? block.text : "").join("\n")), 0);
  const defaultBudgetOk =
    defaultBudgetTokens <= 20_000 &&
    defaultBudgetTokens >= 19_500 &&
    defaultBudgetCompacted.messages.slice(0, -1).every((message) => message.role === "user") &&
    defaultBudgetCompacted.messages.at(-1)?.metadata?.compactBoundary === true;

  const fallbackToolUse = {
    id: "assistant_fallback_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "fallback_call", name: "file_search", input: { query: "codex" } }],
  };
  const fallbackHistory = [
    createTextMessage("user", "提高摘要质量，参考仓库 C:\\Users\\qyq\\Desktop\\work\\codex，不要使用子代理。"),
    createTextMessage("assistant", "已完成 Codex 调查，等待实施。"),
    fallbackToolUse,
    ...Array.from({ length: 8 }, (_, index) => createToolResultMessage(
      { id: `fallback_fail_${index}`, name: "file_search", input: {} },
      false,
      `transient failure ${index}`,
    )),
    createToolResultMessage({ id: "fallback_call", name: "file_search", input: {} }, true, "Codex compaction prompt located."),
  ];
  const fallbackCompacted = await compactor.manualCompact(fallbackHistory, { keepRecentTokenBudget: 200, summaryMaxChars: 1800 });
  const fallbackSummary = fallbackCompacted.summary ?? "";
  const fallbackQualityOk =
    fallbackSummary.includes("提高摘要质量") &&
    fallbackSummary.includes("C:\\Users\\qyq\\Desktop\\work\\codex") &&
    fallbackSummary.includes("已完成 Codex 调查") &&
    fallbackSummary.includes("Next step:") &&
    !fallbackSummary.includes("Persistent facts:") &&
    !fallbackSummary.includes("transient failure 0") &&
    !fallbackSummary.includes("transient failure 7");

  const consecutiveHistory = [...budgetCompacted.messages, createTextMessage("assistant", "new assistant"), createTextMessage("user", "newest real request")];
  const secondCompacted = await compactor.manualCompact(consecutiveHistory, { keepRecentTokenBudget: 200, summaryMaxChars: 3000 });
  const consecutiveCompactOk =
    secondCompacted.messages.at(-1)?.metadata?.compactBoundary === true &&
    secondCompacted.messages.filter((message) => message.metadata?.compactBoundary === true).length === 1 &&
    secondCompacted.messages.slice(0, -1).every((message) => message.role === "user" && message.isMeta !== true) &&
    getMessagesAfterCompactBoundary(secondCompacted.messages).length === secondCompacted.messages.length &&
    secondCompacted.summary?.includes("newest real request") === true;

  const toolUseOld = {
    id: "assistant_old_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_old", name: "file_search", input: { query: "old" } }],
  };
  const toolUseNew = {
    id: "assistant_new_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_new", name: "file_search", input: { query: "new" } }],
  };
  const oldResult = createToolResultMessage({ id: "call_old", name: "file_search", input: {} }, true, "old".repeat(1200));
  const newResult = createToolResultMessage({ id: "call_new", name: "file_search", input: {} }, true, "new".repeat(1200));
  const micro = microCompactIfNeeded([toolUseOld, oldResult, toolUseNew, newResult], { microCompactMaxChars: 100, keepRecentToolResults: 1 });
  const oldOutput = micro.messages[1]?.blocks[0]?.type === "tool_result" ? micro.messages[1].blocks[0].output : undefined;
  const newOutput = micro.messages[3]?.blocks[0]?.type === "tool_result" ? micro.messages[3].blocks[0].output : undefined;
  const microOk = micro.changed && oldOutput === CLEARED_TOOL_RESULT_CONTENT && typeof newOutput === "string" && newOutput.startsWith("new");

  const orphanResult = createToolResultMessage({ id: "call_orphan", name: "file_search", input: {} }, true, "orphan");
  const paired = ensureToolResultPairing([toolUseOld, createTextMessage("assistant", "done"), orphanResult]);
  const pairedJson = JSON.stringify(paired);
  const pairingOk =
    hasValidToolResultPairing(paired) &&
    pairedJson.includes("call_old") &&
    pairedJson.includes("synthetic failure result") &&
    !pairedJson.includes("call_orphan");

  const bigGrepUse = {
    id: "assistant_big_grep",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_big_grep", name: "file_search", input: { query: "^|\\S", root: ".." } }],
  };
  const bigGrepResult = createToolResultMessage(
    { id: "call_big_grep", name: "file_search", input: {} },
    true,
    JSON.stringify({ query: "^|\\S", root: "..", matches: Array.from({ length: 600 }, (_, index) => `match ${index}: ${"x".repeat(80)}`) }),
  );
  const budgetedGrep = applyToolResultBudget([bigGrepUse, bigGrepResult], { maxSerializedLength: 1200 });
  const microGrep = microCompactIfNeeded(budgetedGrep, { microCompactMaxChars: 100, keepRecentToolResults: 1 });
  const repairedGrep = ensureToolResultPairing(microGrep.messages);
  const grepOutput =
    repairedGrep[1]?.blocks[0]?.type === "tool_result" ? String(repairedGrep[1].blocks[0].output) : "";
  const grepRegressionOk =
    hasValidToolResultPairing(repairedGrep) &&
    grepOutput.startsWith("[Tool result truncated for context budget: original ") &&
    !grepOutput.includes('"preview"') &&
    !grepOutput.includes('"truncated"');

  const summaryGateway = new SummaryGateway();
  const modelCompactor = new ModelDrivenCompactor(summaryGateway);
  const summaryToolUse = {
    id: "assistant_summary_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "summary_call", name: "file_read", input: { path: "C:\\Users\\qyq\\Desktop\\work\\codex" } }],
  };
  const summaryToolResult = createToolResultMessage({ id: "summary_call", name: "file_read", input: {} }, false, "temporary read failure");
  const summaryImageUser = {
    ...createTextMessage("user", "historical image reference"),
    blocks: [
      { type: "text" as const, text: "historical image reference" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=", label: "summary-history-image" },
    ],
  };
  const largeSummaryToolUse = {
    id: "assistant_large_summary_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "large_summary_call", name: "file_read", input: { path: "large.log" } }],
  };
  const largeSummaryToolResult = createToolResultMessage(
    { id: "large_summary_call", name: "file_read", input: {} },
    true,
    `START_SENTINEL ${"large-output ".repeat(1500)} END_SENTINEL`,
  );
  const modelHistory = [
    createTextMessage("user", "Please improve summary quality. Codex repository: C:\\Users\\qyq\\Desktop\\work\\codex"),
    createThinkingMessage("private persisted reasoning"),
    summaryImageUser,
    summaryToolUse,
    summaryToolResult,
    largeSummaryToolUse,
    largeSummaryToolResult,
    ...longHistory,
  ];
  const modelCompacted = await modelCompactor.compact(modelHistory, {
    snipMaxChars: 20000,
    microCompactMaxChars: 19000,
    autoCompactMaxChars: 1500,
    keepRecentMessages: 3,
    summaryMaxChars: 24,
  });
  const compactRequestMessages = summaryGateway.lastRequest?.messages ?? [];
  const compactInstruction = compactRequestMessages.at(-1);
  const modelCompactOk =
    summaryGateway.compactCalls === 1 &&
    compactRequestMessages.length === modelHistory.length &&
    compactRequestMessages[0]?.role === "user" &&
    compactRequestMessages.some((message) => message.blocks.some((block) => block.type === "tool_use" && block.id === "summary_call")) &&
    compactRequestMessages.some((message) => message.blocks.some((block) => block.type === "tool_result" && block.toolUseId === "summary_call")) &&
    compactRequestMessages.some((message) => message.metadata?.compactInputNormalized === true && message.blocks.some((block) => block.type === "text" && block.text.includes("summary-history-image"))) &&
    !compactRequestMessages.some((message) => message.blocks.some((block) => block.type === "image")) &&
    summaryGateway.requestText.includes("Tool result normalized for compaction") &&
    summaryGateway.requestText.includes("START_SENTINEL") &&
    summaryGateway.requestText.includes("END_SENTINEL") &&
    compactInstruction?.role === "user" &&
    compactInstruction.metadata?.compactInstruction === true &&
    compactInstruction.blocks.some((block) => block.type === "text" && block.text.includes("CONTEXT CHECKPOINT COMPACTION")) &&
    summaryGateway.lastRequest?.instructions === undefined &&
    summaryGateway.lastRequest?.toolChoice === "none" &&
    !summaryGateway.requestText.includes("private persisted reasoning") &&
    modelCompacted.changed &&
    modelCompacted.summary?.includes("C:\\Users\\qyq\\Desktop\\work\\codex") === true &&
    modelCompacted.summary.includes("AUTHORITY_SUMMARY_END") &&
    !modelCompacted.summary.includes("Persistent facts:") &&
    modelCompacted.messages.some((message) => message.metadata?.modelDriven === true);

  const sequenceGateway = new SequenceSummaryGateway();
  const sequenceCompactor = new ModelDrivenCompactor(sequenceGateway);
  const firstSequenceCompact = await sequenceCompactor.manualCompact?.([
    createTextMessage("user", "original request"),
    createTextMessage("assistant", "investigating"),
  ], { keepRecentTokenBudget: 200 });
  const secondSequenceCompact = await sequenceCompactor.manualCompact?.([
    ...(firstSequenceCompact?.messages ?? []),
    createTextMessage("user", "corrected request; implementation is approved"),
  ], { keepRecentTokenBudget: 200 });
  const secondSequenceRequest = sequenceGateway.requests[1];
  const consecutiveModelCompactOk =
    sequenceGateway.requests.length === 2 &&
    secondSequenceRequest?.messages.some((message) => message.metadata?.compactBoundary === true && JSON.stringify(message).includes("OLDER_CHECKPOINT")) === true &&
    secondSequenceRequest.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("corrected request")) &&
    secondSequenceRequest.messages.at(-1)?.metadata?.compactInstruction === true &&
    secondSequenceCompact?.summary?.includes("LATEST_CHECKPOINT") === true &&
    !secondSequenceCompact.summary.includes("OLDER_CHECKPOINT") &&
    !secondSequenceCompact.summary.includes("Persistent facts:");

  const manualOnly = new ManualOnlyCompactor(modelCompactor);
  const gpt56WindowOk = resolveContextWindowTokens("gpt-5.6", {}).tokens === 256000
    && resolveContextWindowTokens("gpt-5.6-sol", {}).tokens === 256000
    && resolveContextWindowTokens("gpt-5.6-terra", {}).tokens === 256000
    && resolveContextWindowTokens("gpt-5.6-luna", {}).tokens === 256000;
  const sessionWindowMetrics = buildContextMetrics({
    model: "gpt-5.6",
    contextWindowTokensOverride: 64000,
    messages: [],
    systemPrompt: "smoke",
    tools: [],
  });
  const sessionWindowOk = sessionWindowMetrics.contextWindowTokens === 64000
    && sessionWindowMetrics.contextWindowSource === "session";

  const automaticDisabled = await manualOnly.compact(longHistory, {
    autoCompactMaxChars: 1,
    estimatedInputTokens: 1000,
    contextWindowTokens: 1000,
  });
  const reactiveDisabled = await manualOnly.reactiveCompact?.(longHistory, new Error("prompt too long"), {
    keepRecentMessages: 1,
  });
  const automaticDisabledOk =
    automaticDisabled.changed === false &&
    reactiveDisabled?.changed === false &&
    summaryGateway.compactCalls === 1;

  const gateway = new ContextOverflowThenSuccessGateway();
  const engine = new QueryEngine({
    modelGateway: gateway,
    tools: new ToolRegistry(),
    contextManager,
    compactor,
    contextBudget: { keepRecentMessages: 3, summaryMaxChars: 1000 },
    maxTurns: 4,
  });

  const events: string[] = [];
  let telemetryOk = false;
  let reactiveCompactionReportOk = false;
  for await (const event of engine.sendUserText("trigger reactive compact")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
    if (event.type === "context.compacted") {
      reactiveCompactionReportOk =
        event.compaction.reason === "reactive_compact" &&
        event.compaction.sourceMessages > 0 &&
        event.compaction.newWindowMessages > 0 &&
        event.compaction.preservedUserMessages > 0 &&
        event.compaction.summary.length > 0 &&
        event.compaction.continuationState.length > 0;
    }
    if (event.type === "context.metrics") {
      telemetryOk ||= Boolean(
        event.metrics.cacheDiagnostics?.systemPromptHash &&
        event.metrics.cacheDiagnostics.stablePrefixHash &&
        event.metrics.cacheDiagnostics.promptCacheKey &&
        event.metrics.cacheDiagnostics.cacheablePrefixTokens >= 0 &&
        event.metrics.cacheDiagnostics.toolDefinitionsHash &&
        event.metrics.cacheDiagnostics.promptSections.length > 0,
      );
    }
  }

  const reactiveOk =
    gateway.calls === 2 &&
    gateway.sawBoundaryOnRetry &&
    gateway.sawUserContext &&
    gateway.sawSystemContext &&
    events.includes("terminal:completed");

  const defaultGateway = new ContextOverflowThenSuccessGateway();
  const defaultEngine = new QueryEngine({
    modelGateway: defaultGateway,
    tools: new ToolRegistry(),
    contextManager,
    maxTurns: 4,
  });
  const defaultEvents: string[] = [];
  for await (const event of defaultEngine.sendUserText("recover from a provider context error")) {
    defaultEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  const defaultAutomaticEnabledOk =
    defaultGateway.calls === 3 &&
    defaultGateway.sawBoundaryOnRetry &&
    defaultEvents.includes("context.compacted") &&
    defaultEvents.includes("terminal:completed");

  const thresholdGateway = new ThresholdAutoCompactGateway();
  const thresholdEngine = new QueryEngine({
    model: "gpt-5.6-sol",
    contextWindowTokensOverride: 1000,
    modelGateway: thresholdGateway,
    tools: new ToolRegistry(),
    contextManager,
    contextBudget: { autoCompactTriggerRatio: 0.92, keepRecentTokenBudget: 100 },
    maxTurns: 2,
  });
  const thresholdEvents: string[] = [];
  for await (const event of thresholdEngine.sendUserText("x".repeat(5000))) {
    thresholdEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  const thresholdAutomaticOk =
    thresholdGateway.compactCalls === 1 &&
    thresholdGateway.modelCalls === 1 &&
    thresholdGateway.sawBoundary &&
    thresholdEvents.includes("context.compacted") &&
    thresholdEvents.includes("terminal:completed") &&
    thresholdEngine.getHistoryMessages().some((message) => message.metadata?.compactBoundary === true);

  const ok = promptOk && contextOk && recoveryHintOk && extensionOk && budgetOk && compactOk && compactReportOk && budgetWindowOk && defaultBudgetOk && fallbackQualityOk && consecutiveCompactOk && microOk && pairingOk && grepRegressionOk && modelCompactOk && consecutiveModelCompactOk && gpt56WindowOk && sessionWindowOk && automaticDisabledOk && reactiveOk && reactiveCompactionReportOk && defaultAutomaticEnabledOk && thresholdAutomaticOk && telemetryOk;
  console.log(JSON.stringify( { ok, promptOk, contextOk, recoveryHintOk, extensionOk, budgetOk, compactOk, compactReportOk, budgetWindowOk, defaultBudgetOk, fallbackQualityOk, consecutiveCompactOk, microOk, pairingOk, grepRegressionOk, modelCompactOk, consecutiveModelCompactOk, gpt56WindowOk, sessionWindowOk, automaticDisabledOk, reactiveOk, reactiveCompactionReportOk, defaultAutomaticEnabledOk, thresholdAutomaticOk, telemetryOk, events, defaultEvents, thresholdEvents, calls: gateway.calls, defaultCalls: defaultGateway.calls, thresholdCompactCalls: thresholdGateway.compactCalls }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
