import { QueryEngine } from "./query-engine.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import { createTextMessage, createThinkingMessage, type MessageBlock } from "../types/messages.js";
import { stripLeakedReasoningText } from "./assistant-output-filter.js";
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
  const sanitized = stripLeakedReasoningText("目录内容：\n- `package-lock.json`We need answer in Chinese likely. Final maybe mention.");

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

  const ok =
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    sanitized === "目录内容：\n- `package-lock.json`" &&
    snapshot.messages >= 3 &&
    snapshot.fastMode === true &&
    gateway.requests.length > 0 &&
    gateway.requests.every((request) => request.serviceTier === "priority") &&
    abortDuringToolsOk &&
    userImagePinned &&
    storedImageCompacted &&
    historyImageDowngraded &&
    stoppedAfterOneToolTurn &&
    thinkingPersisted &&
    thinkingExcludedFromContext;
  console.log(JSON.stringify({ ok, events, snapshot, sanitized, abortEvents, abortElapsedMs, abortDuringToolsOk, userImagePinned, storedImageCompacted, downgradeEvents, historyImageDowngraded, yieldedEvents, stoppedAfterOneToolTurn, thinkingPersisted, thinkingExcludedFromContext }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
