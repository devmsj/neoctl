import assert from "node:assert/strict";
import { createTaskNotificationMessage, createTextMessage, createThinkingMessage, createToolResultMessage } from "../../src/types/messages.js";
import type { SessionDisplayEntry } from "../../src/session/session-store.js";
import { restoreWebHistoryLines, WebRepl } from "../../src/web/index.js";

const oldReport = {
  reason: "manualcompact" as const,
  summary: "old summary",
  continuationState: "old continuation",
  sourceMessages: 10,
  preservedUserMessages: 2,
  newWindowMessages: 3,
  charsFreed: 100,
  modelDriven: true,
  imageCount: 0,
};
const newReport = {
  ...oldReport,
  summary: "new summary",
  continuationState: "new continuation",
  sourceMessages: 20,
  preservedUserMessages: 4,
  newWindowMessages: 5,
  charsFreed: 200,
};
const entries: SessionDisplayEntry[] = [
  { type: "message", message: createTextMessage("user", "user before first compact") },
  { type: "message", message: createThinkingMessage("assistant reasoning before first compact") },
  { type: "message", message: createTextMessage("assistant", "assistant before first compact") },
  { type: "compact", createdAt: "2026-09-03T06:12:17.756Z", reason: "manualcompact", report: oldReport },
  { type: "message", message: createTextMessage("user", "user between compacts") },
  { type: "message", message: createTextMessage("assistant", "assistant between compacts") },
  { type: "compact", createdAt: "2026-09-03T06:44:41.985Z", reason: "manualcompact", report: newReport },
  { type: "message", message: createTextMessage("assistant", "assistant after second compact") },
  { type: "message", message: createTaskNotificationMessage({ taskId: "task_hidden", agentId: "agent_hidden", status: "completed", type: "agent", content: "must not render" }) },
];

const lines = restoreWebHistoryLines({
  engine: {
    getDisplayEntries: () => entries,
  },
} as never) as Array<Record<string, any>>;
const compactions = lines.filter((line) => line.compaction);
const texts = lines.map((line) => line.text);

assert.deepEqual(texts, [
  "user before first compact",
  "assistant reasoning before first compact",
  "assistant before first compact",
  "3 message(s) in new window, 2 user message(s) preserved",
  "user between compacts",
  "assistant between compacts",
  "5 message(s) in new window, 4 user message(s) preserved",
  "assistant after second compact",
]);
assert.equal(lines[0]?.kind, "user");
assert.equal(lines[1]?.kind, "thinking");
assert.equal(lines[2]?.kind, "assistant");
assert.equal(lines[5]?.kind, "assistant");
assert.equal(lines[7]?.kind, "assistant");
assert.equal(compactions.length, 2);
assert.equal(compactions[0]?.compaction?.current, false);
assert.equal(compactions[1]?.compaction?.current, true);
assert.equal(compactions[0]?.compaction?.createdAt, "2026-09-03T06:12:17.756Z");
assert.equal(compactions[1]?.compaction?.createdAt, "2026-09-03T06:44:41.985Z");

const commandRequest = {
  id: "call_structured_command",
  name: "terminal_run",
  input: { cmd: "npm test", description: "运行测试" },
};
const commandUseMessage = {
  id: "message_tool_use",
  role: "assistant" as const,
  createdAt: new Date().toISOString(),
  blocks: [{ type: "tool_use" as const, ...commandRequest }],
};
const commandResultMessage = createToolResultMessage(commandRequest, true, {
  command: "npm test",
  description: "运行测试",
  exit_code: 0,
  duration_ms: 1280,
  stdout: "ok",
});
const commandLines = restoreWebHistoryLines({
  engine: {
    getDisplayEntries: () => [
      { type: "message", message: commandUseMessage },
      { type: "message", message: commandResultMessage },
    ],
  },
} as never) as Array<Record<string, any>>;
assert.equal(commandLines.length, 1);
assert.equal(commandLines[0]?.toolDisplay?.purpose, "运行测试");
assert.deepEqual(commandLines[0]?.toolDisplay?.facts?.map((fact: {label:string;value:string})=>[fact.label,fact.value]), [['运行状态','已完成'],['退出码','0'],['信号','未提供'],['终止原因','未提供'],['耗时','1280 ms']]);
assert.deepEqual(commandLines[0]?.toolDisplay?.previews?.map((preview: Record<string, unknown>) => [preview.label, preview.kind, preview.content]), [
  ["命令", "code", "npm test"],
  ["stdout", "code", "ok"],
]);

const runtime = {
  engine: {
    getDisplayEntries: () => entries,
    snapshot: () => ({ session: { sessionId: "smoke" } }),
    isFastMode: () => false,
    getAppPrompt: () => ({ hasActivePrompt: false, activePrompt: undefined }),
    onSessionTitleChange: () => () => undefined,
  },
  usage: { snapshot: () => ({}), add: () => undefined, reset: () => undefined },
  taskStore: { subscribe: () => () => undefined, list: () => [] },
  execProcessManager: {
    subscribe: () => () => undefined,
    subscribeOutput: () => () => undefined,
    list: () => [],
  },
} as never;
const repl = new WebRepl(runtime);
const initialSnapshot = repl.snapshot(false);
const initialIds = initialSnapshot.lines.map((line) => line.id);
assert.equal(new Set(initialIds).size, initialIds.length);
const append = (repl as unknown as { append: (line: Record<string, unknown>) => number }).append.bind(repl);
const appendedId = append({ kind: "assistant", text: "live assistant after restore" });
const afterAppend = repl.snapshot(false);
assert.ok(appendedId > Math.max(...initialIds));
assert.equal(new Set(afterAppend.lines.map((line) => line.id)).size, afterAppend.lines.length);
assert.equal(afterAppend.lines.at(-1)?.kind, "assistant");

const handleEvent = (repl as unknown as { handleEvent: (event: unknown) => void }).handleEvent.bind(repl);
const beforeInternalNotification = repl.snapshot(false).lines.length;
handleEvent({ type: "message", message: createTaskNotificationMessage({ taskId: "task_live_hidden", agentId: "agent_live_hidden", status: "completed", type: "agent", content: "must not render live" }) });
assert.equal(repl.snapshot(false).lines.length, beforeInternalNotification);
handleEvent({ type: "tool.started", toolUse: commandRequest, index: 0, total: 1 });
handleEvent({ type: "tool.progress", toolUse: commandRequest, progress: { toolName: "terminal_run", message: "准备", channel: "item", operation: "upsert", key: "phase", phase: "running", sequence: 1 } });
handleEvent({ type: "tool.progress", toolUse: commandRequest, progress: { toolName: "terminal_run", message: "完成", channel: "item", operation: "append", key: "phase", phase: "completed", sequence: 2 } });
handleEvent({ type: "tool.progress", toolUse: commandRequest, progress: { toolName: "terminal_run", message: "重复事件", channel: "item", operation: "upsert", key: "duplicate", phase: "running", sequence: 2 } });
handleEvent({ type: "tool.progress", toolUse: commandRequest, progress: { toolName: "terminal_run", message: "移除", channel: "item", operation: "remove", key: "phase", sequence: 3 } });
handleEvent({ type: "tool.progress", toolUse: commandRequest, progress: { toolName: "terminal_run", message: "输出", channel: "stdout", operation: "append", sequence: 4, data: "live-output" } });
handleEvent({ type: "tool.result.available", toolUse: commandRequest, ok: true, messages: [commandResultMessage], index: 0, total: 1 });
handleEvent({ type: "tool.finished", toolUse: commandRequest, ok: true, index: 0, total: 1 });
handleEvent({ type: "message", message: commandResultMessage });
const streamedSnapshot = repl.snapshot(false) as { lines: Array<Record<string, any>> };
const streamedToolLines = streamedSnapshot.lines.filter((line) => line.toolUseId === commandRequest.id);
assert.equal(streamedToolLines.length, 1);
assert.equal(streamedToolLines[0]?.live, false);
assert.equal(streamedToolLines[0]?.toolDisplay?.purpose, "运行测试");
assert.equal(streamedToolLines[0]?.toolStream?.stdout, "live-output");
assert.deepEqual(streamedToolLines[0]?.toolStream?.steps, []);

const agentRequest = { id: "call_agent", name: "subagent_run", input: { description: "检查前端" } };
handleEvent({ type: "tool.started", toolUse: agentRequest, index: 0, total: 1 });
handleEvent({
  type: "tool.progress",
  toolUse: agentRequest,
  progress: {
    toolName: "subagent_run",
    message: "读取入口文件",
    channel: "item",
    operation: "upsert",
    key: "child_read",
    phase: "tool_running",
    sequence: 1,
    data: { child_event: { type: "tool.started", toolUse: { id: "child_read", name: "file_read", input: { description: "读取入口文件" } } } },
  },
});
handleEvent({
  type: "tool.progress",
  toolUse: agentRequest,
  progress: {
    toolName: "subagent_run",
    message: "搜索事件处理",
    channel: "item",
    operation: "upsert",
    key: "child_grep",
    phase: "tool_running",
    sequence: 2,
    data: { child_event: { type: "tool.started", toolUse: { id: "child_grep", name: "file_search", input: { description: "搜索事件处理" } } } },
  },
});
const agentLine = (repl.snapshot(false) as { lines: Array<Record<string, any>> }).lines.find((line) => line.toolUseId === agentRequest.id);
assert.deepEqual(agentLine?.toolPresentation, { family: "subagent", action: "run", label: "子任务", visibility: "primary" });
assert.deepEqual(agentLine?.toolStream?.steps?.map((step: Record<string, unknown>) => [step.toolName, step.toolLabel, step.message]), [
  ["file_read", "读取文件", "读取入口文件"],
  ["file_search", "搜索文本", "搜索事件处理"],
]);

const subagentGetRequest = { id: "call_subagent_get", name: "subagent_get", input: { task_id: "task_123" } };
handleEvent({ type: "tool.started", toolUse: subagentGetRequest, index: 0, total: 1 });
const subagentGetLine = (repl.snapshot(false) as { lines: Array<Record<string, any>> }).lines.find((line) => line.toolUseId === subagentGetRequest.id);
assert.deepEqual(subagentGetLine?.toolPresentation, { family: "subagent", action: "get", label: "查看子任务", visibility: "hidden" });
assert.equal(subagentGetLine?.toolDisplay?.purpose, "查看子任务 task_123");

// Arguments arrive before execution; the row identity must survive all phases.
const draftCall = { id: 'stream_edit', name: 'file_edit', input: { path:'a.ts',oldString:'old',newString:'new' } };
handleEvent({type:'tool_call.started',callId:draftCall.id,name:draftCall.name});
handleEvent({type:'tool_call.input',callId:draftCall.id,changes:[{op:'set',path:['path'],value:'a.ts'},{op:'set',path:['oldString'],value:'old'},{op:'set',path:['newString'],value:'ne'}]});
const queuedOps=(repl as unknown as {pendingDeltaOperations:Array<Record<string,any>>}).pendingDeltaOperations;
const inputOperation=queuedOps.find(op=>op.type==='line.activity.input');
assert.ok(inputOperation);assert.equal(inputOperation.input,undefined);assert.equal(inputOperation.changes.at(-1).value,'ne');
const draftLine = repl.snapshot(false).lines.find(line=>line.toolUseId===draftCall.id);
assert.equal(draftLine?.activity?.phase,'generating');
assert.equal(draftLine?.activity?.input.newString,'ne');
handleEvent({type:'tool.started',toolUse:draftCall,index:0,total:1});
const runningLine = repl.snapshot(false).lines.find(line=>line.toolUseId===draftCall.id);
assert.equal(runningLine?.id,draftLine?.id);
assert.equal(runningLine?.activity?.phase,'queued');
handleEvent({type:'timing.updated',timing:{version:1,id:'t-edit',runId:'q',kind:'tool',toolUseId:draftCall.id,status:'running'}});
assert.equal(repl.snapshot(false).lines.find(line=>line.id===draftLine?.id)?.activity?.phase,'running');
const resultMessage=createToolResultMessage(draftCall,true,{path:'a.ts',operation:'edit',replacements:1,patch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-old','+new']}]});
handleEvent({type:'tool.result.available',toolUse:draftCall,ok:true,messages:[resultMessage],index:0,total:1});
handleEvent({type:'tool.finished',toolUse:draftCall,ok:true,index:0,total:1});
handleEvent({type:'message',message:resultMessage});
const finishedLines=repl.snapshot(false).lines.filter(line=>line.toolUseId===draftCall.id);
assert.equal(finishedLines.length,1);
assert.equal(finishedLines[0]?.activity?.phase,'completed');
assert.equal(finishedLines[0]?.activity?.input.newString,'new');
assert.ok(Array.isArray(finishedLines[0]?.observation?.patch));
console.log("web history smoke ok");

// The additional hidden image message projects pixels only, tied to its source call.
const loadedMessage = {
 id:'loaded-image-message',role:'user' as const,isMeta:true,createdAt:new Date().toISOString(),
 metadata:{loadedImages:true,sourceToolUseId:'inspect-call',sourceToolName:'image_inspect'},
 blocks:[{type:'text' as const,text:'hidden inspection instructions'}, {type:'image' as const,mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',label:'actual pixels'}],
};
handleEvent({type:'message',message:loadedMessage});
const loadedLive=repl.snapshot(false).lines.filter(line=>line.parentToolUseId==='inspect-call');
assert.equal(loadedLive.length,1);assert.equal(loadedLive[0]?.observationOnly,true);assert.ok(loadedLive[0]?.image);assert.equal(loadedLive[0]?.text,'actual pixels');
const loadedHistory=restoreWebHistoryLines({engine:{getDisplayEntries:()=>[{type:'message',message:loadedMessage}]}} as never);
assert.equal(loadedHistory.length,1);assert.equal(loadedHistory[0]?.parentToolUseId,'inspect-call');assert.equal(loadedHistory[0]?.observationOnly,true);
assert.ok(!JSON.stringify(loadedHistory).includes('hidden inspection instructions'));
// A silent process becomes observable at spawn, not only after its first output/return.
const silentCall={id:'silent-call',name:'terminal_run',input:{cmd:'sleep'}};
handleEvent({type:'tool.started',toolUse:silentCall,index:0,total:1});
handleEvent({type:'tool.progress',toolUse:silentCall,progress:{toolName:'terminal_run',message:'',channel:'state',phase:'running',data:{type:'terminal.started',session_id:'silent-process',command:'sleep'}}});
assert.equal(repl.snapshot(false).lines.find(line=>line.toolUseId===silentCall.id)?.observation?.session_id,'silent-process');
console.log('image identity and silent-process lifecycle smoke ok');
