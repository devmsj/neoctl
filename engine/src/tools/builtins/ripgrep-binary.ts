import fs from "node:fs";
import path from "node:path";

export interface RipgrepBinaryResolution {
  executablePath: string;
  platformKey: string;
}

export function resolveBundledRipgrepBinary(env: NodeJS.ProcessEnv = process.env): RipgrepBinaryResolution {
  const platformKey = ripgrepPlatformKey();
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  const override = env.AGENT_RG_PATH;

  if (override) {
    const executablePath = path.resolve(override);
    assertExecutableExists(executablePath, "AGENT_RG_PATH");
    return { executablePath, platformKey };
  }

  for (const root of candidateRoots(env)) {
    const executablePath = path.join(root, "vendor", "ripgrep", platformKey, executable);
    if (fs.existsSync(executablePath)) return { executablePath, platformKey };
  }

  throw new Error(
    `Bundled ripgrep binary not found for ${platformKey}. Run npm run vendor:rg before using the search tool.`,
  );
}

export function ripgrepPlatformKey(): string {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "win32-x64":
    case "win32-arm64":
    case "linux-x64":
    case "linux-arm64":
    case "darwin-x64":
    case "darwin-arm64":
      return key;
    default:
      throw new Error(`Unsupported ripgrep platform: ${key}`);
  }
}

function candidateRoots(env: NodeJS.ProcessEnv): string[] {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const roots = [
    env.AGENT_VENDOR_DIR,
    process.cwd(),
    path.resolve(__dirname, "../../.."),
    electronProcess.resourcesPath,
    path.dirname(process.execPath),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function assertExecutableExists(executablePath: string, source: string): void {
  if (!fs.existsSync(executablePath)) {
    throw new Error(`${source} points to a missing ripgrep binary: ${executablePath}`);
  }
}
