import { createTextMessage } from "../types/messages";
import { OpenAIResponsesAdapter } from "./openai-responses-adapter";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const gateway = new OpenAIResponsesAdapter({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    endpoint: process.env.OPENAI_ENDPOINT === "chat" ? "chat" : process.env.OPENAI_ENDPOINT === "responses" ? "responses" : "auto",
    defaultMaxOutputTokens: 64,
    timeoutMs: 120000,
    streamIdleTimeoutMs: 120000,
    maxRetries: 1,
  });

  let text = "";
  let completed = false;

  for await (const event of gateway.stream({
    model: process.env.OPENAI_MODEL,
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
