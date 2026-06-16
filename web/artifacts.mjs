import crypto from 'node:crypto';

export class XhsArtifactRegistry {
  constructor() {
    this.entries = new Map();
  }

  add(entry) {
    const now = Date.now();
    const artifact = normalizeArtifact({
      id: crypto.randomUUID(),
      type: 'xhs-post',
      title: '',
      payload: {},
      content: '',
      sessionId: undefined,
      createdAt: now,
      updatedAt: now,
      ...entry,
    });
    this.entries.set(artifact.id, artifact);
    return cloneArtifact(artifact);
  }

  get(id) {
    const artifact = this.entries.get(String(id || ''));
    return artifact ? cloneArtifact(artifact) : undefined;
  }

  update(id, patch) {
    const artifact = this.entries.get(String(id || ''));
    if (!artifact) return undefined;
    if (typeof patch.title === 'string') artifact.title = patch.title.trim().slice(0, 160);
    if (patch.payload && typeof patch.payload === 'object') artifact.payload = normalizePayload(patch.payload);
    if (typeof patch.content === 'string') artifact.content = patch.content;
    artifact.updatedAt = Date.now();
    return cloneArtifact(artifact);
  }
}

export function createOpenXhsArtifactEditorTool(options) {
  return {
    name: 'open_xhs_artifact_editor',
    description:
      'Open a user-editable Xiaohongshu post editor in the web conversation. JSON/payload is only the transport format; the web UI renders it like a Xiaohongshu post with image carousel, title, body, topics, and editing controls.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Draft title.' },
        payload: {
          type: 'object',
          description: 'Structured Xiaohongshu post data: title, body, images, interaction, hashtags, review.',
          additionalProperties: true,
        },
        content: {
          type: 'string',
          description: 'Optional Markdown or JSON content. The UI will parse it into editable post fields.',
        },
      },
      additionalProperties: false,
    },
    metadata: {
      readOnly: false,
      concurrent: true,
      visible: true,
      requiresApproval: false,
      maxResultSizeChars: 60000,
    },
    validate(input) {
      const payload = input?.payload && typeof input.payload === 'object' ? input.payload : parsePayload(input?.content);
      const content = typeof input?.content === 'string' ? input.content : '';
      if (!payload && !content.trim()) throw new Error('provide payload or content');
      return {
        title: firstText(input?.title, payload?.title, payload?.main_title, payload?.cover_title, '小红书笔记').slice(0, 160),
        payload: normalizePayload(payload || { body: content }),
        content,
      };
    },
    async execute(input, context) {
      const artifact = options.registry.add({
        title: input.title,
        payload: input.payload,
        content: input.content,
        sessionId: context.session?.sessionId,
      });
      return { ok: true, output: { artifact }, summary: `Opened Xiaohongshu editor ${artifact.id}` };
    },
  };
}

export function createReadXhsArtifactTool(options) {
  return {
    name: 'read_xhs_artifact',
    description: 'Read the latest user-edited Xiaohongshu artifact by id before revising or continuing collaboration.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Artifact id returned by open_xhs_artifact_editor.' } },
      required: ['id'],
      additionalProperties: false,
    },
    metadata: {
      readOnly: true,
      concurrent: true,
      visible: true,
      requiresApproval: false,
      maxResultSizeChars: 60000,
    },
    validate(input) {
      const id = String(input?.id || '').trim();
      if (!id) throw new Error('id is required');
      return { id };
    },
    async execute(input) {
      const artifact = options.registry.get(input.id);
      if (!artifact) throw new Error(`xhs artifact not found: ${input.id}`);
      return { ok: true, output: { artifact }, summary: `Read Xiaohongshu artifact ${artifact.id}` };
    },
  };
}

export async function serveXhsArtifact(registry, req, res, id, readJsonBody) {
  if (req.method === 'GET') {
    const artifact = registry.get(id);
    return artifact ? sendJson(res, { ok: true, artifact }) : sendJson(res, { error: 'artifact not found' }, 404);
  }
  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    const artifact = registry.update(id, body || {});
    return artifact ? sendJson(res, { ok: true, artifact }) : sendJson(res, { error: 'artifact not found' }, 404);
  }
  return sendJson(res, { error: 'method not allowed' }, 405);
}

function normalizeArtifact(value) {
  const payload = normalizePayload(value.payload);
  return {
    id: String(value.id),
    type: String(value.type || 'xhs-post'),
    title: String(value.title || '').trim() || firstText(payload.title, payload.cover_title, '小红书笔记'),
    payload,
    content: String(value.content || ''),
    sessionId: value.sessionId,
    createdAt: Number(value.createdAt || Date.now()),
    updatedAt: Number(value.updatedAt || Date.now()),
  };
}

function normalizePayload(value) {
  const root = value && typeof value === 'object' ? { ...value } : {};
  const payload = root.web_editor_payload || root.post || root.draft || root.payload || root;
  return {
    ...payload,
    title: firstText(payload.title, payload.main_title, payload.cover_title, payload.title_options, payload.titles),
    body: richText(payload.body || payload.content || payload.caption || payload.copy || payload.text || payload.main_body),
    interaction: richText(payload.interaction || payload.rules || payload.activity_rules || payload.cta || payload.call_to_action),
    hashtags: normalizeTags(payload.hashtags || payload.tags || payload.topics),
    images: normalizeImages(payload.images || payload.image_plan || payload.imagePlan || payload.image_cards || payload.cards || payload.visuals),
    review: richText(payload.review || payload.check || payload.self_check || payload.safety_check),
  };
}

function normalizeImages(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n/).filter(Boolean);
  return list.map((item, index) => {
    if (item && typeof item === 'object') {
      return {
        id: firstText(item.id, item.key, `image-${index + 1}`),
        url: safeImageUrl(item.url, item.src, item.imageUrl, item.image_url),
        caption: firstText(item.caption, item.title, item.scene, item.description, item.text, item.visual, item.shot, item.copy, `配图 ${index + 1}`),
        overlay: firstText(item.overlay, item.overlay_text, item.cover_text, item.key_text, item.headline),
        note: richText(item.note || item.direction || item.prompt || item.detail || item.layout || item.frame),
        upload: item.upload && typeof item.upload === 'object' ? trimUploadInfo(item.upload) : undefined,
      };
    }
    const text = String(item || '').replace(/^\d+[.)、\s-]*/, '').trim();
    return { id: `image-${index + 1}`, url: '', caption: text || `配图 ${index + 1}`, overlay: '', note: '' };
  });
}

function safeImageUrl(...values) {
  const url = firstText(...values);
  if (!url || /^data:/i.test(url)) return '';
  return url.slice(0, 2048);
}

function trimUploadInfo(value) {
  return {
    id: firstText(value.id),
    name: firstText(value.name),
    storedName: firstText(value.storedName),
    size: Number(value.size || 0),
    mimeType: firstText(value.mimeType),
    url: safeImageUrl(value.url),
  };
}

function normalizeTags(value) {
  const text = Array.isArray(value) ? value.map(asText).join(' ') : asText(value);
  return [...new Set(text.split(/[\s,，、]+/).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith('#') ? tag : `#${tag}`))];
}

function parsePayload(content) {
  const parsed = parseFirstJsonObject(content);
  if (parsed && typeof parsed === 'object') return parsed;
  const text = String(content || '');
  return {
    title: markdownSection(text, ['标题', '主标题', '小红书标题']),
    body: markdownSection(text, ['正文', '笔记正文', '发布文案']),
    images: markdownSection(text, ['配图建议', '配图', '图片方案', 'image_cards']),
    interaction: markdownSection(text, ['互动/活动规则', '互动', '活动规则']),
    hashtags: markdownSection(text, ['话题标签', '标签', 'hashtags']),
    review: markdownSection(text, ['品牌词与风格自检', '自检', 'review']),
  };
}

function markdownSection(text, headings) {
  for (const heading of headings) {
    const match = new RegExp(`(?:^|\\n)#{1,4}\\s*${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s+|$)`, 'i').exec(String(text || ''));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return '';
}

function parseFirstJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  for (let end = raw.length; end > start; end = raw.lastIndexOf('}', end - 1)) {
    if (end <= start) break;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return '';
}

function richText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(richText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const preferred = firstText(value.title, value.caption, value.text, value.content, value.description, value.scene, value.name);
    if (preferred) return preferred;
    return Object.values(value).map(richText).filter(Boolean).join('\n');
  }
  return String(value).trim();
}

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' / ');
  if (typeof value === 'object') return firstText(value.title, value.caption, value.text, value.content, value.description, value.scene, value.name);
  return String(value).trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cloneArtifact(artifact) {
  return JSON.parse(JSON.stringify(artifact));
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
