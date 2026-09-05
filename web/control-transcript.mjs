// Pure display conversion. Never import the engine or interpret reported content.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' ? value : ''
const printable = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''

// StreamingMarkdown is reused for a conservative, resource-free subset only.
// Brackets/angle brackets can introduce links, images or HTML; preserve those
// messages literally instead. Do not "sanitize" HTML and then use v-html.
export function canRenderMarkdown(value) {
  return typeof value === 'string' && !/[<>\[\]]|(?:[a-z][a-z\d+.-]*:|www\.)/i.test(value)
}

export function sessionEndpoint(deviceId, sessionId) {
  for (const value of [deviceId, sessionId]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 ||
        value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/.test(value)) {
      throw new Error('URL 缺少或包含无效的 deviceId / sessionId')
    }
  }
  return `/api/sessions/${encodeURIComponent(deviceId)}/${encodeURIComponent(sessionId)}`
}

function convertBlock(block) {
  if (!record(block)) return { type: 'unknown', text: printable(block) }
  switch (block.type) {
    case 'text':
    case 'thinking':
      return { type: block.type, text: text(block.text) }
    case 'tool_use':
      return { type: 'tool_use', name: text(block.name), toolUseId: text(block.id), text: printable(block.input) }
    case 'tool_result':
      return { type: 'tool_result', name: text(block.name), toolUseId: text(block.toolUseId), ok: block.ok === true, text: printable(block.output) }
    case 'image':
      // Intentionally omit data/storage references: no image or local-file reads.
      return { type: 'image', text: `图片未加载：${text(block.label) || text(block.imageId) || '未命名图片'}${text(block.mimeType) ? ` (${block.mimeType})` : ''}。资源文件不随会话文本上传。` }
    default:
      return { type: 'unknown', text: printable(block) }
  }
}

/**
 * Convert engine SessionTranscriptEntry JSONL to a read-only display timeline.
 * compact retains display history (not replacementMessages/model resume state).
 * reset clears prior display entries/title, as SessionStore.loadTranscript does.
 * An incomplete final line is ignored without ever repairing/writing the source.
 */
export function parseControlTranscript(transcript) {
  if (typeof transcript !== 'string') throw new TypeError('transcript 必须是 JSONL 字符串')
  const result = { title: '', entries: [], warnings: [], incompleteTail: false }
  const lines = transcript.replace(/^\uFEFF/, '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '')
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      if (index === lines.length - 1 && !transcript.endsWith('\n')) {
        result.incompleteTail = true
      } else {
        result.warnings.push(`第 ${index + 1} 行 JSON 损坏，已跳过。`)
      }
      continue
    }
    if (!record(entry) || typeof entry.type !== 'string' || typeof entry.agentId !== 'string') {
      result.warnings.push(`第 ${index + 1} 行不是有效的会话记录，已跳过。`)
      continue
    }
    const common = { key: `line-${index + 1}`, agentId: entry.agentId, createdAt: text(entry.createdAt) }
    switch (entry.type) {
      case 'title':
        if (text(entry.title).trim()) result.title = entry.title.trim().replace(/\s+/g, ' ')
        break
      case 'message': {
        const message = entry.message
        if (!record(message) || typeof message.role !== 'string' || !Array.isArray(message.blocks)) {
          result.warnings.push(`第 ${index + 1} 行 message 格式无效，已跳过。`)
          break
        }
        result.entries.push({ ...common, type: 'message', id: text(message.id), role: message.role,
          createdAt: text(message.createdAt), blocks: message.blocks.map(convertBlock) })
        break
      }
      case 'compact':
        result.entries.push({ ...common, type: 'compact', reason: text(entry.reason),
          windowNumber: Number.isSafeInteger(entry.windowNumber) ? entry.windowNumber : null,
          report: entry.report === undefined ? '' : printable(entry.report),
          replacementCount: Array.isArray(entry.replacementMessages) ? entry.replacementMessages.length : 0 })
        break
      case 'reset':
        result.title = ''
        result.entries = [{ ...common, type: 'notice', text: '会话已重置；此前记录不再展示。' }]
        break
      case 'content-replacement':
        result.entries.push({ ...common, type: 'notice', text: '工具结果上下文替换记录（原始展示历史保留；不会读取本地结果文件）。' })
        break
      case 'app-prompt':
      case 'fast-mode':
      case 'context-window':
        result.entries.push({ ...common, type: 'notice', text: `会话配置记录：${entry.type}（仅记录，不应用配置）` })
        break
      default:
        result.entries.push({ ...common, type: 'notice', text: `未支持的记录类型：${entry.type}（未执行）` })
    }
  }
  return result
}
