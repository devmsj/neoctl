import { VALID_ID } from './store.mjs';
import { PREFIX } from './http.mjs';

// Host-neutral neo-plugin/v1 presentation. Never use a model-supplied URL for an iframe.
// Always embed on the current origin, even when direct URLs use a public origin.
export function videoPresentation(output) {
  const videos = Array.isArray(output?.videos)
    ? output.videos.filter((v) => v && typeof v.id === 'string' && VALID_ID.test(v.id)) : [];
  if (!videos.length) return undefined;
  return {
    title: '视频播放',
    text: Array.isArray(output.errors) && output.errors.length
      ? `已嵌入 ${videos.length} 个视频，另有 ${output.errors.length} 个未能加载。`
      : `已嵌入 ${videos.length} 个视频，可直接播放。`,
    presentationLevel: 'primary',
    resources: videos.map((v) => ({
      kind: 'embed',
      url: `${PREFIX}${v.id}?embed=1`,
      label: typeof v.filename === 'string' ? v.filename : '视频播放',
      height: 480,
    })),
  };
}
