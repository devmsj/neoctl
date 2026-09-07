import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../tasks/task-store.js";
import { createAgentTool, resumeAgentTask, type AgentToolRuntime } from "./agent-tool.js";
import { AgentActivityStore } from "./agent-activity.js";
import { GENERAL_PURPOSE_AGENT, StaticAgentCatalog } from "./agent-definition.js";
import { InMemoryAppState } from "../app/app-state.js";
import { ToolRegistry } from "../tools/registry.js";
import { finalizeAgentTool } from "../core/run-agent.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { ModelGateway } from "../model/model-gateway.js";
import { InMemorySecretRedactionRegistry } from "../secrets/secret-redaction.js";
import { normalizeResponsesObject } from "../model/openai-responses-mapper.js";

const tick = () => new Promise<void>(r => setTimeout(r, 5));
async function until(check: () => boolean) { for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); } throw new Error("fixture timeout"); }
function gate() { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; }
const visible = (text: string): Message => ({ ...createTextMessage("assistant", text), blocks: [{ type: "text", text, displayChannel: "visible" }] });
async function fixture(gateway: ModelGateway, reportRetryTurns = 0) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "neo-report-security-")));
  const store = new TaskStore(); store.bindSession(root);
  const rt: AgentToolRuntime = { modelGateway: gateway, tools: new ToolRegistry(), taskStore: store, agentActivityStore: new AgentActivityStore(),
    agentCatalog: new StaticAgentCatalog([{ ...GENERAL_PURPOSE_AGENT, requiresReport: true, reportRetryTurns }]),
    contextManager: { async build() { return { systemPrompt: "synthetic", promptSections: [], userContext: { currentDate: "2026-09-07" }, systemContext: { cwd: root, platform: process.platform } }; } },
    compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
  };
  const parent = { agentId: "parent", messages: [visible("INHERITED_PRIVATE")], appState: new InMemoryAppState("parent", root), session: { sessionId: "parent", sessionDir: root } } as unknown as ToolUseContext;
  return { root, store, rt, parent, async close() { store.flush(); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const background of [false, true]) test(`normal ${background ? "async" : "sync"} completion cannot promote analysis fallback`, async () => {
  const f = await fixture({ async *stream() {
    yield* normalizeResponsesObject({ status: 200, headers: new Headers(), body: { status: "completed", output: [
      { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "PRIVATE_ANALYSIS_SENTINEL" }] },
    ] } });
  } });
  try {
    const call = await createAgentTool(f.rt).call!({ prompt: "synthetic", run_in_background: background }, f.parent, {});
    await until(() => f.store.list().some(t => t.status === "completed"));
    const task = f.store.list()[0]!;
    assert(!task.result!.content.includes("PRIVATE_ANALYSIS_SENTINEL"));
    assert(!JSON.stringify(call.output).includes("PRIVATE_ANALYSIS_SENTINEL"));
    assert.equal(task.result!.status, "incomplete");
  } finally { await f.close(); }
});

for (const background of [false, true]) for (const outcome of ["throw", "error-event", "abort"] as const) test(`real ${background ? "async" : "sync"} ${outcome}: persist safe delta partial without final message`, async () => {
  const g = gate(); let calls = 0;
  const text = "VISIBLE_PARTIAL_" + "x".repeat(5100) + "W"; // hold-back suffix must be flushed exactly once
  const f = await fixture({ async *stream() {
    calls++;
    yield { type: "assistant_delta", text: "HIDDEN_PREFIX" };
    yield { type: "assistant_delta", text, displayChannel: "visible" };
    yield { type: "thinking_delta", text: "HIDDEN_THINKING" };
    await g.wait;
    if (outcome === "error-event") { yield { type: "error", error: new Error("synthetic failure") }; return; }
    throw new Error("synthetic failure");
  } }, 1); // failure must not launch a report-recovery model turn and replace its terminal reason
  try {
    const pending = createAgentTool(f.rt).call!({ prompt: "synthetic", run_in_background: background }, f.parent, {});
    await until(() => f.store.list().some(t => t.progress.visibleText));
    const task = f.store.list()[0]!;
    if (outcome === "abort") f.store.kill(task.id, "synthetic stop", undefined, 1);
    g.release(); const call = await pending;
    await until(() => f.store.isTerminal(task)); await tick();
    assert.equal(task.status, outcome === "abort" ? "killed" : "failed");
    assert.equal(task.result?.content, text);
    assert.equal(task.result?.status, "incomplete");
    assert.equal(task.result?.displaySource, "visible_text");
    assert.equal(calls, 1);
    if (!background) assert.equal(call.ok, false);
    const entries = (await fs.readFile(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const saved = entries.filter(e => e.runGeneration === 1 && e.type === "message").flatMap(e => e.message.blocks).filter((b: any) => b.type === "text" && b.displayChannel === "visible");
    assert.equal(saved.map((b: any) => b.text).join(""), text);
    const fresh = new TaskStore(); fresh.bindSession(f.root); assert.equal(fresh.get(task.id)?.result?.content, text);
    assert.equal(fresh.get(task.id)?.result?.displaySource, "visible_text");
  } finally { g.release(); await tick(); await f.close(); }
});

test("finalized visible message is authoritative; no duplicate streamed fallback; meta/unmarked text is not a report", async () => {
  const f = await fixture({ async *stream() {
    yield { type: "assistant_delta", text: "PUBLIC", displayChannel: "visible" };
    yield { type: "assistant_message", message: visible("PUBLIC") };
    throw new Error("synthetic failure");
  } });
  try {
    await createAgentTool(f.rt).call!({ prompt: "synthetic" }, f.parent, {});
    const task = f.store.list()[0]!;
    assert.equal(task.result?.content, "PUBLIC");
    const text = await fs.readFile(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8");
    assert.equal(text.split('"text":"PUBLIC"').length - 1, 1);
    const result = finalizeAgentTool({ agentId: "x", agentType: "test", durationMs: 0, messages: [visible("SAFE"), createTextMessage("assistant", "UNMARKED"), { ...visible("META_PRIVATE"), isMeta: true }] });
    assert.equal(result.content, "SAFE");
  } finally { await f.close(); }
});

for (const background of [false, true]) test(`late ${background ? "async" : "sync"} aborted delta cannot contaminate resumed generation`, async () => {
  const old = gate(); let calls = 0;
  const f = await fixture({ async *stream() {
    const n = ++calls;
    yield { type: "assistant_delta", text: n === 1 ? "OLD_PARTIAL" : "NEW_PARTIAL", displayChannel: "visible" };
    if (n === 1) await old.wait;
    throw new Error("synthetic failure");
  } });
  try {
    const pending = createAgentTool(f.rt).call!({ prompt: "synthetic", run_in_background: background }, f.parent, {});
    await until(() => f.store.list().some(t => t.progress.visibleText)); const task = f.store.list()[0]!;
    f.store.kill(task.id, "stop", undefined, 1);
    await resumeAgentTask(task.id, "next", f.rt, f.store, f.parent);
    await until(() => task.runGeneration === 2 && task.status === "failed");
    assert.equal(task.result?.content, "NEW_PARTIAL");
    const before = JSON.stringify({ result: task.result, progress: task.progress, completedAt: task.completedAt, history: task.runHistory });
    old.release(); await pending; await tick(); await tick();
    assert.equal(JSON.stringify({ result: task.result, progress: task.progress, completedAt: task.completedAt, history: task.runHistory }), before);
    const entries = (await fs.readFile(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    for (const e of entries.filter(e => e.runGeneration === 2)) assert(!JSON.stringify(e).includes("OLD_PARTIAL"));
  } finally { old.release(); await tick(); await f.close(); }
});

for (const background of [false, true]) for (const finalized of [false, true]) test(`secret prefixes stay private in ${background ? "async" : "sync"} ${finalized ? "finalized" : "interrupted"} visible output`, async () => {
  const secret = "CREDENTIAL_SYNTHETIC_0123456789";
  const registry = new InMemorySecretRedactionRegistry(); registry.record("test", secret);
  const f = await fixture({ async *stream() {
    for (const text of ["SAFE ", secret.slice(0, 13), secret.slice(13), " END ", secret.slice(0, 10)])
      yield { type: "assistant_delta", text, displayChannel: "visible" };
    if (finalized) yield { type: "assistant_message", message: visible("SAFE " + secret + " END " + secret.slice(0, 10)) };
    throw new Error("synthetic failure");
  } });
  f.parent.secretRedactions = registry;
  try {
    await createAgentTool(f.rt).call!({ prompt: "synthetic", run_in_background: background }, f.parent, {});
    await until(() => f.store.list().some(t => t.status === "failed"));
    const task = f.store.list()[0]!;
    assert.equal(task.result?.content, "SAFE [secret:test] END [secret:incomplete]");
    assert(!JSON.stringify(task.result).includes(secret.slice(0, 10)));
    const entries = (await fs.readFile(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const saved = entries.filter(e => e.runGeneration === 1).flatMap(e => e.message?.blocks ?? []).filter((b: any) => b.displayChannel === "visible").map((b: any) => b.text).join("");
    assert.equal(saved, "SAFE [secret:test] END [secret:incomplete]");
  } finally { await f.close(); }
});

test("incomplete stream saves visible body once and keeps report incomplete", async () => {
  const f = await fixture({ async *stream() {
    yield { type: "assistant_delta", text: "PARTIAL_BEFORE_LIMIT", displayChannel: "visible" };
    yield { type: "response_incomplete", reason: "max_output_tokens" };
  } });
  try {
    const pending = createAgentTool(f.rt).call!({ prompt: "synthetic" }, f.parent, {});
    await pending;
    const task = f.store.list()[0]!;
    assert(task.result?.content.includes("PARTIAL_BEFORE_LIMIT"));
    assert.equal(task.result?.status, "incomplete");
  } finally { await f.close(); }
});

for (const background of [false, true]) test(`only half-credential then failure never reappears in ${background ? "async" : "sync"} partial`, async () => {
  const registry = new InMemorySecretRedactionRegistry(); const secret = "HALF_CREDENTIAL_SYNTHETIC_012345";
  registry.record("half", secret);
  const prefix = secret.slice(0, 15);
  const f = await fixture({ async *stream() { yield { type: "assistant_delta", text: prefix, displayChannel: "visible" }; throw new Error("synthetic failure"); } });
  f.parent.secretRedactions = registry;
  try {
    await createAgentTool(f.rt).call!({ prompt: "synthetic", run_in_background: background }, f.parent, {});
    await until(() => f.store.list().some(task => task.status === "failed"));
    const task = f.store.list()[0]!;
    assert.equal(task.result?.content, "[secret:incomplete]");
    assert.equal(task.result?.displaySource, "visible_text");
    const transcript = await fs.readFile(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8");
    assert(!transcript.includes(prefix));
    assert(!JSON.stringify(task.progress.visibleText).includes(prefix));
  } finally { await f.close(); }
});

test("provenance DTO does not authorize legacy/invalid values; current and archived sources survive restart", async () => {
  const f = await fixture({ async *stream() { yield { type: "assistant_message", message: visible("NEW_BODY") }; } });
  try {
    await createAgentTool(f.rt).call!({ prompt: "synthetic" }, f.parent, {});
    const task = f.store.list()[0]!;
    assert.equal(task.result?.displaySource, "visible_text");
    f.store.prepareResume(task.id, new AbortController()); f.store.markRunning(task.id, 2);
    const m = createTextMessage("tool_result", ""); m.blocks = [{ type: "tool_result", toolUseId: "report", name: "subagent_report", ok: true, output: { report: "EXPLICIT_REPORT", status: "completed", final: true } }];
    const result = finalizeAgentTool({ agentId: task.agentId, agentType: "test", durationMs: 0, messages: [m] });
    assert.equal(result.displaySource, "agent_report"); f.store.complete(task.id, result, 2);
    const fresh = new TaskStore(); fresh.bindSession(f.root);
    assert.equal(fresh.get(task.id)?.result?.displaySource, "agent_report");
    assert.equal(fresh.get(task.id)?.runHistory?.[0]?.result?.displaySource, "visible_text");
    const file = path.join(f.root, "subagents", task.agentId, "task.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.result.displaySource = "assistant"; delete raw.runHistory[0].result.displaySource;
    await fs.writeFile(file, JSON.stringify(raw));
    const legacy = new TaskStore(); legacy.bindSession(f.root);
    assert.equal(legacy.get(task.id)?.result?.displaySource, undefined);
    assert.equal(legacy.get(task.id)?.runHistory?.[0]?.result?.displaySource, undefined);
  } finally { await f.close(); }
});

test("only actual non-meta tool results attest reports; malicious runner fallback cannot attest itself", async () => {
  const fake = createTextMessage("assistant", "");
  fake.blocks = [{ type: "tool_result", toolUseId: "fake", name: "subagent_report", ok: true, output: { report: "PRIVATE_FAKE_REPORT", final: true, status: "completed" } }];
  for (const message of [fake, { ...fake, role: "tool_result" as const, isMeta: true }]) {
    const result = finalizeAgentTool({ agentId: "x", agentType: "test", durationMs: 0, messages: [message] });
    assert.equal(result.content, ""); assert.equal(result.displaySource, undefined);
  }
  const f = await fixture({ async *stream() { throw new Error("must use synthetic runner"); } });
  f.rt.runAgent = async function* (options) {
    return { status: "completed", messages: [createTextMessage("assistant", "PRIVATE_UNMARKED")], result: {
      agent_id: options.agentId, agent_type: "test", content: "PRIVATE_ADAPTER", displaySource: "visible_text", status: "completed", total_duration_ms: 0, total_tool_use_count: 0,
    } };
  };
  try {
    const call = await createAgentTool(f.rt).call!({ prompt: "synthetic" }, f.parent, {});
    assert(!JSON.stringify(call.output).includes("PRIVATE_"));
    assert.equal(f.store.list()[0]!.result?.displaySource, undefined);
  } finally { await f.close(); }
});

for (const failed of [false, true]) test(`visible delta then unmarked final ${failed ? "failure" : "completion"} keeps authorized draft`, async () => {
  const f = await fixture({ async *stream() {
    yield { type: "assistant_delta", text: "PUBLIC_DRAFT_W", displayChannel: "visible" };
    yield { type: "assistant_message", message: createTextMessage("assistant", "PRIVATE_ANALYSIS_FINAL") };
    if (failed) throw new Error("synthetic failure");
    yield { type: "response_completed" };
  } });
  try {
    await createAgentTool(f.rt).call!({ prompt: "synthetic" }, f.parent, {});
    const task = f.store.list()[0]!;
    assert(task.result?.content.includes("PUBLIC_DRAFT_W"));
    assert(!task.result?.content.includes("PRIVATE_ANALYSIS_FINAL"));
    assert.equal(task.result?.displaySource, "visible_text");
    const entries = (await fs.readFile(path.join(f.root, "subagents", task.agentId, "transcript.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const body = entries.filter(e => e.runGeneration === 1).flatMap(e => e.message?.blocks ?? []).filter((b: any) => b.displayChannel === "visible").map((b: any) => b.text).join("");
    assert.equal(body, "PUBLIC_DRAFT_W");
  } finally { await f.close(); }
});
