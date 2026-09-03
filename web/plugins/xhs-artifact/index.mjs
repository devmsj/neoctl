import path from 'node:path';
import { createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, serveXhsArtifact, XhsArtifactRegistry } from './artifacts.mjs';

export function createPlugin(context) {
  const configuredStorageDir = String(context.env.NEO_XHS_ARTIFACTS_DIR || '').trim();
  const storageDir = configuredStorageDir
    ? path.resolve(configuredStorageDir)
    : path.join(context.appDataDir || path.join(context.pluginDir, '.data'), 'xhs-artifacts');
  const registry = new XhsArtifactRegistry({ storageDir });
  return {
    tools: [
      createOpenXhsArtifactEditorTool({ registry }),
      createReadXhsArtifactTool({ registry }),
    ],
    async route(req, res, url, helpers) {
      if (!['GET', 'PUT'].includes(req.method || '') || !url.pathname.startsWith('/api/xhs-artifacts/')) return false;
      const id = decodeURIComponent(url.pathname.slice('/api/xhs-artifacts/'.length));
      await serveXhsArtifact(registry, req, res, id, helpers.readJsonBody, url.searchParams.get('sessionId') || undefined);
      return true;
    },
  };
}
