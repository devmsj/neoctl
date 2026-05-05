import type { Message } from "../types/messages";

const STREAM_HOLD_BACK_CHARS = 64;

export class AssistantOutputFilter {
  private buffer = "";
  private emittedLength = 0;
  private redacted = false;

  push(delta: string): string {
    if (!delta || this.redacted) return "";
    this.buffer += delta;

    const leakStart = findReasoningLeakStart(this.buffer);
    if (leakStart >= 0) {
      const safe = this.buffer.slice(this.emittedLength, leakStart);
      this.emittedLength = leakStart;
      this.redacted = true;
      return safe;
    }

    const safeEnd = Math.max(0, this.buffer.length - STREAM_HOLD_BACK_CHARS);
    if (safeEnd <= this.emittedLength) return "";

    const safe = this.buffer.slice(this.emittedLength, safeEnd);
    this.emittedLength = safeEnd;
    return safe;
  }

  sanitizeMessage(message: Message): Message {
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== "text") return block;
      const text = stripLeakedReasoningText(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });

    return changed ? { ...message, blocks, metadata: { ...message.metadata, outputSanitized: true } } : message;
  }
}

export function stripLeakedReasoningText(text: string): string {
  const leakStart = findReasoningLeakStart(text);
  if (leakStart < 0) return text;
  return text.slice(0, leakStart).trimEnd();
}

function findReasoningLeakStart(text: string): number {
  const candidates = [
    /\bWe need\b/i,
    /\bNeed (?:answer|respond|final|maybe|check|mention|say)\b/i,
    /\bFinal maybe\b/i,
    /\bThe transcript shows\b/i,
    /\bOur final\b/i,
    /\bUser asked\b/i,
    /\bNeed answer\b/i,
    /\bI should\b/i,
  ];

  let earliest = -1;
  for (const pattern of candidates) {
    const match = pattern.exec(text);
    if (!match || !isLikelyReasoningLeak(text, match.index)) continue;
    earliest = earliest < 0 ? match.index : Math.min(earliest, match.index);
  }
  return earliest;
}

function isLikelyReasoningLeak(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  if (prefix.trim().length < 12) return false;
  if (/[\u4e00-\u9fff]/.test(prefix)) return true;
  if (/[`*_-]\s*$/.test(prefix)) return true;
  if (/[。！？.!?]\s*$/.test(prefix)) return true;
  if (/\n\s*(?:[-*]|\d+\.)\s+/.test(prefix)) return true;
  return prefix.trim().length >= 80;
}
