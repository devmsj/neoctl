import path from 'node:path';
import os from 'node:os';
import { VideoStore, VALID_ID } from './store.mjs';
import { createVideoRoute, PREFIX } from './http.mjs';
import { videoPresentation } from './presentation.mjs';

const metadata = { readOnly: false, concurrent: true, visible: true, requiresApproval: false, maxResultSizeChars: 20000 };

export function createPlugin(context = {}) {
  const env = context.env || process.env;
  const directory = env.NEO_VIDEO_SHARE_DIR || path.join(context.appDataDir || path.join(os.homedir(), '.neo-video-share'), 'video-share');
  const store = new VideoStore(directory);
  let origin = '';
  if (env.NEO_VIDEO_SHARE_PUBLIC_ORIGIN) {
    const url = new URL(env.NEO_VIDEO_SHARE_PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('NEO_VIDEO_SHARE_PUBLIC_ORIGIN must be an HTTP(S) origin, without credentials or a path');
    }
    origin = url.origin;
  }
  const expose = {
    name: 'expose_videos',
    description: 'Display existing local videos inline in the conversation using embedded players. Persists only original absolute-path mappings, with no copies, directory restrictions or automatic expiration. Playback reads the original file; moving or deleting it invalidates the link. The UI embeds the player automatically. Do not include video links, URLs, Markdown links, HTML video tags or iframes in your textual reply; only acknowledge inline playback. Anyone with a link can view it. Recommend MP4 H.264/AAC or WebM; no transcoding is performed.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Absolute video paths (.mp4, .m4v, .mov, .webm, .ogv).' } }, required: ['paths'], additionalProperties: false },
    metadata,
    validate(input) {
      if (!Array.isArray(input?.paths) || !input.paths.length || input.paths.length > 20 || input.paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('paths must contain 1–20 absolute video paths');
      return { paths: [...new Set(input.paths)] };
    },
    async execute(input) {
      const videos = [], errors = [];
      for (const source of expose.validate(input).paths) {
        try {
          const entry = await store.publish(source);
          const url = `${origin}${PREFIX}${entry.id}`;
          videos.push({ id: entry.id, filename: entry.filename, sizeBytes: entry.sizeBytes, contentType: entry.contentType,
            url, mediaUrl: `${url}/media`, expiresAt: null });
        } catch (error) { errors.push({ path: source, error: error.message }); }
      }
      return { ok: !errors.length, output: { usage: 'The UI automatically embeds video players in the conversation. Do not repeat video URLs or Markdown/HTML video links in the textual response. Simply acknowledge the videos are ready inline. There is no automatic expiration.', videos, errors,
        _ui: videoPresentation({ videos, errors }) },
        summary: `Published ${videos.length} video(s); ${errors.length} failed. No automatic expiration.` };
    },
  };
  const revoke = {
    name: 'revoke_videos', description: 'Revoke video links by removing plugin mappings only. Never delete or modify source videos. Only call when the user requests revocation.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['ids'], additionalProperties: false },
    metadata: { ...metadata, requiresApproval: true },
    validate(input) {
      if (!Array.isArray(input?.ids) || !input.ids.length || input.ids.length > 20 || input.ids.some((id) => typeof id !== 'string' || !VALID_ID.test(id))) throw new Error('ids must contain 1–20 valid video ids');
      return { ids: [...new Set(input.ids)] };
    },
    async execute(input) {
      const results = [];
      for (const id of revoke.validate(input).ids) results.push({ id, revoked: await store.revoke(id) });
      return { ok: true, output: { results }, summary: 'Video links revoked; original source files untouched.' };
    },
  };
  return { tools: [expose, revoke], route: createVideoRoute(store),
    presentToolResult({ toolName, output }) {
      return toolName === 'expose_videos' ? videoPresentation(output) : undefined;
    },
    promptSections: [{ name: 'Inline Video Playback', cacheStable: true, requiresTools: ['expose_videos'],
    content: 'For local video files that the user wants to watch, use expose_videos instead of a generic download tool. The plugin automatically embeds HTML5 players inside the conversation, without opening a new page. Do not put video links, raw video URLs, Markdown video links, HTML video tags or iframe markup in your textual response. Reply only with a brief acknowledgement or relevant explanation; the player is already visible. Do not also expose the same video as a download unless the user explicitly requests a download. There is no automatic expiration. Playback depends on browser codec support; this plugin does not transcode. Publications are zero-copy original-path references with persistent mappings; anyone with a link can view them. Source movement or deletion invalidates the link; do not claim a snapshot is stored. Use revoke_videos only when requested.' }] };
}
