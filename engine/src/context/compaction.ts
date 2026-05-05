import { createTextMessage, type Message } from "../types/messages";

export interface ContextBudgetOptions {
  snipMaxChars?: number;
  microCompactMaxChars?: number;
  autoCompactMaxChars?: number;
  keepRecentMessages?: number;
  summaryMaxChars?: number;
}

export interface CompactionResult {
  messages: Message[];
  summary?: string;
  changed: boolean;
  reason?: "none" | "snip" | "microcompact" | "autocompact" | "reactive_compact";
  tokensFreed?: number;
}

export interface Compactor {
  compact(messages: readonly Message[], options?: ContextBudgetOptions): Promise<CompactionResult>;
  reactiveCompact?(messages: readonly Message[], error: Error, options?: ContextBudgetOptions): Promise<CompactionResult>;
}

export class DeterministicCompactor implements Compactor {
  async compact(messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const snipped = snipCompactIfNeeded(messages, options);
    const micro = microCompactIfNeeded(snipped.messages, options);
    const auto = autoCompactIfNeeded(micro.messages, options);

    if (auto.changed) return mergeResults([snipped, micro, auto], auto.reason);
    if (micro.changed) return mergeResults([snipped, micro], micro.reason);
    if (snipped.changed) return snipped;
    return { messages: [...messages], changed: false, reason: "none" };
  }

  async reactiveCompact(messages: readonly Message[], error: Error, options: ContextBudgetOptions = {}): Promise<CompactionResult> {
    const keepRecentMessages = options.keepRecentMessages ?? 8;
    const recent = messages.slice(-keepRecentMessages);
    const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));
    const summary = buildHistorySummary(older, options.summaryMaxChars ?? 6000);
    const boundary = createCompactionBoundaryMessage(
      `Reactive compact after model context error: ${error.message}\n\n${summary || "No older messages were available to summarize."}`,
      "reactive_compact",
    );
    return {
      messages: [boundary, ...recent],
      summary,
      changed: true,
      reason: "reactive_compact",
      tokensFreed: Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars([boundary, ...recent])),
    };
  }
}

export class NoopCompactor implements Compactor {
  async compact(messages: readonly Message[]): Promise<CompactionResult> {
    return { messages: [...messages], changed: false, reason: "none" };
  }
}

export function estimateMessagesChars(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + serializeMessage(message).length, 0);
}

export function snipCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions = {}): CompactionResult {
  const maxChars = options.snipMaxChars ?? 60000;
  if (estimateMessagesChars(messages) <= maxChars) return { messages: [...messages], changed: false, reason: "none" };

  const keepRecentMessages = options.keepRecentMessages ?? 10;
  const head = messages.slice(0, 1);
  const tail = messages.slice(-keepRecentMessages);
  const removed = messages.slice(head.length, Math.max(head.length, messages.length - keepRecentMessages));
  const summary = buildHistorySummary(removed, options.summaryMaxChars ?? 3000);
  const boundary = createCompactionBoundaryMessage(`Snipped older conversation for context budget.\n\n${summary}`, "snip");
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
  const maxChars = options.microCompactMaxChars ?? 45000;
  if (estimateMessagesChars(messages) <= maxChars) return { messages: [...messages], changed: false, reason: "none" };

  const compacted = messages.map((message, index) => {
    if (index >= messages.length - (options.keepRecentMessages ?? 8)) return message;
    const text = serializeMessage(message);
    if (text.length <= 2000) return message;
    return {
      ...message,
      blocks: [{ type: "text" as const, text: `${message.role} message compacted (${text.length} chars): ${text.slice(0, 1600)}` }],
      metadata: { ...message.metadata, microCompacted: true, originalLength: text.length },
    };
  });

  return {
    messages: compacted,
    changed: true,
    reason: "microcompact",
    tokensFreed: Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars(compacted)),
  };
}

export function autoCompactIfNeeded(messages: readonly Message[], options: ContextBudgetOptions = {}): CompactionResult {
  const maxChars = options.autoCompactMaxChars ?? 36000;
  if (estimateMessagesChars(messages) <= maxChars) return { messages: [...messages], changed: false, reason: "none" };

  const keepRecentMessages = options.keepRecentMessages ?? 8;
  const recent = messages.slice(-keepRecentMessages);
  const older = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));
  const summary = buildHistorySummary(older, options.summaryMaxChars ?? 5000);
  const boundary = createCompactionBoundaryMessage(`Auto compacted earlier conversation.\n\n${summary}`, "autocompact");
  const compacted = [boundary, ...recent];

  return {
    messages: compacted,
    summary,
    changed: true,
    reason: "autocompact",
    tokensFreed: Math.max(0, estimateMessagesChars(messages) - estimateMessagesChars(compacted)),
  };
}

function mergeResults(results: readonly CompactionResult[], reason: CompactionResult["reason"]): CompactionResult {
  const last = results[results.length - 1];
  return {
    messages: last.messages,
    summary: results.map((result) => result.summary).filter(Boolean).join("\n\n") || undefined,
    changed: results.some((result) => result.changed),
    reason,
    tokensFreed: results.reduce((total, result) => total + (result.tokensFreed ?? 0), 0),
  };
}

function createCompactionBoundaryMessage(summary: string, reason: string): Message {
  return {
    ...createTextMessage("user", `Conversation summary (${reason}):\n${summary}`),
    metadata: { compactBoundary: true, compactionReason: reason },
  };
}

function buildHistorySummary(messages: readonly Message[], maxChars: number): string {
  if (messages.length === 0) return "";
  const lines = messages.map((message) => {
    const text = serializeMessage(message).replace(/\s+/g, " ").trim();
    return `- ${message.role}: ${text.slice(0, 500)}`;
  });
  const joined = lines.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n- ...summary truncated...` : joined;
}

function serializeMessage(message: Message): string {
  return message.blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `tool_use ${block.name}: ${JSON.stringify(block.input)}`;
      return `tool_result ${block.name}: ${typeof block.output === "string" ? block.output : JSON.stringify(block.output)}`;
    })
    .join("\n");
}
