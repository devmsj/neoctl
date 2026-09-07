import assert from "node:assert/strict";
import test from "node:test";
import { createTextMessage } from "../types/messages.js";
import type { ToolDefinition } from "../tools/tool.js";
import { ModelAPIError } from "./errors.js";
import type { ModelStreamEvent } from "./model-gateway.js";
import { buildResponsesRequest, normalizeResponsesObject, normalizeResponsesStream } from "./openai-responses-mapper.js";

const imageCreateTool: ToolDefinition = {
  name: "image_create",
  description: "Generate or edit an image through the application Images API integration.",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    additionalProperties: false,
  },
};

function request(providerResponses?: Record<string, unknown>) {
  return {
    messages: [createTextMessage("user", "Generate a cat image")],
    tools: [imageCreateTool],
    stream: true,
    providerOptions: providerResponses ? { responses: providerResponses } : undefined,
  } as const;
}

function assertNativeImageError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ModelAPIError);
  assert.equal(error.code, code);
  assert.match(error.message, /image_create/);
  assert.equal(error.retryable, false);
  return true;
}

test("Responses requests retain the application image_create function tool", () => {
  const body = buildResponsesRequest(request(), { model: "gpt-5.6" });
  assert.deepEqual(body.tools, [{
    type: "function",
    name: "image_create",
    description: imageCreateTool.description,
    parameters: imageCreateTool.inputSchema,
    strict: false,
  }]);
  assert.deepEqual(body.tool_choice, {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "image_create" }],
  });
});

test("provider options cannot replace runtime tools or enable native image generation", () => {
  for (const providerResponses of [
    { tools: [{ type: "image_generation" }] },
    { tool_choice: { type: "image_generation" } },
    { tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "image_generation" }] } },
  ]) {
    const body = buildResponsesRequest(request(providerResponses), { model: "gpt-5.6" });
    assert.deepEqual(body.tools, [{
      type: "function",
      name: "image_create",
      description: imageCreateTool.description,
      parameters: imageCreateTool.inputSchema,
      strict: false,
    }]);
    assert.deepEqual(body.tool_choice, {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "image_create" }],
    });
  }
});

test("streaming native image events fail before a silent completed result", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "ig_1", type: "image_generation_call", status: "in_progress" },
      })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", status: "completed" },
      })}\n\n`));
      controller.close();
    },
  });

  const events: ModelStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of normalizeResponsesStream(stream, { model: "gpt-5.6" })) events.push(event);
  }, (error) => assertNativeImageError(error, "unexpected_native_image_generation"));
  assert.equal(events.some((event) => event.type === "response_completed"), false);
});

test("non-streaming native image output fails instead of completing", () => {
  assert.throws(() => [...normalizeResponsesObject({
    status: 200,
    headers: new Headers(),
    body: {
      id: "resp_1",
      status: "completed",
      output: [{ id: "ig_1", type: "image_generation_call", status: "completed", result: "base64" }],
    },
  })], (error) => assertNativeImageError(error, "unexpected_native_image_generation"));
});
