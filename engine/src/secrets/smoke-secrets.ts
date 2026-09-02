import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import { ToolRegistry } from "../tools/registry.js";
import { runToolUse } from "../tools/run-tool-use.js";
import type { ToolUseContext } from "../tools/tool.js";
import { createExecTool } from "../tools/builtins/exec-tool.js";
import { ExecProcessManager } from "../tools/builtins/exec-process-manager.js";
import { createSecretTools } from "../tools/builtins/secret-tools.js";
import { InMemorySecretRedactionRegistry } from "./secret-redaction.js";
import { SecretStore } from "./secret-store.js";

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neoctl-secrets-"));
  const filePath = path.join(dir, "secrets.json");
  const store = await SecretStore.open({ filePath, passphrase: "smoke-passphrase" });

  await store.setPlaintext("api_token", "super-secret-token");
  const empty = await store.requestEmpty("github_token", { reason: "Need GitHub API", requestedBy: "agent" });
  const raw = await fs.readFile(filePath, "utf8");
  const encryptedAtRestOk = !raw.includes("super-secret-token") && raw.includes("api_token") && raw.includes("github_token");
  const list = await store.list();
  const metadataOk = list.some((entry) => entry.key === "api_token" && entry.status === "set" && entry.length === "super-secret-token".length)
    && empty.status === "empty";

  const registry = new ToolRegistry();
  for (const tool of createSecretTools()) registry.register(tool);
  registry.register(createExecTool({ processManager: new ExecProcessManager() }));
  const redactions = new InMemorySecretRedactionRegistry();
  const context: ToolUseContext = {
    agentId: "smoke",
    tools: registry,
    appState: new InMemoryAppState("smoke", dir),
    secrets: store,
    secretRedactions: redactions,
    emit: () => undefined,
  };

  const secretList = await runToolUse({ id: "secret_list", name: "secret_list", input: {} }, context);
  const secretListJson = JSON.stringify(secretList);
  const listToolOk = secretListJson.includes("api_token") && secretListJson.includes('"length":18') && !secretListJson.includes("super-secret-token");

  const request = await runToolUse({ id: "secret_request", name: "secret_request", input: { key: "new_token", reason: "test" } }, context);
  const requestOk = JSON.stringify(request).includes("new_token") && (await store.info("new_token"))?.status === "empty";

  const execResult = await runToolUse({
    id: "exec_secret",
    name: "exec_command",
    input: {
      cmd: "node -e \"console.log(process.env.API_TOKEN)\"",
      description: "verify secret env redaction",
      envSecrets: { API_TOKEN: "api_token" },
      max_output_chars: 1000,
    },
  }, context);
  const execJson = JSON.stringify(execResult);
  const execRedactedOk = execJson.includes("[secret:api_token]") && !execJson.includes("super-secret-token");

  let emptyErrorOk = false;
  try {
    await store.resolveForTool("github_token");
  } catch (error) {
    emptyErrorOk = error instanceof Error && error.message.includes("has no value");
  }

  const ok = encryptedAtRestOk && metadataOk && listToolOk && requestOk && execRedactedOk && emptyErrorOk;
  console.log(JSON.stringify({ ok, encryptedAtRestOk, metadataOk, listToolOk, requestOk, execRedactedOk, emptyErrorOk }, null, 2));
  if (!ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
