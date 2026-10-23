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
// Unchanged full snapshots must not steal focus from the last real update.
export function useToolObservation(lines, session, runtimeSignal = () => []) {
  const pinned = ref(null), selected = ref(null)
  let timer, lastSwitch=0, revision=0, seen=new Map(), revisions=new Map()
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
  watch(session,()=>{clearTimeout(timer);pinned.value=null;selected.value=null;seen.clear();revisions.clear();lastSwitch=0},{flush:'sync'})
  watch(()=>tools.value.map(l=>[l.id,[l.activity,l.observation,l.toolDisplay,l.toolStream,l.titleStatus,l.text,l.resources,l.timing?.status,...runtimeSignal(l)]]),entries=>{
    const ids=new Set(entries.map(e=>e[0]))
    for(const [id,parts] of entries)if(!seen.has(id)||parts.length!==seen.get(id).length||parts.some((part,i)=>seen.get(id)[i]!==part)){seen.set(id,parts);revisions.set(id,++revision)}
    for(const id of seen.keys())if(!ids.has(id)){seen.delete(id);revisions.delete(id)}
    if(pinned.value!==null&&!tools.value.some(l=>l.id===pinned.value&&eligible(l)))pinned.value=null
    pick()
  },{immediate:true})
  onBeforeUnmount(()=>clearTimeout(timer))
  return {pinned,lastId,observed:computed(()=>tools.value.find(l=>l.id===selected.value)),pinnedLine:computed(()=>tools.value.find(l=>l.id===pinned.value)),toggle(line){if(!eligible(line))return;pinned.value=pinned.value===line.id?null:line.id}}
}
