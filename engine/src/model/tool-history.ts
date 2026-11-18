import type { Message, MessageBlock } from "../types/messages.js";

/** Quote unrepresentable calls and their results; never mutate audit history or retry tools. */
export function projectToolHistory(messages: readonly Message[]): readonly Message[] {
  const invalid = new Set(messages.flatMap(m => m.blocks.flatMap(b =>
    b.type === "tool_use" && (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) ? [b.id] : [])));
  if (!invalid.size) return messages;
  const results = new Map<string, string[]>();
  for (const m of messages) for (const b of m.blocks) if (b.type === "tool_result" && invalid.has(b.toolUseId)) {
    const output = typeof b.output === "string" ? b.output : JSON.stringify(b.output) ?? "null";
    results.set(b.toolUseId, [...results.get(b.toolUseId) ?? [], `[Historical tool result ${b.toolUseId}; recorded status: ${b.ok ? "success" : "failure"}]\n${output}`]);
  }
  return messages.flatMap(message => {
    let changed = false;
    const blocks = message.blocks.flatMap((b): MessageBlock[] => {
      if (b.type === "tool_use" && invalid.has(b.id)) {
        changed = true;
        // Keep the quoted pair together; a synthetic user turn between parallel
        // valid calls and their results would itself violate OpenAI tool ordering.
        return [{ type: "text", text: [`[Historical tool call ${b.id} (${b.name}); non-object arguments, quoted only, do not re-execute]\n${JSON.stringify(b.input) ?? "undefined"}`, ...results.get(b.id) ?? []].join("\n") }];
      }
      if (b.type === "tool_result" && invalid.has(b.toolUseId)) { changed = true; return []; }
      return [b];
    });
    return !changed ? [message] : blocks.length ? [{ ...message, blocks }] : [];
  });
}
