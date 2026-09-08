import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PromptConfigStore, PromptConfigError, MAX_SYSTEM_PROMPT_BYTES, readBundledSystemPrompt } from "./prompt-config.js";
import { AdditionalPromptContextManager, AppPromptContextManager, DefaultContextManager } from "./context-manager.js";
import { InMemoryAppPromptStore } from "../app/app-prompt.js";
import { QueryEngine } from "../core/query-engine.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTextMessage } from "../types/messages.js";
import type { ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-prompt-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "prompts", "test-version", "system.md");
  const store = new PromptConfigStore({ filePath });
  return { root, filePath, store };
}
const fails = (status: number) => (error: unknown) => error instanceof PromptConfigError && error.status === status;

test("initializes the real bundled Markdown exactly once; versions are isolated", async (t) => {
  const { root, store, filePath } = await fixture(t);
  const snapshots = await Promise.all(Array.from({ length: 8 }, () => new PromptConfigStore({ filePath }).read()));
  assert.equal(snapshots[0].content, readBundledSystemPrompt());
  assert.match(snapshots[0].content, /## Agent Scaffold/);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.revision)).size, 1);
  const updated = await store.save("  custom baseline\n", snapshots[0].revision);
  assert.equal((await new PromptConfigStore({ filePath }).read()).content, updated.content);
  assert.equal(await fs.readFile(filePath, "utf8"), updated.content);
  const next = new PromptConfigStore({ homeDir: root, version: "next-version" });
  // Ensure this test's explicit home is independent of the runner's path override.
  const versioned = new PromptConfigStore({ filePath: path.join(root, "prompts", "next-version", "system.md"), version: "next-version" });
  assert.equal((await versioned.read()).content, readBundledSystemPrompt());
  assert.notEqual(versioned.filePath, filePath);
  assert.equal(next.version, "next-version");
});

test("CAS serializes parallel writers, rejects stale and externally modified revisions", async (t) => {
  const { store, filePath } = await fixture(t);
  const initial = await store.read();
  const results = await Promise.allSettled([
    store.save("first", initial.revision),
    new PromptConfigStore({ filePath }).save("second", initial.revision),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(fails(409)(rejection.reason));
  const current = await store.read();
  await fs.writeFile(filePath, "external editor change");
  await assert.rejects(store.save("must not overwrite", current.revision), fails(409));
  assert.equal((await store.read()).content, "external editor change");
  assert.deepEqual((await fs.readdir(path.dirname(filePath))).sort(), ["system.md"]);
});

test("rejects illegal content/revisions and never overwrites existing invalid files", async (t) => {
  const { store, filePath } = await fixture(t);
  const initial = await store.read();
  for (const content of [null, undefined, 1, {}, [], "", " \r\n\t"]) {
    await assert.rejects(store.save(content, initial.revision), fails(400));
  }
  for (const revision of [undefined, null, 1, "", "stale"]) await assert.rejects(store.save("ok", revision), fails(400));
  await assert.rejects(store.save("你".repeat(Math.ceil(MAX_SYSTEM_PROMPT_BYTES / 3)), initial.revision), fails(413));
  const exact = "a".repeat(MAX_SYSTEM_PROMPT_BYTES);
  assert.equal((await store.save(exact, initial.revision)).content.length, MAX_SYSTEM_PROMPT_BYTES);
  await fs.writeFile(filePath, "");
  await assert.rejects(store.read(), fails(400));
  assert.equal(await fs.readFile(filePath, "utf8"), "");
  await fs.writeFile(filePath, "a".repeat(MAX_SYSTEM_PROMPT_BYTES + 1));
  await assert.rejects(store.read(), fails(413));
});

test("atomic file survives a separate process and cross-process CAS admits only one writer", async (t) => {
  const { store, filePath } = await fixture(t);
  const initial = await store.read();
  const moduleUrl = new URL("./prompt-config.js", import.meta.url).href.replace(/\.js$/, import.meta.url.endsWith(".ts") ? ".ts" : ".js");
  const run = promisify(execFile);
  const script = `import { PromptConfigStore } from ${JSON.stringify(moduleUrl)}; const s = new PromptConfigStore({filePath: process.argv[1]}); try { const result = await s.save(process.argv[2], process.argv[3]); console.log(JSON.stringify(result)); } catch(e) { console.log(JSON.stringify({status:e.status})); }`;
  const results = await Promise.all(["process A", "process B"].map((content) => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, filePath, content, initial.revision], { cwd: fileURLToPath(new URL("../../", import.meta.url)) })));
  const parsed = results.map((result) => JSON.parse(result.stdout));
  assert.equal(parsed.filter((result) => result.status === 409).length, 1);
  const saved = parsed.find((result) => result.content);
  assert.deepEqual(await new PromptConfigStore({ filePath }).read(), saved);
});

test("every ContextManager build reloads the baseline and preserves tool/plugin/app/runtime sections", async (t) => {
  const { root, store, filePath } = await fixture(t);
  const app = new InMemoryAppPromptStore();
  app.setAppPrompt({ content: "APP_CONTRACT" });
  const create = () => new AppPromptContextManager(new AdditionalPromptContextManager(new DefaultContextManager({ cwd: root, promptConfigStore: new PromptConfigStore({ filePath }) }), [{ name: "Plugin", content: "PLUGIN_CONTRACT", cacheStable: true }]), app);
  const managers = [create(), create()];
  const input = { agentId: "session-A", messages: [], enabledTools: ["image_create", "image_inspect", "secret_request"] };
  const before = await managers[0].build(input);
  assert.match(before.systemPrompt, /engineering agent running inside neo/);
  await store.save("MY_EDITED_BASELINE", (await store.read()).revision);
  for (const manager of managers) {
    const after = await manager.build(input);
    assert.match(after.systemPrompt, /MY_EDITED_BASELINE/);
    assert.doesNotMatch(after.systemPrompt, /engineering agent running inside neo/);
    for (const text of ["PLUGIN_CONTRACT", "APP_CONTRACT", "agentId=session-A", "48000 serialized characters", "within 1-200000", "use the image_create tool", "use the image_inspect tool", "Secrets:"]) assert.ok(after.systemPrompt.includes(text), text);
  }
  const noTools = await managers[0].build({ ...input, enabledTools: [] });
  assert.match(noTools.systemPrompt, /no drawing\/image generation\/editing tool/);
  assert.match(noTools.systemPrompt, /no image loading tool/);
  assert.doesNotMatch(noTools.systemPrompt, /Secrets:/);
});

test("standard QueryEngine uses the file-backed DefaultContextManager on future requests", async (t) => {
  const { root, store, filePath } = await fixture(t);
  const previous = process.env.NEO_SYSTEM_PROMPT_PATH;
  process.env.NEO_SYSTEM_PROMPT_PATH = filePath;
  t.after(() => { if (previous === undefined) delete process.env.NEO_SYSTEM_PROMPT_PATH; else process.env.NEO_SYSTEM_PROMPT_PATH = previous; });
  const requests: ModelRequest[] = [];
  const engine = new QueryEngine({ cwd: root, model: "test", tools: new ToolRegistry(), session: { enabled: false },
    modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> { requests.push(request); yield { type: "assistant_message", message: createTextMessage("assistant", "ok") }; } },
  });
  for await (const _event of engine.sendUserText("first")) { /* drain */ }
  await store.save("NEXT_REQUEST_BASELINE", (await store.read()).revision);
  for await (const _event of engine.sendUserText("second")) { /* drain */ }
  assert.match(requests[0].systemPrompt!, /engineering agent running inside neo/);
  assert.match(requests.at(-1)!.systemPrompt!, /NEXT_REQUEST_BASELINE/);
});
