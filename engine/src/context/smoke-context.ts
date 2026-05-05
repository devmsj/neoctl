import { ModelAPIError } from "../model/errors";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway";
import { QueryEngine } from "../core/query-engine";
import { applyToolResultBudget, appendSystemContext, ensureToolResultPairing, hasValidToolResultPairing, prependUserContext } from "../core/message-pipeline";
import { ToolRegistry } from "../tools/registry";
import { createTextMessage, createToolResultMessage } from "../types/messages";
import { CLEARED_TOOL_RESULT_CONTENT, DeterministicCompactor, microCompactIfNeeded, ModelDrivenCompactor } from "./compaction";
import { DefaultContextManager } from "./context-manager";
import { buildEffectiveSystemPrompt, splitSystemPromptPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./prompts";

class ContextOverflowThenSuccessGateway implements ModelGateway {
  calls = 0;
  sawBoundaryOnRetry = false;
  sawUserContext = false;
  sawSystemContext = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.sawUserContext ||= request.messages.some((message) => message.metadata?.userContext === true);
    this.sawSystemContext ||= Boolean(request.systemPrompt?.includes("## System Context"));

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

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin !== "compact") throw new Error(`Unexpected query origin: ${request.queryOrigin}`);
    this.compactCalls += 1;
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
  const contextOk =
    runtime.userContext.currentDate === "2026-05-05" &&
    Boolean(runtime.systemContext.cwd) &&
    appendSystemContext(runtime.systemPrompt, runtime.systemContext).includes("## System Context") &&
    prependUserContext([], runtime.userContext)[0]?.metadata?.userContext === true;

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
    blocks: [{ type: "tool_use" as const, id: "call_old", name: "search", input: { query: "old" } }],
  };
  const toolUseNew = {
    id: "assistant_new_tool",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_new", name: "search", input: { query: "new" } }],
  };
  const oldResult = createToolResultMessage({ id: "call_old", name: "search", input: {} }, true, "old".repeat(1200));
  const newResult = createToolResultMessage({ id: "call_new", name: "search", input: {} }, true, "new".repeat(1200));
  const micro = microCompactIfNeeded([toolUseOld, oldResult, toolUseNew, newResult], { microCompactMaxChars: 100, keepRecentToolResults: 1 });
  const oldOutput = micro.messages[1]?.blocks[0]?.type === "tool_result" ? micro.messages[1].blocks[0].output : undefined;
  const newOutput = micro.messages[3]?.blocks[0]?.type === "tool_result" ? micro.messages[3].blocks[0].output : undefined;
  const microOk = micro.changed && oldOutput === CLEARED_TOOL_RESULT_CONTENT && typeof newOutput === "string" && newOutput.startsWith("new");

  const orphanResult = createToolResultMessage({ id: "call_orphan", name: "search", input: {} }, true, "orphan");
  const paired = ensureToolResultPairing([toolUseOld, createTextMessage("assistant", "done"), orphanResult]);
  const pairedJson = JSON.stringify(paired);
  const pairingOk =
    hasValidToolResultPairing(paired) &&
    pairedJson.includes("call_old") &&
    pairedJson.includes("synthetic failure result") &&
    !pairedJson.includes("call_orphan");

  const bigSearchUse = {
    id: "assistant_big_search",
    role: "assistant" as const,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_use" as const, id: "call_big_search", name: "search", input: { query: "^|\\S", root: ".." } }],
  };
  const bigSearchResult = createToolResultMessage(
    { id: "call_big_search", name: "search", input: {} },
    true,
    JSON.stringify({ query: "^|\\S", root: "..", matches: Array.from({ length: 600 }, (_, index) => `match ${index}: ${"x".repeat(80)}`) }),
  );
  const budgetedSearch = applyToolResultBudget([bigSearchUse, bigSearchResult], { maxSerializedLength: 1200 });
  const microSearch = microCompactIfNeeded(budgetedSearch, { microCompactMaxChars: 100, keepRecentToolResults: 1 });
  const repairedSearch = ensureToolResultPairing(microSearch.messages);
  const searchOutput =
    repairedSearch[1]?.blocks[0]?.type === "tool_result" ? String(repairedSearch[1].blocks[0].output) : "";
  const searchRegressionOk =
    hasValidToolResultPairing(repairedSearch) &&
    searchOutput.startsWith("[Tool result truncated for context budget: original ") &&
    !searchOutput.includes('"preview"') &&
    !searchOutput.includes('"truncated"');

  const summaryGateway = new SummaryGateway();
  const modelCompactor = new ModelDrivenCompactor(summaryGateway);
  const modelCompacted = await modelCompactor.compact(longHistory, {
    snipMaxChars: 20000,
    microCompactMaxChars: 19000,
    autoCompactMaxChars: 1500,
    keepRecentMessages: 3,
  });
  const modelCompactOk =
    summaryGateway.compactCalls === 1 &&
    modelCompacted.changed &&
    modelCompacted.summary?.includes("Pending Work") === true &&
    modelCompacted.messages.some((message) => message.metadata?.modelDriven === true);

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
  for await (const event of engine.sendUserText("trigger reactive compact")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const reactiveOk =
    gateway.calls === 2 &&
    gateway.sawBoundaryOnRetry &&
    gateway.sawUserContext &&
    gateway.sawSystemContext &&
    events.includes("terminal:completed");

  const ok = promptOk && contextOk && budgetOk && compactOk && microOk && pairingOk && searchRegressionOk && modelCompactOk && reactiveOk;
  console.log(JSON.stringify( { ok, promptOk, contextOk, budgetOk, compactOk, microOk, pairingOk, searchRegressionOk, modelCompactOk, reactiveOk, events, calls: gateway.calls }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
