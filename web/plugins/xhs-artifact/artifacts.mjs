import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseXhsArtifactToolOutput,
  XHS_ARTIFACT_EDITOR_HINT,
  XHS_ARTIFACT_INPUT_SCHEMA,
  XHS_IMAGE_FIELDS,
  XHS_PAYLOAD_FIELDS,
} from './xhs-artifact-contract.mjs';

export class XhsArtifactRegistry {
  constructor(options = {}) {
    this.entries = new Map();
    this.storageDir = path.resolve(options.storageDir || path.join(process.cwd(), '.neoctl-web', 'xhs-artifacts'));
    this.sessionsDir = path.resolve(options.sessionsDir || path.join(os.homedir(), '.neoctl', 'sessions'));
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
    this.persist(artifact);
    return cloneArtifact(artifact);
  }

  get(id, sessionId) {
    const artifactId = safeArtifactId(id);
    if (!artifactId) return undefined;
    const artifact = this.entries.get(artifactId) || this.load(artifactId) || this.recoverFromTranscript(artifactId, sessionId);
    if (artifact) this.entries.set(artifact.id, artifact);
    if (!artifactBelongsToSession(artifact, sessionId)) return undefined;
    return artifact ? cloneArtifact(artifact) : undefined;
  }

  update(id, patch, sessionId) {
    const artifact = this.get(id, sessionId);
    if (!artifact) return undefined;
    if (typeof patch.title === 'string') artifact.title = patch.title.trim().slice(0, 160);
    if (patch.payload !== undefined) artifact.payload = validateEditorPayload(patch.payload);
    if (typeof patch.content === 'string') artifact.content = patch.content;
    artifact.updatedAt = Date.now();
    this.entries.set(artifact.id, artifact);
    this.persist(artifact);
    return cloneArtifact(artifact);
  }

  load(id) {
    try {
      return normalizeArtifact(JSON.parse(fs.readFileSync(this.artifactFile(id), 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`failed to load xhs artifact ${id}:`, error);
      return undefined;
    }
  }

  persist(artifact) {
    fs.mkdirSync(this.storageDir, { recursive: true });
    const target = this.artifactFile(artifact.id);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  }

  recoverFromTranscript(id, sessionId) {
    const safeSessionId = safeSessionDirectoryName(sessionId);
    if (!safeSessionId) return undefined;
    try {
      const transcript = fs.readFileSync(path.join(this.sessionsDir, safeSessionId, 'transcript.jsonl'), 'utf8');
      const lines = transcript.split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        let entry;
        try { entry = JSON.parse(lines[index]); } catch { continue; }
        for (const block of entry?.message?.blocks || []) {
          if (block?.type !== 'tool_result' || !['open_xhs_artifact_editor', 'read_xhs_artifact'].includes(block.name)) continue;
          const recovered = parseXhsArtifactToolOutput(block.output);
          if (String(recovered?.id || '') !== id) continue;
          const artifact = normalizeArtifact({ ...recovered, sessionId: recovered.sessionId || safeSessionId });
          this.persist(artifact);
          return artifact;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`failed to recover xhs artifact ${id}:`, error);
    }
    return undefined;
  }

  artifactFile(id) {
    return path.join(this.storageDir, `${id}.json`);
  }
}

export function createOpenXhsArtifactEditorTool(options) {
  return {
    name: 'open_xhs_artifact_editor',
    description: XHS_ARTIFACT_EDITOR_HINT,
    inputSchema: XHS_ARTIFACT_INPUT_SCHEMA,
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
      const sessionId = context?.session?.sessionId;
      const artifact = input.artifactId
        ? options.registry.update(input.artifactId, { title: input.title, payload: input.payload, content: input.content }, sessionId)
        : options.registry.add({
            title: input.title,
            payload: input.payload,
            content: input.content,
            sessionId: context.session?.sessionId,
          });
      if (!artifact) throw new Error(`xhs artifact not found: ${input.artifactId}; call read_xhs_artifact first or omit artifact_id to create a new editor`);
      const action = input.artifactId ? 'Updated' : 'Opened';
      return {
        ok: true,
        output: {
          artifact: clientArtifact(artifact),
          action: action.toLowerCase(),
          _ui: xhsArtifactPresentation(artifact),
        },
        summary: `${action} Xiaohongshu editor ${artifact.id}`,
      };
    },
  };
}

export function xhsArtifactPresentation(artifact, sessionId = artifact?.sessionId) {
  if (!artifact?.id) return undefined;
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return {
    title: '编辑小红书笔记',
    bodyTitle: artifact.title || '小红书笔记',
    text: '可编辑笔记已就绪。',
    presentationLevel: 'primary',
    resources: [{
      kind: 'embed',
      url: `/api/xhs-artifacts/${encodeURIComponent(artifact.id)}/editor${query}`,
      label: artifact.title || '小红书笔记编辑器',
      height: 720,
    }],
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
    async execute(input, context) {
      const artifact = options.registry.get(input.id, context?.session?.sessionId);
      if (!artifact) throw new Error(`xhs artifact not found: ${input.id}`);
      return { ok: true, output: { artifact: clientArtifact(artifact) }, summary: '已读取稿件' };
    },
  };
}

export async function serveXhsArtifact(registry, req, res, id, readJsonBody, sessionId) {
  if (req.method === 'GET') {
    const artifact = registry.get(id, sessionId);
    return artifact ? sendJson(res, { ok: true, artifact: clientArtifact(artifact) }) : sendJson(res, { error: 'artifact not found' }, 404);
  }
  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    assertExactKeys(body, ['title', 'payload'], 'request');
    const payload = validateEditorPayload(body?.payload);
    const artifact = registry.update(id, { title: payload.title, payload }, sessionId);
    return artifact ? sendJson(res, { ok: true, artifact: clientArtifact(artifact) }) : sendJson(res, { error: 'artifact not found' }, 404);
  }
  return sendJson(res, { error: 'method not allowed' }, 405);
}

function normalizeArtifact(value) {
  const payload = validateEditorPayload(value.payload);
  return {
    id: String(value.id),
    type: String(value.type || 'xhs-post'),
    title: payload.title,
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
    title: payload.title,
    body: payload.body,
    interaction: payload.interaction,
    hashtags: [...payload.hashtags],
    images: payload.images.map(clientImage),
    review: payload.review,
  };
}

function clientImage(image) {
  return {
    url: safeImageUrl(image.url),
    caption: image.caption,
    overlay: image.overlay,
    note: image.note,
  };
}

function validateEditorPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('payload must be an object');
  }
  assertExactKeys(value, XHS_PAYLOAD_FIELDS, 'payload');

  const title = requireEditorString(value.title, 'payload.title').trim().slice(0, 160);
  const body = requireEditorString(value.body, 'payload.body').trim();
  const interaction = requireEditorString(value.interaction, 'payload.interaction').trim();
  const review = requireEditorString(value.review, 'payload.review').trim();
  if (!title) throw contractError('payload.title must contain the final post title');
  if (!body) throw contractError('payload.body must contain final publish-ready正文 only');
  validateBodyBoundaries(body, title);
  if (!Array.isArray(value.hashtags)) throw contractError('payload.hashtags must be an array of strings such as ["#话题"]');
  if (!Array.isArray(value.images)) throw contractError('payload.images must be an array of {url, caption, overlay, note} objects');
  if (!value.images.length) throw contractError('payload.images must contain at least one image or planned placeholder');

  const hashtags = value.hashtags.map((tag, index) => {
    if (typeof tag !== 'string') throw contractError(`payload.hashtags[${index}] must be a string`);
    const normalized = tag.trim().replace(/^＃/u, '#');
    if (!/^#[^\s#]+$/u.test(normalized)) throw contractError(`payload.hashtags[${index}] must be exactly one #topic without spaces`);
    return normalized.slice(0, 100);
  });
  const images = value.images.map((image, index) => validateEditorImage(image, index));

  return {
    title,
    body,
    interaction,
    hashtags: [...new Set(hashtags)].slice(0, 40),
    images,
    review,
  };
}

function validateEditorImage(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError(`payload.images[${index}] must be an object with url, caption, overlay, note`);
  }
  assertExactKeys(value, XHS_IMAGE_FIELDS, `payload.images[${index}]`);
  const rawUrl = requireEditorString(value.url, `payload.images[${index}].url`).trim();
  const url = safeImageUrl(rawUrl);
  if (rawUrl && !url) {
    throw contractError(`payload.images[${index}].url must be a real http(s) URL, /api/ URL, or absolute local image path; use "" for a placeholder`);
  }
  const caption = requireEditorString(value.caption, `payload.images[${index}].caption`).trim();
  const overlay = requireEditorString(value.overlay, `payload.images[${index}].overlay`).trim();
  const note = requireEditorString(value.note, `payload.images[${index}].note`).trim();
  if (!url && !caption && !note) throw contractError(`payload.images[${index}] is an empty placeholder; describe the planned image in caption or note`);
  return {
    url,
    caption: caption.slice(0, 1000),
    overlay: overlay.slice(0, 500),
    note: note.slice(0, 2000),
  };
}

function requireEditorString(value, field) {
  if (typeof value !== 'string') throw contractError(`${field} must be a string`);
  return value;
}

function safeImageUrl(...values) {
  const url = String(values.find((value) => typeof value === 'string') || '').trim();
  if (!url || /^data:/i.test(url)) return '';
  if (/^(?:https?:|\/api\/)/i.test(url)) return url.slice(0, 2048);
  if (isLocalFilePath(url)) return `/api/local-images/${encodeURIComponent(Buffer.from(url, 'utf8').toString('base64url'))}`;
  return '';
}

function isLocalFilePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

function assertExactKeys(value, expected, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError(`${path} must be an object`);
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      extra.length ? `unexpected ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw contractError(`${path} must contain exactly ${expected.join(', ')} (${details})`);
  }
}

function validateBodyBoundaries(body, title) {
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (firstLine === title || firstLine.replace(/^#{1,6}\s*/, '') === title) {
    throw contractError('payload.body must not repeat payload.title as its first line');
  }
  if (/```|~~~/.test(body)) throw contractError('payload.body must not contain fenced Markdown or JSON');
  if (/^\s*#{1,6}\s*(?:标题|正文|笔记正文|发布文案|配图|图片方案|话题标签|标签|审核|review)\s*[:：]?\s*$/imu.test(body)) {
    throw contractError('payload.body must not contain editor section headings');
  }
  if (/(?:^|\s)#[^\s#]+/u.test(body)) throw contractError('payload.body must not contain hashtags; put them in payload.hashtags');
  if (/^\s*\{[\s\S]*"(?:title|body|images|hashtags)"\s*:/u.test(body)) {
    throw contractError('payload.body must not contain serialized tool JSON');
  }
}

function contractError(message) {
  return new Error(`Invalid Xiaohongshu editor payload: ${message}. Retry open_xhs_artifact_editor with the exact documented schema; do not send Markdown or alternate fields.`);
}

function safeArtifactId(value) {
  const id = String(value || '').trim();
  return id && /^[A-Za-z0-9._-]+$/u.test(id) && path.basename(id) === id ? id : '';
}

function safeSessionDirectoryName(value) {
  const id = String(value || '').trim();
  return id && /^[A-Za-z0-9._:-]+$/u.test(id) && !id.includes('..') && path.basename(id) === id ? id : '';
}

function artifactBelongsToSession(artifact, sessionId) {
  const expected = String(sessionId || '').trim();
  return Boolean(artifact) && (!expected || !artifact.sessionId || artifact.sessionId === expected);
}

function cloneArtifact(artifact) {
  return JSON.parse(JSON.stringify(artifact));
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
