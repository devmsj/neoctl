// Short status beside the elapsed clock. Never include tool names or help text.
export function executionLabel({ loading, runState, phase, compactSaving, busy, image, imagePending, imageQueued, outputKind } = {}) {
  if (loading) return '加载会话'
  if (runState === 'paused') return '已暂停'
  if (runState === 'interrupted') return '已中断'
  if (runState === 'resuming') return '恢复中'
  if (phase === 'compacting' || (compactSaving && !busy)) return '压缩中'
  if (image) return imageQueued ? '排队中' : imagePending ? '加载图片' : '生成图片'
  if (phase === 'calling_model') return outputKind === 'text' ? '生成回复' : outputKind === 'tool_call' ? '准备工具' : '调用模型'
  return ({ ready: '就绪', preparing: '准备中', running: '执行中', thinking: '思考中', running_tools: '执行工具', injecting_context: '更新上下文', retrying: '重试中', stopped: '已暂停', error: '已中断' })[phase] || '处理中'
}
