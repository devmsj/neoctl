export function terminalObservation(line, tasks=[]) {
  if(!['terminal_run','terminal_control'].includes(line?.toolName))return line
  const id=line.observation?.session_id || line.activity?.input?.session_id
  const task=tasks.find(t=>(t.sessionId===id||t.runId===id)&&t.kind==='terminal')
  if(!task)return line
  return {...line,observation:{...line.observation,status:task.status,exit_code:task.exitCode,command:task.command||line.observation?.command}}
}
// References are exact protocol IDs or labels, never extracted from assistant text.
export function referencedImages(line, sources=[]) {
  if(!['image_inspect','image_note'].includes(line?.toolName))return []
  const p=line.activity?.input||{}
  const refs=line.toolName==='image_inspect'?p.imageRefs:p.notes?.map(n=>n.imageRef)||(p.imageRef?[p.imageRef]:[])
  if(!Array.isArray(refs))return []
  return sources.filter(image=>refs.includes(image.imageId)||refs.includes(image.label))
}

export function reconcileActivitySnapshot(incoming, previous=[]) {
  const byId=new Map(previous.map(line=>[line.id,line]))
  return incoming.map(line=>{
    const old=byId.get(line.id)
    if(!old)return line
    const next={...line}
    for(const key of ['activity','observation','toolDisplay','toolStream','resources']) {
      if(JSON.stringify(old[key])===JSON.stringify(line[key]))next[key]=old[key]
    }
    return next
  })
}
// Only real process/task progress influences automatic follow, not elapsed-time ticks.
export function runtimeActivitySignal(line,tasks=[]) {
  const p=line.activity?.input||{},r=line.observation||{}
  if(['terminal_run','terminal_control'].includes(line.toolName)) {
    const id=r.session_id||p.session_id
    const task=tasks.find(t=>t.kind==='terminal'&&(t.sessionId===id||t.runId===id))
    return task?[task.status,task.exitCode,task.outputRevision?.stdout?.storedBytes,task.outputRevision?.stderr?.storedBytes]:[]
  }
  if(['subagent_run','subagent_get','subagent_output','subagent_resume'].includes(line.toolName)) {
    const id=r.task_id||r.taskId||p.task_id,generation=r.run_generation??r.runGeneration
    const task=tasks.find(t=>t.taskId===id&&t.runGeneration===generation)
    if(task)return [task.status,task.progress?.visibleText?.text,task.result?.content]
  }
  return []
}
