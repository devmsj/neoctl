import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryEngine, type QueryEngineOptions } from "./query-engine.js";
import { MAX_SESSION_PROMPT_CHARS, SessionPromptError } from "./session-settings-prompt.js";
import { buildEffectiveSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../context/prompts.js";
import type { ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { buildResponsesRequest } from "../model/openai-responses-mapper.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTextMessage } from "../types/messages.js";
import type { AgentEvent } from "../types/events.js";
import { createWebRuntimeContextPayload } from "../web/runtime-context-protocol.js";
import { readSessionPrompt, updateSessionPrompt } from "../web/session-prompt-protocol.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function drain(stream: AsyncIterable<AgentEvent>) {
  for await (const _event of stream) { /* consume */ }
}
function fixture(cwd: string, options: Partial<QueryEngineOptions> = {}) {
  let baseline = "GLOBAL_V1";
  const requests: ModelRequest[] = [];
  const tools = new ToolRegistry();
  tools.register({ name: "probe", description: "Stable tool", inputSchema: { type: "object" },
    metadata: { readOnly: true, concurrent: true, visible: true }, validate() { return {}; },
    async call() { return { ok: true, output: "ok" }; },
  });
  const engine = new QueryEngine({
    cwd, model: "gpt-5", tools, session: { rootDir: cwd, sessionId: "session-one", resume: false },
    compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    contextManager: { async build(input) {
      const promptSections = [{ name: "Global", content: baseline, cacheStable: true }, { name: "Runtime", content: `agentId=${input.agentId}`, cacheStable: false }];
      return { systemPrompt: buildEffectiveSystemPrompt(promptSections), promptSections,
        userContext: { currentDate: "2026-09-08", projectMemory: "PROJECT_MEMORY" },
        systemContext: { cwd, platform: process.platform, sessionDir: input.toolUseContext?.session?.sessionDir },
      };
    } },
    modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(request);
      yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    } }, ...options,
  });
  return { engine, requests, setBaseline(value: string) { baseline = value; } };
}
async function temp(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neo-session-prompt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("save during asynchronous context construction does not contaminate that request", async (t) => {
  const dir = await temp(t), building = gate(), releaseBuild = gate();
  let blockNextBuild = false;
  const f = fixture(dir, { contextManager: { async build() {
    if (blockNextBuild) { blockNextBuild = false; building.release(); await releaseBuild.promise; }
    return { systemPrompt: "BASELINE", promptSections: [], userContext: { currentDate: "2026-09-08" }, systemContext: { cwd: dir, platform: process.platform } };
  } } });
  const initial = await f.engine.getSessionPrompt();
  blockNextBuild = true;
  const done = drain(f.engine.sendUserText("start")); await building.promise;
  const result = await f.engine.updateSessionPrompt({ content: "NEXT_REQUEST_ONLY", revision: initial.revision });
  assert.equal(result.deferred, true);
  releaseBuild.release(); await done;
  assert.equal(f.requests[0].systemPrompt, "BASELINE");
  await drain(f.engine.sendUserText("next"));
  assert.match(f.requests[1].systemPrompt!, /NEXT_REQUEST_ONLY/);
  assert.match(f.requests[1].systemPrompt!, /BASELINE/);
});

test("latest default changes only the preview, session switching serializes with stale saves, and ephemeral forks isolate", async (t) => {
  const f = fixture(await temp(t));
  const initial = await f.engine.getSessionPrompt();
  f.setBaseline("UPDATED_DEFAULT");
  const updatedDefault = await f.engine.getSessionPrompt();
  assert.equal(updatedDefault.revision, initial.revision);
  assert.notEqual(updatedDefault.effectiveRevision, initial.effectiveRevision);
  await f.engine.updateSessionPrompt({ content: "fresh addition", revision: initial.revision });
  const current = await f.engine.getSessionPrompt();
  const switched = f.engine.newSession();
  const staleSave = f.engine.updateSessionPrompt({ content: "old session", revision: current.revision });
  await switched;
  await assert.rejects(staleSave, { statusCode: 409 });
  assert.equal((await f.engine.getSessionPrompt()).override, false);
  const ephemeral = fixture(await temp(t), { session: { enabled: false } }).engine;
  const value = await ephemeral.getSessionPrompt();
  await ephemeral.updateSessionPrompt({ content: "EPHEMERAL", revision: value.revision });
  assert.equal((await ephemeral.forkForSession().getSessionPrompt()).override, false);
});

// All storage is temporary and every model gateway is fake; no provider/environment secrets.
test("session instructions append to actual model instructions, while tools and user/runtime context stay intact", async (t) => {
  const dir = await temp(t);
  const f = fixture(dir);
  f.engine.setRuntimePlugins(["test-plugin"], [{ name: "Plugin", content: "PLUGIN_RULE", cacheStable: false }]);
  const initial = await readSessionPrompt(f.engine);
  f.engine.setAppPrompt({ content: "APP_RULE", title: "Test app" });
  const current = await readSessionPrompt(f.engine);
  assert.equal(current.override, false);
  assert.match(current.effectiveContent, /GLOBAL_V1/);
  assert.match(current.effectiveContent, /PLUGIN_RULE/);
  assert.match(current.effectiveContent, /APP_RULE/);
  assert.doesNotMatch(current.effectiveContent, /__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/);
  assert.equal(current.revision, initial.revision);
  assert.notEqual(current.effectiveRevision, initial.effectiveRevision);
  const text = "  MY COMPLETE SYSTEM PROMPT\nIncluding dynamic instructions.\n";
  const result = await updateSessionPrompt(f.engine, { content: text, revision: current.revision });
  assert.equal(result.deferred, false);
  assert.equal(result.content, text);
  await drain(f.engine.sendUserText("USER_INPUT"));
  assert.ok(f.requests[0].systemPrompt!.includes(text));
  assert.match(f.requests[0].systemPrompt!, /GLOBAL_V1/);
  assert.match(f.requests[0].systemPrompt!, /PLUGIN_RULE/);
  assert.equal(f.requests[0].tools[0].name, "probe");
  assert.match(JSON.stringify(f.requests[0].messages), /PROJECT_MEMORY/);
  assert.match(JSON.stringify(f.requests[0].messages), /2026-09-08/);
  assert.match(JSON.stringify(f.requests[0].messages), /USER_INPUT/);
  const wire = buildResponsesRequest(f.requests[0], { model: "gpt-5" });
  assert.ok(String(wire.instructions).includes(text));
  const exported = await f.engine.promptExportSnapshot();
  assert.ok(exported.systemPrompt!.includes(text));
  assert.match(exported.baseSystemPrompt!, /GLOBAL_V1/);
  assert.ok((exported.promptSections as Array<{name: string}>).some(section => section.name === "Session Instructions"));
  const runtime = createWebRuntimeContextPayload(exported, { revision: 1 });
  assert.equal(runtime.prompt.sessionPrompt?.override, true);
  assert.equal(runtime.prompt.sessionPrompt?.deferred, false);
  assert.ok(runtime.prompt.systemPrompt.includes(text));
  assert.doesNotMatch(JSON.stringify(f.engine.getHistoryMessages()), /MY COMPLETE SYSTEM PROMPT/);
});

test("resume restores accepted metadata and revision; fork/new-session cannot inherit the override", async (t) => {
  const dir = await temp(t);
  const f = fixture(dir);
  const original = await f.engine.getSessionPrompt();
  const saved = await f.engine.updateSessionPrompt({ content: "SESSION_ONE_ONLY", revision: original.revision });
  const transcript = await readFile(f.engine.snapshot().session!.transcriptPath, "utf8");
  assert.match(transcript, /"type":"session-prompt"/);
  const resumed = f.engine.forkForSession("session-one", true);
  const { ok: _ok, deferred: _deferred, ...savedSnapshot } = saved;
  assert.deepEqual(await resumed.getSessionPrompt(), savedSnapshot);
  await drain(resumed.sendUserText("resume"));
  assert.match(f.requests.at(-1)!.systemPrompt!, /SESSION_ONE_ONLY/);
  const forked = f.engine.forkForSession("session-two", false);
  assert.equal((await forked.getSessionPrompt()).override, false);
  assert.notEqual((await forked.getSessionPrompt()).revision, original.revision);
  await drain(forked.sendUserText("other"));
  assert.doesNotMatch(f.requests.at(-1)!.systemPrompt!, /SESSION_ONE_ONLY/);
  await f.engine.newSession();
  assert.equal((await f.engine.getSessionPrompt()).override, false);
  assert.equal((await resumed.getSessionPrompt()).override, true);
  await assert.rejects(f.engine.updateSessionPrompt({ content: "stale other session", revision: saved.revision }), { statusCode: 409 });
});

test("busy edits persist immediately but apply only on the next model turn; coalescing and runtime status are accurate", async (t) => {
  const dir = await temp(t);
  const opened = gate(), release = gate();
  const requests: ModelRequest[] = [];
  const f = fixture(dir, { modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
    requests.push(request);
    if (requests.length === 1) {
      opened.release(); await release.promise;
      yield { type: "tool_use", toolUse: { id: "probe1", name: "probe", input: {} } };
    } else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } } });
  const initial = await f.engine.getSessionPrompt();
  const done = drain(f.engine.sendUserText("start"));
  await opened.promise;
  const requestBefore = JSON.stringify(requests[0]);
  const first = await f.engine.updateSessionPrompt({ content: "QUEUED_ONE", revision: initial.revision });
  assert.equal(first.deferred, true);
  await f.engine.updateSessionSettings({ fastMode: true });
  const second = await f.engine.updateSessionPrompt({ content: "QUEUED_TWO", revision: first.revision });
  assert.equal(second.deferred, true);
  assert.equal((await f.engine.getSessionPrompt()).content, "QUEUED_TWO");
  const runtime = createWebRuntimeContextPayload(await f.engine.promptExportSnapshot(), { revision: 1 });
  assert.equal(runtime.prompt.sessionPrompt?.override, false);
  assert.equal(runtime.prompt.sessionPrompt?.deferred, true);
  assert.equal(runtime.prompt.sessionPrompt?.pendingOverride, true);
  assert.match(runtime.prompt.systemPrompt, /GLOBAL_V1/);
  const recovered = f.engine.forkForSession("session-one", true);
  assert.equal((await recovered.getSessionPrompt()).content, "QUEUED_TWO");
  assert.equal(JSON.stringify(requests[0]), requestBefore);
  release.release(); await done;
  assert.match(requests[1].systemPrompt!, /QUEUED_TWO/);
  assert.match(requests[1].systemPrompt!, /GLOBAL_V1/);
  assert.equal(requests[1].serviceTier, "priority");
  assert.deepEqual(requests[1].tools, requests[0].tools);
  assert.deepEqual(f.engine.getPendingSessionSettings(), {});
  assert.equal((await f.engine.promptExportSnapshot()).sessionPrompt?.deferred, false);
});

test("reset reads latest baseline plus dynamic plugin/app and persists removal across resume", async (t) => {
  const dir = await temp(t);
  const f = fixture(dir);
  const initial = await f.engine.getSessionPrompt();
  const edited = await f.engine.updateSessionPrompt({ content: "CUSTOM", revision: initial.revision });
  f.setBaseline("GLOBAL_V2");
  f.engine.setRuntimePlugins(["updated"], [{ name: "Plugin", content: "PLUGIN_V2", cacheStable: false }]);
  f.engine.setAppPrompt({ content: "APP_V2" });
  assert.equal((await f.engine.getSessionPrompt()).revision, edited.revision);
  const reset = await f.engine.updateSessionPrompt({ reset: true, revision: edited.revision });
  assert.equal(reset.override, false);
  assert.match(reset.effectiveContent, /GLOBAL_V2/);
  assert.match(reset.effectiveContent, /PLUGIN_V2/);
  assert.match(reset.effectiveContent, /APP_V2/);
  assert.doesNotMatch(reset.effectiveContent, /CUSTOM|__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/);
  await drain(f.engine.sendUserText("reset query"));
  assert.match(f.requests[0].systemPrompt!, /GLOBAL_V2/);
  assert.match(f.requests[0].systemPrompt!, /PLUGIN_V2/);
  assert.match(f.requests[0].systemPrompt!, /APP_V2/);
  assert.equal((await f.engine.forkForSession("session-one", true).getSessionPrompt()).override, false);
});

test("optimistic lock is atomic under concurrent POSTs and invalid input leaves the saved revision untouched", async (t) => {
  const f = fixture(await temp(t));
  const initial = await f.engine.getSessionPrompt();
  const results = await Promise.allSettled([
    f.engine.updateSessionPrompt({ content: "WINNER", revision: initial.revision }),
    f.engine.updateSessionPrompt({ content: "LOSER", revision: initial.revision }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") assert.equal(results[1].reason.statusCode, 409);
  const saved = await f.engine.getSessionPrompt();
  for (const bad of [null, [], {}, { content: "" }, { content: " \n", revision: saved.revision },
    { content: "x".repeat(MAX_SESSION_PROMPT_CHARS + 1), revision: saved.revision },
    { content: SYSTEM_PROMPT_DYNAMIC_BOUNDARY, revision: saved.revision },
    { reset: true, content: "conflict", revision: saved.revision }, { reset: false, revision: saved.revision },
    { content: "valid", revision: saved.revision, global: true }]) {
    await assert.rejects(async () => updateSessionPrompt(f.engine, bad), (error: unknown) => error instanceof SessionPromptError && error.statusCode === 400);
  }
  assert.deepEqual(await f.engine.getSessionPrompt(), saved);
  const reset = await f.engine.updateSessionPrompt({ reset: true, revision: saved.revision });
  assert.notEqual(reset.revision, initial.revision); // ABA protection
  await assert.rejects(f.engine.updateSessionPrompt({ content: "stale default", revision: initial.revision }), { statusCode: 409 });
});

test("a queued reset at a final/aborted boundary is applied without another model request", async (t) => {
  for (const abort of [false, true]) {
    const dir = await temp(t), opened = gate(), release = gate();
    const f = fixture(dir, { modelGateway: { async *stream(): AsyncIterable<ModelStreamEvent> {
      opened.release(); await release.promise;
      yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    } } });
    const initial = await f.engine.getSessionPrompt();
    const edited = await f.engine.updateSessionPrompt({ content: "CUSTOM", revision: initial.revision });
    const controller = new AbortController();
    const done = drain(f.engine.sendUserText("start", { abortSignal: controller.signal })); await opened.promise;
    const reset = await f.engine.updateSessionPrompt({ reset: true, revision: edited.revision });
    assert.equal(reset.deferred, true);
    assert.match((await f.engine.promptExportSnapshot()).systemPrompt!, /CUSTOM/);
    if (abort) controller.abort();
    release.release(); await done;
    assert.equal((await f.engine.promptExportSnapshot()).sessionPrompt?.override, false);
    assert.deepEqual(f.engine.getPendingSessionSettings(), {});
  }
});
