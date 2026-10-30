import { createHash } from "node:crypto";
import { createTextMessage, type Message, type MessageBlock } from "../types/messages.js";
import { splitSystemPromptPrefix } from "../context/prompts.js";
import { resolveImageBlockDataSync } from "../core/image-storage.js";
import { validateImageInput } from "../core/image-input.js";
import { ModelAPIError } from "./errors.js";
import type { ModelRequest, ModelStreamEvent, ModelUsage, ReasoningConfig } from "./model-gateway.js";
import { decodeSSE } from "./sse-decoder.js";
import { findModelMetadata } from "./context-window.js";

type Block = Record<string, unknown>;
interface Turn { role: "user" | "assistant"; content: Block[] }
export interface AnthropicMapperOptions {
  model: string;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig | null;
  thinkingBudgetTokens?: number;
}

export function anthropicInvalid(message: string): never {
  throw new ModelAPIError({ provider: "anthropic", category: "invalid_request", message, retryable: false });
}
function protocolError(message: string): never {
  throw new ModelAPIError({ provider: "anthropic", category: "provider_bug", message, retryable: false });
}
function record(value: unknown): value is Block { return !!value && typeof value === "object" && !Array.isArray(value); }
function visibleFingerprint(blocks: readonly MessageBlock[]): string {
  return createHash("sha256").update(JSON.stringify(blocks.filter(b => b.type !== "thinking"))).digest("hex");
}

export function buildAnthropicRequest(request: ModelRequest, options: AnthropicMapperOptions): Block {
  const model = request.model ?? options.model;
  const metadata = findModelMetadata(model);
  const maxTokens = request.maxOutputTokens ?? options.defaultMaxOutputTokens ?? 8192;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) anthropicInvalid("Claude max_tokens must be a positive integer");
  if (metadata?.provider === "anthropic" && metadata.maxOutputTokens && maxTokens > metadata.maxOutputTokens) anthropicInvalid(`max_tokens exceeds the configured limit for ${model}: ${metadata.maxOutputTokens}`);
  const split = splitSystemPromptPrefix(request.instructions ?? request.systemPrompt ?? "");
  const system: Block[] = [split.stablePrefix, split.dynamicSuffix].filter(Boolean).map(text => ({ type: "text", text }));
  const turns: Turn[] = [];
  const uses = new Set<string>(), results = new Set<string>();
  for (const m of request.messages) for (const b of m.blocks) {
    if (b.type === "tool_use") uses.add(b.id);
    if (b.type === "tool_result") results.add(b.toolUseId);
  }
  const paired = new Set([...uses].filter(id => results.has(id)));
  for (const message of request.messages) {
    if (message.role === "progress" || message.role === "tombstone" || message.metadata?.displayOnly || message.metadata?.systemInit) continue;
    if (message.role === "system") {
      for (const b of message.blocks) if (b.type === "text" && b.text.trim()) system.push({ type: "text", text: b.text });
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    let content: Block[] = [];
    // Preserve the provider's signed/opaque blocks through neo's local thinking
    // filtering and session persistence. Never replay another provider/model's
    // signatures or resurrect content changed by compaction.
    const replay = message.metadata?.anthropicReplay;
    if (role === "assistant" && record(replay) && replay.model === model && replay.fingerprint === visibleFingerprint(message.blocks) && Array.isArray(replay.content)) {
      content = (replay.content as Block[]).filter(b => b.type !== "tool_use" || paired.has(String(b.id))).map(b => ({ ...b }));
    } else {
      for (const b of message.blocks) {
        if (b.type === "text" && b.text.trim()) content.push({ type: "text", text: b.text });
        else if (b.type === "image" && role === "user") {
          const data = resolveImageBlockDataSync(b);
          if (!data) anthropicInvalid("Claude image data is missing");
          const image = validateImageInput(data);
          content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
        } else if (b.type === "tool_use" && role === "assistant" && paired.has(b.id)) {
          if (!record(b.input)) anthropicInvalid(`Tool input for ${b.name} must be a JSON object`);
          content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        } else if (b.type === "tool_result" && paired.has(b.toolUseId)) {
          content.push({ type: "tool_result", tool_use_id: b.toolUseId, is_error: !b.ok, content: typeof b.output === "string" ? b.output : JSON.stringify(b.output) ?? "null" });
        }
      }
    }
    if (!content.length) continue;
    const last = turns[turns.length - 1];
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content });
  }
  // Multiple parallel tool results and injected runtime context share a user
  // turn. Anthropic requires all tool_result blocks before ordinary user text.
  for (const turn of turns) if (turn.role === "user") turn.content = [...turn.content.filter(b => b.type === "tool_result"), ...turn.content.filter(b => b.type !== "tool_result")];
  let pending = new Set<string>();
  for (const turn of turns) {
    if (turn.role === "user") {
      const ids = turn.content.filter(b => b.type === "tool_result").map(b => String(b.tool_use_id));
      if (ids.length !== new Set(ids).size || ids.some(id => !pending.has(id)) || [...pending].some(id => !ids.includes(id))) anthropicInvalid("Claude tool results must immediately follow and match all assistant tool calls");
      pending.clear();
    } else {
      pending = new Set(turn.content.filter(b => b.type === "tool_use").map(b => String(b.id)));
    }
  }
  if (pending.size) anthropicInvalid("Claude tool calls are missing their following results");
  if (!turns.length || turns[0]!.role !== "user") anthropicInvalid("Claude messages must start with a non-empty user turn");
  if (turns[turns.length - 1]!.role === "assistant") anthropicInvalid("Claude assistant prefill is not supported; append a user turn");
  const body: Block = { model, max_tokens: maxTokens, messages: turns, stream: request.stream !== false };
  if (system.length) body.system = system;
  const tools = request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  if (tools.length) {
    body.tools = tools;
    const choice = request.toolChoice;
    if (typeof choice === "object") {
      if (!tools.some(t => t.name === choice.name)) anthropicInvalid(`Unknown Claude tool choice: ${choice.name}`);
      body.tool_choice = { type: "tool", name: choice.name };
    } else body.tool_choice = { type: choice === "required" ? "any" : choice ?? "auto" };
  } else if (request.toolChoice === "required" || typeof request.toolChoice === "object") anthropicInvalid("Claude tool choice requires tools");
  configureThinking(body, request, options, model, maxTokens);
  if (request.textFormat?.type === "json_schema") {
    if (!request.textFormat.schema) anthropicInvalid("Claude JSON schema output requires a schema");
    body.output_config = { ...(body.output_config as Block ?? {}), format: { type: "json_schema", schema: request.textFormat.schema } };
  } else if (request.textFormat?.type === "json_object") anthropicInvalid("Claude requires json_schema rather than OpenAI json_object output");
  if (request.serviceTier && request.serviceTier !== "auto" && request.serviceTier !== "default") anthropicInvalid(`Claude does not map OpenAI service tier '${request.serviceTier}'`);
  if (request.serviceTier === "auto") body.service_tier = "auto";
  if (request.serviceTier === "default") body.service_tier = "standard_only";
  if (request.metadata?.user_id) body.metadata = { user_id: request.metadata.user_id };
  // Deliberately no OpenAI-only fields, previous_response_id, or arbitrary
  // providerOptions spreading. Claude history is sent explicitly each time.
  return body;
}

function configureThinking(body: Block, request: ModelRequest, options: AnthropicMapperOptions, model: string, maxTokens: number): void {
  const reasoning = request.reasoning === undefined ? options.defaultReasoning : request.reasoning;
  if (reasoning?.summary) anthropicInvalid("OpenAI reasoning.summary is not a Claude parameter");
  const effort = reasoning?.effort;
  const metadata = findModelMetadata(model);
  if (effort && metadata?.provider === "anthropic" && metadata.reasoningEfforts && !metadata.reasoningEfforts.includes(effort)) anthropicInvalid(`Claude model ${model} does not support effort '${effort}'`);
  const adaptive = /claude-(?:opus-4-[678]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)/i.test(model);
  const alwaysOn = /claude-(?:opus-5-5|sonnet-5-5|fable-5|mythos-5|mythos-preview)/i.test(model);
  const disabled = reasoning === null || effort === "none";
  if (disabled) {
    if (alwaysOn) anthropicInvalid(`Thinking cannot be disabled on ${model}`);
    body.thinking = { type: "disabled" };
  } else if (effort) {
    if (effort === "minimal") anthropicInvalid("Claude has no 'minimal' effort; select low, medium, or high");
    if (adaptive) {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort };
    } else {
      if (effort === "xhigh" || effort === "max") anthropicInvalid("Legacy Claude thinking supports low/medium/high budget mapping only");
      const budget = options.thinkingBudgetTokens ?? Math.min(({ low: 1024, medium: 2048, high: 4096 }[effort]), maxTokens - 1);
      if (!Number.isSafeInteger(budget) || budget! < 1024 || budget! >= maxTokens) anthropicInvalid("Claude thinking budget must be >=1024 and less than max_tokens; raise MODEL_MAX_OUTPUT_TOKENS or set ANTHROPIC_THINKING_BUDGET_TOKENS");
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
  }
  const choice = body.tool_choice as Block | undefined;
  const thinkingEnabled = !!body.thinking && (body.thinking as Block).type !== "disabled";
  const defaultThinking = /claude-(?:(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)/i.test(model) && !disabled;
  if ((thinkingEnabled || defaultThinking) && (choice?.type === "any" || choice?.type === "tool")) anthropicInvalid("Claude thinking requires auto or none tool choice");
}

export function anthropicUsage(raw: Block): ModelUsage {
  const number = (key: string) => typeof raw[key] === "number" ? raw[key] as number : 0;
  const inputTokens = number("input_tokens") + number("cache_creation_input_tokens") + number("cache_read_input_tokens");
  const outputTokens = number("output_tokens");
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens: number("cache_read_input_tokens"), raw };
}

function assistantMessage(content: Block[], model: string, id?: string): Message {
  const blocks: MessageBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") blocks.push({ type: "text", text: b.text });
    else if (b.type === "thinking") blocks.push({ type: "thinking", text: String(b.thinking ?? ""), signature: typeof b.signature === "string" ? b.signature : undefined });
    else if (b.type === "tool_use") {
      if (typeof b.id !== "string" || typeof b.name !== "string" || !record(b.input)) protocolError("Invalid Claude tool_use block");
      blocks.push({ type: "tool_use", id: b.id as string, name: b.name as string, input: b.input });
    }
  }
  const message = { ...createTextMessage("assistant", ""), blocks, providerMessageId: id };
  return { ...message, metadata: { anthropicReplay: { model, content, fingerprint: visibleFingerprint(blocks) } } };
}

export function* normalizeAnthropicObject(body: Block, model: string): Generator<ModelStreamEvent> {
  if (body.type === "error") throw anthropicStreamError(body);
  if (body.type !== "message" || !Array.isArray(body.content)) protocolError("Expected an Anthropic Message response");
  if (typeof body.stop_reason !== "string" || !body.stop_reason) protocolError("Incomplete Claude Message response: missing stop_reason");
  if (!body.content.every(record)) protocolError("Invalid Claude Message content block");
  const content = body.content as Block[];
  const id = typeof body.id === "string" ? body.id : undefined;
  if (id) yield { type: "response_started", responseId: id };
  yield { type: "assistant_message", message: assistantMessage(content, model, id) };
  yield completionEvent(body.stop_reason as string, anthropicUsage(record(body.usage) ? body.usage : {}));
}

export async function* normalizeAnthropicStream(stream: ReadableStream<Uint8Array>, model: string, idleTimeoutMs = 120000): AsyncGenerator<ModelStreamEvent> {
  const blocks = new Map<number, Block>();
  const partialJson = new Map<number, string>();
  const openBlocks = new Set<number>();
  let id: string | undefined, started = false, stopped = false, reason: string | undefined;
  let usage: Block = {};
  for await (const sse of decodeSSE(stream, idleTimeoutMs)) {
    if (!record(sse.data)) protocolError("Invalid JSON in Claude SSE event");
    const event = sse.data as Block;
    const type = event.type ?? sse.event;
    if (type === "error") throw anthropicStreamError(event);
    yield { type: "provider_event", event };
    if (type === "message_start") {
      if (started || !record(event.message)) protocolError("Invalid Claude message_start");
      started = true;
      const message = event.message as Block;
      id = typeof message.id === "string" ? message.id : undefined;
      if (record(message.usage)) usage = { ...message.usage };
      if (id) yield { type: "response_started", responseId: id };
    } else if (type === "content_block_start") {
      const index = event.index as number;
      if (!started || !Number.isInteger(index) || blocks.has(index) || !record(event.content_block)) protocolError("Invalid Claude content_block_start");
      const block = { ...(event.content_block as Block) };
      blocks.set(index, block); openBlocks.add(index);
      if (block.type === "tool_use") {
        partialJson.set(index, "");
        yield { type: "tool_call_started", callId: String(block.id), name: String(block.name) };
      }
    } else if (type === "content_block_delta") {
      const index = event.index as number, block = blocks.get(index);
      if (!block || !openBlocks.has(index) || !record(event.delta)) protocolError("Claude delta has no open content block");
      const b = block!, delta = event.delta as Block;
      if (delta.type === "text_delta") {
        const text = String(delta.text ?? ""); b.text = String(b.text ?? "") + text;
        yield { type: "assistant_delta", text };
      } else if (delta.type === "thinking_delta") {
        const text = String(delta.thinking ?? ""); b.thinking = String(b.thinking ?? "") + text;
        yield { type: "thinking_delta", text };
      } else if (delta.type === "signature_delta") b.signature = String(b.signature ?? "") + String(delta.signature ?? "");
      else if (delta.type === "input_json_delta") {
        const text = String(delta.partial_json ?? "");
        partialJson.set(index, (partialJson.get(index) ?? "") + text);
        yield { type: "tool_call_delta", callId: String(b.id), name: String(b.name), argumentsDelta: text };
      } else if (delta.type === "citations_delta") {
        b.citations = [...(Array.isArray(b.citations) ? b.citations : []), delta.citation];
      }
    } else if (type === "content_block_stop") {
      const index = event.index as number, block = blocks.get(index);
      if (!block || !openBlocks.delete(index)) protocolError("Claude stopped an unopened content block");
      if (block!.type === "tool_use") {
        const json = partialJson.get(index);
        if (json) { try { block!.input = JSON.parse(json); } catch { protocolError("Claude returned incomplete or malformed tool JSON"); } }
        if (!record(block!.input)) protocolError("Claude tool input must be an object");
      }
      if (block!.type === "text") yield { type: "assistant_text_done" };
    } else if (type === "message_delta") {
      if (record(event.delta) && typeof event.delta.stop_reason === "string") reason = event.delta.stop_reason;
      if (record(event.usage)) usage = { ...usage, ...event.usage };
    } else if (type === "message_stop") {
      if (!started || openBlocks.size || !reason) protocolError("Incomplete Claude message at message_stop");
      stopped = true;
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      // Emit completed tool calls only after the whole message validates. A
      // truncated stream must never execute a partially received command.
      yield { type: "assistant_message", message: assistantMessage(content, model, id) };
      yield completionEvent(reason!, anthropicUsage(usage));
      break;
    }
  }
  if (!stopped) protocolError("Claude stream closed before message_stop");
}

function completionEvent(reason: string, usage: ModelUsage): ModelStreamEvent {
  return reason === "max_tokens" || reason === "model_context_window_exceeded"
    ? { type: "response_incomplete", reason, usage }
    : { type: "response_completed", stopReason: reason, usage };
}

function anthropicStreamError(event: Block): ModelAPIError {
  const error = record(event.error) ? event.error : event;
  const type = String(error.type ?? "api_error"), message = String(error.message ?? "Claude stream error");
  const category = /prompt is too long|context.*(?:length|limit)/i.test(message) ? "context_length"
    : type === "overloaded_error" ? "overloaded" : type === "rate_limit_error" ? "rate_limit"
    : type === "authentication_error" ? "auth_unavailable" : type === "permission_error" ? "permission_denied"
    : type === "invalid_request_error" ? "invalid_request" : "server_error";
  return new ModelAPIError({ provider: "anthropic", category, code: type, message, raw: event });
}
