import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partialToolInput, toolActivity, ACTIVITY_ARGUMENT_LIMIT } from '../../src/web/tool-activity.js';
import { ToolInputStream, applyToolInputChanges } from '../../src/model/tool-input-stream.js';
test('incremental protocol emits suffixes and nested plan fields without full snapshots',()=>{
 const decoder=new ToolInputStream();let input:Record<string,unknown>={};
 const chunks=['{"path":"a.ts","content":"hel','lo\\n','world","items":[{"description":"par','ent","status":"in_progress","subitems":[{"description":"chi','ld","status":"pending"}]}]}'];
 for(const chunk of chunks){const changes=decoder.append(chunk);input=applyToolInputChanges(input,changes);assert.deepEqual(input,decoder.snapshot());}
 assert.equal(input.content,'hello\nworld');assert.deepEqual(input.items,[{description:'parent',status:'in_progress',subitems:[{description:'child',status:'pending'}]}]);
 const d=new ToolInputStream();d.append('{"content":"'+'x'.repeat(10000));const suffix=d.append('new');
 assert.deepEqual(suffix,[{op:'append',path:['content'],value:'new'}]);assert.ok(JSON.stringify(suffix).length<100);
 const a=new ToolInputStream(),b=new ToolInputStream();a.append('{"cmd":"A');b.append('{"cmd":"B');assert.equal(a.snapshot().cmd,'A');assert.equal(b.snapshot().cmd,'B');
 const invalid=new ToolInputStream();assert.deepEqual(invalid.append('assistant says edit x'),[]);
});
test('incremental arguments preserve incomplete strings, escapes and nested completed values',()=>{
 const raw=JSON.stringify({path:'a.ts',oldString:'a\n"x"',newString:'新行\n😀',items:[{description:'child',status:'pending'}]});
 for(let n=1;n<raw.length;n++){const p=partialToolInput(raw.slice(0,n));assert.equal(typeof p,'object');if(p.newString!==undefined)assert.ok('新行\n😀'.startsWith(String(p.newString)));}
 assert.deepEqual(partialToolInput(raw),JSON.parse(raw));
 assert.deepEqual(partialToolInput('{"cmd":"echo \\u4f'),{cmd:'echo '});
 assert.deepEqual(partialToolInput('{"items":[{"description":"x"}],"title":"up'),{items:[{description:'x'}],title:'up'});
});
test('activity input is bounded and never executes partial arguments',()=>{
 const activity=toolActivity({content:'x'.repeat(ACTIVITY_ARGUMENT_LIMIT*2)},'generating');
 assert.equal(activity.truncated,true);assert.ok(String(activity.input.content).length<ACTIVITY_ARGUMENT_LIMIT);
 assert.deepEqual(partialToolInput('not json'),{});
 assert.equal(({} as Record<string,unknown>).polluted,undefined);
 partialToolInput('{"__proto__":{"polluted":true},"path":"x');assert.equal(({} as Record<string,unknown>).polluted,undefined);
});

test('field-operation batching preserves order without mutating source operations',async()=>{
 const {compactLineOperations}=await import('../../src/web/index.js');
 const source=[{type:'line.activity.input' as const,id:1,changes:[{op:'set' as const,path:['content'],value:'a'}]},{type:'line.activity.input' as const,id:1,changes:[{op:'append' as const,path:['content'],value:'b'}]}];
 const compact=compactLineOperations(source);assert.equal(compact.length,1);assert.equal(source[0]!.changes.length,1);
 assert.equal(compact[0]!.type,'line.activity.input');if(compact[0]!.type==='line.activity.input')assert.equal(applyToolInputChanges({},compact[0]!.changes).content,'ab');
});
