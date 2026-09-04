#!/usr/bin/env node

import net from 'node:net';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

export function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 5173,
    runtimeHost: '127.0.0.1',
    runtimePort: 3101,
    open: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') options.help = true;
    else if (argument === '-v' || argument === '--version') options.version = true;
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--host') options.host = readValue(argv, ++index, argument);
    else if (argument === '--port' || argument === '-p') options.port = readPort(argv, ++index, argument);
    else if (argument === '--runtime-port') options.runtimePort = readPort(argv, ++index, argument);
    else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

export async function findAvailablePort(startPort, host, excluded = new Set()) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (excluded.has(port)) continue;
    if (await canListen(port, host)) return port;
  }
  throw new Error(`从 ${startPort} 开始没有可用端口`);
}

export function helpText() {
  return `neow ${packageJson.version}

启动 Neo Web、后台和核心运行时

用法：
  neow [选项]

选项：
  -h, --help              显示帮助
  -v, --version           显示版本
  -p, --port <端口>       Web 起始端口，默认 5173
      --runtime-port <端口> 核心起始端口，默认 3101
      --host <地址>       Web 监听地址，默认 127.0.0.1
      --no-open           不自动打开浏览器

端口被占用时会从指定端口开始自动顺延。`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('运行 neow --help 查看用法。');
    process.exitCode = 1;
    return;
  }
  if (options.help) return console.log(helpText());
  if (options.version) return console.log(packageJson.version);

  const runtimePort = await findAvailablePort(options.runtimePort, options.runtimeHost);
  const webPort = await findAvailablePort(options.port, options.host, new Set([runtimePort]));
  const browserHost = isWildcardHost(options.host) ? '127.0.0.1' : normalizeBrowserHost(options.host);
  const url = `http://${browserHost}:${webPort}`;

  process.env.APP_HOST = options.host;
  process.env.APP_PORT = String(webPort);
  process.env.NEO_RUNTIME_TARGET = `http://${options.runtimeHost}:${runtimePort}`;
  process.env.NEO_EMBED_RUNTIME = 'true';
  process.env.NEO_CORE_SOURCE = 'package';

  if (runtimePort !== options.runtimePort) console.log(`核心端口 ${options.runtimePort} 已占用，使用 ${runtimePort}`);
  if (webPort !== options.port) console.log(`Web 端口 ${options.port} 已占用，使用 ${webPort}`);
  await import('../server.mjs');
  console.log(`Neo Web 已启动：${url}`);
  if (options.open) openBrowser(url);
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} 缺少值`);
  return value;
}

function readPort(argv, index, flag) {
  const value = Number(readValue(argv, index, flag));
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${flag} 必须是 1-65535 的端口`);
  return value;
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host }, () => probe.close(() => resolve(true)));
  });
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

function normalizeBrowserHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['explorer.exe', [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => {});
  child.unref();
}

export function isMainModule(invokedPath, moduleUrl) {
  if (!invokedPath) return false;
  return comparablePath(invokedPath) === comparablePath(fileURLToPath(moduleUrl));
}

function comparablePath(value) {
  const absolutePath = path.resolve(value);
  let resolvedPath = absolutePath;
  try {
    resolvedPath = realpathSync.native(absolutePath);
  } catch {
    // Keep the absolute path so invalid invocations still fail in main().
  }
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(`neow 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
