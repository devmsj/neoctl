import { fallbackDescriptor, fallbackText } from './tool-fallback.mjs'
export function terminalPhase(line, record) {
  const phase = activityPhase(line)
  if (phase === 'interrupted' || phase === 'generating' || phase === 'queued') return phase
  if (record?.lifecycle === 'lost') return 'interrupted'
  if (record?.lifecycle === 'running') return 'running'
  if (record?.lifecycle === 'terminal') return record.exit?.exitCode === 0 ? 'completed' : 'failed'
  const r = line?.observation
  if (r?.status === 'running') return 'running'
  if (r?.status === 'lost') return 'interrupted'
  if (typeof r?.exit_code === 'number') return r.exit_code === 0 ? 'completed' : 'failed'
  return phase
}
export function activityPhase(line) {
  if (line?.toolStream?.phase === 'cancelled' || line?.activity?.phase === 'interrupted') return 'interrupted'
  if (line?.timing?.status==='queued' && line.live) return 'queued'
  if (line?.titleStatus) return line.titleStatus === 'success' ? 'completed' : 'failed'
  return line?.activity?.phase || (line?.live ? 'running' : 'completed')
}
export function activityPurpose(line) {
  const p = line?.activity?.input || {}
  // Explicit model purpose wins; never prepend a tool label or append fallback facts.
  const purpose = [p.purpose,p.description,...(line?.activity ? [] : [line?.toolDisplay?.purpose])].find(value=>typeof value==='string' && value.trim())
  if (purpose) return purpose.trim()
  const d = fallbackDescriptor(line?.toolName || '', p)
  if (!d.key.endsWith('.generic')) return fallbackText(d.key, d.params)
  return line?.toolDisplay?.subject || line?.toolPresentation?.label || line?.title || fallbackText(d.key, d.params)
}
export function activityContent(line) {
  if (!line) return { mode: 'text', text: '' }
  if (line.kind === 'thinking') return { mode: 'thinking', text: line.text || '' }
  const p = line.activity?.input || {}, phase = activityPhase(line), draft = phase === 'generating'
  // Image operations show only the model's prompt, never parameter/result JSON.
  if (line.toolName === 'image_create') return { mode: 'text', text: typeof p.prompt === 'string' ? p.prompt : '' }
  const previews = line.toolDisplay?.previews || []
  const stream = line.toolStream || {}, result = line.observation || {}
  const output = stream.chunks?.length ? stream.chunks.map(c => c.text || '').join('') : [stream.stdout,stream.stderr,stream.output].filter(Boolean).join('\n')
  if(line.toolName==='image_inspect' && Array.isArray(result.images))return {mode:'entries',entries:result.images.map(image=>({name:image.label||image.id,type:'image'}))}
  if (line.toolName === 'plan_update') {
    let items = p.items
    // History is restored structurally by Core; never infer a plan from prose.
    if (Array.isArray(result.items || items)) return { mode: 'plan', items:result.items || items }
  }
  if (!draft && line.toolName==='file_list' && result.type==='file')return {mode:'entries',entries:[{path:result.path,type:'file'}]}
  if (!draft && line.toolName==='file_list' && Array.isArray(result.entries)) return {mode:'entries',entries:result.entries}
  if (!draft && line.toolName==='web_search' && Array.isArray(result.results)) return {mode:'search',results:result.results}
  if (!draft && line.toolName==='file_search' && Array.isArray(result.matches)) return {mode:'matches',matches:result.matches}
  if (!draft && line.toolName==='file_read' && typeof result.content==='string') return {mode:'read',text:result.content}
  if (!draft && line.toolName?.startsWith('subagent_')) {
    if(Array.isArray(result.tasks))return {mode:'tasks',tasks:result.tasks}
    const visible=result.displaySource==='agent_report'||result.displaySource==='visible_text'
    const nested=[result.result,result.output,result.report].find(r=>r&&typeof r==='object'&&(r.displaySource==='agent_report'||r.displaySource==='visible_text'))
    if(visible||nested)return {mode:'text',text:(nested||result).content||''}
  }
  if (line.toolName === 'file_edit') {
    if (draft || phase === 'queued' || phase === 'running') return { mode: 'diff', text: [typeof p.oldString === 'string' ? p.oldString.split('\n').map(s=>'-'+s).join('\n') : '', typeof p.newString === 'string' ? p.newString.split('\n').map(s=>'+'+s).join('\n') : ''].filter(Boolean).join('\n'), draft: true }
    return { mode: 'diff', text: result.patch?.map(h=>`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines||[]).join('\n')}`).join('\n') || previews.filter(x=>x.kind==='diff').map(x=>x.content).join('\n') || line.toolError || '', draft: false }
  }
  if (line.toolName === 'file_write' && (draft || phase === 'queued' || phase === 'running')) return { mode: 'text', text: p.content || '', draft: true }
  if (line.toolName === 'file_write' && result.patch?.length) return {mode:'diff',text:result.patch.map(h=>`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines||[]).join('\n')}`).join('\n')}
  if (line.toolName === 'image_note' && result.recorded?.length) return {mode:'text',text:result.recorded.map(r=>[r.note?.caption,...(r.note?.detectedText||[])].filter(Boolean).join('\n')).join('\n\n')}
  if(line.toolName==='subagent_message')return {mode:'text',text:p.message||line.toolError||''}
  if(line.toolName==='subagent_report')return {mode:'text',text:p.content||line.toolError||''}
  if(line.toolName==='subagent_stop')return {mode:'tasks',tasks:[{...result,task_id:result.task_id||p.task_id}]}
  if (line.toolName === 'framework_feedback') return {mode:'text',text:p.body||p.title||result.title||''}
  if (['terminal_run','terminal_control'].includes(line.toolName)) return { mode:'terminal', command:p.cmd || result.command || previews.find(x=>x.label==='命令')?.content || p.chars || '', text:output || [result.stdout,result.stderr].filter(Boolean).join('\n') || previews.filter(x=>x.label!=='命令').map(x=>x.content).join('\n') || line.toolError || '', phase }
  if (draft) return { mode:'text', text:p.query || p.prompt || p.message || p.content || p.title || p.path || '' }
  return { mode: previews.some(x=>x.kind==='diff') ? 'diff' : line.toolName==='file_read' ? 'read' : 'text', text:output || previews.map(x=>x.content).join('\n') || stream.steps?.map(s=>s.message).join('\n') || line.toolError || (line.toolName?.startsWith('subagent_') ? '' : line.text || '') }
}
export function agentObservation(line,tasks=[]) {
  if(!['subagent_run','subagent_output','subagent_get','subagent_resume'].includes(line?.toolName))return line
  const id=line.observation?.task_id||line.observation?.taskId||line.activity?.input?.task_id
  const task=tasks.find(t=>t.taskId===id)
  if(!task)return line
  const generation=line.observation?.run_generation??line.observation?.runGeneration
  // Never replace an old invocation with the output of a later resumed run.
  if(!Number.isSafeInteger(Number(generation))||Number(generation)!==task.runGeneration)return line
  if(task.result?.availability!=='unavailable'&&typeof task.result?.content==='string')return {...line,observation:{...line.observation,displaySource:'agent_report',content:task.result.content}}
  const visible=task.progress?.visibleText
  if(visible?.channel==='visible'&&visible.redactionVersion===1&&visible.runGeneration===task.runGeneration&&typeof visible.text==='string')return {...line,observation:{...line.observation,displaySource:'visible_text',content:visible.text}}
  return line
}
export function isObservationLine(line) { return isActivityLine(line) || line?.kind === 'thinking' }
export function isActivityLine(line) { return !!line?.toolName && !line.image }
