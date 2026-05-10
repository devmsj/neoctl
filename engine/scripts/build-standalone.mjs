#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(projectRoot, "standalone");
const workRoot = path.join(projectRoot, ".standalone-build");
const bootstrapPath = path.join(workRoot, "bootstrap.cjs");
const seaConfigPath = path.join(workRoot, "sea-config.json");
const seaBlobPath = path.join(workRoot, "neo.blob");
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const appName = "neo";
const platformKey = `${process.platform}-${process.arch}`;
const exeName = process.platform === "win32" ? `${appName}.exe` : appName;
const outDir = path.join(outRoot, platformKey);
const outExePath = path.join(outDir, exeName);
const nodeBin = process.execPath;
const postjectCli = path.join(projectRoot, "node_modules", "postject", "dist", "cli.js");

await main();

async function main() {
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(workRoot, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  await ensureRipgrep();
  await writeBootstrap();
  await writeSeaConfig();
  await runNode(["--experimental-sea-config", seaConfigPath]);
  await copyNodeBinary();
  await injectSeaBlob();
  await copyRuntimeFiles();
  await writeManifest();

  console.log(`[standalone] built ${path.relative(projectRoot, outExePath)}`);
}

async function ensureRipgrep() {
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  const rgPath = path.join(projectRoot, "vendor", "ripgrep", platformKey, executable);
  if (existsSync(rgPath)) return;
  await runNode([path.join(projectRoot, "scripts", "install-ripgrep.cjs")]);
}

async function writeBootstrap() {
  await fs.writeFile(bootstrapPath, `
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const exeDir = path.dirname(process.execPath);
const entry = path.join(exeDir, "dist", "repl", "index.js");
const userArgs = process.argv.slice(1);
process.argv = [process.execPath, entry, ...userArgs];
process.env.AGENT_VENDOR_DIR ||= exeDir;

import(pathToFileURL(entry).href).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`, "utf8");
}

async function writeSeaConfig() {
  await fs.writeFile(
    seaConfigPath,
    `${JSON.stringify({
      main: bootstrapPath,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }, null, 2)}\n`,
    "utf8",
  );
}

async function copyNodeBinary() {
  await fs.copyFile(nodeBin, outExePath);
  if (process.platform !== "win32") await fs.chmod(outExePath, 0o755);
}

async function injectSeaBlob() {
  if (!existsSync(postjectCli)) throw new Error(`postject not found at ${postjectCli}. Run npm install first.`);
  const args = [postjectCli, outExePath, "NODE_SEA_BLOB", seaBlobPath, "--overwrite", "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  await execFileAsync(nodeBin, args, { cwd: projectRoot, maxBuffer: 1024 * 1024 * 20 });
}

async function copyRuntimeFiles() {
  await fs.cp(path.join(projectRoot, "dist"), path.join(outDir, "dist"), { recursive: true });
  await fs.cp(path.join(projectRoot, "node_modules"), path.join(outDir, "node_modules"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.cache${path.sep}`),
  });

  const packageForRuntime = {
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    dependencies: packageJson.dependencies,
  };
  await fs.writeFile(path.join(outDir, "package.json"), `${JSON.stringify(packageForRuntime, null, 2)}\n`, "utf8");

  const rgSource = path.join(projectRoot, "vendor", "ripgrep", platformKey);
  if (existsSync(rgSource)) {
    await fs.cp(rgSource, path.join(outDir, "vendor", "ripgrep", platformKey), { recursive: true });
  }
}

async function writeManifest() {
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify({
      name: packageJson.name,
      command: appName,
      version: packageJson.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      platformKey,
      builtAt: new Date().toISOString(),
      executable: exeName,
      entry: "dist/repl/index.js",
      notes: "Portable standalone distribution built with Node.js SEA bootstrap. Node.js does not need to be installed on the target machine; keep the bundled files beside the executable.",
    }, null, 2)}\n`,
    "utf8",
  );
}

async function runNode(args) {
  await execFileAsync(nodeBin, args, { cwd: projectRoot, maxBuffer: 1024 * 1024 * 20 });
}
