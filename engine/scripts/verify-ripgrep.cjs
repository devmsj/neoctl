#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(PROJECT_ROOT, "vendor", "ripgrep");
const SKIP_GIT = process.argv.includes("--skip-git");
const TARGETS = [
  ["win32-x64", "rg.exe", "pe"],
  ["win32-arm64", "rg.exe", "pe"],
  ["linux-x64", "rg", "elf"],
  ["linux-arm64", "rg", "elf"],
  ["darwin-x64", "rg", "macho"],
  ["darwin-arm64", "rg", "macho"],
];
const REQUIRED_SUPPORT_FILES = ["COPYING", "LICENSE-MIT", "UNLICENSE", "manifest.json"];

for (const [platformKey, executable, format] of TARGETS) {
  const relativeFiles = [executable, ...REQUIRED_SUPPORT_FILES]
    .map((name) => path.join("vendor", "ripgrep", platformKey, name));

  for (const relativeFile of relativeFiles) {
    const absoluteFile = path.join(PROJECT_ROOT, relativeFile);
    const stat = requireFile(absoluteFile, relativeFile);
    if (stat.size === 0) throw new Error(`Required ripgrep resource is empty: ${relativeFile}`);
    if (!SKIP_GIT) assertGitTracked(relativeFile);
  }

  const executablePath = path.join(VENDOR_ROOT, platformKey, executable);
  if (format !== "pe" && (fs.statSync(executablePath).mode & 0o111) === 0) {
    throw new Error(`Required ripgrep binary is not executable: ${path.relative(PROJECT_ROOT, executablePath)}`);
  }
  assertBinaryFormat(executablePath, format, platformKey);
  const manifestPath = path.join(VENDOR_ROOT, platformKey, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "ripgrep" || !manifest.version || !manifest.asset) {
    throw new Error(`Invalid ripgrep manifest: ${path.relative(PROJECT_ROOT, manifestPath)}`);
  }
}

console.error(`[ripgrep] verified ${TARGETS.length} required platform bundles${SKIP_GIT ? "" : " and Git tracking"}`);

function requireFile(file, relativeFile) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    return stat;
  } catch {
    throw new Error(`Missing required ripgrep resource: ${relativeFile}`);
  }
}

function assertGitTracked(relativeFile) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativeFile], {
      cwd: PROJECT_ROOT,
      stdio: "ignore",
    });
  } catch {
    throw new Error(`Required ripgrep resource is not tracked by Git: ${relativeFile}`);
  }
}

function assertBinaryFormat(file, format, platformKey) {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const valid =
    (format === "pe" && header[0] === 0x4d && header[1] === 0x5a) ||
    (format === "elf" && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) ||
    (format === "macho" && (
      header.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) ||
      header.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))
    ));

  if (!valid) throw new Error(`Unexpected ripgrep binary format for ${platformKey}`);
}
