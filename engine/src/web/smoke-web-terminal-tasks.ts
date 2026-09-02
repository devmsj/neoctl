import { ExecProcessManager, type ExecProcessStartOptions } from "../tools/builtins/exec-process-manager.js";
import { WebRepl, type WebRuntime } from "./index.js";

async function main(): Promise<void> {
  const processManager = new ExecProcessManager({ completedRetentionMs: 2_000 });
  const started = await processManager.execute(terminalOptions(), 0);
  const sessionId = started.session_id;
  const foregroundId = processManager.start({ ...terminalOptions(), description: "尚在前台等待" });
  const runtime = {
    execProcessManager: processManager,
    taskStore: {
      activeCount: () => 0,
      subscribe: () => () => undefined,
      list: () => [],
      isTerminal: () => false,
    },
    engine: {
      getHistoryMessages: () => [],
      snapshot: () => ({ messages: 0, session: { sessionId: "web-smoke" } }),
      isFastMode: () => false,
      getAppPrompt: () => ({ hasActivePrompt: false }),
      onSessionTitleChange: () => () => undefined,
    },
    initialMetrics: {},
  } as unknown as WebRuntime;

  const repl = new WebRepl(runtime);
  const snapshot = repl.snapshot() as { backgroundTaskCount: number; backgroundTasks: Array<Record<string, unknown>> };
  const terminal = snapshot.backgroundTasks[0];
  const visible = snapshot.backgroundTaskCount === 1
    && snapshot.backgroundTasks.length === 1
    && terminal?.kind === "terminal"
    && terminal?.sessionId === sessionId
    && terminal?.command === "node background terminal smoke";
  const foregroundHidden = snapshot.backgroundTasks.every((task) => task.sessionId !== foregroundId);

  await processManager.interact(sessionId, { signal: "kill", yieldTimeMs: 3_000 });
  await processManager.interact(foregroundId, { signal: "kill", yieldTimeMs: 3_000 });
  const cleared = (repl.snapshot() as { backgroundTasks: unknown[] }).backgroundTasks.length === 0;
  const checks = { runningTerminalIsListed: visible, foregroundTerminalIsHidden: foregroundHidden, terminalIsRemovedAfterExit: cleared };
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

function terminalOptions(): ExecProcessStartOptions {
  return {
    command: "node background terminal smoke",
    description: "后台终端冒烟测试",
    cwd: process.cwd(),
    shell: { requested: "node", file: process.execPath, args: ["-e", "setTimeout(() => {}, 5000);", "--"] },
    env: {},
    timeoutMs: 10_000,
    maxOutputChars: 4_000,
    tty: false,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
