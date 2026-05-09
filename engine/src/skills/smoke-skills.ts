import { InMemoryAppState } from "../app/app-state.js";
import { ToolRegistry } from "../tools/registry.js";
import { runToolUse } from "../tools/run-tool-use.js";
import type { ToolUseContext } from "../tools/tool.js";
import { createSkillTool, InMemorySkillCatalog } from "./skill-tool.js";

async function main(): Promise<void> {
  const catalog = new InMemorySkillCatalog([
    {
      name: "review-plan",
      description: "Review a plan before implementation.",
      entrypoint: "Review the supplied plan for correctness and missing validation.",
      execution: "inline",
      allowedTools: ["plan"],
      model: "gpt-5.5",
      effort: "high",
    },
    {
      name: "fork-docs",
      description: "Long-running docs workflow.",
      entrypoint: "Analyze docs independently.",
      execution: "fork",
    },
  ]);
  const tools = new ToolRegistry();
  tools.register(createSkillTool(catalog));
  const context: ToolUseContext = {
    agentId: "main",
    tools,
    appState: new InMemoryAppState("main"),
    emit: () => undefined,
  };

  const inline = await runToolUse({
    id: "skill_inline",
    name: "skill",
    input: { skill: "/review-plan", args: "Plan A" },
  }, context);
  const fork = await runToolUse({
    id: "skill_fork",
    name: "skill",
    input: { name: "fork-docs" },
  }, context);
  const missing = await runToolUse({
    id: "skill_missing",
    name: "skill",
    input: { skill: "missing" },
  }, context);

  const inlineResult = inline.find((update) => update.message.blocks.some((block) => block.type === "tool_result"));
  const injected = inline.some((update) => update.message.metadata?.skill === "review-plan");
  const contextUpdated = inline.some((update) => update.context?.options?.mainLoopModel === "gpt-5.5");
  const forkRejected = fork.some((update) => update.message.blocks.some((block) => block.type === "tool_result" && !block.ok));
  const missingRejected = missing.some((update) => update.message.blocks.some((block) => block.type === "tool_result" && !block.ok));
  const ok = Boolean(inlineResult && injected && contextUpdated && forkRejected && missingRejected);

  console.log(JSON.stringify({ ok, injected, contextUpdated, forkRejected, missingRejected }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
