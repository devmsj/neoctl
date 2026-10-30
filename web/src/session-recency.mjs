// Shared sidebar ordering: activity, not opening a session, changes its date.
export const sessionKey = item => `${item?.ownerUsername || ''}:${item?.sessionId || ''}`
export function sessionTimestamp(item) {
  for (const value of [item?.updatedAt, item?.createdAt]) {
    const time = typeof value === 'number' ? value : Date.parse(value || '')
    if (Number.isFinite(time)) return time
  }
  return 0
}
export function mergeSessionActivity(rows, current) {
  if (!current?.sessionId) return rows
  const index = rows.findIndex(item => sessionKey(item) === sessionKey(current))
  if (index < 0) return rows
  const previous = rows[index]
  const updatedAt = sessionTimestamp(current) > sessionTimestamp(previous) ? current.updatedAt || current.createdAt : previous.updatedAt
  if (previous.title === (current.title || previous.title) && previous.updatedAt === updatedAt) return rows
  return rows.map((item, i) => i === index ? { ...item, title: current.title || item.title, updatedAt } : item)
    .sort((a,b) => sessionTimestamp(b) - sessionTimestamp(a))
}
export function sessionDateGroup(item, now = Date.now()) {
  const value = sessionTimestamp(item)
  if (!value) return '更早'
  const today = new Date(now); today.setHours(0,0,0,0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  return value >= +today ? '今天' : value >= +yesterday ? '昨天' : '更早'
}
