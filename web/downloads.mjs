import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class DownloadRegistry {
  constructor() {
    this.entries = new Map();
  }

  add(entry) {
    const id = crypto.randomUUID();
    const full = {
      id,
      createdAt: Date.now(),
      ...entry,
    };
    this.entries.set(id, full);
    return full;
  }

  get(id) {
    const entry = this.entries.get(String(id || ''));
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.entries.delete(entry.id);
      return undefined;
    }
    return entry;
  }
}

export function createExposeDownloadsTool(options) {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;

  return {
    name: 'expose_downloads',
    description:
      'Expose one or more existing local files for the web user to download. Input must be absolute file paths. Use this after creating or locating files that the user may want to download in the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to expose for browser download.',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    metadata: {
      readOnly: true,
      concurrent: true,
      visible: true,
      requiresApproval: false,
      maxResultSizeChars: 12000,
    },
    validate(input) {
      const paths = Array.isArray(input?.paths)
        ? input.paths.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      if (!paths.length) throw new Error('paths must be a non-empty array');
      if (paths.length > 20) throw new Error('too many paths; maximum is 20');
      for (const filePath of paths) {
        if (!path.isAbsolute(filePath)) throw new Error(`path must be absolute: ${filePath}`);
      }
      return { paths };
    },
    async execute(input, context) {
      const downloads = [];
      for (const rawPath of input.paths) {
        const absolutePath = path.resolve(rawPath);
        if (!isAllowedPath(absolutePath, options.allowedRoots ?? [])) {
          throw new Error(`path is outside allowed download roots: ${absolutePath}`);
        }
        const stat = await fsp.stat(absolutePath).catch(() => undefined);
        if (!stat) throw new Error(`file does not exist: ${absolutePath}`);
        if (!stat.isFile()) throw new Error(`path is not a file: ${absolutePath}`);
        const entry = options.registry.add({
          absolutePath,
          filename: path.basename(absolutePath),
          sizeBytes: stat.size,
          expiresAt: Date.now() + ttlMs,
          sessionId: context.session?.sessionId,
        });
        downloads.push({
          id: entry.id,
          filename: entry.filename,
          sizeBytes: entry.sizeBytes,
          url: `/api/downloads/${encodeURIComponent(entry.id)}`,
          expiresAt: entry.expiresAt,
        });
      }
      await options.onExpose?.({ sessionId: context.session?.sessionId, downloads });
      return {
        ok: true,
        output: { downloads },
        summary: `Exposed ${downloads.length} file(s) for browser download.`,
      };
    },
  };
}

export function downloadRootsFromEnv(defaultRoot = process.cwd()) {
  return String(process.env.NEO_DOWNLOAD_ROOTS || defaultRoot)
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

export function serveDownload(registry, req, res, id) {
  const entry = registry.get(id);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'download not found or expired' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(entry.sizeBytes),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    'Cache-Control': 'no-store',
  });

  fs.createReadStream(entry.absolutePath)
    .on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('failed to read file');
      } else {
        res.destroy();
      }
    })
    .pipe(res);
}

function isAllowedPath(filePath, allowedRoots) {
  if (!allowedRoots.length) return true;
  const normalizedFile = path.resolve(filePath).toLowerCase();
  return allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root).toLowerCase();
    return normalizedFile === normalizedRoot || normalizedFile.startsWith(normalizedRoot + path.sep);
  });
}
