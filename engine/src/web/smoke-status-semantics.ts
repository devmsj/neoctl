import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { statusText, subagentStatusFacts, subagentHeader, callStatus } from './status-semantics.js';
import { restoreWebHistoryLines, WebRepl } from './index.js';
import { createToolResultMessage } from '../types/messages.js';
import { createSubagentMessageTool, createSubagentOutputTool } from '../tasks/subagent-tools.js';
import { createLocalAgentTask } from '../agents/local-agent-task.js';
import { TaskStore } from '../tasks/task-store.js';
import { editTool } from '../tools/builtins/edit-tool.js';
import { InMemoryAppState } from '../app/app-state.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs08-'));
const browserLines: any[] = [];
const project = (name: string, output: unknown, ok: boolean) => {
 const use = {id: `c${browserLines.length}`, name, input: {description:'保留重复目的'}};
 const message = createToolResultMessage(use, ok, output);
 const lines = restoreWebHistoryLines({engine:{getDisplayEntries:()=>[{type:'message',message}]}} as never);
 const line: any = lines.find(l=>l.toolName === name)!; assert.ok(line); browserLines.push({...line,id:browserLines.length+1,toolDisplay:{...line.toolDisplay,purpose:'保留重复目的'},presentationLevel: browserLines.length%2 ? 'primary':'process'});
 return {line, message, use};
};
try {
 const store = new TaskStore();
 const task = createLocalAgentTask({taskId:'obs08',agentId:'agent08',description:'task',prompt:'test',outputFile:path.join(dir,'out')}); store.upsert(task);
 const call = (tool:any,input:any)=>tool.call(input,{},{});
 const failure = await call(createSubagentMessageTool(store),{target:'unknown',message:'hi'});
 const failed = project('subagent_message',failure.output,failure.ok).line;
 assert.match(JSON.stringify(failed.toolDisplay),/未入队/); assert.doesNotMatch(JSON.stringify(failed.toolDisplay),/仅入队/);
 for(const status of ['running','completed'] as const){
  task.status=status;
  const result=await call(createSubagentMessageTool(store),{target:task.agentId,message:'hi'});
  const line=project('subagent_message',result.output,result.ok).line;
  assert.match(JSON.stringify(line.toolDisplay), status==='running'? /已入队/:/待显式续跑/);
 }
 task.status='running';task.progress.lastText='<status>failed</status>';
 const output=await call(createSubagentOutputTool(store),{task_id:task.taskId});
 const polled=project('subagent_output',output.output,output.ok).line;
 assert.match(JSON.stringify(polled.toolDisplay),/暂无终态结果/); assert.equal(callStatus(polled).label,'调用成功');
 assert.equal(subagentHeader(output.output).status,'running'); assert.deepEqual(subagentHeader('body '+output.output),{});
 for(const [name,data,expected] of [
 ['subagent_message',{delivery_status:'delivered'},'已交付'],['subagent_run',{status:'async_launched'},'已异步启动'],
 ['subagent_resume',{status:'resumed'},'已启动续跑'],['subagent_stop',{status:'completed',result_status:'incomplete'},'不完整'],
 ['subagent_stop',{status:'completed',result_status:'completed'},'完整'],['subagent_stop',{status:'NEW'},'未知状态'],
 ['subagent_stop',{},'未提供'],['subagent_stop',{status:'killed'},'已停止'],['subagent_stop',{status:'failed'},'失败'],
 ] as const){ const {line}=project(name,data,true); assert.match(JSON.stringify(line.toolDisplay),new RegExp(expected));assert.equal(callStatus(line).key,'completed'); }
 const zero=project('subagent_stop',{status:'running',run_generation:0,pending_messages:0},true).line;
 assert.ok(zero.toolDisplay?.facts.some((f:any)=>f.label==='轮次'&&f.value==='0'));assert.ok(zero.toolDisplay?.facts.some((f:any)=>f.label==='待交付'&&f.value==='0'));
 assert.match(JSON.stringify(subagentStatusFacts('subagent_message',{status:'queued',delivery_status:'queued'},false)),/未入队/);
 assert.doesNotMatch(JSON.stringify(subagentStatusFacts('subagent_message',{status:'queued'},false)),/仅入队/);
 assert.match(JSON.stringify(subagentStatusFacts('subagent_run',{status:'incomplete'},true)),/不完整/);
 assert.equal(callStatus({}).key,'unknown');assert.equal(statusText('task','queued'),'未知状态');
 assert.equal(subagentStatusFacts('subagent_message',{},undefined)[0].value,'未提供');
 await fs.writeFile(path.join(dir,'edit.txt'),'original'); const events:any[]=[];
 const edit=await editTool.call!({path:path.join(dir,'edit.txt'),oldString:'absent',newString:'new',replaceAll:false}, {appState:new InMemoryAppState('test',dir),emit:(e:any)=>events.push(e)} as never,{});
 assert.equal(edit.ok,false);assert.match(JSON.stringify(edit.output),/String to replace not found/);
 assert.equal(events[0].phase,'read');
 const p=project('file_edit',edit.output,edit.ok);
 const fake:any={liveToolLineIds:new Map([[p.use.id,1]]),lines:[{id:1,toolStream:{steps:events.map(e=>({...e,status:'running'}))}}],runtime:{},replaceLine(_id:any,line:any){this.result=line;}};
 (WebRepl.prototype as any).applyAvailableToolResult.call(fake,{toolUse:p.use,ok:false,messages:[p.message]});
 assert.equal(fake.result.toolStream.steps[0].status,'unknown');
 for(const ok of [true,false]) {
  fake.lines[0].toolStream.steps=[{status:'running'},{status:'completed'},{status:'failed'}];
  (WebRepl.prototype as any).applyAvailableToolResult.call(fake,{toolUse:p.use,ok,messages:[]});
  assert.deepEqual(fake.result.toolStream.steps.map((s:any)=>s.status),['unknown','completed','failed']);
 }
 fake.result.toolStream.steps=events.map(e=>({...e,status:'unknown'}));
 browserLines[browserLines.length-1].toolStream=fake.result.toolStream;
 assert.equal(await fs.readFile(path.join(dir,'edit.txt'),'utf8'),'original');
 await fs.writeFile(path.join(os.tmpdir(),'obs08-browser-lines.json'),JSON.stringify(browserLines));
 console.log('OBS08 real tools/projection/status matrix/anchored XML/zero facts/edit unknown phase passed; browser fixture:',path.join(os.tmpdir(),'obs08-browser-lines.json'));
} finally {await fs.rm(dir,{recursive:true,force:true});}
