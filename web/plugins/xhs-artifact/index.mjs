import path from 'node:path';
import { createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, serveXhsArtifact, XhsArtifactRegistry, xhsArtifactPresentation } from './artifacts.mjs';
import { serveXhsEditorPage } from './editor-page.mjs';
import { parseXhsArtifactToolOutput } from './xhs-artifact-contract.mjs';

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
    presentToolResult({ toolName, output, ok, sessionId }) {
      if (!ok) return undefined;
      if (toolName === 'read_xhs_artifact') {
        return { title: '读取小红书笔记', text: '已读取稿件。', presentationLevel: 'process' };
      }
      if (toolName !== 'open_xhs_artifact_editor') return undefined;
      const artifact = parseXhsArtifactToolOutput(output);
      return artifact ? xhsArtifactPresentation(artifact, sessionId) : undefined;
    },
    async route(req, res, url, helpers) {
      if (!['GET', 'PUT'].includes(req.method || '') || !url.pathname.startsWith('/api/xhs-artifacts/')) return false;
      const suffix = url.pathname.slice('/api/xhs-artifacts/'.length);
      const editorMatch = /^([^/]+)\/editor$/.exec(suffix);
      const id = decodeURIComponent(editorMatch?.[1] || suffix);
      if (editorMatch) {
        if (req.method !== 'GET') {
          helpers.sendJson?.(res, { error: 'method not allowed' }, 405);
          return true;
        }
        const artifact = registry.get(id, url.searchParams.get('sessionId') || undefined);
        if (!artifact) {
          helpers.sendJson?.(res, { error: 'artifact not found' }, 404);
          return true;
        }
        serveXhsEditorPage(res, artifact, { sessionId: url.searchParams.get('sessionId') || undefined });
        return true;
      }
      await serveXhsArtifact(registry, req, res, id, helpers.readJsonBody, url.searchParams.get('sessionId') || undefined);
      return true;
    },
  };
}
