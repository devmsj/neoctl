import { createTextMessage } from "../types/messages.js";
import { readModelProviderConfig } from "./config.js";
import { loadDefaultDotEnvFiles } from "./env.js";
import { createModelGatewayFromConfig } from "./provider-factory.js";

async function main(): Promise<void> {
  loadDefaultDotEnvFiles({ override: true });
  const config = readModelProviderConfig(process.env);
  if (!config) throw new Error("OPENAI_API_KEY is required when MODEL_PROVIDER=openai");

  const gateway = createModelGatewayFromConfig({
    ...config,
    defaultMaxOutputTokens: 64,
    timeoutMs: 120000,
    streamIdleTimeoutMs: 120000,
    maxRetries: 1,
  });

  let text = "";
  let completed = false;

  for await (const event of gateway.stream({
    model: config.model,
    instructions: "Answer with exactly one short word when possible.",
    messages: [createTextMessage("user", process.argv.slice(2).join(" ") || "Say pong")],
    tools: [],
    stream: true,
    maxOutputTokens: 64,
  })) {
    if (event.type === "assistant_delta") text += event.text;
    if (event.type === "assistant_message" && !text) {
      text += event.message.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }
    if (event.type === "response_completed") completed = true;
  }

  console.log(JSON.stringify({ ok: completed && text.trim().length > 0, completed, text: text.trim() }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
