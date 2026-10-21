import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrameworkFeedbackTool, FrameworkFeedbackStore, FRAMEWORK_FEEDBACK_PROMPT } from "../../src/tools/builtins/framework-feedback-tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runToolUse } from "../../src/tools/run-tool-use.js";
import { InMemoryAppState } from "../../src/app/app-state.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { DefaultContextManager } from "../../src/context/context-manager.js";
import { PromptConfigStore } from "../../src/context/prompt-config.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { ModelRequest } from "../../src/model/model-gateway.js";
import type { ToolUseContext } from "../../src/tools/tool.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "neo-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FrameworkFeedbackStore(join(root, "feedback"));
  const tools = new ToolRegistry(); tools.register(createFrameworkFeedbackTool(store));
  const context: ToolUseContext = { agentId: "test", tools, appState: new InMemoryAppState("test"), emit() {} };
  const submit = (input: unknown) => runToolUse({ id: "call", name: "framework_feedback", input }, context);
  return { root, store, tools, context, submit };
}

test("one title/body record per call; rejects batches, empty fields and excessive text", async t => {
  const f = await fixture(t);
  for (const input of [[], { items: [{ title: "x", body: "y" }] }, { title: "x" }, { title: " ", body: "x" }, { title: "x", body: "y".repeat(401) }, { title: "x".repeat(61), body: "y" }, { title: "x", body: "y", extra: true }]) {
    const result = await f.submit(input);
    assert.match(JSON.stringify(result), /error/);
  }
  assert.equal((await f.store.list()).total, 0);
  await f.submit({ title: " 界面更新迟缓 ", body: " 问题：状态滞后；复现：切换会话；改进：及时同步。 " });
  const page = await f.store.list();
  assert.equal(page.total, 1);
  assert.equal(page.items[0].title, "界面更新迟缓");
  assert.equal((await new FrameworkFeedbackStore(f.store.directory).list()).total, 1);
  f.tools.setEnabled("framework_feedback", false);
  assert.match(JSON.stringify(await f.submit({ title: "x", body: "y" })), /Unknown tool/);
  assert.equal((await f.store.list()).total, 1);
});

test("concurrent immutable submissions paginate newest first without loss", async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 23 }, (_, i) => new FrameworkFeedbackStore(f.store.directory).submit({ title: `意见${i}`, body: "问题；复现；改进" })));
  await writeFile(join(f.store.directory, "unfinished.json.tmp"), "{");
  const a = await f.store.list(1, 10), b = await f.store.list(2, 10), c = await f.store.list(999, 10);
  assert.equal(a.total, 23); assert.equal(a.items.length, 10); assert.equal(b.items.length, 10); assert.equal(c.items.length, 3);
  assert.equal(c.page, 3); assert.equal(new Set([...a.items, ...b.items, ...c.items].map(x => x.id)).size, 23);
  assert.ok(a.items[0].id > c.items.at(-1)!.id);
  assert.equal((await f.store.list(-1, 1000)).pageSize, 50);
  assert.equal((await f.store.list(NaN, NaN)).page, 1);
});

test("cancelled calls do not persist; known secrets are redacted before storage", async t => {
  const f = await fixture(t);
  f.context.abortSignal = AbortSignal.abort();
  await f.submit({ title: "x", body: "y" });
  assert.equal((await f.store.list()).total, 0);
  f.context.abortSignal = undefined;
  f.context.secretRedactions = { record() {}, redact<T>(value: T): T { return JSON.parse(JSON.stringify(value).replaceAll("SECRET", "[redacted]")); } };
  await f.submit({ title: "x", body: "问题SECRET；复现；改进" });
  assert.doesNotMatch(JSON.stringify(await f.store.list()), /SECRET/);
  const blocked = join(f.root, "blocked"); await writeFile(blocked, "file");
  const tool = createFrameworkFeedbackTool(new FrameworkFeedbackStore(blocked));
  assert.equal((await tool.call!({ title: "x", body: "y" }, f.context, {})).ok, false);
  assert.ok((await readdir(f.store.directory)).every(name => !name.endsWith(".tmp")));
});

test("deletion persists across store reopening, clamps empty last page and rejects unsafe ids", async t => {
  const f = await fixture(t);
  const a = await f.store.submit({ title: "保留", body: "问题；复现；改进" });
  const b = await f.store.submit({ title: "删除", body: "问题；复现；改进" });
  for (const id of [undefined, null, {}, "", "../outside", a.id + ".json", "C:\\outside", a.id + "/../x"]) {
    await assert.rejects(f.store.delete(id), /Invalid feedback id/);
  }
  assert.equal((await f.store.list()).total, 2);
  assert.equal(await f.store.delete(b.id), true);
  assert.equal(await f.store.delete(b.id), false, "repeated deletion is idempotent");
  const reopened = new FrameworkFeedbackStore(f.store.directory);
  const page = await reopened.list(2, 1);
  assert.equal(page.page, 1); assert.equal(page.totalPages, 1); assert.equal(page.total, 1);
  assert.equal(page.items[0].id, a.id);
  assert.equal((await readdir(f.store.directory)).includes(`${b.id}.json`), false, "remove the durable file, not just UI state");
  await reopened.delete(a.id);
  assert.equal((await new FrameworkFeedbackStore(f.store.directory).list()).total, 0);
});

test("effective model prompt and schemas follow enabled tools on each request", async t => {
  const f = await fixture(t), requests: ModelRequest[] = [];
  const engine = new QueryEngine({ cwd: f.root, tools: f.tools, model: "test", session: { enabled: false },
    contextManager: new DefaultContextManager({ cwd: f.root, promptConfigStore: new PromptConfigStore({ filePath: join(f.root, "system.md") }) }),
    modelGateway: { async *stream(request) { requests.push(request); yield { type: "assistant_message", message: createTextMessage("assistant", "ok") }; } },
  });
  for (const enabled of [true, false, true]) {
    f.tools.setEnabled("framework_feedback", enabled);
    for await (const _ of engine.sendUserText("task")) { /* drain */ }
    const request = requests.at(-1)!;
    assert.equal(request.systemPrompt!.includes(FRAMEWORK_FEEDBACK_PROMPT), enabled);
    assert.equal(request.systemPrompt!.includes("framework_feedback"), enabled);
    assert.equal(request.tools.some(tool => tool.name === "framework_feedback"), enabled);
  }
});
