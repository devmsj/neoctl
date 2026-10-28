import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QueryEngine } from '../../src/core/query-engine.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { WebRepl, WebRuntimeRouter, type WebRuntime } from '../../src/web/index.js';

async function fixture(t: any) {
 const root=await mkdtemp(path.join(os.tmpdir(),'neo-active-delete-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const engine=new QueryEngine({modelGateway:{async *stream(){throw Error('must not call model')}},tools:new ToolRegistry(),
  contextManager:{async build(){return {systemPrompt:'test',promptSections:[],userContext:{currentDate:'2026-10-28'},systemContext:{cwd:root,platform:process.platform}}}},
  compactor:{async compact(messages){return {messages:[...messages],changed:false}}},cwd:root,session:{rootDir:root,resume:false}});
 await engine.initialize();const old=engine.snapshot().session!;
 const runtime={engine,initialMetrics:{},usage:{reset(){}},taskStore:{subscribe(){},list:()=>[],bindSession(){}},execProcessManager:{subscribe(){},subscribeOutput(){},list:()=>[]}} as unknown as WebRuntime;
 const repl=new WebRepl(runtime);const internals=repl as any;
 internals.publishRuntimeContext=()=>{};internals.broadcastSync=()=>{};
 const events:string[]=[];internals.subscribers.add({});internals.send=(_subscriber:any,event:string)=>events.push(event);
 const router=new WebRuntimeRouter();(router as any).repls.set(`session:${old.sessionId}`,Promise.resolve(repl));
 t.after(()=>{clearTimeout(internals.pendingDeltaTimer);clearTimeout(internals.terminalOutputTimer)});
 return {root,engine,old,runtime,repl,internals,router,events};
}

test('confirmed idle active deletion releases the writer, removes files, creates replacement and retires old aliases',async t=>{
 const f=await fixture(t);const order:string[]=[];
 const settle=f.engine.settleSessionWrites.bind(f.engine);f.engine.settleSessionWrites=async()=>{order.push('release');await settle()};
 const fork=f.engine.forkForSession.bind(f.engine);f.engine.forkForSession=(id,resume)=>{const next=fork(id,resume);const remove=next.deleteSession.bind(next),init=next.initialize.bind(next);next.deleteSession=async id=>{order.push('delete');assert.equal(f.runtime.engine,next);return remove(id)};next.initialize=async()=>{order.push('initialize');await init()};return next};
 const result=await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 assert.equal(result.ok,true);if(!result.ok) return;
 assert.ok(result.replacementSessionId);assert.notEqual(result.replacementSessionId,f.old.sessionId);
 assert.deepEqual(order.slice(0,3),['release','delete','initialize']);
 await assert.rejects(stat(f.old.sessionDir));assert.ok(await stat(f.runtime.engine.snapshot().session!.sessionDir));
 assert.throws(()=>f.router.get({sessionId:f.old.sessionId}),/已删除/);
 assert.equal(await f.router.get({sessionId:result.replacementSessionId}),f.repl);
 assert.deepEqual(f.events,['session.replaced']);
});

test('running session is protected and deletion failure restores the original runtime',async t=>{
 const f=await fixture(t);f.internals.busy=true;
 assert.equal((await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId)).ok,false);
 assert.equal(f.runtime.engine,f.engine);assert.ok(await stat(f.old.sessionDir));f.internals.busy=false;
 const fork=f.engine.forkForSession.bind(f.engine);f.engine.forkForSession=(id,resume)=>{const next=fork(id,resume);next.deleteSession=async()=>{throw Error('permission denied')};return next};
 const result=await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 assert.equal(result.ok,false);assert.equal(f.runtime.engine,f.engine);assert.ok(await stat(f.old.sessionDir));assert.equal(await f.router.get({sessionId:f.old.sessionId}),f.repl);
});

test('duplicate delete and submit are blocked until release settles',async t=>{
 const f=await fixture(t);let release!:()=>void;f.engine.settleSessionWrites=()=>new Promise<void>(r=>{release=r});
 const deleting=f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 while(!release)await new Promise(r=>setTimeout(r,1));
 assert.equal((await f.repl.submit('must not run')).ok,false);
 assert.equal((await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId)).ok,false);
 release();assert.equal((await deleting).ok,true);
});

test('replacement initialization failure never restores the deleted writer',async t=>{
 const f=await fixture(t);const fork=f.engine.forkForSession.bind(f.engine);f.engine.forkForSession=(id,resume)=>{const next=fork(id,resume);next.initialize=async()=>{throw Error('disk full')};return next};
 const result=await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 assert.equal(result.ok,true);assert.notEqual(f.runtime.engine,f.engine);await assert.rejects(stat(f.old.sessionDir));assert.deepEqual(f.events,['session.deleted']);assert.throws(()=>f.router.get({sessionId:f.old.sessionId}),/已删除/);
});

test('replacement is registered before observers receive the transition event',async t=>{
 const f=await fixture(t);let observed:Promise<unknown>|undefined;
 f.internals.send=(_s:any,event:string,data:any)=>{if(event==='session.replaced')observed=f.router.get({sessionId:data.sessionId})};
 const result=await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 assert.equal(result.ok,true);assert.equal(await observed,f.repl);
});

test('cold active-session deletion restores one owner and publishes a reusable replacement',async t=>{
 const f=await fixture(t);let restored=0;
 const router=new WebRuntimeRouter({createRuntime:async options=>{restored++;assert.equal(options?.sessionId,f.old.sessionId);return f.runtime},createRepl:()=>f.repl});
 const result=await router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 assert.equal(result.ok,true);if(!result.ok)return;
 assert.equal(restored,1);assert.equal(await router.get({sessionId:result.replacementSessionId}),f.repl);
 await assert.rejects(stat(f.old.sessionDir));
});

test('pending external session persistence prevents deletion and all settings reject during release',async t=>{
 const f=await fixture(t);f.internals.sessionMutations=1;
 assert.equal((await f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId)).ok,false);
 f.internals.sessionMutations=0;
 let release!:()=>void;f.engine.settleSessionWrites=()=>new Promise<void>(r=>{release=r});
 const pending=f.router.deleteSession({sessionId:f.old.sessionId},f.old.sessionId);
 while(!release)await new Promise(r=>setTimeout(r,1));
 for(const call of [()=>f.repl.setFastMode(true),()=>f.repl.setSessionModel('test',undefined),()=>f.repl.setContextWindowK('100'),()=>f.repl.setSessionTools({}),()=>f.repl.setSessionPlugins({}),()=>f.repl.saveSessionPrompt({}),()=>f.repl.resumeSession('other'),()=>f.repl.newSession()]) assert.equal((await call()).ok,false);
 release();assert.equal((await pending).ok,true);
});
