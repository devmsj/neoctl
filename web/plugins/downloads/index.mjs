import path from 'node:path';
import os from 'node:os';
import { createExposeDownloadsTool, DownloadRegistry, serveDownload } from './downloads.mjs';

export function createPlugin(context = {}) {
  const env = context.env || process.env;
  const registry = new DownloadRegistry({ storageDir: env.NEO_DOWNLOADS_DIR || path.join(context.appDataDir || path.join(os.homedir(), '.neoctl'), 'downloads') });
  return {
    tools: [createExposeDownloadsTool({ registry })],
    async route(req, res, url, helpers = {}) {
      if (!url.pathname.startsWith('/api/downloads/')) return false;
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
      const id = url.pathname.slice('/api/downloads/'.length);
      await serveDownload(registry, req, res, id, helpers);
      return true;
    },
  };
}
