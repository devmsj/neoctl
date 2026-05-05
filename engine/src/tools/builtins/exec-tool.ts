import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";

export type ExecShell = "auto" | "powershell" | "cmd" | "bash" | "sh";

export interface ExecToolInput {
  command: string;
  cwd?: string;
  timeoutMs: number;
  maxOutputChars: number;
  shell: ExecShell;
  env: Record<string, string>;
  description?: string;
}

interface ExecOutput {
  command: string;
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

export const execTool: Tool<ExecToolInput> = {
  name: "exec",
  aliases: ["shell", "bash", "powershell"],
  description:
    "Execute a shell command in the local workspace with full permissions. Use cwd to choose the working directory and timeoutMs/maxOutputChars to bound long commands.",
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
      description: { type: "string", description: "Short human-readable description of the command purpose." },
    },
    required: ["command"],
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
      description: record.description,
    };
  },
  validateInput(input) {
    if (!input.command.trim()) return { ok: false, message: "exec.command cannot be empty" };
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
  isConcurrencySafe() {
    return false;
  },
  async call(input, context, options): Promise<ToolResult> {
    const cwd = resolveCwd(input.cwd, context);
    const cwdStat = await fs.stat(cwd).catch(() => undefined);
    if (!cwdStat) return { ok: false, output: { error: `exec.cwd does not exist: ${cwd}` } };
    if (!cwdStat.isDirectory()) return { ok: false, output: { error: `exec.cwd is not a directory: ${cwd}` } };

    const resolvedShell = resolveShell(input.shell);
    options.onProgress?.({
      toolName: execTool.name,
      message: `Running command${input.description ? `: ${input.description}` : ""}`,
      data: { cwd, shell: resolvedShell.displayName, command: input.command },
    });

    const output = await runCommand({
      command: input.command,
      cwd,
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars,
      shell: resolvedShell,
      env: input.env,
      abortSignal: context.abortSignal,
    });

    const ok = output.exitCode === 0 && !output.timedOut;
    return {
      ok,
      output,
      summary: summarizeExecOutput(output),
    };
  },
};

interface ResolvedShell {
  requested: ExecShell;
  displayName: string;
  file: string;
  args: string[];
}

interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  shell: ResolvedShell;
  env: Record<string, string>;
  abortSignal?: AbortSignal;
}

function runCommand(options: RunCommandOptions): Promise<ExecOutput> {
  const started = Date.now();
  const stdout = new OutputAccumulator(options.maxOutputChars);
  const stderr = new OutputAccumulator(options.maxOutputChars);
  let timedOut = false;
  let settled = false;

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

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    child.on("error", (error) => {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", abort);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", abort);
      resolve({
        command: options.command,
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
    });
  });
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
