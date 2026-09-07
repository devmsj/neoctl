import { InMemorySecretRedactionRegistry } from '../secrets/secret-redaction.js';
import { runToolUseToMessages } from '../tools/run-tool-use.js';
import { ToolRegistry } from '../tools/registry.js';
import { InMemoryAppState } from '../app/app-state.js';
import { readFileTool } from '../tools/builtins/filesystem-tools.js';
import { editTool } from '../tools/builtins/edit-tool.js';
import { createSubagentTools } from '../tasks/subagent-tools.js';
import { TaskStore } from '../tasks/task-store.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readToolCallDetail, redactToolDetail, allowToolDetailRequest } from './tool-call-detail.js';
import { SessionStore } from '../session/session-store.js';
import { FileToolResultMemory } from '../session/tool-result-memory.js';
import { createToolResultMessage, type Message } from '../types/messages.js';
import { restoreWebHistoryLines, WebRepl } from './index.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs01-'));
let checks = 0;
const check = (v: unknown) => { assert.ok(v); checks++; };
try {
 const request = { id: 'call-one', name: 'file_read', input: { path: 'missing.txt', offset: 0, token: 'INPUT_SECRET' } };
 const use: Message = { id: 'use-message', role: 'assistant', createdAt: '', blocks: [{ type: 'tool_use', ...request }] };
 const entry = (message: Message) => ({ type: 'message', message });
 const options = { sessionId: 's1', expectedSessionId: 's1', sessionDir: dir, toolUseId: request.id };
 for (const error of ['ENOENT: missing.txt', 'oldString not found', 'input.path must be string', 'Unknown agent target: nobody']) {
   const result = createToolResultMessage(request, false, { error });
   const entries = [entry(use), entry(result)];
   const detail = await readToolCallDetail({ ...options, entries });
   check(detail?.error.text === error);
   check(detail?.input.text.includes('missing.txt') && !detail?.input.text.includes('INPUT_SECRET'));
   const lines = restoreWebHistoryLines({ engine: { getDisplayEntries: () => entries } } as never);
   check(lines.some(line => line.kind === 'error' && line.toolUseId === request.id && line.toolError === error));
 }
 const tools = new ToolRegistry(); tools.register(readFileTool); tools.register(editTool);
 for (const tool of createSubagentTools(new TaskStore())) tools.register(tool);
 await fs.writeFile(path.join(dir, 'edit.txt'), 'unchanged');
 const context = { emit: () => {}, agentId: 'test', tools, appState: new InMemoryAppState('test', dir), session: {sessionId:'s1',sessionDir:dir} };
 for (const actual of [
   {id:'real-read',name:'file_read',input:{path:path.join(dir,'absent.txt')}},
   {id:'real-edit',name:'file_edit',input:{path:path.join(dir,'edit.txt'),oldString:'NOT_FOUND',newString:'new'}},
   {id:'real-schema',name:'file_read',input:{path:123}},
   {id:'real-agent',name:'subagent_message',input:{target:'nonexistent',message:'hello'}}
 ]) {
   const messages = await runToolUseToMessages(actual, context);
   const actualUse: Message = {...use, id:actual.id+'-input', blocks:[{type:'tool_use',...actual}]};
   const detail = await readToolCallDetail({...options,toolUseId:actual.id,entries:[entry(actualUse),...messages.map(entry)]});
   check(detail?.ok === false && !!detail.error.text && detail.error.text !== '未提供错误原因');
   console.log(actual.name + ' actual failure: ' + detail?.error.text);
 }
 const registry = new InMemorySecretRedactionRegistry(); registry.record('runtime-secret','REGISTERED_NOT_IN_ENV');
 const registryResult = await readToolCallDetail({...options,redact:value=>registry.redact(value),entries:[entry(use),entry(createToolResultMessage(request,true,{content:'REGISTERED_NOT_IN_ENV',lastText:'HIDDEN_CAMEL'}))]});
 check(!JSON.stringify(registryResult).includes('REGISTERED_NOT_IN_ENV') && !JSON.stringify(registryResult).includes('HIDDEN_CAMEL'));
 const fake = { runtime: { engine: { snapshot:()=>({session:{sessionId:'s1'}}), redactDisplayValue:<T>(v:T)=>registry.redact(v), isFastMode:()=>false, getAppPrompt:()=>({}) } },
 lines:[{id:1,toolError:'REGISTERED_NOT_IN_ENV'}], backgroundTasks:()=>[], terminalTaskHistory:()=>[], backgroundSessionRuns:new Map(), pendingDeltaOperations:[], scheduleDeltaFlush:()=>{} };
 // Snapshot also needs the existing task-store projection contract.
 Object.assign(fake.runtime,{taskStore:{list:()=>[]}});
 const projected = WebRepl.prototype.snapshot.call(fake as never);
 check(projected.lines[0].toolError === '[secret:runtime-secret]');
 const queue = (WebRepl.prototype as unknown as {queueDeltaOperation:(op:unknown)=>void}).queueDeltaOperation;
 queue.call(fake,{type:'line.append',line:{id:2,toolError:'REGISTERED_NOT_IN_ENV'}});
 queue.call(fake,{type:'line.patch',id:2,patch:{toolError:'REGISTERED_NOT_IN_ENV'}});
 check(!JSON.stringify(fake.pendingDeltaOperations).includes('REGISTERED_NOT_IN_ENV'));

 const memory = new FileToolResultMemory({ sessionDir: dir, thresholdChars: 100 });
 const full = { arbitrary: 'REGISTERED_NOT_IN_ENV', content: 'FULL_START\n' + 'x'.repeat(9000) + '\nFULL_END', password: 'OUTPUT_SECRET' };
 const processed = await memory.processToolResult(request.id, full);
 const result = createToolResultMessage(request, true, processed.output);
 const entries = [entry(use), entry(result)];
 const detail = await readToolCallDetail({ ...options, entries });
 const store = await SessionStore.open({agentId:'test',rootDir:dir,sessionId:'persisted'});
 for (const item of entries) store.recordMessage(item.message);
 const restored = await SessionStore.open({agentId:'test',rootDir:dir,sessionId:'persisted',resume:true});
 check((await readToolCallDetail({...options,entries:restored.getDisplayEntries()}))?.result.text === detail?.result.text);
 check(detail?.result.state === 'complete' && detail.result.text.includes('FULL_END'));
 check(!JSON.stringify(detail).includes('OUTPUT_SECRET'));
 check(!JSON.stringify(await readToolCallDetail({...options,entries,redact:value=>registry.redact(value)})).includes('REGISTERED_NOT_IN_ENV'));
 check((await readToolCallDetail({ ...options, entries: JSON.parse(JSON.stringify(entries)) }))?.result.text === detail?.result.text);
 check(await readToolCallDetail({ ...options, entries, expectedSessionId: 'other' }) === undefined);
 check(await readToolCallDetail({ ...options, entries, toolUseId: 'other' }) === undefined);
 check(await readToolCallDetail({ ...options, entries, messageId: 'other' }) === undefined);
 check(await readToolCallDetail({ ...options, entries: [...entries, entry(use)] }) === undefined);
 await fs.rm(path.join(dir, 'tool-results'), { recursive: true });
 check((await readToolCallDetail({ ...options, entries }))?.result.state === 'unavailable');
 const malicious = createToolResultMessage(request, true, '<persisted-output>\nFull output saved to: ' + path.join(dir, '../private.txt') + '\n');
 check((await readToolCallDetail({ ...options, entries: [entry(use), entry(malicious)] }))?.result.state === 'unavailable');
 for (const output of [0, false, [], '', null]) check((await readToolCallDetail({ ...options, entries: [entry(createToolResultMessage(request, true, output))] }))?.result.state === 'complete');
 check((await readToolCallDetail({ ...options, entries: [entry(createToolResultMessage(request, true, { truncated: true, content: 'preview' }))] }))?.result.state === 'truncated');
 check((await readToolCallDetail({ ...options, entries: [entry(result)] }))?.input.state === 'missing');
 check(!allowToolDetailRequest('https://evil.example', 'localhost:123', 'cross-site'));
 check(allowToolDetailRequest('http://localhost:123', 'localhost:123', 'same-origin'));
 const redacted = JSON.stringify(redactToolDetail({ config: { a: 'PRIVATE_CONFIG' }, thinking: 'HIDDEN', nested: { apiKey: 'KEY' }, error: 'Authorization: Bearer abc123 password=abcd sk-very-secret-key' }));
 for (const secret of ['PRIVATE_CONFIG', 'HIDDEN', 'abc123', 'abcd', 'sk-very-secret-key']) check(!redacted.includes(secret));
 check(await readToolCallDetail({...options, entries:[entry({...use,blocks:[{type:'tool_use',...request,name:'secret_get'}]})]}) === undefined);
 console.log(`OBS-01 service smoke passed: ${checks} assertions`);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
