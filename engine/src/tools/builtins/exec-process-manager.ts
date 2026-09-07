import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  TerminalOutputStore, redactedTerminalChunk, TERMINAL_OUTPUT_RETENTION_MS,
  type StoreResult, type RunView, type OutputPage, type TerminalRunMetadata,
} from "../terminal-output-store.js";

export type { StoreResult, RunView, OutputPage } from "../terminal-output-store.js";

/** UTF-8 byte offsets in ONE redacted stream; marker text is not part of these ranges. */
export interface ExecOutputRange {
  start: number;
  end: number;
  retained: Array<{ start: number; end: number }>;
  gaps: Array<{ start: number; end: number }>;
  truncated: boolean;
}
export interface ExecOutputReference {
  owner_session_id: string | null;
  run_id: string;
  availability: RunView["record"]["availability"] | "unavailable";
  reason?: string;
  persistence?: RunView["persistence"];
  truncated?: boolean;
  byte_limit?: number;
  expires_at?: number | null;
  streams?: RunView["record"]["streams"];
}

const LIVE_OUTPUT_MAX_CHARS = 40_000;

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
  /** Trusted runtime session directory, never a tool argument. */
  sessionDir?: string;
  command: string;
  description?: string;
  cwd: string;
  shell: {
    requested: string;
    file: string;
    args: string[];
    commandPrefix?: string;
  };
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  tty: boolean;
  redactOutput?: (text: string) => string;
  createStreamingRedactor?: () => { push(chunk: string): string; flush(): string };
}

export interface ExecProcessOutputDelta {
  sessionId: string;
  stream: ExecOutputStream;
  text: string;
  ownerSessionId?: string;
  outputKind?: "incremental";
  /** Authoritative stream text; legacy background text may include a display prefix. */
  streamText?: string;
  streamStart?: number;
  streamEnd?: number;
  cursorUnit?: "utf8_bytes";
  streamMode?: "separate" | "tty_merged";
  /** Legacy mixed-display UTF-16 offsets, NOT output-store cursors. */
  outputStart?: number;
  outputEnd?: number;
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
  owner_session_id?: string;
  started_at: number;
  finished_at: number | null;
  output_kind: "incremental";
  output_cursor_unit: "utf8_bytes";
  stream_mode: "separate" | "tty_merged";
  output_ranges: Record<ExecOutputStream, ExecOutputRange>;
  output_ref: ExecOutputReference;
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
  liveOutput: TextWindow;
  waiters: Set<() => void>;
  subscribers: Set<(delta: ExecProcessOutputDelta) => void>;
  interactionTail: Promise<void>;
  timeout?: NodeJS.Timeout;
  escalation?: NodeJS.Timeout;
  cleanup?: NodeJS.Timeout;
  outputRecord?: RunView;
  outputFailure?: string;
  outputStore?: TerminalOutputStore;
}

export class ExecProcessManager {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly subscribers = new Set<() => void>();
  private readonly outputSubscribers = new Set<(delta: ExecProcessOutputDelta) => void>();
  private nextId = 1;
  private readonly ownerBindings = new Map<string, { dir: string; store: TerminalOutputStore }>();
  private readonly stores = new Map<string, TerminalOutputStore>();

  constructor(
    private readonly options: {
      maxProcesses?: number;
      completedRetentionMs?: number;
      /** Trusted global root, optional for legacy runtimes. */
      sessionsRoot?: string;
      /** Injectable independent store for tests/hosts already owning a single store. */
      outputStore?: TerminalOutputStore;
    } = {},
  ) {}

  /** Bind only an authorized runtime session's actual directory. Never accept an HTTP path. */
  registerOwnerSession(ownerSessionId: string, sessionDir: string): StoreResult<{ records: RunView[]; rejected: number }> {
    return this.storeGuard(() => {
      if (!ownerSessionId || !path.isAbsolute(sessionDir)) return { ok: false, reason: "invalid-input" };
      const dir = path.resolve(sessionDir);
      const existing = this.ownerBindings.get(ownerSessionId);
      const equal = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (existing && !equal(existing.dir, dir)) return { ok: false, reason: "conflict" };
      for (const [id, binding] of this.ownerBindings) {
        if (id !== ownerSessionId && equal(binding.dir, dir)) return { ok: false, reason: "conflict" };
      }
      const root = path.resolve(this.options.sessionsRoot ?? path.dirname(dir));
      const key = process.platform === "win32" ? root.toLowerCase() : root;
      let store = existing?.store ?? this.options.outputStore ?? this.stores.get(key);
      if (!store) {
        store = new TerminalOutputStore({ sessionsRoot: root,
          resolveOwnerSessionDir: (id) => this.ownerBindings.get(id)?.dir });
        this.stores.set(key, store);
      }
      this.ownerBindings.set(ownerSessionId, { dir, store });
      const restored = store.restoreSession(ownerSessionId, dir);
      if (!restored.ok && !existing) this.ownerBindings.delete(ownerSessionId);
      return restored;
    });
  }

  listHistory(ownerSessionId: string, pagination: { offset?: number; limit?: number } = {}): StoreResult<{ records: RunView[]; nextOffset: number | null }> {
    return this.storeGuard(() => this.ownerBindings.get(ownerSessionId)?.store.listHistory(ownerSessionId, pagination)
      ?? { ok: false, reason: "not-found" });
  }

  readOutput(ownerSessionId: string, runId: string, page: { stream: ExecOutputStream; offset?: number; limitBytes?: number }): StoreResult<OutputPage> {
    const result = this.storeGuard(() => this.ownerBindings.get(ownerSessionId)?.store.read(ownerSessionId, runId, page)
      ?? { ok: false, reason: "not-found" });
    const session = this.sessions.get(runId);
    if (session?.options.ownerId === ownerSessionId && result.ok) {
      // Keep availability/facts in live projections aligned after a read discovers expiry or I/O loss.
      session.outputRecord = { record: structuredClone(result.value.record), persistence: result.value.persistence };
    }
    return result;
  }

  /** Cleanup is independent of process execution and never turns a successful exit into a tool error. */
  sweepOutput(): void {
    for (const store of new Set([...this.ownerBindings.values()].map((binding) => binding.store))) {
      this.storeGuard(() => store.sweep());
    }
  }

  private storeGuard<T>(action: () => StoreResult<T>): StoreResult<T> {
    try { return action(); } catch { return { ok: false, reason: "io-error" }; }
  }

  private recordOutputResult(session: ProcessSession, result: StoreResult<RunView>): void {
    if (result.ok) session.outputRecord = result.value;
    else session.outputFailure = result.reason;
  }

  private outputReference(session: ProcessSession): ExecOutputReference {
    const view = session.outputRecord;
    const expired = view?.record.expiresAt != null && Date.now() >= view.record.expiresAt;
    return { owner_session_id: session.options.ownerId ?? null, run_id: session.id,
      availability: session.outputFailure ? "unavailable" : expired && view?.record.availability === "available" ? "expired" : view?.record.availability ?? "unavailable",
      reason: session.outputFailure ?? (!view ? "owner-session-unavailable" : undefined),
      persistence: view?.persistence, truncated: view?.record.truncated, byte_limit: view?.record.byteLimit,
      expires_at: view?.record.expiresAt, streams: view?.record.streams };
  }

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
        if (session.timeout) clearTimeout(session.timeout);
        session.timeout = undefined;
        this.notify();
      }
    }
    return result;
  }

  /** No owner argument preserves the trusted internal legacy view. Web MUST supply an owner. */
  list(ownerSessionId?: string) {
    return [...this.sessions.values()]
      .filter((session) => ownerSessionId === undefined || session.options.ownerId === ownerSessionId)
      .map((session) => ({
        session_id: session.id,
        owner_session_id: session.options.ownerId,
        process_id: session.backend.pid,
        status: session.status,
        command: session.options.command,
        description: session.options.description,
        cwd: session.options.cwd,
        shell: session.options.shell.requested,
        started_at: session.startedAt,
        finished_at: session.finishedAt ?? null,
        duration_ms: (session.finishedAt ?? Date.now()) - session.startedAt,
        tty: session.options.tty,
        exit_code: session.exitCode,
        signal: session.signal,
        termination_reason: session.terminationReason,
        backgrounded: session.backgrounded,
        output: session.liveOutput.snapshot().text,
        outputEnd: session.liveOutput.observedChars(),
        output_kind: "snapshot" as const,
        output_cursor_unit: "utf16_code_units" as const,
        output_truncated: session.liveOutput.snapshot().omitted > 0,
        stream_mode: session.options.tty ? "tty_merged" as const : "separate" as const,
        output_ref: this.outputReference(session),
      }));
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((session) => session.status === "running" && session.backgrounded).length;
  }

  isBackgroundRunning(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return Boolean(session?.backgrounded && session.status === "running");
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  subscribeOutput(listener: (delta: ExecProcessOutputDelta) => void): () => void {
    this.outputSubscribers.add(listener);
    return () => this.outputSubscribers.delete(listener);
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
    let redactOutput = options.redactOutput;
    const redactors = {
      stdout: options.createStreamingRedactor?.(),
      stderr: options.createStreamingRedactor?.(),
    };
    // Some redactors operate on UTF-16 code units. Hold a high surrogate until its pair arrives.
    const unicodeCarry = { stdout: "", stderr: "" };
    const byteOffsets = { stdout: 0, stderr: 0 };
    const normalizers = { stdout: createOutputNormalizer(), stderr: createOutputNormalizer() };
    let liveOutputOffset = 0;
    const publishSafeOutput = (stream: ExecOutputStream, safeOutput: string) => {
      safeOutput = unicodeCarry[stream] + safeOutput;
      unicodeCarry[stream] = "";
      if (/[\uD800-\uDBFF]$/.test(safeOutput)) {
        unicodeCarry[stream] = safeOutput.slice(-1);
        safeOutput = safeOutput.slice(0, -1);
      }
      if (!safeOutput) return;
      const streamStart = byteOffsets[stream];
      byteOffsets[stream] += Buffer.byteLength(safeOutput, "utf8");
      // The ONLY full-output writer. Never append drain results or live snapshots.
      if (session.outputStore && options.ownerId) {
        this.recordOutputResult(session, this.storeGuard(() => session.outputStore!.append(
          options.ownerId!, id, redactedTerminalChunk(stream, streamStart, safeOutput))));
      }
      session[stream].push(safeOutput);
      const liveText = stream === "stderr" ? `[stderr] ${safeOutput}` : safeOutput;
      session.liveOutput.push(liveText);
      const delta: ExecProcessOutputDelta = { sessionId: id, ownerSessionId: options.ownerId,
        stream, text: safeOutput, streamText: safeOutput, outputKind: "incremental",
        streamStart, streamEnd: byteOffsets[stream], cursorUnit: "utf8_bytes",
        streamMode: options.tty ? "tty_merged" : "separate" };
      for (const subscriber of session.subscribers) subscriber(delta);
      const outputStart = liveOutputOffset;
      liveOutputOffset += liveText.length;
      if (session.backgrounded) {
        const publicDelta = { ...delta, text: liveText, outputStart, outputEnd: liveOutputOffset };
        for (const subscriber of this.outputSubscribers) subscriber(publicDelta);
      }
    };
    const onOutput = (stream: ExecOutputStream, text: string) => {
      const normalized = normalizers[stream].push(text);
      if (!normalized) return;
      const safeOutput = redactors[stream]?.push(normalized) ?? redactOutput?.(normalized) ?? normalized;
      publishSafeOutput(stream, safeOutput);
    };
    const onExit = (exitCode: number | null, signal: string | number | null, error?: Error) => {
      if (session.finishedAt !== undefined) return;
      if (error) onOutput("stderr", `${error.message}\n`);
      for (const stream of ["stdout", "stderr"] as const) {
        publishSafeOutput(stream, redactors[stream]?.flush() ?? "");
        // Invalid dangling surrogate is explicitly decoded like Node's UTF-8 output, never persisted malformed.
        if (unicodeCarry[stream]) { unicodeCarry[stream] = ""; publishSafeOutput(stream, "\ufffd"); }
      }
      redactOutput = undefined;
      session.options.redactOutput = undefined;
      this.finalizeSession(session, exitCode, signal, error);
      session.backend.dispose();
    };
    const backend = options.tty
      ? createPtyBackend(options, (text) => onOutput("stdout", text), onExit)
      : createPipeBackend(options, onOutput, onExit);
    session = {
      id,
      options: { ...options, env: {},
        command: redactOutput?.(options.command) ?? options.command,
        description: options.description === undefined ? undefined : redactOutput?.(options.description) ?? options.description,
        cwd: redactOutput?.(options.cwd) ?? options.cwd,
        shell: { ...options.shell, requested: redactOutput?.(options.shell.requested) ?? options.shell.requested },
        createStreamingRedactor: undefined },
      backend,
      startedAt: Date.now(),
      backgrounded: false,
      status: "running",
      exitCode: null,
      signal: null,
      terminationReason: null,
      stdout: new TextWindow(options.maxOutputChars),
      stderr: new TextWindow(options.maxOutputChars),
      liveOutput: new TextWindow(Math.min(options.maxOutputChars, LIVE_OUTPUT_MAX_CHARS)),
      waiters: new Set(),
      subscribers: new Set(),
      interactionTail: Promise.resolve(),
    };
    if (options.ownerId && options.sessionDir) {
      const binding = this.ownerBindings.get(options.ownerId);
      const registered = binding?.dir === path.resolve(options.sessionDir)
        ? { ok: true as const, value: { records: [], rejected: 0 } }
        : this.registerOwnerSession(options.ownerId, options.sessionDir);
      if (!registered.ok) session.outputFailure = registered.reason;
      else {
        session.outputStore = this.ownerBindings.get(options.ownerId)!.store;
        this.recordOutputResult(session, this.storeGuard(() => session.outputStore!.start(
          options.ownerId!, options.sessionDir!, id, {
            startedAt: session.startedAt, processId: backend.pid, tty: options.tty, sessionId: id,
            status: "running", ...boundedRunMetadata(session.options),
          })));
      }
    }
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
      session.exitCode = exitCode;
      session.signal = signal;
      session.terminationReason = "timeout";
    } else if (requested) {
      session.status = "killed";
      session.exitCode = exitCode;
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
    if (session.outputStore && session.options.ownerId) {
      this.recordOutputResult(session, this.storeGuard(() => session.outputStore!.finalize(
        session.options.ownerId!, session.id, {
          status: session.status, finishedAt: session.finishedAt!, exitCode: session.exitCode,
          signal: session.signal, terminationReason: session.terminationReason,
          durationMs: session.finishedAt! - session.startedAt,
        })));
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
        this.sweepOutput();
        this.notify();
      }, this.options.completedRetentionMs ?? TERMINAL_OUTPUT_RETENTION_MS);
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
      owner_session_id: session.options.ownerId,
      started_at: session.startedAt,
      finished_at: session.finishedAt ?? null,
      output_kind: "incremental",
      output_cursor_unit: "utf8_bytes",
      stream_mode: session.options.tty ? "tty_merged" : "separate",
      output_ranges: { stdout: stdout.range, stderr: stderr.range },
      output_ref: this.outputReference(session),
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
      if (session.outputStore && session.options.ownerId) {
        this.recordOutputResult(session, this.storeGuard(() => session.outputStore!.evict(session.options.ownerId!, session.id)));
      }
      this.sessions.delete(session.id);
      this.notify();
    }
    if (this.sessions.size >= limit) throw new Error(`Too many active terminal sessions (limit ${limit})`);
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

function boundedRunMetadata(options: ExecProcessStartOptions): Pick<TerminalRunMetadata, "command" | "cwd" | "shell" | "description" | "truncatedFields"> {
  const result: Pick<TerminalRunMetadata, "command" | "cwd" | "shell" | "description" | "truncatedFields"> = {};
  const limits = { command: 4096, cwd: 2048, shell: 256, description: 2048 } as const;
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const text = key === "shell" ? options.shell.requested : options[key];
    if (text === undefined) continue;
    const bytes = Buffer.from(text, "utf8");
    let end = Math.min(limits[key], bytes.length);
    if (end < bytes.length) {
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      (result.truncatedFields ??= []).push(key);
    }
    result[key] = bytes.subarray(0, end).toString("utf8");
  }
  return result;
}

class TextWindow {
  private head = "";
  private tail = "";
  private observed = 0;
  private startByte = 0;
  private endByte = 0;

  constructor(private readonly capacity: number) {}

  push(text: string): void {
    const wasTruncated = this.observed > this.head.length + this.tail.length;
    this.observed += text.length;
    this.endByte += Buffer.byteLength(text, "utf8");
    if (wasTruncated) {
      const tailSize = this.capacity - Math.floor(this.capacity / 2);
      this.tail = (tailSize ? (this.tail + text).slice(-tailSize) : "").replace(/^[\uDC00-\uDFFF]/, "");
      return;
    }
    const combined = this.head + this.tail + text;
    if (combined.length <= this.capacity) {
      this.head = combined;
      this.tail = "";
      return;
    }
    const headSize = Math.floor(this.capacity / 2);
    const tailSize = this.capacity - headSize;
    this.head = combined.slice(0, headSize).replace(/[\uD800-\uDBFF]$/, "");
    this.tail = (tailSize ? combined.slice(-tailSize) : "").replace(/^[\uDC00-\uDFFF]/, "");
  }

  observedChars(): number {
    return this.observed;
  }

  snapshot(): { text: string; observed: number; omitted: number; range: ExecOutputRange } {
    const omitted = Math.max(0, this.observed - this.head.length - this.tail.length);
    const marker = omitted > 0 ? `\n[... ${omitted} characters omitted ...]\n` : "";
    const headEnd = this.startByte + Buffer.byteLength(this.head, "utf8");
    const tailStart = this.endByte - Buffer.byteLength(this.tail, "utf8");
    return { text: this.head + marker + this.tail, observed: this.observed, omitted,
      range: { start: this.startByte, end: this.endByte, truncated: omitted > 0,
        retained: omitted > 0 ? [{ start: this.startByte, end: headEnd }, { start: tailStart, end: this.endByte }]
          : [{ start: this.startByte, end: this.endByte }],
        gaps: omitted > 0 ? [{ start: headEnd, end: tailStart }] : [] } };
  }

  drain(): { text: string; observed: number; omitted: number; range: ExecOutputRange } {
    const result = this.snapshot();
    this.head = "";
    this.tail = "";
    this.observed = 0;
    this.startByte = this.endByte;
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
    args: [...options.shell.args, shellCommand(options)],
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
  const child = spawnChild(options.shell.file, [...options.shell.args, shellCommand(options)], {
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

function shellCommand(options: ExecProcessStartOptions): string {
  return options.shell.commandPrefix ? `${options.shell.commandPrefix}${options.command}` : options.command;
}

// Match legacy newline normalization without doubling CRLF split across process chunks.
function createOutputNormalizer(): { push(text: string): string } {
  let previousCR = false;
  return { push(text) {
    if (!text) return "";
    const input = previousCR && text.startsWith("\n") ? text.slice(1) : text;
    previousCR = text.endsWith("\r");
    return normalizeOutput(input);
  } };
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
