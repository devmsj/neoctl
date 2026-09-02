import { spawn as spawnChild } from "node:child_process";
import os from "node:os";
import { spawn, type IPty } from "@lydell/node-pty";

interface StartMessage {
  type: "start";
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

type HostMessage = StartMessage
  | { type: "write"; chars: string }
  | { type: "terminate"; force: boolean };

let terminal: IPty | undefined;
let finished = false;

process.on("message", (message: HostMessage) => {
  if (message.type === "start") {
    if (terminal) return;
    try {
      terminal = spawn(message.file, message.args, {
        cwd: message.cwd,
        env: message.env,
        name: "xterm-256color",
        cols: message.cols,
        rows: message.rows,
      });
      send({ type: "ready", pid: terminal.pid });
      terminal.onData((text) => send({ type: "data", text }));
      terminal.onExit(({ exitCode, signal }) => finish({ type: "exit", exitCode, signal: signal ?? null }));
    } catch (error) {
      finish({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (!terminal) return;
  if (message.type === "write") {
    terminal.write(message.chars);
    return;
  }
  terminateTerminal(terminal, message.force);
});

process.on("disconnect", () => {
  if (terminal && !finished) terminateTerminal(terminal, true);
  setTimeout(() => process.exit(0), 250).unref();
});

function terminateTerminal(target: IPty, force: boolean): void {
  if (os.platform() === "win32" && target.pid > 0) {
    const args = ["/pid", String(target.pid), "/t", ...(force ? ["/f"] : [])];
    const killer = spawnChild("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
    killer.unref();
  }
  try {
    target.kill(os.platform() === "win32" ? undefined : force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The terminal may have exited between the manager's status check and this request.
  }
  setTimeout(() => process.exit(0), 1_500);
}

function finish(message: Record<string, unknown>): void {
  if (finished) return;
  finished = true;
  send(message, () => setImmediate(() => process.exit(0)));
}

function send(message: Record<string, unknown>, callback?: () => void): void {
  if (!process.connected) {
    callback?.();
    return;
  }
  if (callback) process.send?.(message, () => callback());
  else process.send?.(message);
}
