import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptConfigStore } from "../context/prompt-config.js";
import { DefaultContextManager } from "../context/context-manager.js";
import { QueryEngine } from "./query-engine.js";
import { SessionStore } from "../session/session-store.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTextMessage } from "../types/messages.js";
import type { ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { refreshGlobalToolOverrides, type WebRuntime } from "../web/index.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "neo-inheritance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PromptConfigStore({ filePath: join(root, "system.md") });
  await store.save("GLOBAL_V1", (await store.read()).revision);
  const tools = new ToolRegistry();
  for (const name of ["image_create", "expose_downloads"]) tools.register({
    name, description: name, inputSchema: { type: "object" }, metadata: { visible: true, readOnly: true, concurrent: true },
    validate() { return {}; }, async call() { return { ok: true, output: "ok" }; },
  });
  const requests: ModelRequest[] = [];
  const engine = new QueryEngine({ cwd: root, tools, model: "test", session: { rootDir: root, sessionId: "a", resume: true },
    contextManager: new DefaultContextManager({ cwd: root, promptConfigStore: store }),
    additionalPromptSections: [{ name: "Downloads", content: "DOWNLOAD_RULE", requiresTools: ["expose_downloads"] }],
    modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> { requests.push(request); yield { type: "assistant_message", message: createTextMessage("assistant", "ok") }; } },
  });
  return { root, store, tools, requests, engine };
}
async function send(engine: QueryEngine) { for await (const _ of engine.sendUserText("test")) { /* drain */ } }

test("append survives global edits and tool toggles without snapshotting generated instructions or conflicting revisions", async t => {
  const f = await fixture(t);
  const initial = await f.engine.getSessionPrompt();
  assert.equal(initial.content, "");
  assert.equal(initial.mode, "inherit");
  f.tools.setEnabled("image_create", false);
  const saved = await f.engine.updateSessionPrompt({ content: "CUSTOM_RULE", revision: initial.revision });
  assert.equal(saved.mode, "append");
  assert.match(saved.effectiveContent, /no drawing/);
  f.tools.setEnabled("image_create", true);
  f.tools.setEnabled("expose_downloads", false);
  await f.store.save("GLOBAL_V2", (await f.store.read()).revision);
  const next = await f.engine.getSessionPrompt();
  assert.equal(next.content, "CUSTOM_RULE");
  assert.equal(next.revision, saved.revision);
  assert.notEqual(next.effectiveRevision, saved.effectiveRevision);
  await send(f.engine);
  const request = f.requests[0];
  assert.match(request.systemPrompt!, /GLOBAL_V2/);
  assert.match(request.systemPrompt!, /CUSTOM_RULE/);
  assert.match(request.systemPrompt!, /use the image_create tool/);
  assert.doesNotMatch(request.systemPrompt!, /GLOBAL_V1|DOWNLOAD_RULE|no drawing/);
  assert.deepEqual(request.tools.map(t => t.name), ["image_create"]);
  assert.equal((request.systemPrompt!.match(/CUSTOM_RULE/g) ?? []).length, 1);
  assert.equal((await f.engine.forkForSession("a", true).getSessionPrompt()).mode, "append");
});

test("replace_base replaces only the global source and reset resumes live inheritance", async t => {
  const f = await fixture(t);
  await f.engine.initialize();
  f.engine.setAppPrompt({ content: "APP_RULE" });
  const initial = await f.engine.getSessionPrompt();
  const saved = await f.engine.updateSessionPrompt({ content: "MY_BASE", mode: "replace_base", revision: initial.revision });
  await send(f.engine);
  assert.doesNotMatch(f.requests[0].systemPrompt!, /GLOBAL_V1/);
  for (const rule of ["MY_BASE", "APP_RULE", "DOWNLOAD_RULE", "Runtime Tool Capabilities", "agentId="]) assert.ok(f.requests[0].systemPrompt!.includes(rule));
  assert.equal((await f.engine.forkForSession("a", true).getSessionPrompt()).mode, "replace_base");
  const reset = await f.engine.updateSessionPrompt({ reset: true, revision: saved.revision });
  assert.equal(reset.content, "");
  assert.match(reset.effectiveContent, /GLOBAL_V1/);
});

test("old transcript preserves full replacement until an explicit migration; new full replacements are rejected", async t => {
  const f = await fixture(t);
  const session = await SessionStore.open({ rootDir: f.root, sessionId: "a", agentId: "main", resume: true });
  session.recordSessionPrompt({ content: "LEGACY_ORIGINAL", revision: "old" });
  const legacy = await f.engine.getSessionPrompt();
  assert.equal(legacy.mode, "legacy_full_override");
  assert.equal(legacy.effectiveContent, "LEGACY_ORIGINAL");
  const edited = await f.engine.updateSessionPrompt({ content: "LEGACY_EDIT", revision: legacy.revision });
  assert.equal(edited.mode, "legacy_full_override");
  assert.equal(edited.effectiveContent, "LEGACY_EDIT");
  const migrated = await f.engine.updateSessionPrompt({ content: "USER_ONLY", mode: "append", revision: edited.revision });
  assert.match(migrated.effectiveContent, /GLOBAL_V1/);
  assert.match(migrated.effectiveContent, /USER_ONLY/);
  assert.doesNotMatch(migrated.effectiveContent, /LEGACY/);
  await assert.rejects(f.engine.updateSessionPrompt({ content: "x", mode: "legacy_full_override", revision: migrated.revision }), { statusCode: 400 });
});

test("existing runtimes refresh shared global tools at turn boundaries, never during an in-flight request", async t => {
  const f = await fixture(t);
  let global: Record<string, boolean> = {};
  let release!: () => void, opened!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { opened = r; });
  function make(id: string, sessionOverrides: Record<string, boolean> = {}) {
    const tools = new ToolRegistry();
    tools.register({ name: "probe", description: "probe", inputSchema: { type: "object" }, metadata: { visible: true, readOnly: true, concurrent: true }, validate() { return {}; }, async call() { return { ok: true, output: "ok" }; } });
    const runtime = { tools, toolSupport: { catalog: [{ name: "probe" }], globalOverrides: {}, sessionOverrides, resolveGlobal: () => ({ ...global }) } } as unknown as WebRuntime;
    const requests: ModelRequest[] = [];
    const engine = new QueryEngine({ tools, cwd: f.root, session: { enabled: false }, refreshTools: () => refreshGlobalToolOverrides(runtime),
      contextManager: new DefaultContextManager({ cwd: f.root, promptConfigStore: f.store }),
      modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
        requests.push(request);
        if (id === "a" && requests.length === 1) { opened(); await gate; yield { type: "tool_use", toolUse: { id: "call", name: "probe", input: {} } }; }
        else yield { type: "assistant_message", message: createTextMessage("assistant", "ok") };
      } },
    });
    return { engine, tools, requests };
  }
  const a = make("a"), b = make("b"), explicit = make("c", { probe: true });
  const done = send(a.engine); await started;
  global = { probe: false };
  await a.engine.promptExportSnapshot();
  assert.equal(a.tools.isEnabled("probe"), true);
  assert.equal((await b.engine.promptExportSnapshot()).toolDefinitions instanceof Array, true);
  assert.equal(b.tools.isEnabled("probe"), false);
  await explicit.engine.promptExportSnapshot();
  assert.equal(explicit.tools.isEnabled("probe"), true);
  release(); await done;
  assert.equal(a.requests[0].tools.length, 1);
  assert.equal(a.requests[1].tools.length, 0);
  assert.equal(a.tools.isEnabled("probe"), false);
});
