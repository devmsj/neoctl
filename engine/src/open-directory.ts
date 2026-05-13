import { spawn } from "node:child_process";

export async function openDirectory(directory: string): Promise<void> {
  const opener = directoryOpener(directory);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener.command, opener.args, {
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${opener.command} exited with code ${code ?? "unknown"}`));
    });
  });
}

function directoryOpener(directory: string): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: "cmd", args: ["/d", "/c", "start", "", directory] };
  if (process.platform === "darwin") return { command: "open", args: [directory] };
  return { command: "xdg-open", args: [directory] };
}
