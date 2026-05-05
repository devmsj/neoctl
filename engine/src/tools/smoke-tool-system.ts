import { InMemoryAppState } from "../app/app-state";
import type { Message } from "../types/messages";
import { echoTool } from "./builtins/echo-tool";
import { ToolRegistry } from "./registry";
import { runToolUseToMessages } from "./run-tool-use";
import { runTools } from "./tool-orchestration";
import type { Tool, ToolUseContext } from "./tool";

const delayTool: Tool<{ id: string; delayMs: number }> = {
  name: "delay",
  description: "Wait briefly and return an id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, delayMs: { type: "integer" } },
    required: ["id", "delayMs"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input) {
    return input as { id: string; delayMs: number };
  },
  async call(input) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    return { ok: true, output: input.id };
  },
};

const largeTool: Tool<{ size: number }> = {
  name: "large",
  description: "Return a large string for truncation tests.",
  inputSchema: {
    type: "object",
    properties: { size: { type: "integer" } },
    required: ["size"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true, maxResultSizeChars: 8 },
  validate(input) {
    return input as { size: number };
  },
  async call(input) {
    return { ok: true, output: "x".repeat(input.size) };
  },
};

async function main(): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(delayTool);
  registry.register(largeTool);

  const context: ToolUseContext = {
    agentId: "tool-smoke",
    tools: registry,
    appState: new InMemoryAppState("tool-smoke"),
    emit: () => undefined,
  };

  const valid = await runToolUseToMessages({ id: "echo1", name: "say", input: { text: "ok" } }, context);
  const invalid = await runToolUseToMessages({ id: "echo2", name: "echo", input: { text: "" } }, context);
  const unknown = await runToolUseToMessages({ id: "missing", name: "missing", input: {} }, context);
  const large = await runToolUseToMessages({ id: "large", name: "large", input: { size: 20 } }, context);
  const started = Date.now();
  const batch = await runTools(
    [
      { id: "d1", name: "delay", input: { id: "a", delayMs: 60 } },
      { id: "d2", name: "delay", input: { id: "b", delayMs: 60 } },
    ],
    context,
  );
  const elapsedMs = Date.now() - started;

  const ok =
    toolOk(valid[valid.length - 1]) &&
    !toolOk(invalid[invalid.length - 1]) &&
    !toolOk(unknown[0]) &&
    JSON.stringify(large[large.length - 1]).includes("truncated") &&
    batch.messages.length === 4 &&
    elapsedMs < 110;

  console.log(JSON.stringify({ ok, elapsedMs, counts: { valid: valid.length, invalid: invalid.length, unknown: unknown.length, large: large.length, batch: batch.messages.length } }, null, 2));
  if (!ok) process.exitCode = 1;
}

function toolOk(message: Message): boolean {
  return message.blocks.every((block) => block.type !== "tool_result" || block.ok);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
