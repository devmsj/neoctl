import type { ModelStreamEvent } from "./model-gateway.js";

/** Normalize provider boundaries and defend against compatible streams omitting them.
 * Wrap outside cancellation races too: EOF/abort/errors must stop the UI immediately.
 */
export async function* withThinkingLifecycle(source: AsyncIterable<ModelStreamEvent>): AsyncGenerator<ModelStreamEvent> {
  let active = false;
  try {
    for await (const event of source) {
      if (event.type === "thinking_delta") {
        if (!event.text) continue;
        active = true;
      } else if (event.type === "thinking_done") {
        if (!active) continue;
        active = false;
      } else if (active && endsThinking(event)) {
        active = false;
        yield { type: "thinking_done" };
      }
      yield event;
    }
  } catch (error) {
    if (active) { active = false; yield { type: "thinking_done" }; }
    throw error;
  }
  if (active) yield { type: "thinking_done" };
}

function endsThinking(event: ModelStreamEvent): boolean {
  return (event.type === "assistant_delta" && !!event.text)
    || event.type === "assistant_text_done"
    || event.type === "assistant_message"
    || event.type === "tool_call_started" || event.type === "tool_call_delta" || event.type === "tool_use"
    || event.type === "response_completed" || event.type === "response_incomplete"
    || event.type === "error" || event.type === "retrying" || event.type === "retry";
}
