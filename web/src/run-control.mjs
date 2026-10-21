export function composerRunAction({ running, control = {}, hasDraft, queued, pending, uploading }) {
  const resuming = control.state === 'resuming'
  if (pending || resuming) return { action: 'waiting', label: resuming ? '已接收，等待旧请求取消' : '正在处理', disabled: true }
  if (control.canResume) return hasDraft
    ? { action: 'send', label: '发送新指令', disabled: !!uploading }
    : { action: 'continue', label: '继续', disabled: false }
  if (!running) return { action: 'send', label: '发送 ↵', disabled: !!uploading || !hasDraft }
  if (hasDraft) return { action: 'interrupt-send', label: '打断并发送', disabled: !!uploading }
  if (queued) return { action: 'send-now', label: '立即发送', disabled: false }
  return { action: 'pause', label: '暂停', disabled: !control.canPause }
}
