#!/usr/bin/env node
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { QueryEngine } from "../core/query-engine";
import { createModelGatewayFromEnv } from "../model/env";
import { ToolRegistry } from "../tools/registry";
import { echoTool } from "../tools/builtins/echo-tool";
import { parseReplCommand, helpText } from "./commands";
import { renderEvent } from "./render";

async function main(): Promise<void> {
  const tools = new ToolRegistry();
  tools.register(echoTool);

  const engine = new QueryEngine({
    agentId: "main",
    modelGateway: createModelGatewayFromEnv(),
    tools,
  });

  const rl = readline.createInterface({ input, output, prompt: "agent> " });
  console.log("Agent Scaffold REPL");
  console.log("Type /help for commands.");
  rl.prompt();

  for await (const line of rl) {
    const command = parseReplCommand(line);

    if (command.type === "exit") break;
    if (command.type === "help") {
      console.log(helpText);
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
      console.log(JSON.stringify(engine.snapshot(), null, 2));
      rl.prompt();
      continue;
    }
    if (!command.text.trim()) {
      rl.prompt();
      continue;
    }

    try {
      for await (const event of engine.sendUserText(command.text)) {
        const rendered = renderEvent(event);
        if (rendered) console.log(rendered);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    rl.prompt();
  }

  rl.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
