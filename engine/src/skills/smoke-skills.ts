import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import { ToolRegistry } from "../tools/registry.js";
import { runToolUse } from "../tools/run-tool-use.js";
import type { ToolUseContext } from "../tools/tool.js";
import { FileSystemSkillCatalog, parseSkillMarkdown } from "./skill-filesystem.js";
import { createSkillCreateTool, createSkillListTool, createSkillReadTool, createSkillValidateTool } from "./skill-management-tools.js";
import { createSkillAwareCanUseTool, createSkillTool, InMemorySkillCatalog } from "./skill-tool.js";

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
  tools.register(createSkillListTool(catalog));
  tools.register(createSkillReadTool(catalog));
  tools.register(createSkillValidateTool());
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
  const listed = await runToolUse({ id: "skill_list", name: "skill_list", input: {} }, context);
  const read = await runToolUse({ id: "skill_read", name: "skill_read", input: { name: "review-plan", includeEntrypoint: true } }, context);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-skills-"));
  await fs.mkdir(path.join(root, "summarize"), { recursive: true });
  await fs.writeFile(path.join(root, "summarize", "SKILL.md"), `---\nname: summarize\ndescription: Summarize text\nallowed-tools:\n  - read\ntags:\n  - writing\n---\n\nSummarize the provided text into crisp bullets.\n`, "utf8");
  const fsCatalog = new FileSystemSkillCatalog([root]);
  const parsed = parseSkillMarkdown(`---\ndescription: Demo\n---\n\nDo demo work.\n`, "demo");
  const fsSkill = await fsCatalog.get("summarize");
  const createTool = createSkillCreateTool(fsCatalog, { requireApproval: false });
  const fsTools = new ToolRegistry();
  fsTools.register(createTool);
  const fsContext: ToolUseContext = { agentId: "main", tools: fsTools, appState: new InMemoryAppState("main"), emit: () => undefined };
  const created = await runToolUse({
    id: "skill_create",
    name: "skill_create",
    input: {
      skill: {
        name: "generated-review",
        description: "Generated review workflow",
        entrypoint: "Review generated output and list risks.",
        execution: "inline",
        allowedTools: ["read"],
      },
    },
  }, fsContext);
  const createdSkill = await fsCatalog.get("generated-review");

  const guard = createSkillAwareCanUseTool(catalog);
  const allowedDecision = await guard({ id: "allowed", name: "plan", input: {} }, {
    ...context,
    options: { activeSkill: { name: "review-plan", allowedTools: ["plan"] } },
  });
  const deniedDecision = await guard({ id: "denied", name: "exec", input: {} }, {
    ...context,
    options: { activeSkill: { name: "review-plan", allowedTools: ["plan"] } },
  });

  const inlineResult = inline.find((update) => update.message.blocks.some((block) => block.type === "tool_result"));
  const injected = inline.some((update) => update.message.metadata?.skill === "review-plan");
  const contextUpdated = inline.some((update) => update.context?.options?.mainLoopModel === "gpt-5.5" && update.context.options.activeSkill?.name === "review-plan");
  const forkRejected = fork.some((update) => update.message.blocks.some((block) => block.type === "tool_result" && !block.ok));
  const missingRejected = missing.some((update) => update.message.blocks.some((block) => block.type === "tool_result" && !block.ok));
  const listWorked = listed.some((update) => update.message.blocks.some((block) => block.type === "tool_result" && block.ok));
  const readWorked = read.some((update) => update.message.blocks.some((block) => block.type === "tool_result" && block.ok));
  const filesystemWorked = fsSkill?.name === "summarize" && parsed.name === "demo";
  const createWorked = createdSkill?.name === "generated-review" && created.some((update) => update.message.metadata?.skillManagement === "created");
  const guardWorked = (typeof allowedDecision === "boolean" ? allowedDecision : allowedDecision.allowed) === true &&
    typeof deniedDecision !== "boolean" && deniedDecision.allowed === false;
  const ok = Boolean(inlineResult && injected && contextUpdated && forkRejected && missingRejected && listWorked && readWorked && filesystemWorked && createWorked && guardWorked);

  console.log(JSON.stringify({ ok, injected, contextUpdated, forkRejected, missingRejected, listWorked, readWorked, filesystemWorked, createWorked, guardWorked }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
