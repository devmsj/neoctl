import { createExposeDownloadsTool, DownloadRegistry, serveDownload } from './downloads.mjs';
import { createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, serveXhsArtifact, XhsArtifactRegistry } from './artifacts.mjs';

export function createDefaultWebPlugins(options = {}) {
  const downloadRegistry = options.downloadRegistry || new DownloadRegistry();
  const xhsArtifactRegistry = options.xhsArtifactRegistry || new XhsArtifactRegistry({ storageDir: options.xhsArtifactsDir });
  return [
    {
      id: 'downloads',
      name: '文件下载',
      version: '1.0.0',
      defaultEnabled: true,
      tools: [createExposeDownloadsTool({ registry: downloadRegistry })],
      promptSections: [{
        name: 'Web Downloads',
        cacheStable: true,
        content: 'When you create, modify, export, package, or identify local files that the web user should receive, call expose_downloads with the relevant absolute paths before the final response. Use the returned browser links instead of presenting absolute paths as the primary delivery method.',
      }],
      async route(req, res, url) {
        if (req.method !== 'GET' || !url.pathname.startsWith('/api/downloads/')) return false;
        const id = decodeURIComponent(url.pathname.slice('/api/downloads/'.length));
        await serveDownload(downloadRegistry, req, res, id);
        return true;
      },
    },
    {
      id: 'xhs-artifact',
      name: '小红书编辑器',
      version: '1.0.0',
      defaultEnabled: true,
      tools: [
        createOpenXhsArtifactEditorTool({ registry: xhsArtifactRegistry }),
        createReadXhsArtifactTool({ registry: xhsArtifactRegistry }),
      ],
      async route(req, res, url, helpers) {
        if (!['GET', 'PUT'].includes(req.method || '') || !url.pathname.startsWith('/api/xhs-artifacts/')) return false;
        const id = decodeURIComponent(url.pathname.slice('/api/xhs-artifacts/'.length));
        await serveXhsArtifact(xhsArtifactRegistry, req, res, id, helpers.readJsonBody, url.searchParams.get('sessionId') || undefined);
        return true;
      },
    },
  ];
}
