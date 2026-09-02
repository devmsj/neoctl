import { createTextMessage, createThinkingMessage, createToolResultMessage, type Message } from "../types/messages.js";
import type { ToolDefinition } from "../tools/tool.js";
import { buildChatRequest } from "./openai-chat-mapper.js";
import { buildResponsesRequest, normalizeResponsesStream } from "./openai-responses-mapper.js";
import { readModelProviderConfig } from "./config.js";

const tool: ToolDefinition = {
  name: "smoke_tool",
  description: "Smoke test tool.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

const assistantToolUse: Message = {
  id: "assistant_tool_use",
  role: "assistant",
  createdAt: new Date().toISOString(),
  blocks: [{ type: "tool_use", id: "call_1", name: "smoke_tool", input: { text: "ok" } }],
};
const toolResult = createToolResultMessage({ id: "call_1", name: "smoke_tool", input: { text: "ok" } }, true, "ok");
const danglingToolUse: Message = {
  id: "dangling_tool_use",
  role: "assistant",
  createdAt: new Date().toISOString(),
  blocks: [{ type: "tool_use", id: "call_missing_result", name: "smoke_tool", input: { text: "missing" } }],
};
const danglingToolResult = createToolResultMessage({ id: "call_missing_use", name: "smoke_tool", input: { text: "missing" } }, true, "missing");
const stableRuntimeContext: Message = {
  ...createTextMessage("user", "project memory"),
  isMeta: true,
  metadata: { runtimeContext: true, cacheStableRuntimeContext: true },
};

const plain = buildResponsesRequest(
  { messages: [createTextMessage("user", "hello")], tools: [], stream: true, serviceTier: "fast" },
  { model: "gpt-test" },
);
const cached = buildResponsesRequest(
  {
    messages: [stableRuntimeContext, createTextMessage("user", "hello")],
    systemPrompt: "## Stable\ncache me\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\n## Dynamic\nchanges",
    tools: [tool],
    stream: true,
  },
  { model: "gpt-5.6" },
);
const withTools = buildResponsesRequest(
  { messages: [createTextMessage("user", "hello")], tools: [tool], stream: true },
  { model: "gpt-test" },
);
const continuation = buildResponsesRequest(
  {
    messages: [assistantToolUse, toolResult],
    tools: [tool],
    stream: true,
  },
  { model: "gpt-test" },
);
const dangling = buildResponsesRequest(
  {
    messages: [danglingToolUse, danglingToolResult],
    tools: [tool],
    stream: true,
  },
  { model: "gpt-test" },
);
const override = buildResponsesRequest(
  {
    messages: [createTextMessage("user", "hello")],
    tools: [tool],
    stream: true,
    providerOptions: { responses: { store: false } },
  },
  { model: "gpt-test" },
);
const chat = buildChatRequest(
  { messages: [assistantToolUse, toolResult], tools: [tool], stream: true, serviceTier: "fast" },
  { model: "gpt-test" },
);
const chatWithSystemState = buildChatRequest(
  { messages: [createTextMessage("system", "Internal continuation state from context compaction.")], tools: [], stream: true },
  { model: "gpt-test" },
);
const cachedChat = buildChatRequest(
  {
    messages: [createTextMessage("user", "hello")],
    systemPrompt: "stable\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\ndynamic",
    tools: [tool],
    stream: true,
  },
  { model: "gpt-5.6" },
);
const danglingChat = buildChatRequest(
  { messages: [danglingToolUse, danglingToolResult], tools: [tool], stream: true },
  { model: "gpt-test" },
);
const thinking = createThinkingMessage("local reasoning must not be sent");
const reasoningAuto = buildResponsesRequest(
  { messages: [createTextMessage("user", "hello")], tools: [], stream: true, reasoning: { summary: "auto" } },
  { model: "gpt-5.6-sol" },
);
const reasoningDetailed = buildResponsesRequest(
  { messages: [createTextMessage("user", "hello")], tools: [], stream: true, reasoning: { effort: "high", summary: "detailed" } },
  { model: "gpt-5.6-sol" },
);
const responsesWithoutThinking = buildResponsesRequest(
  { messages: [createTextMessage("user", "hello"), thinking], tools: [], stream: true },
  { model: "gpt-5.6-sol" },
);
const chatWithoutThinking = buildChatRequest(
  { messages: [createTextMessage("user", "hello"), thinking], tools: [], stream: true },
  { model: "gpt-5.6-sol" },
);

const reasoningEvents = [
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Summary" },
  { type: "response.reasoning_text.delta", item_id: "rs_1", output_index: 0, content_index: 0, delta: "Visible reasoning" },
  {
    type: "response.completed",
    response: {
      id: "resp_reasoning",
      status: "completed",
      output: [{
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Summary" }, { type: "summary_text", text: "Second summary part" }],
        content: [{ type: "reasoning_text", text: "Visible reasoning" }],
      }],
    },
  },
];
const encoder = new TextEncoder();
const reasoningStream = new ReadableStream<Uint8Array>({
  start(controller) {
    for (const event of reasoningEvents) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
});
const normalizedReasoningEvents = [];
for await (const event of normalizeResponsesStream(reasoningStream, { model: "gpt-5.6-sol" })) normalizedReasoningEvents.push(event);
const finalThinking = normalizedReasoningEvents
  .filter((event) => event.type === "assistant_message")
  .flatMap((event) => event.type === "assistant_message" ? event.message.blocks : [])
  .find((block) => block.type === "thinking");
const nativeLimitConfig = readModelProviderConfig({ OPENAI_API_KEY: "test" });

const continuationInput = continuation.input as Array<Record<string, unknown>>;
const danglingInput = dangling.input as Array<Record<string, unknown>>;
const chatMessages = chat.messages as Array<Record<string, unknown>>;
const chatWithSystemStateMessages = chatWithSystemState.messages as Array<Record<string, unknown>>;
const danglingChatMessages = danglingChat.messages as Array<Record<string, unknown>>;
const cachedChatJson = JSON.stringify(cachedChat.messages);
const cachedInput = cached.input as Array<Record<string, unknown>>;
const cachedInputJson = JSON.stringify(cachedInput);
const cachedBreakpoints = cachedInputJson.match(/prompt_cache_breakpoint/g)?.length ?? 0;
const chatAssistant = chatMessages.find((message) => message.role === "assistant") as Record<string, unknown> | undefined;
const ok =
  plain.store === false &&
  typeof plain.prompt_cache_key === "string" &&
  cached.instructions === undefined &&
  cached.prompt_cache_options &&
  cachedBreakpoints === 2 &&
  !cachedInputJson.includes("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__") &&
  cachedInputJson.indexOf("cache me") < cachedInputJson.indexOf("project memory") &&
  cachedInputJson.indexOf("project memory") < cachedInputJson.indexOf("changes") &&
  typeof cachedChat.prompt_cache_key === "string" &&
  !cachedChatJson.includes("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__") &&
  cachedChatJson.indexOf("stable") < cachedChatJson.indexOf("dynamic") &&
  plain.service_tier === "fast" &&
  withTools.store === true &&
  continuation.store === true &&
  continuation.previous_response_id === undefined &&
  continuationInput.some((item) => item.type === "function_call" && item.call_id === "call_1") &&
  continuationInput.some((item) => item.type === "function_call_output" && item.call_id === "call_1") &&
  !JSON.stringify(danglingInput).includes("call_missing_result") &&
  !JSON.stringify(danglingInput).includes("call_missing_use") &&
  Array.isArray(chatAssistant?.tool_calls) &&
  JSON.stringify(chatMessages).includes('"tool_call_id":"call_1"') &&
  chatWithSystemStateMessages.some((message) => message.role === "system" && String(message.content).includes("Internal continuation state")) &&
  !JSON.stringify(danglingChatMessages).includes("call_missing_result") &&
  !JSON.stringify(danglingChatMessages).includes("call_missing_use") &&
  override.store === false &&
  chat.service_tier === "fast" &&
  (reasoningAuto.reasoning as Record<string, unknown>)?.summary === "auto" &&
  (reasoningDetailed.reasoning as Record<string, unknown>)?.effort === "high" &&
  (reasoningDetailed.reasoning as Record<string, unknown>)?.summary === "detailed" &&
  !JSON.stringify(responsesWithoutThinking.input).includes("local reasoning must not be sent") &&
  !JSON.stringify(chatWithoutThinking.messages).includes("local reasoning must not be sent") &&
  normalizedReasoningEvents.some((event) => event.type === "thinking_delta" && event.text === "\n\nVisible reasoning") &&
  finalThinking?.type === "thinking" &&
  finalThinking.text === "Summary\n\nSecond summary part\n\nVisible reasoning" &&
  nativeLimitConfig?.defaultMaxOutputTokens === undefined;

console.log(JSON.stringify({ ok, stores: { plain: plain.store, withTools: withTools.store, continuation: continuation.store, override: override.store } }, null, 2));
if (!ok) process.exitCode = 1;
