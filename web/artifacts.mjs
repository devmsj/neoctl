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
    description: [
      'Create or update the user-editable Xiaohongshu post editor shown in the web conversation.',
      'Always pass the exact structured payload; never pass Markdown, analysis, a content blob, or alternate field names.',
      'Exact input example: {"artifact_id":"omit for a new draft; reuse after read_xhs_artifact when revising","payload":{"title":"published post title only","body":"final publish-ready post body only","interaction":"optional CTA/activity rules only","hashtags":["#topic"],"images":[{"url":"actual image URL or absolute local image path; empty only for a planned placeholder","caption":"what this image shows","overlay":"text visibly printed on the image","note":"internal shooting/design note"}],"review":"internal review notes, never part of body"}}.',
      'Field boundaries are strict: body must not contain the title, hashtags, image plan, review, JSON, or Markdown section headings. hashtags must be an array. images must be an array of objects, never prose.',
      'For a generated or uploaded image, put the exact returned URL or absolute file path in images[].url. Never put a prompt, caption, Markdown image syntax, image id, or descriptive sentence in url. If no real file exists yet, use url:"" and put the plan in caption/note.',
      'To revise an existing editor: first call read_xhs_artifact with its id, preserve the user-edited fields, then call this tool with artifact_id set to that same id and the complete revised payload.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: {
          type: 'string',
          description: 'Existing artifact id to update. Omit for a new editor. Before using this, call read_xhs_artifact with the same id.',
        },
        payload: {
          type: 'object',
          description: 'Complete editor state. Use only the exact fields declared here.',
          properties: {
            title: {
              type: 'string',
              description: 'Final Xiaohongshu post title only. Do not include cover text, body, hashtags, or alternatives.',
            },
            body: {
              type: 'string',
              description: 'Final publish-ready正文 only. Do not include the title, hashtags, image descriptions/plans, review notes, JSON, or Markdown headings such as “正文”.',
            },
            interaction: {
              type: 'string',
              description: 'Optional CTA, giveaway, or activity rules shown separately from正文. Use an empty string when absent.',
            },
            hashtags: {
              type: 'array',
              description: 'Topic tags only, one string per tag, preferably including #. Never put them in body.',
              items: { type: 'string' },
            },
            images: {
              type: 'array',
              description: 'Ordered image carousel. Each item is one actual image or one explicit placeholder slot; never pass a string or Markdown list.',
              items: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description: 'Actual http(s) URL, /api/ image URL, or absolute local image file path. Use "" only if the image has not been created. Never put descriptive prose here.',
                  },
                  caption: {
                    type: 'string',
                    description: 'Short description of what the image shows. This is not正文 and is not the image URL.',
                  },
                  overlay: {
                    type: 'string',
                    description: 'Exact words visibly printed on the image/cover. Use "" if there is no overlaid text.',
                  },
                  note: {
                    type: 'string',
                    description: 'Internal shooting, generation, layout, or design note. Use "" if absent.',
                  },
                },
                required: ['url', 'caption', 'overlay', 'note'],
                additionalProperties: false,
              },
            },
            review: {
              type: 'string',
              description: 'Internal compliance/style review notes. Never copy this into正文. Use "" when absent.',
            },
          },
          required: ['title', 'body', 'interaction', 'hashtags', 'images', 'review'],
          additionalProperties: false,
        },
      },
      required: ['payload'],
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
      const payload = validateEditorPayload(input?.payload);
      return {
        artifactId: String(input?.artifact_id || '').trim(),
        title: payload.title,
        payload,
        content: '',
      };
    },
    async execute(input, context) {
      const artifact = input.artifactId
        ? options.registry.update(input.artifactId, { title: input.title, payload: input.payload, content: input.content })
        : options.registry.add({
            title: input.title,
            payload: input.payload,
            content: input.content,
            sessionId: context.session?.sessionId,
          });
      if (!artifact) throw new Error(`xhs artifact not found: ${input.artifactId}; call read_xhs_artifact first or omit artifact_id to create a new editor`);
      const action = input.artifactId ? 'Updated' : 'Opened';
      return { ok: true, output: { artifact: clientArtifact(artifact), action: action.toLowerCase() }, summary: `${action} Xiaohongshu editor ${artifact.id}` };
    },
  };
}

export function createReadXhsArtifactTool(options) {
  return {
    name: 'read_xhs_artifact',
    description: 'Read the latest user-edited Xiaohongshu editor state. Before revising, call this with the artifact id, preserve the returned user edits, then call open_xhs_artifact_editor with artifact_id set to the same id and a complete exact payload.',
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
      return { ok: true, output: { artifact: clientArtifact(artifact) }, summary: '已读取稿件' };
    },
  };
}

export async function serveXhsArtifact(registry, req, res, id, readJsonBody) {
  if (req.method === 'GET') {
    const artifact = registry.get(id);
    return artifact ? sendJson(res, { ok: true, artifact: clientArtifact(artifact) }) : sendJson(res, { error: 'artifact not found' }, 404);
  }
  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    const artifact = registry.update(id, body || {});
    return artifact ? sendJson(res, { ok: true, artifact: clientArtifact(artifact) }) : sendJson(res, { error: 'artifact not found' }, 404);
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

function clientArtifact(artifact) {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    payload: clientPayload(artifact.payload),
    sessionId: artifact.sessionId,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function clientPayload(payload) {
  return {
    type: firstText(payload.type, 'xiaohongshu_post_draft'),
    version: firstText(payload.version, '1.0'),
    id: firstText(payload.id),
    status: firstText(payload.status, 'draft'),
    meta: compactObject(payload.meta),
    brief: compactObject(payload.brief),
    title: firstText(payload.title),
    body: richText(payload.body),
    interaction: interactionText(payload.interaction),
    hashtags: Array.isArray(payload.hashtags) ? payload.hashtags.slice(0, 40) : normalizeTags(payload.hashtags),
    images: Array.isArray(payload.images) ? payload.images.map(clientImage) : [],
    review: richText(payload.review),
  };
}

function clientImage(image) {
  return {
    id: firstText(image.id),
    url: safeImageUrl(image.url),
    caption: firstText(image.caption),
    overlay: firstText(image.overlay, image.overlay_text?.main, image.overlay_text?.sub),
    note: richText(image.note).slice(0, 2000),
  };
}

function compactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item)]).filter(([, item]) => item !== undefined && item !== ''));
}

function compactValue(value) {
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(compactValue).filter((item) => item !== undefined && item !== '');
  if (value && typeof value === 'object') return compactObject(value);
  return undefined;
}

function normalizePayload(value) {
  const root = value && typeof value === 'object' ? { ...value } : {};
  const payload = root.web_editor_payload || root.post || root.draft || root.payload || root;
  const content = payload.content && typeof payload.content === 'object' ? payload.content : {};
  const imageCards = firstImageList(payload.image_cards, payload.images, payload.image_plan, payload.imagePlan, payload.cards, payload.visuals);
  return {
    ...payload,
    title: firstText(payload.title, payload.main_title, payload.cover_title, payload.final_title, content.final_title, payload.title_options, content.title_options, payload.titles),
    body: richText(content.body || payload.body || payload.caption || payload.copy || payload.text || payload.main_body),
    interaction: interactionText(payload.interaction || payload.rules || payload.activity_rules || payload.cta || payload.call_to_action),
    hashtags: normalizeTags(content.hashtags || payload.hashtags || payload.tags || payload.topics),
    images: normalizeImages(imageCards),
    review: richText(payload.review || payload.check || payload.self_check || payload.safety_check),
  };
}

function validateEditorPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payload must be an object with exactly: title, body, interaction, hashtags, images, review');
  }

  const title = requireEditorString(value.title, 'payload.title').trim().slice(0, 160);
  const body = requireEditorString(value.body, 'payload.body').trim();
  const interaction = requireEditorString(value.interaction, 'payload.interaction').trim();
  const review = requireEditorString(value.review, 'payload.review').trim();
  if (!title) throw new Error('payload.title must contain the final post title');
  if (!body) throw new Error('payload.body must contain the final publish-ready正文 only');
  if (!Array.isArray(value.hashtags)) throw new Error('payload.hashtags must be an array of tag strings');
  if (!Array.isArray(value.images)) throw new Error('payload.images must be an array of image objects, not prose or Markdown');

  const hashtags = value.hashtags.map((tag, index) => {
    if (typeof tag !== 'string') throw new Error(`payload.hashtags[${index}] must be a string`);
    return tag;
  });
  const images = value.images.map((image, index) => validateEditorImage(image, index));

  return {
    title,
    body,
    interaction,
    hashtags: normalizeTags(hashtags),
    images,
    review,
  };
}

function validateEditorImage(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`payload.images[${index}] must be an object with url, caption, overlay, note`);
  }
  const rawUrl = requireEditorString(value.url, `payload.images[${index}].url`).trim();
  const url = safeImageUrl(rawUrl);
  if (rawUrl && !url) {
    throw new Error(`payload.images[${index}].url must be an actual http(s) URL, /api/ image URL, or absolute local image path; put descriptions in caption/note`);
  }
  return {
    id: `image-${index + 1}`,
    url,
    caption: requireEditorString(value.caption, `payload.images[${index}].caption`).trim(),
    overlay: requireEditorString(value.overlay, `payload.images[${index}].overlay`).trim(),
    note: requireEditorString(value.note, `payload.images[${index}].note`).trim(),
  };
}

function requireEditorString(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function firstImageList(...values) {
  for (const value of values) {
    const images = normalizeImages(value);
    if (images.some(hasUsefulImageInfo)) return value;
  }
  return values.find((value) => Array.isArray(value) && value.length) || values.find(Boolean);
}

function hasUsefulImageInfo(image) {
  return Boolean(image.url || image.caption || image.overlay || image.note);
}

function normalizeImages(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n/).filter(Boolean);
  return list.map((item, index) => {
    if (item && typeof item === 'object') {
      return {
        id: firstText(item.id, item.key, `image-${index + 1}`),
        url: safeImageUrl(item.url, item.src, item.imageUrl, item.image_url, item.preview_url, item.previewUrl, item.local_path, item.path),
        caption: firstText(item.caption, item.title, item.role, item.scene, item.description, item.text, item.visual, item.visual_brief, item.shot, item.copy, `配图 ${index + 1}`),
        overlay: firstText(item.overlay, item.overlay_text?.main, item.overlay_text?.sub, item.overlay_text, item.cover_text, item.key_text, item.headline),
        note: richText(item.note || item.direction || item.prompt || item.detail || item.layout || item.frame || item.visual_brief || item.design_notes || item.replace_instruction),
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
  if (/^(?:https?:|\/api\/)/i.test(url)) return url.slice(0, 2048);
  if (isLocalFilePath(url)) return `/api/local-images/${encodeURIComponent(Buffer.from(url, 'utf8').toString('base64url'))}`;
  return '';
}

function isLocalFilePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
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

function interactionText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return cleanInteractionLines(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return '';
  if (Array.isArray(value)) return cleanInteractionLines(value.map(interactionText).filter(Boolean).join('\n'));
  if (typeof value === 'object') {
    return cleanInteractionLines([
      value.type,
      value.action_text,
      value.activity_time,
      value.prize,
      value.winner_count,
      value.claim_note,
      value.risk_note,
      value.note,
      value.description,
      value.text,
      value.content,
    ].map(richText).filter(Boolean).join('\n'));
  }
  return cleanInteractionLines(String(value));
}

function cleanInteractionLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:true|false|未设置|无|none|null|undefined)$/i.test(line))
    .join('\n');
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
