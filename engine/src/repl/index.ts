#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { QueryEngine } from "../core/query-engine";
import { createModelGatewayFromEnv, loadDotEnvIfPresent } from "../model/env";
import { readModelProviderConfig } from "../model/config";
import { CommunicationLogger, LoggingModelGateway } from "../model/communication-logger";
import { ToolRegistry } from "../tools/registry";
import { echoTool } from "../tools/builtins/echo-tool";
import { editTool, writeTool } from "../tools/builtins/edit-tool";
import { execTool } from "../tools/builtins/exec-tool";
import { listDirectoryTool, readFileTool } from "../tools/builtins/filesystem-tools";
import { searchTool } from "../tools/builtins/search-tool";
import { createAgentTool } from "../agents/agent-tool";
import { createTaskTools } from "../tasks/task-tools";
import { TaskStore } from "../tasks/task-store";
import { parseReplCommand, helpText } from "./commands";
import { renderEvent } from "./render";
import { ReplStatusLine } from "./status-line";

async function main(): Promise<void> {
  loadDotEnvIfPresent(undefined, { override: true });
  const modelConfig = readModelProviderConfig(process.env);
  const communicationLogger = new CommunicationLogger();
  const modelGateway = new LoggingModelGateway(createModelGatewayFromEnv(), communicationLogger);
  const taskStore = new TaskStore();
  const tools = new ToolRegistry();
  tools.register(echoTool);
  tools.register(editTool);
  tools.register(writeTool);
  tools.register(execTool);
  tools.register(listDirectoryTool);
  tools.register(readFileTool);
  tools.register(searchTool);
  for (const tool of createTaskTools(taskStore)) tools.register(tool);
  tools.register(createAgentTool({ modelGateway, tools, taskStore }));

  const engine = new QueryEngine({
    agentId: "main",
    model: modelConfig?.model,
    fallbackModel: modelConfig?.fallbackModel,
    modelGateway,
    tools,
    session: {
      enabled: process.env.AGENT_SESSION_TRANSCRIPT !== "0",
      sessionId: process.env.AGENT_SESSION_ID,
      rootDir: process.env.AGENT_SESSION_DIR,
      resume: process.env.AGENT_SESSION_RESUME === "1",
      toolResultThresholdChars: process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS
        ? Number(process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS)
        : undefined,
    },
  });
  await engine.initialize();

  const rl = readline.createInterface({ input, output, prompt: "agent> " });
  const statusLine = new ReplStatusLine(output);
  console.log("Agent Scaffold REPL");
  console.log("Type /help for commands.");
  const session = engine.snapshot().session;
  if (session) console.log(`Session transcript: ${session.transcriptPath}`);
  rl.prompt();

  for await (const line of rl) {
    const command = parseReplCommand(line);

    if (command.type === "exit") break;
    if (command.type === "help") {
      console.log(helpText);
      rl.prompt();
      continue;
    }
    if (command.type === "log") {
      if (command.off) {
        communicationLogger.setDirectory(undefined);
        console.log("model communication logging disabled");
        rl.prompt();
        continue;
      }
      if (!command.path || !path.isAbsolute(command.path)) {
        console.log("usage: /log <absolute-directory> or /log off");
        rl.prompt();
        continue;
      }
      await fs.mkdir(command.path, { recursive: true });
      communicationLogger.setDirectory(command.path);
      console.log(`model communication logs: ${path.resolve(command.path)}`);
      rl.prompt();
      continue;
    }
    if (command.type === "reset") {
      engine.reset();
      console.log("transcript reset");
      rl.prompt();
      continue;
    }
    if (command.type === "state") {
      console.log(JSON.stringify({ ...engine.snapshot(), communicationLog: communicationLogger.snapshot() }, null, 2));
      rl.prompt();
      continue;
    }
    if (!command.text.trim()) {
      rl.prompt();
      continue;
    }

    try {
      for await (const event of engine.sendUserText(command.text)) {
        statusLine.handle(event);
        const rendered = renderEvent(event);
        statusLine.clear();
        if (rendered) console.log(rendered);
        statusLine.render();
      }
    } catch (error) {
      statusLine.clear();
      console.error(error instanceof Error ? error.message : String(error));
    }
    statusLine.clear();
    rl.prompt();
  }

  rl.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
