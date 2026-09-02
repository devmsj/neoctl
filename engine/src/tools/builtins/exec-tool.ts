import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult, ToolUseContext } from "../tool.js";
import {
  ExecProcessManager,
  type ExecProcessOutputDelta,
  type ExecProcessResult,
} from "./exec-process-manager.js";

export type ExecShell = "auto" | "powershell" | "cmd" | "bash" | "sh";

export interface ExecToolInput {
  cmd: string;
  workdir?: string;
  timeout_ms: number;
  yield_time_ms: number;
  max_output_chars: number;
  shell: ExecShell;
  tty: boolean;
  env: Record<string, string>;
  envSecrets: Record<string, string>;
  description: string;
}

export interface WriteStdinToolInput {
  session_id: string;
  chars: string;
  signal?: "interrupt" | "terminate" | "kill";
  yield_time_ms: number;
}

export interface ExecToolRuntime {
  processManager: ExecProcessManager;
}

export function createExecTool(runtime: ExecToolRuntime): Tool<ExecToolInput> {
  const manager = runtime.processManager;
  return {
    name: "exec_command",
    description:
      "Run a command in a managed terminal session. Output is collected asynchronously. Commands still running after yield_time_ms return a session_id that can be polled or controlled with write_stdin. Set tty=true for interactive terminal programs.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Shell command to execute." },
        workdir: { type: "string", description: "Working directory. Defaults to the current agent cwd." },
        timeout_ms: { type: "integer", description: "Maximum process lifetime in milliseconds. Defaults to 600000." },
        yield_time_ms: { type: "integer", description: "Wait before yielding a running session. Defaults to 10000; range 0-30000." },
        max_output_chars: { type: "integer", description: "Maximum unread characters retained per output stream. Defaults to 40000." },
        shell: {
          type: "string",
          enum: ["auto", "powershell", "cmd", "bash", "sh"],
          description: "Shell to use. Defaults to the platform shell.",
        },
        tty: { type: "boolean", description: "Attach a pseudoterminal for interactive programs. Defaults to false." },
        env: { type: "object", description: "Additional environment variables.", additionalProperties: true },
        envSecrets: {
          type: "object",
          description: "Environment variables resolved from secret keys at runtime.",
          additionalProperties: true,
        },
        description: { type: "string", description: "Short user-facing description of the command." },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
    metadata: {
      readOnly: false,
      concurrent: true,
      visible: true,
      requiresApproval: false,
      destructive: true,
      maxResultSizeChars: 50000,
      searchHint: "run commands and open interactive terminal sessions",
    },
    validate(input) {
      const record = input as Partial<ExecToolInput>;
      return {
        cmd: record.cmd ?? "",
        workdir: record.workdir,
        timeout_ms: record.timeout_ms ?? 600_000,
        yield_time_ms: record.yield_time_ms ?? 10_000,
        max_output_chars: record.max_output_chars ?? 40_000,
        shell: record.shell ?? "auto",
        tty: record.tty ?? false,
        env: normalizeEnv(record.env),
        envSecrets: normalizeEnv(record.envSecrets),
        description: record.description ?? "",
      };
    },
    validateInput(input) {
      if (!input.cmd.trim()) return { ok: false, message: "exec_command.cmd cannot be empty" };
      if (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 3_600_000) {
        return { ok: false, message: "exec_command.timeout_ms must be between 1 and 3600000" };
      }
      if (!Number.isInteger(input.yield_time_ms) || input.yield_time_ms < 0 || input.yield_time_ms > 30_000) {
        return { ok: false, message: "exec_command.yield_time_ms must be between 0 and 30000" };
      }
      if (!Number.isInteger(input.max_output_chars) || input.max_output_chars < 1_000 || input.max_output_chars > 200_000) {
        return { ok: false, message: "exec_command.max_output_chars must be between 1000 and 200000" };
      }
      if (!isExecShell(input.shell)) return { ok: false, message: "exec_command.shell is invalid" };
      return { ok: true, value: input };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context, options): Promise<ToolResult> {
      const cwd = resolveCwd(input.workdir, context);
      const cwdStat = await fs.stat(cwd).catch(() => undefined);
      if (!cwdStat) return { ok: false, output: { error: `exec_command.workdir does not exist: ${cwd}` } };
      if (!cwdStat.isDirectory()) return { ok: false, output: { error: `exec_command.workdir is not a directory: ${cwd}` } };

      const env = await resolveEnvSecrets(input.env, input.envSecrets, context);
      const shell = resolveShell(input.shell);
      options.onProgress?.({
        toolName: "exec_command",
        message: input.description,
        data: { cwd, shell: shell.displayName, command: input.cmd, tty: input.tty },
      });
      const result = await manager.execute(
        {
          ownerId: context.session?.sessionId ?? context.agentId,
          command: input.cmd,
          description: input.description,
          cwd,
          shell,
          env,
          timeoutMs: input.timeout_ms,
          maxOutputChars: input.max_output_chars,
          tty: input.tty,
        },
        input.yield_time_ms,
        (delta) => emitOutputDelta(context, delta),
        context.abortSignal,
      );
      const output = toToolOutput(result);
      const ok = result.status === "running" || (result.status === "exited" && result.exit_code === 0);
      return { ok, output, summary: summarizeExecOutput(result) };
    },
  };
}

export function createWriteStdinTool(processManager: ExecProcessManager): Tool<WriteStdinToolInput> {
  return {
    name: "write_stdin",
    description:
      "Interact with a managed terminal returned by exec_command. Send exact characters, poll with empty chars, interrupt the foreground program, or terminate the terminal.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Terminal session identifier returned by exec_command." },
        chars: { type: "string", description: "Exact characters to write. Use an empty string to poll output." },
        signal: { type: "string", enum: ["interrupt", "terminate", "kill"], description: "Optional process control signal." },
        yield_time_ms: { type: "integer", description: "Wait before returning output. Defaults to 250 after input and 5000 when polling." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    metadata: {
      readOnly: false,
      concurrent: true,
      visible: true,
      requiresApproval: false,
      destructive: true,
      maxResultSizeChars: 50000,
      searchHint: "poll, type into, interrupt, or stop a background terminal",
    },
    validate(input) {
      const record = input as Partial<WriteStdinToolInput>;
      const chars = typeof record.chars === "string" ? record.chars : "";
      return {
        session_id: record.session_id ?? "",
        chars,
        signal: record.signal,
        yield_time_ms: record.yield_time_ms ?? (chars || record.signal ? 250 : 5_000),
      };
    },
    validateInput(input) {
      if (!input.session_id.trim()) return { ok: false, message: "write_stdin.session_id is required" };
      if (!Number.isInteger(input.yield_time_ms) || input.yield_time_ms < 0 || input.yield_time_ms > 300_000) {
        return { ok: false, message: "write_stdin.yield_time_ms must be between 0 and 300000" };
      }
      if (input.signal && !["interrupt", "terminate", "kill"].includes(input.signal)) {
        return { ok: false, message: "write_stdin.signal is invalid" };
      }
      return { ok: true, value: input };
    },
    isConcurrencySafe() {
      return true;
    },
    async call(input, context): Promise<ToolResult> {
      try {
        const result = await processManager.interact(input.session_id, {
          ownerId: context.session?.sessionId ?? context.agentId,
          chars: input.chars,
          signal: input.signal,
          yieldTimeMs: input.yield_time_ms,
          onOutput: (delta) => emitOutputDelta(context, delta),
          abortSignal: context.abortSignal,
        });
        return { ok: true, output: toToolOutput(result), summary: summarizeExecOutput(result) };
      } catch (error) {
        return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

export function createExecTools(processManager = new ExecProcessManager()): [Tool<ExecToolInput>, Tool<WriteStdinToolInput>] {
  return [createExecTool({ processManager }), createWriteStdinTool(processManager)];
}

interface ResolvedShell {
  requested: ExecShell;
  displayName: string;
  file: string;
  args: string[];
}

function resolveShell(shell: ExecShell): ResolvedShell {
  const requested = shell === "auto" ? defaultShell() : shell;
  if (requested === "powershell") {
    return { requested, displayName: "PowerShell", file: "powershell.exe", args: ["-NoProfile", "-Command"] };
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

function isExecShell(value: string): value is ExecShell {
  return ["auto", "powershell", "cmd", "bash", "sh"].includes(value);
}

function emitOutputDelta(context: ToolUseContext, delta: ExecProcessOutputDelta): void {
  const text = context.secretRedactions?.redact(delta.text) ?? delta.text;
  context.emit({
    toolName: "exec_command",
    message: "Terminal output",
    data: { type: "terminal.output.delta", session_id: delta.sessionId, stream: delta.stream, text },
  });
}

function toToolOutput(result: ExecProcessResult): Record<string, unknown> {
  return {
    status: result.status,
    session_id: result.session_id,
    process_id: result.process_id,
    command: result.command,
    description: result.description,
    cwd: result.cwd,
    shell: result.shell,
    tty: result.tty,
    exit_code: result.exit_code,
    signal: result.signal,
    termination_reason: result.termination_reason,
    duration_ms: result.duration_ms,
    timed_out: result.timed_out,
    stdout: result.stdout,
    stderr: result.stderr,
    output_chars: result.output_chars,
    omitted_chars: result.omitted_chars,
  };
}

function summarizeExecOutput(output: ExecProcessResult): string {
  const status = output.status === "running"
    ? `running as terminal ${output.session_id}`
    : output.status === "exited"
      ? `exit ${output.exit_code ?? "unknown"}`
      : output.status.replace("_", " ");
  const stdout = output.stdout.trim() ? `${output.stdout.trim().split(/\n/).length} stdout line(s)` : "no stdout";
  const stderr = output.stderr.trim() ? `${output.stderr.trim().split(/\n/).length} stderr line(s)` : "no stderr";
  return `${status}, ${stdout}, ${stderr}, ${output.duration_ms}ms`;
}
