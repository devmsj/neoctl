import { createTextMessage, type Message, type MessageBlock, type ToolUseRequest } from "../types/messages";
import type { ToolDefinition } from "../tools/tool";
import type { CredentialProvider } from "./credentials";
import { EnvCredentialProvider, StaticCredentialProvider } from "./credentials";
import { ModelAPIError, normalizeUnknownError } from "./errors";
import { HttpTransport } from "./http-transport";
import type { ModelGateway, ModelRequest, ModelStreamEvent, ModelUsage } from "./model-gateway";
import type { ProviderAdapter, ProviderCapabilities } from "./provider-adapter";
import { streamWithRetry } from "./retry-runner";
import { decodeSSE } from "./sse-decoder";

export type OpenAIEndpointPreference = "responses" | "chat" | "auto";

export interface OpenAIResponsesAdapterOptions {
  apiKey?: string;
  apiKeyEnvName?: string;
  credentialProvider?: CredentialProvider;
  baseUrl?: string;
  model: string;
  fallbackModel?: string;
  endpoint?: OpenAIEndpointPreference;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
}

interface ToolBuffer {
  callId: string;
  name: string;
  argumentsBuffer: string;
}

export class OpenAIResponsesAdapter implements ProviderAdapter, ModelGateway {
  readonly name = "openai.responses";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    functionTools: true,
    parallelToolCalls: true,
    structuredOutput: true,
    previousResponseId: true,
    imageInput: false,
    fileInput: false,
    reasoningConfig: true,
    builtInTools: false,
  };

  private readonly credentialProvider: CredentialProvider;
  private readonly transport = new HttpTransport(this.name);
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIResponsesAdapterOptions) {
    this.credentialProvider =
      options.credentialProvider ??
      (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider(options.apiKeyEnvName ?? "OPENAI_API_KEY"));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const endpoint = this.options.endpoint ?? "auto";
    yield* streamWithRetry((attempt) => this.streamAttempt(request, endpoint, attempt), {
      provider: this.name,
      maxRetries: this.options.maxRetries ?? 2,
    });
  }

  private async *streamAttempt(
    request: ModelRequest,
    endpoint: OpenAIEndpointPreference,
    attempt: number,
  ): AsyncGenerator<ModelStreamEvent> {
    if (endpoint === "chat") {
      yield* this.streamChat(request);
      return;
    }

    try {
      yield* this.streamResponses(request);
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error, this.name);
      if (endpoint === "auto" && shouldFallbackToChat(normalized)) {
        yield { type: "provider_event", event: { type: "endpoint_fallback", from: "responses", to: "chat", reason: normalized.message, attempt } };
        yield* this.streamChat(request);
        return;
      }
      throw normalized;
    }
  }

  private async *streamResponses(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const body = this.buildResponsesRequest(request);
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (request.stream !== false) {
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/v1/responses`,
        headers,
        body: { ...body, stream: true },
        timeoutMs,
        signal: request.cancellation,
      });
      yield* this.normalizeResponsesStream(response.body);
      return;
    }

    const response = await this.transport.sendJson<Record<string, unknown>>({
      method: "POST",
      url: `${this.baseUrl}/v1/responses`,
      headers,
      body: { ...body, stream: false },
      timeoutMs,
      signal: request.cancellation,
    });
    yield* this.normalizeResponsesObject(response.body);
  }

  private async *streamChat(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const body = this.buildChatRequest(request);
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (request.stream !== false) {
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/v1/chat/completions`,
        headers,
        body: { ...body, stream: true },
        timeoutMs,
        signal: request.cancellation,
      });
      yield* this.normalizeChatStream(response.body);
      return;
    }

    const response = await this.transport.sendJson<Record<string, unknown>>({
      method: "POST",
      url: `${this.baseUrl}/v1/chat/completions`,
      headers,
      body: { ...body, stream: false },
      timeoutMs,
      signal: request.cancellation,
    });
    yield* this.normalizeChatObject(response.body);
  }

  private buildResponsesRequest(request: ModelRequest): Record<string, unknown> {
    const tools = buildResponsesTools(request.tools);
    const body: Record<string, unknown> = {
      model: request.model ?? this.options.model,
      instructions: request.instructions ?? request.systemPrompt,
      input: buildResponsesInput(request.messages),
      tools: tools.length ? tools : undefined,
      tool_choice: request.toolChoice ?? (tools.length ? "auto" : undefined),
      previous_response_id: request.previousResponseId,
      max_output_tokens: request.maxOutputTokens ?? this.options.defaultMaxOutputTokens,
      reasoning: request.reasoning,
      text: request.textFormat ? { format: request.textFormat } : undefined,
      metadata: request.metadata,
      store: false,
    };
    return dropUndefined(body);
  }

  private buildChatRequest(request: ModelRequest): Record<string, unknown> {
    const tools = buildChatTools(request.tools);
    const body: Record<string, unknown> = {
      model: request.model ?? this.options.model,
      messages: buildChatMessages(request),
      tools: tools.length ? tools : undefined,
      tool_choice: request.toolChoice ?? (tools.length ? "auto" : undefined),
      max_tokens: request.maxOutputTokens ?? this.options.defaultMaxOutputTokens,
      metadata: request.metadata,
    };
    return dropUndefined(body);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const credential = await this.credentialProvider.getCredential();
    if (!credential) {
      throw new ModelAPIError({
        category: "auth_unavailable",
        provider: this.name,
        message: "OpenAI API key is not configured",
        retryable: false,
      });
    }
    return { Authorization: `Bearer ${credential}` };
  }

  private async *normalizeResponsesStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ModelStreamEvent> {
    const textParts: string[] = [];
    const toolBuffers = new Map<number, ToolBuffer>();
    let responseId: string | undefined;

    for await (const sse of decodeSSE(stream, this.options.streamIdleTimeoutMs ?? 120000)) {
      const event = sse.data as Record<string, unknown>;
      const type = asString(event.type ?? sse.event);
      yield { type: "provider_event", event };

      if (type === "response.created") {
        const response = event.response as Record<string, unknown> | undefined;
        responseId = asString(response?.id);
        if (responseId) yield { type: "response_started", responseId };
      }

      if (type === "response.output_text.delta") {
        const delta = asString(event.delta) ?? "";
        if (delta) {
          textParts.push(delta);
          yield { type: "assistant_delta", text: delta };
        }
      }

      if (type === "response.output_item.added") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const outputIndex = asNumber(event.output_index) ?? toolBuffers.size;
          toolBuffers.set(outputIndex, {
            callId: asString(item.call_id) ?? asString(item.id) ?? `call_${outputIndex}`,
            name: asString(item.name) ?? "unknown_tool",
            argumentsBuffer: asString(item.arguments) ?? "",
          });
        }
      }

      if (type === "response.function_call_arguments.delta") {
        const outputIndex = asNumber(event.output_index) ?? 0;
        const delta = asString(event.delta) ?? "";
        const buffer = ensureToolBuffer(toolBuffers, outputIndex);
        buffer.argumentsBuffer += delta;
        yield { type: "tool_call_delta", callId: buffer.callId, name: buffer.name, argumentsDelta: delta };
      }

      if (type === "response.function_call_arguments.done") {
        const outputIndex = asNumber(event.output_index) ?? 0;
        const buffer = ensureToolBuffer(toolBuffers, outputIndex);
        buffer.argumentsBuffer = asString(event.arguments) ?? buffer.argumentsBuffer;
      }

      if (type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const outputIndex = asNumber(event.output_index) ?? 0;
          const buffer = toolBuffers.get(outputIndex) ?? {
            callId: asString(item.call_id) ?? asString(item.id) ?? `call_${outputIndex}`,
            name: asString(item.name) ?? "unknown_tool",
            argumentsBuffer: asString(item.arguments) ?? "{}",
          };
          yield { type: "tool_use", toolUse: toToolUse(buffer) };
        }
      }

      if (type === "response.completed") {
        const response = event.response as Record<string, unknown> | undefined;
        responseId = asString(response?.id) ?? responseId;
        const text = textParts.join("");
        if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
        const usage = normalizeUsage(response?.usage);
        if (usage) yield { type: "usage", usage };
        yield { type: "response_completed", responseId, stopReason: asString(response?.status) ?? "completed", usage };
      }

      if (type === "response.incomplete") {
        const response = event.response as Record<string, unknown> | undefined;
        const usage = normalizeUsage(response?.usage);
        yield {
          type: "response_incomplete",
          responseId: asString(response?.id) ?? responseId,
          reason: asString((response?.incomplete_details as Record<string, unknown> | undefined)?.reason),
          usage,
        };
      }

      if (type === "error") {
        yield { type: "error", error: new Error(JSON.stringify(event.error ?? event)) };
      }
    }
  }

  private async *normalizeResponsesObject(response: Record<string, unknown>): AsyncGenerator<ModelStreamEvent> {
    const responseId = asString(response.id);
    if (responseId) yield { type: "response_started", responseId };
    const output = Array.isArray(response.output) ? response.output : [];
    const textParts: string[] = [];

    for (const item of output as Record<string, unknown>[]) {
      if (item.type === "message") {
        textParts.push(extractResponsesMessageText(item));
      }
      if (item.type === "function_call") {
        yield {
          type: "tool_use",
          toolUse: toToolUse({
            callId: asString(item.call_id) ?? asString(item.id) ?? "call_unknown",
            name: asString(item.name) ?? "unknown_tool",
            argumentsBuffer: asString(item.arguments) ?? "{}",
          }),
        };
      }
    }

    const text = textParts.join("");
    if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
    const usage = normalizeUsage(response.usage);
    if (usage) yield { type: "usage", usage };
    if (response.status === "incomplete") {
      yield { type: "response_incomplete", responseId, reason: asString((response.incomplete_details as Record<string, unknown> | undefined)?.reason), usage };
    } else {
      yield { type: "response_completed", responseId, stopReason: asString(response.status), usage };
    }
  }

  private async *normalizeChatStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ModelStreamEvent> {
    const textParts: string[] = [];
    const toolBuffers = new Map<number, ToolBuffer>();
    let responseId: string | undefined;

    for await (const sse of decodeSSE(stream, this.options.streamIdleTimeoutMs ?? 120000)) {
      const event = sse.data as Record<string, unknown>;
      yield { type: "provider_event", event };
      responseId = asString(event.id) ?? responseId;
      const choices = Array.isArray(event.choices) ? event.choices : [];

      for (const choice of choices as Record<string, unknown>[]) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        const content = asString(delta?.content);
        if (content) {
          textParts.push(content);
          yield { type: "assistant_delta", text: content };
        }

        const toolCalls = Array.isArray(delta?.tool_calls) ? delta?.tool_calls : [];
        for (const toolCall of toolCalls as Record<string, unknown>[]) {
          const index = asNumber(toolCall.index) ?? toolBuffers.size;
          const fn = toolCall.function as Record<string, unknown> | undefined;
          const buffer = toolBuffers.get(index) ?? {
            callId: asString(toolCall.id) ?? `call_${index}`,
            name: asString(fn?.name) ?? "unknown_tool",
            argumentsBuffer: "",
          };
          buffer.callId = asString(toolCall.id) ?? buffer.callId;
          buffer.name = asString(fn?.name) ?? buffer.name;
          const argsDelta = asString(fn?.arguments) ?? "";
          buffer.argumentsBuffer += argsDelta;
          toolBuffers.set(index, buffer);
          if (argsDelta) yield { type: "tool_call_delta", callId: buffer.callId, name: buffer.name, argumentsDelta: argsDelta };
        }

        const finishReason = asString(choice.finish_reason);
        if (finishReason === "tool_calls") {
          for (const buffer of toolBuffers.values()) yield { type: "tool_use", toolUse: toToolUse(buffer) };
        }
      }
    }

    const text = textParts.join("");
    if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
    yield { type: "response_completed", responseId, stopReason: "completed" };
  }

  private async *normalizeChatObject(response: Record<string, unknown>): AsyncGenerator<ModelStreamEvent> {
    const responseId = asString(response.id);
    if (responseId) yield { type: "response_started", responseId };
    const choices = Array.isArray(response.choices) ? response.choices : [];
    for (const choice of choices as Record<string, unknown>[]) {
      const message = choice.message as Record<string, unknown> | undefined;
      const content = asString(message?.content);
      if (content) yield { type: "assistant_message", message: createTextMessage("assistant", content) };
      const toolCalls = Array.isArray(message?.tool_calls) ? message?.tool_calls : [];
      for (const toolCall of toolCalls as Record<string, unknown>[]) {
        const fn = toolCall.function as Record<string, unknown> | undefined;
        yield {
          type: "tool_use",
          toolUse: toToolUse({
            callId: asString(toolCall.id) ?? "call_unknown",
            name: asString(fn?.name) ?? "unknown_tool",
            argumentsBuffer: asString(fn?.arguments) ?? "{}",
          }),
        };
      }
    }
    const usage = normalizeUsage(response.usage);
    if (usage) yield { type: "usage", usage };
    yield { type: "response_completed", responseId, stopReason: "completed", usage };
  }
}

function buildResponsesInput(messages: readonly Message[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "progress") continue;
    for (const block of message.blocks) {
      if (block.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: block.toolUseId, output: serializeToolOutput(block.output) });
      }
    }
    const text = textFromBlocks(message.blocks);
    if (!text) continue;
    if (message.role === "assistant") {
      input.push({ role: "assistant", content: [{ type: "output_text", text }] });
    } else if (message.role === "system") {
      input.push({ role: "developer", content: [{ type: "input_text", text }] });
    } else if (message.role !== "tool_result") {
      input.push({ role: "user", content: [{ type: "input_text", text }] });
    }
  }
  return input;
}

function buildChatMessages(request: ModelRequest): unknown[] {
  const messages: unknown[] = [];
  const instructions = request.instructions ?? request.systemPrompt;
  if (instructions) messages.push({ role: "system", content: instructions });
  for (const message of request.messages) {
    const text = textFromBlocks(message.blocks);
    if (message.role === "user" && text) messages.push({ role: "user", content: text });
    if (message.role === "assistant" && text) messages.push({ role: "assistant", content: text });
    for (const block of message.blocks) {
      if (block.type === "tool_result") {
        messages.push({ role: "tool", tool_call_id: block.toolUseId, content: serializeToolOutput(block.output) });
      }
    }
  }
  return messages;
}

function buildResponsesTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeSchema(tool.inputSchema),
    strict: false,
  }));
}

function buildChatTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeSchema(tool.inputSchema),
    },
  }));
}

function normalizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {}, additionalProperties: false };
  return schema;
}

function textFromBlocks(blocks: readonly MessageBlock[]): string {
  return blocks.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n");
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function toToolUse(buffer: ToolBuffer): ToolUseRequest {
  return { id: buffer.callId, name: buffer.name, input: parseArguments(buffer.argumentsBuffer) };
}

function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Tool call arguments are not valid JSON: ${value}`);
  }
}

function extractResponsesMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      const record = part as Record<string, unknown>;
      return asString(record.text) ?? asString(record.output_text) ?? "";
    })
    .join("");
}

function ensureToolBuffer(buffers: Map<number, ToolBuffer>, outputIndex: number): ToolBuffer {
  const existing = buffers.get(outputIndex);
  if (existing) return existing;
  const created = { callId: `call_${outputIndex}`, name: "unknown_tool", argumentsBuffer: "" };
  buffers.set(outputIndex, created);
  return created;
}

function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = asNumber(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens ?? usage.completion_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: asNumber(usage.total_tokens) ?? sum(inputTokens, outputTokens),
    reasoningTokens: asNumber((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
    cachedTokens: asNumber((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens),
    raw,
  };
}

function shouldFallbackToChat(error: ModelAPIError): boolean {
  return error.status === 404 || (error.status === 400 && /responses|endpoint|route|not found/i.test(error.message));
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sum(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}
