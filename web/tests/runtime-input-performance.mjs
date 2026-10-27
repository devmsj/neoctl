// Synthetic UI benchmark: no real sessions, model calls or tools. Run against built assets.
import { writeFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const label=process.argv[2]||'baseline', count=Number(process.env.PERF_LINES||1200)
const lines=Array.from({length:count},(_,i)=>i%4===0?{id:i,kind:'user',messageId:'m'+i,text:'请分析这段代码，保留格式。'}:i%4===3?{id:i,kind:'assistant',text:'已完成检查。\n\n- 保留现有交互\n- 检查布局与功能'}:{id:i,kind:'tool',toolName:'file_read',toolUseId:'t'+i,titleStatus:'success',text:'result',activity:{phase:'completed',input:{path:'src/file'+i+'.ts'}},observation:{content:'const value = 1;'}})
lines.push({id:count,kind:'assistant',live:true,text:'正在分析：\n'})
const snapshot=observabilitySnapshot({busy:true,lines,status:{phase:'responding'},runControl:{state:'running',canPause:true}})
const ui=await createObservabilityBrowser(snapshot,undefined,{viewport:{width:1180,height:760}})
try{
 const {page}=ui
 await page.addInitScript(()=>{window.EventSource=class{constructor(){window.perfEvents=this;this.listeners={}}addEventListener(k,fn){this.listeners[k]=fn}close(){}}})
 await page.reload();await page.locator('.composer textarea').waitFor();await page.waitForTimeout(800)
 const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start')
 const result=await page.evaluate(async({id})=>{
  const input=document.querySelector('.composer textarea');input.focus()
  const delays=[],longTasks=[];const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask',buffered:false})
  let seq=0
  const stream=setInterval(()=>window.perfEvents.listeners.delta?.({data:JSON.stringify({sessionId:'obs-session',operations:[{type:'line.text.append',id,text:'流式输出 '+(++seq)+'。'}]})}),50)
  for(let i=0;i<60;i++){
   await new Promise(r=>setTimeout(r,50));const start=performance.now()
   input.value+='a';input.dispatchEvent(new Event('input',{bubbles:true}))
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
   delays.push(performance.now()-start)
  }
  clearInterval(stream);observer.disconnect();delays.sort((a,b)=>a-b)
  return {inputPaintMs:{p50:delays[30],p95:delays[57],max:delays.at(-1)},longTasks:longTasks.length,longTaskMs:longTasks.reduce((a,b)=>a+b,0),streamUpdates:seq,renderedRows:document.querySelectorAll('.virtual-message-row').length,inputLength:input.value.length}
 },{id:count})
 await page.waitForFunction(() => document.querySelector('.messages')?.textContent.includes('流式输出') || document.querySelector('.virtual-message-row:last-child')?.textContent.includes('流式输出'))
 assert.equal(result.inputLength,60)
 assert.deepEqual(ui.errors,[])
 result.streamRendered=true
 const {profile}=await cdp.send('Profiler.stop')
 const nodes=new Map(profile.nodes.map(n=>[n.id,n])), self=new Map()
 for(let i=0;i<(profile.samples||[]).length;i++){const n=nodes.get(profile.samples[i]);const key=n.callFrame.functionName+' '+n.callFrame.url.split('/').at(-1)+':'+(n.callFrame.lineNumber+1);self.set(key,(self.get(key)||0)+(profile.timeDeltas[i]||0)/1000)}
 await mkdir('../desktop/.cache/performance',{recursive:true})
 await writeFile(`../desktop/.cache/performance/${label}.cpuprofile`,JSON.stringify(profile))
 const report={label,count,...result,hotspots:[...self].sort((a,b)=>b[1]-a[1]).slice(0,25),errors:ui.errors}
 await writeFile(`../desktop/.cache/performance/${label}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await ui.close()}
