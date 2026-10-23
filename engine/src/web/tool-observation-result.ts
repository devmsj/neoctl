import { sanitizeAgentToolPayload } from './tool-call-detail.js';
// UI projections only. Full results remain in the existing tool detail/output infrastructure.
export function toolObservationResult(name: string, output: unknown): Record<string, unknown> | undefined {
  const data = sanitizeAgentToolPayload(name, output).value;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record=data as Record<string, unknown>;
  const keys: Record<string,string[]> = {
    file_read:['path','content','startLine','endLine','hasMoreAfter'],
    file_list:['path','type','entries','truncated'], file_search:['query','matches','truncated'],
    file_edit:['path','patch','operation','replacements'],file_write:['path','patch','operation'],
    terminal_run:['command','stdout','stderr','exit_code','status','session_id','owner_session_id','output_ref'],
    terminal_control:['command','stdout','stderr','exit_code','status','session_id','owner_session_id','output_ref'],
    web_search:['query','results'],plan_update:['title','items'],
    image_inspect:['images','total','nextOffset'],image_note:['recorded','failed'],framework_feedback:['title','id'],
  };
  const fields=keys[name] || (name.startsWith('subagent_') ? ['tasks','status','task_id','agent_id','result','output','report','content','displaySource','run_generation','runGeneration','taskId','message'] : []);
  let budget=40_000;
  const bound=(value:unknown,depth=0):unknown=>{
    if(budget<=0||depth>12)return undefined;
    if(typeof value==='string'){const text=value.slice(0,Math.min(budget,16000));budget-=text.length;return text}
    if(Array.isArray(value))return value.slice(0,80).map(v=>bound(v,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,40).map(([k,v])=>[k,bound(v,depth+1)]));
    return value;
  };
  return Object.fromEntries(fields.filter(k=>record[k]!==undefined).map(k=>[k,bound(record[k])]));
}
