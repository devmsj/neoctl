#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = "BurntSushi/ripgrep";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(PROJECT_ROOT, "vendor", "ripgrep");
const OPTIONAL = process.argv.includes("--optional");
const FORCE = process.argv.includes("--force");
const ALL = process.argv.includes("--all");

const TARGETS = {
  "win32-x64": [/x86_64-pc-windows-msvc\.zip$/i],
  "win32-arm64": [/aarch64-pc-windows-msvc\.zip$/i],
  "linux-x64": [/x86_64-unknown-linux-musl\.tar\.gz$/i, /x86_64-unknown-linux-gnu\.tar\.gz$/i],
  "linux-arm64": [/aarch64-unknown-linux-gnu\.tar\.gz$/i, /aarch64-unknown-linux-musl\.tar\.gz$/i],
  "darwin-x64": [/x86_64-apple-darwin\.tar\.gz$/i],
  "darwin-arm64": [/aarch64-apple-darwin\.tar\.gz$/i],
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (OPTIONAL) {
    console.warn(`[ripgrep] optional install skipped: ${message}`);
    process.exit(0);
  }
  console.error(`[ripgrep] install failed: ${message}`);
  process.exit(1);
});

async function main() {
  const release = await getJson(LATEST_RELEASE_URL);
  const keys = ALL ? Object.keys(TARGETS) : [platformKey()];
  for (const key of keys) {
    await installTarget(release, key);
  }
}

async function installTarget(release, key) {
  const executable = key.startsWith("win32-") ? "rg.exe" : "rg";
  const targetDir = path.join(VENDOR_ROOT, key);
  const targetPath = path.join(targetDir, executable);

  if (!FORCE && fs.existsSync(targetPath)) {
    console.error(`[ripgrep] using existing ${path.relative(PROJECT_ROOT, targetPath)}`);
    return;
  }

  const asset = selectAsset(release.assets ?? [], key);
  if (!asset) throw new Error(`no ripgrep release asset found for ${key}`);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-rg-"));
  try {
    const archivePath = path.join(tempDir, asset.name);
    const extractDir = path.join(tempDir, "extract");
    await fsp.mkdir(extractDir, { recursive: true });

    console.error(`[ripgrep] downloading ${asset.name}`);
    await download(asset.browser_download_url, archivePath);
    extractArchive(archivePath, extractDir);

    const binaryPath = await findFile(extractDir, executable);
    if (!binaryPath) throw new Error(`${executable} not found inside ${asset.name}`);

    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.copyFile(binaryPath, targetPath);
    if (!key.startsWith("win32-")) await fsp.chmod(targetPath, 0o755);

    await copyLicenseFiles(extractDir, targetDir);
    await fsp.writeFile(
      path.join(targetDir, "manifest.json"),
      `${JSON.stringify({
        name: "ripgrep",
        version: release.tag_name,
        source: release.html_url,
        asset: asset.name,
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    console.error(`[ripgrep] installed ${path.relative(PROJECT_ROOT, targetPath)}`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

function platformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!TARGETS[key]) throw new Error(`unsupported platform: ${key}`);
  return key;
}

function selectAsset(assets, key) {
  const patterns = TARGETS[key];
  return assets.find((asset) => patterns.some((pattern) => pattern.test(asset.name)));
}

async function getJson(url) {
  try {
    const response = await fetchWithRetry(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-scaffold-ripgrep-installer",
      },
    });
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  } catch (error) {
    const body = curlGet(url);
    return JSON.parse(body.toString("utf8"));
  }
}

async function download(url, destination) {
  try {
    const response = await fetchWithRetry(url, { headers: { "User-Agent": "agent-scaffold-ripgrep-installer" } });
    if (!response.ok) throw new Error(`download returned ${response.status}`);
    await fsp.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    curlDownload(url, destination);
  }
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status < 500 || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await delay(1000 * attempt);
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function curlGet(url) {
  return execFileSync("curl", ["-fL", "--retry", "3", "--retry-delay", "1", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: agent-scaffold-ripgrep-installer", url], { maxBuffer: 1024 * 1024 * 20 });
}

function curlDownload(url, destination) {
  execFileSync("curl", ["-fL", "--retry", "3", "--retry-delay", "1", "-H", "User-Agent: agent-scaffold-ripgrep-installer", "-o", destination, url], { stdio: "ignore" });
}

function extractArchive(archivePath, destination) {
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", destination], { stdio: "ignore" });
    return;
  } catch (error) {
    if (process.platform !== "win32" || !archivePath.toLowerCase().endsWith(".zip")) throw error;
  }

  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
    archivePath,
    destination,
  ], { stdio: "ignore" });
}

async function findFile(root, fileName) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, fileName);
      if (found) return found;
    }
  }
  return undefined;
}

async function copyLicenseFiles(root, targetDir) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && /^licen[sc]e|copying|unlicense/i.test(entry.name)) {
      await fsp.copyFile(fullPath, path.join(targetDir, entry.name));
    }
    if (entry.isDirectory()) await copyLicenseFiles(fullPath, targetDir);
  }
}
