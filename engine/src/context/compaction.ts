import type { ModelGateway } from "../model/model-gateway.js";
import { createTextMessage, type Message, type MessageBlock } from "../types/messages.js";

export interface ContextBudgetOptions {
  snipMaxChars?: number;
  microCompactMaxChars?: number;
  autoCompactMaxChars?: number;
  estimatedInputTokens?: number;
  contextWindowTokens?: number;
  autoCompactTriggerRatio?: number;
  microCompactTriggerRatio?: number;
  snipCompactTriggerRatio?: number;
  keepRecentMessages?: number;
  keepRecentToolResults?: number;
  summaryMaxChars?: number;
  compactModel?: string;
  compactMaxOutputTokens?: number;
}

export type CompactionReason = "none" | "snip" | "microcompact" | "autocompact" | "reactive_compact" | "manualcompact" | "purecompact";

export interface CompactionResult {
  messages: Message[];
  summary?: string;
  changed: boolean;
  reason?: CompactionReason;
  tokensFreed?: number;
}

export interface Compactor {
  compact(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  manualCompact?(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  pureCompact?(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  reactiveCompact?(messages: readonly Message[], error: Error, options?: ContextBudgetOptions): Promise<CompactionResult>;
}

export const CLEARED_TOOL_RESULT_CONTENT = "[Old tool result content cleared]";

export class DeterministicCompactor implements Compactor {
  async compact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const micro = microCompactIfNeeded(messages, options);
    const auto = autoCompactIfNeeded(micro.messages, options);
    const snipped = snipCompactIfNeeded(auto.messages, options);

    if (snipped.changed) return mergeResults([micro, auto, snipped], snipped.reason);
    if (auto.changed) return mergeResults([micro, auto], auto.reason);
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
    const reactive = reactiveCompactWithSummary(micro.messages, `Reactive compact after model context error: ${error.message}`, options);
    return micro.changed ? mergeResults([micro, reactive], reactive.reason) : reactive;
  }
}

export class ModelDrivenCompactor implements Compactor {
  private readonly fallback = new DeterministicCompactor();

  constructor(private readonly modelGateway: ModelGateway) {}

  async compact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const micro = microCompactIfNeeded(messages, options);
    const auto = await this.modelAutoCompactIfNeeded(micro.messages, options);
    const snipped = snipCompactIfNeeded(auto.messages, options);

    if (snipped.changed) return mergeResults([micro, auto, snipped], snipped.reason);
    if (auto.changed) return mergeResults([micro, auto], auto.reason);
    if (micro.changed) return micro;
    return { messages: [...messages], changed: false, reason: "none" };
  }

  async manualCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const keepRecentMessages = options.keepRecentMessages ?? 8;
    const recent = messages.slice(-keepRecentMessages);
    const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));
    if (older.length === 0) return { messages: [...messages], changed: false, reason: "none" };

    try {
      const summary = await this.summarizeWithModel(older, MANUAL_COMPACT_INSTRUCTIONS, options);
      return buildCompactionResult(messages, recent, summary, "manualcompact", true);
    } catch {
      return this.fallback.manualCompact?.(messages, options) ?? manualCompactWithSummary(messages, options);
    }
  }

  async pureCompact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    return pureCompactWithSanitizedSummary(messages, options);
  }

  async reactiveCompact(messages: readonly Message[], error: Error, options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const micro = microCompactIfNeeded(messages, options);
    const keepRecentMessages = options.keepRecentMessages ?? 8;
    const recent = micro.messages.slice(-keepRecentMessages);
    const older = micro.messages.slice(0, Math.max(0, micro.messages.length - keepRecentMessages));
    try {
      const summary = await this.summarizeWithModel(older, buildReactiveCompactInstruction(error), options);
      const reactive = buildCompactionResult(micro.messages, recent, summary, "reactive_compact", true);
      return micro.changed ? mergeResults([micro, reactive], reactive.reason) : reactive;
    } catch {
      const fallback = await this.fallback.reactiveCompact(micro.messages, error, options);
      return micro.changed ? mergeResults([micro, fallback], fallback.reason) : fallback;
    }
  }

  private async modelAutoCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions): Promise<CompactionResult> {
    if (!shouldCompactForBudget(messages, options, options.autoCompactMaxChars ?? 50000)) {
      return { messages: [...messages], changed: false, reason: "none" };
    }

    const maxChars = options.autoCompactMaxChars ?? 50000;

    const keepRecentMessages = options.keepRecentMessages ?? 8;
    const recent = messages.slice(-keepRecentMessages);
    const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));

    try {
      const summary = await this.summarizeWithModel(older, AUTO_COMPACT_INSTRUCTIONS, options);
      return buildCompactionResult(messages, recent, summary, "autocompact", true);
    } catch {
      return autoCompactIfNeeded(messages, options);
    }
  }

  private async summarizeWithModel(
    messages: readonly Message[],
    instructions: string,
    options: ContextBudgetOptions,
  ): Promise<string> {
    const transcript = serializeTranscriptForSummary(messages, options.summaryMaxChars ?? 12000);
    if (!transcript.trim()) return "No earlier conversation content required preservation.";

    let text = "";
    for await (const event of this.modelGateway.stream({
      model: options.compactModel,
      instructions,
      messages: [createTextMessage("user", transcript)],
      tools: [],
      stream: true,
      maxOutputTokens: options.compactMaxOutputTokens ?? 2500,
      queryOrigin: "compact",
      providerOptions: {
        compact: true,
      },
    })) {
      if (event.type === "assistant_delta") text += event.text;
      if (event.type === "assistant_message") text += extractText(event.message);
      if (event.type === "error") throw event.error;
    }

    const summary = text.trim();
    if (!summary) throw new Error("Model compaction produced an empty summary");
    return summary.length > (options.summaryMaxChars ?? 6000)
      ? `${summary.slice(0, options.summaryMaxChars ?? 6000)}\n- ...model summary truncated...`
      : summary;
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

export function estimateMessagesChars(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + serializeMessage(message).length, 0);
}

export function snipCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions = {}): CompactionResult {
  const maxChars = options.snipMaxChars ?? 90000;
  const triggerRatio = options.snipCompactTriggerRatio ?? 0.98;
  if (!shouldCompactForBudget(messages, options, maxChars, triggerRatio)) return { messages: [...messages], changed: false, reason: "none" };

  const keepRecentMessages = options.keepRecentMessages ?? 6;
  const head = messages.slice(0, 1).filter((message) => !message.metadata?.compactBoundary);
  const tailStart = Math.max(head.length, messages.length - keepRecentMessages);
  const tail = messages.slice(tailStart);
  const removed = messages.slice(head.length, tailStart);
  const summary = buildHistorySummary(removed, options.summaryMaxChars ?? 3000);
  const boundary = createCompactionBoundaryMessage(`Snipped older conversation for context budget.\n\n${summary}`, "snip", false);
  const compacted = [...head, boundary, ...tail];

  return {
    messages: compacted,
    summary,
    changed: true,
    reason: "snip",
    tokensFreed: Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars(compacted)),
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

  return {
    messages: compacted,
    summary: `Cleared ${cleared} older tool result content block(s); kept the latest ${keepRecentToolResults}.`,
    changed: true,
    reason: "microcompact",
    tokensFreed: Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars(compacted)),
  };
}

export function autoCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions = {}): CompactionResult {
  const maxChars = options.autoCompactMaxChars ?? 50000;
  if (!shouldCompactForBudget(messages, options, maxChars)) return { messages: [...messages], changed: false, reason: "none" };

  const keepRecentMessages = options.keepRecentMessages ?? 8;
  const recent = messages.slice(-keepRecentMessages);
  const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));
  const summary = buildHistorySummary(older, options.summaryMaxChars ?? 5000);
  return buildCompactionResult(messages, recent, summary, "autocompact", false);
}

function shouldCompactForBudget(messages: readonly Message[], options: ContextBudgetOptions, fallbackMaxChars: number, triggerRatioOverride?: number): boolean {
  if (options.contextWindowTokens && options.estimatedInputTokens !== undefined) {
    const triggerRatio = triggerRatioOverride ?? options.autoCompactTriggerRatio ?? 0.92;
    return options.estimatedInputTokens / options.contextWindowTokens >= triggerRatio;
  }
  return estimateMessagesChars(messages) > fallbackMaxChars;
}

function manualCompactWithSummary(messages: readonly Message[], options: ContextBudgetOptions): CompactionResult {
  const keepRecentMessages = options.keepRecentMessages ?? 8;
  const recent = messages.slice(-keepRecentMessages);
  const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));
  if (older.length === 0) return { messages: [...messages], changed: false, reason: "none" };

  const summary = buildHistorySummary(older, options.summaryMaxChars ?? 6000);
  return buildCompactionResult(
    messages,
    recent,
    summary || "No older messages were available to summarize.",
    "manualcompact",
    false,
  );
}

function reactiveCompactWithSummary(
  messages: readonly Message[],
  heading: string,
  options: ContextBudgetOptions,
): CompactionResult {
  const keepRecentMessages = options.keepRecentMessages ?? 8;
  const recent = messages.slice(-keepRecentMessages);
  const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));
  const summary = buildHistorySummary(older, options.summaryMaxChars ?? 6000);
  return buildCompactionResult(
    messages,
    recent,
    `${heading}\n\n${summary || "No older messages were available to summarize."}`,
    "reactive_compact",
    false,
  );
}

function pureCompactWithSanitizedSummary(messages: readonly Message[], options: ContextBudgetOptions): CompactionResult {
  if (messages.length === 0) return { messages: [], changed: false, reason: "none" };

  const summary = buildPureSummary(messages, options.summaryMaxChars ?? 4000);
  const boundary = createCompactionBoundaryMessage(
    `Pure compacted conversation after a transport/WAF risk block.\n\n${summary}`,
    "purecompact",
    false,
  );

  return {
    messages: [boundary],
    summary,
    changed: true,
    reason: "purecompact",
    tokensFreed: Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars([boundary])),
  };
}

function buildCompactionResult(
  originalMessages: readonly Message[],
  recentMessages: readonly Message[],
  summary: string,
  reason: "autocompact" | "reactive_compact" | "manualcompact",
  modelDriven: boolean,
): CompactionResult {
  const label = reason === "autocompact"
    ? "Auto compacted earlier conversation."
    : reason === "manualcompact"
      ? "Manually compacted earlier conversation."
      : "Reactive compacted earlier conversation.";
  const boundary = createCompactionBoundaryMessage(`${label}\n\n${summary}`, reason, modelDriven);
  const compacted = [boundary, ...recentMessages];
  return {
    messages: compacted,
    summary,
    changed: true,
    reason,
    tokensFreed: Math.max(0, estimateMessagesChars(originalMessages) - estimateMessagesChars(compacted)),
  };
}

function mergeResults(results: readonly CompactionResult[], reason: CompactionReason | undefined): CompactionResult {
  const changedResults = results.filter((result) => result.changed);
  const last = changedResults[changedResults.length - 1] ?? results[results.length - 1];
  return {
    messages: last.messages,
    summary: changedResults.map((result) => result.summary).filter(Boolean).join("\n\n") || undefined,
    changed: changedResults.length > 0,
    reason,
    tokensFreed: changedResults.reduce((total, result) => total + (result.tokensFreed ?? 0), 0),
  };
}

function createCompactionBoundaryMessage(summary: string, reason: string, modelDriven: boolean): Message {
  return {
    ...createTextMessage("system", renderInternalContinuationState(summary, reason)),
    isMeta: true,
    metadata: { compactBoundary: true, compactionReason: reason, modelDriven },
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

function normalizeSummaryForInternalState(summary: string): string {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, ""))
    .join("\n")
    .trim();
}

function buildHistorySummary(messages: readonly Message[], maxChars: number): string {
  if (messages.length === 0) return "";
  const lines = messages.map((message) => {
    const text = serializeMessageForSummary(message).replace(/\s+/g, " ").trim();
    return `- ${message.role}: ${text.slice(0, 500)}`;
  });
  const joined = lines.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n- ...summary truncated...` : joined;
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
      if (block.type === "thinking") return "[assistant thinking omitted]";
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

function serializeTranscriptForSummary(messages: readonly Message[], maxChars: number): string {
  const lines = messages.map((message) => {
    const metadata = [
      message.providerMessageId ? `provider=${message.providerMessageId}` : undefined,
      message.requestId ? `request=${message.requestId}` : undefined,
      message.isMeta ? "meta" : undefined,
    ].filter(Boolean).join(" ");
    return `<message role="${message.role}"${metadata ? ` ${metadata}` : ""}>\n${serializeMessageForSummary(message)}\n</message>`;
  });
  const joined = lines.join("\n\n");
  return joined.length > maxChars ? joined.slice(Math.max(0, joined.length - maxChars)) : joined;
}

function serializeMessage(message: Message): string {
  return message.blocks.map(serializeBlock).join("\n");
}

function serializeMessageForSummary(message: Message): string {
  if (message.metadata?.compactBoundary === true) return extractText(message) || "[compact boundary]";
  return message.blocks
    .map((block) => {
      if (block.type !== "tool_result") return serializeBlock(block);
      const output = serializeToolOutput(block.output);
      if (output === CLEARED_TOOL_RESULT_CONTENT) return `tool_result ${block.name}: ${CLEARED_TOOL_RESULT_CONTENT}`;
      return `tool_result ${block.name}: ${summarizeToolOutput(output)}`;
    })
    .join("\n");
}

function serializeBlock(block: MessageBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return block.label ?? `[image ${block.mimeType}]`;
  if (block.type === "thinking") return `thinking: ${block.text}`;
  if (block.type === "tool_use") return `tool_use ${block.name}: ${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return `tool_result ${block.name}: ${serializeToolOutput(block.output)}`;
  return "";
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function summarizeToolOutput(output: string): string {
  if (output.length <= 800) return output;
  return `[large tool result: ${output.length} chars, head: ${output.slice(0, 400)}]`;
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

function buildReactiveCompactInstruction(error: Error): string {
  return `${AUTO_COMPACT_INSTRUCTIONS}\n\nThe previous model request failed because the prompt was too long. Preserve enough task state to continue after this error. Error: ${error.message}`;
}

const MANUAL_COMPACT_INSTRUCTIONS = [
  "Summarize the earlier agent conversation for continuation after a user-requested context compaction.",
  "Preserve: user goals and constraints, decisions made, files or commands mentioned, completed work, pending work, task ids, important tool results, and any errors or blockers.",
  "Drop: repetitive logs, transient progress chatter, and irrelevant wording.",
  "Return concise plain text labels, not Markdown headings. Use labels like Goal:, Constraints:, Work completed:, Important facts:, Pending work:, Open risks:.",
  "Do not include final-answer prose; this summary is an internal continuation state only.",
].join("\n");

const AUTO_COMPACT_INSTRUCTIONS = [
  "Summarize the earlier agent conversation for continuation after context compaction.",
  "Preserve: user goals and constraints, decisions made, files or commands mentioned, completed work, pending work, task ids, important tool results, and any errors or blockers.",
  "Drop: repetitive logs, transient progress chatter, and irrelevant wording.",
  "Return concise plain text labels, not Markdown headings. Use labels like Goal:, Constraints:, Work completed:, Important facts:, Pending work:, Open risks:.",
  "Do not include final-answer prose; this summary is an internal continuation state only.",
].join("\n");
