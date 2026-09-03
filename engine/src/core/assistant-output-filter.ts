import type { Message } from "../types/messages.js";

const REASONING_LEAK_MARKERS = [
  "We need",
  "Need answer",
  "Need respond",
  "Need final",
  "Need maybe",
  "Need check",
  "Need mention",
  "Need say",
  "Final maybe",
  "The transcript shows",
  "Our final",
  "User asked",
  "I should",
] as const;

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

    // Only retain a suffix that could become one of the leak markers when the
    // provider's next chunk arrives. A fixed-size hold-back makes ordinary text
    // appear frozen during model pauses and releases it only at a later tool or
    // final-message boundary.
    const safeEnd = this.buffer.length - reasoningLeakPrefixSuffixLength(this.buffer);
    if (safeEnd <= this.emittedLength) return "";

    const safe = this.buffer.slice(this.emittedLength, safeEnd);
    this.emittedLength = safeEnd;
    return safe;
  }

  flush(): string {
    if (this.redacted || this.emittedLength >= this.buffer.length) return "";
    const leakStart = findReasoningLeakStart(this.buffer);
    const safeEnd = leakStart >= 0 ? leakStart : this.buffer.length;
    const safe = this.buffer.slice(this.emittedLength, safeEnd);
    this.emittedLength = safeEnd;
    if (leakStart >= 0) this.redacted = true;
    return safe;
  }

  sanitizeMessage(message: Message): Message {
    let changed = false;
    let hasFinalText = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== "text") return block;
      hasFinalText = true;
      const text = stripLeakedReasoningText(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });

    // A provider-finalized text block is authoritative and replaces the streamed
    // line in consumers. Mark the hold-back buffer consumed so flush() cannot
    // emit its tail a second time. Tool-only assistant messages deliberately do
    // not consume it: their preceding streamed text still needs to be released.
    if (hasFinalText) this.emittedLength = this.buffer.length;

    return changed ? { ...message, blocks, metadata: { ...message.metadata, outputSanitized: true } } : message;
  }
}

export function stripLeakedReasoningText(text: string): string {
  const leakStart = findReasoningLeakStart(text);
  if (leakStart < 0) return text;
  return text.slice(0, leakStart).trimEnd();
}

function reasoningLeakPrefixSuffixLength(text: string): number {
  const lowerText = text.toLocaleLowerCase("en-US");
  let longest = 0;
  for (const marker of REASONING_LEAK_MARKERS) {
    const lowerMarker = marker.toLocaleLowerCase("en-US");
    const maxLength = Math.min(lowerText.length, lowerMarker.length - 1);
    for (let length = maxLength; length > longest; length -= 1) {
      if (lowerText.endsWith(lowerMarker.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
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
