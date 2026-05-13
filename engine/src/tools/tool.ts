import type { AppStatePort } from "../app/app-state.js";
import type { Message, ToolUseRequest } from "../types/messages.js";
import type { ContentReplacementRecord, ToolResultMemory } from "../session/tool-result-memory.js";

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict?: boolean;
}

export interface ToolMetadata {
  readOnly: boolean;
  concurrent: boolean;
  visible: boolean;
  requiresApproval?: boolean;
  destructive?: boolean;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  isMcp?: boolean;
  isLsp?: boolean;
  maxResultSizeChars?: number;
  searchHint?: string;
}

export interface ToolProgressEvent {
  toolName: string;
  toolUseId?: string;
  message: string;
  data?: unknown;
}

export type ValidationResult<TInput> =
  | { ok: true; value: TInput }
  | { ok: false; message: string };

export interface ToolResult {
  ok: boolean;
  output: unknown;
  summary?: string;
  newMessages?: Message[];
  contextModifier?: (context: ToolUseContext) => ToolUseContext;
  mcpMeta?: {
    meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  };
}

export interface ToolRegistryLike {
  get(name: string): Tool | undefined;
  getByAlias?(name: string): Tool | undefined;
}

export interface ActiveSkillRuntimeState {
  name: string;
  allowedTools?: readonly string[];
  model?: string;
  effort?: string;
  source?: unknown;
}

export interface ToolRuntimeOptions {
  debug?: boolean;
  verbose?: boolean;
  mainLoopModel?: string;
  modelGateway?: import("../model/model-gateway.js").ModelGateway;
  tools?: ToolRegistryLike;
  thinkingConfig?: unknown;
  reasoning?: import("../model/model-gateway.js").ReasoningConfig | null;
  activeSkill?: ActiveSkillRuntimeState;
  isNonInteractiveSession?: boolean;
  refreshTools?: () => Promise<void> | void;
}

export interface ToolUseContext {
  agentId: string;
  agentType?: string;
  toolUseId?: string;
  abortSignal?: AbortSignal;
  tools: ToolRegistryLike;
  appState: AppStatePort;
  messages?: readonly Message[];
  queryTracking?: unknown;
  requestPrompt?: string;
  options?: ToolRuntimeOptions;
  toolResultMemory?: ToolResultMemory;
  emit(event: ToolProgressEvent): void;
  recordContentReplacements?(records: ContentReplacementRecord[]): void;
  appendSystemMessage?(message: Message): void;
  setResponseLength?(length: "short" | "medium" | "long"): void;
  pushApiMetricsEntry?(entry: Record<string, unknown>): void;
}

export interface ToolCallOptions<TInput> {
  canUseTool?: CanUseTool;
  parentMessage?: Message;
  onProgress?: (event: ToolProgressEvent) => void;
}

export type CanUseTool = (
  toolUse: ToolUseRequest,
  context: ToolUseContext,
) => boolean | ToolPermissionDecision | Promise<boolean | ToolPermissionDecision>;

export interface ToolPermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly searchHint?: string;
  readonly description: string | ((input?: TInput, context?: ToolUseContext) => string);
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly metadata: ToolMetadata;

  validate?(input: unknown, context: ToolUseContext): TInput;
  validateInput?(input: TInput, context: ToolUseContext): ValidationResult<TInput> | Promise<ValidationResult<TInput>>;
  isConcurrencySafe?(input: TInput, context: ToolUseContext): boolean;
  isEnabled?(context?: ToolUseContext): boolean;
  isReadOnly?(input: TInput, context: ToolUseContext): boolean;
  isDestructive?(input: TInput, context: ToolUseContext): boolean;
  interruptBehavior?(input: TInput, context: ToolUseContext): "cancel" | "block";
  backfillObservableInput?(input: TInput, context: ToolUseContext): unknown;

  execute?(input: TInput, context: ToolUseContext): Promise<ToolResult>;
  call?(input: TInput, context: ToolUseContext, options: ToolCallOptions<TInput>): Promise<ToolResult>;
  mapResult?(result: ToolResult, request: ToolUseRequest): unknown;
  renderToolUseMessage?(input: TInput): Message | undefined;
  renderToolResultMessage?(result: ToolResult, request?: ToolUseRequest): Message | undefined;
  renderToolProgressMessage?(progress: ToolProgressEvent): Message | undefined;
}

export function resolveToolDescription(tool: Tool, context?: ToolUseContext): string {
  return typeof tool.description === "function" ? tool.description(undefined, context) : tool.description;
}
