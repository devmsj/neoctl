import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore } from "../tasks/task-store.js";
import { agentRunDurationMs, createLocalAgentTask, updateProgressFromEvent, updateProgressFromMessage, type AgentToolResult } from "./local-agent-task.js";
import { createAgentTool, resumeAgentTask, type AgentToolRuntime } from "./agent-tool.js";
import { AgentActivityStore } from "./agent-activity.js";
import { GENERAL_PURPOSE_AGENT, StaticAgentCatalog } from "./agent-definition.js";
import { InMemoryAppState } from "../app/app-state.js";
import { ToolRegistry } from "../tools/registry.js";
import { finalizeAgentTool } from "../core/run-agent.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { ModelGateway, ModelStreamEvent } from "../model/model-gateway.js";

const report = (content = "allowed partial"): AgentToolResult => ({ agent_id: "worker", agent_type: "fake", content, status: "completed", total_duration_ms: 999999, total_tool_use_count: 1 });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "neo-obs07-11-"));
  const store = new TaskStore(); store.bindSession(root);
  const task = createLocalAgentTask({ taskId: "task", agentId: "worker", prompt: "original prompt", description: "scope", outputFile: path.join(root, "output.txt"), abortController: new AbortController() });
  task.createdAt = "1990-01-01T00:00:00.000Z";
  store.upsert(task);
  return { root, store, task, close: () => { store.flush(); rmSync(root, { recursive: true, force: true }); } };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
  throw new Error("Timed out waiting for simulated runner");
}
function gate() { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; }

for (const terminal of ["completed", "failed", "killed"] as const) test(`real TaskStore: ${terminal} freezes every generation, retains eight and rejects late callbacks`, () => {
  const f = fixture();
  try {
    const { store, task } = f;
    for (let generation = 1; generation <= 11; generation++) {
      assert.equal(task.startedAt, undefined); assert.equal(task.durationMs, undefined); assert.equal(task.completedAt, undefined);
      store.markRunning(task.id, generation);
      assert.notEqual(task.startedAt, task.createdAt);
      const start = task.startedAt!;
      store.markRunning(task.id, generation); assert.equal(task.startedAt, start);
      assert.equal(agentRunDurationMs(task, Date.parse(start) + 71), 71);
      if (terminal === "completed") store.complete(task.id, report(), generation);
      else if (terminal === "failed") store.fail(task.id, "failed reason", report(), generation);
      else store.kill(task.id, "stopped reason", report(), generation);
      const frozen = structuredClone({ startedAt: task.startedAt, completedAt: task.completedAt, durationMs: task.durationMs });
      assert.equal(frozen.durationMs, Date.parse(frozen.completedAt!) - Date.parse(start));
      assert.notEqual(frozen.durationMs, task.result?.total_duration_ms);
      assert.equal(agentRunDurationMs(task, Date.now() + 999999), frozen.durationMs);
      store.kill(task.id, "duplicate stop", report("duplicate"), generation);
      store.complete(task.id, report("duplicate"), generation);
      assert.deepEqual({ startedAt: task.startedAt, completedAt: task.completedAt, durationMs: task.durationMs }, frozen);
      assert.equal(task.status, terminal); assert.equal(task.result?.content, "allowed partial");
      assert.equal(task.result?.status, terminal === "completed" ? "completed" : "incomplete");
      store.prepareResume(task.id, new AbortController());
      assert.deepEqual({ startedAt: task.runHistory!.at(-1)!.startedAt, completedAt: task.runHistory!.at(-1)!.completedAt, durationMs: task.runHistory!.at(-1)!.durationMs }, frozen);
      assert.equal(task.runHistory!.length, Math.min(8, generation));
      assert.equal(task.result, undefined); assert.equal(task.error, undefined);
      store.markRunning(task.id, generation);
      store.complete(task.id, report("late completed"), generation);
      store.fail(task.id, "late failed", report("late failed"), generation);
      store.kill(task.id, "late stopped", report("late stopped"), generation);
      assert.equal(task.status, "pending"); assert.equal(task.startedAt, undefined); assert.equal(task.result, undefined);
      assert.equal(task.abortController!.signal.aborted, false);
    }
    assert.equal(task.prompt, "original prompt");
    assert.deepEqual(task.runHistory!.map(r => r.runGeneration), [4, 5, 6, 7, 8, 9, 10, 11]);
  } finally { f.close(); }
});

test("same-generation late partial enriches stopped task without moving frozen terminal facts; reentrant resume cannot be killed", () => {
  const f = fixture();
  try {
    const { store, task } = f; store.markRunning(task.id, 1); store.kill(task.id, "stop", undefined, 1);
    const end = task.completedAt, duration = task.durationMs;
    store.kill(task.id, "late reason", report(), 1);
    assert.equal(task.error, "stop"); assert.equal(task.completedAt, end); assert.equal(task.durationMs, duration); assert.equal(task.result?.status, "incomplete");
    store.prepareResume(task.id, new AbortController()); store.markRunning(task.id, 2);
    const controller = task.abortController!;
    controller.signal.addEventListener("abort", () => { store.prepareResume(task.id, new AbortController()); store.markRunning(task.id, 3); });
    store.kill(task.id, "stop two", undefined, 2);
    assert.equal(task.runGeneration, 3); assert.equal(task.status, "running"); assert.equal(task.abortController!.signal.aborted, false);
  } finally { f.close(); }
});

test("legacy/malformed/rollback timestamps remain unknown, including missing frozen duration and valid zero", () => {
  const f = fixture();
  try {
    for (const start of [undefined, "bad", "0", "2026-02-30T00:00:00.000Z", "2999-01-01T00:00:00.000Z"]) {
      f.task.status = "running"; f.task.startedAt = start;
      f.store.fail(f.task.id, "failure", undefined, f.task.runGeneration);
      assert.equal(f.task.durationMs, undefined); assert.equal(agentRunDurationMs(f.task), undefined);
      f.store.prepareResume(f.task.id, new AbortController());
      assert.equal(f.task.runHistory!.at(-1)!.durationMs, undefined);
    }
    const startedAt = "2026-09-07T00:00:00.000Z";
    for (const status of ["completed", "failed", "killed"] as const) {
      assert.equal(agentRunDurationMs({ status, startedAt, completedAt: startedAt, durationMs: 0 }), 0);
      assert.equal(agentRunDurationMs({ status, startedAt, completedAt: startedAt }), undefined);
      assert.equal(agentRunDurationMs({ status, startedAt, completedAt: "bad", durationMs: 0 }), undefined);
      assert.equal(agentRunDurationMs({ status, startedAt, completedAt: startedAt, durationMs: NaN }), undefined);
    }
    assert.equal(agentRunDurationMs({ status: "running", startedAt }, NaN), undefined);
    assert.equal(agentRunDurationMs({ status: "running", startedAt }, Date.parse(startedAt) - 1), undefined);
  } finally { f.close(); }
});

test("fresh TaskStore rereads current/history timing and partial report; legacy record does not invent a start", () => {
  const f = fixture();
  try {
    const { task, store } = f;
    store.markRunning(task.id, 1); store.fail(task.id, "first failure", report("first partial"), 1);
    const first = { startedAt: task.startedAt, completedAt: task.completedAt, durationMs: task.durationMs };
    store.prepareResume(task.id, new AbortController()); store.markRunning(task.id, 2); store.kill(task.id, "second stop", report("second partial"), 2);
    const fresh = new TaskStore(); assert.deepEqual(fresh.bindSession(f.root).errors, []);
    const restored = fresh.get(task.id)!;
    assert.equal(restored.startedAt, task.startedAt); assert.equal(restored.durationMs, task.durationMs);
    assert.deepEqual({ startedAt: restored.runHistory![0].startedAt, completedAt: restored.runHistory![0].completedAt, durationMs: restored.runHistory![0].durationMs }, first);
    assert.equal(restored.result?.content, "second partial"); assert.equal(restored.result?.status, "incomplete");
    assert.equal(restored.runHistory![0].result?.content, "first partial");
    const file = path.join(f.root, "subagents", task.agentId, "task.json");
    const raw = JSON.parse(readFileSync(file, "utf8")); delete raw.startedAt; delete raw.durationMs;
    writeFileSync(file, JSON.stringify(raw));
    const legacy = new TaskStore(); legacy.bindSession(f.root);
    assert.equal(legacy.get(task.id)?.startedAt, undefined); assert.equal(agentRunDurationMs(legacy.get(task.id)!), undefined);
  } finally { f.close(); }
});

function runtime(root: string, store: TaskStore, gateway: ModelGateway): { rt: AgentToolRuntime; parent: ToolUseContext } {
  return {
    parent: { agentId: "parent", messages: [], appState: new InMemoryAppState("parent", root), session: { sessionId: "parent", sessionDir: root } } as unknown as ToolUseContext,
    rt: { modelGateway: gateway, tools: new ToolRegistry(), taskStore: store, agentActivityStore: new AgentActivityStore(),
      agentCatalog: new StaticAgentCatalog([{ ...GENERAL_PURPOSE_AGENT, requiresReport: false, reportRetryTurns: 0 }]),
      contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-09-07" }, systemContext: { cwd: root, platform: process.platform } }; } },
      compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    },
  };
}
for (const background of [false, true]) for (const outcome of ["failed", "killed"] as const) for (const source of ["report", "visible", "hidden"] as const) test(`real lifecycle ${background ? "async" : "sync"} ${outcome} preserves only ${source} partial`, async () => {
  const f = fixture(); const stopGate = gate();
  try {
    const { rt, parent } = runtime(f.root, f.store, { async *stream() { throw new Error("mock runner must not call model"); } });
    rt.runAgent = async function* (options) {
      assert.equal(options.runGeneration, 1);
      const messages: Message[] = [];
      if (source === "report") {
        const m = createTextMessage("tool_result", "");
        m.blocks = [{ type: "tool_result", toolUseId: "draft", name: "subagent_report", ok: true, output: { report: "# Allowed draft\n\n  code", status: "draft", final: false } }];
        messages.push(m); yield { type: "message", message: m };
      }
      const m = createTextMessage("assistant", "NEVER REPORT HIDDEN TEXT");
      if (source === "visible") m.blocks.push({ type: "text", text: "Allowed visible partial", displayChannel: "visible" });
      m.blocks.push({ type: "thinking", text: "SECRET REASONING" });
      messages.push(m); yield { type: "message", message: m };
      await stopGate.wait;
      // Production finalizer intentionally has a broader legacy text fallback.
      const result = finalizeAgentTool({ agentId: options.agentId, agentType: options.agent.agentType, agent: options.agent, messages, durationMs: 99999 });
      return { status: outcome === "killed" ? "aborted" : "failed", result, messages, terminalReason: outcome === "killed" ? "aborted_streaming" : "model_error" };
    };
    const pending = createAgentTool(rt).call!({ prompt: "actual launch prompt", run_in_background: background }, parent, {});
    await until(() => f.store.list().some(t => t.id !== "task" && t.progress.lastText?.includes("NEVER REPORT")));
    const task = f.store.list().find(t => t.id !== "task")!;
    if (outcome === "killed") f.store.kill(task.id, "user stop", undefined, task.runGeneration);
    const killedEnd = task.completedAt, killedDuration = task.durationMs;
    stopGate.release();
    const call = await pending;
    await until(() => f.store.isTerminal(task) && (source === "hidden" || !!task.result)); await tick();
    assert.equal(task.status, outcome);
    assert.equal(task.result?.content, source === "report" ? "# Allowed draft\n\n  code" : source === "visible" ? "Allowed visible partial" : undefined);
    if (source !== "hidden") assert.equal(task.result?.status, "incomplete");
    assert(!(JSON.stringify(task.result) ?? "").includes("SECRET"));
    if (outcome === "killed") { assert.equal(task.completedAt, killedEnd); assert.equal(task.durationMs, killedDuration); }
    if (!background) { assert.equal(call.ok, false); assert.equal((call.output as any).status, outcome === "failed" ? "failed" : "cancelled"); }
    const fresh = new TaskStore(); fresh.bindSession(f.root);
    assert.deepEqual(fresh.get(task.id)?.result?.content, task.result?.content);
    assert.equal(task.prompt, "actual launch prompt");
  } finally { stopGate.release(); await tick(); f.close(); }
});

test("late stopped runner cannot overwrite resumed result, timing, progress or OBS04 generation", async () => {
  const f = fixture(); const old = gate(); let calls = 0;
  try {
    const gateway: ModelGateway = { async *stream(): AsyncIterable<ModelStreamEvent> {
      const n = ++calls;
      const m = createTextMessage("assistant", n === 1 ? "old visible" : "new visible");
      (m.blocks[0] as { displayChannel?: string }).displayChannel = "visible";
      yield { type: "assistant_message", message: m };
      if (n === 1) await old.wait;
      yield { type: "response_completed", stopReason: "completed" };
    } };
    const { rt, parent } = runtime(f.root, f.store, gateway);
    await createAgentTool(rt).call!({ prompt: "unchanged", run_in_background: true }, parent, {});
    await until(() => f.store.list().some(t => t.progress.lastText === "old visible"));
    const task = f.store.list().find(t => t.id !== "task")!;
    f.store.kill(task.id, "stop", undefined, 1);
    await resumeAgentTask(task.id, "continue exactly", rt, f.store, parent);
    await until(() => task.status === "completed");
    const before = JSON.stringify({ result: task.result, startedAt: task.startedAt, completedAt: task.completedAt, durationMs: task.durationMs, progress: task.progress, history: task.runHistory });
    old.release(); await tick(); await tick();
    assert.equal(JSON.stringify({ result: task.result, startedAt: task.startedAt, completedAt: task.completedAt, durationMs: task.durationMs, progress: task.progress, history: task.runHistory }), before);
    assert.equal(task.runGeneration, 2); assert.equal(task.prompt, "unchanged"); assert.equal(task.result?.content, "new visible");
    const entries = readFileSync(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const generations = entries.filter(e => e.type === "message" && e.message.role === "assistant").map(e => e.runGeneration);
    assert.deepEqual(generations, [1, 2]);
  } finally { old.release(); await tick(); f.close(); }
});

for (const background of [false, true]) test(`simulated runner ${background ? "async" : "sync"} multi-round failure/abort/completion freezes and clears previous results`, async () => {
  const f = fixture(); const gates = [gate(), gate(), gate()];
  try {
    const { rt, parent } = runtime(f.root, f.store, { async *stream() { throw new Error("mock only"); } });
    rt.runAgent = async function* (options) {
      const generation = options.runGeneration!;
      const message = createTextMessage("tool_result", "");
      message.blocks = [{ type: "tool_result", toolUseId: `report-${generation}`, name: "subagent_report", ok: true, output: { report: `round ${generation}`, status: "completed", final: true } }];
      yield { type: "message", message };
      await gates[generation - 1].wait;
      return { status: generation === 1 ? "failed" : generation === 2 ? "aborted" : "completed", messages: [message],
        result: finalizeAgentTool({ agentId: options.agentId, agentType: options.agent.agentType, messages: [message], durationMs: 99999 }),
        terminalReason: generation === 1 ? "model_error" : generation === 2 ? "aborted_streaming" : "completed" };
    };
    const launch = createAgentTool(rt).call!({ prompt: "keep prompt", run_in_background: background }, parent, {});
    await until(() => f.store.list().some(t => t.id !== "task"));
    const task = f.store.list().find(t => t.id !== "task")!;
    for (let generation = 1; generation <= 3; generation++) {
      assert.equal(task.runGeneration, generation); assert.equal(task.status, "running");
      assert(task.startedAt); assert.equal(task.completedAt, undefined); assert.equal(task.durationMs, undefined); assert.equal(task.result, undefined);
      gates[generation - 1].release(); await until(() => f.store.isTerminal(task));
      assert.equal(task.status, generation === 1 ? "failed" : generation === 2 ? "killed" : "completed");
      assert.equal(f.store.get(task.id)?.result?.content, `round ${generation}`); assert.equal(f.store.get(task.id)?.result?.status, generation < 3 ? "incomplete" : "completed");
      assert.equal(agentRunDurationMs(task, Date.now() + 100000), task.durationMs);
      const end = task.completedAt, duration = task.durationMs, start = task.startedAt;
      if (generation < 3) {
        await resumeAgentTask(task.id, `directive ${generation + 1}`, rt, f.store, parent);
        assert.equal(task.runHistory!.at(-1)!.startedAt, start); assert.equal(task.runHistory!.at(-1)!.completedAt, end); assert.equal(task.runHistory!.at(-1)!.durationMs, duration);
      }
    }
    await launch; assert.equal(task.prompt, "keep prompt");
    const fresh = new TaskStore(); fresh.bindSession(f.root);
    assert.equal(fresh.get(task.id)?.result?.content, "round 3");
    assert.deepEqual(fresh.get(task.id)?.runHistory?.map(r => [r.status, r.result?.status, r.result?.content]), [["failed", "incomplete", "round 1"], ["killed", "incomplete", "round 2"]]);
  } finally { gates.forEach(g => g.release()); await tick(); f.close(); }
});

test("OBS04 live visibleText accepts only marked deltas in the captured current generation; never final-message fallback", () => {
  const f = fixture();
  try {
    const { task, store } = f; store.markRunning(task.id, 1);
    task.progress.lastText = "SECRET mixed legacy";
    updateProgressFromEvent(task, { type: "assistant.delta", text: "unmarked analysis" }, 1);
    assert.equal(task.progress.visibleText, undefined);
    updateProgressFromEvent(task, { type: "assistant.delta", text: "missing generation", displayChannel: "visible" });
    assert.equal(task.progress.visibleText, undefined);
    updateProgressFromEvent(task, { type: "assistant.delta", text: "  hello\n\n", displayChannel: "visible" }, 1);
    assert.deepEqual(task.progress.visibleText, { redactionVersion: 1, channel: "visible", runGeneration: 1, text: "  hello\n\n", truncated: false });
    const message = createTextMessage("assistant", "MIXED SECRET");
    message.blocks.push({ type: "text", text: "final visible must not duplicate", displayChannel: "visible" });
    message.blocks.push({ type: "thinking", text: "reasoning" });
    updateProgressFromMessage(task, message);
    assert.equal(store.get(task.id)?.progress.visibleText?.text, "  hello\n\n");
    updateProgressFromEvent(task, { type: "assistant.delta", text: "x".repeat(4100), displayChannel: "visible" }, 1);
    assert.equal(store.get(task.id)?.progress.visibleText?.text, "x".repeat(4000)); assert.equal(store.get(task.id)?.progress.visibleText?.truncated, true);
    store.fail(task.id, "end", undefined, 1); store.prepareResume(task.id, new AbortController());
    assert.equal(task.progress.visibleText, undefined); store.markRunning(task.id, 2);
    updateProgressFromEvent(task, { type: "assistant.delta", text: "late", displayChannel: "visible" }, 1);
    assert.equal(task.progress.visibleText, undefined);
    updateProgressFromEvent(task, { type: "assistant.delta", text: "\n  next", displayChannel: "visible" }, 2);
    assert.deepEqual(task.progress.visibleText, { redactionVersion: 1, channel: "visible", runGeneration: 2, text: "\n  next", truncated: false });
    assert.equal(task.runHistory![0].progress.visibleText?.runGeneration, 1);
  } finally { f.close(); }
});

test("DTO round-trip current/history visible preview and timing; corrupt preview/timestamps never gain trust", () => {
  const f = fixture();
  try {
    const { task, store } = f;
    store.markRunning(task.id, 1);
    updateProgressFromEvent(task, { type: "assistant.delta", text: "  first\n", displayChannel: "visible" }, 1);
    store.fail(task.id, "failed", report(), 1); store.prepareResume(task.id, new AbortController());
    store.markRunning(task.id, 2);
    updateProgressFromEvent(task, { type: "assistant.delta", text: "  second\n", displayChannel: "visible" }, 2);
    store.kill(task.id, "stopped", report(), 2);
    const fresh = new TaskStore(); assert.deepEqual(fresh.bindSession(f.root).errors, []);
    assert.deepEqual(fresh.get(task.id)?.progress.visibleText, { redactionVersion: 1, channel: "visible", runGeneration: 2, text: "  second\n", truncated: false });
    assert.deepEqual(fresh.get(task.id)?.runHistory?.[0].progress.visibleText, { redactionVersion: 1, channel: "visible", runGeneration: 1, text: "  first\n", truncated: false });
    assert.equal(fresh.get(task.id)?.durationMs, task.durationMs);
    const file = path.join(f.root, "subagents", task.agentId, "task.json");
    const baseline = JSON.parse(readFileSync(file, "utf8"));
    const invalid = [undefined, { channel: "visible", runGeneration: 2, text: "0123456789", truncated: true },
      { redactionVersion: 0, channel: "visible", runGeneration: 2, text: "OLD", truncated: false },
      { redactionVersion: "1", channel: "visible", runGeneration: 2, text: "INVALID", truncated: false }, { redactionVersion: 1, channel: "analysis", runGeneration: 2, text: "SECRET", truncated: false },
      { redactionVersion: 1, channel: "visible", runGeneration: 1, text: "WRONG ROUND", truncated: false },
      { redactionVersion: 1, channel: "visible", runGeneration: 2.5, text: "INVALID", truncated: false },
      { redactionVersion: 1, channel: "visible", runGeneration: "2", text: "INVALID", truncated: false },
      { redactionVersion: 1, runGeneration: 2, text: "UNMARKED", truncated: false },
      { redactionVersion: 1, channel: "visible", runGeneration: 2, text: 123, truncated: false },
      { redactionVersion: 1, channel: "visible", runGeneration: 2, text: "INVALID", truncated: "false" }];
    for (const preview of invalid) {
      const raw = structuredClone(baseline); raw.progress.visibleText = preview; raw.progress.lastText = "SECRET FALLBACK";
      raw.startedAt = "2026-02-30T00:00:00.000Z"; raw.durationMs = -9;
      raw.runHistory[0].progress.visibleText = { redactionVersion: 1, channel: "visible", runGeneration: 2, text: "WRONG ARCHIVE", truncated: false };
      writeFileSync(file, JSON.stringify(raw));
      const restored = new TaskStore(); assert.deepEqual(restored.bindSession(f.root).errors, []);
      assert.equal(restored.get(task.id)?.progress.visibleText, undefined);
      assert.equal(restored.get(task.id)?.runHistory?.[0].progress.visibleText, undefined);
      assert.equal(restored.get(task.id)?.startedAt, undefined); assert.equal(restored.get(task.id)?.durationMs, undefined);
    }
    const raw = structuredClone(baseline);
    raw.progress.visibleText.text = " ".repeat(4500); raw.progress.visibleText.extraSecret = "MUST OMIT";
    writeFileSync(file, JSON.stringify(raw));
    const bounded = new TaskStore(); bounded.bindSession(f.root);
    assert.deepEqual(bounded.get(task.id)?.progress.visibleText, { redactionVersion: 1, channel: "visible", runGeneration: 2, text: " ".repeat(4000), truncated: true });
  } finally { f.close(); }
});

for (const running of [false, true]) test(`recover ${running ? "running" : "pending"} interruption preserves actual start only, never fabricates stop at reload`, () => {
  const f = fixture();
  try {
    if (running) {
      f.store.markRunning(f.task.id, 1);
      updateProgressFromEvent(f.task, { type: "assistant.delta", text: "safe preview", displayChannel: "visible" }, 1);
      f.store.upsert(f.task);
    }
    const startedAt = f.task.startedAt;
    for (let n = 0; n < 2; n++) {
      const fresh = new TaskStore(); const summary = fresh.bindSession(f.root);
      assert.equal(summary.interrupted, n === 0 ? 1 : 0);
      const restored = fresh.get(f.task.id)!;
      assert.equal(restored.status, "killed"); assert.equal(restored.startedAt, startedAt);
      assert.equal(restored.completedAt, undefined); assert.equal(restored.durationMs, undefined);
      assert.equal(agentRunDurationMs(restored), undefined);
      if (running) assert.equal(restored.progress.visibleText?.text, "safe preview");
      if (n === 1) {
        fresh.prepareResume(restored.id, new AbortController());
        assert.equal(restored.runHistory![0].completedAt, undefined); assert.equal(restored.runHistory![0].durationMs, undefined);
        fresh.markRunning(restored.id, 2); fresh.complete(restored.id, report(), 2);
        assert.equal(typeof restored.durationMs, "number");
      }
    }
  } finally { f.close(); }
});
