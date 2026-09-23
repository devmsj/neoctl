import { workspaceFs, openWorkspaceRead } from '../../execution-backend.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const VALID_ID = /^[a-f0-9-]{36}$/;

export class DownloadRegistry {
  constructor(options = {}) {
    this.storageDir = path.resolve(options.storageDir || path.join(os.homedir(), '.neoctl-downloads'));
  }

  async add(entry) {
    const source = entry.absolutePath;
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('path must be absolute');
    const before = await workspaceFs.stat(source);
    if (!before.isFile()) throw new Error('path is not a regular file');
    await fsp.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    const pending = path.join(this.storageDir, `.pending-${id}`);
    await fsp.mkdir(pending, { mode: 0o700 });
    try {
      // Persist only a reference. Any existing absolute path is allowed, including
      // paths outside the workspace; never copy or relocate the source file.
      const full = { version: 2, id, createdAt: Date.now(), absolutePath: path.resolve(source),
        filename: path.basename(source), sizeBytes: before.size, expiresAt: null };
      await fsp.writeFile(path.join(pending, 'entry.json'), JSON.stringify(full), { mode: 0o600 });
      await fsp.rename(pending, path.join(this.storageDir, id));
      return full;
    } catch (error) {
      await fsp.rm(pending, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id) {
    if (typeof id !== 'string' || !VALID_ID.test(id)) return undefined;
    try {
      const entry = JSON.parse(await fsp.readFile(path.join(this.storageDir, id, 'entry.json'), 'utf8'));
      if (entry.version !== 2 || entry.id !== id || typeof entry.filename !== 'string'
        || typeof entry.absolutePath !== 'string' || !path.isAbsolute(entry.absolutePath)) throw new Error('Invalid download metadata');
      return { ...entry, expiresAt: null };
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
}

export function createExposeDownloadsTool(options) {
  const tool = {
    name: 'expose_downloads',
    description: 'Expose existing local files for browser download with no automatic expiration. Only absolute-path mappings are persisted; no file is copied. Any readable regular file anywhere is allowed, including outside the workspace. Links survive restarts but fail when the original path is moved, deleted, or unreadable. Anyone with the link can download. Input must be absolute paths. Copy downloads[].markdown verbatim (neoctl.resource-link.v1).',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Absolute file paths to publish as permanent browser downloads.' } },
      required: ['paths'], additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: true, visible: true, requiresApproval: false, maxResultSizeChars: 20000 },
    validate(input) {
      if (!Array.isArray(input?.paths) || !input.paths.length || input.paths.length > 20
        || input.paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('paths must contain 1–20 absolute file paths');
      return { paths: [...new Set(input.paths)] };
    },
    async execute(input, context = {}) {
      const downloads = [], errors = [];
      for (const absolutePath of tool.validate(input).paths) {
        try {
          const entry = await options.registry.add({ absolutePath });
          const url = `/api/downloads/${entry.id}`;
          const reference = `sandbox:${url}`;
          const label = entry.filename.replace(/[\r\n]/g, ' ').replace(/([\\[\]<>`*_])/g, '\\$1');
          downloads.push({ id: entry.id, filename: entry.filename, sizeBytes: entry.sizeBytes, url, reference,
            markdown: `[${label}](${reference})`, expiresAt: null, expiresAtEpochMs: null });
        } catch (error) { errors.push({ path: absolutePath, error: error.message }); }
      }
      await options.onExpose?.({ sessionId: context.session?.sessionId, downloads });
      return { ok: !errors.length, output: {
        resourceProtocol: 'neoctl.resource-link.v1',
        usage: 'Copy downloads[].markdown verbatim. Links have no automatic expiration; expiresAt is null.',
        downloads, errors,
        _ui: { resources: downloads.map((item) => ({ kind: 'download', url: item.url, reference: item.reference,
          label: item.filename, downloadName: item.filename, sizeBytes: item.sizeBytes })) },
      }, summary: `Exposed ${downloads.length} permanent download(s); ${errors.length} failed.` };
    },
  };
  return tool;
}

export async function serveDownload(registry, req, res, id, helpers = {}) {
  let handle;
  try {
    const entry = await registry.get(id);
    if (!entry) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : 'Download not found'); return; }
    handle = await openWorkspaceRead(entry.absolutePath);
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    res.writeHead(200, {
      ...helpers.localResourceHeaders?.(req, entry.absolutePath),
      'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') res.end();
    else await pipeline(handle.createReadStream({ autoClose: false }), res);
  } catch (error) {
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); }
    else { res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : 'Unable to read download'); }
  } finally { await handle?.close(); }
}
