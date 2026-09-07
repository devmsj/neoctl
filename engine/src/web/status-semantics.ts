// Presentation only: never controls execution or infers downstream completion.
export type StatusDomain = 'call' | 'task' | 'delivery' | 'readiness' | 'completeness' | 'launch';
const labels: Record<StatusDomain, Record<string, string>> = {
  call: { running: '调用中', success: '调用成功', failed: '调用失败' },
  task: { pending: '排队中', running: '运行中', completed: '已完成', failed: '失败', killed: '已停止' },
  delivery: { queued: '已入队', queued_for_resume: '已入队，待显式续跑', delivered: '已交付', not_queued: '未入队', failed: '投递失败' },
  readiness: { ready: '结果已就绪', not_ready: '暂无终态结果' },
  completeness: { completed: '完整', incomplete: '不完整' },
  launch: { async_launched: '已异步启动', resumed: '已启动续跑' },
};
export function statusText(domain: StatusDomain, value: unknown): string {
  if (value === undefined || value === null || value === '') return '未提供';
  return labels[domain][String(value)] ?? '未知状态';
}
export function callStatus(line: any) {
  const value = line?.live ? 'running' : line?.titleStatus === 'failure' || line?.kind === 'error' ? 'failed' : line?.titleStatus === 'success' ? 'success' : undefined;
  return { key: value === 'success' ? 'completed' : value ?? 'unknown', label: statusText('call', value) };
}
// Only the anchored, ordered protocol header is eligible. Never search output/error bodies.
export function subagentHeader(output: unknown): Record<string, any> {
  if (output && typeof output === 'object' && !Array.isArray(output)) return output as Record<string, any>;
  if (typeof output !== 'string') return {};
  const match = /^\s*<retrieval_status>([^<>]*)<\/retrieval_status>\s*<task_id>([^<>]*)<\/task_id>\s*<task_type>([^<>]*)<\/task_type>\s*<status>([^<>]*)<\/status>\s*<run_generation>([^<>]*)<\/run_generation>\s*<pending_messages>([^<>]*)<\/pending_messages>\s*<requires_resume>(true|false)<\/requires_resume>\s*<agent_id>([^<>]*)<\/agent_id>\s*<output>/.exec(output);
  if (!match) return {};
  const keys = ['retrieval_status', 'task_id', 'task_type', 'status', 'run_generation', 'pending_messages', 'requires_resume', 'agent_id'];
  const data: Record<string, any> = Object.fromEntries(keys.map((key, i) => [key, match[i + 1]]));
  data.requires_resume = data.requires_resume === 'true';
  return data;
}
export function subagentStatusFacts(name: string, output: unknown, ok?: boolean) {
  const data = subagentHeader(output);
  const facts: { label: string; value: string }[] = [];
  const add = (label: string, domain: StatusDomain, value: unknown) => facts.push({ label, value: statusText(domain, value) });
  add('调用状态', 'call', ok === true ? 'success' : ok === false ? 'failed' : undefined);
  if (name === 'subagent_message') {
    const delivery = ok === false ? 'not_queued' : data.status === 'queued_for_resume' ? data.status : data.delivery_status ?? data.status;
    add('消息交付', 'delivery', delivery);
    if (['queued', 'queued_for_resume'].includes(delivery)) facts.push({ label: '交付说明', value: '仅入队，不代表已交付或完成' });
    if (delivery === 'delivered') facts.push({ label: '交付说明', value: '已进入模型上下文，不代表采纳或完成' });
  } else if (['async_launched', 'resumed'].includes(data.status)) add('启动状态', 'launch', data.status);
  else if (name === 'subagent_run' && ['completed', 'incomplete'].includes(data.status)) add('结果完整性', 'completeness', data.status);
  else if (name !== 'subagent_list') add('任务状态', 'task', data.status);
  if (name === 'subagent_output' || data.retrieval_status !== undefined) add('结果就绪', 'readiness', data.retrieval_status);
  if (data.result_status !== undefined || data.result?.status !== undefined) add('结果完整性', 'completeness', data.result_status ?? data.result?.status);
  if (data.requires_resume === true) facts.push({ label: '后续', value: '需要显式续跑' });
  return facts;
}
