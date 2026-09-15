import { openWorkspaceRead } from '../../execution-backend.mjs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export const PREFIX = '/api/video-share/';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function playerPage(entry, options = {}) {
  const title = escapeHtml(entry.filename);
  const src = `${(process.env.NEO_WEB_BASE_PATH || "").replace(/\/$/, "")}${PREFIX}${entry.id}/media`;
  const theme = options.theme === 'light' ? 'light' : 'dark';
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  :root{color-scheme:dark;--bg:#11151d;--fg:#eee;--muted:#aab2c1}html[data-theme=light]{color-scheme:light;--bg:#fff;--fg:#222;--muted:#667085}*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}main{height:100%;display:flex;flex-direction:column;gap:10px;padding:14px}h1{margin:0;font-size:16px;overflow-wrap:anywhere}video{display:block;flex:1;min-height:0;width:100%;background:#000;border-radius:8px}p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}
  </style></head><body><main><h1>${title}</h1><video controls playsinline preload="metadata" src="${src}">浏览器不支持视频播放。</video></main></body></html>`;
}

// A single byte range is sufficient for HTML5 media. Ignore unknown/multipart ranges.
export function parseRange(value, size) {
  if (!value || !value.startsWith('bytes=') || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  if (!size) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function text(res, status, message, head = false) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : message);
}

export function createVideoRoute(store) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) { res.setHeader('Allow', 'GET, HEAD'); text(res, 405, 'Method not allowed'); return true; }
    const match = /^\/api\/video-share\/([a-f0-9]{48})(\/media)?$/.exec(url.pathname);
    if (!match) { text(res, 404, 'Video not found', head); return true; }
    let handle;
    try {
      const entry = await store.get(match[1]);
      if (!entry) { text(res, 404, 'Video not found', head); return true; }
      handle = await openWorkspaceRead(entry.mediaPath);
      const stat = await handle.stat();
      if (!stat.isFile()) { text(res, 404, 'Video not found', head); return true; }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      if (!match[2]) {
        const body = playerPage(entry, { theme: url.searchParams.get('theme') });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
          'Content-Security-Policy': "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'" });
        res.end(head ? undefined : body);
        return true;
      }
      const etag = `"${entry.id}-${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}"`;
      const rangeHeader = req.headers['if-range'] && req.headers['if-range'] !== etag ? undefined : req.headers.range;
      const range = head ? null : parseRange(rangeHeader, stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etag);
      if (range === false) { res.setHeader('Content-Range', `bytes */${stat.size}`); text(res, 416, 'Range not satisfiable', head); return true; }
      const length = range ? range.end - range.start + 1 : stat.size;
      res.setHeader('Content-Type', entry.contentType);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(entry.filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`);
      res.setHeader('Content-Length', length);
      if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.statusCode = range ? 206 : 200;
      if (head) res.end();
      else await pipeline(handle.createReadStream({ ...(range || {}), autoClose: false }), res);
      return true;
    } catch (error) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); }
      else text(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Video not found' : 'Unable to serve video', head);
      return true;
    } finally { await handle?.close(); }
  };
}
