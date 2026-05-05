import { createTextMessage, createToolResultMessage, type Message } from "../types/messages";
import type { ToolDefinition } from "../tools/tool";
import { buildChatRequest } from "./openai-chat-mapper";
import { buildResponsesRequest } from "./openai-responses-mapper";

const tool: ToolDefinition = {
  name: "echo",
  description: "Echo text.",
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
  blocks: [{ type: "tool_use", id: "call_1", name: "echo", input: { text: "ok" } }],
};
const toolResult = createToolResultMessage({ id: "call_1", name: "echo", input: { text: "ok" } }, true, "ok");
const danglingToolUse: Message = {
  id: "dangling_tool_use",
  role: "assistant",
  createdAt: new Date().toISOString(),
  blocks: [{ type: "tool_use", id: "call_missing_result", name: "echo", input: { text: "missing" } }],
};
const danglingToolResult = createToolResultMessage({ id: "call_missing_use", name: "echo", input: { text: "missing" } }, true, "missing");

const plain = buildResponsesRequest(
  { messages: [createTextMessage("user", "hello")], tools: [], stream: true },
  { model: "gpt-test" },
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
  { messages: [assistantToolUse, toolResult], tools: [tool], stream: true },
  { model: "gpt-test" },
);
const danglingChat = buildChatRequest(
  { messages: [danglingToolUse, danglingToolResult], tools: [tool], stream: true },
  { model: "gpt-test" },
);

const continuationInput = continuation.input as Array<Record<string, unknown>>;
const danglingInput = dangling.input as Array<Record<string, unknown>>;
const chatMessages = chat.messages as Array<Record<string, unknown>>;
const danglingChatMessages = danglingChat.messages as Array<Record<string, unknown>>;
const chatAssistant = chatMessages.find((message) => message.role === "assistant") as Record<string, unknown> | undefined;
const ok =
  plain.store === false &&
  withTools.store === true &&
  continuation.store === true &&
  continuation.previous_response_id === undefined &&
  continuationInput.some((item) => item.type === "function_call" && item.call_id === "call_1") &&
  continuationInput.some((item) => item.type === "function_call_output" && item.call_id === "call_1") &&
  !JSON.stringify(danglingInput).includes("call_missing_result") &&
  !JSON.stringify(danglingInput).includes("call_missing_use") &&
  Array.isArray(chatAssistant?.tool_calls) &&
  JSON.stringify(chatMessages).includes('"tool_call_id":"call_1"') &&
  !JSON.stringify(danglingChatMessages).includes("call_missing_result") &&
  !JSON.stringify(danglingChatMessages).includes("call_missing_use") &&
  override.store === false;

console.log(JSON.stringify({ ok, stores: { plain: plain.store, withTools: withTools.store, continuation: continuation.store, override: override.store } }, null, 2));
if (!ok) process.exitCode = 1;
