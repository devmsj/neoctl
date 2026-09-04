import { createExposeDownloadsTool, DownloadRegistry, serveDownload } from './downloads.mjs';

export function createPlugin() {
  const registry = new DownloadRegistry();
  return {
    tools: [createExposeDownloadsTool({ registry })],
    promptSections: [{
      name: 'Web Downloads',
      cacheStable: true,
      content: 'When you create, modify, export, package, or identify local files that the web user should receive, call expose_downloads with the relevant absolute paths before the final response. For every link in your response, copy the returned downloads[].markdown value verbatim. This is the neoctl.resource-link.v1 protocol: never construct a link, alter the reference URI, or add/remove a sandbox: prefix. The tool also returns expiresAt as an ISO timestamp.',
    }],
    async route(req, res, url) {
      if (req.method !== 'GET' || !url.pathname.startsWith('/api/downloads/')) return false;
      const id = decodeURIComponent(url.pathname.slice('/api/downloads/'.length));
      await serveDownload(registry, req, res, id);
      return true;
    },
  };
}
