import { createExposeDownloadsTool, DownloadRegistry, serveDownload } from './downloads.mjs';

export function createPlugin() {
  const registry = new DownloadRegistry();
  return {
    tools: [createExposeDownloadsTool({ registry })],
    promptSections: [{
      name: 'Web Downloads',
      cacheStable: true,
      content: 'When you create, modify, export, package, or identify local files that the web user should receive, call expose_downloads with the relevant absolute paths before the final response. Use the returned browser links instead of presenting absolute paths as the primary delivery method.',
    }],
    async route(req, res, url) {
      if (req.method !== 'GET' || !url.pathname.startsWith('/api/downloads/')) return false;
      const id = decodeURIComponent(url.pathname.slice('/api/downloads/'.length));
      await serveDownload(registry, req, res, id);
      return true;
    },
  };
}
