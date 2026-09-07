import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { TaskStore } from '../tasks/task-store.js';
import type { LocalAgentTask } from '../agents/local-agent-task.js';
import { validTaskId } from '../tasks/task-persistence.js';
import { redactToolDetail, sanitizeAgentToolPayload, type DetailPart } from './tool-call-detail.js';
import { classifyToolDetailFields } from './tool-detail-fields.js';

/** Server-owned context ONLY. Never construct this from request/query/body fields.
 * The store must already be loaded by the host. Loading/binding it here would write.
 * redact must apply the owner's runtime secret registry (redactDisplayValue).
 */
export interface AgentContentOwner {
  ownerSessionId: string;
  ownerSessionDir: string;
  taskStore: Pick<TaskStore, 'getInSession'>;
  redact: (value: unknown) => unknown;
}
export interface AgentContentRequest {
  taskId: string;
  runGeneration: number;
  cursor?: string;
  pageChars?: number;
  /** Only with a drained timeline's refreshCursor. Extends its immutable upper bound. */
  refresh?: boolean;
}
export interface AgentContentFragment extends DetailPart {
  /** Offset/length in the fully sanitized string, UTF-16; join by id + offset. */
  offset: number;
  totalChars: number;
  hasMore: boolean;
}
export interface AgentTimelineItem {
  id: string;
  kind: 'assistant' | 'tool_use' | 'tool_result';
  messageId: string;
  createdAt?: string;
  toolUseId?: string;
  toolName?: string;
  ok?: boolean;
  /** Source fact only. A tool_use alone does not prove it is still running. */
  status?: 'invoked' | 'completed' | 'failed' | 'unknown';
  object?: DetailPart;
  /** assistant body / serialized input / real result, respectively. */
  content: AgentContentFragment;
}
export interface AgentContentPage {
  ownerSessionId: string;
  taskId: string;
  runGeneration: number;
  state: 'complete' | 'partial' | 'missing' | 'unavailable';
  reason: string;
  snapshotId?: string;
  nextCursor?: string;
  refreshCursor?: string;
  upperBoundBytes?: number;
  pendingTail?: boolean;
  items?: AgentTimelineItem[];
  /** Delegation uses task.prompt/description, NOT inherited context or resume directives. */
  delegation?: { scope: 'task'; prompt: AgentContentFragment; description: DetailPart };
  messages?: { content: AgentContentFragment };
  report?: { source: 'task.result' | 'runHistory'; taskStatus: string; reportStatus?: 'completed' | 'incomplete'; content: AgentContentFragment; error: DetailPart };
}
const MAX_LINE = 16 * 1024 * 1024;
const SCAN_PAGE = 4 * 1024 * 1024;
const REF_SCAN = 32 * 1024 * 1024;
const CHUNK = 64 * 1024;
const MAX_CHARS = 64 * 1024;
const TTL = 30 * 60 * 1000;
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const hash = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
const text = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
const absent = (reason = '未提供'): DetailPart => ({ state: 'missing', text: '', reason });
class ReadFailure extends Error {
  constructor(readonly reason: string, readonly state: 'missing' | 'unavailable' = 'unavailable') { super(reason); }
}
function fail(reason: string): never { throw new ReadFailure(reason); }
function generation(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) > 0; }
// Windows lstat reports dev=0 while fstat reports the volume serial number.
// Paths are checked independently; compare the file index and creation time there.
function fileIdentity(s: Stats): string { return `${process.platform === 'win32' ? 0 : s.dev}:${s.ino}:${s.birthtimeMs}`; }
function regular(s: Stats): void { if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail('不安全的文件：链接、hardlink 或非普通文件'); }
async function directory(dir: string): Promise<void> {
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || path.resolve(await fs.realpath(dir)) !== path.resolve(dir)) fail('不安全的目录：链接或路径身份不明确');
}
async function directories(owner: AgentContentOwner, agentId: string): Promise<string> {
  // Check every ancestor too: canonicalizing a junction first would silently authorize it.
  const absolute = path.resolve(owner.ownerSessionDir);
  const root = path.parse(absolute).root;
  let dir = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) { dir = path.join(dir, segment); await directory(dir); }
  await directory(path.join(dir, 'subagents'));
  dir = path.join(dir, 'subagents', agentId);
  await directory(dir);
  return dir;
}
async function openChecked(owner: AgentContentOwner, agentId: string, suffix: string[]): Promise<{ handle: FileHandle; stat: Stats; check: () => Promise<Stats> }> {
  const child = await directories(owner, agentId);
  if (suffix.length === 2) await directory(path.join(child, suffix[0]!));
  const file = path.join(child, ...suffix);
  const before = await fs.lstat(file); regular(before);
  if (path.resolve(await fs.realpath(file)) !== path.resolve(file)) fail('不安全的文件路径');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const check = async () => {
    await directories(owner, agentId);
    if (suffix.length === 2) await directory(path.join(child, suffix[0]!));
    const [named, opened] = await Promise.all([fs.lstat(file), handle.stat()]);
    regular(named); regular(opened);
    if (fileIdentity(named) !== fileIdentity(before) || fileIdentity(opened) !== fileIdentity(before)) fail('读取期间文件身份已改变');
    return opened;
  };
  try { return { handle, stat: await check(), check }; } catch (e) { await handle.close(); throw e; }
}
async function readBytes(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const out = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const got = await handle.read(out, read, length - read, start + read);
    if (!got.bytesRead) fail('文件在读取期间缩短');
    read += got.bytesRead;
  }
  return out;
}
/** Bounded one-entry read, not readFile/readline's unbounded line buffering. */
async function lineAt(handle: FileHandle, start: number, upper: number): Promise<{ value?: unknown; end: number; tail: boolean }> {
  const buffers: Buffer[] = [];
  let pos = start;
  while (pos < upper) {
    const b = await readBytes(handle, pos, Math.min(CHUNK, upper - pos));
    const lf = b.indexOf(10);
    const used = lf < 0 ? b.length : lf + 1;
    if (pos + used - start > MAX_LINE) fail('单条 JSONL 超过 16 MiB 安全读取上限；未跳过内容');
    buffers.push(b.subarray(0, used)); pos += used;
    if (lf >= 0) {
      try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers))), end: pos, tail: false }; }
      catch { fail('JSONL 内容损坏或 UTF-8 无效；未跳过内容'); }
    }
  }
  return { end: start, tail: pos > start };
}
async function anchors(handle: FileHandle, upper: number): Promise<string> {
  return hash(Buffer.concat([await readBytes(handle, 0, Math.min(CHUNK, upper)), await readBytes(handle, Math.max(0, upper - CHUNK), Math.min(CHUNK, upper))]));
}
function truncated(v: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (typeof v === 'string') {
    if (/<persisted-output>|\[Tool result truncated|\[Old tool result content cleared\]/.test(v)) return true;
    try { const parsed = JSON.parse(v); return typeof parsed === 'object' && parsed !== null && truncated(parsed, depth + 1); } catch { return false; }
  }
  const r = record(v);
  return Array.isArray(v) ? v.some(x => truncated(x, depth + 1)) : !!r && Object.entries(r).some(([k, x]) => (/truncated|hasMore|has_more/.test(k) && x === true) || (k === 'omitted_chars' && !!record(x) && Object.values(x as object).some(n => typeof n === 'number' && n > 0)) || (typeof x === 'object' && truncated(x, depth + 1)));
}
function sanitize(owner: AgentContentOwner, v: unknown): unknown {
  // Preserve the original value; ownership and source selection are checked separately.
  return v;
}
function part(owner: AgentContentOwner, v: unknown): DetailPart {
  if (v === undefined) return absent();
  const isTruncated = truncated(v);
  return { state: isTruncated ? 'truncated' : 'complete', text: text(sanitize(owner, v)), reason: isTruncated ? '保存的源数据已截断，不是全文' : '已保存内容的脱敏全文' };
}
function preview(p: DetailPart, max = 2048): DetailPart {
  return p.text.length <= max ? p : { state: 'truncated', text: p.text.slice(0, max), reason: '摘要明确截断；不作为全文' };
}
function fragment(p: DetailPart, offset: number, chars: number): AgentContentFragment {
  let end = Math.min(p.text.length, offset + chars);
  if (end < p.text.length && end > offset && /[\uD800-\uDBFF]/.test(p.text[end - 1]!)) end--;
  return { ...p, text: p.text.slice(offset, end), offset, totalChars: p.text.length, hasMore: end < p.text.length };
}
interface Cursor {
  kind: 'timeline' | 'delegation' | 'report' | 'messages'; binding: string; expires: number; snapshotId: string;
  pos: number; block: number; offset: number; done: boolean;
  upper: number; file: string; anchor: string; mtime: number; ctime: number;
  digest?: string;
}
/** Keep one resolver per server. Cursors expire on restart or after 30 minutes.
 * No routes, subscriptions, SessionStore, model, message or lifecycle operations.
 */
export function createAgentContentDetailResolver() {
  const key = randomBytes(32);
  function encode(c: Cursor): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(c)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  function decode(token: string, binding: string, kind: Cursor['kind']): Cursor {
    try {
      if (typeof token !== 'string' || token.length > 4096) fail('无效游标');
      const b = Buffer.from(token, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); decipher.setAuthTag(b.subarray(-16));
      const c = JSON.parse(Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]).toString()) as Cursor;
      if (c.binding !== binding || c.kind !== kind || c.expires < Date.now()) fail('游标过期或不属于请求对象');
      return c;
    } catch { fail('游标无效、过期或不属于请求对象'); }
  }
  async function authorize(owner: AgentContentOwner, req: AgentContentRequest): Promise<{ task: LocalAgentTask; binding: string; chars: number }> {
    if (!owner.ownerSessionId || !path.isAbsolute(owner.ownerSessionDir) || typeof owner.redact !== 'function' || !validTaskId(req.taskId) || !generation(req.runGeneration)) fail('无效的所属会话或任务轮次');
    if (Object.keys(req).some(k => !['taskId', 'runGeneration', 'cursor', 'pageChars', 'refresh'].includes(k))) fail('请求只允许任务身份与分页参数');
    if (req.pageChars !== undefined && (!Number.isSafeInteger(req.pageChars) || req.pageChars < 256 || req.pageChars > MAX_CHARS)) fail('pageChars 必须为 256..65536 的整数');
    if (req.refresh !== undefined && typeof req.refresh !== 'boolean') fail('无效刷新参数');
    const task = owner.taskStore.getInSession(req.taskId, owner.ownerSessionDir);
    if (!task) throw new ReadFailure('任务不属于已授权会话或不存在', 'missing');
    if (task.id !== req.taskId || task.taskId !== req.taskId || task.type !== 'agent' || !validTaskId(task.agentId) || path.resolve(task.ownerSessionDir ?? '') !== path.resolve(owner.ownerSessionDir)) fail('任务身份不明确');
    if (!generation(task.runGeneration) || req.runGeneration > task.runGeneration) throw new ReadFailure('指定轮次未记录', 'missing');
    const child = await directories(owner, task.agentId);
    // Store is authoritative. Do not load/recover task.json; reject unsafe existing storage.
    try { regular(await fs.lstat(path.join(child, 'task.json'))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return { task, binding: hash(JSON.stringify([owner.ownerSessionId, path.resolve(owner.ownerSessionDir), task.id, task.agentId, req.runGeneration])), chars: req.pageChars ?? 16000 };
  }
  function fresh(kind: Cursor['kind'], binding: string): Cursor {
    return { kind, binding, expires: Date.now() + TTL, snapshotId: randomBytes(12).toString('hex'), pos: 0, block: 0, offset: 0, done: false, upper: 0, file: '', anchor: '', mtime: 0, ctime: 0 };
  }
  async function guarded(owner: AgentContentOwner, req: AgentContentRequest, read: (base: AgentContentPage, auth: Awaited<ReturnType<typeof authorize>>) => Promise<AgentContentPage>): Promise<AgentContentPage> {
    const base: AgentContentPage = { ownerSessionId: owner.ownerSessionId, taskId: req.taskId, runGeneration: req.runGeneration, state: 'complete', reason: '' };
    try {
      const auth = await authorize(owner, req);
      const currentRun = auth.task.runGeneration;
      const result = await read(base, auth);
      const latest = await authorize(owner, req);
      if (latest.binding !== auth.binding || latest.task.runGeneration !== currentRun) fail('读取期间任务所属关系或当前轮次改变；请重试');
      return result;
    } catch (e) {
      return { ...base, state: e instanceof ReadFailure ? e.state : 'unavailable', reason: e instanceof ReadFailure ? e.reason : '内容已清理、不可访问或安全读取失败' };
    }
  }
  async function referencedResult(owner: AgentContentOwner, task: LocalAgentTask, req: AgentContentRequest, handle: FileHandle, upper: number, callId: string, output: string): Promise<DetailPart> {
    const unavailable: DetailPart = { state: 'unavailable', text: '', reason: '完整工具结果引用不可获取：路径、调用身份不明确、已清理或超过安全读取上限' };
    try {
      // Ref filenames are a lossy projection in the writer. Verify collisions in ALL runs.
      const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'tool-result';
      const id = safeId(callId);
      // Mutable reference files have no generation metadata. Never use one for an
      // archived run or while the transcript has advanced beyond this snapshot.
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id) || upper > REF_SCAN || task.runGeneration !== req.runGeneration || (await handle.stat()).size !== upper) return unavailable;
      let uses = 0; let results = 0;
      for (let pos = 0; pos < upper;) {
        const line = await lineAt(handle, pos, upper); if (line.tail) break; pos = line.end;
        const e = record(line.value); const m = record(e?.message);
        if (e?.type !== 'message' || !Array.isArray(m?.blocks)) continue;
        for (const b of m.blocks.map(record)) {
          const other = b?.type === 'tool_use' ? b.id : b?.type === 'tool_result' ? b.toolUseId : undefined;
          if (typeof other !== 'string' || safeId(other) !== id) continue;
          if (other !== callId || e.runGeneration !== req.runGeneration || e.sessionId !== task.agentId || e.agentId !== task.agentId) return unavailable;
          if (b?.type === 'tool_use') uses++; else results++;
        }
      }
      if (uses !== 1 || results !== 1) return unavailable;
      const ref = /Full output saved to: ([^\r\n]+)\r?\n/.exec(output)?.[1];
      const child = path.join(owner.ownerSessionDir, 'subagents', task.agentId);
      const ext = ['json', 'txt'].find(ext => ref === path.join(child, 'tool-results', `${id}.${ext}`));
      if (!ext) return unavailable;
      const stored = await openChecked(owner, task.agentId, ['tool-results', `${id}.${ext}`]);
      try {
        if (stored.stat.size > MAX_LINE) return unavailable;
        const bytes = await readBytes(stored.handle, 0, stored.stat.size);
        const end = await stored.check();
        if (end.size !== stored.stat.size || end.mtimeMs !== stored.stat.mtimeMs || end.ctimeMs !== stored.stat.ctimeMs || (await handle.stat()).size !== upper) return unavailable;
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return part(owner, ext === 'json' ? JSON.parse(value) : value);
      } finally { await stored.handle.close(); }
    } catch { return unavailable; }
  }
  async function timeline(owner: AgentContentOwner, req: AgentContentRequest): Promise<AgentContentPage> {
    return guarded(owner, req, async (base, { task, binding, chars }) => {
      const c = req.cursor ? decode(req.cursor, binding, 'timeline') : fresh('timeline', binding);
      if (req.refresh && (!req.cursor || !c.done)) fail('只能从已读完快照的 refreshCursor 刷新');
      const source = await openChecked(owner, task.agentId, ['transcript.jsonl']);
      try {
        const s = source.stat;
        if (req.cursor) {
          if (c.file !== fileIdentity(s) || s.size < c.upper || (s.size === c.upper && (s.mtimeMs !== c.mtime || s.ctimeMs !== c.ctime)) || c.anchor !== await anchors(source.handle, c.upper)) fail('快照文件已替换、缩短或修改；请重新读取');
        }
        if (!req.cursor || req.refresh) {
          c.upper = s.size; c.file = fileIdentity(s); c.anchor = await anchors(source.handle, s.size); c.mtime = s.mtimeMs; c.ctime = s.ctimeMs;
          c.done = false; c.snapshotId = randomBytes(12).toString('hex'); c.expires = Date.now() + TTL;
        }
        if (c.done) fail('快照已读完；请使用 refresh 参数或重新开始');
        const items: AgentTimelineItem[] = [];
        const start = c.pos; let used = 0; let tail = false;
        while (c.pos < c.upper && c.pos - start < SCAN_PAGE && used < chars && items.length < 64) {
          const line = await lineAt(source.handle, c.pos, c.upper);
          if (line.tail) { tail = true; break; }
          const e = record(line.value); const m = record(e?.message);
          if (e?.type !== 'message' || e.runGeneration !== req.runGeneration || e.sessionId !== task.agentId || e.agentId !== task.agentId || !m || m.isMeta === true || !['assistant', 'tool_result'].includes(String(m.role)) || !Array.isArray(m.blocks)) {
            c.pos = line.end; c.block = c.offset = 0; continue;
          }
          for (; c.block < m.blocks.length && used < chars && items.length < 64; c.block++) {
            const b = record(m.blocks[c.block]);
            if (!b) continue;
            let content: DetailPart; let kind: AgentTimelineItem['kind']; let object: DetailPart | undefined;
            const callId = b.type === 'tool_use' ? b.id : b.toolUseId;
            if (m.role === 'assistant' && b.type === 'text' && b.displayChannel === 'visible' && typeof b.text === 'string') {
              kind = 'assistant'; content = part(owner, b.text);
            } else if (((m.role === 'assistant' && b.type === 'tool_use') || (m.role === 'tool_result' && b.type === 'tool_result')) && typeof callId === 'string' && callId.length > 0 && callId.length <= 512 && typeof b.name === 'string' && b.name.length <= 160 && !/^(secret_|.*config)/i.test(b.name)) {
              kind = b.type as 'tool_use' | 'tool_result';
              if (kind === 'tool_use') {
                const input = sanitize(owner, b.input);
                content = part(owner, input);
                const fields = classifyToolDetailFields({ toolName: b.name, input });
                const r = record(input);
                const target = fields.object.value ?? (['terminal_run', 'exec_command'].includes(b.name) ? r?.cmd ?? r?.command : ['terminal_control', 'write_stdin'].includes(b.name) ? r?.session_id : undefined);
                object = preview(part(owner, target));
              } else {
                if (typeof b.output === 'string' && b.output.startsWith('<persisted-output>')) {
                  content = await referencedResult(owner, task, req, source.handle, c.upper, callId, b.output);
                  const authorized = sanitizeAgentToolPayload(b.name, content.text);
                  content = { ...part(owner, authorized.value), state: authorized.unavailable ? 'unavailable' : content.state, reason: authorized.unavailable ?? content.reason };
                } else {
                  const authorized = sanitizeAgentToolPayload(b.name, b.output);
                  content = { ...part(owner, authorized.value), ...(authorized.unavailable ? { state: 'unavailable' as const, reason: authorized.unavailable } : {}) };
                }
              }
            } else continue;
            if (c.offset && c.digest !== hash(content.text)) fail('分片源内容或脱敏策略已改变；请重新读取');
            const piece = fragment(content, c.offset, chars - used);
            items.push({ id: `${c.pos}:${c.block}`, kind, messageId: preview(part(owner, m.id), 512).text,
              createdAt: typeof m.createdAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.Z+-]+$/.test(m.createdAt) ? m.createdAt : undefined,
              ...(kind !== 'assistant' ? { toolUseId: text(sanitize(owner, callId)), toolName: text(sanitize(owner, b.name)),
                status: kind === 'tool_use' ? 'invoked' as const : b.ok === true ? 'completed' as const : b.ok === false ? 'failed' as const : 'unknown' as const,
                ok: typeof b.ok === 'boolean' ? b.ok : undefined, object } : {}), content: piece });
            used += Math.max(1, piece.text.length);
            if (piece.hasMore) { c.offset += piece.text.length; c.digest = hash(content.text); break; }
            c.offset = 0; c.digest = undefined;
          }
          if (c.block < m.blocks.length) break;
          c.pos = line.end; c.block = c.offset = 0;
        }
        c.done = tail || c.pos === c.upper;
        const end = await source.check();
        if (end.size < s.size || (end.size === s.size && (end.mtimeMs !== s.mtimeMs || end.ctimeMs !== s.ctimeMs)) || c.anchor !== await anchors(source.handle, c.upper)) fail('读取期间快照改变；未返回可能混合的内容');
        return { ...base, state: c.done ? 'complete' : 'partial', reason: tail ? '已读完上界内完整记录；未提交尾行等待刷新' : '仅指定轮次获准内容；complete 表示快照读完，不代表任务或源结果完整',
          snapshotId: c.snapshotId, upperBoundBytes: c.upper, pendingTail: tail, items,
          ...(c.done ? { refreshCursor: encode(c) } : { nextCursor: encode(c) }) };
      } finally { await source.handle.close(); }
    });
  }
  async function messageContent(owner: AgentContentOwner, task: LocalAgentTask, req: AgentContentRequest): Promise<DetailPart> {
    const receipts = (task.messageReceipts ?? []).filter(r => r.runGeneration === req.runGeneration);
    const byId = new Map<string, { id: string; text: string; status: string; createdAt?: string }>();
    const receiptById = new Map(receipts.map(r => [r.messageId, r]));
    const accept = (value: unknown, fromTranscript = false) => {
      const m = record(value);
      if (!m || m.role !== 'user' || m.isMeta === true || typeof m.id !== 'string' || !Array.isArray(m.blocks)) return;
      const receipt = receiptById.get(m.id);
      const resume = fromTranscript && record(m.metadata)?.agentMessageKind === 'resume';
      if (!receipt && !resume) return;
      const body = m.blocks.map(record).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b!.text).join('\n');
      byId.set(m.id, { id: m.id, text: text(sanitize(owner, body)), status: receipt?.status ?? 'delivered', createdAt: receipt?.queuedAt ?? (typeof m.createdAt === 'string' ? m.createdAt : undefined) });
    };
    for (const message of [...task.messages, ...task.pendingMessages]) accept(message);
    // Receipt IDs identify parent messages; never return inherited user context.
    // Read the durable log too: delivered messages may have left the live context.
    let source: Awaited<ReturnType<typeof openChecked>> | undefined;
    try {
      source = await openChecked(owner, task.agentId, ['transcript.jsonl']);
      if (source.stat.size > REF_SCAN) fail('消息记录过大');
      for (let pos = 0; pos < source.stat.size;) {
        const line = await lineAt(source.handle, pos, source.stat.size);
        if (line.tail) break;
        pos = line.end;
        const entry = record(line.value);
        if (entry?.type === 'message' && entry.runGeneration === req.runGeneration && entry.agentId === task.agentId && entry.sessionId === task.agentId) accept(entry.message, true);
      }
      const end = await source.check();
      if (end.size < source.stat.size || (end.size === source.stat.size && (end.mtimeMs !== source.stat.mtimeMs || end.ctimeMs !== source.stat.ctimeMs))) fail('消息记录已改变');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally { await source?.handle.close(); }
    for (const receipt of receipts) if (!byId.has(receipt.messageId)) byId.set(receipt.messageId, { id: receipt.messageId, text: '', status: receipt.status, createdAt: receipt.queuedAt });
    return part(owner, [...byId.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')));
  }
  async function scalar(kind: 'delegation' | 'report' | 'messages', owner: AgentContentOwner, req: AgentContentRequest): Promise<AgentContentPage> {
    return guarded(owner, req, async (base, { task, binding, chars }) => {
      if (req.refresh) fail('委派/报告刷新请不带游标重新读取');
      const c = req.cursor ? decode(req.cursor, binding, kind) : fresh(kind, binding);
      let content: DetailPart; let metadata: AgentContentPage;
      if (kind === 'messages') {
        content = await messageContent(owner, task, req);
        metadata = { ...base, messages: { content: fragment(content, 0, 0) } };
      } else if (kind === 'delegation') {
        content = part(owner, task.prompt);
        metadata = { ...base, delegation: { scope: 'task', prompt: fragment(content, 0, 0), description: preview(part(owner, task.description)) } };
      } else {
        const matches = (task.runHistory ?? []).filter(r => r.runGeneration === req.runGeneration);
        if (matches.length > 1 || (task.runGeneration === req.runGeneration && matches.length)) fail('报告轮次身份不明确');
        const run = task.runGeneration === req.runGeneration ? task : matches[0];
        if (!run) throw new ReadFailure('指定旧轮报告未保留或已淘汰；不会回退当前报告', 'missing');
        if (run.result && run.result.agent_id !== task.agentId) fail('报告不属于该任务代理');
        const proven = run.result?.displaySource === 'agent_report' || run.result?.displaySource === 'visible_text';
        content = run.result && !proven
          ? { state: 'unavailable', text: '', reason: '报告公开来源未记录或无法证明；不会读取旧输出文件或推断其他轮次正文' }
          : typeof run.result?.content === 'string' ? part(owner, run.result.content) : absent('指定轮次尚无已保存报告');
        metadata = { ...base, report: { source: run === task ? 'task.result' : 'runHistory', taskStatus: ['pending', 'running', 'completed', 'failed', 'killed'].includes(run.status) ? run.status : 'unknown',
          reportStatus: run.result?.status === 'completed' || run.result?.status === 'incomplete' ? run.result.status : undefined,
          content: fragment(content, 0, 0), error: preview(part(owner, run.error), 4096) } };
      }
      const digest = hash(JSON.stringify([content, metadata]));
      if (req.cursor && c.digest !== digest) fail('委派/报告或脱敏策略已改变；请重新读取');
      c.digest = digest;
      const piece = fragment(content, c.offset, chars); c.offset += piece.text.length;
      if (metadata.delegation) metadata.delegation.prompt = piece;
      if (metadata.report) metadata.report.content = piece;
      if (metadata.messages) metadata.messages.content = piece;
      return { ...metadata, state: content.state === 'unavailable' ? 'unavailable' : content.state === 'missing' ? 'missing' : piece.hasMore ? 'partial' : 'complete', reason: content.reason, snapshotId: c.snapshotId, ...(piece.hasMore ? { nextCursor: encode(c) } : {}) };
    });
  }
  return { timeline, messages: (owner: AgentContentOwner, req: AgentContentRequest) => scalar('messages', owner, req), delegation: (owner: AgentContentOwner, req: AgentContentRequest) => scalar('delegation', owner, req), report: (owner: AgentContentOwner, req: AgentContentRequest) => scalar('report', owner, req) };
}
