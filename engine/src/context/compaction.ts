import type { ModelGateway } from "../model/model-gateway.js";
import { createTextMessage, withoutThinkingBlocks, type Message, type MessageBlock } from "../types/messages.js";
import { estimateTextTokens } from "../core/context-metrics.js";
import { buildImageRegistry, extractRegistryFromBoundary, mergeImageRegistries, formatImageRegistryForContext, type ImageRegistry } from "../core/image-registry.js";
import { resolveImageBlockDataLengthSync } from "../core/image-storage.js";

export interface ContextBudgetOptions {
  snipMaxChars?: number;
  microCompactMaxChars?: number;
  autoCompactMaxChars?: number;
  estimatedInputTokens?: number;
  contextWindowTokens?: number;
  autoCompactTriggerRatio?: number;
  microCompactTriggerRatio?: number;
  snipCompactTriggerRatio?: number;
  /** @deprecated Summary checkpoints preserve recent user messages by token budget instead. */
  keepRecentMessages?: number;
  keepRecentTokenBudget?: number;
  keepRecentToolResults?: number;
  /** Character budget for deterministic fallback, snip, and pure summaries. Model summaries use compactMaxOutputTokens. */
  summaryMaxChars?: number;
  /** @deprecated Checkpoint summaries serialize the complete pre-compaction window. */
  compactInputMaxChars?: number;
  compactModel?: string;
  compactMaxOutputTokens?: number;
}

export type CompactionReason = "none" | "snip" | "microcompact" | "autocompact" | "reactive_compact" | "manualcompact" | "purecompact";

export interface CompactionReport {
  reason: Exclude<CompactionReason, "none">;
  summary: string;
  continuationState: string;
  sourceMessages: number;
  preservedUserMessages: number;
  newWindowMessages: number;
  charsFreed: number;
  modelDriven: boolean;
  imageCount: number;
}

export interface CompactionResult {
  messages: Message[];
  summary?: string;
  changed: boolean;
  reason?: CompactionReason;
  charsFreed?: number;
  report?: CompactionReport;
  /** @deprecated Use charsFreed instead. Alias kept for backward compatibility. */
  tokensFreed?: number;
}

export interface Compactor {
  compact(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  manualCompact?(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  pureCompact?(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  reactiveCompact?(messages: readonly Message[], error: Error, options?: ContextBudgetOptions): Promise<CompactionResult>;
}

export const CLEARED_TOOL_RESULT_CONTENT = "[Old tool result content cleared]";
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

export class DeterministicCompactor implements Compactor {
  async compact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const micro = microCompactIfNeeded(messages, options);
    const auto = autoCompactIfNeeded(micro.messages, options, messages);
    if (auto.changed) return auto;

    const snipped = snipCompactIfNeeded(micro.messages, options);
    if (snipped.changed) return mergeResults([micro, snipped], snipped.reason);
    if (micro.changed) return micro;
    return { messages: [...messages], changed: false, reason: "none" };
  }

  async manualCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return manualCompactWithSummary(messages, options);
  }

  async pureCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return pureCompactWithSanitizedSummary(messages, options);
  }

  async reactiveCompact(messages: readonly Message[], error: Error, options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const micro = microCompactIfNeeded(messages, options);
    const reactive = reactiveCompactWithSummary(
      messages,
      micro.messages,
      `Reactive compact after model context error: ${error.message}`,
      options,
    );
    return reactive;
  }
}

export class ModelDrivenCompactor implements Compactor {
  constructor(private readonly modelGateway: ModelGateway) {}

  async compact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    if (!shouldCompactForBudget(messages, options, options.autoCompactMaxChars)) {
      return { messages: [...messages], changed: false, reason: "none" };
    }
    return this.createCheckpoint(messages, "autocompact", options);
  }

  async manualCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return this.createCheckpoint(messages, "manualcompact", options);
  }

  async pureCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return pureCompactWithSanitizedSummary(messages, options);
  }

  async reactiveCompact(messages: readonly Message[], _error: Error, options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return this.createCheckpoint(messages, "reactive_compact", options);
  }

  private async createCheckpoint(
    messages: readonly Message[],
    reason: "autocompact" | "manualcompact" | "reactive_compact",
    options: ContextBudgetOptions,
  ): Promise<CompactionResult> {
    if (messages.length === 0) return { messages: [], changed: false, reason: "none" };

    try {
      const summary = await this.summarizeWithModel(messages, CHECKPOINT_COMPACT_INSTRUCTIONS, options);
      return buildCompactionResult(messages, summary, reason, true, options);
    } catch {
      return checkpointCompactWithSummary(messages, options, reason);
    }
  }

  private async summarizeWithModel(
    messages: readonly Message[],
    instructions: string,
    options: ContextBudgetOptions,
  ): Promise<string> {
    const compactMessages = prepareMessagesForModelSummary(messages, instructions);
    if (compactMessages.length === 1) return "No earlier conversation content required preservation.";

    let streamedText = "";
    let finalAssistantText = "";
    let completed = false;
    for await (const event of this.modelGateway.stream({
      model: options.compactModel,
      messages: compactMessages,
      tools: [],
      toolChoice: "none",
      stream: true,
      maxOutputTokens: options.compactMaxOutputTokens ?? 2500,
      queryOrigin: "compact",
      providerOptions: {
        compact: true,
      },
    })) {
      if (event.type === "assistant_delta") streamedText += event.text;
      if (event.type === "assistant_message") finalAssistantText = extractText(event.message).trim() || finalAssistantText;
      if (event.type === "response_completed") completed = true;
      if (event.type === "response_incomplete") throw new Error(`Model compaction response was incomplete: ${event.reason ?? "unknown reason"}`);
      if (event.type === "error") throw event.error;
    }

    if (!completed) throw new Error("Model compaction stream ended before completion");
    const summary = (finalAssistantText || streamedText).trim();
    if (!summary) throw new Error("Model compaction produced an empty summary");
    return summary;
  }
}

export class NoopCompactor implements Compactor {
  async compact(messages: readonly Message[]): Promise<CompactionResult> {
    return { messages: [...messages], changed: false, reason: "none" };
  }

  async manualCompact(messages: readonly Message[]): Promise<CompactionResult> {
    return { messages: [...messages], changed: false, reason: "none" };
  }

  async pureCompact(messages: readonly Message[]): Promise<CompactionResult> {
    return { messages: [...messages], changed: false, reason: "none" };
  }
}

/**
 * Default runtime policy: explicit compact commands remain available, while
 * normal turns and context-error retries never rewrite conversation history.
 */
export class ManualOnlyCompactor implements Compactor {
  constructor(private readonly delegate: Compactor) {}

  async compact(messages: readonly Message[], _options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return { messages: [...messages], changed: false, reason: "none" };
  }

  async manualCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return this.delegate.manualCompact?.(messages, options) ?? { messages: [...messages], changed: false, reason: "none" };
  }

  async pureCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return this.delegate.pureCompact?.(messages, options) ?? { messages: [...messages], changed: false, reason: "none" };
  }

  async reactiveCompact(messages: readonly Message[], _error: Error, _options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return { messages: [...messages], changed: false, reason: "none" };
  }
}

export function withCompactionReport(result: CompactionResult, sourceMessages: number): CompactionResult {
  if (!result.changed || result.report) return result;
  const reason = result.reason && result.reason !== "none" ? result.reason : "autocompact";
  const boundary = findLastCompactBoundary(result.messages);
  const boundaryText = boundary ? extractText(boundary) : "";
  const continuationState = extractCompactState(boundaryText) || result.summary || "";
  const imageRegistry = boundary?.metadata?.imageRegistry as ImageRegistry | undefined;
  const report: CompactionReport = {
    reason,
    summary: result.summary || continuationState,
    continuationState,
    sourceMessages: Math.max(0, Math.round(sourceMessages)),
    preservedUserMessages: result.messages.filter((message) => message.metadata?.compactPreservedUser === true).length,
    newWindowMessages: result.messages.length,
    charsFreed: Math.max(0, result.charsFreed ?? result.tokensFreed ?? 0),
    modelDriven: boundary?.metadata?.modelDriven === true,
    imageCount: Array.isArray(imageRegistry?.images) ? imageRegistry.images.length : 0,
  };
  return {
    ...result,
    messages: result.messages.map((message) => message === boundary
      ? { ...message, metadata: { ...message.metadata, compactionReport: report } }
      : message),
    report,
  };
}

function findLastCompactBoundary(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].metadata?.compactBoundary === true) return messages[index];
  }
  return undefined;
}

export function estimateMessagesChars(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + serializeMessage(message).length, 0);
}

export function snipCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions = {}): CompactionResult {
  const maxChars = options.snipMaxChars ?? 90000;
  const triggerRatio = options.snipCompactTriggerRatio ?? 0.98;
  if (!shouldCompactForBudget(messages, options, maxChars, triggerRatio)) return { messages: [...messages], changed: false, reason: "none" };

  const head = messages.slice(0, 1).filter((message) => !message.metadata?.compactBoundary);
  const tailStart = Math.max(head.length, computeKeepRecentSplit(messages, options, options.keepRecentMessages ?? 6));
  const tail = messages.slice(tailStart);
  const removed = messages.slice(head.length, tailStart);
  const summary = buildHistorySummary(removed, options.summaryMaxChars ?? 3000);
  const imageRegistry = buildMergedImageRegistry(messages);
  const boundary = createCompactionBoundaryMessage(`Snipped older conversation for context budget.\n\n${summary}`, "snip", false, imageRegistry);
  const compacted = [...head, boundary, ...tail];

  const freed = Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars(compacted));
  return {
    messages: compacted,
    summary,
    changed: true,
    reason: "snip",
    charsFreed: freed,
    tokensFreed: freed,
  };
}

export function microCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions = {}): CompactionResult {
  const maxChars = options.microCompactMaxChars ?? 30000;
  const triggerRatio = options.microCompactTriggerRatio ?? 0.85;
  if (!shouldCompactForBudget(messages, options, maxChars, triggerRatio)) return { messages: [...messages], changed: false, reason: "none" };

  const keepRecentToolResults = Math.max(1, options.keepRecentToolResults ?? 6);
  const toolResultIds = collectToolResultIds(messages);
  const keepIds = new Set(toolResultIds.slice(-keepRecentToolResults));
  let changed = false;
  let cleared = 0;

  const compacted = messages.map((message) => {
    if (message.metadata?.compactBoundary === true || message.role !== "tool_result") return message;

    let touched = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== "tool_result" || keepIds.has(block.toolUseId)) return block;
      const serialized = serializeToolOutput(block.output);
      if (serialized === CLEARED_TOOL_RESULT_CONTENT || serialized.length < 512) return block;
      touched = true;
      cleared += 1;
      return {
        ...block,
        output: CLEARED_TOOL_RESULT_CONTENT,
      };
    });

    if (!touched) return message;
    changed = true;
    return {
      ...message,
      blocks,
      metadata: { ...message.metadata, microCompacted: true, clearedToolResultContent: true },
    };
  });

  if (!changed) return { messages: [...messages], changed: false, reason: "none" };

  const freed = Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars(compacted));
  return {
    messages: compacted,
    summary: `Cleared ${cleared} older tool result content block(s); kept the latest ${keepRecentToolResults}.`,
    changed: true,
    reason: "microcompact",
    charsFreed: freed,
    tokensFreed: freed,
  };
}

export function autoCompactIfNeeded(
  messages: readonly Message[],
  options: ContextBudgetOptions = {},
  sourceMessages: readonly Message[] = messages,
): CompactionResult {
  const maxChars = options.autoCompactMaxChars ?? 50000;
  if (!shouldCompactForBudget(messages, options, maxChars)) return { messages: [...messages], changed: false, reason: "none" };
  if (sourceMessages.length === 0) return { messages: [], changed: false, reason: "none" };

  const summary = buildCheckpointFallbackSummary(sourceMessages, options.summaryMaxChars ?? 5000);
  return buildCompactionResult(
    sourceMessages,
    summary || "No conversation content was available to summarize.",
    "autocompact",
    false,
    options,
    messages,
  );
}

function computeKeepRecentSplit(messages: readonly Message[], options: ContextBudgetOptions, fallbackCount?: number): number {
  const tokenBudget = options.keepRecentTokenBudget ?? defaultRecentTokenBudget(options.contextWindowTokens);
  const keepCount = fallbackCount ?? options.keepRecentMessages ?? 8;

  if (!tokenBudget) return Math.max(0, messages.length - keepCount);

  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msgTokens = estimateTextTokens(serializeMessage(messages[i]));
    if (tokens + msgTokens > tokenBudget && i < messages.length - 1) return i + 1;
    tokens += msgTokens;
  }
  return 0;
}

function shouldCompactForBudget(messages: readonly Message[], options: ContextBudgetOptions, fallbackMaxChars?: number, triggerRatioOverride?: number): boolean {
  if (options.contextWindowTokens && options.estimatedInputTokens !== undefined) {
    const triggerRatio = triggerRatioOverride ?? options.autoCompactTriggerRatio ?? 0.92;
    return options.estimatedInputTokens / options.contextWindowTokens >= triggerRatio;
  }
  return fallbackMaxChars !== undefined && estimateMessagesChars(messages) > fallbackMaxChars;
}

function manualCompactWithSummary(messages: readonly Message[], options: ContextBudgetOptions): CompactionResult {
  return checkpointCompactWithSummary(messages, options, "manualcompact");
}

function checkpointCompactWithSummary(
  messages: readonly Message[],
  options: ContextBudgetOptions,
  reason: "autocompact" | "reactive_compact" | "manualcompact",
): CompactionResult {
  if (messages.length === 0) return { messages: [], changed: false, reason: "none" };
  const summary = buildCheckpointFallbackSummary(messages, options.summaryMaxChars ?? 6000);
  return buildCompactionResult(
    messages,
    summary || "No conversation content was available to summarize.",
    reason,
    false,
    options,
  );
}

function reactiveCompactWithSummary(
  sourceMessages: readonly Message[],
  messagesForSelection: readonly Message[],
  heading: string,
  options: ContextBudgetOptions,
): CompactionResult {
  const summary = buildCheckpointFallbackSummary(sourceMessages, options.summaryMaxChars ?? 6000);
  return buildCompactionResult(
    sourceMessages,
    `${heading}\n\n${summary || "No conversation content was available to summarize."}`,
    "reactive_compact",
    false,
    options,
    messagesForSelection,
  );
}

function pureCompactWithSanitizedSummary(messages: readonly Message[], options: ContextBudgetOptions): CompactionResult {
  if (messages.length === 0) return { messages: [], changed: false, reason: "none" };

  const summary = buildPureSummary(messages, options.summaryMaxChars ?? 4000);
  const imageRegistry = buildMergedImageRegistry(messages);
  const boundary = createCompactionBoundaryMessage(
    `Pure compacted conversation after a transport/WAF risk block.\n\n${summary}`,
    "purecompact",
    false,
    imageRegistry,
  );

  const freed = Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars([boundary]));
  return {
    messages: [boundary],
    summary,
    changed: true,
    reason: "purecompact",
    charsFreed: freed,
    tokensFreed: freed,
  };
}

function buildCompactionResult(
  originalMessages: readonly Message[],
  summary: string,
  reason: "autocompact" | "reactive_compact" | "manualcompact",
  modelDriven: boolean,
  options: ContextBudgetOptions,
  messagesForSelection: readonly Message[] = originalMessages,
): CompactionResult {
  const label = reason === "autocompact"
    ? "Auto compacted earlier conversation."
    : reason === "manualcompact"
      ? "Manually compacted earlier conversation."
      : "Reactive compacted earlier conversation.";

  const imageRegistry = buildMergedImageRegistry(originalMessages);
  const preservedUsers = selectRecentUserMessages(messagesForSelection, options.keepRecentTokenBudget ?? COMPACT_USER_MESSAGE_MAX_TOKENS);
  const boundary = createCompactionBoundaryMessage(`${label}\n\n${summary}`, reason, modelDriven, imageRegistry);
  const compacted = [...preservedUsers, boundary];
  const freed = Math.max(0, estimateMessagesChars(originalMessages) - estimateMessagesChars(compacted));
  return {
    messages: compacted,
    summary,
    changed: true,
    reason,
    charsFreed: freed,
    tokensFreed: freed,
  };
}

function selectRecentUserMessages(messages: readonly Message[], tokenBudget: number): Message[] {
  if (tokenBudget <= 0) return [];
  const users = messages.filter(isRealUserMessage);
  const selected: Message[] = [];
  let remaining = tokenBudget;

  for (let index = users.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = users[index];
    const tokens = estimateMessageTokens(message);
    if (tokens <= remaining) {
      selected.push(markPreservedUserMessage(message));
      remaining -= tokens;
      continue;
    }

    const truncated = truncateUserMessageToTokenBudget(message, remaining);
    if (truncated) selected.push(markPreservedUserMessage(truncated));
    break;
  }
  return selected.reverse();
}

function isRealUserMessage(message: Message): boolean {
  return message.role === "user" && message.isMeta !== true && message.metadata?.compactBoundary !== true;
}

function estimateMessageTokens(message: Message): number {
  return estimateTextTokens(serializeMessage(message));
}

function markPreservedUserMessage(message: Message): Message {
  return {
    ...message,
    blocks: message.blocks.map((block) => ({ ...block })),
    metadata: { ...message.metadata, compactPreservedUser: true },
  };
}

function truncateUserMessageToTokenBudget(message: Message, maxTokens: number): Message | undefined {
  if (maxTokens <= 0) return undefined;
  const marker = "[... user message truncated for compaction token budget ...]";
  const textLength = message.blocks.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
  if (textLength === 0) return undefined;

  let low = 0;
  let high = textLength;
  let best: MessageBlock[] | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const blocks = truncateUserBlocks(message.blocks, mid, marker);
    if (estimateTextTokens(blocks.map(serializeBlock).join("\n")) <= maxTokens) {
      best = blocks;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best ? { ...message, blocks: best } : undefined;
}

function truncateUserBlocks(blocks: readonly MessageBlock[], textChars: number, marker: string): MessageBlock[] {
  const result: MessageBlock[] = [];
  let remaining = textChars;
  let markerInserted = false;

  for (const block of blocks) {
    if (block.type !== "text") {
      result.push({ ...block });
      continue;
    }
    if (remaining <= 0) continue;
    const kept = block.text.slice(0, remaining);
    remaining -= kept.length;
    if (kept) result.push({ type: "text", text: kept });
  }

  for (let index = result.length - 1; index >= 0; index -= 1) {
    const block = result[index];
    if (block.type !== "text") continue;
    result[index] = { type: "text", text: `${block.text.trimEnd()}\n${marker}` };
    markerInserted = true;
    break;
  }
  if (!markerInserted) result.unshift({ type: "text", text: marker });
  return result;
}

function buildMergedImageRegistry(messages: readonly Message[]): ImageRegistry {
  const previousRegistry = extractRegistryFromBoundary(messages);
  const currentRegistry = buildImageRegistry(messages);
  return previousRegistry
    ? mergeImageRegistries(previousRegistry, currentRegistry)
    : currentRegistry;
}

function mergeResults(results: readonly CompactionResult[], reason: CompactionReason | undefined): CompactionResult {
  const changedResults = results.filter((result) => result.changed);
  const last = changedResults[changedResults.length - 1] ?? results[results.length - 1];
  const freed = changedResults.reduce((total, result) => total + (result.charsFreed ?? result.tokensFreed ?? 0), 0);
  return {
    messages: last.messages,
    summary: changedResults.map((result) => result.summary).filter(Boolean).join("\n\n") || undefined,
    changed: changedResults.length > 0,
    reason,
    charsFreed: freed,
    tokensFreed: freed,
  };
}

function createCompactionBoundaryMessage(summary: string, reason: string, modelDriven: boolean, imageRegistry?: ImageRegistry): Message {
  const registryText = imageRegistry && imageRegistry.images.length > 0
    ? `\n\n${formatImageRegistryForContext(imageRegistry)}`
    : "";
  return {
    ...createTextMessage("system", renderInternalContinuationState(summary + registryText, reason)),
    isMeta: true,
    metadata: {
      compactBoundary: true,
      compactionReason: reason,
      modelDriven,
      ...(imageRegistry && imageRegistry.images.length > 0 ? { imageRegistry } : {}),
    },
  };
}

function renderInternalContinuationState(summary: string, reason: string): string {
  return [
    `Internal continuation state from context compaction (${reason}).`,
    "This is not a user message. Use it only to continue the task; do not quote, summarize, or mirror this block in the final answer.",
    "<compact_state>",
    normalizeSummaryForInternalState(summary),
    "</compact_state>",
  ].join("\n");
}

function extractCompactState(text: string): string {
  const match = /<compact_state>\s*([\s\S]*?)\s*<\/compact_state>/i.exec(text);
  return match?.[1]?.trim() ?? "";
}

function normalizeSummaryForInternalState(summary: string): string {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, ""))
    .join("\n")
    .trim();
}

function buildCheckpointFallbackSummary(messages: readonly Message[], maxChars: number): string {
  const previousState = findLatestCheckpointState(messages);
  const runtimeContext = messages
    .filter((message) => message.isMeta === true && (message.metadata?.runtimeContext === true || message.metadata?.userContext === true || message.metadata?.systemContext === true))
    .map(extractText)
    .filter(Boolean)
    .at(-1);
  const userContext = messages
    .filter(isRealUserMessage)
    .map((message) => summarizeMessageText(message, 700))
    .filter(Boolean)
    .slice(-12);
  const assistantProgress = messages
    .filter((message) => message.role === "assistant" && message.isApiErrorMessage !== true)
    .map((message) => summarizeMessageText(message, 700))
    .filter(Boolean)
    .slice(-10);
  const references = collectContinuationReferences(messages).slice(0, 24);
  const toolActivity = summarizeFallbackToolActivity(messages);

  const sections = [
    formatFallbackSection("User goals, constraints, and requests", userContext),
    formatFallbackSection("Assistant progress and decisions", assistantProgress),
    previousState ? `Previous checkpoint state:\n${truncateSummaryText(previousState, 2400)}` : "",
    runtimeContext ? `Runtime context:\n${truncateSummaryText(runtimeContext, 900)}` : "",
    references.length > 0 ? `Critical references:\n${references.map((reference) => `- ${reference}`).join("\n")}` : "",
    toolActivity ? `Tool activity relevant to continuation:\n${toolActivity}` : "",
  ].filter(Boolean);
  const nextStep = "Next step: continue from the latest unresolved user request using the checkpoint state above; verify the current workspace before making further changes.";

  return fitSummarySectionsWithFooter(sections, nextStep, maxChars);
}

function findLatestCheckpointState(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.metadata?.compactBoundary !== true) continue;
    return extractCompactState(extractText(message)) || extractText(message);
  }
  return "";
}

function summarizeMessageText(message: Message, maxChars: number): string {
  const parts = message.blocks.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return [`[image: ${block.label ?? "unlabeled"}, ${block.mimeType}]`];
    return [];
  });
  return truncateSummaryText(parts.join("\n").replace(/\s+/g, " ").trim(), maxChars);
}

function collectContinuationReferences(messages: readonly Message[]): string[] {
  const references: string[] = [];
  const patterns = [
    /[A-Za-z]:[\\/](?:[^\s"'`<>|]+[\\/]?)+/g,
    /(?:^|\s)(\/(?:[^\s"'`<>]+\/?)+)/g,
    /https?:\/\/[^\s"'`<>]+/g,
    /\b[0-9a-f]{7,40}\b/gi,
    /\b(?:task|session|request|response|artifact|turn|thread)[-_ ]?id\s*[:=]\s*[^\s,;]+/gi,
  ];
  for (const message of messages) {
    for (const block of message.blocks) {
      const text = block.type === "text"
        ? block.text
        : block.type === "tool_use"
          ? serializeToolOutput(block.input)
          : block.type === "tool_result"
            ? serializeToolOutput(block.output)
            : "";
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const value = (match[1] ?? match[0]).trim().replace(/[),.;:]+$/, "");
          if (value) references.push(value);
        }
      }
    }
  }
  return dedupeLines(references).slice(-24);
}

function summarizeFallbackToolActivity(messages: readonly Message[]): string {
  const successful: string[] = [];
  const failedByName = new Map<string, number>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      if (block.ok) {
        const output = serializeToolOutput(block.output).replace(/\s+/g, " ").trim();
        if (output && output !== CLEARED_TOOL_RESULT_CONTENT) {
          successful.push(`- ${block.name}: ${truncateSummaryText(output, 320)}`);
        }
      } else {
        failedByName.set(block.name, (failedByName.get(block.name) ?? 0) + 1);
      }
    }
  }
  const lines = successful.slice(-6);
  if (failedByName.size > 0) {
    const counts = [...failedByName.entries()].map(([name, count]) => `${name} ×${count}`).join(", ");
    lines.push(`- Some tool attempts failed (${counts}); individual transient errors were omitted. Re-check only if still relevant.`);
  }
  return lines.join("\n");
}

function formatFallbackSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function truncateSummaryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function fitSummarySectionsWithFooter(sections: readonly string[], footer: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (maxChars <= footer.length) return truncateSummaryText(footer, maxChars);

  const footerWithSeparator = `\n\n${footer}`;
  const bodyBudget = maxChars - footerWithSeparator.length;
  let body = "";
  for (const section of sections) {
    const separator = body ? "\n\n" : "";
    const remaining = bodyBudget - body.length - separator.length;
    if (remaining <= 0) break;
    body += separator + truncateSummaryText(section, remaining);
    if (section.length > remaining) break;
  }
  return body ? `${body}${footerWithSeparator}` : footer;
}

function scoreMessageImportance(message: Message): number {
  let score = 1;
  if (message.metadata?.compactBoundary) return 0;
  if (message.role === "user") score += 3;
  if (message.role === "system") score += 2;

  for (const block of message.blocks) {
    if (block.type === "text") {
      const text = block.text.toLowerCase();
      if (/\b(error|fail|exception|panic|crash|bug)\b/.test(text)) score += 3;
      if (/\b(must|require|constraint|important|critical|never|always)\b/.test(text)) score += 2;
      if (/\b(decide|chosen|approach|plan|architecture|design)\b/.test(text)) score += 2;
      if (/\b(todo|pending|remaining|next step|blocked)\b/.test(text)) score += 2;
    }
    if (block.type === "tool_result") {
      if (!block.ok) score += 3;
      const output = serializeToolOutput(block.output);
      if (/\b(error|fail|permission denied|not found)\b/i.test(output)) score += 2;
    }
    if (block.type === "tool_use") score += 1;
  }
  return score;
}

function extractStructuredToolResult(block: { type: "tool_result"; toolUseId: string; name: string; ok: boolean; output: unknown }): string {
  const output = serializeToolOutput(block.output);
  const status = block.ok ? "ok" : "error";
  const toolName = block.name;

  if (toolName.includes("exec") || toolName.includes("shell") || toolName.includes("bash")) {
    const exitMatch = output.match(/exit[_ ]?code[:\s]*(\d+)/i);
    const exitCode = exitMatch ? exitMatch[1] : (block.ok ? "0" : "non-zero");
    const errorLines = output.split("\n").filter((line) => /error|fail|warning|denied/i.test(line)).slice(0, 3);
    const errorSummary = errorLines.length > 0 ? ` key_output: ${errorLines.join("; ").slice(0, 200)}` : "";
    return `${toolName}(${status}, exit=${exitCode}${errorSummary})`;
  }

  if (toolName.includes("read") || toolName.includes("write") || toolName.includes("edit") || toolName.includes("file")) {
    const pathMatch = output.match(/(?:path|file)[:\s]*["']?([^\s"']+)/i);
    const path = pathMatch ? pathMatch[1] : "";
    return `${toolName}(${status}${path ? `, path=${path}` : ""}, ${output.length} chars)`;
  }

  if (toolName.includes("search") || toolName.includes("grep") || toolName.includes("find")) {
    const matchCount = (output.match(/\n/g) || []).length;
    return `${toolName}(${status}, ~${matchCount} matches, ${output.length} chars)`;
  }

  if (output.length <= 200) return `${toolName}(${status}): ${output}`;
  return `${toolName}(${status}, ${output.length} chars): ${output.slice(0, 150)}...`;
}

function buildHistorySummary(messages: readonly Message[], maxChars: number): string {
  if (messages.length === 0) return "";

  const scored = messages.map((message) => ({
    message,
    importance: scoreMessageImportance(message),
  }));
  scored.sort((a, b) => b.importance - a.importance);

  const highPriorityLines: string[] = [];
  const lowPriorityLines: string[] = [];

  for (const { message, importance } of scored) {
    const line = buildSmartMessageSummary(message);
    if (importance >= 4) highPriorityLines.push(line);
    else lowPriorityLines.push(line);
  }

  const sections: string[] = [];
  if (highPriorityLines.length > 0) {
    sections.push("Key context:\n" + highPriorityLines.join("\n"));
  }
  if (lowPriorityLines.length > 0) {
    sections.push("Other activity:\n" + lowPriorityLines.join("\n"));
  }

  const joined = sections.join("\n\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n- ...summary truncated...` : joined;
}

function buildSmartMessageSummary(message: Message): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    if (block.type === "text") {
      const text = block.text.replace(/\s+/g, " ").trim();
      parts.push(text.length > 400 ? `${text.slice(0, 400)}...` : text);
    } else if (block.type === "image") {
      const label = block.label ? `"${block.label}"` : "unlabeled";
      const stored = block.storage?.path ? ", stored payload available via image registry" : "";
      parts.push(`[image omitted from text compaction: ${label}, ${block.mimeType}${stored}; use load_image by id/label for visual inspection]`);
    } else if (block.type === "tool_result") {
      parts.push(extractStructuredToolResult(block));
    } else if (block.type === "tool_use") {
      const input = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
      parts.push(`${block.name}(${input.slice(0, 120)})`);
    } else if (block.type === "thinking") {
      continue;
    }
  }
  return `- ${message.role}: ${parts.join(" | ")}`;
}

function buildPureSummary(messages: readonly Message[], maxChars: number): string {
  const userLines: string[] = [];
  const assistantLines: string[] = [];
  const toolLines: string[] = [];
  const stateLines: string[] = [];

  for (const message of messages) {
    const text = sanitizeForPureState(serializeMessageForPure(message));
    if (!text) continue;
    const line = `- ${text}`;
    if (message.metadata?.compactBoundary === true) stateLines.push(line);
    else if (message.role === "user") userLines.push(line);
    else if (message.role === "assistant") assistantLines.push(line);
    else if (message.role === "tool_result") toolLines.push(line);
    else if (message.role !== "system" && message.role !== "progress" && message.role !== "tombstone") stateLines.push(`- ${message.role}: ${text}`);
  }

  const sections = [
    "Purpose: sanitized continuation state produced by /pure after a risk/WAF block; raw commands, logs, code snippets, and bulky tool output were intentionally omitted.",
    formatPureSection("Recent user goals/constraints", lastItems(userLines, 10)),
    formatPureSection("Recent assistant progress/decisions", lastItems(assistantLines, 8)),
    formatPureSection("Tool activity summary", lastItems(toolLines, 8)),
    formatPureSection("Prior compact/state facts", lastItems(stateLines, 8)),
    "Pending work: continue from the latest user request using the sanitized facts above; ask for clarification only if a required detail was removed by sanitization.",
  ].filter(Boolean).join("\n");

  return sections.length > maxChars ? `${sections.slice(0, maxChars)}\n- ...pure summary truncated...` : sections;
}

function formatPureSection(title: string, lines: readonly string[]): string {
  return lines.length > 0 ? `${title}:\n${dedupeLines(lines).join("\n")}` : `${title}: none retained.`;
}

function lastItems<T>(items: readonly T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }
  return deduped;
}

function serializeMessageForPure(message: Message): string {
  return message.blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return block.label ?? `[image ${block.mimeType}]`;
      if (block.type === "thinking") return "";
      if (block.type === "tool_use") return `tool_use ${block.name}: ${sanitizeToolPayload(block.input)}`;
      if (block.type === "tool_result") return `tool_result ${block.name}: ${block.ok ? "ok" : "error"}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeToolPayload(input: unknown): string {
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  if (!serialized) return "no input";
  return sanitizeForPureState(serialized).slice(0, 180) || "details omitted";
}

function sanitizeForPureState(text: string): string {
  const normalized = text.replace(/```[\s\S]*?```/g, "[code block omitted]");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => sanitizePureLine(line))
    .filter(Boolean);
  return dedupeLines(lines).join("; ").replace(/\s+/g, " ").trim().slice(0, 700);
}

function sanitizePureLine(line: string): string {
  let safe = line.trim();
  if (!safe) return "";
  if (/\b(python\s+-c|node\s+-e|bash\s+-c|sh\s+-c|powershell|cmd\.exe|set-location|copy-item|invoke-webrequest|curl|read_text|write_text)\b/i.test(safe)) {
    return "[omitted raw command/log detail]";
  }
  safe = safe.replace(/[A-Za-z]:[\\/][^\s"'`<>]+/g, (match) => summarizePathForPureState(match));
  safe = safe.replace(/[\\]+/g, "/");
  safe = safe.replace(/[{}<>`]/g, " ");
  safe = safe.replace(/\s+/g, " ").trim();
  return safe.length > 240 ? `${safe.slice(0, 240)}...` : safe;
}

function summarizePathForPureState(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(Math.max(0, parts.length - 3)).join("/");
  return tail ? `[path:${tail}]` : "[path]";
}

function prepareMessagesForModelSummary(messages: readonly Message[], instructions: string): Message[] {
  const history = withoutThinkingBlocks(messages)
    .filter((message) => message.role !== "progress" && message.role !== "tombstone")
    .map(normalizeMessageForModelSummary);
  const compactInstruction = {
    ...createTextMessage("user", instructions),
    isMeta: true,
    metadata: { compactInstruction: true },
  };
  return [...history, compactInstruction];
}

function normalizeMessageForModelSummary(message: Message): Message {
  let changed = false;
  const blocks = message.blocks.map((block): MessageBlock => {
    if (block.type === "image") {
      changed = true;
      const storage = block.storage?.path ? `; stored payload=${block.storage.path}` : "";
      return {
        type: "text",
        text: `[Historical image: ${block.label ?? "unlabeled"}, ${block.mimeType}${storage}. Pixels are omitted from compaction input; preserve the image reference if it may still matter.]`,
      };
    }
    if (block.type === "tool_result") {
      const output = serializeToolOutput(block.output);
      const normalizedOutput = summarizeToolResultForModelSummary(output);
      if (normalizedOutput !== output) {
        changed = true;
        return { ...block, output: normalizedOutput };
      }
    }
    return { ...block };
  });
  return changed
    ? { ...message, blocks, metadata: { ...message.metadata, compactInputNormalized: true } }
    : { ...message, blocks };
}

function summarizeToolResultForModelSummary(output: string): string {
  const maxChars = 12_000;
  if (output.length <= maxChars) return output;
  const edgeChars = Math.floor((maxChars - 160) / 2);
  return [
    `[Tool result normalized for compaction: ${output.length} chars total]`,
    "Head:",
    output.slice(0, edgeChars),
    "Tail:",
    output.slice(-edgeChars),
  ].join("\n");
}

function serializeMessage(message: Message): string {
  return message.blocks.map(serializeBlock).join("\n");
}

function serializeBlock(block: MessageBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") {
    const estimatedBytes = Math.floor(resolveImageBlockDataLengthSync(block) * 0.75);
    const tiles = Math.max(1, Math.ceil(estimatedBytes / 200_000));
    const estimatedTokenEquivalentChars = tiles * 85 * 4;
    return `[image ${block.label ?? "unlabeled"} ${block.mimeType}; estimated visual token chars=${estimatedTokenEquivalentChars}; pixels are not text-summarized]`;
  }
  if (block.type === "thinking") return "";
  if (block.type === "tool_use") return `tool_use ${block.name}: ${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return `tool_result ${block.name}: ${serializeToolOutput(block.output)}`;
  return "";
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function collectToolResultIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_result") ids.push(block.toolUseId);
    }
  }
  return ids;
}

function extractText(message: Message): string {
  return message.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function defaultRecentTokenBudget(contextWindowTokens: number | undefined): number | undefined {
  if (!contextWindowTokens) return undefined;
  return Math.max(4_000, Math.min(20_000, Math.floor(contextWindowTokens * 0.15)));
}

const CHECKPOINT_COMPACT_INSTRUCTIONS = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task without access to the earlier transcript.",
  "Include the current goal, progress, and key decisions; important context, constraints, and user preferences; completed work and validation status; what remains to be done with clear next steps; and any critical files, paths, identifiers, commands, data, examples, or references needed to continue.",
  "Use task continuity and current relevance to decide what to preserve. Report tool activity through durable findings and current consequences, not as a chronological call log. Include errors only when they remain relevant as blockers, risks, unresolved failures, or important lessons.",
  "Treat any earlier compaction summary as prior handoff state. Merge it with later developments, preserve still-valid constraints, and replace stale or superseded status with the newest known state instead of repeating both.",
  "Be concise, structured, and specific enough for the next LLM to continue immediately. Use the conversation's primary language when practical. Do not invent facts, do not continue the task, and do not write a user-facing final answer.",
].join("\n");
