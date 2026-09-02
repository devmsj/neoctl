import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";

export type ExecOutputStream = "stdout" | "stderr";
export type ExecProcessStatus = "running" | "exited" | "failed" | "timed_out" | "killed";
export type ExecTerminationReason =
  | "completed"
  | "failed"
  | "user_interrupt"
  | "user_terminate"
  | "user_kill"
  | "timeout"
  | "external_signal"
  | "spawn_error";

export interface ExecProcessStartOptions {
  ownerId?: string;
  command: string;
  description?: string;
  cwd: string;
  shell: {
    requested: string;
    file: string;
    args: string[];
  };
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  tty: boolean;
}

export interface ExecProcessOutputDelta {
  sessionId: string;
  stream: ExecOutputStream;
  text: string;
}

export interface ExecProcessResult {
  status: ExecProcessStatus;
  session_id: string;
  process_id: number | null;
  command: string;
  description?: string;
  cwd: string;
  shell: string;
  tty: boolean;
  exit_code: number | null;
  signal: string | number | null;
  termination_reason: ExecTerminationReason | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  output_chars: { stdout: number; stderr: number };
  omitted_chars: { stdout: number; stderr: number };
}

export interface ExecProcessInteraction {
  ownerId?: string;
  chars?: string;
  signal?: "interrupt" | "terminate" | "kill";
  yieldTimeMs: number;
  onOutput?: (delta: ExecProcessOutputDelta) => void;
  abortSignal?: AbortSignal;
}

interface ProcessBackend {
  readonly pid: number | null;
  write(data: string): void;
  interrupt(): void;
  terminate(force: boolean): void;
  dispose(): void;
}

interface ProcessSession {
  id: string;
  options: ExecProcessStartOptions;
  backend: ProcessBackend;
  startedAt: number;
  finishedAt?: number;
  backgrounded: boolean;
  status: ExecProcessStatus;
  exitCode: number | null;
  signal: string | number | null;
  terminationReason: ExecTerminationReason | null;
  requestedTerminationReason?: Extract<ExecTerminationReason, "user_interrupt" | "user_terminate" | "user_kill" | "timeout">;
  stdout: TextWindow;
  stderr: TextWindow;
  waiters: Set<() => void>;
  subscribers: Set<(delta: ExecProcessOutputDelta) => void>;
  interactionTail: Promise<void>;
  timeout?: NodeJS.Timeout;
  escalation?: NodeJS.Timeout;
  cleanup?: NodeJS.Timeout;
}

export class ExecProcessManager {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly subscribers = new Set<() => void>();
  private nextId = 1;

  constructor(
    private readonly options: {
      maxProcesses?: number;
      completedRetentionMs?: number;
    } = {},
  ) {}

  start(options: ExecProcessStartOptions): string {
    this.prune();
    const id = `${this.nextId++}_${randomBytes(3).toString("hex")}`;
    const session = this.createSession(id, options);
    this.sessions.set(id, session);
    this.notify();
    session.timeout = setTimeout(() => {
      if (session.status !== "running") return;
      session.requestedTerminationReason = "timeout";
      session.backend.terminate(false);
      session.escalation = setTimeout(() => {
        if (session.status === "running") session.backend.terminate(true);
      }, 1_000).unref();
    }, options.timeoutMs);
    session.timeout.unref();
    return id;
  }

  async interact(sessionId: string, interaction: ExecProcessInteraction): Promise<ExecProcessResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown terminal session: ${sessionId}`);
    if (session.options.ownerId && interaction.ownerId !== session.options.ownerId) {
      throw new Error(`Terminal session ${sessionId} does not belong to the current session`);
    }

    let release!: () => void;
    const previous = session.interactionTail;
    session.interactionTail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    await previous;

    if (interaction.onOutput) session.subscribers.add(interaction.onOutput);
    try {
      if (interaction.signal) {
        this.signal(session, interaction.signal);
      } else if (interaction.chars) {
        if (session.status !== "running") throw new Error(`Terminal session ${sessionId} is no longer running`);
        session.backend.write(interaction.chars);
      }

      if (session.status === "running" && interaction.yieldTimeMs > 0) {
        await this.waitForExit(session, interaction.yieldTimeMs, interaction.abortSignal);
      }
      return this.drain(session);
    } finally {
      if (interaction.onOutput) session.subscribers.delete(interaction.onOutput);
      release();
    }
  }

  async execute(
    options: ExecProcessStartOptions,
    yieldTimeMs: number,
    onOutput?: (delta: ExecProcessOutputDelta) => void,
    abortSignal?: AbortSignal,
  ): Promise<ExecProcessResult> {
    const sessionId = this.start(options);
    const result = await this.interact(sessionId, { ownerId: options.ownerId, yieldTimeMs, onOutput, abortSignal });
    if (result.status === "running") {
      const session = this.sessions.get(sessionId);
      if (session && !session.backgrounded) {
        session.backgrounded = true;
        this.notify();
      }
    }
    return result;
  }

  list(): Array<Pick<ExecProcessResult, "session_id" | "process_id" | "status" | "command" | "description" | "cwd" | "shell" | "duration_ms" | "tty" | "termination_reason"> & { backgrounded: boolean }> {
    return [...this.sessions.values()].map((session) => ({
      session_id: session.id,
      process_id: session.backend.pid,
      status: session.status,
      command: session.options.command,
      description: session.options.description,
      cwd: session.options.cwd,
      shell: session.options.shell.requested,
      duration_ms: (session.finishedAt ?? Date.now()) - session.startedAt,
      tty: session.options.tty,
      termination_reason: session.terminationReason,
      backgrounded: session.backgrounded,
    }));
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((session) => session.status === "running" && session.backgrounded).length;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  terminateAll(): void {
    for (const session of this.sessions.values()) {
      if (session.status === "running") {
        session.requestedTerminationReason = "user_kill";
        session.backend.terminate(true);
      }
    }
  }

  private createSession(id: string, options: ExecProcessStartOptions): ProcessSession {
    let session!: ProcessSession;
    const onOutput = (stream: ExecOutputStream, text: string) => {
      const normalized = normalizeOutput(text);
      if (!normalized) return;
      session[stream].push(normalized);
      const delta = { sessionId: id, stream, text: normalized };
      for (const subscriber of session.subscribers) subscriber(delta);
    };
    const onExit = (exitCode: number | null, signal: string | number | null, error?: Error) => {
      if (session.finishedAt !== undefined) return;
      if (error) onOutput("stderr", `${error.message}\n`);
      this.finalizeSession(session, exitCode, signal, error);
      session.backend.dispose();
    };
    const backend = options.tty
      ? createPtyBackend(options, (text) => onOutput("stdout", text), onExit)
      : createPipeBackend(options, onOutput, onExit);
    session = {
      id,
      options,
      backend,
      startedAt: Date.now(),
      backgrounded: false,
      status: "running",
      exitCode: null,
      signal: null,
      terminationReason: null,
      stdout: new TextWindow(options.maxOutputChars),
      stderr: new TextWindow(options.maxOutputChars),
      waiters: new Set(),
      subscribers: new Set(),
      interactionTail: Promise.resolve(),
    };
    return session;
  }

  private signal(session: ProcessSession, signal: NonNullable<ExecProcessInteraction["signal"]>): void {
    if (session.status !== "running") return;
    if (signal === "interrupt") {
      session.requestedTerminationReason = "user_interrupt";
      session.backend.interrupt();
      return;
    }
    session.requestedTerminationReason = signal === "kill" ? "user_kill" : "user_terminate";
    session.backend.terminate(signal === "kill");
  }

  private finalizeSession(
    session: ProcessSession,
    exitCode: number | null,
    signal: string | number | null,
    error?: Error,
  ): void {
    if (session.finishedAt !== undefined) return;
    session.finishedAt = Date.now();
    const requested = session.requestedTerminationReason;
    if (requested === "timeout") {
      session.status = "timed_out";
      session.exitCode = null;
      session.signal = null;
      session.terminationReason = "timeout";
    } else if (requested) {
      session.status = "killed";
      session.exitCode = null;
      session.signal = signal;
      session.terminationReason = requested;
    } else if (error) {
      session.status = "failed";
      session.exitCode = null;
      session.signal = signal;
      session.terminationReason = "spawn_error";
    } else if (signal !== null) {
      session.status = "killed";
      session.exitCode = exitCode;
      session.signal = signal;
      session.terminationReason = "external_signal";
    } else {
      session.status = "exited";
      session.exitCode = exitCode;
      session.signal = null;
      session.terminationReason = exitCode === 0 ? "completed" : "failed";
    }
    this.notifyExit(session);
  }

  private notifyExit(session: ProcessSession): void {
    if (session.timeout) clearTimeout(session.timeout);
    if (session.escalation) clearTimeout(session.escalation);
    for (const waiter of [...session.waiters]) waiter();
    session.waiters.clear();
    if (!session.cleanup) {
      session.cleanup = setTimeout(() => {
        this.sessions.delete(session.id);
        this.notify();
      }, this.options.completedRetentionMs ?? 300_000);
      session.cleanup.unref();
    }
    this.notify();
  }

  private waitForExit(session: ProcessSession, waitMs: number, abortSignal?: AbortSignal): Promise<void> {
    if (session.status !== "running" || waitMs <= 0 || abortSignal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.waiters.delete(finish);
        abortSignal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      session.waiters.add(finish);
      abortSignal?.addEventListener("abort", finish, { once: true });
    });
  }

  private drain(session: ProcessSession): ExecProcessResult {
    const stdout = session.stdout.drain();
    const stderr = session.stderr.drain();
    return {
      status: session.status,
      session_id: session.id,
      process_id: session.backend.pid,
      command: session.options.command,
      description: session.options.description,
      cwd: session.options.cwd,
      shell: session.options.shell.requested,
      tty: session.options.tty,
      exit_code: session.exitCode,
      signal: session.signal,
      termination_reason: session.terminationReason,
      duration_ms: (session.finishedAt ?? Date.now()) - session.startedAt,
      timed_out: session.status === "timed_out",
      stdout: stdout.text,
      stderr: stderr.text,
      output_chars: { stdout: stdout.observed, stderr: stderr.observed },
      omitted_chars: { stdout: stdout.omitted, stderr: stderr.omitted },
    };
  }

  private prune(): void {
    const limit = this.options.maxProcesses ?? 64;
    if (this.sessions.size < limit) return;
    const completed = [...this.sessions.values()].filter((session) => session.status !== "running");
    completed.sort((left, right) => left.startedAt - right.startedAt);
    while (this.sessions.size >= limit && completed.length) {
      const session = completed.shift()!;
      if (session.cleanup) clearTimeout(session.cleanup);
      this.sessions.delete(session.id);
      this.notify();
    }
    if (this.sessions.size >= limit) throw new Error(`Too many active terminal sessions (limit ${limit})`);
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

class TextWindow {
  private head = "";
  private tail = "";
  private observed = 0;

  constructor(private readonly capacity: number) {}

  push(text: string): void {
    this.observed += text.length;
    const combined = this.head + this.tail + text;
    if (combined.length <= this.capacity) {
      this.head = combined;
      this.tail = "";
      return;
    }
    const headSize = Math.floor(this.capacity / 2);
    const tailSize = this.capacity - headSize;
    this.head = combined.slice(0, headSize);
    this.tail = combined.slice(-tailSize);
  }

  drain(): { text: string; observed: number; omitted: number } {
    const omitted = Math.max(0, this.observed - this.head.length - this.tail.length);
    const marker = omitted > 0 ? `\n[... ${omitted} characters omitted ...]\n` : "";
    const result = { text: this.head + marker + this.tail, observed: this.observed, omitted };
    this.head = "";
    this.tail = "";
    this.observed = 0;
    return result;
  }
}

function createPtyBackend(
  options: ExecProcessStartOptions,
  onOutput: (text: string) => void,
  onExit: (exitCode: number | null, signal: string | number | null, error?: Error) => void,
): ProcessBackend {
  const hostModule = fileURLToPath(new URL("./exec-pty-host.js", import.meta.url));
  const host = spawnChild(process.execPath, [...process.execArgv, hostModule], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let terminalPid: number | null = host.pid && host.pid > 0 ? host.pid : null;
  let ready = false;
  let disposed = false;
  let completed = false;
  let diagnostic = "";
  const pendingWrites: string[] = [];
  host.stderr?.setEncoding("utf8");
  host.stderr?.on("data", (text: string) => {
    diagnostic = (diagnostic + normalizeOutput(text)).slice(-4_000);
  });
  host.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "ready" && typeof record.pid === "number") {
      ready = true;
      if (record.pid > 0) terminalPid = record.pid;
      for (const chars of pendingWrites.splice(0)) host.send?.({ type: "write", chars });
    } else if (record.type === "data" && typeof record.text === "string") {
      onOutput(record.text);
    } else if (record.type === "exit") {
      completed = true;
      onExit(typeof record.exitCode === "number" ? record.exitCode : null, typeof record.signal === "number" ? record.signal : null);
    } else if (record.type === "error") {
      completed = true;
      onExit(null, null, new Error(typeof record.message === "string" ? record.message : "Pseudoterminal host failed"));
    }
  });
  host.once("error", (error) => {
    if (!completed) onExit(null, null, error);
  });
  host.once("exit", (code, signal) => {
    if (!completed) {
      const detail = diagnostic.trim();
      onExit(code, signal, new Error(detail || `Pseudoterminal host exited before the terminal completed`));
    }
  });
  host.send({
    type: "start",
    file: options.shell.file,
    args: [...options.shell.args, options.command],
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    cols: 120,
    rows: 30,
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    host.removeAllListeners();
    host.stderr?.destroy();
  };
  return {
    get pid() { return terminalPid; },
    write: (data) => {
      const chars = normalizePtyInput(data);
      if (!ready) pendingWrites.push(chars);
      else host.send?.({ type: "write", chars });
    },
    interrupt: () => host.send?.({ type: "write", chars: "\x03" }),
    terminate: (force) => host.send?.({ type: "terminate", force }),
    dispose,
  };
}

function createPipeBackend(
  options: ExecProcessStartOptions,
  onOutput: (stream: ExecOutputStream, text: string) => void,
  onExit: (exitCode: number | null, signal: string | number | null, error?: Error) => void,
): ProcessBackend {
  const child = spawnChild(options.shell.file, [...options.shell.args, options.command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    detached: os.platform() !== "win32",
    stdio: "pipe",
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => onOutput("stdout", text));
  child.stderr.on("data", (text: string) => onOutput("stderr", text));
  child.once("error", (error) => onExit(null, null, error));
  child.once("close", (exitCode, signal) => onExit(exitCode, signal));
  return {
    pid: child.pid && child.pid > 0 ? child.pid : null,
    write: (data) => child.stdin.write(data),
    interrupt: () => interruptPipe(child),
    terminate: (force) => terminatePipe(child, force),
    dispose: () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.removeAllListeners();
    },
  };
}

function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizePtyInput(text: string): string {
  return os.platform() === "win32" ? text.replace(/(?<!\r)\n/g, "\r") : text;
}

function interruptPipe(child: ChildProcessWithoutNullStreams): void {
  if (os.platform() === "win32") {
    terminatePipe(child, false);
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, "SIGINT");
  } catch {
    child.kill("SIGINT");
  }
}

function terminatePipe(child: ChildProcessWithoutNullStreams, force: boolean): void {
  if (!child.pid) return;
  if (os.platform() === "win32") {
    // Windows console processes do not reliably react to taskkill without /F.
    // The cross-platform intent remains available through termination_reason.
    const args = ["/pid", String(child.pid), "/t", "/f"];
    const killer = spawnChild("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}
