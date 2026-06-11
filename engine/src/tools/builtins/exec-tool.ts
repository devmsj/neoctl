import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";
import type { SecretRedactionRegistry } from "../../secrets/secret-types.js";
import { createLocalAgentTask } from "../../agents/local-agent-task.js";
import { globalTaskStore, type TaskStore } from "../../tasks/task-store.js";
import { createTextMessage } from "../../types/messages.js";

export type ExecShell = "auto" | "powershell" | "cmd" | "bash" | "sh";

export interface ExecToolInput {
  command: string;
  cwd?: string;
  timeoutMs: number;
  maxOutputChars: number;
  shell: ExecShell;
  env: Record<string, string>;
  envSecrets: Record<string, string>;
  description: string;
  background?: boolean;
}

interface ExecOutput {
  command: string;
  description?: string;
  cwd: string;
  shell: ExecShell;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputBytes: {
    stdout: number;
    stderr: number;
  };
}

export interface ForegroundExecDetachResult {
  ok: boolean;
  message: string;
  taskId?: string;
  agentId?: string;
}

export interface ForegroundExecDetachHandle {
  toolUseId?: string;
  toolName?: string;
  command: string;
  description?: string;
  cwd: string;
  startedAt: number;
  detach(): ForegroundExecDetachResult;
}

export interface ForegroundExecDetachRegistry {
  set(handle: ForegroundExecDetachHandle): () => void;
}

export interface ExecToolRuntime {
  taskStore?: TaskStore;
  foregroundDetachRegistry?: ForegroundExecDetachRegistry;
}

export function createExecTool(runtime?: ExecToolRuntime): Tool<ExecToolInput> {
  return {
    name: "exec",
    aliases: ["shell", "bash", "powershell"],
    description:
      "Execute a shell command in the local workspace with full permissions. The required description field is shown to the user and should explain what the command is doing. Use cwd to choose the working directory and timeoutMs/maxOutputChars to bound long commands. Set background=true to run long-lived commands asynchronously and receive a task_id for later polling.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: { type: "string", description: "Working directory. Defaults to the current agent cwd." },
        timeoutMs: { type: "integer", description: "Timeout in milliseconds, 1-600000. Defaults to 120000." },
        maxOutputChars: { type: "integer", description: "Maximum stdout/stderr chars to keep each, 1000-200000. Defaults to 40000." },
        shell: {
          type: "string",
          enum: ["auto", "powershell", "cmd", "bash", "sh"],
          description: "Shell to use. Defaults to auto: PowerShell on Windows, bash/sh elsewhere.",
        },
        env: {
          type: "object",
          description: "Additional environment variables for the child process.",
          additionalProperties: true,
        },
        envSecrets: {
          type: "object",
          description: "Environment variables whose values are resolved from secret keys at tool runtime. The agent sees keys only; values are never returned.",
          additionalProperties: true,
        },
        description: { type: "string", description: "Required user-facing description of what this command is doing and why it is being run." },
        background: { type: "boolean", description: "If true, run the command in the background and return immediately with a task_id." },
      },
      required: ["command", "description"],
      additionalProperties: false,
    },
    metadata: {
      readOnly: false,
      concurrent: false,
      visible: true,
      requiresApproval: false,
      destructive: true,
      maxResultSizeChars: 50000,
      searchHint: "run shell commands and inspect stdout/stderr",
    },
    validate(input) {
      const record = input as Partial<ExecToolInput>;
      return {
        command: record.command ?? "",
        cwd: record.cwd,
        timeoutMs: record.timeoutMs ?? 120000,
        maxOutputChars: record.maxOutputChars ?? 40000,
        shell: record.shell ?? "auto",
        env: normalizeEnv(record.env),
        envSecrets: normalizeEnv((record as Partial<ExecToolInput>).envSecrets),
        description: record.description ?? "",
        background: record.background ?? false,
      };
    },
    validateInput(input) {
      if (!input.command.trim()) return { ok: false, message: "exec.command cannot be empty" };
      if (!input.description.trim()) return { ok: false, message: "exec.description is required and cannot be empty" };
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600000) {
        return { ok: false, message: "exec.timeoutMs must be between 1 and 600000" };
      }
      if (!Number.isInteger(input.maxOutputChars) || input.maxOutputChars < 1000 || input.maxOutputChars > 200000) {
        return { ok: false, message: "exec.maxOutputChars must be between 1000 and 200000" };
      }
      if (!["auto", "powershell", "cmd", "bash", "sh"].includes(input.shell)) {
        return { ok: false, message: "exec.shell must be one of auto, powershell, cmd, bash, sh" };
      }
      return { ok: true, value: input };
    },
    isConcurrencySafe(input) {
      return Boolean(input.background);
    },
    async call(input, context, options): Promise<ToolResult> {
      const cwd = resolveCwd(input.cwd, context);
      const cwdStat = await fs.stat(cwd).catch(() => undefined);
      if (!cwdStat) return { ok: false, output: { error: `exec.cwd does not exist: ${cwd}` } };
      if (!cwdStat.isDirectory()) return { ok: false, output: { error: `exec.cwd is not a directory: ${cwd}` } };

      const env = await resolveEnvSecrets(input.env, input.envSecrets, context);
      const resolvedInput = { ...input, env };

      if (input.background) {
        return launchBackgroundExec(resolvedInput, cwd, runtime?.taskStore ?? globalTaskStore, context.secretRedactions);
      }

      const resolvedShell = resolveShell(input.shell);
      options.onProgress?.({
        toolName: "exec",
        message: `Running command${input.description ? `: ${input.description}` : ""}`,
        data: { cwd, shell: resolvedShell.displayName, command: input.command, description: input.description },
      });

      const output = await runCommand({
        command: input.command,
        description: input.description,
        cwd,
        timeoutMs: input.timeoutMs,
        maxOutputChars: input.maxOutputChars,
        shell: resolvedShell,
        env,
        abortSignal: context.abortSignal,
        detach: runtime?.foregroundDetachRegistry && runtime?.taskStore
          ? {
              toolUseId: context.toolUseId,
              input,
              taskStore: runtime.taskStore,
              registry: runtime.foregroundDetachRegistry,
            }
          : undefined,
      });

      if (isDetachedExecOutput(output)) {
        return {
          ok: true,
          output,
          summary: `detached to background task ${output.task_id}`,
        };
      }

      const ok = output.exitCode === 0 && !output.timedOut;
      return {
        ok,
        output,
        summary: summarizeExecOutput(output),
      };
    },
  };
}

export const execTool: Tool<ExecToolInput> = createExecTool();

function launchBackgroundExec(
  input: ExecToolInput,
  cwd: string,
  taskStore: TaskStore,
  secretRedactions?: SecretRedactionRegistry,
): ToolResult {
  const taskId = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `bg_exec_${Date.now().toString(36)}`;
  const description = input.description ?? `exec: ${input.command.slice(0, 80)}`;
  const abortController = new AbortController();

  const task = createLocalAgentTask({
    taskId,
    agentId,
    description,
    prompt: input.command,
    type: "exec",
    abortController,
  });
  taskStore.upsert(task);
  taskStore.markRunning(taskId);

  const resolvedShell = resolveShell(input.shell);

  void runCommand({
    command: input.command,
    description: input.description,
    cwd,
    timeoutMs: input.timeoutMs,
    maxOutputChars: input.maxOutputChars,
    shell: resolvedShell,
    env: input.env,
    abortSignal: abortController.signal,
  }).then((output) => {
    if (isDetachedExecOutput(output)) return;
    const safeOutput = secretRedactions?.redact(output) ?? output;
    const ok = safeOutput.exitCode === 0 && !safeOutput.timedOut;
    taskStore.complete(taskId, {
      agent_id: agentId,
      agent_type: "exec",
      content: summarizeExecOutput(safeOutput),
      total_duration_ms: safeOutput.durationMs,
      total_tool_use_count: 0,
    });
    const finished = taskStore.get(taskId);
    if (finished) {
      finished.messages.push(
        createTextMessage("user",
          `<task-notification agent_id="${agentId}" task_id="${taskId}" status="${ok ? "completed" : "failed"}" type="exec">\n${summarizeExecOutput(safeOutput)}\nstdout: ${safeOutput.stdout.slice(0, 2000)}\nstderr: ${safeOutput.stderr.slice(0, 2000)}\n</task-notification>`,
        ),
      );
      finished.notified = false;
      taskStore.upsert(finished);
    }
  }).catch((error) => {
    taskStore.fail(taskId, error instanceof Error ? error.message : String(error));
  });

  return {
    ok: true,
    output: {
      status: "async_launched",
      task_id: taskId,
      agent_id: agentId,
      description,
      command: input.command,
      output_file: task.outputFile,
      message: "Command launched in background. Use TaskOutput or TaskGet to check status.",
    },
  };
}

interface ResolvedShell {
  requested: ExecShell;
  displayName: string;
  file: string;
  args: string[];
}

interface ExecDetachedOutput {
  status: "async_launched";
  detachedFromForeground: true;
  task_id: string;
  agent_id: string;
  description: string;
  command: string;
  output_file: string;
  message: string;
}

interface RunCommandDetachOptions {
  toolUseId?: string;
  input: ExecToolInput;
  taskStore: TaskStore;
  registry: ForegroundExecDetachRegistry;
  taskId?: string;
}

interface RunCommandOptions {
  command: string;
  description?: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  shell: ResolvedShell;
  env: Record<string, string>;
  abortSignal?: AbortSignal;
  detach?: RunCommandDetachOptions;
}

function runCommand(options: RunCommandOptions): Promise<ExecOutput | ExecDetachedOutput> {
  const started = Date.now();
  const stdout = new OutputAccumulator(options.maxOutputChars);
  const stderr = new OutputAccumulator(options.maxOutputChars);
  let timedOut = false;
  let settled = false;
  let detached = false;
  let detachCleanup: (() => void) | undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(options.shell.file, [...options.shell.args, options.command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref();
    }, options.timeoutMs);

    const abort = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };
    options.abortSignal?.addEventListener("abort", abort, { once: true });

    const buildOutput = (exitCode: number | null, signal: NodeJS.Signals | null): ExecOutput => ({
      command: options.command,
      description: options.description,
      cwd: options.cwd,
      shell: options.shell.requested,
      exitCode,
      signal,
      timedOut,
      durationMs: Date.now() - started,
      stdout: stdout.value(),
      stderr: stderr.value(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      outputBytes: {
        stdout: stdout.bytes,
        stderr: stderr.bytes,
      },
    });

    const backgroundAbortController = new AbortController();
    const backgroundAbort = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };

    if (options.detach) {
      detachCleanup = options.detach.registry.set({
        toolUseId: options.detach.toolUseId,
        command: options.command,
        description: options.description,
        cwd: options.cwd,
        startedAt: started,
        detach: () => {
          if (settled) return { ok: false, message: "exec command already finished" };
          if (detached) return { ok: false, message: "exec command already detached" };
          detached = true;
          options.abortSignal?.removeEventListener("abort", abort);
          backgroundAbortController.signal.addEventListener("abort", backgroundAbort, { once: true });
          const launched = createDetachedExecTask(options.detach!, backgroundAbortController);
          detachCleanup?.();
          detachCleanup = undefined;
          resolve(launched.output);
          return { ok: true, message: launched.output.message, taskId: launched.taskId, agentId: launched.agentId };
        },
      });
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      detachCleanup?.();
      options.abortSignal?.removeEventListener("abort", abort);
      backgroundAbortController.signal.removeEventListener("abort", backgroundAbort);
      if (detached && options.detach) {
        options.detach.taskStore.fail(resolveDetachedTaskId(options.detach), error instanceof Error ? error.message : String(error));
        return;
      }
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timeout);
      detachCleanup?.();
      options.abortSignal?.removeEventListener("abort", abort);
      backgroundAbortController.signal.removeEventListener("abort", backgroundAbort);
      const output = buildOutput(exitCode, signal);
      if (detached && options.detach) {
        completeDetachedExecTask(options.detach.taskStore, resolveDetachedTaskId(options.detach), output);
        return;
      }
      resolve(output);
    });
  });
}

function createDetachedExecTask(
  detach: RunCommandDetachOptions,
  abortController: AbortController,
): { taskId: string; agentId: string; output: ExecDetachedOutput } {
  const taskId = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `bg_exec_${Date.now().toString(36)}`;
  const description = detach.input.description ?? `exec: ${detach.input.command.slice(0, 80)}`;
  detach.taskId = taskId;
  const task = createLocalAgentTask({
    taskId,
    agentId,
    description,
    prompt: detach.input.command,
    type: "exec",
    abortController,
  });
  detach.taskStore.upsert(task);
  detach.taskStore.markRunning(taskId);
  const output: ExecDetachedOutput = {
    status: "async_launched",
    detachedFromForeground: true,
    task_id: taskId,
    agent_id: agentId,
    description,
    command: detach.input.command,
    output_file: task.outputFile,
    message: "Foreground command detached to background. Use TaskOutput or TaskGet to check status.",
  };
  return { taskId, agentId, output };
}

function resolveDetachedTaskId(detach: RunCommandDetachOptions): string {
  if (!detach.taskId) throw new Error("Detached exec task was not initialized");
  return detach.taskId;
}

function completeDetachedExecTask(taskStore: TaskStore, taskId: string, output: ExecOutput): void {
  const ok = output.exitCode === 0 && !output.timedOut;
  taskStore.complete(taskId, {
    agent_id: taskStore.get(taskId)?.agentId ?? "bg_exec",
    agent_type: "exec",
    content: summarizeExecOutput(output),
    total_duration_ms: output.durationMs,
    total_tool_use_count: 0,
  });
  const finished = taskStore.get(taskId);
  if (finished) {
    finished.messages.push(
      createTextMessage("user",
        `<task-notification agent_id="${finished.agentId}" task_id="${taskId}" status="${ok ? "completed" : "failed"}" type="exec">\n${summarizeExecOutput(output)}\nstdout: ${output.stdout.slice(0, 2000)}\nstderr: ${output.stderr.slice(0, 2000)}\n</task-notification>`,
      ),
    );
    finished.notified = false;
    taskStore.upsert(finished);
  }
}

function isDetachedExecOutput(output: ExecOutput | ExecDetachedOutput): output is ExecDetachedOutput {
  return "status" in output && output.status === "async_launched" && output.detachedFromForeground === true;
}

class OutputAccumulator {
  bytes = 0;
  truncated = false;
  private valueText = "";

  constructor(private readonly maxChars: number) {}

  push(text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.valueText.length >= this.maxChars) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxChars - this.valueText.length;
    if (text.length > remaining) {
      this.valueText += text.slice(0, remaining);
      this.truncated = true;
      return;
    }
    this.valueText += text;
  }

  value(): string {
    if (!this.truncated) return normalizeOutput(this.valueText);
    return `${normalizeOutput(this.valueText)}\n[output truncated at ${this.maxChars} chars]`;
  }
}

function resolveShell(shell: ExecShell): ResolvedShell {
  const requested = shell === "auto" ? defaultShell() : shell;
  if (requested === "powershell") {
    return {
      requested,
      displayName: "PowerShell",
      file: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"],
    };
  }
  if (requested === "cmd") return { requested, displayName: "cmd.exe", file: "cmd.exe", args: ["/d", "/s", "/c"] };
  if (requested === "bash") return { requested, displayName: "bash", file: "bash", args: ["-lc"] };
  return { requested, displayName: "sh", file: "sh", args: ["-lc"] };
}

function defaultShell(): ExecShell {
  return os.platform() === "win32" ? "powershell" : "bash";
}

function resolveCwd(cwd: string | undefined, context: ToolUseContext): string {
  const root = path.resolve(context.appState.snapshot().cwd ?? process.cwd());
  if (!cwd?.trim()) return root;
  return path.isAbsolute(cwd) ? path.normalize(cwd) : path.resolve(root, cwd);
}

async function resolveEnvSecrets(env: Record<string, string>, envSecrets: Record<string, string>, context: ToolUseContext): Promise<Record<string, string>> {
  const resolved = { ...env };
  for (const [envName, secretKey] of Object.entries(envSecrets)) {
    if (!context.secrets) throw new Error(`Secret store is not available; cannot resolve envSecrets.${envName}`);
    const value = await context.secrets.resolve(secretKey);
    context.secretRedactions?.record(secretKey, value);
    resolved[envName] = value;
  }
  return resolved;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );
}

function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function summarizeExecOutput(output: ExecOutput): string {
  const status = output.timedOut ? "timed out" : output.exitCode === 0 ? "exit 0" : `exit ${output.exitCode ?? "unknown"}`;
  const stdout = output.stdout.trim() ? `${output.stdout.trim().split(/\n/).length} stdout line(s)` : "no stdout";
  const stderr = output.stderr.trim() ? `${output.stderr.trim().split(/\n/).length} stderr line(s)` : "no stderr";
  return `${status}, ${stdout}, ${stderr}, ${output.durationMs}ms`;
}
