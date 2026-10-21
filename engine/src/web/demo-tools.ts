import path from "node:path";
import fs from "node:fs/promises";
import { DEMO_VIDEO_BASE64 } from "./demo-video.js";
import { randomUUID } from "node:crypto";
import { createLocalAgentTask } from "../agents/local-agent-task.js";
import type { TaskStore } from "../tasks/task-store.js";
import { createSubagentTools } from "../tasks/subagent-tools.js";
import type { ExecProcessManager } from "../tools/builtins/exec-process-manager.js";
import { createOpenAIImageGenerationTool } from "../tools/builtins/image-generation-tool.js";
import { createLoadImageTool } from "../tools/builtins/image-loader-tool.js";
import { planTool } from "../tools/builtins/plan-tool.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolResult, ToolUseContext, ToolCallOptions } from "../tools/tool.js";
import { redactedTerminalChunk, type TerminalOutputStore, type StoreResult } from "../tools/terminal-output-store.js";
import { createTextMessage, type Message } from "../types/messages.js";
import { SessionStore } from "../session/session-store.js";
import { resolveContextImage } from "../core/session-images.js";

export const DEMO_SYSTEM_TOOLS = ["file_edit", "file_write", "file_read", "file_list", "file_search", "terminal_run", "terminal_control", "web_search", "image_create", "image_inspect", "plan_update", "subagent_run", "subagent_output", "subagent_list", "subagent_get", "subagent_stop", "subagent_message", "subagent_resume"] as const;

/** Offline tool backends; only local resource plugins execute, restricted to demo-owned fixtures/IDs. */
export class DemoTools {
  readonly registry = new ToolRegistry();
  readonly counts = new Map<string, number>();
  readonly files = new Map<string, string>([["README.md", "# Aurora workspace\nA small application with persistent image references.\n"], ["src/app.ts", "export const title = 'Aurora';\nexport const ready = true;\n"]]);
  readonly artifacts = new Map<string, Record<string, unknown>>();
  currentTask = "";
  currentAgent = "";
  currentTerminal = "";
  currentArtifact = "";
  currentVideo = "";
  firstImage = "";
  latestImage = "";
  firstImageUrl = "";
  private imageNumber = 0;
  private readonly terminals = new Map<string, { store: TerminalOutputStore; owner: string; started: number; offset: number; polls: number; command: string; done?: boolean }>();
  private readonly taskIds = new Set<string>();
  private readonly taskSessions = new Map<string, SessionStore>();
  private readonly resourceTools = new Map<string, Tool<any>>();
  private readonly videoIds = new Set<string>();
  resourceDir = "";

  async prepare(sessionDir: string): Promise<void> {
    this.resourceDir = path.join(sessionDir, "demo");
    await fs.mkdir(this.resourceDir, { recursive: true });
    await fs.writeFile(path.join(this.resourceDir, "walkthrough.webm"), Buffer.from(DEMO_VIDEO_BASE64, "base64"));
    await fs.writeFile(path.join(this.resourceDir, "review.md"), "# Aurora\nOffline demonstration artifacts.\n");
  }
  private readonly taskTools: Map<string, Tool<any>>;

  constructor(source: ToolRegistry, private readonly tasks: TaskStore, private readonly processes: ExecProcessManager) {
    this.taskTools = new Map(createSubagentTools(tasks, async id => {
      const task = tasks.prepareResume(id, new AbortController());
      tasks.markRunning(id, task.runGeneration);
      const delivered = tasks.deliverPendingMessages(id, task.runGeneration);
      for (const message of delivered) this.taskSessions.get(id)!.recordMessage(message, { runGeneration: task.runGeneration });
      tasks.confirmDelivery(id, delivered.map(message => message.id), task.runGeneration);
      this.recordTaskMessage(id, createTextMessage("assistant", "已恢复任务，继续核对资源身份与会话记录。"));
      return { ok: true };
    }).map(tool => [tool.name, tool]));
    const catalog = source.clone();
    for (const name of catalog.names({ includeDisabled: true })) catalog.setEnabled(name, true);
    const implementations = new Map(catalog.names().map(name => [name, catalog.get(name)!]));
    // Image demos must work without credentials or a configured image-capable provider.
    implementations.set("image_create", createOpenAIImageGenerationTool());
    implementations.set("image_inspect", createLoadImageTool());
    implementations.set("plan_update", planTool);
    for (const [name, original] of implementations) {
      // Scripted demonstrations must not fabricate real framework feedback or enable its prompt.
      if (name === "framework_feedback") continue;
      if (["expose_downloads", "expose_videos", "revoke_videos", "open_xhs_artifact_editor", "read_xhs_artifact"].includes(name)) this.resourceTools.set(name, original);
      const tool: Tool<any> = {
        ...original,
        metadata: { ...original.metadata, concurrent: false, shouldDefer: false, visible: true },
        isEnabled: () => true,
        isConcurrencySafe: () => false,
        validate: input => input,
        validateInput: undefined,
        mapResult: undefined,
        renderToolResultMessage: name === "image_create" ? original.renderToolResultMessage : undefined,
        call: async (input, context, options) => {
          this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
          options.onProgress?.({ toolName: name, channel: "state", phase: "running", message: "正在处理", sequence: 1 });
          return this.call(name, input, context, options);
        },
      };
      this.registry.register(tool);
      this.registry.setEnabled(name, true);
    }
  }

  private async call(name: string, input: any, context: ToolUseContext, options: ToolCallOptions<any>): Promise<ToolResult> {
    if (context.abortSignal?.aborted) throw new Error("Demo stopped");
    if (name === "plan_update") return planTool.call!(input, context, options);
    if (name === "image_inspect") return createLoadImageTool().call!(input, context, options);
    if (name === "image_create") return this.image(input, context);
    if (name === "file_list") return { ok: true, output: { path: input.path ?? "demo", type: "directory", recursive: true, totalFiles: this.files.size, entries: [...this.files.keys()].map(file => ({ path: `demo/${file}`, name: path.basename(file), type: "file", size: this.files.get(file)!.length })) } };
    if (name === "file_read") {
      const file = this.file(input.path); const content = this.files.get(file);
      if (content === undefined) return { ok: false, output: { error: `File not found: ${input.path}` } };
      const lines = content.split("\n"), offset = input.offset ?? 1, limit = input.limit ?? 120;
      return { ok: true, output: { path: input.path, offset, limit, totalLines: lines.length, content: lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i} | ${line}`).join("\n") } };
    }
    if (name === "file_write") {
      this.files.set(this.file(input.path), input.content);
      return { ok: true, output: { path: input.path, operation: "write", bytesWritten: Buffer.byteLength(input.content), content: input.content } };
    }
    if (name === "file_edit") {
      const file = this.file(input.path), old = this.files.get(file) ?? "";
      if (!old.includes(input.oldString)) return { ok: false, output: { error: "oldString not found" } };
      this.files.set(file, old.replace(input.oldString, input.newString));
      options.onProgress?.({ toolName: name, channel: "patch", phase: "completed", message: "补丁已应用", data: { text: `- ${input.oldString}\n+ ${input.newString}` }, sequence: 2 });
      return { ok: true, output: { path: input.path, operation: "edit", replacements: 1, diff: `- ${input.oldString}\n+ ${input.newString}` } };
    }
    if (name === "file_search") {
      const matches = [...this.files].flatMap(([file, text]) => text.split("\n").flatMap((line, i) => line.includes(input.query) ? [{ file: `demo/${file}`, line: i + 1, text: line }] : []));
      return { ok: true, output: { query: input.query, grepPath: "demo", matches, returnedMatches: matches.length, truncated: false } };
    }
    if (name === "web_search") return { ok: true, output: { query: input.query, provider: "demo", results: [
      { title: "Streaming responses", url: "https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events", text: "通过 SSE 增量发送内容、工具进度及完成事件。" },
      { title: "Persistent resources", url: "https://developer.mozilla.org/en-US/docs/Web/API/File", text: "资源身份独立于上下文窗口，跨轮次继续引用。" },
    ] } };
    if (name === "terminal_run" || name === "terminal_control") return this.terminal(name, input, context, options);
    if (name === "subagent_run") {
      const id = `demo-task-${randomUUID()}`;
      const task = createLocalAgentTask({ taskId: id, agentId: `demo-agent-${randomUUID()}`, description: input.description ?? "核对图片引用", prompt: input.prompt, outputFile: path.join(context.session!.sessionDir, "demo", `${id}.json`), abortController: new AbortController() });
      this.taskIds.add(id); this.currentTask = id; this.currentAgent = task.agentId;
      this.tasks.attachTask(task, context.session?.sessionDir);
      this.taskSessions.set(id, await SessionStore.open({ agentId: task.agentId, sessionId: task.agentId, rootDir: path.join(context.session!.sessionDir, "subagents"), cwd: context.appState.snapshot().cwd }));
      this.tasks.markRunning(id);
      this.recordTaskMessage(id, createTextMessage("user", input.prompt));
      this.recordTaskMessage(id, createTextMessage("assistant", "正在检查持久图片索引、上下文边界和恢复路径。"));
      return { ok: true, output: { status: "async_launched", task_id: id, agent_id: task.agentId, description: task.description, output_file: task.outputFile } };
    }
    if (this.taskTools.has(name)) {
      if (name !== "subagent_list") {
        const id = name === "subagent_message" ? [...this.taskIds].find(id => this.tasks.get(id)?.agentId === input.target) : input.task_id;
        if (!id || !this.taskIds.has(id)) throw new Error("Demo can only access its own tasks");
        if (name === "subagent_output") {
          const task = this.tasks.get(id)!;
          this.recordTaskMessage(id, createTextMessage("assistant", "核验通过：图片身份稳定，压缩边界和工具输出可追溯。"));
          if (!this.tasks.isTerminal(task)) this.tasks.complete(id, { agent_id: task.agentId, agent_type: "general-purpose", content: "核验通过：图片身份稳定，压缩边界和工具输出可追溯。", displaySource: "visible_text", status: "completed", total_duration_ms: Date.now() - Date.parse(task.startedAt!), total_tool_use_count: 0 });
        }
      }
      return this.taskTools.get(name)!.call!(input, context, options);
    }
    if (name === "image_note") return { ok: true, output: { imageId: this.firstImage, note: input.note ?? "保留图片身份与构图说明" } };
    // Reuse installed resource infrastructure, but only for fixtures and IDs owned by this demo.
    const resource = this.resourceTools.get(name);
    if (resource) {
      if (!this.resourceDir) await this.prepare(context.session!.sessionDir);
      if (name === "expose_downloads" || name === "expose_videos") {
        const allowed = path.join(this.resourceDir, name === "expose_downloads" ? "review.md" : "walkthrough.webm");
        if (!Array.isArray(input.paths) || input.paths.some((file: string) => path.resolve(file) !== allowed)) throw new Error("Demo can only publish its own fixtures");
      }
      if (name === "revoke_videos" && input.ids.some((id: string) => !this.videoIds.has(id))) throw new Error("Demo can only revoke its own video links");
      if (name === "read_xhs_artifact" && !this.artifacts.has(input.id)) throw new Error("Demo can only read its own editor");
      if (name === "open_xhs_artifact_editor" && input.artifact_id && !this.artifacts.has(input.artifact_id)) throw new Error("Demo can only update its own editor");
      const normalized = resource.validate ? resource.validate(input, context) : input;
      const result = resource.call ? await resource.call(normalized, context, options) : await resource.execute!(normalized, context);
      const output = result.output as any;
      if (name === "expose_videos" && result.ok) for (const video of output.videos) { this.currentVideo = video.id; this.videoIds.add(video.id); }
      if (name === "open_xhs_artifact_editor" && result.ok) { this.currentArtifact = output.artifact.id; this.artifacts.set(this.currentArtifact, input.payload); }
      return result;
    }
    return { ok: true, output: { simulated: true, tool: name, input, note: "仅模拟结果，不执行外部操作。" } };
  }

  private recordTaskMessage(id: string, message: Message): void {
    if (message.role === "assistant") for (const block of message.blocks) if (block.type === "text") block.displayChannel = "visible";
    this.taskSessions.get(id)!.recordMessage(message, { runGeneration: this.tasks.get(id)!.runGeneration });
    this.tasks.appendMessage(id, message);
  }

  private file(value: string): string { return value.replace(/\\/g, "/").replace(/^\.?\/?demo\//, ""); }

  private async image(input: any, context: ToolUseContext): Promise<ToolResult> {
    if (input.mode === "edit") for (const ref of input.imageRefs ?? [this.latestImage]) resolveContextImage(context, ref);
    const number = ++this.imageNumber;
    const color = number % 2 ? "#dd74ae" : "#73cbd5";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#252c38"/><circle cx="760" cy="120" r="150" fill="${color}" opacity=".22"/><path d="M0 440L180 230 360 400 590 190 960 460V540H0Z" fill="${color}" opacity=".65"/><path d="M0 490L290 340 460 460 720 280 960 440V540H0Z" fill="${color}"/><text x="64" y="110" font-family="sans-serif" font-size="44" fill="white">AURORA / ${number.toString().padStart(2, "0")}</text><text x="66" y="154" font-family="sans-serif" font-size="20" fill="#ddd">Persistent images · Context continuity</text></svg>`;
    const message = createTextMessage("attachment", "");
    message.blocks = [{ type: "image", mimeType: "image/svg+xml", data: Buffer.from(svg).toString("base64"), label: `Aurora-${number}` }];
    const stored = await context.imageStore!.persistMessage(message);
    const block = stored.blocks.find(b => b.type === "image")!;
    this.latestImage = block.imageId!; this.firstImage ||= block.imageId!;
    this.firstImageUrl ||= `/api/images/by-id/${encodeURIComponent(block.imageId!)}?sessionId=${encodeURIComponent(context.session!.sessionId)}`;
    return { ok: true, output: { provider: "openai", simulated: true, model: "demo", mode: input.mode ?? "generate", prompt: input.prompt, semanticName: input.semanticName, size: "960x540", quality: "auto", outputFormat: "svg", background: "opaque", images: [{ index: 0, imageId: block.imageId, imageAlias: block.imageAlias, label: block.label, storagePath: block.storage?.path, base64: block.data, mimeType: block.mimeType, width: 960, height: 540 }], warnings: [] } };
  }

  private terminal(name: string, input: any, context: ToolUseContext, options: ToolCallOptions<any>): ToolResult {
    const checked = <T>(result: StoreResult<T>): T => { if (!result.ok) throw new Error(`Terminal store: ${result.reason}`); return result.value; };
    if (name === "terminal_run") {
      const session = context.session!; const id = `demo-terminal-${randomUUID()}`; this.currentTerminal = id;
      const store = this.processes.outputStoreForSession(session.sessionId, session.sessionDir), started = Date.now();
      checked(store.start(session.sessionId, session.sessionDir, id, { startedAt: started, command: input.cmd, description: input.description, cwd: "demo", shell: "simulated", backgrounded: true }));
      this.terminals.set(id, { store, owner: session.sessionId, started, offset: 0, polls: 0, command: input.cmd });
    }
    const id = name === "terminal_run" ? this.currentTerminal : input.session_id, run = this.terminals.get(id);
    if (!run) throw new Error("Unknown demo terminal");
    const stdout = name === "terminal_run" ? "Starting verification...\n" : ++run.polls === 1 ? "✓ image references\n✓ context checkpoints\n" : "3 checks passed\n";
    const record = checked(run.store.append(run.owner, id, redactedTerminalChunk("stdout", run.offset, stdout))).record;
    run.offset += Buffer.byteLength(stdout);
    const done = run.polls >= 2 || Boolean(input.signal);
    if (done) { checked(run.store.finalize(run.owner, id, { status: "exited", finishedAt: Date.now(), exitCode: 0, signal: null, terminationReason: "completed", durationMs: Date.now() - run.started })); run.done = true; }
    options.onProgress?.({ toolName: name, channel: "stdout", operation: "append", phase: "running", message: "", data: { text: stdout }, sequence: 2 });
    return { ok: true, output: { status: done ? "exited" : "running", session_id: id, owner_session_id: run.owner, command: run.command, shell: "simulated", cwd: "demo", stdout, stderr: "", exit_code: done ? 0 : null, duration_ms: Date.now() - run.started, termination_reason: done ? "completed" : null, output_ref: { owner_session_id: run.owner, run_id: id, persistence: "stored", availability: "available", streams: record.streams } } };
  }

  stop(): void {
    for (const id of this.taskIds) { const task = this.tasks.get(id); if (task && !this.tasks.isTerminal(task)) this.tasks.kill(id, "Demo stopped"); }
    for (const [id, run] of this.terminals) if (!run.done) {
      run.store.finalize(run.owner, id, { status: "exited", finishedAt: Date.now(), exitCode: null, signal: "SIGTERM", terminationReason: "interrupted", durationMs: Date.now() - run.started });
      run.done = true;
    }
    this.tasks.flush();
  }
}
