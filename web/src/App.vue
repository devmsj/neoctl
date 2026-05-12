<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import diff from 'highlight.js/lib/languages/diff'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('vue', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('diff', diff)

const TOOL_COLLAPSED_CHARS = 1800
const CONTEXT_COMPRESSION_WARNING_TOKENS = 100_000
const IMAGE_OPERATION_HINT = '系统提示：用户已附加图片。如果本次请求涉及图片编辑、修改、重绘、换背景、调整风格、修复、去除或局部改动，请调用 image2 工具并使用 mode=edit；默认使用已附加/最近的图片作为源图。图片操作可能较慢，请默认等待最多 10 分钟，不要因为耗时较长就过早放弃；除非工具返回错误或用户撤回/中断。'
const LOCAL_TIPS = [
  '可以让 Neo 制定计划、查找资料、检查文件、运行工具或继续工作流。',
  '按 Ctrl/⌘ + K 可快速聚焦输入框。',
  '输入 /sessions 管理历史会话，输入 /login 配置模型供应商。',
  '粘贴图片后会作为附件随消息一起发送。',
]
const FEATURE_TIP_MIN_MS = 35_000
const FEATURE_TIP_MAX_MS = 110_000
const FEATURE_TIPS = [
  { id: 'workflow', title: '把 Neo 当工作流助手', body: '可以先让它拆计划，再继续调研、检查文件、运行命令或调用工具。' },
  { id: 'new-session', title: '换主题时新建会话', body: '项目、需求或方向切换时，新建会话能让上下文更干净，回答也更稳定。' },
  { id: 'focus-input', title: '快速回到输入框', body: '按 Ctrl/⌘ + K 可以立即聚焦输入框，继续补充需求或追问。' },
  { id: 'enter-send', title: '换行与发送', body: 'Enter 发送；需要多行说明时按 Shift + Enter 换行。' },
  { id: 'interrupt', title: '随时中断任务', body: '任务方向不对或等待太久时，可以点“中断任务”；输入框为空时 Ctrl/⌘ + C 也能中断。' },
  { id: 'sessions', title: '管理历史会话', body: '侧边栏“会话管理”或输入 /sessions 可以恢复、切换和整理历史会话。' },
  { id: 'model-settings', title: '模型配置在这里', body: '需要换模型、接口或 API Key 时，打开“模型配置”，也可以输入 /login。' },
  { id: 'image-attachments', title: '图片可直接粘贴', body: '把图片粘到输入框后会作为附件发送；涉及修图、重绘、换背景时会优先走图片工具。' },
  { id: 'context-compress', title: '上下文过长先压缩', body: '当上下文接近或超过 100k 时，点输入框下方“压缩会话”可减少历史压力。' },
  { id: 'queued-message', title: '忙碌时会排队', body: 'Neo 正在运行时继续发送会进入下一条队列；如果发错了，可以在输入框上方撤回。' },
  { id: 'tool-output', title: '工具输出可展开', body: '较长的工具输出会自动折叠，需要细节时点“展开完整工具输出”。' },
  { id: 'background-tasks', title: '后台任务看右侧', body: '后台 agent 或长任务会显示在右侧“后台任务”，完成、失败、停止状态都会同步。' },
  { id: 'task-complete', title: '任务完成后继续推进', body: '得到结果后，可以直接让 Neo 生成下一步计划、提炼结论或检查遗漏。' },
]
const FEATURE_TIP_REASONS = {
  welcome: '功能提示',
  random: '灵感提示',
  manual: '功能提示',
  new_session: '新会话提示',
  task_complete: '任务完成提示',
  context: '上下文提示',
  image: '图片提示',
  queued: '排队提示',
}
const PANEL_LABELS = {
  chat: '对话工作台',
  sessions: '会话管理',
  tools: '运行时能力',
  settings: '模型配置',
}
const LINE_TITLE_LABELS = {
  Assistant: '助手',
  You: '你',
  User: '你',
  System: '系统',
  Config: '配置',
  Reasoning: '推理过程',
  'Runtime tool': '运行时工具',
}
const TASK_STATUS_LABELS = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已停止',
  queued: '排队中',
  stopped: '已停止',
}
const LOGIN_FIELD_LABELS = {
  'API key': 'API 密钥',
  'Base URL': '接口地址',
  Model: '模型',
  'Fallback model': '备用模型',
  Endpoint: '端点类型',
  'Reasoning effort': '推理强度',
  'Reasoning summary': '推理摘要',
  'Max output tokens': '最大输出 token',
  'Timeout ms': '超时时间（毫秒）',
  'Stream idle timeout ms': '流式空闲超时（毫秒）',
  'Max retries': '最大重试次数',
}
const RUNTIME_TAB_ID_KEY = 'neoctl-web.tabId'
const RUNTIME_SESSION_ID_KEY = 'neoctl-web.sessionId'

const runtimeTabId = getOrCreateRuntimeTabId()
let runtimeSessionId = sessionStorage.getItem(RUNTIME_SESSION_ID_KEY) || ''

function getOrCreateRuntimeTabId() {
  let id = sessionStorage.getItem(RUNTIME_TAB_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(RUNTIME_TAB_ID_KEY, id)
  }
  return id
}

function runtimeUrl(url) {
  const target = new URL(url, window.location.origin)
  target.searchParams.set('tabId', runtimeTabId)
  if (runtimeSessionId) target.searchParams.set('sessionId', runtimeSessionId)
  return `${target.pathname}${target.search}${target.hash}`
}

function rememberRuntimeSession(session) {
  const sessionId = session?.sessionId || ''
  if (!sessionId || sessionId === runtimeSessionId) return
  runtimeSessionId = sessionId
  sessionStorage.setItem(RUNTIME_SESSION_ID_KEY, sessionId)
}

const state = reactive({
  connected: false,
  connecting: true,
  lines: [],
  status: { phase: 'ready', streamedOutputTokens: 0 },
  busy: false,
  queuedInput: undefined,
  backgroundTaskCount: 0,
  backgroundTasks: [],
  backgroundSessionRunCount: 0,
  runningSessionIds: [],
  session: undefined,
  catalog: { commands: [], modelIds: [], reasoning: [] },
  interactive: {},
  tips: [],
  tipIndex: 0,
  sessions: [],
  login: undefined,
  activePanel: 'chat',
  expandedTools: new Set(),
  attachments: [],
  attachmentCounter: 0,
  messageImagePreviews: [],
  liveToolStartedAt: {},
  clockTick: Date.now(),
  composerMetrics: {
    context: { display: 0, target: 0, bump: 0, initialized: false },
    inputTokens: { display: 0, target: 0, bump: 0, initialized: false },
    outputTokens: { display: 0, target: 0, bump: 0, initialized: false },
  },
  featureTip: { visible: true, index: 0, reason: 'welcome', dismissed: false },
  toast: '',
})

const input = ref('')
const composer = ref(null)
const transcript = ref(null)
const loginProvider = ref('')
const loginValues = reactive({})
let es
let toastTimer
let scrollRaf = 0
let clockTimer
let featureTipTimer
let metricsRaf = 0
let previousBackgroundTaskStatuses = new Map()
const renderedLineCache = new Map()

const phaseLabel = computed(() => phaseText(state.status?.phase))

const active = computed(() => isActivePhase(state.status?.phase))
const realSessionTitle = computed(() => {
  const title = state.session?.title?.trim() || ''
  return title && title !== 'neo' ? title : ''
})
const currentTitle = computed(() => realSessionTitle.value || '未命名设计会话')
const currentSessionId = computed(() => state.session?.sessionId || '暂无会话')
const modelName = computed(() => state.status?.metrics?.model || '模型未配置')
const contextPercent = computed(() => {
  const ratio = state.status?.metrics?.contextUsageRatio
  return ratio === undefined ? '—' : `${(ratio * 100).toFixed(1)}%`
})
const inputTokens = computed(() => compactNumber(state.status?.usage?.inputTokens ?? state.status?.metrics?.estimatedInputTokens))
const outputTokens = computed(() => compactNumber(state.status?.usage?.outputTokens ?? state.status?.streamedOutputTokens))
const composerContextValue = computed(() => `${state.composerMetrics.context.display.toFixed(1)}%`)
const composerInputTokens = computed(() => compactNumber(state.composerMetrics.inputTokens.display))
const composerOutputTokens = computed(() => compactNumber(state.composerMetrics.outputTokens.display))
const currentContextTokens = computed(() => Number(state.status?.metrics?.estimatedInputTokens ?? state.status?.usage?.inputTokens ?? 0))
const showCompressionWarning = computed(() => currentContextTokens.value > CONTEXT_COMPRESSION_WARNING_TOKENS)
const visibleTip = computed(() => LOCAL_TIPS[state.tipIndex % LOCAL_TIPS.length])
const currentFeatureTip = computed(() => FEATURE_TIPS[state.featureTip.index % FEATURE_TIPS.length])
const featureTipLabel = computed(() => FEATURE_TIP_REASONS[state.featureTip.reason] || FEATURE_TIP_REASONS.manual)
const filteredSessions = computed(() => state.sessions || [])
const activePanelLabel = computed(() => PANEL_LABELS[state.activePanel] || state.activePanel)
const visibleLines = computed(() => (state.lines || []).filter((line) => !shouldHideLine(line)))

watch(realSessionTitle, (title) => {
  document.title = title || 'neo runtime'
}, { immediate: true })

onMounted(async () => {
  await fetchState()
  connectEvents()
  clockTimer = setInterval(() => { state.clockTick = Date.now() }, 1000)
  showFeatureTip('workflow', 'welcome')
  scheduleFeatureTip()
  window.addEventListener('keydown', handleGlobalKeydown)
})

onBeforeUnmount(() => {
  if (es) es.close()
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  if (metricsRaf) cancelAnimationFrame(metricsRaf)
  if (clockTimer) clearInterval(clockTimer)
  if (featureTipTimer) clearTimeout(featureTipTimer)
  window.removeEventListener('keydown', handleGlobalKeydown)
})

async function fetchState() {
  try {
    const res = await fetch(runtimeUrl('/api/state'))
    if (!res.ok) throw new Error(`state ${res.status}`)
    applySync(await res.json())
  } catch (error) {
    notify(`运行时不可用：${error.message || error}`)
  }
}

function connectEvents() {
  if (es) es.close()
  state.connecting = true
  es = new EventSource(runtimeUrl('/events'))
  es.addEventListener('open', () => {
    state.connected = true
    state.connecting = false
  })
  es.addEventListener('error', () => {
    state.connected = false
    state.connecting = false
  })
  es.addEventListener('sync', (event) => {
    applySync(JSON.parse(event.data))
  })
}

function applySync(payload) {
  const shouldFollow = isTranscriptNearBottom()
  const oldBusy = state.busy
  const oldQueuedInput = state.queuedInput
  const oldSessionId = state.session?.sessionId || ''
  const oldTaskStatuses = new Map(previousBackgroundTaskStatuses)
  state.lines = payload.lines || []
  syncLiveToolTimers(state.lines)
  state.status = payload.status || state.status
  updateComposerMetricTargets()
  state.busy = !!payload.busy
  state.queuedInput = payload.queuedInput
  state.backgroundTaskCount = payload.backgroundTaskCount || 0
  state.backgroundTasks = payload.backgroundTasks || []
  state.backgroundSessionRunCount = payload.backgroundSessionRunCount || 0
  state.runningSessionIds = payload.runningSessionIds || []
  state.session = payload.session
  rememberRuntimeSession(payload.session)
  if (payload.catalog) state.catalog = payload.catalog
  if (payload.interactive) state.interactive = payload.interactive
  if (payload.tips) state.tips = payload.tips
  if (payload.tipIndex !== undefined && state.tipIndex === 0) state.tipIndex = payload.tipIndex
  state.connected = true
  state.connecting = false
  maybeTriggerFeatureTips({ oldBusy, oldQueuedInput, oldSessionId, oldTaskStatuses })
  previousBackgroundTaskStatuses = backgroundTaskStatusMap(state.backgroundTasks)
  pruneRenderedLineCache()
  if (shouldFollow) scheduleTranscriptScrollBottom()
}

async function submit() {
  const text = input.value
  if (!text.trim() && state.attachments.length === 0) return
  if (text.trim() === '/sessions') {
    input.value = ''
    await openSessions()
    return
  }
  if (text.trim() === '/login') {
    input.value = ''
    await openLogin()
    return
  }
  if (text.trim() === '/new') {
    input.value = ''
    await newSession()
    return
  }
  const attachments = [...state.attachments]
  const submitText = textWithAttachmentLabels(textWithImageOperationHint(text, attachments), attachments)
  cacheMessageImagePreviews(attachments)
  input.value = ''
  state.attachments = []
  autosize()
  try {
    const res = await fetch(runtimeUrl('/api/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: submitText, attachments }),
    })
    const body = await res.json()
    if (!res.ok || body?.error) throw new Error(body.error || `submit ${res.status}`)
  } catch (error) {
    notify(error.message || String(error))
  }
}

async function interrupt() {
  await fetch(runtimeUrl('/api/interrupt'), { method: 'POST' })
}

async function retractQueuedInput() {
  const result = await postJson('/api/interrupt', {})
  if (result?.ok !== false) notify('已撤回排队消息')
}

async function compressSession() {
  const result = await postJson('/api/submit', { text: '/compact', attachments: [] })
  if (result?.ok !== false) notify('已请求压缩上下文')
}

async function openSessions() {
  state.activePanel = 'sessions'
  try {
    const res = await fetch(runtimeUrl('/api/sessions'))
    const body = await res.json()
    state.sessions = body.sessions || []
    state.runningSessionIds = body.runningSessionIds || []
  } catch (error) {
    notify(error.message || String(error))
  }
}

async function resumeSession(sessionId) {
  const result = await postJson('/api/sessions/resume', { sessionId })
  if (result?.ok !== false) state.activePanel = 'chat'
}

async function newSession() {
  const result = await postJson('/api/sessions/new', {})
  if (result?.ok !== false) {
    state.activePanel = 'chat'
    notify('已创建新会话')
    showFeatureTip('new-session', 'new_session')
  }
}

async function deleteSession(sessionId) {
  if (!confirm('确定要删除这个已保存会话吗？')) return
  await postJson('/api/sessions/delete', { sessionId })
  await openSessions()
}

async function openLogin(provider) {
  state.activePanel = 'settings'
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''
  try {
    const res = await fetch(runtimeUrl(`/api/login${query}`))
    const body = await res.json()
    state.login = body
    loginProvider.value = body.provider
    Object.keys(loginValues).forEach((key) => delete loginValues[key])
    Object.assign(loginValues, body.values || {})
  } catch (error) {
    notify(error.message || String(error))
  }
}

async function switchLoginProvider() {
  await openLogin(loginProvider.value)
}

async function saveLogin() {
  const result = await postJson('/api/login', { provider: loginProvider.value, values: { ...loginValues } })
  if (result?.ok !== false) notify('模型配置已保存')
}

async function postJson(url, body) {
  try {
    const res = await fetch(runtimeUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await res.json()
    if (!res.ok || value?.error || value?.ok === false) throw new Error(value.error || `request ${res.status}`)
    return value
  } catch (error) {
    notify(error.message || String(error))
    return { ok: false, error: error.message || String(error) }
  }
}

function toggleTool(lineId) {
  if (state.expandedTools.has(lineId)) state.expandedTools.delete(lineId)
  else state.expandedTools.add(lineId)
}

function lineText(line) {
  const text = stripImageOperationHint(stripImageLabels(line.text || ''))
  if (line.kind !== 'tool') return text
  if (state.expandedTools.has(line.id) || text.length <= TOOL_COLLAPSED_CHARS) return text
  return `${text.slice(0, TOOL_COLLAPSED_CHARS)}\n…`
}

function lineTitle(line) {
  if (line.title) return LINE_TITLE_LABELS[line.title] || line.title
  if (line.kind === 'assistant') return '助手'
  if (line.kind === 'user') return '你'
  if (line.kind === 'tool') return '运行时工具'
  if (line.kind === 'thinking') return '推理过程'
  return '系统'
}

function isImage2Line(line) {
  return line?.kind === 'tool' && String(line?.title || '').toLowerCase() === 'image2'
}

function isImage2LiveLine(line) {
  return line?.live && isImage2Line(line)
}

function isImage2PendingReplacementLine(line) {
  return isImage2Line(line) && line?.pendingReplacement === true
}

function shouldHideLine(line) {
  return isGeneratedImageLine(line) && !isImage2Line(line)
}

function lineHasImage2Stage(line) {
  return isImage2LiveLine(line) || isImage2ResultLine(line) || isImage2PendingReplacementLine(line)
}

function syncLiveToolTimers(lines) {
  const activeIds = new Set()
  const now = Date.now()
  for (const line of lines || []) {
    if (!isImage2LiveLine(line)) continue
    const id = String(line.id)
    activeIds.add(id)
    if (!state.liveToolStartedAt[id]) state.liveToolStartedAt[id] = now
  }
  for (const id of Object.keys(state.liveToolStartedAt)) {
    if (!activeIds.has(id)) delete state.liveToolStartedAt[id]
  }
}

function lineElapsedText(line) {
  if (!isImage2LiveLine(line)) return ''
  const startedAt = state.liveToolStartedAt[String(line.id)]
  if (!startedAt) return ''
  return formatDuration(state.clockTick - startedAt)
}

function updateComposerMetricTargets() {
  const ratio = state.status?.metrics?.contextUsageRatio
  animateComposerMetric('context', ratio === undefined ? 0 : ratio * 100)
  animateComposerMetric('inputTokens', Number(state.status?.usage?.inputTokens ?? state.status?.metrics?.estimatedInputTokens ?? 0))
  animateComposerMetric('outputTokens', Number(state.status?.usage?.outputTokens ?? state.status?.streamedOutputTokens ?? 0))
}

function animateComposerMetric(key, target) {
  const metric = state.composerMetrics[key]
  const next = Number.isFinite(target) ? Math.max(0, target) : 0
  if (!metric.initialized) {
    metric.display = next
    metric.target = next
    metric.initialized = true
    return
  }
  if (Math.abs(metric.target - next) < 0.001) return
  metric.target = next
  metric.bump += 1
  startMetricsAnimation()
}

function startMetricsAnimation() {
  if (metricsRaf) return
  const tick = () => {
    let active = false
    for (const metric of Object.values(state.composerMetrics)) {
      const delta = metric.target - metric.display
      if (Math.abs(delta) < 0.01) {
        metric.display = metric.target
        continue
      }
      const speed = Math.min(0.42, Math.max(0.14, Math.abs(delta) > 1000 ? 0.32 : 0.2))
      const overshoot = Math.sin(Date.now() / 90) * Math.min(Math.abs(delta) * 0.018, metric.target * 0.006 + 1)
      metric.display += delta * speed + overshoot
      if (metric.display < 0) metric.display = 0
      active = true
    }
    if (active) metricsRaf = requestAnimationFrame(tick)
    else metricsRaf = 0
  }
  metricsRaf = requestAnimationFrame(tick)
}

function metricBumpClass(key) {
  return `bump-${state.composerMetrics[key].bump % 2}`
}

function pickFeatureTipIndex(id) {
  if (id) {
    const found = FEATURE_TIPS.findIndex((tip) => tip.id === id)
    if (found >= 0) return found
  }
  if (FEATURE_TIPS.length <= 1) return 0
  let next = Math.floor(Math.random() * FEATURE_TIPS.length)
  if (next === state.featureTip.index) next = (next + 1) % FEATURE_TIPS.length
  return next
}

function showFeatureTip(id, reason = 'manual') {
  if (state.featureTip.dismissed) return
  state.featureTip.index = pickFeatureTipIndex(id)
  state.featureTip.reason = reason
  state.featureTip.visible = true
}

function nextFeatureTip() {
  showFeatureTip(undefined, 'manual')
}

function closeFeatureTips() {
  state.featureTip.visible = false
  state.featureTip.dismissed = true
  if (featureTipTimer) clearTimeout(featureTipTimer)
}

function scheduleFeatureTip() {
  if (state.featureTip.dismissed) return
  if (featureTipTimer) clearTimeout(featureTipTimer)
  const span = FEATURE_TIP_MAX_MS - FEATURE_TIP_MIN_MS
  const delay = FEATURE_TIP_MIN_MS + Math.floor(Math.random() * span)
  featureTipTimer = setTimeout(() => {
    showFeatureTip(undefined, 'random')
    scheduleFeatureTip()
  }, delay)
}

function backgroundTaskStatusMap(tasks = []) {
  return new Map(tasks.map((task) => [String(task.taskId || task.agentId || task.description || task.type), task.status]))
}

function maybeTriggerFeatureTips({ oldBusy, oldQueuedInput, oldSessionId, oldTaskStatuses }) {
  if (state.featureTip.dismissed) return
  const newSessionId = state.session?.sessionId || ''
  if (oldSessionId && newSessionId && oldSessionId !== newSessionId) {
    showFeatureTip('new-session', 'new_session')
    return
  }
  if (showCompressionWarning.value && currentFeatureTip.value?.id !== 'context-compress') {
    showFeatureTip('context-compress', 'context')
    return
  }
  if (!oldQueuedInput && state.queuedInput) {
    showFeatureTip('queued-message', 'queued')
    return
  }
  const completedBackgroundTask = state.backgroundTasks.some((task) => {
    const id = String(task.taskId || task.agentId || task.description || task.type)
    const before = oldTaskStatuses.get(id)
    return before && before !== task.status && ['completed', 'failed', 'killed', 'stopped'].includes(task.status)
  })
  if ((oldBusy && !state.busy) || completedBackgroundTask) {
    showFeatureTip('task-complete', 'task_complete')
  }
}

function phaseText(phase = 'ready') {
  const labels = {
    ready: '就绪',
    running: '运行中',
    preparing: '准备中',
    calling_model: '调用模型',
    thinking: '推理中',
    running_tools: '调用工具',
    injecting_context: '注入上下文',
    compacting: '压缩上下文',
    stopped: '已停止',
    error: '出错',
  }
  return labels[phase] || phase
}

function taskStatusText(status) {
  return TASK_STATUS_LABELS[status] || status || '未知'
}

function loginFieldLabel(label) {
  return LOGIN_FIELD_LABELS[label] || label
}

function shouldMarkdown(line) {
  return !['ansi', 'plain', 'diff'].includes(line.format) && ['assistant', 'thinking', 'system', 'tool'].includes(line.kind)
}

function renderLine(line) {
  if (isImage2ResultLine(line)) return renderImage2Result(line)
  const text = lineText(line)
  const key = [line.id, line.kind, line.format, line.title, line.titleStatus, line.live ? '1' : '0', state.expandedTools.has(line.id) ? '1' : '0', text].join('\u001f')
  const cached = renderedLineCache.get(key)
  if (cached !== undefined) return cached
  let html
  if (line.format === 'diff') html = renderDiff(text)
  else if (line.format === 'ansi' || !shouldMarkdown(line)) html = linkify(escapeHtml(stripAnsi(text)))
  else html = sanitizeMarkdown(marked.parse(text || ''))
  renderedLineCache.set(key, html)
  return html
}

function renderDiff(text) {
  return `<pre class="diff-block">${escapeHtml(text)}</pre>`
}

function isImage2ResultLine(line) {
  return isImage2Line(line) && /\b(ok|failed|generated|edited|image\s+(?:generate|edit)\s+failed)\b/i.test(String(line?.text || ''))
}

function renderImage2Stage(line) {
  const images = lineImagePreviews(line)
  if (images.length) return renderImageGrid(images)
  return renderImage2Skeleton(line)
}

function renderImage2Skeleton(line) {
  const text = String(line?.text || '')
  const failed = /\bfail(?:ed)?\b|image\s+(?:generate|edit)\s+failed/i.test(text)
  const title = failed ? '图片生成失败' : isImage2PendingReplacementLine(line) ? '正在整理图片结果…' : '正在生成图片…'
  const detail = failed ? firstNonEmptyLine(text, ['failed', 'image generate failed', 'image edit failed']) : '图片生成可能需要几十秒，请稍候'
  return `<div class="image2-stage ${failed ? 'failed' : 'loading'}"><div class="image2-skeleton" aria-hidden="true"><span></span><span></span><span></span></div><div class="image2-stage-text"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div></div>`
}

function firstNonEmptyLine(text, ignored = []) {
  const ignoreSet = new Set(ignored.map((item) => item.toLowerCase()))
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line && !ignoreSet.has(line.toLowerCase())) || '请展开工具输出查看详情'
}

function renderImageGrid(images) {
  const items = images.map((item, index) => {
    const href = escapeHtml(item.originalUrl || item.previewUrl)
    const src = escapeHtml(item.previewUrl)
    const caption = escapeHtml(imageCaption(item, index))
    const download = escapeHtml(imageDownloadName(item, index))
    return `<figure class="message-image-attachment"><a href="${href}" target="_blank" rel="noreferrer noopener"><img src="${src}" alt="${caption}" /></a><figcaption>${caption}</figcaption><a class="image-download" href="${href}" download="${download}">下载</a></figure>`
  }).join('')
  return `<div class="message-image-attachments image2-output-images">${items}</div>`
}

function renderImage2Result(line) {
  const parsed = parseImage2Result(line.text || '')
  const text = String(line.text || '')
  const status = /\bfail(?:ed)?\b|failed/i.test(text) ? '生成失败' : /^edited\b/i.test(text.trim()) ? '修改完成' : '生成完成'
  const chips = [parsed.count ? `${parsed.count} 张` : '', parsed.model, parsed.size, parsed.quality, parsed.outputFormat, parsed.duration].filter(Boolean)
  const parts = [`<div class="image2-result"><div class="image2-summary"><strong>${escapeHtml(status)}</strong>${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join('')}</div>`]
  if (parsed.prompt) parts.push(`<div class="image2-meta"><span>提示词</span><p>${escapeHtml(parsed.prompt)}</p></div>`)
  if (parsed.revisedPrompt && parsed.revisedPrompt !== parsed.prompt) parts.push(`<div class="image2-meta"><span>修订提示词</span><p>${escapeHtml(parsed.revisedPrompt)}</p></div>`)
  const details = [parsed.provider && `provider: ${parsed.provider}`, parsed.background && `background: ${parsed.background}`, parsed.usage && `usage: ${parsed.usage}`].filter(Boolean)
  if (details.length) parts.push(`<div class="image2-details">${escapeHtml(details.join(' · '))}</div>`)
  parts.push('</div>')
  return parts.join('')
}

function parseImage2Result(text) {
  const raw = String(text || '')
  const compact = raw.replace(/\s+/g, ' ').trim()
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const generated = /^(generated|edited)\s+(\d+)\s+images?/i.exec(lines[0] || compact)
  const detailsLine = lines.find((line) => line.includes(' · ')) || ''
  const detailParts = detailsLine.split(' · ').map((part) => part.trim()).filter(Boolean)
  const durationMs = numberField(compact, ['duration', 'durationMs', 'elapsed', 'elapsedMs'])
  return {
    provider: matchImage2Field(compact, 'provider', ['model', 'prompt']) || detailParts[0] || '',
    model: matchImage2Field(compact, 'model', ['prompt']) || detailParts[1] || '',
    prompt: matchImage2Field(compact, 'prompt', ['size', 'quality', 'outputFormat', 'background', 'returnedImages', 'duration']),
    size: matchImage2Field(compact, 'size', ['quality', 'outputFormat', 'background', 'returnedImages', 'duration']) || detailParts.find((part) => /^\d+x\d+$/i.test(part)) || '',
    quality: matchImage2Field(compact, 'quality', ['outputFormat', 'background', 'returnedImages', 'duration']) || detailParts.find((part) => ['low', 'medium', 'high'].includes(part.toLowerCase())) || '',
    outputFormat: matchImage2Field(compact, 'outputFormat', ['background', 'returnedImages', 'images', 'duration']) || detailParts.find((part) => ['png', 'jpeg', 'jpg', 'webp'].includes(part.toLowerCase())) || '',
    background: matchImage2Field(compact, 'background', ['returnedImages', 'images', 'duration']),
    count: matchImage2Field(compact, 'returnedImages', ['images', 'index', 'duration']) || generated?.[2] || '',
    revisedPrompt: matchImage2Field(compact, 'revisedPrompt', ['raw', 'created', 'data', 'b64_json', 'background', 'output_format', 'quality', 'size', 'usage', 'duration']),
    usage: matchImage2Field(compact, 'usage', ['duration']),
    duration: durationMs === undefined ? '' : formatDuration(durationMs),
  }
}

function matchImage2Field(text, field, nextFields) {
  const next = nextFields.length ? `(?=\\s(?:${nextFields.map(escapeRegExp).join('|')}):)` : '$'
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(field)}:\\s*([\\s\\S]*?)${next}`, 'i')
  const match = pattern.exec(text)
  return match?.[1]?.replace(/\[(?:base64 image|data URL) omitted[^\]]*\]/gi, '').trim().replace(/\s{2,}/g, ' ') || ''
}

function numberField(text, fields) {
  for (const field of fields) {
    const match = new RegExp(`(?:^|\\s)${escapeRegExp(field)}:\\s*(\\d+(?:\\.\\d+)?)\\s*ms?\\b`, 'i').exec(text)
    if (match) return Number(match[1])
  }
  return undefined
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '')}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitizeMarkdown(html) {
  const template = document.createElement('template')
  template.innerHTML = String(html)
  const allowed = new Set(['A', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'S', 'INPUT'])
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(document.createTextNode(node.textContent || ''))
      continue
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value
      const keep = (node.tagName === 'A' && name === 'href' && safeHref(value)) ||
        (node.tagName === 'A' && name === 'title') ||
        (node.tagName === 'CODE' && name === 'class' && /^language-[\w-]+$/.test(value)) ||
        (node.tagName === 'PRE' && name === 'data-lang' && /^[\w-]+$/.test(value)) ||
        (node.tagName === 'INPUT' && ['type', 'checked', 'disabled'].includes(name))
      if (!keep) node.removeAttribute(attr.name)
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noreferrer noopener')
    }
  }
  highlightCodeBlocks(template.content)
  return template.innerHTML
}

function highlightCodeBlocks(root) {
  for (const code of root.querySelectorAll('pre > code')) {
    const language = normalizeCodeLanguage(code.className)
    const source = code.textContent || ''
    const pre = code.parentElement
    if (pre && language) pre.setAttribute('data-lang', language)
    try {
      const result = language && hljs.getLanguage(language)
        ? hljs.highlight(source, { language, ignoreIllegals: true })
        : source.length <= 20000
          ? hljs.highlightAuto(source)
          : undefined
      if (!result) continue
      code.innerHTML = result.value
      code.className = ['hljs', result.language ? `language-${result.language}` : language ? `language-${language}` : ''].filter(Boolean).join(' ')
      if (pre && result.language && !pre.hasAttribute('data-lang')) pre.setAttribute('data-lang', result.language)
    } catch {
      code.textContent = source
    }
  }
}

function normalizeCodeLanguage(className) {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className || '') || /(?:^|\s)lang-([\w-]+)/.exec(className || '')
  if (!match) return ''
  const value = match[1].toLowerCase()
  const aliases = {
    cjs: 'javascript',
    mjs: 'javascript',
    node: 'javascript',
    shell: 'bash',
    zsh: 'bash',
    powershell: 'bash',
    ps1: 'bash',
    python3: 'python',
    yml: 'yaml',
    html: 'xml',
    vue: 'xml',
  }
  return aliases[value] || value
}

function handleKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

function handleGlobalKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    composer.value?.focus()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !input.value) {
    interrupt()
  }
}

async function handlePaste(event) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (!files.length) return
  event.preventDefault()
  for (const file of files) {
    const id = ++state.attachmentCounter
    const label = `[img#${id}]`
    const payload = await fileToDataUrlPayload(file)
    state.attachments.push({ kind: 'image', label, mimeType: payload.mimeType, data: payload.data, previewUrl: payload.previewUrl, name: file.name || `图片 ${id}` })
  }
  notify(`已添加 ${files.length} 张图片附件`)
  showFeatureTip('image-attachments', 'image')
}

function textWithAttachmentLabels(text, attachments) {
  if (!attachments.length) return text
  const suffix = attachments.map((attachment) => attachment.label).join(' ')
  return text.trim() ? `${text.trim()}\n\n${suffix}` : suffix
}

function textWithImageOperationHint(text, attachments) {
  if (!attachments.some((attachment) => attachment.kind === 'image')) return text
  if (!looksLikeImageOperationRequest(text)) return text
  return [
    text.trim(),
    IMAGE_OPERATION_HINT,
  ].filter(Boolean).join('\n\n')
}

function looksLikeImageOperationRequest(text) {
  const value = String(text || '').toLowerCase()
  return /修改|编辑|改图|重绘|换背景|去除|移除|修复|润色|调整|变成|改成|替换|加上|添加|保留|风格|edit|modify|change|replace|remove|retouch|inpaint|outpaint|background|style/.test(value)
}

function stripImageLabels(text) {
  return String(text).replace(/\s*\[img#\d+\]\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

function stripImageOperationHint(text) {
  return String(text).replace(IMAGE_OPERATION_HINT, '').replace(/[ \t]{2,}/g, ' ').trim()
}

function imageLabelsFromText(text) {
  return Array.from(new Set(String(text || '').match(/\[img#\d+\]/g) || []))
}

function cacheMessageImagePreviews(attachments) {
  const previews = attachments
    .filter((attachment) => attachment?.kind === 'image' && attachment.label && attachment.previewUrl)
    .map((attachment) => ({
      label: attachment.label,
      mimeType: attachment.mimeType,
      previewUrl: attachment.previewUrl,
      originalUrl: attachment.previewUrl,
      name: attachment.name,
    }))
  if (!previews.length) return
  const labels = new Set(previews.map((item) => item.label))
  state.messageImagePreviews = [
    ...state.messageImagePreviews.filter((item) => !labels.has(item.label)),
    ...previews,
  ].slice(-100)
}

function lineImagePreviews(line) {
  if (isImage2Line(line)) return image2LineImages(line)
  const images = []
  collectLineImageItems(line, images)
  for (const label of imageLabelsFromText(line?.text)) {
    const cached = state.messageImagePreviews.find((item) => item.label === label)
    if (cached) images.push(cached)
  }
  return dedupeImages(images.map(normalizeImagePreview).filter(Boolean))
}

function image2LineImages(line) {
  const images = []
  collectLineImageItems(line, images)
  for (const generatedLine of generatedImageLinesAfter(line)) collectLineImageItems(generatedLine, images)
  return dedupeImages(images.map(normalizeImagePreview).filter(Boolean))
}

function generatedImageLinesAfter(line) {
  const lines = state.lines || []
  const index = lines.findIndex((item) => item?.id === line?.id)
  if (index < 0) return []
  const result = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const next = lines[cursor]
    if (isGeneratedImageLine(next) && !isImage2Line(next)) {
      result.push(next)
      continue
    }
    if (next?.kind === 'tool' || next?.kind === 'user') break
    if (next?.kind === 'assistant' && String(next?.text || '').trim()) break
  }
  return result
}

function collectLineImageItems(line, images) {
  if (!line || typeof line !== 'object') return
  const collections = [line.images, line.imageAttachments, line.attachments, line.thumbnails]
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue
    for (const item of collection) {
      if (!item || (item.kind && item.kind !== 'image') || (item.type && item.type !== 'image')) continue
      images.push(item)
    }
  }
  if (Array.isArray(line.blocks)) {
    for (const block of line.blocks) {
      if (block?.type === 'image') images.push(block)
    }
  }
  if (line.image) images.push(line.image)
}

function normalizeImagePreview(item) {
  if (!item || typeof item !== 'object') return undefined
  const mimeType = item.mimeType || item.thumbnail?.mimeType || item.original?.mimeType || 'image/png'
  const previewUrl = item.thumbnailSrc || item.thumbnail?.src || item.previewUrl || item.src || item.originalSrc || item.original?.src || dataToImageSrc(item.data, mimeType)
  if (!previewUrl) return undefined
  const originalUrl = item.originalSrc || item.original?.src || item.src || item.previewUrl || previewUrl
  return {
    label: item.label,
    mimeType,
    previewUrl,
    originalUrl,
    name: item.name || item.filename || item.label,
    sizeBytes: item.sizeBytes,
  }
}

function dataToImageSrc(data, mimeType) {
  if (!data || typeof data !== 'string') return ''
  if (data.startsWith('data:')) return data
  return `data:${mimeType || 'image/png'};base64,${data}`
}

function dedupeImages(images) {
  const seen = new Set()
  const result = []
  for (const image of images) {
    const key = image.label || image.previewUrl
    if (seen.has(key)) continue
    seen.add(key)
    result.push(image)
  }
  return result
}

function imageCaption(item, index) {
  return item?.label || (item?.name && !/^\[img#\d+\]$/.test(item.name) ? item.name : `图片 ${index + 1}`)
}

function imageDownloadName(item, index) {
  const ext = mimeExtension(item?.mimeType)
  const base = (item?.name || item?.label || `image-${index + 1}`).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || `image-${index + 1}`
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`
}

function mimeExtension(mimeType) {
  const value = String(mimeType || '').toLowerCase()
  if (value.includes('jpeg')) return 'jpg'
  if (value.includes('webp')) return 'webp'
  if (value.includes('gif')) return 'gif'
  return 'png'
}

function isGeneratedImageLine(line) {
  const title = String(line?.title || '').toLowerCase()
  return title === 'image2' || line?.metadata?.tool === 'image2' || line?.metadata?.generatedImages === true || (line?.kind === 'tool' && /^Generated image \d+$/i.test(String(line?.text || '').trim()))
}

function removeOmittedImageDetails(line) {
  return isGeneratedImageLine(line) && lineImagePreviews(line).length > 0
}

function removeAttachment(label) {
  state.attachments = state.attachments.filter((attachment) => attachment.label !== label)
}

function insertAtCursor(value) {
  const el = composer.value
  const start = el?.selectionStart || input.value.length
  const end = el?.selectionEnd || start
  input.value = input.value.slice(0, start) + value + input.value.slice(end)
  nextTick(() => {
    if (el) el.selectionStart = el.selectionEnd = start + value.length
    autosize()
  })
}

async function fileToDataUrlPayload(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
  const comma = dataUrl.indexOf(',')
  return { mimeType: file.type || 'image/png', data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, previewUrl: dataUrl }
}

function autosize() {
  const el = composer.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.34)}px`
}

function isTranscriptNearBottom(threshold = 96) {
  const el = transcript.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function scheduleTranscriptScrollBottom() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    scrollTranscriptBottom()
  })
}

function scrollTranscriptBottom() {
  const el = transcript.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function pruneRenderedLineCache() {
  if (renderedLineCache.size < 300) return
  const liveIds = new Set(state.lines.map((line) => line.id))
  for (const key of renderedLineCache.keys()) {
    const id = Number(String(key).split('\u001f', 1)[0])
    if (!liveIds.has(id)) renderedLineCache.delete(key)
  }
  if (renderedLineCache.size > 500) renderedLineCache.clear()
}

function notify(message) {
  state.toast = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { state.toast = '' }, 3600)
}

function isActivePhase(phase) {
  return ['running', 'preparing', 'calling_model', 'thinking', 'running_tools', 'compacting', 'injecting_context'].includes(phase)
}

function compactNumber(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '—'
  const n = Math.max(0, Math.round(Number(value)))
  if (n >= 1_000_000) return `${trimFixed(n / 1_000_000)}m`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${trimFixed(n / 1000)}k`
  return String(n)
}

function trimFixed(v) {
  return v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '')
}

function safeHref(value) {
  try {
    const url = new URL(value, window.location.href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol)
  } catch {
    return false
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function linkify(value) {
  return value.replace(/(https?:\/\/[^\s<]+)/g, '<a target="_blank" rel="noreferrer noopener" href="$1">$1</a>')
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand-row logo-only">
        <img class="mark" src="/favicon.svg" alt="neo runtime" />
      </div>

      <nav class="nav">
        <button :class="{ active: state.activePanel === 'chat' }" @click="state.activePanel = 'chat'">⌁ 对话工作台</button>
        <button :class="{ active: state.activePanel === 'sessions' }" @click="openSessions">◇ 会话管理</button>
        <button :class="{ active: state.activePanel === 'settings' }" @click="openLogin()">⚙ 模型配置</button>
      </nav>

      <button class="sidebar-card session-entry" type="button" @click="state.activePanel = 'chat'">
        <div class="eyebrow">当前会话</div>
        <div class="session-title-line"><span class="dot ok"></span><strong>{{ currentTitle }}</strong></div>
        <div class="muted">{{ currentSessionId }}</div>
      </button>

      <section :class="['sidebar-card purple feature-tip-card', { hidden: !state.featureTip.visible }]" aria-live="polite">
        <template v-if="state.featureTip.visible">
          <div class="tip-head">
            <span>{{ featureTipLabel }}</span>
            <button class="close-card" type="button" aria-label="关闭功能提示" @click="closeFeatureTips">×</button>
          </div>
          <strong>{{ currentFeatureTip.title }}</strong>
          <p>{{ currentFeatureTip.body }}</p>
          <button class="tip-next" type="button" @click="nextFeatureTip">换一条提示</button>
        </template>
      </section>

      <div class="sidebar-footer">
        <button @click="newSession">＋ 新建会话</button>
        <button @click="interrupt">⌘ 中断任务</button>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="crumb"><span>⌘</span> 工作空间 / {{ activePanelLabel }}</div>
        <div class="top-actions">
          <button class="ghost" @click="openLogin()">配置模型</button>
          <button class="primary" @click="newSession">+ 新建</button>
        </div>
      </header>

      <section v-if="state.activePanel === 'chat'" class="content-grid chat-grid">
        <div class="chat-panel">
          <div ref="transcript" class="transcript">
            <article v-for="line in visibleLines" :key="line.id" :class="['message', line.kind || 'system', { live: line.live }]">
              <div class="message-marker">{{ line.kind === 'tool' ? '◆' : line.kind === 'assistant' ? '●' : line.kind === 'user' ? '○' : '◇' }}</div>
              <div class="message-body">
                <div class="message-head">
                  <strong>{{ lineTitle(line) }}</strong>
                  <span v-if="line.titleStatus">{{ line.titleStatus }}</span>
                  <span v-if="line.live" class="live-pill">实时</span>
                  <span v-if="lineElapsedText(line)" class="elapsed-pill">{{ lineElapsedText(line) }}</span>
                </div>
                <div v-if="lineHasImage2Stage(line)" class="message-text markdown image2-stage-wrap" v-html="renderImage2Stage(line)"></div>
                <template v-else>
                  <div v-if="!removeOmittedImageDetails(line)" class="message-text markdown" v-html="renderLine(line)"></div>
                  <template v-for="images in [lineImagePreviews(line)]" :key="`${line.id}-images`">
                    <div v-if="images.length" class="message-image-attachments">
                      <figure v-for="(item, index) in images" :key="item.label || item.previewUrl" class="message-image-attachment">
                        <a :href="item.originalUrl || item.previewUrl" target="_blank" rel="noreferrer noopener">
                          <img :src="item.previewUrl" :alt="imageCaption(item, index)" />
                        </a>
                        <figcaption>{{ imageCaption(item, index) }}</figcaption>
                        <a class="image-download" :href="item.originalUrl || item.previewUrl" :download="imageDownloadName(item, index)">下载</a>
                      </figure>
                    </div>
                  </template>
                </template>
                <button v-if="line.kind === 'tool' && (line.text || '').length > TOOL_COLLAPSED_CHARS" class="link-button" @click="toggleTool(line.id)">
                  {{ state.expandedTools.has(line.id) ? '收起工具输出' : '展开完整工具输出' }}
                </button>
              </div>
            </article>
          </div>

          <div v-if="state.queuedInput" class="queued">
            <span>已排队的下一条消息：{{ state.queuedInput }}</span>
            <button type="button" @click="retractQueuedInput">撤回</button>
          </div>

          <form class="composer" @submit.prevent="submit">
            <div v-if="state.attachments.length" class="attachments image-attachments">
              <figure v-for="(item, index) in state.attachments" :key="item.label" class="image-attachment">
                <img :src="item.previewUrl" :alt="item.name || `图片 ${index + 1}`" />
                <figcaption>图片 {{ index + 1 }}</figcaption>
                <button type="button" aria-label="移除图片" @click="removeAttachment(item.label)">×</button>
              </figure>
            </div>
            <textarea ref="composer" v-model="input" placeholder="让 Neo 帮你调研、规划、检查文件、调用工具，或继续一个工作流…" @keydown="handleKeydown" @paste="handlePaste" @input="autosize"></textarea>
            <div class="composer-footer">
              <div class="composer-metrics" aria-label="运行状态指标">
                <span class="metric-chip model-chip"><em>模型</em><strong>{{ modelName }}</strong></span>
                <span :class="['metric-chip numeric', metricBumpClass('context')]" :key="`context-${state.composerMetrics.context.bump}`"><em>上下文</em><strong>{{ composerContextValue }}</strong></span>
                <span :class="['metric-chip numeric', metricBumpClass('inputTokens')]" :key="`input-${state.composerMetrics.inputTokens.bump}`"><em>输入</em><strong>{{ composerInputTokens }}</strong></span>
                <span :class="['metric-chip numeric', metricBumpClass('outputTokens')]" :key="`output-${state.composerMetrics.outputTokens.bump}`"><em>输出</em><strong>{{ composerOutputTokens }}</strong></span>
                <span class="compress-wrap">
                  <button type="button" class="compact-button" :disabled="active" @click="compressSession">压缩会话</button>
                  <span v-if="showCompressionWarning" class="compression-warning" role="alert">上下文已超过 100k，请压缩上下文</span>
                </span>
              </div>
              <div>
                <button type="button" class="ghost" @click="interrupt">停止</button>
                <button type="submit" class="primary" :disabled="!input.trim() && !state.attachments.length">发送 ↵</button>
              </div>
            </div>
          </form>
        </div>

        <aside class="right-panel">
          <section class="status-card compact-status">
            <div :class="['runtime-phase', { active }]">{{ active ? '●' : '✓' }} {{ phaseLabel }}</div>
            <dl>
              <div><dt>模型</dt><dd>{{ modelName }}</dd></div>
              <div><dt>上下文</dt><dd>{{ contextPercent }}</dd></div>
              <div><dt>Token</dt><dd>↑ {{ inputTokens }} / ↓ {{ outputTokens }}</dd></div>
            </dl>
          </section>
          <section>
            <div class="panel-title">后台任务</div>
            <div v-if="!state.backgroundTasks.length" class="empty-mini">暂无后台任务</div>
            <div v-for="task in state.backgroundTasks" :key="task.taskId || task.agentId" class="task-row">
              <strong>{{ task.type }}</strong>
              <span>{{ taskStatusText(task.status) }}</span>
              <small>{{ task.description || task.agentId || task.taskId }}</small>
            </div>
          </section>
        </aside>
      </section>

      <section v-else-if="state.activePanel === 'sessions'" class="content-grid single">
        <div class="panel-page">
          <div class="page-head">
            <div><h2>会话管理</h2><p>恢复、删除或新建 Neo 会话。正在运行的会话可以重新接入。</p></div>
            <button class="primary" @click="newSession">+ 新建会话</button>
          </div>
          <div v-if="!filteredSessions.length" class="empty-state">暂无已保存会话。</div>
          <div class="session-list">
            <article v-for="session in filteredSessions" :key="session.sessionId" class="session-card">
              <div>
                <strong>{{ session.title || '未命名会话' }}</strong>
                <p>{{ session.sessionId }}</p>
                <small>{{ session.updatedAt || session.createdAt }}</small>
              </div>
              <div class="session-actions">
                <span v-if="state.runningSessionIds.includes(session.sessionId)" class="live-pill">运行中</span>
                <button @click="resumeSession(session.sessionId)">打开</button>
                <button class="danger" @click="deleteSession(session.sessionId)">删除</button>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section v-else-if="state.activePanel === 'settings'" class="content-grid single">
        <div class="panel-page">
          <div class="page-head">
            <div><h2>模型配置</h2><p>配置与 neo web 相同的模型供应商参数，并保存到 Neo 环境配置中。</p></div>
            <button class="primary" @click="saveLogin" :disabled="!state.login">保存</button>
          </div>
          <div v-if="!state.login" class="empty-state">正在加载配置…</div>
          <form v-else class="settings-form" @submit.prevent="saveLogin">
            <label>
              <span>供应商</span>
              <select v-model="loginProvider" @change="switchLoginProvider">
                <option v-for="provider in state.login.providers" :key="provider" :value="provider">{{ provider }}</option>
              </select>
            </label>
            <label v-for="field in state.login.fields" :key="field.key">
              <span>{{ loginFieldLabel(field.label) }} <em v-if="field.required">必填</em></span>
              <select v-if="field.options" v-model="loginValues[field.key]">
                <option v-for="option in field.options" :key="option" :value="option">{{ option || '（空）' }}</option>
              </select>
              <input v-else v-model="loginValues[field.key]" :type="field.secret ? 'password' : 'text'" :placeholder="field.placeholder || field.envKey" />
              <small>{{ field.envKey }}</small>
            </label>
          </form>
        </div>
      </section>

      <section v-else class="content-grid single">
        <div class="panel-page">
          <h2>运行时能力概览</h2>
          <p>这些能力由当前 SPA 后面的 neoctl 运行时提供。</p>
          <div class="capability-grid">
            <div v-for="item in ['流式模型循环', '工具执行', '上下文指标', '会话恢复', '后台代理', '登录配置', '图片附件', 'Markdown 输出']" :key="item" class="capability-card">{{ item }}</div>
          </div>
        </div>
      </section>
    </main>

    <div v-if="state.toast" class="toast">{{ state.toast }}</div>
  </div>
</template>
