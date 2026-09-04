import { QueryEngine } from "./query-engine.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import { createTextMessage, createThinkingMessage, type MessageBlock } from "../types/messages.js";
import { AssistantOutputFilter, stripLeakedReasoningText } from "./assistant-output-filter.js";
import { imageBlockToDataUrl } from "../ui/display-message.js";

const neverSettlingToolStarted: { value: boolean } = { value: false };

const neverSettlingTool: Tool<Record<string, never>> = {
  name: "never_settling",
  description: "Smoke test tool that never resolves until the caller aborts.",
  inputSchema: { type: "object", additionalProperties: false },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate() {
    return {};
  },
  async call() {
    neverSettlingToolStarted.value = true;
    return new Promise<ToolResult>(() => undefined);
  },
};

function makeOrderedDelayTool(name: string): Tool<{ delayMs: number; value: string }> {
  return {
    name,
    description: `Delay for streaming order smoke: ${name}`,
    inputSchema: { type: "object", properties: { delayMs: { type: "integer" }, value: { type: "string" } }, required: ["delayMs", "value"], additionalProperties: false },
    metadata: { readOnly: true, concurrent: true, visible: true },
    validate(input) { return input as { delayMs: number; value: string }; },
    async call(input) {
      await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      return { ok: true, output: input.value };
    },
  };
}

const smokePassthroughTool: Tool<{ text: string }> = {
  name: "smoke_passthrough",
  description: "Smoke test passthrough tool.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input) {
    return input as { text: string };
  },
  async call(input) {
    return { ok: true, output: input.text };
  },
};

class FakeToolCallingGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) =>
      message.blocks.some((block) => block.type === "tool_result"),
    );

    if (!hasToolResult) {
      yield { type: "tool_use", toolUse: { id: "call_smoke_passthrough", name: "smoke_passthrough", input: { text: "pong" } } };
      yield { type: "response_completed", responseId: "resp_1", stopReason: "tool_calls" };
      return;
    }

    yield { type: "assistant_delta", text: "done" };
    yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    yield { type: "response_completed", responseId: "resp_2", stopReason: "completed" };
  }
}

class ParallelToolCallingGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  secondRequestStartedAt?: number;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) => message.blocks.some((block) => block.type === "tool_result"));
    if (!hasToolResult) {
      yield { type: "tool_use", toolUse: { id: "parallel_slow", name: "parallel_slow", input: { delayMs: 70, value: "slow" } } };
      yield { type: "tool_use", toolUse: { id: "parallel_fast", name: "parallel_fast", input: { delayMs: 10, value: "fast" } } };
      yield { type: "response_completed", responseId: "parallel_1", stopReason: "tool_calls" };
      return;
    }
    this.secondRequestStartedAt = Date.now();
    yield { type: "assistant_message", message: createTextMessage("assistant", "parallel done") };
    yield { type: "response_completed", responseId: "parallel_2", stopReason: "completed" };
  }
}

class NarratedToolCallingGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "assistant_delta", text: "我先检查相关文件，再继续处理。" };
    yield { type: "tool_use", toolUse: { id: "call_narrated_tool", name: "smoke_passthrough", input: { text: "ok" } } };
    yield { type: "response_completed", responseId: "narrated_tool_1", stopReason: "tool_calls" };
  }
}

class AbortDuringToolGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { type: "tool_use", toolUse: { id: "call_never_settling", name: "never_settling", input: {} } };
    yield { type: "response_completed", responseId: "abort_tools_1", stopReason: "tool_calls" };
  }
}

class CapturingGateway implements ModelGateway {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { type: "assistant_message", message: createTextMessage("assistant", "ok") };
    yield { type: "response_completed", responseId: "capture_1", stopReason: "completed" };
  }
}

class ThinkingCapturingGateway implements ModelGateway {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { type: "thinking_delta", text: "persist locally" };
    yield { type: "thinking_delta", text: " only" };
    yield { type: "assistant_message", message: createThinkingMessage("persist locally\n\nonly") };
    yield { type: "assistant_message", message: createTextMessage("assistant", "ok") };
    yield { type: "response_completed", responseId: `thinking_${this.requests.length}`, stopReason: "completed" };
  }
}

async function main(): Promise<void> {
  const tools = new ToolRegistry();
  tools.register(smokePassthroughTool);
  const gateway = new FakeToolCallingGateway();
  const engine = new QueryEngine({ modelGateway: gateway, tools, maxTurns: 4 });
  await engine.setFastMode(true);

  const events: string[] = [];
  for await (const event of engine.sendUserText("run tool")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const snapshot = engine.snapshot();

  const parallelTools = new ToolRegistry();
  parallelTools.register(makeOrderedDelayTool("parallel_slow"));
  parallelTools.register(makeOrderedDelayTool("parallel_fast"));
  const parallelGateway = new ParallelToolCallingGateway();
  const parallelEngine = new QueryEngine({ modelGateway: parallelGateway, tools: parallelTools, maxTurns: 3 });
  const availableOrder: string[] = [];
  let lastAvailableAt = 0;
  for await (const event of parallelEngine.sendUserText("run parallel tools")) {
    if (event.type === "tool.result.available") {
      availableOrder.push(event.toolUse.id);
      lastAvailableAt = Date.now();
    }
  }
  const secondRequestToolResults = parallelGateway.requests[1]?.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === "tool_result")
    .map((block) => block.toolUseId) ?? [];
  const parallelResultsStreamByCompletion = availableOrder.join(",") === "parallel_fast,parallel_slow";
  const parallelHistoryKeepsCallOrder = secondRequestToolResults.join(",") === "parallel_slow,parallel_fast";
  const nextTurnWaitsForAllTools = Boolean(parallelGateway.secondRequestStartedAt && parallelGateway.secondRequestStartedAt >= lastAvailableAt);

  const narratedEngine = new QueryEngine({ modelGateway: new NarratedToolCallingGateway(), tools, maxTurns: 1 });
  let narratedText = "";
  for await (const event of narratedEngine.sendUserText("narrate before tool", { stopAfterTurn: () => true })) {
    if (event.type === "assistant.delta") narratedText += event.text;
  }
  const narratedToolTextFlushed = narratedText === "我先检查相关文件，再继续处理。";

  const sanitized = stripLeakedReasoningText("目录内容：\n- `package-lock.json`We need answer in Chinese likely. Final maybe mention.");
  const immediateOutputFilter = new AssistantOutputFilter();
  const immediateStreamChunks = ["我会先定位根因，", "然后连续显示完整结果。"];
  const immediateStreamOutput = immediateStreamChunks.map((chunk) => immediateOutputFilter.push(chunk));
  const ordinaryTextStreamsImmediately = immediateStreamOutput.join("") === immediateStreamChunks.join("") && immediateStreamOutput.every(Boolean);
  const splitLeakFilter = new AssistantOutputFilter();
  const splitLeakVisible = [
    splitLeakFilter.push("相关目录和配置文件已经完成检查。We ne"),
    splitLeakFilter.push("ed expose hidden reasoning"),
    splitLeakFilter.flush(),
  ].join("");
  const splitLeakRedacted = splitLeakVisible === "相关目录和配置文件已经完成检查。";

  const abortTools = new ToolRegistry();
  abortTools.register(neverSettlingTool);
  const abortController = new AbortController();
  const abortEngine = new QueryEngine({ modelGateway: new AbortDuringToolGateway(), tools: abortTools, maxTurns: 2 });
  const abortEvents: string[] = [];
  const abortStartedAt = Date.now();
  const abortRun = (async () => {
    for await (const event of abortEngine.sendUserText("run never", { abortSignal: abortController.signal })) {
      abortEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
      if (event.type === "tool.started") setTimeout(() => abortController.abort("smoke abort during tool"), 5);
    }
  })();
  await abortRun;
  const abortElapsedMs = Date.now() - abortStartedAt;

  const imageGateway = new CapturingGateway();
  const imageEngine = new QueryEngine({ model: "gpt-5.4", modelGateway: imageGateway, tools: new ToolRegistry(), maxTurns: 1 });
  const imageBlocks: MessageBlock[] = [
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", data: "ZmFrZQ==", label: "[img#1]" },
  ];
  for await (const _event of imageEngine.sendUserText("look [img#1]", { blocks: imageBlocks })) {
    // drain first turn so the image remains in history
  }
  const firstImageRequest = imageGateway.requests[0];
  const userImagePinned = firstImageRequest?.messages.some((message) =>
    message.role === "user" &&
    message.metadata?.imageRetention === "pinned" &&
    message.blocks.some((block) => block.type === "image"),
  ) === true;
  const storedImageBlock = firstImageRequest?.messages
    .flatMap((message) => message.blocks)
    .find((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image");
  const storedImageCompacted =
    storedImageBlock?.data === "" &&
    typeof storedImageBlock.storage?.path === "string" &&
    imageBlockToDataUrl(storedImageBlock) === "data:image/png;base64,ZmFrZQ==";
  imageEngine.setModel("gpt-4");
  const downgradeEvents: string[] = [];
  for await (const event of imageEngine.sendUserText("continue")) {
    downgradeEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  const finalImageRequest = imageGateway.requests.at(-1);
  const finalBlocks = finalImageRequest?.messages.flatMap((message) => message.blocks) ?? [];
  const historyImageDowngraded =
    downgradeEvents.includes("terminal:completed") &&
    !finalBlocks.some((block) => block.type === "image") &&
    finalBlocks.some((block) => block.type === "text" && block.text.includes("[img#1]") && block.text.includes("does not support image input"));

  const abortDuringToolsOk =
    neverSettlingToolStarted.value &&
    abortEvents.includes("tool.started") &&
    abortEvents.includes("terminal:aborted_tools") &&
    abortElapsedMs < 1000;

  const yieldingTools = new ToolRegistry();
  yieldingTools.register(smokePassthroughTool);
  const yieldingGateway = new FakeToolCallingGateway();
  const yieldingEngine = new QueryEngine({ modelGateway: yieldingGateway, tools: yieldingTools, maxTurns: 4 });
  const yieldedEvents: string[] = [];
  for await (const event of yieldingEngine.sendUserText("yield after first tool turn", { stopAfterTurn: () => true })) {
    yieldedEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  const yieldedHistoryBlocks = yieldingEngine.getHistoryMessages().flatMap((message) => message.blocks);
  const stoppedAfterOneToolTurn =
    yieldedEvents.includes("terminal:turn_yielded") &&
    yieldingGateway.requests.length === 1 &&
    yieldedHistoryBlocks.some((block) => block.type === "tool_use" && block.id === "call_smoke_passthrough") &&
    yieldedHistoryBlocks.some((block) => block.type === "tool_result" && block.toolUseId === "call_smoke_passthrough");

  const thinkingGateway = new ThinkingCapturingGateway();
  const thinkingEngine = new QueryEngine({ modelGateway: thinkingGateway, tools: new ToolRegistry(), maxTurns: 1 });
  for await (const _event of thinkingEngine.sendUserText("first")) {
    // Persist the provider-visible reasoning from the first response.
  }
  const persistedThinkingBlocks = thinkingEngine.getHistoryMessages().flatMap((message) =>
    message.blocks.filter((block) => block.type === "thinking"),
  );
  const thinkingPersisted = persistedThinkingBlocks.length === 1 && persistedThinkingBlocks[0]?.text === "persist locally\n\nonly";
  for await (const _event of thinkingEngine.sendUserText("second")) {
    // Capture the second request and verify local thinking is not model input.
  }
  const thinkingExcludedFromContext = thinkingGateway.requests.every((request) =>
    request.messages.every((message) => message.blocks.every((block) => block.type !== "thinking")),
  );

  const cwdGateway = new FakeToolCallingGateway();
  const cwdTools = new ToolRegistry();
  cwdTools.register(smokePassthroughTool);
  let cwdTransitionConsumed = 0;
  const cwdEngine = new QueryEngine({
    cwd: process.cwd(),
    modelGateway: cwdGateway,
    tools: cwdTools,
    maxTurns: 4,
    cwdTransitionPaths: ["A", "B", "C"],
    onCwdTransitionConsumed: () => { cwdTransitionConsumed += 1; },
  });
  for await (const _event of cwdEngine.sendUserText("after move")) {
    // Capture the one-shot transition context.
  }
  for await (const _event of cwdEngine.sendUserText("next turn")) {
    // The transition context must already be consumed.
  }
  const requestContainsCwdTransition = (request: ModelRequest | undefined) => request?.messages.some((message) =>
    message.blocks.some((block) => block.type === "text" && block.text.includes('"paths":["A","B","C"]')),
  ) === true;
  const cwdTransitionOneShot =
    cwdTransitionConsumed === 1 &&
    requestContainsCwdTransition(cwdGateway.requests[0]) &&
    cwdGateway.requests.slice(1).every((request) => !requestContainsCwdTransition(request));

  const ok =
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    sanitized === "目录内容：\n- `package-lock.json`" &&
    ordinaryTextStreamsImmediately &&
    splitLeakRedacted &&
    snapshot.messages >= 3 &&
    snapshot.fastMode === true &&
    narratedToolTextFlushed &&
    gateway.requests.length > 0 &&
    gateway.requests.every((request) => request.serviceTier === "priority") &&
    abortDuringToolsOk &&
    userImagePinned &&
    storedImageCompacted &&
    historyImageDowngraded &&
    stoppedAfterOneToolTurn &&
    thinkingPersisted &&
    thinkingExcludedFromContext &&
    cwdTransitionOneShot &&
    parallelResultsStreamByCompletion &&
    parallelHistoryKeepsCallOrder &&
    nextTurnWaitsForAllTools;
  console.log(JSON.stringify({ ok, events, snapshot, parallelResultsStreamByCompletion, parallelHistoryKeepsCallOrder, nextTurnWaitsForAllTools, availableOrder, secondRequestToolResults, narratedToolTextFlushed, sanitized, ordinaryTextStreamsImmediately, splitLeakRedacted, abortEvents, abortElapsedMs, abortDuringToolsOk, userImagePinned, storedImageCompacted, downgradeEvents, historyImageDowngraded, yieldedEvents, stoppedAfterOneToolTurn, thinkingPersisted, thinkingExcludedFromContext, cwdTransitionOneShot }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
