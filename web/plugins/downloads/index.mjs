import path from 'node:path';
import os from 'node:os';
import { createExposeDownloadsTool, DownloadRegistry, serveDownload } from './downloads.mjs';

export function createPlugin(context = {}) {
  const env = context.env || process.env;
  const registry = new DownloadRegistry({ storageDir: env.NEO_DOWNLOADS_DIR || path.join(context.appDataDir || path.join(os.homedir(), '.neoctl'), 'downloads') });
  return {
    tools: [createExposeDownloadsTool({ registry })],
    promptSections: [{
      name: 'Web Downloads', requiresTools: ['expose_downloads'], cacheStable: true,
      content: 'When you create, modify, export, package, or identify local files that the web user should receive as downloads, call expose_downloads with the relevant absolute paths before the final response. For every download link, copy downloads[].markdown verbatim (neoctl.resource-link.v1): never construct links or add/remove a sandbox: prefix. Only the link-to-original-absolute-path mapping is persisted, with no file copy and no directory restriction. Links do not automatically expire and expiresAt is null. If the original path is moved, deleted, or unreadable, the link stops working. Anyone with a link can download. Historical links from the old in-memory plugin cannot be restored; re-expose the original file if needed.',
    }],
    async route(req, res, url) {
      if (!url.pathname.startsWith('/api/downloads/')) return false;
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
      const id = url.pathname.slice('/api/downloads/'.length);
      await serveDownload(registry, req, res, id);
      return true;
    },
  };
}
