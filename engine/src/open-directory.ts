import { spawn } from "node:child_process";

export async function openDirectory(directory: string): Promise<void> {
  const opener = directoryOpener();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener.command, [...opener.args, directory], {
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

function directoryOpener(): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: "explorer", args: [] };
  if (process.platform === "darwin") return { command: "open", args: [] };
  return { command: "xdg-open", args: [] };
}
