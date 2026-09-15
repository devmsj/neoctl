import { execFile, execFileSync } from "node:child_process";
import path from "node:path";

/** Deployment-owned configuration. Never accept a container name from tool input. */
export function dockerEnabled(): boolean {
  const backend = process.env.NEO_EXECUTION_BACKEND || "local";
  if (backend !== "local" && backend !== "docker") throw new Error(`Unknown execution backend: ${backend}`);
  return backend === "docker";
}

export function dockerContainer(): string {
  if (!dockerEnabled()) throw new Error("Docker execution is not enabled");
  const name = process.env.NEO_EXECUTION_CONTAINER || "neo-workspace";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error("Invalid NEO_EXECUTION_CONTAINER");
  return name;
}

export function executionCwd(cwd?: string): string {
  if (!dockerEnabled()) return path.resolve(cwd || process.cwd());
  return path.posix.resolve("/workspace", cwd || ".");
}

export function dockerHostEnv(): NodeJS.ProcessEnv {
  // Only the Docker client runs on the host. Agent-supplied env never configures it.
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };
}

export function dockerArgs(argv: readonly string[], cwd = "/", env: Record<string, string> = {}, tty = false): string[] {
  const args = ["exec", "-i", ...(tty ? ["-t"] : []), "--user", "0", "--workdir", executionCwd(cwd)];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid command environment");
    args.push("--env", `${key}=${value}`);
  }
  args.push(dockerContainer(), ...argv);
  return args;
}

export function dockerRun(args: string[], input?: string | Buffer, maxBuffer = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", args, { env: dockerHostEnv(), encoding: "buffer", maxBuffer, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Container operation failed: ${stderr.toString().slice(0, 2000) || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export function dockerRunSync(args: string[], input?: string | Buffer): Buffer {
  return execFileSync("docker", args, { input, env: dockerHostEnv(), maxBuffer: 32 * 1024 * 1024, timeout: 60_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

export async function verifyDockerBackend(): Promise<void> {
  if (!dockerEnabled()) return;
  if (process.platform !== "linux") throw new Error("Docker execution backend requires a Linux service host");
  const [info] = JSON.parse((await dockerRun(["inspect", dockerContainer()])).toString());
  const host = info?.HostConfig;
  if (!info?.State?.Running) throw new Error("Execution container is not running");
  if (host?.Privileged || host?.NetworkMode === "host" || String(host?.NetworkMode).startsWith("container:") || host?.PidMode === "host" || host?.IpcMode === "host") throw new Error("Unsafe execution container namespaces");
  if (host?.CapAdd?.length || host?.Devices?.length || host?.DeviceRequests?.length || host?.VolumesFrom?.length) throw new Error("Execution container has extra host privileges");
  if (!host?.SecurityOpt?.some((v: string) => v === "no-new-privileges" || v === "no-new-privileges=true")) throw new Error("Execution container requires no-new-privileges");
  if (!host?.Memory || !host?.NanoCpus || !(host?.PidsLimit > 0)) throw new Error("Execution container requires CPU, memory and PID limits");
  if (info.Mounts?.some((mount: { Type: string; Destination: string }) => mount.Type !== "volume" || mount.Destination !== "/workspace")) throw new Error("Only the /workspace data volume may be mounted");
  if (Object.keys(host?.PortBindings || {}).length) throw new Error("Execution container must not publish ports");
  await dockerRun(dockerArgs(["node", "-e", "if(process.getuid()!==0)process.exit(1);process.stdout.write('ok')"]));
}
