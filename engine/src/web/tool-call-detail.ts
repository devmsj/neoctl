import fs from 'node:fs/promises';
import path from 'node:path';
import { subagentHeader } from './status-semantics.js';
import type { Message, MessageBlock } from '../types/messages.js';

export interface DetailPart { state: 'complete' | 'truncated' | 'missing' | 'unavailable'; text: string; reason: string }
export interface ToolCallDetail { sessionId: string; toolUseId: string; messageId?: string; toolName: string; ok?: boolean; input: DetailPart; result: DetailPart; error: DetailPart }
const privateKey = /api[_-]?key|token|password|secret|authorization|cookie|credential|private[_-]?key|env|config|system[_-]?(prompt|message)|reasoning|thinking|last[_-]?text|hidden|analysis|context|messages|transcript/i;
/** Boundary for user-facing tool data, never entire model messages. */
export function redactToolDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactToolDetail);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateKey.test(key) ? '[已脱敏]' : redactToolDetail(item)]));
  if (typeof value !== 'string') return value;
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(redactToolDetail(parsed), null, 2); } catch { /* plain output */ }
  let text = value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[已脱敏]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已脱敏]')
    .replace(/\bsk-[\w-]+/g, '[已脱敏]')
    .replace(/((?:[\w-]*(?:token|password|secret|api[_-]?key|authorization|cookie)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[已脱敏]')
    .replace(/(<(?:thinking|analysis|system)>)[\s\S]*?<\/(?:thinking|analysis|system)>/gi, '[已脱敏]');
  for (const [key, secret] of Object.entries(process.env)) if (privateKey.test(key) && secret && secret.length >= 4) text = text.split(secret).join('[已脱敏]');
  return text;
}
// Exact registered agent tools only: unrelated tools may legitimately return arbitrary text.
const agentPayloadTools = new Set(['subagent_run', 'subagent_get', 'subagent_output', 'subagent_list', 'subagent_resume', 'subagent_stop', 'subagent_message']);
const agentControlTools = new Set(['subagent_message', 'subagent_stop', 'subagent_resume']);
const reportUnavailable = '报告正文不可获取：缺少获准展示来源（displaySource）；请使用任务/轮次报告入口';
/** Source authorization, BEFORE registry redaction, serialization or preview slicing.
 * Provenance authorizes only the same result object's content, never sibling/history prose.
 * This is not a secret redactor; callers must retain their existing redaction boundary.
 */
export function sanitizeAgentToolPayload(name: string, output: unknown): { value: unknown; unavailable?: string } {
  if (!agentPayloadTools.has(name) || output === undefined || output === null) return { value: output };
  let withheld = false;
  const unavailable = () => { withheld = true; return `[unavailable: ${reportUnavailable}]`; };
  function body(value: unknown, depth: number): unknown {
    if (value === undefined || value === null) return value;
    if (depth > 40) return unavailable();
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object') return visit(parsed, depth + 1);
      } catch { /* unproven plain/XML prose is not a report */ }
      const header = subagentHeader(value);
      return { ...header, content: unavailable() };
    }
    if (typeof value === 'object') return visit(value, depth + 1);
    return unavailable();
  }
  function visit(value: unknown, depth: number, root = false): unknown {
    if (depth > 40) return unavailable();
    if (Array.isArray(value)) return value.map(item => body(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const data = value as Record<string, unknown>;
    const proven = data.displaySource === 'agent_report' || data.displaySource === 'visible_text';
    return Object.fromEntries(Object.entries(data).map(([key, item]) => {
      if (key === 'content') return [key, proven && typeof item === 'string' ? item : item == null ? item : unavailable()];
      if (/^(last_?text|text|message|error)$/i.test(key)) {
        // Top-level structured errors are tool diagnostics; nested result/error may be legacy report prose.
        return [key, root && (key === 'error' || (agentControlTools.has(name) && key === 'message')) ? item : item == null ? item : unavailable()];
      }
      if (/^(result|output|report)$/i.test(key)) return [key, body(item, depth + 1)];
      if (item && typeof item === 'object') return [key, visit(item, depth + 1)];
      return [key, item]; // IDs/status/delivery metadata and user delegation prompt/description.
    }));
  }
  let value: unknown;
  if (typeof output === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { /* legacy XML/plain output */ }
    value = parsed && typeof parsed === 'object'
      ? visit(parsed, 0, true)
      : agentControlTools.has(name) ? output : body(output, 0);
  } else value = visit(output, 0, true);
  return { value, ...(withheld ? { unavailable: reportUnavailable } : {}) };
}
const serialize = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
const missing = (reason: string): DetailPart => ({ state: 'missing', text: '', reason });
function sourceTruncated(value: unknown): boolean {
  if (typeof value === 'string') {
    if (/<persisted-output>|\[Tool result truncated|\[Old tool result content cleared\]/.test(value)) return true;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? sourceTruncated(parsed) : false; } catch { return false; }
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (/truncated|hasMore|has_more/.test(key) && item === true) || (key === 'omitted_chars' && item && typeof item === 'object' && Object.values(item).some(n => typeof n === 'number' && n > 0)) || (typeof item === 'object' && sourceTruncated(item)));
}
function part(value: unknown): DetailPart {
  if (value === undefined) return missing('未提供');
  const truncated = sourceTruncated(value);
  return { state: truncated ? 'truncated' : 'complete', text: serialize(redactToolDetail(value)), reason: truncated ? '数据源已截断；当前为预览，不是完整结果' : '已保存数据的脱敏全文' };
}
export function toolErrorText(output: unknown, ok: boolean): string {
  if (ok) return '';
  const data = output && typeof output === 'object' ? output as Record<string, unknown> : undefined;
  const error = data?.error ?? data?.message ?? (typeof output === 'string' ? output : undefined);
  return error === undefined ? '未提供错误原因' : serialize(redactToolDetail(error));
}
export function allowToolDetailRequest(origin: string | undefined, host: string | undefined, fetchSite: string | undefined): boolean {
  if (fetchSite === 'cross-site') return false;
  if (!origin) return true; // local desktop / non-browser clients share the existing local-user trust boundary
  try { return new URL(origin).host === host; } catch { return false; }
}
export async function readToolCallDetail(options: { sessionId: string; expectedSessionId: string; sessionDir?: string; toolUseId: string; messageId?: string; redact?: (value: unknown) => unknown; entries: readonly { type: string; message?: Message }[] }): Promise<ToolCallDetail | undefined> {
  if (!options.sessionId || options.expectedSessionId !== options.sessionId || !options.toolUseId) return undefined;
  const blocks = options.entries.flatMap(entry => entry.type === 'message' && entry.message && ['assistant', 'tool_result'].includes(entry.message.role) ? entry.message.blocks.map(block => ({ block, messageId: entry.message!.id })) : []);
  const uses = blocks.filter(item => item.block.type === 'tool_use' && item.block.id === options.toolUseId);
  const results = blocks.filter(item => item.block.type === 'tool_result' && item.block.toolUseId === options.toolUseId && (!options.messageId || item.messageId === options.messageId));
  if (uses.length > 1 || results.length > 1 || (!uses.length && !results.length) || (options.messageId && !results.length)) return undefined;
  const use = uses[0]?.block as Extract<MessageBlock, { type: 'tool_use' }> | undefined;
  const result = results[0]?.block as Extract<MessageBlock, { type: 'tool_result' }> | undefined;
  if (use && result && use.name !== result.name) return undefined;
  const name = result?.name ?? use!.name;
  // Secret/config tools are not part of the public ordinary-call payload contract.
  if (/^(secret_|.*config)/i.test(name)) return undefined;
  let output = result?.output;
  let unavailable = '';
  if (typeof output === 'string' && output.startsWith('<persisted-output>')) {
    try {
      if (!options.sessionDir) throw new Error('no session storage');
      const safeId = options.toolUseId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'tool-result';
      const collisions = blocks.some(({ block }) => block.type === 'tool_result' && block.toolUseId !== options.toolUseId && block.toolUseId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) === safeId);
      if (collisions) throw new Error('ambiguous storage identity');
      const ref = /Full output saved to: (.+)\r?\n/.exec(output)?.[1]?.trim();
      const dir = path.join(options.sessionDir, 'tool-results');
      if (!ref || !['json', 'txt'].some(ext => path.resolve(ref) === path.resolve(dir, `${safeId}.${ext}`))) throw new Error('invalid stored reference');
      const [realDir, realFile, stat] = await Promise.all([fs.realpath(dir), fs.realpath(ref), fs.lstat(ref)]);
      if (stat.isSymbolicLink() || path.dirname(realFile) !== realDir || realDir !== path.join(await fs.realpath(options.sessionDir), 'tool-results')) throw new Error('invalid storage path');
      const stored = await fs.readFile(realFile, 'utf8');
      output = ref.endsWith('.json') ? JSON.parse(stored) : stored;
    } catch { unavailable = '完整结果不可获取：存储已清理、引用无效或不可访问；以下仅为保存的预览'; }
  }
  const redact = options.redact ?? ((value: unknown) => value);
  const authorized = sanitizeAgentToolPayload(name, output);
  output = redact(authorized.value);
  unavailable ||= authorized.unavailable ?? '';
  return { sessionId: options.sessionId, toolUseId: options.toolUseId, messageId: results[0]?.messageId, toolName: name, ok: result?.ok,
    input: part(redact(use?.input)), result: unavailable ? { ...part(output), state: 'unavailable', reason: unavailable } : part(output),
    error: result?.ok === false ? { ...part(toolErrorText(output, false)), ...(unavailable ? { state: 'unavailable' as const, reason: unavailable } : {}) } : missing(result ? '不适用' : '结果尚未提供') };
}
