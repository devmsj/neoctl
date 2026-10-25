import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
process.env.NEO_CORE_SOURCE = 'local';
const { createWorkspaceRuntimeManager, SessionWorkspaceRegistry } = await import('../runtime-workspaces.mjs');
const { QueryEngine, ToolRegistry, TaskStore } = await import('../../engine/dist/index.js');
const { ExecProcessManager } = await import('../../engine/dist/tools/builtins/exec-process-manager.js');
const { SessionUsageTracker } = await import('../../engine/dist/web/index.js');
const { applyRuntimeContextForPromptCache } = await import('../../engine/dist/core/message-pipeline.js');

test('scope add/remove preserves engine, settings, disk directories and per-session persistence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-scope-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a=path.join(root,'a'), b=path.join(root,'b'); await mkdir(a); await mkdir(b);
  const registryFile=path.join(root,'registry.json');
  const tools=new ToolRegistry(), taskStore=new TaskStore();
  const engine=new QueryEngine({ tools, cwd:a, workspacePaths:[a], model:'test', modelGateway:{ async *stream(){ throw Error('No real requests'); } }, session:{rootDir:path.join(root,'sessions'),resume:false} });
  await engine.initialize(); taskStore.bindSession(engine.snapshot().session.sessionDir);
  const manager=createWorkspaceRuntimeManager({projectRoot:root,workspaceRoot:path.join(root,'workspaces'),registryFile});
  const runtime={engine,tools,taskStore,execProcessManager:new ExecProcessManager(),usage:new SessionUsageTracker(),initialMetrics:await engine.contextMetrics(),envPath:path.join(root,'.env')};
  const repl=manager.createRepl(runtime);
  const results=await Promise.all([repl.updateWorkspaceScope(b),repl.updateWorkspaceScope(b)]);
  assert.ok(results.every(r=>r.ok)); assert.deepEqual(engine.getWorkspacePaths(),[a,b]); assert.equal(runtime.engine,engine); assert.equal(engine.getModelSettings().model,'test');
  const id=engine.snapshot().session.sessionId;
  assert.deepEqual((await new SessionWorkspaceRegistry(registryFile,root).entry(id)).workspacePaths,[a,b]);
  assert.equal((await repl.updateWorkspaceScope(a,true)).ok,true); assert.deepEqual(engine.getWorkspacePaths(),[b]);
  assert.equal((await stat(a)).isDirectory(),true);
  assert.equal((await repl.updateWorkspaceScope(b,true)).ok,true); assert.deepEqual(engine.getWorkspacePaths(),[]);
  assert.equal((await stat(b)).isDirectory(),true);
  assert.deepEqual((await new SessionWorkspaceRegistry(registryFile,root).entry(id)).workspacePaths,[]);
  repl.busy=true; assert.equal((await repl.updateWorkspaceScope(a)).ok,false); repl.busy=false;
  await repl.resumeSession(id); assert.deepEqual(runtime.engine.getWorkspacePaths(),[]);
  await repl.newSession(); assert.equal(runtime.engine.getWorkspacePaths().length,1);
  await repl.resumeSession(id); assert.deepEqual(runtime.engine.getWorkspacePaths(),[]);
  await new Promise(r=>setImmediate(r));
});

test('legacy registry migrates current directory only, not historical scope',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'neo-scope-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'registry.json'),a=path.join(root,'a'),b=path.join(root,'b');
  await writeFile(file,JSON.stringify({old:a,history:{cwd:b,cwdHistory:[a,b],cwdNoticePending:true}}));
  const registry=new SessionWorkspaceRegistry(file,root);
  assert.deepEqual((await registry.entry('old')).workspacePaths,[a]);assert.deepEqual((await registry.entry('history')).workspacePaths,[b]);
  await registry.set('history',b,{workspacePaths:[],materialized:false});
  await registry.set('history',b,{workspacePaths:[a]});
  assert.equal((await registry.entry('history')).materialized,false);
});

test('scope and project documents stay dynamic without changing the cache prefix',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'neo-scope-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const a=path.join(root,'a'),b=path.join(root,'b');await mkdir(a);await mkdir(b);await writeFile(path.join(a,'AGENTS.md'),'FIRST MEMORY');await writeFile(path.join(b,'AGENTS.md'),'SECOND MEMORY');
  const engine=new QueryEngine({tools:new ToolRegistry(),cwd:a,workspacePaths:[a],modelGateway:{async *stream(){}},session:{enabled:false}});
  const input={agentId:'main',messages:[]};
  const first=await engine.buildWorkspaceContext(input);
  engine.setWorkspacePaths([b]);const second=await engine.buildWorkspaceContext(input);
  const message={id:'user',role:'user',blocks:[{type:'text',text:'test'}],createdAt:new Date().toISOString()};
  const one=applyRuntimeContextForPromptCache([message],first.userContext,first.systemContext),two=applyRuntimeContextForPromptCache([message],second.userContext,second.systemContext);
  assert.equal(first.systemPrompt,second.systemPrompt);assert.deepEqual(one[0].blocks,two[0].blocks);
  const dynamic=JSON.stringify(two.find(m=>m.metadata?.cacheStableRuntimeContext===false));
  assert.match(dynamic,/Workspace scope changed/);assert.match(dynamic,/SECOND MEMORY/);assert.doesNotMatch(dynamic,/FIRST MEMORY/);
  assert.deepEqual(second.systemContext['Workspace scope changed'],[b]);assert.equal(second.userContext.projectMemory,undefined);
  engine.setWorkspacePaths([]);const empty=await engine.buildWorkspaceContext(input);assert.equal(empty.systemContext.workspaceMemory,undefined);assert.deepEqual(empty.systemContext['Workspace scope changed'],[]);
  await assert.rejects(engine.updateWorkspacePaths([a],async()=>{throw Error('disk failure')}));assert.deepEqual(engine.getWorkspacePaths(),[]);
  const exported = await engine.promptExportSnapshot();
  assert.deepEqual(exported.systemContext['Workspace scope changed'], []);
  assert.deepEqual(exported.projectDocuments, []);
});

test('accepted scope persistence completes before the next model request and remains visible on later turns',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'neo-scope-request-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const requests=[];let release;const persisted=new Promise(r=>release=r);
  const engine=new QueryEngine({tools:new ToolRegistry(),cwd:root,workspacePaths:[],session:{enabled:false},modelGateway:{async *stream(request){requests.push(request);yield {type:'assistant_message',message:{id:'reply-'+requests.length,role:'assistant',blocks:[{type:'text',text:'ok'}],createdAt:new Date().toISOString()}};yield {type:'response_completed',stopReason:'completed'};}}});
  const update=engine.updateWorkspacePaths([root],()=>persisted);
  const send=(async()=>{for await(const event of engine.sendUserText('test')){}})();
  await new Promise(r=>setTimeout(r,30));assert.equal(requests.length,0);release();await update;await send;
  for await(const event of engine.sendUserText('next')){}
  assert.equal(requests.length,2);
  for(const req of requests){const rendered=JSON.stringify(req.messages);assert.match(rendered,/Workspace scope changed/);assert.ok(rendered.includes(JSON.stringify(root).slice(1,-1)));assert.doesNotMatch(rendered,/cwdTransition/);}
});
