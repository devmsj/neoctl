import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readModelProviderConfig } from "../../src/model/config.js";
import { createModelGatewayFromConfig } from "../../src/model/provider-factory.js";
import { createTextMessage } from "../../src/types/messages.js";
import { WebRepl } from "../../src/web/index.js";

test("OpenAI config ignores legacy endpoint selection and login has no endpoint field", () => {
  for (const endpoint of [undefined, "auto", "chat", "responses"]) {
    const config = readModelProviderConfig({ OPENAI_API_KEY: "test-key", OPENAI_ENDPOINT: endpoint });
    assert.equal(config?.provider, "openai");
    if (config?.provider === "openai") assert.equal(config.openai?.endpoint, "responses");
  }
  const repl = Object.create(WebRepl.prototype) as WebRepl;
  (repl as any).runtime = { envPath: "nonexistent-responses-only-test.env" };
  for (const provider of ["openai", "anthropic"]) {
    const form = repl.loginForm(provider);
    for (const key of ["endpoint", "reasoningSummary", "apiVersion", "thinkingBudgetTokens"]) {
      assert.equal(form.fields.some(field => field.key === key), false);
      assert.equal(key in form.values, false);
    }
  }
  assert.equal(repl.loginForm("openai").fields.find(field => field.key === "maxOutputTokens")?.placeholder, "Leave empty for server default");
  assert.equal(repl.loginForm("anthropic").fields.find(field => field.key === "maxOutputTokens")?.placeholder, "8192");
});

test("application gateway appends /v1/responses to origin and never falls back to chat", async () => {
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    paths.push(req.url ?? "");
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unknown endpoint" } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    for (const suffix of ["", "/", "/v1", "/v1/", "/proxy/v1", "/v1/v1"]) for (const endpoint of ["auto", "chat"] as const) {
      const gateway = createModelGatewayFromConfig({ provider: "openai", model: "gpt-5.6", apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}${suffix}`, maxRetries: 0, openai: { endpoint } });
      await assert.rejects(async () => {
        for await (const _ of gateway.stream({ messages: [createTextMessage("user", "hello")], tools: [], stream: false })) { /* consume */ }
      });
    }
    assert.deepEqual(paths, [
      ...Array(8).fill("/v1/responses"),
      "/proxy/v1/responses", "/proxy/v1/responses",
      "/v1/v1/responses", "/v1/v1/responses",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
