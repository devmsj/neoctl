import type { AgentEvent } from "../types/events";

export function renderEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "state":
      return `[${event.phase}]${event.detail ? ` ${event.detail}` : ""}`;
    case "assistant.delta":
      return event.text;
    case "message":
      return event.message.blocks
        .map((block) => {
          if (block.type === "text") return `${event.message.role}> ${block.text}`;
          if (block.type === "tool_result") return `tool_result:${block.name}> ${JSON.stringify(block.output)}`;
          return `tool_use:${block.name}> ${JSON.stringify(block.input)}`;
        })
        .join("\n");
    case "tool.started":
      return `tool started: ${event.toolUse.name}`;
    case "tool.finished":
      return `tool finished: ${event.toolUse.name} (${event.ok ? "ok" : "failed"})`;
    case "error":
      return `error: ${event.error.message}`;
  }
}
