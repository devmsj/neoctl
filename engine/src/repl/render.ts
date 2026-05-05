import type { AgentEvent } from "../types/events.js";

export function renderEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "state":
      return `[${event.phase}]${event.detail ? ` ${event.detail}` : ""}`;
    case "context.metrics":
      return undefined;
    case "assistant.delta":
      return event.text;
    case "message":
      return event.message.blocks
        .map((block) => {
          const prefix = event.message.isMeta ? `meta:${event.message.role}` : event.message.role;
          if (block.type === "text") return `${prefix}> ${block.text}`;
          if (block.type === "thinking") return `thinking> ${block.text}`;
          if (block.type === "tool_result") return `tool_result:${block.name}> ${JSON.stringify(block.output)}`;
          return `tool_use:${block.name}> ${JSON.stringify(block.input)}`;
        })
        .join("\n");
    case "tool.started":
      return `tool started: ${event.toolUse.name}`;
    case "tool.finished":
      return `tool finished: ${event.toolUse.name} (${event.ok ? "ok" : "failed"})`;
    case "usage":
      return undefined;
    case "retrying":
      return `retrying model request: attempt ${event.attempt}, delay ${event.delayMs}ms, ${event.error.message}`;
    case "terminal":
      return `[stopped] ${event.reason}${event.detail ? `: ${event.detail}` : ""}`;
    case "error":
      return `error: ${event.error.message}`;
  }
}
