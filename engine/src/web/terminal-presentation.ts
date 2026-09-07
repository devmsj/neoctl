// Terminal output is not summary text: preserve whitespace and stream identity.
export interface TerminalFact { label: string; value: string; code?: boolean; tone?: 'neutral' | 'warning' | 'danger' }
export interface TerminalPreview { label: string; kind: 'code'; content: string }
const supplied = (value: unknown): string => value === undefined || value === null ? '未提供' : String(value);
export function terminalStatus(data: Record<string, unknown>): string {
  if (data.status === 'running') return '运行中';
  if (data.status === 'lost') return '运行已失联';
  if (data.timed_out === true || data.termination_reason === 'timeout') return '已超时';
  if (['interrupt', 'terminate', 'kill', 'interrupted', 'terminated', 'killed'].includes(String(data.termination_reason)) || ['killed', 'stopped'].includes(String(data.status))) return '已停止';
  if (data.termination_reason === 'failed' || (typeof data.exit_code === 'number' && data.exit_code !== 0)) return '执行失败';
  if (data.exit_code === 0) return '已完成';
  if (data.signal !== undefined && data.signal !== null) return '因信号终止';
  if (data.status === 'exited') return '已退出（结果未提供）';
  return '未提供';
}
export function terminalFacts(data: Record<string, unknown>): TerminalFact[] {
  const facts: TerminalFact[] = [
    { label: '运行状态', value: terminalStatus(data) },
    { label: '退出码', value: supplied(data.exit_code), code: true },
    { label: '信号', value: supplied(data.signal) },
    { label: '终止原因', value: supplied(data.termination_reason) },
    { label: '耗时', value: typeof data.duration_ms === 'number' && Number.isFinite(data.duration_ms) && data.duration_ms >= 0 ? `${data.duration_ms} ms` : '未提供' },
  ];
  if (typeof data.session_id === 'string') facts.push({ label: '终端会话', value: data.session_id, code: true });
  const omitted = data.omitted_chars && typeof data.omitted_chars === 'object' ? data.omitted_chars as Record<string, unknown> : undefined;
  const counts = data.output_chars && typeof data.output_chars === 'object' ? data.output_chars as Record<string, unknown> : undefined;
  for (const stream of ['stdout', 'stderr']) {
    const count = counts?.[stream];
    const missing = omitted?.[stream];
    if (typeof count === 'number') facts.push({ label: `${stream} 本次字符`, value: String(count) });
    if (typeof missing === 'number') facts.push({ label: `${stream} 本次省略`, value: String(missing), ...(missing > 0 ? { tone: 'warning' as const } : {}) });
  }
  return facts;
}
export function terminalPreviews(data: Record<string, unknown>, limit = 1400): TerminalPreview[] {
  const previews: TerminalPreview[] = [];
  for (const stream of ['stdout', 'stderr']) {
    const value = data[stream];
    if (typeof value !== 'string') continue;
    previews.push({ label: `${stream}${data.tty === true && stream === 'stdout' ? '（TTY 合流）' : ''}${value.length > limit ? ' · 预览已截断' : ''}`, kind: 'code', content: value.length > limit ? value.slice(0, limit) : value });
  }
  return previews;
}
export function terminalResultText(data: Record<string, unknown>): string {
  const head = terminalFacts(data).map(fact => `${fact.label}：${fact.value}`);
  for (const stream of ['stdout', 'stderr']) {
    const value = data[stream];
    head.push(`${stream}${data.tty === true && stream === 'stdout' ? '（TTY 合流）' : ''}：`, typeof value === 'string' ? value === '' ? '（本次返回为空）' : value : '未提供');
  }
  return head.join('\n');
}
