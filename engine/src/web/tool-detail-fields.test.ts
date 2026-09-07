import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyToolDetailFields as classify, toolDetailFieldsFromDetail as adapt, type ToolDetailFields } from './tool-detail-fields.js';
import { redactToolDetail, type DetailPart, type ToolCallDetail } from './tool-call-detail.js';
const param = (f: ToolDetailFields, key: string) => f.keyParameters.find(p => p.key === key)!;
const part = (value: unknown, state: DetailPart['state'] = 'complete'): DetailPart => ({ text: JSON.stringify(value), state, reason: state });

test('explicit spec aliases only; unrelated/prototype names never guessed', () => {
  for (const [alias, canonical] of Object.entries({ read: 'file_read', list: 'file_list', write: 'file_write', edit: 'file_edit', grep: 'file_search', search: 'web_search' })) {
    assert.deepEqual(classify({ toolName: alias, input: {} }).keyParameters, classify({ toolName: canonical, input: {} }).keyParameters);
    assert.equal(classify({ toolName: alias }).canonicalName, canonical);
  }
  for (const toolName of ['constructor', '__proto__', 'TaskOutput', 'subagent_fake', 'file_read_more', 'image2']) {
    const f = classify({ toolName, input: { purpose: 'file_read offset 4', title: 'file_read', path: '/fake' } });
    assert.equal(f.category, 'other'); assert.deepEqual(f.keyParameters, []);
  }
});
test('purpose/subject independent; never derive parameters from metadata', () => {
  const f = classify({ toolName: 'read', purpose: 'read /intent offset 99', subject: '/summary', input: { description: 'other intention' } });
  assert.equal(f.purpose.value, 'other intention'); assert.equal(f.purpose.source, 'input'); assert.equal(f.subject.completeness, 'summary'); assert.equal(f.subject.value, '/summary');
  assert.equal(f.object.state, 'not-provided'); assert.equal(param(f, 'offset').state, 'unspecified');
  assert.equal(classify({ toolName: 'read', input: { purpose: '', description: 'not fallback' } }).purpose.value, '');
});
test('real absolute result path wins; raw input path retained; Windows/UNC/POSIX', () => {
  for (const path of ['C:\\work\\真实 文件.ts', '\\\\server\\share\\file', '/work/file']) {
    const f = classify({ toolName: 'file_read', input: { path: './file', offset: 0, limit: 0 }, output: { path } });
    assert.equal(f.actualPath.copyValue, path); assert.equal(f.object.value, path);
    assert.equal(param(f, 'path').value, './file'); assert.equal(param(f, 'offset').value, 0); assert.equal(param(f, 'limit').value, 0);
  }
  const f = classify({ toolName: 'read', input: { path: './real' }, output: { path: 'relative-result' } });
  assert.equal(f.actualPath.value, './real'); assert.equal(f.actualPath.copyValue, undefined);
});
test('edit/write preserve empty creation rule, multiline changes and false', () => {
  const input = Object.freeze({ path: '/file', oldString: '', newString: 'a\n  b\n', replaceAll: false });
  const f = classify({ toolName: 'edit', input });
  assert.equal(param(f, 'oldString').value, ''); assert.equal(param(f, 'newString').value, input.newString); assert.equal(param(f, 'replaceAll').value, false);
  assert.equal(param(classify({ toolName: 'write', input: { content: '' } }), 'content').state, 'provided');
});
test('missing source vs unspecified optional filters vs valid empty results', () => {
  assert.equal(param(classify({ toolName: 'search' }), 'provider').state, 'not-provided');
  const f = classify({ toolName: 'search', input: { query: 'q', includeDomains: [] }, output: { provider: 'exa', results: [] } });
  assert.equal(param(f, 'provider').state, 'unspecified'); assert.equal(f.actualProvider.value, 'exa'); assert.equal(f.result.empty, true);
  assert.deepEqual(param(f, 'includeDomains').value, []); assert.equal(param(f, 'excludeDomains').state, 'unspecified');
  const requestOnly = classify({ toolName: 'search', input: { provider: 'openai' } });
  assert.equal(requestOnly.actualProvider.state, 'not-provided'); assert.equal(requestOnly.result.empty, false);
  for (const output of [0, false]) assert.equal(classify({ toolName: 'search', output }).result.empty, false);
  for (const output of ['', [], null]) assert.equal(classify({ toolName: 'search', output }).result.empty, true);
});
test('search exact fields, real grepPath, requested vs actual provider', () => {
  const grep = classify({ toolName: 'grep', input: { query: 'a\nb', path: '.', glob: [], fixedStrings: false, caseMode: 'sensitive', contextLines: 0, maxResults: 0 }, output: { grepPath: 'C:\\repo', matches: [] } });
  assert.equal(grep.actualPath.copyValue, 'C:\\repo'); assert.equal(grep.object.value, 'a\nb'); assert.equal(grep.result.empty, true);
  for (const key of ['contextLines', 'maxResults']) assert.equal(param(grep, key).value, 0);
  const input = { query: 'q', provider: 'openai', startPublishedDate: '2026-01-01', endPublishedDate: '2026-09-07', includeDomains: ['example.org'], excludeDomains: [] };
  const f = classify({ toolName: 'web_search', input, output: { provider: 'exa', results: [] } });
  for (const [key, value] of Object.entries(input)) assert.deepEqual(param(f, key).value, value);
  assert.equal(f.actualProvider.source, 'result'); assert.equal(f.actualProvider.value, 'exa');
});
test('subagent real task identity, target, prompt, directive and controls; no status inference', () => {
  const f = classify({ toolName: 'subagent_message', input: { target: 'worker', message: 'line1\nline2' }, output: { task_id: 'actual-id', agent_id: 'agent', run_generation: 0, status: 'queued' } });
  assert.equal(f.object.value, 'actual-id'); assert.equal(param(f, 'target').value, 'worker'); assert.equal(param(f, 'message').value, 'line1\nline2'); assert.equal(param(f, 'run_generation').value, 0);
  assert.equal(f.keyParameters.some(p => p.key === 'status'), false);
  const prompt = 'delegation\n'.repeat(3000);
  assert.equal(param(classify({ toolName: 'subagent_run', input: { prompt, parallel: false } }), 'prompt').value, prompt);
  assert.equal(param(classify({ toolName: 'subagent_resume', input: { task_id: 'id', directive: '' } }), 'directive').value, '');
  const out = classify({ toolName: 'subagent_output', input: { task_id: 'id', block: false, timeout_ms: 0 } });
  assert.equal(param(out, 'block').value, false); assert.equal(param(out, 'timeout_ms').value, 0);
  assert.equal(param(classify({ toolName: 'subagent_get', output: { prompt } }), 'prompt').source, 'result');
});
test('OBS01 structural contract, redacted fields, completeness and reasons preserved', () => {
  const detail: ToolCallDetail = { sessionId: 's', toolUseId: 't', toolName: 'edit', input: part(redactToolDetail({ path: '/file', oldString: '', newString: 'Bearer secret-value' })), result: part({ path: '/file' }), error: part('') };
  const before = JSON.stringify(detail); const f = adapt(detail);
  assert.equal(JSON.stringify(detail), before); assert.equal(f.actualPath.copyValue, '/file');
  assert.equal(String(param(f, 'newString').value).includes('secret-value'), false); assert.equal(f.input.reason, 'complete');
  const truncated = adapt({ ...detail, input: part({ path: '/preview' }, 'truncated'), result: part({}, 'missing') });
  assert.equal(truncated.actualPath.value, '/preview'); assert.equal(truncated.actualPath.copyValue, undefined);
  assert.equal(param(truncated, 'replaceAll').state, 'not-provided'); assert.equal(truncated.input.completeness, 'truncated');
  for (const state of ['missing', 'unavailable'] as const) {
    const f = adapt({ ...detail, input: part({ path: '/hidden' }, state), result: part({ path: '/hidden' }, state) });
    assert.equal(f.actualPath.state, 'not-provided'); assert.equal(f.result.empty, false);
  }
});
test('malformed JSON and plain/XML text cannot supply fields or task IDs', () => {
  for (const text of ['{"path":"/file",', 'path: /file offset: 4', '<task_id>id</task_id>']) {
    const f = adapt({ toolName: 'file_read', input: { state: 'truncated', text, reason: 'budget' }, result: { state: 'complete', text, reason: 'saved text' } });
    assert.equal(f.actualPath.state, 'not-provided'); assert.equal(f.input.structured, false); assert.equal(f.input.reason, 'budget');
  }
});
