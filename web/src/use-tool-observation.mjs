import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isObservationLine } from './tool-activity.mjs'
// A real assistant text block ends the automatic preview phase. Empty streaming
// placeholders, thinking and system messages do not. Later tools begin a new phase.
export function hasUnansweredToolActivity(lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (isObservationLine(line)) return true
    if (line.kind === 'assistant' && typeof line.text === 'string' && line.text.trim()) return false
  }
  return false
}
// Membership and content have separate subscriptions. A token changes one row,
// not the dependency graph of every completed invocation in the transcript.
export function useToolObservation(lines, session, runtimeSignal = () => []) {
  const pinned = ref(null), selected = ref(null), changed = ref(0)
  let timer, lastSwitch=0, revision=0, revisions=new Map(), subscriptions=new Map()
  const tools=computed(()=>lines.value.filter(isObservationLine))
  const lastId=computed(()=>tools.value.at(-1)?.id)
  const eligible=l=>!(l.toolName==='image_create' && (l.titleStatus==='success'||(!l.live&&l.imageCreate))) && !l.resources?.length
  function pick(force=false){
    clearTimeout(timer)
    const candidates=tools.value.filter(l=>eligible(l) && (l.kind!=='thinking' || String(l.text||'').trim()))
    const target=candidates.reduce((best,l)=>!best||(revisions.get(l.id)||0)>(revisions.get(best.id)||0)?l:best,null)
    if(!target){selected.value=null;return}
    if(target.id===selected.value)return
    const delay=800-(Date.now()-lastSwitch)
    if(!force && selected.value!==null && delay>0){timer=setTimeout(()=>pick(),delay);return}
    selected.value=target.id;lastSwitch=Date.now()
  }
  function disposeRows(){for(const item of subscriptions.values())item.stop();subscriptions.clear();revisions.clear()}
  watch(session,()=>{clearTimeout(timer);pinned.value=null;selected.value=null;disposeRows();lastSwitch=0},{flush:'sync'})
  watch(()=>[session(),tools.value],()=>{
    const ids=new Set()
    for(const line of tools.value){
      ids.add(line.id)
      if(subscriptions.get(line.id)?.line===line)continue
      subscriptions.get(line.id)?.stop()
      const stop=watch(()=>[line.activity,line.observation,line.toolDisplay,line.toolStream,line.titleStatus,line.text,line.resources,line.timing?.status,...runtimeSignal(line)],(parts,old)=>{
        if(old&&parts.length===old.length&&parts.every((part,i)=>part===old[i]))return
        revisions.set(line.id,++revision);changed.value++
      },{immediate:true})
      subscriptions.set(line.id,{line,stop})
    }
    for(const [id,item] of subscriptions)if(!ids.has(id)){item.stop();subscriptions.delete(id);revisions.delete(id)}
    changed.value++
  },{immediate:true})
  watch(changed,()=>{
    if(pinned.value!==null&&!tools.value.some(l=>l.id===pinned.value&&eligible(l)))pinned.value=null
    pick()
  },{immediate:true})
  onBeforeUnmount(()=>{clearTimeout(timer);disposeRows()})
  return {pinned,lastId,observed:computed(()=>tools.value.find(l=>l.id===selected.value)),pinnedLine:computed(()=>tools.value.find(l=>l.id===pinned.value)),toggle(line){if(!eligible(line))return;pinned.value=pinned.value===line.id?null:line.id}}
}
