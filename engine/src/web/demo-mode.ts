import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelDrivenCompactor, type Compactor, type ContextBudgetOptions, type CompactionResult } from "../context/compaction.js";
import type { QuerySimulation } from "../core/query-engine.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { createTextMessage, type Message, type ToolUseRequest } from "../types/messages.js";
import type { JsonSchema } from "../tools/tool.js";
import { DemoTools } from "./demo-tools.js";

export const DEMO_RESPONSE_INTERVAL_MS = 3000;
export const DEMO_PROMPT = "请检查 Aurora 项目，完善文件、运行验证、生成并修改配图，安排子任务交叉核验，最后整理结果。";
export const DEMO_MARKER = "neo.demo.v1";
type Step = { text: string; calls: Array<{ name: string; input: unknown }>; compactAfter?: boolean };
type StepFactory = () => Step;
export type DemoWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

/** Same gateway contract as real providers; no transport or browser-only replay protocol. */
export class DemoMode implements ModelGateway, QuerySimulation {
  readonly modelGateway = this;
  readonly tools;
  readonly compactor: Compactor;
  readonly controller = new AbortController();
  readonly steps: StepFactory[] = [];
  responseCount = 0;
  compactionCount = 0;
  private cursor = 0;
  private compactPending = false;

  constructor(readonly backend: DemoTools, private readonly wait: DemoWait = async (ms, signal) => { await delay(ms, undefined, { signal }); }) {
    this.tools = backend.registry;
    const delegate = new ModelDrivenCompactor(this);
    const compact = async (messages: readonly Message[], options: ContextBudgetOptions = {}): Promise<CompactionResult> => {
      if (!this.compactPending) return { messages: [...messages], changed: false, reason: "none" };
      this.compactPending = false;
      return delegate.compact(messages, { ...options, autoCompactMaxChars: 1, estimatedInputTokens: undefined, contextWindowTokens: undefined, keepRecentTokenBudget: 0 });
    };
    this.compactor = {
      compact,
      manualCompact: (messages, options) => delegate.manualCompact(messages, { ...options, keepRecentTokenBudget: 0 }),
      pureCompact: (messages, options) => delegate.pureCompact(messages, options),
    };
    this.buildScript();
  }

  stop(): void { this.controller.abort(); this.backend.stop(); }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const signal = request.cancellation ? AbortSignal.any([request.cancellation, this.controller.signal]) : this.controller.signal;
    await this.wait(DEMO_RESPONSE_INTERVAL_MS, signal);
    signal.throwIfAborted();
    this.responseCount++;
    if (request.queryOrigin === "compact") {
      this.compactionCount++;
      const summary = `Aurora 项目检查已推进至第 ${this.cursor} 轮。保留文件检查、验证命令、计划和子任务结果。首张图片的稳定资源 ID 为 ${this.backend.firstImage}，最新图片为 ${this.backend.latestImage}。继续当前脚本，不重置工具状态；后续仍需复查图片与交付结果。`;
      yield { type: "assistant_delta", text: summary };
      yield { type: "assistant_message", message: createTextMessage("assistant", summary) };
      yield { type: "response_completed", stopReason: "stop" };
      return;
    }
    const step = this.steps[this.cursor++]?.();
    if (!step) throw new Error("Demo script exhausted; user messages must use the record-only path");
    const responseId = `demo-response-${randomUUID()}`;
    yield { type: "response_started", responseId };
    const thinking = `第 ${this.cursor} 轮：核对现有结果并选择下一步工具。`;
    yield { type: "thinking_delta", text: thinking };
    const calls: ToolUseRequest[] = step.calls.map(call => ({ ...call, id: `demo-call-${randomUUID()}` }));
    const midpoint = Math.max(1, Math.floor(step.text.length / 2));
    yield { type: "assistant_delta", text: step.text.slice(0, midpoint), displayChannel: "visible" };
    yield { type: "assistant_delta", text: step.text.slice(midpoint), displayChannel: "visible" };
    for (const call of calls) {
      yield { type: "tool_call_started", callId: call.id, name: call.name };
      yield { type: "tool_call_delta", callId: call.id, name: call.name, argumentsDelta: JSON.stringify(call.input) };
    }
    const message = createTextMessage("assistant", step.text);
    for (const block of message.blocks) if (block.type === "text") block.displayChannel = "visible";
    message.blocks.unshift({ type: "thinking", text: thinking });
    message.blocks.push(...calls.map(call => ({ type: "tool_use" as const, ...call })));
    yield { type: "assistant_message", message };
    // Tool uses are already present in assistant_message; do not emit them a second time.
    const usage = { inputTokens: 3600 + this.cursor * 220, outputTokens: 120 + calls.length * 80, cachedTokens: 2400 };
    yield { type: "usage", usage };
    this.compactPending = step.compactAfter === true;
    yield { type: "response_completed", responseId, stopReason: calls.length ? "tool_calls" : "stop", usage };
  }

  private buildScript(): void {
    const b = this.backend;
    const call = (name: string, input: unknown) => ({ name, input });
    const add = (text: string, calls: () => Step["calls"], compactAfter = false) => this.steps.push(() => ({ text, calls: calls().filter(c => this.tools.get(c.name)), compactAfter }));
    const plan = (stage: number) => call("plan_update", { title: "Aurora 项目完善", items: ["检查项目与资料", "完善文件和配图", "交叉验证并交付"].map((description, i) => ({ description, status: i < stage ? "completed" : i === stage ? "in_progress" : "pending" })) });
    for (let round = 0; round < 2; round++) {
      add(round ? "第一次压缩已完成。继续第二轮检查，复用上一阶段的资源和结果。" : "先建立计划，检查项目结构，并查找流式交互相关资料。", () => [plan(round), call("file_list", { path: "demo", recursive: true }), call("file_read", { path: "demo/README.md" }), call("web_search", { query: round ? "persistent image references context compaction" : "server sent events tool progress", numResults: 2 })]);
      add("现在补充实现和说明，随后检索关键改动。", () => [call("file_write", { path: `demo/notes-${round + 1}.md`, content: `# Review ${round + 1}\nAurora image references remain stable.\n` }), call("file_edit", { path: "demo/src/app.ts", oldString: round ? "Aurora One" : "Aurora", newString: round ? "Aurora Final" : "Aurora One" }), call("file_search", { path: "demo", query: "Aurora", contextLines: 1 })]);
      add("运行验证，同时委派一个独立核验任务。", () => [call("terminal_run", { cmd: "npm test -- --run", workdir: "demo", yield_time_ms: 1000, description: "核验图片与上下文连续性" }), call("subagent_run", { prompt: "检查图片持久引用及上下文压缩后的连续性。", description: `交叉核验 ${round + 1}`, run_in_background: true })]);
      add("读取终端增量和子任务状态，补充核验重点。", () => [call("terminal_control", { session_id: b.currentTerminal, chars: "", yield_time_ms: 1000 }), call("subagent_list", {}), call("subagent_get", { task_id: b.currentTask, detail: true }), call("subagent_message", { target: b.currentAgent, message: "重点核对压缩后图片 ID 不变。" })]);
      add(round ? "根据第一张图继续调整配色，保持原始引用可用。" : "生成项目配图，后续会在压缩之后继续引用这张图。", () => [call("image_create", { semanticName: round ? "Aurora 配色迭代" : "Aurora 项目配图", prompt: "深色背景的抽象山峦与渐变色块", mode: round ? "edit" : "generate", ...(round ? { imageRefs: [b.firstImage] } : {}) }), call("terminal_control", { session_id: b.currentTerminal, chars: "", yield_time_ms: 1000 }), call("subagent_stop", { task_id: b.currentTask })]);
      add("图片已就绪。检查构图，并恢复核验任务以收集最终结果。", () => [call("image_inspect", { imageRefs: [b.firstImage], retention: "next_turn", prompt: "检查构图与色彩" }), call("subagent_resume", { task_id: b.currentTask, directive: "继续核验并给出结果。" })]);
      add(round ? "第二轮核验完成。整理续接摘要后，将继续复查和交付。" : "第一阶段完成。先整理续接摘要，再继续第二轮工具使用。", () => [call("subagent_output", { task_id: b.currentTask }), plan(round + 1)], true);
    }
    add("第二次压缩已完成。继续读取最初的图片和最终文件，确认对话与资源均能衔接。", () => [call("image_inspect", { imageRefs: [b.firstImage, b.latestImage], retention: "next_turn" }), call("image_inspect", { mode: "list", offset: 0, limit: 10 }), call("file_read", { path: "demo/src/app.ts" })]);
    // Cover installed tools twice; only demo-owned local resource operations reach plugin backends.
    const covered = new Set(["file_edit", "file_write", "file_read", "file_list", "file_search", "terminal_run", "terminal_control", "web_search", "image_create", "image_inspect", "plan_update", "subagent_run", "subagent_output", "subagent_list", "subagent_get", "subagent_stop", "subagent_message", "subagent_resume"]);
    const extras = this.tools.names().filter(name => !covered.has(name));
    for (let round = 0; round < 2; round++) for (const name of extras) {
      add(`继续整理交付内容：${name}。`, () => [call(name, this.extraInput(name, round))]);
    }
    if (extras.includes("expose_videos")) add("撤销测试已完成，保留一个可播放的交付样例。", () => [call("expose_videos", this.extraInput("expose_videos", 2))]);
    add("检查已经完成，最后更新任务计划。", () => [plan(3)]);
    add("项目检查与交付已完成。文件、终端、搜索、图片和子任务均经过多轮使用；两次上下文压缩后，最初的图片引用仍可读取，对话也已继续。", () => []);
  }

  private extraInput(name: string, round: number): unknown {
    const b = this.backend;
    if (name === "expose_downloads") return { paths: [path.join(b.resourceDir, "review.md")] };
    if (name === "expose_videos") return { paths: [path.join(b.resourceDir, "walkthrough.webm")] };
    if (name === "revoke_videos") return { ids: [b.currentVideo || "demo-video"] };
    if (name === "open_xhs_artifact_editor") return { payload: { title: "把灵感整理成可执行计划", body: "从检查文件到完成验证，让创作过程有迹可循。", interaction: "", hashtags: ["#效率工具"], images: [{ url: b.firstImageUrl, caption: "Aurora 配图", overlay: "", note: "" }], review: "" } };
    if (name === "read_xhs_artifact") return { id: b.currentArtifact };
    const schema = this.tools.get(name)!.inputSchema;
    return exampleInput(schema, round);
  }
}

/** Schema-conforming placeholder for optional installed tools, never executed outside the simulator. */
function exampleInput(schema: JsonSchema, round: number): unknown {
  if (schema.enum?.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "object" || schema.properties) return Object.fromEntries((schema.required ?? []).map(key => [key, exampleInput(schema.properties?.[key] ?? { type: "string" }, round)]));
  if (schema.type === "array") return Array.from({ length: Math.max(1, Number(schema.minItems ?? 1)) }, () => exampleInput(schema.items ?? {}, round));
  if (schema.type === "integer" || schema.type === "number") return Number(schema.minimum ?? 1);
  if (schema.type === "boolean") return true;
  return `demo-${round + 1}`;
}
