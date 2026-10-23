import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityContent,activityPurpose,activityPhase } from '../src/tool-activity.mjs'
import { toolIcons } from '../src/tool-icons.mjs'
const line=(toolName,input={},phase='generating',extra={})=>({toolName,activity:{input,phase},...extra})
test('only real assistant text ends the automatic observation phase',async()=>{
 const {hasUnansweredToolActivity}=await import('../src/use-tool-observation.mjs');
 const tool={id:'call',kind:'tool',toolName:'file_read'};
 assert.equal(hasUnansweredToolActivity([]),false);
 assert.equal(hasUnansweredToolActivity([tool,{kind:'assistant',text:''}]),true);
 assert.equal(hasUnansweredToolActivity([tool,{kind:'thinking',text:'thinking'}]),true);
 assert.equal(hasUnansweredToolActivity([tool,{kind:'system',text:'system'}]),true);
 assert.equal(hasUnansweredToolActivity([tool,{kind:'assistant',text:' \n '}]),true);
 assert.equal(hasUnansweredToolActivity([tool,{kind:'assistant',text:'reply'}]),false);
 assert.equal(hasUnansweredToolActivity([tool,{kind:'assistant',text:'reply'},{...tool,id:'next'}]),true);
});
test('structured field changes preserve unchanged branches and never interpret prose',async()=>{
 const {applyActivityInput}=await import('../src/tool-input-changes.mjs');
 const before={path:'a.ts',items:[{description:'parent',subitems:[{description:'chi'}]}]};
 const after=applyActivityInput(before,[{op:'append',path:['items',0,'subitems',0,'description'],value:'ld'}]);
 assert.equal(after.items[0].subitems[0].description,'child');assert.equal(before.items[0].subitems[0].description,'chi');assert.equal(after.path,before.path);
 assert.deepEqual(applyActivityInput({},[{op:'set',path:['__proto__','polluted'],value:true}]),{});
 assert.equal(activityContent(line('plan_update',{},'running',{text:'{"items":[{"description":"not protocol"}]}'})).mode,'text');
});
test('image observation references and terminal live states use exact identities',async()=>{
 const {referencedImages,terminalObservation}=await import('../src/tool-runtime-observation.mjs');
 assert.deepEqual(referencedImages(line('image_note',{imageRef:'img_1'}),[{imageId:'img_1'},{imageId:'img_2'}]),[{imageId:'img_1'}]);
 const run=line('terminal_run',{},'completed',{observation:{session_id:'run1'}});
 assert.equal(terminalObservation(run,[{kind:'terminal',sessionId:'run1',status:'running'}]).observation.status,'running');
});
test('all builtins have icon and real argument fallback without decorative separators',()=>{
 const fixtures={file_read:{path:'x',offset:2},file_list:{path:'src'},file_search:{query:'x'},file_write:{path:'x'},file_edit:{path:'x'},terminal_run:{cmd:'echo x'},terminal_control:{session_id:'1'},web_search:{query:'x'},image_create:{semanticName:'x'},image_inspect:{imageRefs:['img_1']},image_note:{imageRef:'img_1'},plan_update:{items:[]},framework_feedback:{title:'x'},subagent_run:{name:'x'},subagent_output:{task_id:'1'},subagent_list:{},subagent_get:{task_id:'1'},subagent_stop:{task_id:'1'},subagent_message:{target:'x'},subagent_resume:{task_id:'1'},subagent_report:{status:'completed'}};
 for(const [name,input] of Object.entries(fixtures)){assert.ok(toolIcons[name]);assert.ok(activityPurpose(line(name,input)));assert.ok(!activityPurpose(line(name,input)).includes('·'))}
 assert.ok(toolIcons.plugin);assert.equal(activityPurpose(line('file_read',{description:'真实目的',path:'x'})),'真实目的')
})
test('draft editing differs from committed patch and interrupted draft is not applied',()=>{
 const input={oldString:'old',newString:'new'};assert.equal(activityContent(line('file_edit',input)).draft,true)
 const committed=activityContent(line('file_edit',input,'completed',{observation:{patch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-actual','+applied']}]}}));assert.ok(committed.text.includes('+applied'));assert.ok(!committed.text.includes('+new'))
 assert.equal(activityContent(line('file_edit',input,'interrupted')).text,'')
 assert.equal(activityPhase(line('terminal_run',{},'running',{toolStream:{phase:'cancelled'}})),'interrupted')
})
test('structured tools project actual output, no generated fixture content',()=>{
 for(const [toolName,result,mode] of [['file_list',{entries:[{name:'actual'}]},'entries'],['file_search',{matches:[{text:'actual'}]},'matches'],['web_search',{results:[{title:'actual'}]},'search'],['file_read',{content:'actual'},'read'],['subagent_list',{tasks:[{task_id:'actual'}]},'tasks']])assert.equal(activityContent(line(toolName,{},'completed',{observation:result})).mode,mode)
 assert.equal(activityContent(line('subagent_get',{},'completed',{observation:{content:'hidden'}})).text,'')
 assert.equal(activityContent(line('subagent_get',{},'completed',{observation:{content:'approved',displaySource:'visible_text'}})).text,'approved')
})

test('command process lifecycle is independent of tool-call success',async()=>{
 const {terminalPhase,agentObservation}=await import('../src/tool-activity.mjs');
 const running=line('terminal_run',{},'completed',{titleStatus:'success',observation:{status:'running',session_id:'r'}});
 assert.equal(terminalPhase(running),'running');
 assert.equal(terminalPhase(running,{lifecycle:'terminal',exit:{exitCode:0}}),'completed');
 assert.equal(terminalPhase(running,{lifecycle:'terminal',exit:{exitCode:3}}),'failed');
 assert.equal(terminalPhase(running,{lifecycle:'lost'}),'interrupted');
 assert.equal(activityPhase(line('terminal_run',{},'running',{live:true,timing:{status:'queued'}})),'queued');
 const old=line('subagent_get',{},'completed',{observation:{taskId:'a',runGeneration:1}});
 const task={taskId:'a',runGeneration:2,progress:{visibleText:{channel:'visible',redactionVersion:1,runGeneration:2,text:'new run'}}};
 assert.equal(agentObservation(old,[task]),old);
 assert.equal(agentObservation({...old,observation:{taskId:'a',runGeneration:2}},[task]).observation.content,'new run');
});

test('snapshots reuse unchanged projections while changed content and runtime events advance',async()=>{
 const {reconcileActivitySnapshot,runtimeActivitySignal}=await import('../src/tool-runtime-observation.mjs');
 const previous=[{id:'a',activity:{phase:'generating',input:{content:'abc'}},observation:{session_id:'r'}}];
 const same=reconcileActivitySnapshot(structuredClone(previous),previous);
 assert.equal(same[0].activity,previous[0].activity);assert.equal(same[0].observation,previous[0].observation);
 const changed=reconcileActivitySnapshot([{...same[0],activity:{...same[0].activity,input:{content:'abcd'}}}],same);
 assert.notEqual(changed[0].activity,same[0].activity);
 assert.deepEqual(runtimeActivitySignal({...previous[0],toolName:'terminal_run'},[{kind:'terminal',sessionId:'r',status:'running',outputRevision:{stdout:{storedBytes:50},stderr:{storedBytes:0}}}]),['running',undefined,50,0]);
});
test('report text cannot fabricate lifecycle and final authorized report wins over progress',async()=>{
 const {agentObservation}=await import('../src/tool-activity.mjs');
 assert.equal(activityPurpose(line('subagent_report',{content:'INCOMPLETE words'})),'提交子任务报告草稿');
 const source=line('subagent_get',{},'completed',{observation:{taskId:'a',runGeneration:2}});
 assert.equal(agentObservation(source,[{taskId:'a',runGeneration:2,progress:{visibleText:{channel:'visible',redactionVersion:1,runGeneration:2,text:'old'}},result:{content:'final'}}]).observation.content,'final');
});

test('interrupted lifecycle wins over generic tool failure and listing a file stays structural',()=>{
 assert.equal(activityPhase(line('file_write',{},'interrupted',{titleStatus:'failure'})),'interrupted');
 assert.deepEqual(activityContent(line('file_list',{},'completed',{observation:{type:'file',path:'actual.txt'}})),{mode:'entries',entries:[{type:'file',path:'actual.txt'}]});
});

test('explicit model purpose is shown alone throughout each tool lifecycle',()=>{
 for(const toolName of ['file_read','file_list','file_search','file_edit','file_write','terminal_run','terminal_control','plan_update','custom_plugin']) {
  for(const phase of ['generating','queued','running','completed','failed','interrupted']) {
   const input={purpose:'  核对本次改动  ',description:'其他说明',path:'a.ts',cmd:'echo test',query:'test'};
   assert.equal(activityPurpose(line(toolName,input,phase,{toolDisplay:{purpose:'旧展示目的',subject:'旧对象'},title:'工具名称'})),'核对本次改动');
   assert.equal(activityPurpose(line(toolName,{...input,purpose:' ',description:'模型填写的目的'},phase)),'模型填写的目的');
  }
 }
 assert.equal(activityPurpose(line('file_read',{purpose:null,description:' ',path:'src/a.ts',offset:8})),'从第 8 行读取 src/a.ts');
 assert.equal(activityPurpose(line('terminal_run',{purpose:42,description:false,cmd:'echo test'})),'执行 echo test');
});

test('new rows prefer verified fallback over legacy synthesized purpose',()=>{
 assert.equal(activityPurpose(line('file_read',{path:'src/a.ts',offset:8},'generating',{toolDisplay:{purpose:'读取 a.ts'}})),'从第 8 行读取 src/a.ts');
});

test('tool groups use source membership without response-based disappearance',async()=>{
 const {toolConnectionGroups}=await import('../src/tool-concurrency.mjs');
 const a={id:'a',kind:'tool',toolName:'file_read',connectPreviousTool:false};
 const b={...a,id:'b',connectPreviousTool:true};
 assert.equal(toolConnectionGroups([a]).length,0);
 assert.equal(toolConnectionGroups([a,b])[0].connections.size,2);
 assert.equal(toolConnectionGroups([a,{kind:'thinking',id:'t'},b])[0].connections.size,3);
 assert.equal(toolConnectionGroups([a,b,{kind:'assistant',text:'reply'}])[0].connections.size,2);
 assert.equal(toolConnectionGroups([a,b,{...a,id:'c'},{...b,id:'d'}]).length,2);
 assert.equal(toolConnectionGroups([a,b])[0].connections.get('a').first,true);
 assert.equal(toolConnectionGroups([a,b])[0].connections.get('b').last,true);
});
test('fixed two second playback never resets or replays from updates, replies, scrolling or history',async()=>{
 const {createToolConnectionPlayback,toolConnectionGroups,TOOL_CONNECTION_DURATION}=await import('../src/tool-concurrency.mjs');
 let shown;const timers=[];
 const playback=createToolConnectionPlayback(v=>shown=v,(cb,delay)=>{timers.push({cb,delay});return timers.length},()=>{});
 const a={id:'a',kind:'tool',toolName:'file_read'},b={...a,id:'b',connectPreviousTool:true};
 const group=toolConnectionGroups([a,b]);
 playback.update(group);assert.equal(shown.size,2);assert.equal(timers.length,1);assert.equal(timers[0].delay,2000);assert.equal(TOOL_CONNECTION_DURATION,2000);
 playback.update(toolConnectionGroups([a,b,{kind:'assistant',text:'reply'}]));
 playback.update([]);assert.equal(shown.size,2,'new call/reply never cancels playback');assert.equal(timers.length,1);
 timers[0].cb();assert.equal(shown.size,0);
 playback.update(group);assert.equal(shown.size,0);assert.equal(timers.length,1,'no replay after expiry');
 playback.reset();playback.update(group,true);assert.equal(shown.size,0,'loaded history does not play');
 playback.reset();playback.update(group);assert.equal(shown.size,2);playback.reset();assert.equal(shown.size,0);
});
