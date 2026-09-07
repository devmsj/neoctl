import type { DetailPart, ToolCallDetail } from './tool-call-detail.js';

/** OBS06 detail contract. Pure projection, NOT an authorization/redaction boundary.
 * Call only after OBS01 authorization + redaction. Never pass raw messages/context.
 * No IO, defaults from runtime configuration, status inference or summary parsing.
 */
export type FieldState = 'provided' | 'not-provided' | 'unspecified' | 'not-applicable';
export interface DetailField {
  key: string;
  state: FieldState;
  value?: unknown;
  source?: 'input' | 'result' | 'display';
  sourceKey?: string;
  completeness?: DetailPart['state'] | 'summary';
}
export type FieldCategory = 'file-read' | 'file-list' | 'file-change' | 'file-search' | 'web-search' | 'subagent' | 'other';
export interface SanitizedToolFieldsSource {
  toolName: string;
  input?: unknown;
  output?: unknown;
  /** Actual saved display metadata only; never used to infer objects/parameters. */
  purpose?: unknown;
  subject?: unknown;
  inputCompleteness?: DetailPart['state'];
  outputCompleteness?: DetailPart['state'];
}
export interface ToolDetailFields {
  toolName: string;
  canonicalName: string;
  category: FieldCategory;
  purpose: DetailField;
  subject: DetailField;
  object: DetailField;
  keyParameters: DetailField[];
  actualPath: DetailField & { isAbsolute: boolean; copyValue?: string };
  actualProvider: DetailField;
  input: { completeness: DetailPart['state']; structured: boolean; reason: string };
  result: { completeness: DetailPart['state']; empty: boolean; reason: string };
}

// Specification's explicit locating aliases; no prefix stripping, fuzzy/title matching
// or invented legacy Task*/Agent names. Runtime-resolved identities should be passed in.
const aliases: Readonly<Record<string, string>> = {
  read: 'file_read', list: 'file_list', write: 'file_write', edit: 'file_edit',
  grep: 'file_search', search: 'web_search',
};
const specs: Readonly<Record<string, { category: FieldCategory; object: string; required?: string[]; optional: string[] }>> = {
  file_read: { category: 'file-read', object: 'path', required: ['path'], optional: ['offset', 'limit'] },
  file_list: { category: 'file-list', object: 'path', optional: ['path', 'recursive', 'includeHidden', 'maxEntries', 'maxDepth', 'exclude'] },
  file_write: { category: 'file-change', object: 'path', required: ['path', 'content'], optional: [] },
  file_edit: { category: 'file-change', object: 'path', required: ['path', 'oldString', 'newString'], optional: ['replaceAll'] },
  file_search: { category: 'file-search', object: 'query', required: ['query'], optional: ['path', 'glob', 'caseMode', 'fixedStrings', 'includeHidden', 'contextLines', 'maxResults', 'maxColumns'] },
  web_search: { category: 'web-search', object: 'query', required: ['query'], optional: ['provider', 'numResults', 'includeDomains', 'excludeDomains', 'startPublishedDate', 'endPublishedDate'] },
  subagent_run: { category: 'subagent', object: 'task_id', required: ['prompt'], optional: ['description', 'subagent_type', 'model', 'run_in_background', 'name', 'team_name', 'mode', 'isolation', 'cwd', 'parallel'] },
  subagent_get: { category: 'subagent', object: 'task_id', required: ['task_id'], optional: ['detail'] },
  subagent_output: { category: 'subagent', object: 'task_id', required: ['task_id'], optional: ['block', 'timeout_ms'] },
  subagent_stop: { category: 'subagent', object: 'task_id', required: ['task_id'], optional: [] },
  subagent_message: { category: 'subagent', object: 'task_id', required: ['target', 'message'], optional: [] },
  subagent_resume: { category: 'subagent', object: 'task_id', required: ['task_id'], optional: ['directive'] },
  subagent_list: { category: 'subagent', object: '', optional: [] },
  subagent_report: { category: 'subagent', object: '', required: ['content'], optional: ['status'] },
};
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
// Host independent: do not resolve a historical relative path against current cwd.
const absolute = (value: unknown): value is string => typeof value === 'string' && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
const empty = (value: unknown): boolean => value === '' || value === null || (Array.isArray(value) && value.length === 0) || (!!record(value) && Object.keys(value as object).length === 0);
const absent = (key: string, state: FieldState = 'not-provided'): DetailField => ({ key, state });

/** Direct sanitized JSON values; undefined means not recorded, null is explicit data. */
export function classifyToolDetailFields(source: SanitizedToolFieldsSource): ToolDetailFields {
  const canonicalName = own(aliases, source.toolName) ? aliases[source.toolName]! : source.toolName;
  const spec = own(specs, canonicalName) ? specs[canonicalName] : undefined;
  const inputState = source.inputCompleteness ?? (source.input === undefined ? 'missing' : 'complete');
  const outputState = source.outputCompleteness ?? (source.output === undefined ? 'missing' : 'complete');
  const input = inputState === 'missing' || inputState === 'unavailable' ? undefined : record(source.input);
  const output = outputState === 'missing' || outputState === 'unavailable' ? undefined : record(source.output);
  function field(key: string, side: 'input' | 'result', sourceKey = key, optional = false): DetailField {
    const data = side === 'input' ? input : output;
    const completeness = side === 'input' ? inputState : outputState;
    if (data && own(data, sourceKey) && data[sourceKey] !== undefined) return { key, state: 'provided', value: data[sourceKey], source: side, sourceKey, completeness };
    return absent(key, optional && !!data && completeness === 'complete' ? 'unspecified' : 'not-provided');
  }
  function metadata(key: 'purpose' | 'subject'): DetailField {
    const value = field(key, 'input');
    if (value.state === 'provided') return value;
    const description = key === 'purpose' ? field(key, 'input', 'description') : value;
    if (description.state === 'provided') return description;
    if (own(source, key) && source[key] !== undefined) return { key, state: 'provided', value: source[key], source: 'display', sourceKey: key, completeness: 'summary' };
    return value;
  }
  const file = spec?.category.startsWith('file-') === true;
  let actualPath = absent('actualPath', file ? 'not-provided' : 'not-applicable');
  if (file) {
    const returned = field('actualPath', 'result', canonicalName === 'file_search' ? 'grepPath' : 'path');
    actualPath = returned.state === 'provided' && absolute(returned.value) ? returned : field('actualPath', 'input', 'path', !(spec?.required ?? []).includes('path'));
  }
  let object = spec?.object ? field('object', 'input', spec.object) : absent('object', spec ? 'not-applicable' : 'not-provided');
  if (file && spec?.object === 'path') object = { ...actualPath, key: 'object' };
  if (spec?.category === 'subagent' && spec.object) {
    const returnedId = field('object', 'result', 'task_id');
    object = returnedId.state === 'provided' ? returnedId : field('object', 'input', 'task_id');
    if (object.state !== 'provided' && canonicalName === 'subagent_message') object = field('object', 'input', 'target');
  }
  const keyParameters = spec ? [
    ...(spec.required ?? []).map(key => field(key, 'input')),
    ...spec.optional.map(key => field(key, 'input', key, true)),
    field('maxResultChars', 'input', 'maxResultChars', true),
  ] : [];
  if (spec?.category === 'subagent') {
    // Output identity is not a requested alias; never infer task/round from purpose.
    for (const key of ['task_id', 'agent_id', 'run_generation', 'prompt']) {
      const returned = field(key, 'result');
      if (returned.state === 'provided') keyParameters.push(returned);
    }
  }
  const resultValue = record(source.output);
  const emptyResult = outputState === 'complete' && source.output !== undefined && (empty(source.output)
    || (canonicalName === 'web_search' && !!resultValue && own(resultValue, 'results') && empty(resultValue.results))
    || (canonicalName === 'file_search' && !!resultValue && own(resultValue, 'matches') && empty(resultValue.matches)));
  return {
    toolName: source.toolName, canonicalName, category: spec?.category ?? 'other',
    purpose: metadata('purpose'), subject: metadata('subject'), object, keyParameters,
    actualPath: { ...actualPath, isAbsolute: absolute(actualPath.value), ...(absolute(actualPath.value) && actualPath.completeness === 'complete' ? { copyValue: actualPath.value } : {}) },
    actualProvider: canonicalName === 'web_search' ? field('actualProvider', 'result', 'provider') : absent('actualProvider', 'not-applicable'),
    input: { completeness: inputState, structured: !!input, reason: '' },
    result: { completeness: outputState, empty: emptyResult, reason: '' },
  };
}

/** OBS01 adapter. Parse JSON only, never recover fields from text previews/regex.
 * Truncated valid JSON may expose explicitly present values with truncated provenance;
 * malformed JSON exposes none. Missing/unavailable parts cannot provide facts.
 */
export function toolDetailFieldsFromDetail(
  detail: Pick<ToolCallDetail, 'toolName' | 'input' | 'result'>,
  display: { purpose?: unknown; subject?: unknown } = {},
): ToolDetailFields {
  function parse(part: DetailPart): unknown {
    if (part.state === 'missing' || part.state === 'unavailable') return undefined;
    try { return JSON.parse(part.text); } catch { return part.text; }
  }
  const fields = classifyToolDetailFields({ ...display, toolName: detail.toolName,
    input: parse(detail.input), output: parse(detail.result),
    inputCompleteness: detail.input.state, outputCompleteness: detail.result.state,
  });
  fields.input.reason = detail.input.reason;
  fields.result.reason = detail.result.reason;
  return fields;
}
