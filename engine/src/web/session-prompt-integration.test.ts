import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PromptConfigStore } from "../context/prompt-config.js";
import { DefaultContextManager } from "../context/context-manager.js";
import { QueryEngine } from "../core/query-engine.js";
import { SessionPromptError } from "../core/session-settings-prompt.js";
import { ToolRegistry } from "../tools/registry.js";
import { WebRepl, type WebRuntime } from "./index.js";

test("WebRepl session editor uses real file baseline and session persistence without global writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-web-session-prompt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PromptConfigStore({ filePath: path.join(root, "system.md") });
  const original = await store.read();
  const tools = new ToolRegistry();
  const gateway = { async *stream() { throw new Error("editor must not call a model"); } };
  const makeEngine = (id: string) => new QueryEngine({
    cwd: root, tools, modelGateway: gateway,
    contextManager: new DefaultContextManager({ cwd: root, promptConfigStore: store }),
    session: { rootDir: path.join(root, "sessions"), sessionId: id, resume: true },
  });
  const first = makeEngine("session-a");
  const second = makeEngine("session-b");
  await first.initialize();
  await second.initialize();
  const runtime = {
    engine: first, tools, initialMetrics: await first.contextMetrics(),
    taskStore: { subscribe: () => () => undefined, list: () => [], isTerminal: () => false },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  } as unknown as WebRuntime;
  const repl = new WebRepl(runtime);
  const internals = repl as unknown as { publishRuntimeContext(): void; broadcastSync(): void };
  let published = 0;
  internals.publishRuntimeContext = () => { published++; };
  internals.broadcastSync = () => undefined;
  const initial = await repl.sessionPrompt();
  assert.equal(initial.override, false);
  const saved = await repl.saveSessionPrompt({ content: "Session A only", revision: initial.revision });
  assert.equal(saved.ok, true);
  assert.equal(saved.override, true);
  assert.equal(saved.deferred, false);
  assert.equal((await repl.sessionPrompt()).content, "Session A only");
  assert.equal((await second.getSessionPrompt()).override, false);
  assert.equal((await store.read()).content, original.content);
  assert.equal((await makeEngine("session-a").getSessionPrompt()).content, "Session A only");
  await assert.rejects(repl.saveSessionPrompt({ content: "stale", revision: initial.revision }), (e) => e instanceof SessionPromptError && e.statusCode === 409);
  await assert.rejects(repl.saveSessionPrompt({ content: "", revision: saved.revision }), (e) => e instanceof SessionPromptError && e.statusCode === 400);
  await store.save("Latest global baseline", original.revision);
  const reset = await repl.saveSessionPrompt({ reset: true, revision: saved.revision });
  assert.equal(reset.override, false);
  assert.ok(reset.effectiveContent.includes("Latest global baseline"));
  assert.equal(published, 2);
  assert.equal((await store.read()).content, "Latest global baseline");
});
