import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.DIST_DIR || path.join(__dirname, 'dist'));
const host = process.env.APP_HOST || '0.0.0.0';
const port = Number(process.env.APP_PORT || process.env.PORT || 5173);
const runtimeTarget = new URL(process.env.NEO_RUNTIME_TARGET || 'http://127.0.0.1:3101');
const promptLibraryFile = path.resolve(process.env.NEO_PROMPT_LIBRARY_FILE || path.join(__dirname, '.neoctl-web', 'prompt-library.json'));

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
server.listen(port, host, () => {
  console.log(`maker web listening on http://${host}:${port}, dist=${root}, runtime=${runtimeTarget.href}`);
});

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
    if (['host', 'content-length', 'connection'].includes(key.toLowerCase())) continue;
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
      res.write(chunk);
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
  };
}

function clonePromptItem(item) {
  return { ...item };
}

function createPromptId() {
  return `prompt-${Math.random().toString(36).slice(2, 10)}`;
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
