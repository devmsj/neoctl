import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebRuntime, runWebServer } from 'neoctl/web/index.js';
import { createExposeDownloadsTool, DownloadRegistry, serveDownload } from './downloads.mjs';
import { createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, serveXhsArtifact, XhsArtifactRegistry } from './artifacts.mjs';
import { createWorkspaceRuntimeManager } from './runtime-workspaces.mjs';
import { installRuntimeRouterIdleCleanup } from './runtime-router-cleanup.mjs';

installRuntimeRouterIdleCleanup();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.DIST_DIR || path.join(__dirname, 'dist'));
const host = process.env.APP_HOST || '0.0.0.0';
const port = Number(process.env.APP_PORT || process.env.PORT || 5173);
const runtimeTarget = new URL(process.env.NEO_RUNTIME_TARGET || 'http://127.0.0.1:3101');
const promptLibraryFile = path.resolve(process.env.NEO_PROMPT_LIBRARY_FILE || path.join(__dirname, '.neoctl-web', 'prompt-library.json'));
const uploadsDir = path.resolve(process.env.NEO_UPLOADS_DIR || path.join(__dirname, '.neoctl-web', 'uploads'));
const xhsArtifactsDir = path.resolve(process.env.NEO_XHS_ARTIFACTS_DIR || path.join(__dirname, '.neoctl-web', 'xhs-artifacts'));
const maxUploadBytes = Number(process.env.NEO_UPLOAD_MAX_BYTES || 25 * 1024 * 1024);
const downloadRegistry = new DownloadRegistry();
const xhsArtifactRegistry = new XhsArtifactRegistry({ storageDir: xhsArtifactsDir });
const embedRuntime = process.env.NEO_EMBED_RUNTIME !== 'false';
const workspaceRuntime = createWorkspaceRuntimeManager({
  projectRoot: __dirname,
  workspaceRoot: path.resolve(process.env.NEO_WORKSPACE_ROOT || path.join(__dirname, 'workspace')),
  createRuntime: (runtimeOptions) => createWebRuntime({
    ...runtimeOptions,
    externalTools: [
      createExposeDownloadsTool({ registry: downloadRegistry }),
      createOpenXhsArtifactEditorTool({ registry: xhsArtifactRegistry }),
      createReadXhsArtifactTool({ registry: xhsArtifactRegistry }),
    ],
  }),
});

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

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function shouldProxy(pathname) {
  return pathname === '/events' || pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/vendor/');
}

const server = http.createServer((req, res) => {
  void routeRequest(req, res);
});

server.keepAliveTimeout = 70_000;
server.headersTimeout = 75_000;
if (embedRuntime) await startEmbeddedRuntime();
server.listen(port, host, () => {
  console.log(`maker web listening on http://${host}:${port}, dist=${root}, runtime=${runtimeTarget.href}`);
});

async function startEmbeddedRuntime() {
  const runtimeHost = runtimeTarget.hostname || '127.0.0.1';
  const runtimePort = runtimeTarget.port || '3101';
  await runWebServer(['--host', runtimeHost, '--port', runtimePort], {
    createRuntime: workspaceRuntime.createRuntime,
    createRepl: workspaceRuntime.createRepl,
  });
}

async function routeRequest(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/prompt-library') {
      return sendJson(res, { items: await readPromptLibrary() });
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
    if (req.method === 'POST' && url.pathname === '/api/prompt-library/reorder') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || '').trim()).filter(Boolean) : [];
      if (!ids.length || new Set(ids).size !== ids.length) return sendJson(res, { error: 'invalid prompt order' }, 400);
      const items = await readPromptLibrary();
      const byId = new Map(items.map((item) => [item.id, item]));
      if (ids.some((id) => !byId.has(id))) return sendJson(res, { error: 'prompt order contains unknown id' }, 400);
      const ordered = ids.map((id) => byId.get(id));
      const included = new Set(ids);
      ordered.push(...items.filter((item) => !included.has(item.id)));
      await writePromptLibrary(ordered);
      return sendJson(res, { ok: true, items: ordered });
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
    if (req.method === 'GET' && url.pathname.startsWith('/api/downloads/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/downloads/'.length));
      return serveDownload(downloadRegistry, req, res, id);
    }
    if ((req.method === 'GET' || req.method === 'PUT') && url.pathname.startsWith('/api/xhs-artifacts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/xhs-artifacts/'.length));
      return serveXhsArtifact(xhsArtifactRegistry, req, res, id, readJsonBody, url.searchParams.get('sessionId') || undefined);
    }
    if (shouldProxy(url.pathname)) {
      return proxy(req, res);
    }
    return serveStatic(res, url);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function proxy(req, res) {
  const target = new URL(req.url || '/', runtimeTarget);
  target.protocol = runtimeTarget.protocol;
  target.hostname = runtimeTarget.hostname;
  target.port = runtimeTarget.port;

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

async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  let filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(root, 'index.html');
  }

  try {
    const body = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const cache = filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function readPromptLibrary() {
  try {
    const raw = await fsp.readFile(promptLibraryFile, 'utf8');
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
  await fsp.mkdir(path.dirname(promptLibraryFile), { recursive: true });
  await fsp.writeFile(promptLibraryFile, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
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
    usage: String(item.usage || '').trim(),
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
  await fsp.mkdir(uploadsDir, { recursive: true });
  const absolutePath = path.join(uploadsDir, storedName);
  await fsp.writeFile(absolutePath, buffer);
  return {
    id: `upload-${random}`,
    name,
    storedName,
    size: buffer.length,
    mimeType: normalizeMimeType(payload?.mimeType),
    absolutePath,
    relativePath: path.relative(__dirname, absolutePath) || storedName,
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
  const uploadRoot = path.resolve(uploadsDir);
  const filePath = path.resolve(uploadRoot, safeName);
  if (!filePath.startsWith(uploadRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
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
  const contentType = mime[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not an image');
    return;
  }
  try {
    const fileStat = await fsp.stat(absolutePath);
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
