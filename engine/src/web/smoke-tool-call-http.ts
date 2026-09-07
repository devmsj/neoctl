// Real Node HTTP route + WebRepl detail + real disk storage; no model/network provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWebServer, WebRepl, restoreWebHistoryLines } from './index.js';
import { FileToolResultMemory } from '../session/tool-result-memory.js';
import { createToolResultMessage, type Message } from '../types/messages.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'obs01-http-'));
const sessions = new Map<string, {dir:string;entries:{type:string;message:Message}[]}>();
for (const id of ['A','B']) {
 const dir=path.join(root,id); await fs.mkdir(dir);
 const req={id:'same-call',name:'file_read',input:{path:`${id}.txt`}};
 const memory=new FileToolResultMemory({sessionDir:dir,thresholdChars:20});
 const output=await memory.processToolResult(req.id,{content:`SESSION_${id}_ONLY`+'x'.repeat(100)});
 sessions.set(id,{dir,entries:[{type:'message',message:{id:`use-${id}`,role:'assistant',createdAt:'',blocks:[{type:'tool_use',...req}]}},{type:'message',message:{...createToolResultMessage(req,true,output.output),id:`result-${id}`}}]});
}
let server: http.Server | undefined;
const original=http.createServer;
const probe=original();await new Promise<void>(r=>probe.listen(0,"127.0.0.1",r));
const probeAddress=probe.address();assert.ok(probeAddress && typeof probeAddress === "object");
const port=probeAddress.port;await new Promise<void>(r=>probe.close(()=>r()));
// Capture the real server solely to close it after running its private production route.
(http as unknown as {createServer:Function}).createServer=(...args:unknown[])=>{server=(original as Function)(...args);return server;};
let executions=0;
try {
 await runWebServer(['--host','127.0.0.1','--port',String(port)],{
  createRuntime:async options=>({sessionId:options?.sessionId} as never),
  createRepl:runtime=>{
   const id=(runtime as unknown as {sessionId:string}).sessionId;
   const data=sessions.get(id);
   const fake={runtime:{engine:{snapshot:()=>({session:{sessionId:id,sessionDir:data?.dir}}),getDisplayEntries:()=>data?.entries??[],redactDisplayValue:<T>(v:T)=>v}},toolCallDetail:WebRepl.prototype.toolCallDetail,submit:()=>{executions++;throw new Error('must not execute');}};
   return fake as unknown as WebRepl;
  }
 });
 const address=server!.address();assert.ok(address && typeof address==='object');
 const base=`http://127.0.0.1:${address.port}`;
 const url=(s:string,m='')=>`${base}/api/tool-call-detail?sessionId=${s}&toolUseId=same-call${m?'&messageId='+m:''}`;
 let count=0; const check=(v:unknown)=>{assert.ok(v);count++;};
 for(const id of ['A','B']) {
  const r=await fetch(url(id));check(r.status===200);check(r.headers.get('cache-control')==='no-store');
  const body=await r.json();check(body.sessionId===id);check(body.result.text.includes(`SESSION_${id}_ONLY`));check(!body.result.text.includes(`SESSION_${id==='A'?'B':'A'}_ONLY`));
 }
 // Agent source provenance must hold at the ordinary-call HTTP boundary too.
 for (const name of ['subagent_run', 'subagent_get', 'subagent_output']) {
  const request={id:`legacy-${name}`,name,input:{task_id:'legacy-task'}};
  const legacy=name==='subagent_output'
   ? '<retrieval_status>ready</retrieval_status>\n<task_id>legacy-task</task_id>\n<task_type>agent</task_type>\n<status>completed</status>\n<run_generation>2</run_generation>\n<pending_messages>0</pending_messages>\n<requires_resume>false</requires_resume>\n<agent_id>legacy-agent</agent_id>\n<output>PRIVATE_LEGACY_REASONING</output>'
   : {task_id:'legacy-task',run_generation:2,status:'completed',result:{content:'PRIVATE_LEGACY_REASONING'},progress:{last_text:'PRIVATE_LEGACY_PROGRESS'}};
  sessions.get('A')!.entries.push({type:'message',message:createToolResultMessage(request,true,legacy)});
  const r=await fetch(`${base}/api/tool-call-detail?sessionId=A&toolUseId=${request.id}`);
  check(r.status===200);const body=await r.json();
  check(!JSON.stringify(body).includes('PRIVATE_LEGACY_'));
  check(body.result.state==='unavailable');
  check(body.result.text.includes('legacy-task') && body.result.text.includes('2'));
  const lines=restoreWebHistoryLines({engine:{getDisplayEntries:()=>sessions.get('A')!.entries}} as never);
  check(!JSON.stringify(lines).includes('PRIVATE_LEGACY_'));
 }

 // Windows junction is an actual filesystem symlink/reparse point, no admin privilege needed.
 const a=sessions.get('A')!;await fs.rm(path.join(a.dir,'tool-results'),{recursive:true});
 await fs.symlink(path.join(sessions.get('B')!.dir,'tool-results'),path.join(a.dir,'tool-results'),'junction');
 check((await fs.lstat(path.join(a.dir,'tool-results'))).isSymbolicLink());
 const attack=await (await fetch(url('A'))).json();check(attack.result.state==='unavailable');check(!attack.result.text.includes('SESSION_B_ONLY'));
 await fs.unlink(path.join(a.dir,'tool-results'));
 // Same caller-selected session cannot request the other session's result-message identity.
 const denied=await fetch(url('A','result-B'));console.log('Actual cross-session status:',denied.status);check(denied.status===404);check(!(await denied.text()).includes('SESSION_B_ONLY'));
 check((await fetch(url('absent'))).status===404);
 check((await fetch(url('A'),{headers:{Origin:'https://evil.invalid','Sec-Fetch-Site':'cross-site'}})).status===403);
 check((await fetch(url('A'),{method:'POST'})).status===404);
 check(executions===0);
 console.log(`OBS-01 real HTTP passed: ${count} assertions; GET read-only, 403/404, two runtime session roots, cross-session message refusal, real junction escape refused`);
} finally {
 (http as unknown as {createServer:Function}).createServer=original;
 server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());
 // Never recursively follow the test junction on failure.
 await fs.unlink(path.join(root,'A','tool-results')).catch(()=>{});
 await fs.rm(root,{recursive:true,force:true});
}
