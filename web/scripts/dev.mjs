import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createWebRuntime, runWebServer } from 'neoctl/web/index.js';
import { createDefaultWebPlugins } from '../default-plugins.mjs';
import { createWebPluginHost } from '../plugins.mjs';
import { createWebPluginSettings } from '../plugin-settings.mjs';
import { createWorkspaceRuntimeManager } from '../runtime-workspaces.mjs';
import { installRuntimeRouterIdleCleanup } from '../runtime-router-cleanup.mjs';
import { createCpaQuotaMonitor } from '../cpa-quota.mjs';
import { createMemoryMonitor } from '../memory-monitor.mjs';

installRuntimeRouterIdleCleanup();

const host = process.env.NEO_RUNTIME_HOST || '127.0.0.1';
const runtimePort = Number(process.env.NEO_RUNTIME_PORT || 3101);
const upstreamPort = Number(process.env.NEO_RUNTIME_UPSTREAM_PORT || runtimePort + 1);
const appHost = process.env.VITE_HOST || '0.0.0.0';
const appPort = String(process.env.VITE_PORT || 5173);
const promptLibraryFile = path.resolve(process.env.NEO_PROMPT_LIBRARY_FILE || path.join(process.cwd(), '.neoctl-web', 'prompt-library.json'));
const uploadsDir = path.resolve(process.env.NEO_UPLOADS_DIR || path.join(process.cwd(), '.neoctl-web', 'uploads'));
const xhsArtifactsDir = path.resolve(process.env.NEO_XHS_ARTIFACTS_DIR || path.join(process.cwd(), '.neoctl-web', 'xhs-artifacts'));
const cpaConfigFile = path.resolve(process.env.NEO_CPA_CONFIG_FILE || path.join(process.cwd(), '.neoctl-web', 'cpa-config.json'));
const memoryMonitorFile = path.resolve(process.env.NEO_MEMORY_MONITOR_FILE || path.join(process.cwd(), '.neoctl-web', 'memory-monitor.json'));
const pluginSettingsFile = path.resolve(process.env.NEO_WEB_PLUGIN_SETTINGS_FILE || path.join(process.cwd(), '.neoctl-web', 'plugins.json'));
const maxUploadBytes = Number(process.env.NEO_UPLOAD_MAX_BYTES || 25 * 1024 * 1024);
const pluginSettings = await createWebPluginSettings(pluginSettingsFile);
const pluginEnv = process.env.NEO_WEB_PLUGINS;
const pluginHost = createWebPluginHost({
  plugins: createDefaultWebPlugins({ xhsArtifactsDir }),
  enabled: pluginEnv?.trim() ? pluginEnv : pluginSettings.globalEnabledIds(),
  locked: Boolean(pluginEnv?.trim()),
  settings: pluginSettings,
});
const cpaQuotaMonitor = createCpaQuotaMonitor({ configFile: cpaConfigFile });
const memoryMonitor = createMemoryMonitor({
  storageFile: memoryMonitorFile,
  sampleMs: process.env.NEO_MEMORY_SAMPLE_MS,
  retentionMs: process.env.NEO_MEMORY_RETENTION_MS,
  publicSamples: process.env.NEO_MEMORY_PUBLIC_SAMPLES,
  maxPersistedSamples: process.env.NEO_MEMORY_MAX_PERSISTED_SAMPLES,
  maxPersistedBytes: process.env.NEO_MEMORY_MAX_PERSISTED_BYTES,
});
const workspaceRuntime = createWorkspaceRuntimeManager({
  projectRoot: process.cwd(),
  workspaceRoot: path.resolve(process.env.NEO_WORKSPACE_ROOT || path.join(process.cwd(), 'workspace')),
  createRuntime: (runtimeOptions) => createWebRuntime({
    ...runtimeOptions,
    ...pluginHost.runtimePlugins(runtimeOptions.sessionId),
  }),
});

process.env.VITE_NEO_RUNTIME_TARGET = `http://${host}:${runtimePort}`;
process.env.OPENAI_IMAGE_TIMEOUT_MS ||= '600000';

const DEFAULT_APP_PROMPT_LIBRARY = [
  {
    id: 'product-copilot',
    title: '产品副驾',
    content: '你当前承担应用层产品副驾角色。优先关注产品意图、用户目标、体验取舍、边界情况、上线风险与下一步决策。回答要清晰、结构化，以判断和推进为主。',
  },
  {
    id: 'frontend-crafter',
    title: '前端工匠',
    content: '你当前承担应用层前端工匠角色。优先关注交互细节、布局清晰度、视觉层级、响应式表现和可落地的界面实现建议。提出 UI 方案时要具体、有审美，不要泛泛而谈。',
  },
  {
    id: 'delivery-driver',
    title: '交付推进',
    content: '你当前承担应用层交付推进角色。优先追求执行速度、解除阻塞、减少绕路、快速验证和务实落地。除非用户明确要求分析，否则优先给出直接可执行的下一步。',
  },
];

await runWebServer(['--host', host, '--port', String(upstreamPort)], {
  createRuntime: workspaceRuntime.createRuntime,
  createRepl: workspaceRuntime.createRepl,
});
await cpaQuotaMonitor.start();
await memoryMonitor.start();
await startPromptLibraryProxy();

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => typeof value === 'string' && key && !key.includes('='))
);

const command = `npm run dev:ui -- --host ${appHost} --port ${appPort}`;
const vite = process.platform === 'win32'
  ? spawn('cmd.exe', ['/d', '/s', '/c', command], { stdio: 'inherit', env: childEnv })
  : spawn('sh', ['-c', command], { stdio: 'inherit', env: childEnv });

const shutdown = () => {
  if (!vite.killed) vite.kill('SIGTERM');
  process.exit();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
vite.on('exit', (code) => process.exit(code ?? 0));
vite.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

async function startPromptLibraryProxy() {
  const server = http.createServer((req, res) => {
    void routeRequest(req, res);
  });
  await new Promise((resolve) => server.listen(runtimePort, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : runtimePort;
  console.log(`neo web bridge listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);
}

async function routeRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${host}:${runtimePort}`);
  try {
    if (await pluginHost.route(req, res, url, { readJsonBody, sendJson })) return;
    if (req.method === 'GET' && url.pathname === '/api/prompt-library') {
      return sendJson(res, { items: await readPromptLibrary() });
    }
    if (req.method === 'GET' && url.pathname === '/api/cpa-quota') {
      return sendJson(res, cpaQuotaMonitor.getPublicState());
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      return sendJson(res, memoryMonitor.getPublicState());
    }
    if (req.method === 'POST' && url.pathname === '/api/cpa-config') {
      const body = await readJsonBody(req);
      const current = cpaQuotaMonitor.getPublicState();
      const password = body?.preservePassword && current.config.hasPassword
        ? undefined
        : String(body?.password || '');
      return sendJson(res, { ok: true, ...(await cpaQuotaMonitor.updateConfig({
        url: body?.url,
        password,
        preservePassword: body?.preservePassword,
      })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/prompt-library') {
      const body = await readJsonBody(req);
      const item = normalizePromptItem(body?.item);
      if (!item) return sendJson(res, { error: 'invalid prompt item' }, 400);
      const items = await readPromptLibrary();
      const index = items.findIndex((entry) => entry.id === item.id);
      if (index >= 0) items.splice(index, 1, item);
      else items.unshift(item);
      await writePromptLibrary(items);
      return sendJson(res, { ok: true, item, items });
    }
    if (req.method === 'POST' && url.pathname === '/api/prompt-library/delete') {
      const body = await readJsonBody(req);
      const id = String(body?.id || '').trim();
      if (!id) return sendJson(res, { error: 'missing prompt id' }, 400);
      const items = await readPromptLibrary();
      const nextItems = items.filter((entry) => entry.id !== id);
      await writePromptLibrary(nextItems);
      return sendJson(res, { ok: true, items: nextItems });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/uploads/')) {
      const storedName = decodeURIComponent(url.pathname.slice('/api/uploads/'.length));
      return serveUploadedFile(res, storedName);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/local-images/')) {
      const encodedPath = decodeURIComponent(url.pathname.slice('/api/local-images/'.length));
      return serveLocalImage(res, encodedPath);
    }
    if (req.method === 'POST' && url.pathname === '/api/uploads') {
      const body = await readJsonBody(req);
      const file = await storeUploadedFile(body);
      return sendJson(res, { ok: true, file });
    }
    return proxyToRuntime(req, res, url);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function proxyToRuntime(req, res, originalUrl) {
  const target = new URL(originalUrl.pathname + originalUrl.search, `http://${host}:${upstreamPort}`);
  const method = req.method || 'GET';
  const requestBody = method === 'GET' || method === 'HEAD' ? undefined : await readRequestBody(req);
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (['host', 'content-length', 'connection', 'expect'].includes(key.toLowerCase())) continue;
    requestHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers: requestHeaders,
      body: requestBody,
    });

    const responseHeaders = {};
    for (const [key, value] of upstream.headers.entries()) {
      if (['connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }

    res.on('close', () => {
      upstream.body?.cancel().catch(() => {});
    });

    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      if (!res.write(chunk) && !await waitForDrainOrClose(res)) break;
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    const isTerminatedSocket =
      error?.name === 'TypeError' &&
      error?.message === 'terminated' &&
      error?.cause?.code === 'UND_ERR_SOCKET';
    if (error?.name === 'AbortError' || isTerminatedSocket || res.destroyed) return;
    throw error;
  }
}

function waitForDrainOrClose(res) {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}

async function readPromptLibrary() {
  try {
    const raw = await readFile(promptLibraryFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('prompt library file must contain an array');
    return parsed.map(normalizePromptItem).filter(Boolean);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const items = DEFAULT_APP_PROMPT_LIBRARY.map(clonePromptItem);
    await writePromptLibrary(items);
    return items;
  }
}

async function writePromptLibrary(items) {
  await mkdir(path.dirname(promptLibraryFile), { recursive: true });
  await writeFile(promptLibraryFile, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function normalizePromptItem(item) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title || '').trim();
  const content = String(item.content || '').trim();
  if (!title || !content) return null;
  return {
    id: String(item.id || createPromptId()).trim(),
    title,
    content,
  };
}

function clonePromptItem(item) {
  return { ...item };
}

function createPromptId() {
  return `prompt-${Math.random().toString(36).slice(2, 10)}`;
}

async function storeUploadedFile(payload) {
  const name = sanitizeUploadName(payload?.name);
  if (!name) throw new Error('invalid upload name');
  const data = String(payload?.data || '').trim();
  if (!data) throw new Error('missing upload data');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) throw new Error('empty upload data');
  if (buffer.length > maxUploadBytes) throw new Error(`upload too large: max ${maxUploadBytes} bytes`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  const storedName = `${stamp}-${random}-${name}`;
  await mkdir(uploadsDir, { recursive: true });
  const absolutePath = path.join(uploadsDir, storedName);
  await writeFile(absolutePath, buffer);
  return {
    id: `upload-${random}`,
    name,
    storedName,
    size: buffer.length,
    mimeType: normalizeMimeType(payload?.mimeType),
    absolutePath,
    relativePath: path.relative(process.cwd(), absolutePath) || storedName,
    url: `/api/uploads/${encodeURIComponent(storedName)}`,
  };
}

async function serveUploadedFile(res, storedName) {
  const safeName = path.basename(String(storedName || '').trim());
  if (!safeName || safeName !== storedName) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('invalid upload name');
    return;
  }
  const root = path.resolve(uploadsDir);
  const filePath = path.resolve(root, safeName);
  if (!filePath.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypeForPath(filePath),
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function serveLocalImage(res, encodedPath) {
  let filePath = '';
  try {
    filePath = Buffer.from(encodedPath, 'base64url').toString('utf8');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('invalid image path');
    return;
  }
  const absolutePath = path.resolve(filePath);
  const contentType = mimeTypeForPath(absolutePath);
  if (!contentType.startsWith('image/')) {
    res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not an image');
    return;
  }
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(absolutePath)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

function sanitizeUploadName(value) {
  const base = path.basename(String(value || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-');
  return base.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function normalizeMimeType(value) {
  const mimeType = String(value || '').trim();
  return mimeType || 'application/octet-stream';
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
