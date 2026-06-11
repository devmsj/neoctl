#!/usr/bin/env node
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const dryRun = takeFlag("--dry-run") || takeFlag("-n") || isTruthy(process.env.npm_config_dry_run);
const skipInstall = takeFlag("--no-install");
const skipPublish = takeFlag("--no-publish");
const registry = takeOption("--registry") ?? "https://registry.npmjs.org/";
const tag = takeOption("--tag") ?? "latest";
const positional = args.filter((arg) => !arg.startsWith("-"));
const bump = positional[0] ?? "patch";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const packageName = packageJson.name;
const currentVersion = packageJson.version;
const targetVersion = resolveTargetVersion(currentVersion, bump);

console.log(`[release-local] package: ${packageName}`);
console.log(`[release-local] current: ${currentVersion}`);
console.log(`[release-local] target:  ${targetVersion}`);
console.log(`[release-local] registry: ${registry}`);
console.log(`[release-local] tag:      ${tag}`);

if (dryRun) {
  console.log("[release-local] dry run: version files will not be modified, package will not be published, global install will not run");
  await run("npm", ["pack", "--dry-run"], { cwd: root });
  console.log(`[release-local] dry run complete. Would publish ${packageName}@${targetVersion} and install it globally.`);
  process.exit(0);
}

await run("npm", ["version", targetVersion, "--no-git-tag-version"], { cwd: root });

let userconfig;
try {
  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (token) {
    userconfig = await writeTempNpmrc(registry, token);
  }

  if (!skipPublish) {
    const publishArgs = ["publish", "--registry", registry, "--tag", tag];
    if (userconfig) publishArgs.push("--userconfig", userconfig);
    await run("npm", publishArgs, { cwd: root });
  } else {
    console.log("[release-local] --no-publish: skipping npm publish");
  }

  if (!skipPublish) {
    await waitForPublishedVersion(packageName, targetVersion, registry, root);
  }

  if (!skipInstall) {
    await run("npm", ["install", "-g", `${packageName}@${targetVersion}`, "--registry", registry], { cwd: root });
  } else {
    console.log("[release-local] --no-install: skipping global install");
  }

  if (!skipPublish) {
    await run("npm", ["view", packageName, "version", "dist-tags", "--registry", registry], { cwd: root });
  }
  if (!skipInstall) {
    await run("npm", ["list", "-g", packageName, "--depth=0"], { cwd: root });
  }

  console.log(`[release-local] done: ${packageName}@${targetVersion}`);
} finally {
  if (userconfig) await rm(userconfig, { force: true }).catch(() => undefined);
}

function takeFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(name) {
  const equalsIndex = args.findIndex((arg) => arg.startsWith(`${name}=`));
  if (equalsIndex !== -1) {
    const value = args[equalsIndex].slice(name.length + 1);
    args.splice(equalsIndex, 1);
    return value;
  }
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

function isTruthy(value) {
  return value === "true" || value === "1" || value === "yes";
}

function resolveTargetVersion(currentVersion, bump) {
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bump)) return bump;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion);
  if (!match) throw new Error(`Cannot bump non-standard version: ${currentVersion}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  throw new Error(`Unknown bump/version '${bump}'. Use patch, minor, major, or an explicit x.y.z version.`);
}

async function writeTempNpmrc(registry, token) {
  const dir = await mkdtemp(path.join(tmpdir(), "neoctl-release-"));
  const file = path.join(dir, ".npmrc");
  const registryUrl = new URL(registry);
  const fs = await import("node:fs/promises");
  await fs.writeFile(file, `//${registryUrl.host}/:_authToken=${token}\nregistry=${registry}\n`, "utf8");
  return file;
}

async function waitForPublishedVersion(packageName, targetVersion, registry, cwd) {
  const deadline = Date.now() + 180_000;
  console.log(`[release-local] waiting for ${packageName}@${targetVersion} to be visible on ${registry}`);
  while (Date.now() < deadline) {
    const result = await runCapture("npm", ["view", packageName, "version", "--registry", registry], { cwd });
    const version = result.stdout.trim();
    if (result.code === 0 && version === targetVersion) {
      console.log(`[release-local] registry version visible: ${version}`);
      return;
    }
    console.log(`[release-local] registry version is ${version || "unavailable"}; retrying...`);
    await delay(5_000);
  }
  throw new Error(`Timed out waiting for ${packageName}@${targetVersion} to be visible on ${registry}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, commandArgs, options = {}) {
  console.log(`[release-local] $ ${command} ${commandArgs.map(quoteArg).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

function runCapture(command, commandArgs, options = {}) {
  console.log(`[release-local] $ ${command} ${commandArgs.map(quoteArg).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function quoteArg(arg) {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function printHelp() {
  console.log(`Usage: npm run release:local -- [patch|minor|major|x.y.z] [options]\n\nPublishes a new npm version and updates the local global install to that exact version.\n\nDefault bump is patch. The script updates package.json/package-lock.json using\n'npm version <version> --no-git-tag-version', runs npm publish, then runs\n'npm install -g <name>@<version>'.\n\nOptions:\n  --dry-run, -n           Run npm pack --dry-run only; do not modify, publish, or install\n  --registry <url>        Registry to publish/install from (default: https://registry.npmjs.org/)\n  --tag <tag>             npm dist-tag for publish (default: latest)\n  --no-publish            Bump version and install, but skip npm publish\n  --no-install            Bump version and publish, but skip global install\n  -h, --help              Show this help\n\nAuth:\n  Uses NODE_AUTH_TOKEN or NPM_TOKEN when set; otherwise relies on npm login.\n\nExamples:\n  npm run release:local\n  npm run release:local -- minor\n  npm run release:local -- 0.3.0\n  NODE_AUTH_TOKEN=... npm run release:local -- patch\n`);
}
