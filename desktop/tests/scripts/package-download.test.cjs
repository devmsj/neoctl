const {test}=require('node:test');
const assert=require('node:assert/strict');
const {packagesFromLock,downloadPackages}=require('../../src-tauri/src/package-download.cjs');
test('download denominator deduplicates archives and excludes root/dev/local/link entries',()=>{
  const pkg={resolved:'https://registry.npmjs.org/a/-/a-1.tgz',integrity:'sha512-a'};
  const list=packagesFromLock({packages:{'':{},'node_modules/a':pkg,'node_modules/b/node_modules/a':pkg,'node_modules/dev':{...pkg,dev:true},'node_modules/local':{resolved:'file:local.tgz'},'node_modules/link':{...pkg,link:true},'node_modules/c':{resolved:'https://registry.npmjs.org/c/-/c-1.tgz'}}});
  assert.equal(list.length,2);
});
test('completed count advances only after verified fetch resolves, bounded concurrency and monotonic progress',async()=>{
 const packages=Array.from({length:13},(_,i)=>({name:'p'+i})),events=[];let active=0,max=0;
 await downloadPackages(packages,async()=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,3));active--;},e=>events.push(e),3);
 assert.equal(max,3);assert.equal(events.length,14);assert.equal(events.at(-1).completed,13);assert.equal(events.at(-1).total,13);assert.equal(events.at(-1).percent,70);
 events.slice(1).forEach((e,i)=>{assert.equal(e.completed,i+1);assert.ok(e.percent>=events[i].percent);});
});
test('failed package is not counted as completed or reported as finished',async()=>{
 const events=[];await assert.rejects(downloadPackages([{name:'good'},{name:'bad'},{name:'later'}],async p=>{if(p.name==='bad')throw Error('integrity mismatch')},e=>events.push(e),1),/integrity/);
 assert.equal(events.at(-1).completed,1);assert.equal(events.at(-1).total,3);assert.ok(events.at(-1).percent<70);
});
test('zero remote dependencies completes safely without invented package counts',async()=>{
 const events=[];assert.equal(await downloadPackages([],()=>{throw Error('should not fetch')},e=>events.push(e)),0);assert.equal(events.length,1);assert.match(events[0].stage,/0 \/ 0/);
});
