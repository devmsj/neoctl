import fs from "node:fs/promises";
import path from "node:path";
import type { Message, MessageBlock, ToolUseRequest } from "../types/messages.js";
import { ModelAPIError } from "./errors.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "./model-gateway.js";

export interface CommunicationLogSnapshot {
  enabled: boolean;
  directory?: string;
  calls: number;
}

export class CommunicationLogger {
  private directory?: string;
  private calls = 0;

  setDirectory(directory: string | undefined): void {
    this.directory = directory ? path.resolve(directory) : undefined;
  }

  snapshot(): CommunicationLogSnapshot {
    return {
      enabled: this.directory !== undefined,
      directory: this.directory,
      calls: this.calls,
    };
  }

  async createCallLog(request: ModelRequest): Promise<ModelCallLog | undefined> {
    if (!this.directory) return undefined;
    await fs.mkdir(this.directory, { recursive: true });
    this.calls += 1;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(this.calls).padStart(4, "0")}`;
    const basePath = path.join(this.directory, `model-call-${id}`);
    const log = new ModelCallLog(basePath, request);
    await log.writeRequest();
    return log;
  }
}

export class LoggingModelGateway implements ModelGateway {
  constructor(private inner: ModelGateway, readonly logger: CommunicationLogger) {}

  setInner(inner: ModelGateway): void {
    this.inner = inner;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const log = await this.logger.createCallLog(request);
    try {
      for await (const event of this.inner.stream(request)) {
        await log?.writeEvent(event);
        yield event;
      }
      await log?.finish();
    } catch (error) {
      await log?.writeError(error);
      await log?.finish(error);
      throw error;
    }
  }
}

class ModelCallLog {
  private readonly final = new FinalResponseAccumulator();

  constructor(private readonly basePath: string, private readonly request: ModelRequest) {}

  async writeRequest(): Promise<void> {
    await writeJson(`${this.basePath}.request.json`, {
      kind: "model_request",
      createdAt: new Date().toISOString(),
      request: normalizeRequestForLog(this.request),
    });
  }

  async writeEvent(event: ModelStreamEvent): Promise<void> {
    this.final.push(event);
    await appendJsonLine(`${this.basePath}.events.jsonl`, {
      kind: "model_stream_event",
      createdAt: new Date().toISOString(),
      event,
    });
  }

  async writeError(error: unknown): Promise<void> {
    await appendJsonLine(`${this.basePath}.events.jsonl`, {
      kind: "model_stream_error",
      createdAt: new Date().toISOString(),
      error: serializeError(error),
    });
  }

  async finish(error?: unknown): Promise<void> {
    const final = this.final.snapshot(error);
    await writeJson(`${this.basePath}.final.json`, {
      kind: "model_final_response",
      createdAt: new Date().toISOString(),
      ...final,
    });
    await fs.writeFile(`${this.basePath}.final.txt`, final.text, "utf8");
  }
}

class FinalResponseAccumulator {
  private textFromDelta = "";
  private assistantMessages: Message[] = [];
  private toolUses: ToolUseRequest[] = [];
  private responseIds: string[] = [];
  private stopReason?: string;

  push(event: ModelStreamEvent): void {
    if (event.type === "assistant_delta") this.textFromDelta += event.text;
    if (event.type === "assistant_message") this.assistantMessages.push(event.message);
    if (event.type === "tool_use") this.toolUses.push(event.toolUse);
    if (event.type === "response_started") this.responseIds.push(event.responseId);
    if (event.type === "response_completed") {
      if (event.responseId) this.responseIds.push(event.responseId);
      this.stopReason = event.stopReason;
    }
    if (event.type === "response_incomplete") {
      if (event.responseId) this.responseIds.push(event.responseId);
      this.stopReason = event.reason;
    }
  }

  snapshot(error?: unknown): { text: string; assistantMessages: Message[]; toolUses: ToolUseRequest[]; responseIds: string[]; stopReason?: string; error?: unknown } {
    const text = this.textFromDelta || this.assistantMessages.map(messageText).filter(Boolean).join("\n");
    return {
      text,
      assistantMessages: this.assistantMessages,
      toolUses: this.toolUses,
      responseIds: [...new Set(this.responseIds)],
      stopReason: this.stopReason,
      error: error === undefined ? undefined : serializeError(error),
    };
  }
}

function normalizeRequestForLog(request: ModelRequest): Record<string, unknown> {
  const { cancellation: _cancellation, ...serializable } = request;
  return {
    ...serializable,
    messages: request.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map(normalizeBlockForLog),
    })),
  };
}

function normalizeBlockForLog(block: MessageBlock): MessageBlock {
  return block;
}

function messageText(message: Message): string {
  return message.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function writeJson(filepath: string, value: unknown): Promise<void> {
  await fs.writeFile(filepath, `${stableStringify(value)}\n`, "utf8");
}

async function appendJsonLine(filepath: string, value: unknown): Promise<void> {
  await fs.appendFile(filepath, `${stableStringify(value)}\n`, "utf8");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, replacer, 2);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return value;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof ModelAPIError) {
    return {
      name: error.name,
      message: error.message,
      category: error.category,
      provider: error.provider,
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
      retryable: error.retryable,
      request: error.request,
      response: compactForLog(error.response),
      raw: compactForLog(error.raw),
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function compactForLog(value: unknown, maxChars = 8000): unknown {
  if (value === undefined) return undefined;
  const text = safeStringify(value);
  if (text.length <= maxChars) return value;
  return {
    truncated: true,
    originalLength: text.length,
    preview: text.slice(0, maxChars),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replacer);
  } catch (error) {
    return String(error);
  }
}
