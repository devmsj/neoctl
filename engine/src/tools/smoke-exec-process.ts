import { ExecProcessManager, type ExecProcessStartOptions } from "./builtins/exec-process-manager.js";

async function main(): Promise<void> {
  const manager = new ExecProcessManager({ completedRetentionMs: 20_000 });
  const pipe = manager.start(options(
    `process.stdin.once("data", value => { console.log("pipe:" + value.toString().trim()); process.exit(0); })`,
    false,
  ));
  const pipeStarted = await manager.interact(pipe, { yieldTimeMs: 30 });
  const pipeFinished = await manager.interact(pipe, { chars: "hello\n", yieldTimeMs: 3_000 });

  const pty = manager.start(options(
    `console.log(process.stdout.isTTY ? "tty-ready" : "no-tty"); process.stdin.once("data", value => { console.log("pty:" + value.toString().trim()); process.exit(0); })`,
    true,
  ));
  const ptyStarted = await manager.interact(pty, { yieldTimeMs: 100 });
  const ptyFinished = await manager.interact(pty, { chars: "hello\r", yieldTimeMs: 3_000 });
  const ptyOutput = ptyStarted.stdout + ptyFinished.stdout;

  const truncated = await manager.execute(
    {
      ...options(`process.stdout.write("HEAD" + "x".repeat(3000) + "TAIL"); process.stderr.write("ERRH" + "y".repeat(3000) + "ERRT")`, false),
      maxOutputChars: 1_000,
    },
    3_000,
  );

  const incrementalId = manager.start(options(
    `process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { process.stdout.write(value); if (value.includes("C")) process.exit(0); })`,
    false,
  ));
  await manager.interact(incrementalId, { yieldTimeMs: 40 });
  const incrementalA = await manager.interact(incrementalId, { chars: "A", yieldTimeMs: 80 });
  const incrementalB = await manager.interact(incrementalId, { chars: "B", yieldTimeMs: 80 });
  const incrementalC = await manager.interact(incrementalId, { chars: "C", yieldTimeMs: 3_000 });

  const completed = await manager.execute(options(`setTimeout(() => process.exit(0), 80)`, false), 3_000);
  await delay(120);
  const completedAgain = await manager.interact(completed.session_id, { yieldTimeMs: 0 });

  const timedOut = await manager.execute(
    { ...options(`setTimeout(() => process.exit(0), 5_000)`, false), timeoutMs: 120 },
    3_000,
  );
  await delay(120);
  const timedOutAgain = await manager.interact(timedOut.session_id, { yieldTimeMs: 0 });
  const timedOutThird = await manager.interact(timedOut.session_id, { yieldTimeMs: 0 });

  const interruptedId = manager.start(options(`setTimeout(() => process.exit(0), 5_000)`, false));
  await manager.interact(interruptedId, { yieldTimeMs: 40 });
  const interrupted = await manager.interact(interruptedId, { signal: "interrupt", yieldTimeMs: 3_000 });

  const terminatedId = manager.start(options(`setTimeout(() => process.exit(0), 5_000)`, false));
  await manager.interact(terminatedId, { yieldTimeMs: 40 });
  const terminated = await manager.interact(terminatedId, { signal: "terminate", yieldTimeMs: 3_000 });

  const killedId = manager.start(options(`setTimeout(() => process.exit(0), 5_000)`, false));
  await manager.interact(killedId, { yieldTimeMs: 40 });
  const killed = await manager.interact(killedId, { signal: "kill", yieldTimeMs: 3_000 });
  const interruptedAgain = await manager.interact(interruptedId, { yieldTimeMs: 0 });
  const terminatedAgain = await manager.interact(terminatedId, { yieldTimeMs: 0 });
  const killedAgain = await manager.interact(killedId, { yieldTimeMs: 0 });

  const checks = {
    pipeYields: pipeStarted.status === "running" && pipeStarted.stdout === "",
    pipeAcceptsInput: pipeFinished.status === "exited" && pipeFinished.exit_code === 0 && pipeFinished.stdout.includes("pipe:hello"),
    ptyIsRealTerminal: ptyFinished.status === "exited" && ptyFinished.exit_code === 0 && ptyOutput.includes("tty-ready"),
    ptyHasMeaningfulProcessId: typeof ptyStarted.process_id === "number" && ptyStarted.process_id > 0,
    ptyAcceptsInput: ptyOutput.includes("pty:hello"),
    outputKeepsHeadAndTail:
      truncated.stdout.includes("HEAD") &&
      truncated.stdout.includes("TAIL") &&
      truncated.stderr.includes("ERRH") &&
      truncated.stderr.includes("ERRT") &&
      truncated.output_chars.stdout === 3_008 &&
      truncated.output_chars.stderr === 3_008 &&
      truncated.omitted_chars.stdout === 2_008 &&
      truncated.omitted_chars.stderr === 2_008,
    outputIsIncremental:
      incrementalA.stdout === "A" && incrementalB.stdout === "B" && incrementalC.stdout === "C",
    completedDurationIsStable:
      completed.termination_reason === "completed" && completed.duration_ms === completedAgain.duration_ms,
    timeoutTerminalIsStable:
      timedOut.status === "timed_out" &&
      timedOut.exit_code === null &&
      timedOut.termination_reason === "timeout" &&
      timedOut.status === timedOutAgain.status &&
      timedOut.exit_code === timedOutAgain.exit_code &&
      timedOut.duration_ms === timedOutAgain.duration_ms &&
      timedOut.termination_reason === timedOutAgain.termination_reason &&
      timedOutAgain.duration_ms === timedOutThird.duration_ms,
    interruptReason:
      interrupted.status === "killed" &&
      interrupted.termination_reason === "user_interrupt" &&
      sameTerminalState(interrupted, interruptedAgain),
    terminateReason:
      terminated.status === "killed" &&
      terminated.termination_reason === "user_terminate" &&
      sameTerminalState(terminated, terminatedAgain),
    killReason:
      killed.status === "killed" &&
      killed.termination_reason === "user_kill" &&
      sameTerminalState(killed, killedAgain),
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    ok,
    checks,
    controls: {
      interrupt: pickTerminalState(interrupted),
      terminate: pickTerminalState(terminated),
      kill: pickTerminalState(killed),
    },
  }, null, 2));
  manager.terminateAll();
  if (!ok) process.exitCode = 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickTerminalState(result: { status: string; termination_reason: string | null; exit_code: number | null }) {
  return { status: result.status, termination_reason: result.termination_reason, exit_code: result.exit_code };
}

function sameTerminalState(
  left: { status: string; termination_reason: string | null; exit_code: number | null; duration_ms: number },
  right: { status: string; termination_reason: string | null; exit_code: number | null; duration_ms: number },
): boolean {
  return left.status === right.status
    && left.termination_reason === right.termination_reason
    && left.exit_code === right.exit_code
    && left.duration_ms === right.duration_ms;
}

function options(command: string, tty: boolean): ExecProcessStartOptions {
  return {
    command,
    cwd: process.cwd(),
    shell: { requested: "node", file: process.execPath, args: ["-e"] },
    env: {},
    timeoutMs: 10_000,
    maxOutputChars: 4_000,
    tty,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
