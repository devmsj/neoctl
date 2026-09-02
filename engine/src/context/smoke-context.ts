import { ModelAPIError } from "../model/errors.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { QueryEngine } from "../core/query-engine.js";
import { applyRuntimeContextForPromptCache, applyToolResultBudget, ensureToolResultPairing, hasValidToolResultPairing } from "../core/message-pipeline.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTextMessage, createThinkingMessage, createToolResultMessage } from "../types/messages.js";
import { CLEARED_TOOL_RESULT_CONTENT, DeterministicCompactor, ManualOnlyCompactor, microCompactIfNeeded, ModelDrivenCompactor } from "./compaction.js";
import { AdditionalPromptContextManager, DefaultContextManager } from "./context-manager.js";
import { buildEffectiveSystemPrompt, splitSystemPromptPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./prompts.js";

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

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin !== "compact") throw new Error(`Unexpected query origin: ${request.queryOrigin}`);
    this.compactCalls += 1;
    this.requestText += JSON.stringify(request.messages);
    yield { type: "assistant_delta", text: "Goal: keep working.\nPending Work: finish validation." };
    yield { type: "response_completed", responseId: "compact_1", stopReason: "completed" };
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
  const runtime = await contextManager.build({ agentId: "main", messages: [createTextMessage("user", "hello")] });
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
  const lastRuntimeBlock = runtimeContextMessages.at(-1)?.blocks[0];
  const contextOk =
    runtime.userContext.currentDate === "2026-05-05" &&
    Boolean(runtime.systemContext.cwd) &&
    !runtime.systemPrompt.includes("## System Context") &&
    runtimeContextMessages[0]?.metadata?.userContext === true &&
    runtimeContextMessages[0]?.metadata?.systemContext === true &&
    runtimeContextMessages[0]?.blocks[0]?.type === "text" &&
    nextRuntimeContextMessages[0]?.blocks[0]?.type === "text" &&
    runtimeContextMessages[0].blocks[0].text === nextRuntimeContextMessages[0].blocks[0].text &&
    lastRuntimeBlock?.type === "text" &&
    lastRuntimeBlock.text === "first";

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
  const compactBoundary = compacted.messages.find((message) => message.metadata?.compactBoundary === true);
  const compactOk =
    compacted.changed &&
    compactBoundary?.role === "system" &&
    JSON.stringify(compactBoundary).includes("Internal continuation state") &&
    !JSON.stringify(compactBoundary).includes("Conversation summary");

  const toolUseOld = {
    id: "assistant_old_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_old", name: "grep", input: { query: "old" } }],
  };
  const toolUseNew = {
    id: "assistant_new_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_new", name: "grep", input: { query: "new" } }],
  };
  const oldResult = createToolResultMessage({ id: "call_old", name: "grep", input: {} }, true, "old".repeat(1200));
  const newResult = createToolResultMessage({ id: "call_new", name: "grep", input: {} }, true, "new".repeat(1200));
  const micro = microCompactIfNeeded([toolUseOld, oldResult, toolUseNew, newResult], { microCompactMaxChars: 100, keepRecentToolResults: 1 });
  const oldOutput = micro.messages[1]?.blocks[0]?.type === "tool_result" ? micro.messages[1].blocks[0].output : undefined;
  const newOutput = micro.messages[3]?.blocks[0]?.type === "tool_result" ? micro.messages[3].blocks[0].output : undefined;
  const microOk = micro.changed && oldOutput === CLEARED_TOOL_RESULT_CONTENT && typeof newOutput === "string" && newOutput.startsWith("new");

  const orphanResult = createToolResultMessage({ id: "call_orphan", name: "grep", input: {} }, true, "orphan");
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
    blocks: [{ type: "tool_use" as const, id: "call_big_grep", name: "grep", input: { query: "^|\\S", root: ".." } }],
  };
  const bigGrepResult = createToolResultMessage(
    { id: "call_big_grep", name: "grep", input: {} },
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
  const modelCompacted = await modelCompactor.compact([createThinkingMessage("private persisted reasoning"), ...longHistory], {
    snipMaxChars: 20000,
    microCompactMaxChars: 19000,
    autoCompactMaxChars: 1500,
    keepRecentMessages: 3,
  });
  const modelCompactOk =
    summaryGateway.compactCalls === 1 &&
    !summaryGateway.requestText.includes("private persisted reasoning") &&
    modelCompacted.changed &&
    modelCompacted.summary?.includes("Pending Work") === true &&
    modelCompacted.messages.some((message) => message.metadata?.modelDriven === true);

  const manualOnly = new ManualOnlyCompactor(modelCompactor);
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
  for await (const event of engine.sendUserText("trigger reactive compact")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
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
  for await (const event of defaultEngine.sendUserText("do not compact automatically")) {
    defaultEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  const defaultAutomaticDisabledOk =
    defaultGateway.calls === 1 &&
    !defaultGateway.sawBoundaryOnRetry &&
    defaultEvents.includes("error") &&
    defaultEvents.includes("terminal:prompt_too_long");

  const ok = promptOk && contextOk && extensionOk && budgetOk && compactOk && microOk && pairingOk && grepRegressionOk && modelCompactOk && automaticDisabledOk && reactiveOk && defaultAutomaticDisabledOk && telemetryOk;
  console.log(JSON.stringify( { ok, promptOk, contextOk, extensionOk, budgetOk, compactOk, microOk, pairingOk, grepRegressionOk, modelCompactOk, automaticDisabledOk, reactiveOk, defaultAutomaticDisabledOk, telemetryOk, events, defaultEvents, calls: gateway.calls, defaultCalls: defaultGateway.calls }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
