import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { QueryEngine } from "../../src/core/query-engine.js";
import { DemoMode, DEMO_PROMPT, DEMO_RESPONSE_INTERVAL_MS } from "../../src/web/demo-mode.js";
import { DemoTools, DEMO_SYSTEM_TOOLS } from "../../src/web/demo-tools.js";
import { WebRepl, SessionUsageTracker, type WebRuntime } from "../../src/web/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { editTool, writeTool } from "../../src/tools/builtins/edit-tool.js";
import { readFileTool, listDirectoryTool } from "../../src/tools/builtins/filesystem-tools.js";
import { grepTool } from "../../src/tools/builtins/grep-tool.js";
import { searchTool } from "../../src/tools/builtins/search-tool.js";
import { planTool } from "../../src/tools/builtins/plan-tool.js";
import { createFrameworkFeedbackTool, FrameworkFeedbackStore } from "../../src/tools/builtins/framework-feedback-tool.js";
import { createExecTool, createWriteStdinTool } from "../../src/tools/builtins/exec-tool.js";
import { ExecProcessManager } from "../../src/tools/builtins/exec-process-manager.js";
import { createAgentTool } from "../../src/agents/agent-tool.js";
import { createSubagentTools } from "../../src/tasks/subagent-tools.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import type { AgentEvent } from "../../src/types/events.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { ModelGateway } from "../../src/model/model-gateway.js";
import { SessionImageStore, resolveContextImage } from "../../src/core/session-images.js";
import { loadNeoPlugins } from "../../src/plugins/plugin-system.js";

async function fixture(t: TestContext, withPlugins = false) {
  // Windows CI may expose TEMP through an 8.3 alias; security readers require canonical paths.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "neo-demo-")));
  const taskStore = new TaskStore(), processes = new ExecProcessManager(), tools = new ToolRegistry();
  let realCalls = 0;
  const real: ModelGateway = { async *stream() { realCalls++; throw new Error("Real API must not be called"); } };
  for (const tool of [editTool, writeTool, readFileTool, listDirectoryTool, grepTool, searchTool, planTool, createExecTool({ processManager: processes }), createWriteStdinTool(processes), createAgentTool({ modelGateway: real, tools, taskStore }), ...createSubagentTools(taskStore)]) tools.register(tool);
  const plugins = withPlugins ? await loadNeoPlugins({ directories: path.resolve('../web/plugins'), appDataDir: path.join(root, 'plugins'), env: {} }) : [];
  for (const plugin of plugins) for (const tool of plugin.tools) tools.register(tool);
  const engine = new QueryEngine({ modelGateway: real, tools, cwd: root, model: "gpt-test", session: { rootDir: root, sessionId: "demo-session", resume: false } });
  await engine.initialize();
  taskStore.bindSession(engine.snapshot().session!.sessionDir);
  tools.register(createFrameworkFeedbackTool(new FrameworkFeedbackStore(path.join(root, 'feedback'))));
  const backend = new DemoTools(tools, taskStore, processes);
  assert.equal(backend.registry.get('framework_feedback'), undefined, 'offline demo must not fabricate submitted opinions');
  const waits: number[] = [];
  const demo = new DemoMode(backend, async ms => { waits.push(ms); });
  const runtime = { engine, tools, taskStore, execProcessManager: processes, modelGateway: real, agentRuntime: { modelGateway: real, tools, taskStore }, usage: new SessionUsageTracker(), initialMetrics: await engine.contextMetrics(), envPath: path.join(root, ".env") } as unknown as WebRuntime;
  t.after(async () => { demo.stop(); await fs.rm(root, { force: true, recursive: true }); });
  return { root, engine, backend, demo, waits, runtime, plugins, realCalls: () => realCalls };
}

async function settle(repl: WebRepl) {
  await (repl as unknown as { foregroundRun?: Promise<void> }).foregroundRun;
}

test("full demo reuses query, tool, image, task and compaction infrastructure with two spaced checkpoints", async t => {
  const f = await fixture(t);
  f.engine.setSimulation(f.demo);
  const events: AgentEvent[] = [];
  for await (const event of f.engine.sendUserText(DEMO_PROMPT)) events.push(event);
  const failures = events.filter(e => e.type === "message").flatMap(e => e.type === "message" ? e.message.blocks : []).filter(b => b.type === "tool_result" && !b.ok);
  assert.deepEqual(failures, []);
  for (const name of DEMO_SYSTEM_TOOLS) assert.ok((f.backend.counts.get(name) ?? 0) >= 2, `${name} must run at least twice`);
  const compacts = events.flatMap((e, i) => e.type === "context.compacted" ? [i] : []);
  assert.equal(compacts.length, 2);
  assert.ok(events.slice(compacts[0] + 1, compacts[1]).filter(e => e.type === "assistant.delta").length >= 4);
  assert.ok(events.slice(compacts[1] + 1).some(e => e.type === "assistant.delta"));
  assert.ok(events.some(e => e.type === "state" && e.phase === "compacting"));
  assert.ok(events.some(e => e.type === "tool.progress"));
  assert.equal(f.demo.compactionCount, 2);
  assert.ok(f.waits.length > 15);
  assert.ok(f.waits.every(ms => ms === DEMO_RESPONSE_INTERVAL_MS && ms === 3000));
  assert.equal(f.realCalls(), 0);
  const session = f.engine.snapshot().session!;
  const transcript = (await fs.readFile(session.transcriptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(transcript.filter(e => e.type === "compact").length, 2);
  const store = await SessionImageStore.open(session.sessionDir);
  assert.ok(resolveContextImage({ imageStore: store }, f.backend.firstImage).data);
  assert.equal(f.runtime.taskStore.list().length, 2);
  assert.ok(f.runtime.taskStore.list().every(task => task.status === "completed"));
  assert.equal(f.runtime.execProcessManager.listHistory(session.sessionId).ok, true);
  assert.equal(await fs.stat(path.join(f.root, "demo")).then(() => true, () => false), false, "simulated file tools do not touch workspace");
  assert.ok(f.engine.getTimingRecords().some(record => record.kind === "tool"));
});

test("Web demo atomically requires empty idle session and records user inputs without model calls, including after reload", async t => {
  const f = await fixture(t);
  const repl = new WebRepl(f.runtime, { wait: async () => {} });
  const sessionId = f.engine.snapshot().session!.sessionId;
  assert.equal((await repl.startDemo("other-session")).ok, false);
  const start = repl.startDemo(sessionId);
  assert.equal((await repl.startDemo(sessionId)).ok, false);
  assert.equal((await start).ok, true);
  assert.equal(repl.snapshot().demoMode, true);
  assert.deepEqual(await repl.submit("这条消息只记录，不回复"), { ok: true });
  assert.deepEqual(await repl.submitImmediately("/reset"), { ok: true, interrupted: false });
  const imageId = 'image_12345678-1234-4234-8234-123456789abc';
  assert.equal((await repl.submit('附图只记录 user attachment', [{ kind: 'image', imageId, label: 'user attachment', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFqkAAAAASUVORK5CYII=' }])).ok, true);
  await settle(repl);
  assert.ok(repl.imagePayloadById(imageId), 'submitted image should be readable');
  await repl.submit('附带文件', [{ kind: 'file', name: 'note.txt', absolutePath: path.join(f.root, 'note.txt'), mimeType: 'text/plain', size: 4 }]);
  assert.ok(f.engine.getDisplayEntries().some(entry => entry.type === 'message' && entry.message.blocks.some(block => block.type === 'text' && block.text.includes('<<ATTACHMENT_MANIFEST>>'))), 'file attachment metadata is retained');
  const before = repl.snapshot().lines.filter(line => line.kind === "assistant").length;
  await repl.submit("演示结束后也不回复");
  assert.equal(repl.snapshot().lines.filter(line => line.kind === "assistant").length, before);
  assert.ok(repl.snapshot().lines.some(line => line.kind === "user" && line.text === "/reset"));
  assert.equal(repl.snapshot().queuedInput, undefined);
  assert.equal(repl.snapshot().lines.filter(line => line.compaction).length, 2);
  assert.ok(repl.snapshot().lines.filter(line => line.compaction).every(line => line.collapsible === false));
  assert.equal(f.realCalls(), 0);
  const reloaded = f.engine.forkForSession(sessionId, true);
  await reloaded.initialize();
  const replay = new WebRepl({ ...f.runtime, engine: reloaded });
  assert.equal(replay.snapshot().demoMode, true);
  assert.ok(replay.imagePayloadById(imageId), 'submitted image survives reload');
  assert.ok(replay.snapshot().lines.some(line => line.text === "演示结束后也不回复"));
  await replay.submit("reload input");
  assert.equal(f.realCalls(), 0);
  assert.ok(!reloaded.getHistoryMessages().some(message => message.blocks.some(block => block.type === "text" && block.text === "reload input")));
  await replay.newSession();
  assert.equal(replay.snapshot().demoMode, false);
  assert.equal((await repl.startDemo(sessionId)).ok, false);
});

test("nonempty session is rejected without mutating history", async t => {
  const f = await fixture(t);
  await f.engine.recordDisplayMessage(createTextMessage("user", "existing"));
  const repl = new WebRepl(f.runtime);
  const before = f.engine.getDisplayEntries();
  assert.equal((await repl.startDemo(f.engine.snapshot().session!.sessionId)).ok, false);
  assert.deepEqual(f.engine.getDisplayEntries(), before);
  assert.equal(f.realCalls(), 0);
});

test("interrupt cancels the pending simulated response and never falls through to real provider", async t => {
  const f = await fixture(t);
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  const repl = new WebRepl(f.runtime, { wait: (_ms, signal) => new Promise((_resolve, reject) => {
    waiting();
    if (signal.aborted) reject(new Error("stopped"));
    else signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  }) });
  await repl.startDemo(f.engine.snapshot().session!.sessionId);
  await ready;
  await repl.submit("still only record");
  assert.equal(repl.snapshot().busy, true);
  await repl.interrupt();
  assert.equal(repl.snapshot().busy, false);
  await repl.submit("after stop");
  assert.equal(f.realCalls(), 0);
});

test("installed resource plugins use real local stores and every registered tool runs twice", async t => {
  const f = await fixture(t, true);
  await f.backend.prepare(f.engine.snapshot().session!.sessionDir);
  f.engine.setSimulation(f.demo);
  const results: Array<{ name: string; ok: boolean; output: any }> = [];
  for await (const event of f.engine.sendUserText(DEMO_PROMPT)) if (event.type === "message") {
    for (const block of event.message.blocks) if (block.type === "tool_result") results.push(block);
  }
  assert.deepEqual(results.filter(result => !result.ok), []);
  for (const name of f.backend.registry.names()) assert.ok((f.backend.counts.get(name) ?? 0) >= 2, name);
  assert.equal(f.demo.compactionCount, 2);
  assert.equal(f.realCalls(), 0);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    for (const plugin of f.plugins) if (await plugin.route?.(req, res, url, {})) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const download = results.find(result => result.name === 'expose_downloads')!.output.downloads[0];
  const response = await fetch(new URL(download.url, origin));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Aurora/);
  const video = results.filter(result => result.name === 'expose_videos').at(-1)!.output.videos[0];
  const media = await fetch(new URL(video.mediaUrl, origin));
  assert.equal(media.status, 200);
  assert.equal((await media.arrayBuffer()).byteLength, Buffer.from((await import('../../src/web/demo-video.js')).DEMO_VIDEO_BASE64, 'base64').length);
  for (const result of results.filter(result => result.name === 'open_xhs_artifact_editor')) {
    const artifact = result.output.artifact;
    const saved = await fetch(`${origin}/api/xhs-artifacts/${artifact.id}?sessionId=${encodeURIComponent(f.engine.snapshot().session!.sessionId)}`);
    assert.equal(saved.status, 200);
    assert.ok(await saved.json());
  }
  const repl = new WebRepl(f.runtime);
  for (const task of f.runtime.taskStore.list()) {
    const page = await repl.agentContent(f.engine.snapshot().session!.sessionId, 'timeline', { taskId: task.id, runGeneration: task.runGeneration });
    assert.equal(page?.state, 'complete');
    assert.ok(page?.items?.some(item => item.kind === 'assistant'));
  }
});

test("stopping during startup prevents all simulated responses and leaves no busy reservation", async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.engine.recordDisplayMessage.bind(f.engine);
  f.engine.recordDisplayMessage = async message => { await gate; return original(message); };
  let waits = 0;
  const repl = new WebRepl(f.runtime, { wait: async () => { waits++; } });
  const pending = repl.startDemo(f.engine.snapshot().session!.sessionId);
  await repl.interrupt();
  release();
  assert.equal((await pending).ok, false);
  assert.equal(repl.snapshot().busy, false);
  assert.equal(waits, 0);
  assert.equal(f.realCalls(), 0);
});

test("switching away cancels demo, does not leak simulation, and original session stays record-only", async t => {
  const f = await fixture(t);
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const repl = new WebRepl(f.runtime, { wait: (_ms, signal) => new Promise((_resolve, reject) => {
    ready();
    if (signal.aborted) reject(new Error('stopped'));
    else signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }) });
  const sessionId = f.engine.snapshot().session!.sessionId;
  await repl.startDemo(sessionId);
  await waiting;
  assert.equal((await repl.newSession()).ok, true);
  assert.equal(repl.snapshot().demoMode, false);
  assert.equal(repl.snapshot().busy, false);
  assert.equal((await repl.resumeSession(sessionId)).ok, true);
  assert.equal(repl.snapshot().demoMode, true);
  await repl.submit('record only after switch');
  assert.equal(f.realCalls(), 0);
});
