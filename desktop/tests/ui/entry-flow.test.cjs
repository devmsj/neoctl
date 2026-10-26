const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../../ui/app.js','utf8');
function fixture({external=false,running=false,failEntry=false}={}) {
  const elements=new Map(),calls=[],events={};
  const node=id=>{if(elements.has(id))return elements.get(id);const handlers={};const n={id,hidden:false,value:'',textContent:'',dataset:{},attributes:{},style:{},scrollHeight:0,scrollTop:0,clientHeight:0,addEventListener(k,f){handlers[k]=f},removeEventListener(){},setAttribute(k,v){this.attributes[k]=v},focus(){},classList:{toggle(){}},emit(k){return handlers[k]?.({preventDefault(){}})}};elements.set(id,n);return n};
  const document=node('document');document.body=node('body');document.querySelector=s=>node(s.slice(1));document.querySelectorAll=()=>['readyView','progressView','launchView'].map(node);
  const window=node('window');window.__TAURI__={core:{invoke:async name=>{calls.push(name);if(name==='bootstrap_state')return {installed:true,auto_launch:false,external_runtime:external,install_dir:'D:\\Existing'};if(name==='runtime_status')return running;if(name==='enter_application'&&failEntry)throw Error('entry failed')}},event:{listen:async(name,fn)=>{events[name]=fn;return()=>{}}}};
  vm.runInNewContext(source,{window,document,setInterval(){},clearInterval(){},setTimeout: fn => { queueMicrotask(fn); return 1; },clearTimeout(){},console});return {node,calls,events};
}
test('attached server enters without start/update ownership and hides empty logs',async()=>{
  const h=fixture({external:true,running:true});await new Promise(setImmediate);
  assert.equal(h.node('enterButton').disabled,false);
  for(const id of ['startBackend','stopBackend','updateRuntime'])assert.equal(h.node(id).hidden,true);
  assert.equal(h.node('logDetails').hidden,true);
  h.events['runtime-log']({payload:{line:'  \n'}});
  assert.equal(h.node('logDetails').hidden,true);
  for (const id of ['startBackend','stopBackend','cleanupRuntime','updateRuntime']) await h.node(id).emit('click');
  for (const command of ['start_backend','stop_backend','cleanup_runtime','update_runtime']) assert.ok(!h.calls.includes(command));
  await h.node('enterButton').emit('click');assert.equal(h.calls.at(-1),'enter_application');
  assert.ok(!h.calls.includes('start_backend'));
  h.events['runtime-log']({payload:{line:'actual output'}});
  assert.equal(h.node('logDetails').hidden,false);
  assert.match(h.node('installLog').textContent,/actual output/);
});
test('stopped managed runtime offers one-click startup; entry failures appear in logs',async()=>{
  const h=fixture({running:false,failEntry:true});await new Promise(setImmediate);
  assert.equal(h.node('enterButton').disabled,false);
  assert.equal(h.node('enterButton').attributes['aria-label'],'启动并进入');
  await h.node('enterButton').emit('click');
  assert.match(h.node('installLog').textContent,/entry failed/);
  assert.equal(h.node('logDetails').hidden,false);
});
