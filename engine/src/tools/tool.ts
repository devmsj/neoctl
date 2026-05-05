import type { AppStatePort } from "../app/app-state";
import type { ToolUseRequest } from "../types/messages";

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolMetadata {
  readOnly: boolean;
  concurrent: boolean;
  visible: boolean;
  requiresApproval?: boolean;
}

export interface ToolProgressEvent {
  toolName: string;
  message: string;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  summary?: string;
}

export interface ToolRegistryLike {
  get(name: string): Tool | undefined;
}

export interface ToolUseContext {
  agentId: string;
  abortSignal?: AbortSignal;
  tools: ToolRegistryLike;
  appState: AppStatePort;
  emit(event: ToolProgressEvent): void;
}

export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly metadata: ToolMetadata;
  validate?(input: unknown): TInput;
  execute(input: TInput, context: ToolUseContext): Promise<ToolResult>;
  mapResult?(result: ToolResult, request: ToolUseRequest): unknown;
}
