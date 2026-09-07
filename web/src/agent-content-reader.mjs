// AgentContentPage wire contract: engine/src/web/agent-content-detail.ts.
// Pure reader helpers. No runtime/model/state-changing API dependencies.
export const contentViews = ['report', 'timeline', 'messages', 'delegation']
export const isRunning = status => status === 'running' || status === 'pending'
export const defaultContentView = status => isRunning(status) ? 'timeline' : 'report'
export const sameIdentity = (a, b) => a.ownerSessionId === b.ownerSessionId && a.taskId === b.taskId && a.runGeneration === b.runGeneration
export const validIdentity = value => typeof value.ownerSessionId === 'string' && !!value.ownerSessionId && typeof value.taskId === 'string' && !!value.taskId && Number.isSafeInteger(value.runGeneration) && value.runGeneration > 0
export const acceptsPreview = (preview, identity) => validIdentity(identity) && preview?.channel === 'visible' && preview.runGeneration === identity.runGeneration && typeof preview.text === 'string' && typeof preview.truncated === 'boolean'
export function contentUrl(identity, view, cursor, refresh = false) {
  if (!validIdentity(identity) || !contentViews.includes(view) || (refresh && (!cursor || view !== 'timeline'))) throw new Error('所属会话、任务、轮次或读取方式无效')
  const query = new URLSearchParams({ sessionId: identity.ownerSessionId, taskId: identity.taskId, runGeneration: String(identity.runGeneration), view, pageChars: '16000' })
  if (cursor) query.set('cursor', cursor)
  if (refresh) query.set('refresh', 'true')
  return `/api/agent-content?${query}`
}
const partStates = ['complete', 'truncated', 'missing', 'unavailable']
export function mergeFragment(previous, incoming) {
  if (!incoming || !partStates.includes(incoming.state) || typeof incoming.text !== 'string' || !Number.isSafeInteger(incoming.offset) || incoming.offset < 0 || !Number.isSafeInteger(incoming.totalChars) || incoming.totalChars < 0 || typeof incoming.hasMore !== 'boolean') throw new Error('内容分片格式无效')
  const end = incoming.offset + incoming.text.length
  if (end > incoming.totalChars || incoming.hasMore !== (end < incoming.totalChars)) throw new Error('内容分片范围无效')
  if (previous && (previous.totalChars !== incoming.totalChars || previous.state !== incoming.state)) throw new Error('分片源内容已改变，请重新读取')
  const text = previous?.text ?? ''
  if (incoming.offset > text.length) throw new Error('内容分片缺页，请重新读取')
  const overlap = Math.min(text.length - incoming.offset, incoming.text.length)
  if (text.slice(incoming.offset, incoming.offset + overlap) !== incoming.text.slice(0, overlap)) throw new Error('内容分片冲突，请重新读取')
  const merged = text + incoming.text.slice(overlap)
  return { ...incoming, offset: 0, text: merged, hasMore: merged.length < incoming.totalChars }
}
export function emptyContent() { return { page: null, items: [], fragment: null } }
export function mergeContent(previous, page, identity, view, mode = 'next') {
  if (!page || !sameIdentity(page, identity)) throw new Error('响应所属会话、任务或轮次不匹配，已丢弃')
  if (!['complete', 'partial', 'missing', 'unavailable'].includes(page.state)) throw new Error('未知内容读取状态')
  for (const field of ['nextCursor', 'refreshCursor', 'snapshotId']) if (page[field] !== undefined && (typeof page[field] !== 'string' || !page[field])) throw new Error('响应游标或快照无效')
  const prior = mode === 'start' ? emptyContent() : previous
  // An incremental refresh deliberately advances snapshotId; a next page must not.
  if (mode === 'next' && prior.page?.snapshotId && page.snapshotId && prior.page.snapshotId !== page.snapshotId) throw new Error('分页快照已改变，请重新读取')
  if (mode === 'refresh' && (view !== 'timeline' || !prior.page?.refreshCursor || prior.page.nextCursor)) throw new Error('尚未读完快照，不能增量刷新')
  if (page.state === 'partial' && !page.nextCursor) throw new Error('分页未完成但未提供继续游标')
  if (page.nextCursor && page.refreshCursor) throw new Error('分页与刷新游标冲突')
  if (page.state === 'unavailable') return { ...prior, page }
  if (view === 'timeline') {
    if (!Array.isArray(page.items) && page.state !== 'missing') throw new Error('过程页未提供 items')
    const items = prior.items.slice()
    const index = new Map(items.map((item, i) => [item.id, i]))
    for (const item of page.items ?? []) {
      if (!item || typeof item.id !== 'string' || !item.id || !['assistant', 'tool_use', 'tool_result'].includes(item.kind)) throw new Error('过程条目身份或类型无效')
      const i = index.get(item.id), old = i === undefined ? undefined : items[i]
      if (old && (old.kind !== item.kind || old.messageId !== item.messageId || old.toolUseId !== item.toolUseId || old.toolName !== item.toolName)) throw new Error('过程条目身份冲突')
      const merged = { ...item, content: mergeFragment(old?.content, item.content) }
      if (i === undefined) { index.set(item.id, items.length); items.push(merged) } else items[i] = merged
    }
    return { page, items, fragment: null }
  }
  if (view === 'delegation' && page.delegation && page.delegation.scope !== 'task') throw new Error('未知委派 scope；不展示上下文或续跑指令')
  const fragment = view === 'delegation' ? page.delegation?.prompt : view === 'messages' ? page.messages?.content : page.report?.content
  if (!fragment && page.state !== 'missing') throw new Error('读取页未提供正文')
  return { page, items: [], fragment: fragment ? mergeFragment(prior.fragment, fragment) : null }
}
export const fragmentComplete = fragment => !!fragment && fragment.state === 'complete' && !fragment.hasMore && fragment.text.length === fragment.totalChars
export const partLabel = part => ({ complete: '已保存内容完整', truncated: '源已截断，不是全文', missing: '未提供', unavailable: '不可获取' })[part?.state] || '未提供'
export function exportScope(content, view) {
  const page = content.page
  if (!page || page.nextCursor || page.state !== 'complete' || page.pendingTail) return '已加载预览（非全文）'
  if (view === 'timeline') return content.items.every(item => fragmentComplete(item.content)) ? '当前已保存过程快照全文（不代表任务完成）' : '已保留过程预览（含截断或不可获取内容，非全文）'
  if (!fragmentComplete(content.fragment)) return '已保留内容预览（非全文）'
  if (view === 'messages') return '消息全文'
  if (view === 'delegation') return '任务级脱敏委派正文全文（不是本轮续跑指令）'
  return page.report?.reportStatus === 'completed' ? '已保存报告全文（报告标记：completed）' : page.report?.reportStatus === 'incomplete' ? '已保存报告全文（报告未完成：incomplete）' : '已保存报告全文（报告完成状态未提供）'
}
export function canExportFull(content, view) {
  if (!content.page || ['missing', 'unavailable'].includes(content.page.state)) return false
  return view === 'timeline' ? content.items.every(item => item.content.state === 'complete') : content.fragment?.state === 'complete'
}
export function contentText(content, view) {
  if (view !== 'timeline') return content.fragment?.text ?? ''
  return content.items.map(item => {
    const header = item.kind === 'assistant' ? '可展示正文' : `${item.kind} · ${item.toolName || '工具名未提供'} · 调用 ID：${item.toolUseId || '未提供'} · 调用状态：${item.status || 'unknown'}`
    const object = item.kind === 'tool_use' ? `\n对象：${item.object?.text ?? '未提供'}（${partLabel(item.object)}）` : ''
    return `--- ${header}${object} ---\n${item.content.text}\n[${partLabel(item.content)}${item.content.hasMore ? '；当前分片未读完' : ''}]`
  }).join('\n\n')
}
