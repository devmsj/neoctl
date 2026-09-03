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
import XhsArtifactEditor from './components/XhsArtifactEditor.vue'
import NeoSelect from './components/NeoSelect.vue'
import StreamingMarkdown from './components/StreamingMarkdown.vue'
import { parseXhsArtifactToolOutput, selectNewestXhsArtifact, XHS_ARTIFACT_EDITOR_HINT } from '../plugins/xhs-artifact/xhs-artifact-contract.mjs'

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

const IMAGE_MAX_EDGE = 2048
const IMAGE_MAX_BYTES = 1_800_000
const IMAGE_MIN_QUALITY = 0.62
const SESSION_PAGE_SIZE = 10
const SESSION_PLUGIN_MODE_OPTIONS = [
  { value: 'inherit', label: '跟随全局' },
  { value: 'enabled', label: '启用' },
  { value: 'disabled', label: '关闭' },
]
// Kept only to hide hints already persisted by older web clients. New requests never append them.
const LEGACY_IMAGE_GENERATION_HINT = 'System hint: if the user is asking you to draw, render, create, generate, or illustrate a new image, you must call the image2 tool with mode=generate instead of replying with text-only description. After the tool returns images, continue the response normally so the UI can display them in the conversation.'
const LEGACY_IMAGE_OPERATION_HINT = 'System hint: the user attached an image. If this request involves image editing, modification, redraw, background replacement, style transfer, repair, object removal, or localized changes, you must call the image2 tool with mode=edit and use the attached or most recent image as the source image. Image operations may take a while, so wait up to 10 minutes by default unless the tool returns an error or the user interrupts.'
const LEGACY_DOWNLOAD_EXPOSURE_HINT = 'System hint from web UI: if your final answer produces, creates, modifies, exports, packages, or identifies local files that the user should receive, you must call the expose_downloads tool with all relevant absolute file paths before your final textual response. Do not paste absolute paths as the primary delivery method; expose them as browser downloads.'
const ATTACHMENT_MANIFEST_START = '<<ATTACHMENT_MANIFEST>>'
const ATTACHMENT_MANIFEST_END = '<</ATTACHMENT_MANIFEST>>'
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
  'Context compaction': '上下文压缩',
  Config: '配置',
  Reasoning: '思考',
  'Runtime tool': '运行时工具',
  agent: '子任务',
  edit: '编辑文件',
  exec_command: '执行命令',
  write_stdin: '终端交互',
  expose_downloads: '文件下载',
  grep: '搜索文本',
  image2: '图片生成',
  image_note: '记录图片',
  list: '列出文件',
  load_image: '读取图片',
  plan: '任务计划',
  read: '读取文件',
  search: '网络搜索',
  write: '写入文件',
  read_xhs_artifact: '读取小红书笔记',
  open_xhs_artifact_editor: '编辑小红书笔记',
  SendMessage: '发送协作消息',
  sendmessage: '发送协作消息',
  TaskGet: '读取后台任务',
  taskget: '读取后台任务',
  TaskList: '后台任务列表',
  tasklist: '后台任务列表',
  TaskOutput: '读取任务输出',
  taskoutput: '读取任务输出',
  TaskResume: '继续后台任务',
  taskresume: '继续后台任务',
  TaskStop: '停止后台任务',
  taskstop: '停止后台任务',
  multi_tool_use: '并行执行工具',
  '文件下载': '文件下载',
}
const TASK_STATUS_LABELS = {
  pending: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已停止',
  queued: '排队中',
  stopped: '已停止',
}
const LOGIN_FIELD_LABELS = {
  'API key': 'API Key',
  'Base URL': 'Base URL',
  Model: '模型',
  'Fallback model': '备用模型',
  Endpoint: 'Endpoint',
  'Reasoning effort': '推理强度',
  'Reasoning summary': '推理摘要',
  'Max output tokens': '最大输出 Token',
  'Timeout ms': '请求超时（ms）',
  'Stream idle timeout ms': '流式空闲超时（ms）',
  'Max retries': '最大重试次数',
}
const LOGIN_PROVIDER_LABELS = {
  openai: 'OpenAI',
}
const ACTION_ERROR_MESSAGES = {
  INVALID_REQUEST: '请求参数无效',
  SESSION_ACTIVE: '当前会话不能删除，请先切换到其他会话',
  SESSION_RUNNING: '运行中的会话不能删除，请等待运行结束',
  SESSION_NOT_FOUND: '会话不存在或已被删除',
  SESSION_RESUME_FAILED: '打开会话失败',
  SESSION_CREATE_FAILED: '新建会话失败',
  SESSION_DELETE_FAILED: '删除会话失败',
  PLUGIN_UPDATE_BLOCKED: '模型回答期间不能修改会话插件',
  PLUGIN_NOT_CONFIGURED: '插件功能未配置',
  PLUGIN_INVALID: '插件配置无效',
  PLUGIN_UPDATE_FAILED: '插件配置更新失败',
  PLUGINS_LOCKED: '插件配置已由环境变量锁定',
  TOOL_UPDATE_BLOCKED: '模型回答期间不能修改会话工具',
  TOOL_NOT_CONFIGURED: '工具配置功能未启用',
  TOOL_INVALID: '工具配置无效',
  TOOL_UPDATE_FAILED: '工具配置更新失败',
  PROMPT_UPDATE_FAILED: '提示词更新失败',
  PROMPT_INVALID: '提示词内容无效',
  FAST_MODE_UPDATE_FAILED: '快速模式切换失败',
  CONTEXT_WINDOW_UPDATE_BLOCKED: '回答期间不能调整上下文窗口',
  CONTEXT_WINDOW_INVALID: '请输入大于 0 的整数',
  CONTEXT_WINDOW_UPDATE_FAILED: '上下文窗口调整失败',
  LOGIN_INVALID: '模型配置无效',
  LOGIN_SAVE_FAILED: '模型配置保存失败',
  API_NOT_FOUND: '当前运行时不支持此功能，请重启服务',
  WEB_REQUEST_FAILED: '请求处理失败',
}
const CPA_PASSWORD_MASK = '••••••••••••••••••'
const RUNTIME_TAB_ID_KEY = 'neoctl-web.tabId'
const RUNTIME_SESSION_ID_KEY = 'neoctl-web.sessionId'
const THEME_STORAGE_KEY = 'neoctl-web.theme'
let runtimeTabId = getOrCreateRuntimeTabId()
let runtimeSessionId = sessionStorage.getItem(RUNTIME_SESSION_ID_KEY) || ''
let allowRuntimeSessionChange = !runtimeSessionId
let runtimeSessionRepairing = false

const DEFAULT_APP_PROMPT_LIBRARY = [
  {
    id: 'product-copilot',
    title: '产品副驾',
    content: '你当前承担应用层产品副驾角色。优先关注产品意图、用户目标、体验取舍、边界情况、上线风险与下一步决策。回答要清晰、结构化、以判断和推进为主。',
  },
  {
    id: 'frontend-crafter',
    title: '前端工匠',
    content: '你当前承担应用层前端工匠角色。优先关注交互细节、布局清晰度、视觉层级、响应式表现和可落地的界面实现建议。提出 UI 方案时要具体、有审美，不要泛泛而谈。',
  },
  {
    id: 'delivery-driver',
    title: '交付推进',
    content: '你当前承担应用层交付推进角色。优先追求执行速度、解除阻塞、减少绕路、快速验证和务实落地。除非用户明确要求分析，否则优先给出直接可执行的下一步。',
  },
]

function createEmptyPromptDraft() {
  return {
    id: '',
    title: '',
    content: '',
    usage: '',
  }
}

function clonePromptItem(item) {
  return { ...item }
}

function normalizePromptItem(item) {
  if (!item || typeof item !== 'object') return null
  const title = String(item.title || '').trim()
  const content = String(item.content || '').trim()
  if (!title || !content) return null
  return {
    id: String(item.id || createPromptId()).trim(),
    title,
    content,
    usage: String(item.usage || '').trim(),
  }
}

function createPromptId() {
  return `prompt-${Math.random().toString(36).slice(2, 10)}`
}

function getOrCreateRuntimeTabId() {
  let id = sessionStorage.getItem(RUNTIME_TAB_ID_KEY)
  if (!id) {
    id = randomRuntimeId()
    sessionStorage.setItem(RUNTIME_TAB_ID_KEY, id)
  }
  return id
}

function randomRuntimeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

function runtimeUrl(url) {
  const target = new URL(url, window.location.origin)
  target.searchParams.set('tabId', runtimeTabId)
  if (runtimeSessionId) target.searchParams.set('sessionId', runtimeSessionId)
  return `${target.pathname}${target.search}${target.hash}`
}

function rememberRuntimeSession(session, force = false) {
  const sessionId = session?.sessionId || ''
  if (!sessionId || sessionId === runtimeSessionId) return
  if (!force && !allowRuntimeSessionChange && runtimeSessionId) return
  runtimeSessionId = sessionId
  allowRuntimeSessionChange = false
  sessionStorage.setItem(RUNTIME_SESSION_ID_KEY, sessionId)
}

const state = reactive({
  connected: false,
  connecting: true,
  lines: [],
  status: { phase: 'ready', streamedOutputTokens: 0 },
  appPrompt: { hasActivePrompt: false, activePrompt: undefined },
  runtimeContext: undefined,
  runtimeContextLoading: true,
  runtimeContextError: '',
  runtimeContextModal: '',
  runtimeContextDetail: undefined,
  globalPlugins: { items: [], locked: false, restartRequired: true, loading: false },
  sessionPlugins: { items: [], busy: false, loading: false },
  globalTools: { items: [], loading: false },
  sessionTools: { items: [], busy: false, loading: false },
  fastMode: false,
  fastModeMutating: false,
  contextWindowModalOpen: false,
  contextWindowDraft: '',
  contextWindowError: '',
  contextWindowSaving: false,
  busy: false,
  queuedInput: undefined,
  backgroundTaskCount: 0,
  backgroundTasks: [],
  backgroundSessionRunCount: 0,
  runningSessionIds: [],
  session: undefined,
  cwd: '',
  sessionsLoading: false,
  sessionResumeLoading: false,
  pendingResumeSessionId: '',
  catalog: { commands: [], modelIds: [], reasoning: [] },
  interactive: {},
  sessions: [],
  login: undefined,
  cpaConfig: { url: '', password: '', hasPassword: false, loaded: false },
  cpaQuotas: [],
  cpaQuotaIndex: 0,
  memory: { current: null, history: [], sampleMs: 60_000, retentionMs: 86_400_000 },
  activePanel: 'chat',
  toolDetailLineId: undefined,
  compactionDetailLineId: undefined,
  backgroundTaskDetail: undefined,
  imagePreview: undefined,
  confirmDialog: {
    open: false,
    title: '',
    message: '',
    confirmLabel: '确认',
    cancelLabel: '取消',
    tone: 'warning',
  },
  promptLibrary: [],
  promptLibraryLoading: true,
  promptManagerOpen: false,
  selectedPromptId: '',
  composerDropActive: false,
  composerDropMode: 'prompt',
  attachments: [],
  attachmentCounter: 0,
  uploadingFiles: false,
  messageImagePreviews: [],
  xhsArtifacts: {},
  liveToolStartedAt: {},
  clockTick: Date.now(),
  composerMetrics: {
    context: { display: 0, target: 0, bump: 0, initialized: false },
    inputTokens: { display: 0, target: 0, bump: 0, initialized: false },
    outputTokens: { display: 0, target: 0, bump: 0, initialized: false },
  },
  toast: '',
})

const input = ref('')
const sessionSearch = ref('')
const sessionPage = ref(1)
const theme = ref(resolveInitialTheme())
const composer = ref(null)
const fileInput = ref(null)
const transcript = ref(null)
const backgroundTaskOutput = ref(null)
const mobileMenu = ref(null)
const loginProvider = ref('')
const loginValues = reactive({})
const promptDraft = reactive(createEmptyPromptDraft())
const draggingPromptId = ref('')
const sortingPromptId = ref('')
const promptSortTargetId = ref('')
const promptSortPosition = ref('before')
const memoryHoverIndex = ref(-1)
let es
let toastTimer
let scrollRaf = 0
let syncRaf = 0
let lineTextRaf = 0
let pendingSyncPayload
let hasReceivedEventSync = false
let clockTimer
let cpaStateTimer
let memoryStateTimer
let metricsRaf = 0
let fastModeMutationQueue = Promise.resolve()
let fastModeMutationVersion = 0
let previousBackgroundTaskStatuses = new Map()
let confirmDialogResolver
const renderedLineCache = new Map()
const pendingLineText = new Map()
const BACKGROUND_TASK_OUTPUT_MAX_CHARS = 40_000

const liveImage2Line = computed(() => [...(state.lines || [])].reverse().find((line) => isImage2LiveLine(line)) || null)
const phaseLabel = computed(() => phaseText(state.status?.phase))
const exactPhaseLabel = computed(() => {
  if (liveImage2Line.value) {
    return isImage2PendingReplacementLine(liveImage2Line.value) ? '整理图片结果' : '图片生成中'
  }
  if (state.status?.phase === 'running_tools') {
    const tool = state.status?.currentTool
    if (String(tool?.name || '').toLowerCase() === 'image2') return '图片生成中'
    if (tool?.name) return `调用 ${tool.name}${tool.kind ? ` · ${tool.kind}` : ''}`
  }
  return phaseLabel.value
})

const active = computed(() => isActivePhase(state.status?.phase))
const showTranscriptLoading = computed(() => active.value || state.busy || state.sessionResumeLoading)
const transcriptLoadingLabel = computed(() => {
  if (state.sessionResumeLoading) return '正在加载会话'
  if (liveImage2Line.value) {
    const elapsed = lineElapsedText(liveImage2Line.value)
    const title = isImage2PendingReplacementLine(liveImage2Line.value) ? '正在载入图片结果' : '图片模型正在生成'
    return elapsed ? `${title} · 已用时 ${elapsed}` : title
  }
  return `正在${exactPhaseLabel.value}`
})
const cleanSessionTitle = (value) => String(value || '').replace(/设计/g, '').trim()
const displaySessionTitle = (session) => cleanSessionTitle(session?.title) || '未命名会话'
const realSessionTitle = computed(() => {
  const title = cleanSessionTitle(state.session?.title)
  return title && title !== 'neo' ? title : ''
})
const currentTitle = computed(() => realSessionTitle.value || '未命名会话')
const sessionTitleViewport = ref(null)
const sessionTitleText = ref(null)
const titleShouldMarquee = ref(false)
let sessionTitleResizeObserver
const updateSessionTitleMarquee = async () => {
  await nextTick()
  const viewport = sessionTitleViewport.value
  const text = sessionTitleText.value
  titleShouldMarquee.value = Boolean(viewport && text && text.scrollWidth > viewport.clientWidth + 2)
}
const currentSessionId = computed(() => state.session?.sessionId || '暂无会话')
const currentCwd = computed(() => state.cwd || '—')
const modelName = computed(() => state.status?.metrics?.model || '模型未配置')
const contextPercent = computed(() => {
  const ratio = state.status?.metrics?.contextUsageRatio
  return ratio === undefined ? '—' : `${(ratio * 100).toFixed(1)}%`
})
const inputTokens = computed(() => compactNumber(state.status?.usage?.inputTokens ?? state.status?.metrics?.estimatedInputTokens))
const outputTokens = computed(() => compactNumber(state.status?.usage?.outputTokens ?? state.status?.streamedOutputTokens))
const composerContextValue = computed(() => `${state.composerMetrics.context.display.toFixed(1)}%`)
const currentContextWindowK = computed(() => {
  const tokens = Number(state.status?.metrics?.contextWindowTokens)
  return Number.isFinite(tokens) && tokens > 0 ? String(Math.max(1, Math.round(tokens / 1000))) : ''
})
const composerInputTokens = computed(() => compactNumber(state.composerMetrics.inputTokens.display))
const composerOutputTokens = computed(() => compactNumber(state.composerMetrics.outputTokens.display))
const composerRunning = computed(() => active.value || state.busy)
const backgroundTaskCount = computed(() => state.backgroundTasks.length)
const primaryBackgroundTask = computed(() => state.backgroundTasks[0])
const composerHasDraft = computed(() => Boolean(input.value.trim() || state.attachments.length))
const composerActionLabel = computed(() => {
  if (!composerRunning.value) return '发送 ↵'
  if (composerHasDraft.value) return '打断并发送'
  if (state.queuedInput) return '立即发送'
  return '停止'
})
const filteredSessions = computed(() => {
  const query = sessionSearch.value.trim().toLocaleLowerCase()
  const sessions = state.sessions || []
  if (!query) return sessions
  return sessions.filter((session) => [
    displaySessionTitle(session),
    session.title,
    session.sessionId,
    session.updatedAt,
    session.createdAt,
  ].some((value) => String(value || '').toLocaleLowerCase().includes(query)))
})
const sessionTotalPages = computed(() => Math.max(1, Math.ceil(filteredSessions.value.length / SESSION_PAGE_SIZE)))
const paginatedSessions = computed(() => {
  const start = (sessionPage.value - 1) * SESSION_PAGE_SIZE
  return filteredSessions.value.slice(start, start + SESSION_PAGE_SIZE)
})
const sessionPageNumbers = computed(() => {
  const total = sessionTotalPages.value
  const start = Math.max(1, Math.min(sessionPage.value - 2, total - 4))
  const end = Math.min(total, start + 4)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
})
const activePanelLabel = computed(() => ({
  chat: '对话工作台',
  sessions: '会话管理',
  prompts: '提示词管理',
  settings: '模型配置',
}[state.activePanel] || state.activePanel))
const visibleLines = computed(() => state.sessionResumeLoading ? [] : (state.lines || []).filter((line) => !shouldHideLine(line)))
const runtimePromptSections = computed(() => Array.isArray(state.runtimeContext?.prompt?.sections) ? state.runtimeContext.prompt.sections : [])
const runtimeTools = computed(() => Array.isArray(state.runtimeContext?.tools) ? state.runtimeContext.tools : [])
const effectiveSessionPluginCount = computed(() => state.sessionPlugins.items.filter((item) => item.effectiveEnabled).length)
const effectiveSessionToolCount = computed(() => state.sessionTools.items.filter((item) => item.effectiveEnabled).length)
const toolDetailLine = computed(() => state.lines.find((line) => String(line.id) === String(state.toolDetailLineId)) || null)
const compactionDetailLine = computed(() => state.lines.find((line) => String(line.id) === String(state.compactionDetailLineId)) || null)
const activeAppPrompt = computed(() => state.appPrompt?.activePrompt || undefined)
const activeAppPromptTitle = computed(() => activeAppPrompt.value?.title || activeAppPrompt.value?.id || '')
const selectedPrompt = computed(() => state.promptLibrary.find((item) => item.id === state.selectedPromptId) || state.promptLibrary[0] || null)
const isDarkTheme = computed(() => theme.value === 'dark')
const themeToggleLabel = computed(() => isDarkTheme.value ? '切换到日间模式' : '切换到夜间模式')
const currentCpaQuota = computed(() => {
  if (!state.cpaQuotas.length) return null
  return state.cpaQuotas[state.cpaQuotaIndex % state.cpaQuotas.length] || state.cpaQuotas[0]
})
const memoryCurrent = computed(() => state.memory?.current || null)
const memoryTrendPoints = computed(() => {
  const entries = (state.memory?.history || []).filter((entry) => Number.isFinite(Number(entry?.rss)))
  const values = entries.map((entry) => Number(entry.rss))
  if (!values.length) return []
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = Math.max(1, maximum - minimum)
  return values.map((value, index) => ({
    entry: entries[index],
    x: values.length === 1 ? 130 : index / (values.length - 1) * 260,
    y: values.length === 1 ? 22 : 40 - (value - minimum) / range * 36,
  }))
})
const memoryTrendPath = computed(() => memoryTrendPoints.value.map((point, index) => (
  `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
)).join(' '))
const memoryHoveredPoint = computed(() => memoryTrendPoints.value[memoryHoverIndex.value] || null)

watch(theme, applyTheme, { immediate: true })

watch([composerRunning, isDarkTheme], ([running, dark]) => {
  const fill = running ? (dark ? '#bef264' : '#a3e635') : (dark ? '#38bdf8' : '#7dd3fc')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 4 50 32 32 60 14 32Z" fill="${fill}"/></svg>`
  const favicon = document.querySelector('link[rel="icon"]')
  if (favicon) favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}, { immediate: true })

watch(realSessionTitle, (title) => {
  document.title = title || '对话工作台'
}, { immediate: true })

watch(currentTitle, updateSessionTitleMarquee, { immediate: true })

watch(sessionSearch, () => {
  sessionPage.value = 1
})

watch(sessionTotalPages, (total) => {
  if (sessionPage.value > total) sessionPage.value = total
})

watch(() => state.backgroundTaskDetail?.output, async () => {
  await nextTick()
  const output = backgroundTaskOutput.value
  if (output) output.scrollTop = output.scrollHeight
})

onMounted(async () => {
  await Promise.all([fetchState(), fetchRuntimeContext(), fetchSessionPlugins(), fetchSessionTools(), fetchPromptLibrary(), fetchCpaState(), fetchMemoryState()])
  connectEvents()
  clockTimer = setInterval(() => { state.clockTick = Date.now() }, 1000)
  cpaStateTimer = setInterval(fetchCpaState, 60_000)
  memoryStateTimer = setInterval(fetchMemoryState, 60_000)
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('click', handleDocumentImageClick)
  if (typeof ResizeObserver !== 'undefined' && sessionTitleViewport.value) {
    sessionTitleResizeObserver = new ResizeObserver(updateSessionTitleMarquee)
    sessionTitleResizeObserver.observe(sessionTitleViewport.value)
  }
  updateSessionTitleMarquee()
})

onBeforeUnmount(() => {
  if (es) es.close()
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  if (syncRaf) cancelAnimationFrame(syncRaf)
  resetLineTextScheduler()
  pendingSyncPayload = undefined
  if (metricsRaf) cancelAnimationFrame(metricsRaf)
  if (clockTimer) clearInterval(clockTimer)
  if (cpaStateTimer) clearInterval(cpaStateTimer)
  if (memoryStateTimer) clearInterval(memoryStateTimer)
  if (sessionTitleResizeObserver) sessionTitleResizeObserver.disconnect()
  document.body.classList.remove('tool-detail-open', 'image-preview-open', 'runtime-context-open', 'context-window-open')
  if (confirmDialogResolver) resolveConfirmation(false)
  window.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('click', handleDocumentImageClick)
})

async function fetchState(options = {}) {
  try {
    const res = await fetch(runtimeUrl('/api/state'))
    if (!res.ok) throw new Error(`state ${res.status}`)
    applySync(await res.json())
    return true
  } catch (error) {
    if (!options.silent) notify(`运行时不可用：${error.message || error}`)
    return false
  }
}

async function fetchRuntimeContext() {
  state.runtimeContextLoading = true
  try {
    const res = await fetch(runtimeUrl('/api/runtime-context'))
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload.error || `runtime-context ${res.status}`)
    applyRuntimeContext(payload)
    return true
  } catch (error) {
    state.runtimeContextError = error.message || String(error)
    return false
  } finally {
    state.runtimeContextLoading = false
  }
}

async function fetchGlobalTools() {
  state.globalTools.loading = true
  try {
    const res = await fetch(runtimeUrl('/api/tools'))
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `tools ${res.status}`)
    state.globalTools = { items: Array.isArray(body.items) ? body.items.map((item) => ({ ...item })) : [], loading: false }
  } catch (error) {
    state.globalTools.loading = false
    notify(error.message || String(error))
  }
}

async function saveGlobalTools() {
  const overrides = Object.fromEntries(state.globalTools.items.map((item) => [item.name, item.configuredEnabled !== false]))
  state.globalTools.loading = true
  try {
    const result = await postJson('/api/tools/global', { overrides })
    state.globalTools = { ...result.state, loading: false }
    await Promise.all([fetchSessionTools(), fetchRuntimeContext()])
    notify('全局工具配置已保存并立即生效')
  } catch (error) {
    state.globalTools.loading = false
    notifyActionError(error, '工具配置保存失败')
  }
}

async function fetchSessionTools() {
  state.sessionTools.loading = true
  try {
    const res = await fetch(runtimeUrl('/api/session-tools'))
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `session-tools ${res.status}`)
    state.sessionTools = { ...body, items: Array.isArray(body.items) ? body.items : [], loading: false }
  } catch (error) {
    state.sessionTools.loading = false
    notify(error.message || String(error))
  }
}

async function updateSessionTool(item, mode) {
  const overrides = Object.fromEntries(state.sessionTools.items.map((entry) => [entry.name, entry.name === item.name ? mode : entry.mode]))
  state.sessionTools.busy = true
  try {
    const result = await postJson('/api/session-tools', { overrides })
    state.sessionTools = { ...result.state, loading: false, busy: false }
  } catch (error) {
    state.sessionTools.busy = false
    notifyActionError(error, '会话工具更新失败')
  }
}

async function fetchGlobalPlugins() {
  state.globalPlugins.loading = true
  try {
    const res = await fetch(runtimeUrl('/api/plugins'))
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `plugins ${res.status}`)
    state.globalPlugins = {
      items: Array.isArray(body.items) ? body.items.map((item) => ({ ...item })) : [],
      locked: body.locked === true,
      restartRequired: body.restartRequired !== false,
      loading: false,
    }
  } catch (error) {
    state.globalPlugins.loading = false
    notify(error.message || String(error))
  }
}

async function saveGlobalPlugins() {
  const enabledIds = state.globalPlugins.items.filter((item) => item.configuredEnabled !== false).map((item) => item.id)
  state.globalPlugins.loading = true
  try {
    const result = await postJson('/api/plugins/global', { enabledIds })
    const enabled = new Set(result.enabledIds || enabledIds)
    state.globalPlugins.items = state.globalPlugins.items.map((item) => ({ ...item, configuredEnabled: enabled.has(item.id) }))
    notify('插件配置已保存，重启后生效')
  } catch (error) {
    notifyActionError(error, '插件配置保存失败')
  } finally {
    state.globalPlugins.loading = false
  }
}

async function fetchSessionPlugins() {
  state.sessionPlugins.loading = true
  try {
    const res = await fetch(runtimeUrl('/api/session-plugins'))
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `session-plugins ${res.status}`)
    state.sessionPlugins = { ...body, items: Array.isArray(body.items) ? body.items : [], loading: false }
  } catch (error) {
    state.sessionPlugins.loading = false
    notify(error.message || String(error))
  }
}

async function updateSessionPlugin(item, mode) {
  const overrides = Object.fromEntries(state.sessionPlugins.items.map((entry) => [entry.id, entry.id === item.id ? mode : entry.mode]))
  state.sessionPlugins.busy = true
  try {
    const result = await postJson('/api/session-plugins', { overrides })
    state.sessionPlugins = { ...result.state, loading: false, busy: false }
  } catch (error) {
    state.sessionPlugins.busy = false
    notifyActionError(error, '会话插件更新失败')
  }
}

async function fetchPromptLibrary() {
  state.promptLibraryLoading = true
  try {
    const res = await fetch(runtimeUrl('/api/prompt-library'))
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `prompt-library ${res.status}`)
    syncPromptLibrary(Array.isArray(body.items) ? body.items : DEFAULT_APP_PROMPT_LIBRARY)
  } catch (error) {
    syncPromptLibrary([])
    notify(error.message || String(error))
  } finally {
    state.promptLibraryLoading = false
  }
}

function connectEvents() {
  if (es) es.close()
  if (syncRaf) cancelAnimationFrame(syncRaf)
  syncRaf = 0
  resetLineTextScheduler()
  pendingSyncPayload = undefined
  hasReceivedEventSync = false
  state.connecting = true
  es = new EventSource(runtimeUrl('/events'))
  es.addEventListener('open', () => {
    hasReceivedEventSync = false
    state.connected = true
    state.connecting = false
  })
  es.addEventListener('error', () => {
    flushQueuedSync()
    state.connected = false
    state.connecting = false
  })
  es.addEventListener('sync', (event) => {
    // The first snapshot on every connection carries catalogs that later
    // snapshots intentionally omit, so it must never be coalesced away.
    if (!hasReceivedEventSync) {
      hasReceivedEventSync = true
      applyRawSync(event.data)
      return
    }
    queueSync(event.data)
  })
  es.addEventListener('delta', (event) => {
    // A queued structural snapshot must land before later line deltas, or its
    // animation-frame callback could overwrite text that already arrived.
    flushQueuedSync()
    applyRawDelta(event.data)
  })
  es.addEventListener('terminal.output', (event) => {
    try {
      applyTerminalOutput(JSON.parse(event.data))
    } catch {
      // A later sync snapshot repairs malformed or missed output events.
    }
  })
  es.addEventListener('runtime.context', (event) => {
    try {
      applyRuntimeContext(JSON.parse(event.data))
    } catch (error) {
      state.runtimeContextError = error.message || String(error)
    }
  })
  es.addEventListener('runtime.context.error', (event) => {
    try {
      const payload = JSON.parse(event.data)
      state.runtimeContextError = payload.message || '运行上下文同步失败'
    } catch {
      state.runtimeContextError = '运行上下文同步失败'
    }
  })
}

function applyRuntimeContext(payload) {
  if (Number(payload?.protocolVersion) !== 1) throw new Error(`不支持的运行上下文协议版本：${payload?.protocolVersion ?? '未知'}`)
  const incomingRevision = Number(payload.revision || 0)
  const currentRevision = Number(state.runtimeContext?.revision || 0)
  const sameSession = !payload.sessionId || !state.runtimeContext?.sessionId || payload.sessionId === state.runtimeContext.sessionId
  if (sameSession && incomingRevision < currentRevision) return
  state.runtimeContext = payload
  state.runtimeContextLoading = false
  state.runtimeContextError = ''
}

// The runtime publishes complete conversation snapshots. Processing each one as
// soon as it arrives makes a long session fall behind the stream: the browser
// spends its time rendering obsolete intermediate states after the model has
// already finished. Keep only the newest snapshot until the next paint.
function queueSync(rawPayload) {
  pendingSyncPayload = rawPayload
  if (syncRaf) return
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0
    applyPendingSync()
  })
}

function flushQueuedSync() {
  if (syncRaf) cancelAnimationFrame(syncRaf)
  syncRaf = 0
  applyPendingSync()
}

function applyPendingSync() {
  const payload = pendingSyncPayload
  pendingSyncPayload = undefined
  if (payload) applyRawSync(payload)
}

function applyRawSync(rawPayload) {
  try {
    applySync(JSON.parse(rawPayload))
  } catch (error) {
    notify(`运行状态同步失败：${error.message || error}`)
  }
}

function applyRawDelta(rawPayload) {
  try {
    applyDelta(JSON.parse(rawPayload))
  } catch (error) {
    notify(`流式增量同步失败：${error.message || error}`)
    void fetchState()
  }
}

function queueLineText(id, text) {
  const delta = String(text || '')
  if (!delta) return
  const key = String(id)
  pendingLineText.set(key, `${pendingLineText.get(key) || ''}${delta}`)
  scheduleLineTextPaint()
}

function scheduleLineTextPaint() {
  if (lineTextRaf) return
  lineTextRaf = requestAnimationFrame(paintLineText)
}

function paintLineText() {
  lineTextRaf = 0
  const shouldFollow = isTranscriptNearBottom()
  const updates = [...pendingLineText]
  pendingLineText.clear()
  for (const [id, buffered] of updates) {
    const index = state.lines.findIndex((line) => String(line.id) === id)
    if (index < 0) continue
    const line = state.lines[index]
    state.lines[index] = { ...line, text: `${line.text || ''}${buffered}` }
  }
  if (shouldFollow) scheduleTranscriptScrollBottom()
  if (pendingLineText.size) scheduleLineTextPaint()
}

function flushLineText(id) {
  const key = String(id)
  const buffered = pendingLineText.get(key)
  if (!buffered) return
  pendingLineText.delete(key)
  const index = state.lines.findIndex((line) => String(line.id) === key)
  if (index < 0) return
  const line = state.lines[index]
  state.lines[index] = { ...line, text: `${line.text || ''}${buffered}` }
}

function resetLineTextScheduler() {
  if (lineTextRaf) cancelAnimationFrame(lineTextRaf)
  lineTextRaf = 0
  pendingLineText.clear()
}

function applyDelta(payload) {
  const incomingSessionId = String(payload.sessionId || '')
  if (runtimeSessionId && incomingSessionId && incomingSessionId !== runtimeSessionId && !allowRuntimeSessionChange) {
    repairRuntimeSessionBinding()
    return
  }
  const shouldFollow = isTranscriptNearBottom()
  for (const operation of payload.operations || []) {
    if (operation.type === 'line.append') {
      if (!state.lines.some((line) => String(line.id) === String(operation.line?.id))) {
        state.lines.push(operation.line)
      }
      continue
    }
    const index = state.lines.findIndex((line) => String(line.id) === String(operation.id))
    if (index < 0) throw new Error(`找不到增量消息行 ${operation.id}`)
    const line = state.lines[index]
    if (operation.type === 'line.text.append') {
      queueLineText(operation.id, operation.text)
    } else if (operation.type === 'line.patch') {
      flushLineText(operation.id)
      const patchedLine = state.lines[index]
      state.lines[index] = { ...patchedLine, ...(operation.patch || {}) }
    }
  }
  if (payload.status) state.status = payload.status
  updateComposerMetricTargets()
  state.connected = true
  state.connecting = false
  if (shouldFollow) scheduleTranscriptScrollBottom()
}

function applyTerminalOutput(payload) {
  for (const update of payload?.updates || []) {
    const sessionId = String(update?.sessionId || '')
    if (!sessionId) continue
    const taskIndex = state.backgroundTasks.findIndex((task) => String(task?.sessionId || '') === sessionId)
    if (taskIndex < 0) continue
    const chunk = String(update.text || '')
    if (!chunk) continue
    const task = state.backgroundTasks[taskIndex]
    const currentOutput = String(task.output || '')
    const currentEnd = Number(task.outputEnd ?? currentOutput.length)
    const outputStart = Number(update.outputStart ?? currentEnd)
    const outputEnd = Number(update.outputEnd ?? outputStart + chunk.length)
    const output = outputStart === currentEnd
      ? appendBoundedText(currentOutput, chunk, BACKGROUND_TASK_OUTPUT_MAX_CHARS)
      : chunk.slice(-BACKGROUND_TASK_OUTPUT_MAX_CHARS)
    state.backgroundTasks[taskIndex] = { ...task, output, outputEnd }
    if (String(state.backgroundTaskDetail?.sessionId || '') === sessionId) {
      state.backgroundTaskDetail = { ...state.backgroundTaskDetail, output, outputEnd }
    }
  }
}

function appendBoundedText(current, incoming, limit) {
  const combined = `${current}${incoming}`
  return combined.length <= limit ? combined : combined.slice(-limit)
}

function applySync(payload) {
  resetLineTextScheduler()
  const incomingSessionId = String(payload.session?.sessionId || '')
  const previousSessionId = String(state.session?.sessionId || '')
  if (runtimeSessionId && incomingSessionId && incomingSessionId !== runtimeSessionId && !allowRuntimeSessionChange) {
    repairRuntimeSessionBinding()
    return
  }
  const shouldFollow = isTranscriptNearBottom()
  if (incomingSessionId !== previousSessionId) {
    state.messageImagePreviews = state.messageImagePreviews.filter((item) => item.sessionId === incomingSessionId)
    state.attachmentCounter = 0
  }
  state.lines = payload.lines || []
  if (state.toolDetailLineId !== undefined && !state.lines.some((line) => String(line.id) === String(state.toolDetailLineId))) closeToolDetail()
  if (state.compactionDetailLineId !== undefined && !state.lines.some((line) => String(line.id) === String(state.compactionDetailLineId))) closeCompactionDetail()
  syncMessageImagePreviewsFromLines(state.lines)
  syncLiveToolTimers(state.lines)
  state.status = payload.status || state.status
  updateComposerMetricTargets()
  state.busy = !!payload.busy
  state.queuedInput = payload.queuedInput
  state.backgroundTaskCount = payload.backgroundTaskCount || 0
  state.backgroundTasks = payload.backgroundTasks || []
  if (state.backgroundTaskDetail) {
    const currentTask = state.backgroundTasks.find((task) => backgroundTaskKey(task) === backgroundTaskKey(state.backgroundTaskDetail))
    if (currentTask) state.backgroundTaskDetail = { ...currentTask }
    else if (state.backgroundTasks.length) state.backgroundTaskDetail = { ...state.backgroundTasks[0] }
    else closeBackgroundTaskDetail()
  }
  state.backgroundSessionRunCount = payload.backgroundSessionRunCount || 0
  state.runningSessionIds = payload.runningSessionIds || []
  state.session = payload.session
  state.cwd = payload.cwd || ''
  if (!state.fastModeMutating) state.fastMode = payload.fastMode === true
  state.appPrompt = payload.appPrompt || { hasActivePrompt: false, activePrompt: undefined }
  rememberRuntimeSession(payload.session, allowRuntimeSessionChange)
  if (incomingSessionId && incomingSessionId !== previousSessionId) void Promise.all([fetchSessionPlugins(), fetchSessionTools()])
  if (state.sessionResumeLoading) {
    const sessionId = payload.session?.sessionId || ''
    if (state.pendingResumeSessionId && sessionId === state.pendingResumeSessionId) {
      state.sessionResumeLoading = false
      state.pendingResumeSessionId = ''
    }
  }
  if (payload.catalog) state.catalog = payload.catalog
  if (payload.interactive) state.interactive = payload.interactive
  if (payload.tips) state.tips = payload.tips
  if (payload.tipIndex !== undefined && state.tipIndex === 0) state.tipIndex = payload.tipIndex
  state.connected = true
  state.connecting = false
  previousBackgroundTaskStatuses = backgroundTaskStatusMap(state.backgroundTasks)
  pruneRenderedLineCache()
  if (shouldFollow) scheduleTranscriptScrollBottom()
}

function syncPromptLibrary(items, preferredId = state.selectedPromptId) {
  const nextItems = (items || []).map(normalizePromptItem).filter(Boolean)
  state.promptLibrary = nextItems
  const current = nextItems.find((item) => item.id === preferredId) || nextItems[0] || null
  state.selectedPromptId = current?.id || ''
  syncPromptDraft(current || createEmptyPromptDraft())
}

function syncPromptDraft(item) {
  promptDraft.id = item?.id || ''
  promptDraft.title = item?.title || ''
  promptDraft.content = item?.content || ''
  promptDraft.usage = item?.usage || ''
}

function togglePromptManager() {
  openPromptManager()
}

function openPromptManager(promptId) {
  state.activePanel = 'prompts'
  state.promptManagerOpen = true
  if (promptId) state.selectedPromptId = promptId
  const current = state.promptLibrary.find((item) => item.id === state.selectedPromptId) || state.promptLibrary[0] || createEmptyPromptDraft()
  state.selectedPromptId = current.id || ''
  syncPromptDraft(current)
}

function editPromptItem(item) {
  state.selectedPromptId = item.id
  openPromptManager(item.id)
}

function newPromptItem() {
  state.selectedPromptId = ''
  syncPromptDraft(createEmptyPromptDraft())
  state.activePanel = 'prompts'
  state.promptManagerOpen = true
}

function selectPromptItem(item) {
  state.selectedPromptId = item.id
  syncPromptDraft(item)
}

async function savePromptItem() {
  const normalized = normalizePromptItem({
    id: promptDraft.id || createPromptId(),
    title: promptDraft.title,
    content: promptDraft.content,
    usage: promptDraft.usage,
  })
  if (!normalized) {
    notify('标题和内容不能为空')
    return
  }
  try {
    const result = await postJson('/api/prompt-library', { item: normalized })
    syncPromptLibrary(result.items, normalized.id)
  } catch (error) {
    notify(error.message || String(error))
    return
  }
  notify('已保存提示词')
}

async function deletePromptItem() {
  const id = String(promptDraft.id || '').trim()
  if (!id) {
    syncPromptDraft(createEmptyPromptDraft())
    return
  }
  const removed = state.promptLibrary.find((item) => item.id === id)
  if (!removed) return
  const confirmed = await requestConfirmation({
    title: '删除提示词？',
    message: `“${removed.title}”删除后无法恢复。`,
    confirmLabel: '确认删除',
    tone: 'danger',
  })
  if (!confirmed) return
  try {
    const result = await postJson('/api/prompt-library/delete', { id })
    syncPromptLibrary(result.items)
  } catch (error) {
    notify(error.message || String(error))
    return
  }
  if (activeAppPrompt.value?.id === removed.id) void clearAppPrompt({ confirm: false })
  notify('已删除提示词')
}

async function applyPromptItem(item) {
  const normalized = normalizePromptItem(item)
  if (!normalized) {
    notify('提示词无效')
    return
  }
  const current = activeAppPrompt.value
  const isDifferentPrompt = current && (
    current.id !== normalized.id
    || String(current.content || '').trim() !== normalized.content
  )
  if (isDifferentPrompt) {
    const samePromptUpdated = current.id === normalized.id
    const confirmed = await requestConfirmation({
      title: samePromptUpdated ? '更新当前提示词？' : '切换当前提示词？',
      message: samePromptUpdated
        ? `“${normalized.title}”的内容已经变化。重新应用会影响模型对后续问题的理解和回答方式。`
        : `将从“${current.title || current.id || '当前提示词'}”切换为“${normalized.title}”。提示词变化会影响模型对后续问题的理解和回答方式。`,
      confirmLabel: samePromptUpdated ? '确认更新' : '确认切换',
    })
    if (!confirmed) return
  }
  try {
    const result = await postJson('/api/app-prompt', {
      id: normalized.id,
      title: normalized.title,
      usage: normalized.usage,
      source: 'sidebar-library',
      content: normalized.content,
    })
    if (result?.ok !== false) {
      state.appPrompt = result.appPrompt || { hasActivePrompt: true, activePrompt: normalized }
      notify(`已应用：${normalized.title}`)
    }
  } catch (error) {
    notifyActionError(error, '应用提示词失败')
  }
}

async function clearAppPrompt(options = {}) {
  if (!activeAppPrompt.value) return
  if (options.confirm !== false) {
    const confirmed = await requestConfirmation({
      title: '清除当前提示词？',
      message: '清除后，模型将不再遵循当前应用提示词，这会改变它对后续问题的理解和回答方式。',
      confirmLabel: '确认清除',
      tone: 'danger',
    })
    if (!confirmed) return
  }
  try {
    const result = await postJson('/api/app-prompt', { clear: true })
    if (result?.ok !== false) {
      state.appPrompt = result.appPrompt || { hasActivePrompt: false, activePrompt: undefined }
      notify('已清空应用提示词')
    }
  } catch (error) {
    notifyActionError(error, '清空提示词失败')
  }
}

function requestConfirmation(options) {
  if (confirmDialogResolver) resolveConfirmation(false)
  Object.assign(state.confirmDialog, {
    open: true,
    title: String(options?.title || '请确认'),
    message: String(options?.message || ''),
    confirmLabel: String(options?.confirmLabel || '确认'),
    cancelLabel: String(options?.cancelLabel || '取消'),
    tone: options?.tone === 'danger' ? 'danger' : 'warning',
  })
  return new Promise((resolve) => {
    confirmDialogResolver = resolve
  })
}

function resolveConfirmation(confirmed) {
  const resolve = confirmDialogResolver
  confirmDialogResolver = undefined
  state.confirmDialog.open = false
  resolve?.(confirmed === true)
}

function handlePromptDragStart(event, item) {
  draggingPromptId.value = item.id
  if (!event?.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-neoctl-prompt-id', item.id)
  event.dataTransfer.setData('text/plain', item.title)
}

function handleComposerDragOver(event) {
  const types = Array.from(event?.dataTransfer?.types || [])
  const draggingFiles = hasDraggedFiles(event)
  if (!types.includes('application/x-neoctl-prompt-id') && !draggingFiles) return
  event.preventDefault()
  state.composerDropActive = true
  state.composerDropMode = draggingFiles ? 'files' : 'prompt'
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleComposerDragLeave(event) {
  if (event?.currentTarget && event?.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return
  state.composerDropActive = false
  state.composerDropMode = 'prompt'
}

async function handleComposerDrop(event) {
  const files = filesFromDataTransfer(event?.dataTransfer)
  if (files.length) {
    event.preventDefault()
    state.composerDropActive = false
    state.composerDropMode = 'prompt'
    draggingPromptId.value = ''
    await uploadFiles(files)
    composer.value?.focus()
    return
  }

  const promptId = event?.dataTransfer?.getData('application/x-neoctl-prompt-id') || draggingPromptId.value
  state.composerDropActive = false
  state.composerDropMode = 'prompt'
  if (!promptId) return
  event.preventDefault()
  const item = state.promptLibrary.find((entry) => entry.id === promptId)
  draggingPromptId.value = ''
  if (!item) {
    notify('未找到提示词')
    return
  }
  await applyPromptItem(item)
}

function hasDraggedFiles(event) {
  const types = Array.from(event?.dataTransfer?.types || [])
  if (types.includes('Files')) return true
  return Array.from(event?.dataTransfer?.items || []).some((item) => item.kind === 'file')
}

function filesFromDataTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || [])
  if (files.length) return files
  return Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean)
}

function handlePromptDragEnd() {
  draggingPromptId.value = ''
  state.composerDropActive = false
  state.composerDropMode = 'prompt'
}

function handlePromptSortDragStart(event, item) {
  sortingPromptId.value = item.id
  promptSortTargetId.value = ''
  if (!event?.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-neoctl-prompt-sort-id', item.id)
  event.dataTransfer.setData('text/plain', item.title)
}

function handlePromptSortDragOver(event, item) {
  const sourceId = sortingPromptId.value || event?.dataTransfer?.getData('application/x-neoctl-prompt-sort-id')
  if (!sourceId || sourceId === item.id) return
  event.preventDefault()
  const rect = event.currentTarget?.getBoundingClientRect?.()
  promptSortTargetId.value = item.id
  promptSortPosition.value = rect && event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

async function handlePromptSortDrop(event, targetItem) {
  event.preventDefault()
  const sourceId = event?.dataTransfer?.getData('application/x-neoctl-prompt-sort-id') || sortingPromptId.value
  const position = promptSortPosition.value
  resetPromptSortState()
  if (!sourceId || sourceId === targetItem.id) return
  const current = [...state.promptLibrary]
  const sourceIndex = current.findIndex((item) => item.id === sourceId)
  if (sourceIndex < 0) return
  const [source] = current.splice(sourceIndex, 1)
  const targetIndex = current.findIndex((item) => item.id === targetItem.id)
  if (targetIndex < 0) return
  current.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source)
  state.promptLibrary = current
  try {
    const result = await postJson('/api/prompt-library/reorder', { ids: current.map((item) => item.id) })
    syncPromptLibrary(result.items, state.selectedPromptId)
    notify('提示词顺序已更新')
  } catch (error) {
    await fetchPromptLibrary()
    notify(error.message || String(error))
  }
}

function resetPromptSortState() {
  sortingPromptId.value = ''
  promptSortTargetId.value = ''
  promptSortPosition.value = 'before'
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
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image')
  const fileAttachments = attachments.filter((attachment) => attachment.kind === 'file' && attachment.absolutePath)
  const submitText = textWithAttachmentLabels(text, imageAttachments)
  cacheMessageImagePreviews(imageAttachments, submitText)
  input.value = ''
  state.attachments = []
  autosize()
  try {
    const res = await fetch(runtimeUrl('/api/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: submitText, attachments: [...imageAttachments, ...fileAttachments] }),
    })
    const body = await res.json()
    if (!res.ok || body?.error) throw new Error(body.error || `submit ${res.status}`)
  } catch (error) {
    notify(error.message || String(error))
  }
}

async function interruptAndSubmit() {
  if (!composerHasDraft.value) {
    if (state.queuedInput) await sendQueuedNow()
    else await interrupt()
    return
  }
  const text = input.value
  const attachments = [...state.attachments]
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image')
  const fileAttachments = attachments.filter((attachment) => attachment.kind === 'file' && attachment.absolutePath)
  const submitText = textWithAttachmentLabels(text, imageAttachments)
  cacheMessageImagePreviews(imageAttachments, submitText)
  input.value = ''
  state.attachments = []
  autosize()
  try {
    await postJson('/api/submit-now', { text: submitText, attachments: [...imageAttachments, ...fileAttachments] })
  } catch (error) {
    notify(error.message || String(error))
  }
}

async function interrupt() {
  try {
    await postJson('/api/interrupt', {})
  } catch (error) {
    notifyActionError(error, '停止回答失败')
  }
}

async function retractQueuedInput() {
  try {
    const result = await postJson('/api/queue/cancel', {})
    notify(result.cancelled ? '已撤回排队消息' : '没有待撤回的消息')
  } catch (error) {
    notifyActionError(error, '撤回排队消息失败')
  }
}

async function sendQueuedNow() {
  try {
    const result = await postJson('/api/queue/send-now', {})
    notify(result.interrupted ? '已打断并发送排队消息' : '已发送排队消息')
  } catch (error) {
    notifyActionError(error, '发送排队消息失败')
  }
}

async function compressSession() {
  try {
    await postJson('/api/submit', { text: '/compact', attachments: [] })
    notify('已请求压缩上下文')
  } catch (error) {
    notifyActionError(error, '压缩上下文失败')
  }
}

function openContextWindowModal() {
  state.contextWindowDraft = currentContextWindowK.value
  state.contextWindowError = ''
  state.contextWindowModalOpen = true
  document.body.classList.add('context-window-open')
}

function closeContextWindowModal() {
  if (state.contextWindowSaving) return
  state.contextWindowModalOpen = false
  state.contextWindowError = ''
  document.body.classList.remove('context-window-open')
}

function normalizeContextWindowDraft() {
  state.contextWindowError = ''
}

async function saveContextWindow() {
  const value = String(state.contextWindowDraft || '')
  if (!/^\d+$/.test(value) || value === '0') {
    state.contextWindowError = '请输入大于 0 的整数'
    return
  }
  state.contextWindowSaving = true
  state.contextWindowError = ''
  try {
    const result = await postJson('/api/context-window', { value })
    const metrics = state.status?.metrics || {}
    const tokens = Number(result.contextWindowTokens)
    const estimatedInputTokens = Number(metrics.estimatedInputTokens || 0)
    state.status = {
      ...state.status,
      metrics: {
        ...metrics,
        contextWindowTokens: tokens,
        contextWindowSource: 'session',
        contextUsageRatio: tokens > 0 ? estimatedInputTokens / tokens : undefined,
      },
    }
    updateComposerMetricTargets()
    state.contextWindowModalOpen = false
    document.body.classList.remove('context-window-open')
  } catch (error) {
    state.contextWindowError = actionErrorMessage(error, '调整失败')
  } finally {
    state.contextWindowSaving = false
  }
}

function toggleFastMode() {
  const enabled = !state.fastMode
  const version = ++fastModeMutationVersion
  state.fastMode = enabled
  state.fastModeMutating = true

  fastModeMutationQueue = fastModeMutationQueue
    .catch(() => undefined)
    .then(() => postJson('/api/fast-mode', { enabled }))
    .then((result) => {
      if (version !== fastModeMutationVersion) return
      state.fastMode = result.fastMode === true
      state.fastModeMutating = false
      notify(state.fastMode ? '快速模式已为当前会话启动' : '快速模式已关闭')
    })
    .catch(async (error) => {
      if (version !== fastModeMutationVersion) return
      state.fastModeMutating = false
      await fetchState()
      notifyActionError(error, '快速模式切换失败')
    })
}

async function openSessions() {
  state.activePanel = 'sessions'
  state.sessionsLoading = true
  try {
    const res = await fetch(runtimeUrl('/api/sessions'))
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.error || body?.ok === false) throw requestError(body, res.status)
    state.sessions = body.sessions || []
    state.runningSessionIds = body.runningSessionIds || []
  } catch (error) {
    notifyActionError(error, '加载会话失败')
  } finally {
    state.sessionsLoading = false
  }
}

async function resumeSession(sessionId) {
  const previousTabId = runtimeTabId
  const previousSessionId = runtimeSessionId
  state.pendingResumeSessionId = sessionId
  state.sessionResumeLoading = true
  const connected = await bindRuntimeSession(sessionId)
  if (connected) {
    state.activePanel = 'chat'
    notify('已打开会话')
  } else {
    const restored = await restoreRuntimeBinding(previousTabId, previousSessionId)
    notify(restored ? '打开会话失败，已恢复原会话' : '打开会话失败，运行时连接已断开')
  }
  state.sessionResumeLoading = false
  state.pendingResumeSessionId = ''
}

async function fetchCpaState() {
  try {
    const res = await fetch(runtimeUrl('/api/cpa-quota'))
    if (!res.ok) throw new Error(`cpa-quota ${res.status}`)
    const body = await res.json()
    state.cpaQuotas = Array.isArray(body?.quotas) ? body.quotas : []
    if (state.cpaQuotaIndex >= state.cpaQuotas.length) state.cpaQuotaIndex = 0
    if (body?.config) {
      if (!state.cpaConfig.loaded) {
        state.cpaConfig.url = String(body.config.url || '')
        state.cpaConfig.password = body.config.hasPassword ? CPA_PASSWORD_MASK : ''
        state.cpaConfig.loaded = true
      }
      state.cpaConfig.hasPassword = Boolean(body.config.hasPassword)
    }
  } catch {
    state.cpaQuotas = []
    state.cpaQuotaIndex = 0
  }
}

async function fetchMemoryState() {
  try {
    const res = await fetch(runtimeUrl('/api/memory'))
    if (!res.ok) throw new Error(`memory ${res.status}`)
    const body = await res.json()
    state.memory = {
      current: body?.current || null,
      history: Array.isArray(body?.history) ? body.history : [],
      sampleMs: Number(body?.sampleMs) || 60_000,
      retentionMs: Number(body?.retentionMs) || 86_400_000,
    }
  } catch {
    // Memory monitoring is observational and must not interrupt chat usage.
  }
}

async function newSession() {
  const previousTabId = runtimeTabId
  const previousSessionId = runtimeSessionId
  disconnectRuntimeEvents()
  runtimeTabId = randomRuntimeId()
  runtimeSessionId = ''
  allowRuntimeSessionChange = true
  sessionStorage.setItem(RUNTIME_TAB_ID_KEY, runtimeTabId)
  sessionStorage.removeItem(RUNTIME_SESSION_ID_KEY)
  state.sessionResumeLoading = true
  state.pendingResumeSessionId = ''
  const connected = await fetchState({ silent: true })
  if (connected) {
    state.activePanel = 'chat'
    notify('已创建新会话')
    connectEvents()
  } else {
    const restored = await restoreRuntimeBinding(previousTabId, previousSessionId)
    notify(restored ? '新建会话失败，已恢复原会话' : '新建会话失败，运行时连接已断开')
  }
  state.sessionResumeLoading = false
}

function isCurrentSession(sessionId) {
  return Boolean(sessionId) && String(state.session?.sessionId || '') === String(sessionId)
}

function isRunningSession(sessionId) {
  return state.runningSessionIds.includes(sessionId)
}

async function deleteSession(sessionId) {
  const session = state.sessions.find((item) => item.sessionId === sessionId)
  if (isCurrentSession(sessionId)) {
    notify(ACTION_ERROR_MESSAGES.SESSION_ACTIVE)
    return
  }
  if (isRunningSession(sessionId)) {
    notify(ACTION_ERROR_MESSAGES.SESSION_RUNNING)
    return
  }
  const confirmed = await requestConfirmation({
    title: '删除会话？',
    message: `“${session?.title || sessionId || '这个会话'}”删除后无法恢复。`,
    confirmLabel: '确认删除',
    tone: 'danger',
  })
  if (!confirmed) return
  try {
    await postJson('/api/sessions/delete', { sessionId })
    await openSessions()
    notify('会话已删除')
  } catch (error) {
    notifyActionError(error, '删除会话失败')
  }
}

async function openLogin(provider) {
  state.activePanel = 'settings'
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''
  try {
    const res = await fetch(runtimeUrl(`/api/login${query}`))
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.error || body?.ok === false) throw requestError(body, res.status)
    state.login = body
    loginProvider.value = body.provider
    Object.keys(loginValues).forEach((key) => delete loginValues[key])
    Object.assign(loginValues, body.values || {})
    await Promise.all([fetchCpaState(), fetchGlobalPlugins(), fetchGlobalTools()])
  } catch (error) {
    notifyActionError(error, '加载模型配置失败')
  }
}

async function switchLoginProvider() {
  await openLogin(loginProvider.value)
}

async function saveLogin() {
  const [modelSave, cpaSave] = await Promise.allSettled([
    postJson('/api/login', { provider: loginProvider.value, values: { ...loginValues } }),
    postJson('/api/cpa-config', {
      url: state.cpaConfig.url,
      password: state.cpaConfig.password === CPA_PASSWORD_MASK ? '' : state.cpaConfig.password,
      preservePassword: state.cpaConfig.hasPassword && (!state.cpaConfig.password || state.cpaConfig.password === CPA_PASSWORD_MASK),
    }),
  ])
  if (cpaSave.status === 'fulfilled') {
    const cpaResult = cpaSave.value
    state.cpaQuotas = Array.isArray(cpaResult?.quotas) ? cpaResult.quotas : []
    state.cpaQuotaIndex = 0
    state.cpaConfig.loaded = true
    state.cpaConfig.hasPassword = Boolean(cpaResult?.config?.hasPassword)
    state.cpaConfig.password = state.cpaConfig.hasPassword ? CPA_PASSWORD_MASK : ''
  }
  if (modelSave.status === 'fulfilled' && cpaSave.status === 'fulfilled') {
    notify('模型配置已保存')
    return
  }
  const failed = []
  if (modelSave.status === 'rejected') failed.push(actionErrorMessage(modelSave.reason, '模型配置保存失败'))
  if (cpaSave.status === 'rejected') failed.push(actionErrorMessage(cpaSave.reason, 'CPA 配置保存失败'))
  notify(failed.join('；'))
}

function normalizedQuotaPercent(value) {
  const number = Number.parseFloat(String(value ?? '').replace('%', ''))
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0
}

function quotaPercent(value) {
  const raw = Number.parseFloat(String(value ?? '').replace('%', ''))
  if (!Number.isFinite(raw)) return '—'
  const number = normalizedQuotaPercent(raw)
  return `${number.toFixed(number % 1 ? 1 : 0)}%`
}

function formatQuotaReset(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function formatSessionTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function rotateCpaQuota(direction) {
  const count = state.cpaQuotas.length
  if (count < 2) return
  state.cpaQuotaIndex = (state.cpaQuotaIndex + direction + count) % count
}

function quotaAccountLabel(value) {
  const account = String(value || '').trim()
  if (!account) return 'Codex 凭据'
  const [name, domain] = account.split('@')
  if (!domain || name.length <= 3) return account
  return `${name.slice(0, 3)}***@${domain}`
}

function formatMemoryBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function formatMemoryTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '等待采样'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

function formatMemoryTooltipTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

function updateMemoryHover(event) {
  const count = memoryTrendPoints.value.length
  if (!count) return
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
  memoryHoverIndex.value = count === 1 ? 0 : Math.round(ratio * (count - 1))
}

function clearMemoryHover() {
  memoryHoverIndex.value = -1
}

async function postJson(url, body) {
  const res = await fetch(runtimeUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await res.json().catch(() => ({}))
  if (!res.ok || value?.error || value?.ok === false) throw requestError(value, res.status)
  return value
}

class ActionRequestError extends Error {
  constructor(message, code = '') {
    super(message)
    this.name = 'ActionRequestError'
    this.code = code
  }
}

function requestError(value, status) {
  const code = String(value?.errorCode || (status === 404 ? 'API_NOT_FOUND' : ''))
  return new ActionRequestError(value?.error || `请求失败（${status}）`, code)
}

function actionErrorMessage(error, fallback = '操作失败') {
  const code = String(error?.code || '')
  if (code && ACTION_ERROR_MESSAGES[code]) return ACTION_ERROR_MESSAGES[code]
  const detail = String(error?.message || error || '').trim()
  return detail ? `${fallback}：${detail}` : fallback
}

function notifyActionError(error, fallback) {
  notify(actionErrorMessage(error, fallback))
}

function lineText(line) {
  const baseText = stripHiddenAttachmentManifest(stripImageOperationHint(stripImageLabels(line.text || '')))
  const text = line.kind === 'system' || line.kind === 'meta' ? localizeSystemText(baseText) : baseText
  return text
}

function localizeSystemText(text) {
  return String(text || '')
    .replace(/^Interactive web UI enabled\.\s*Type \/help for commands\.\s*/i, '工作台已连接。输入 `/help` 可查看命令说明。')
    .replace(/\bSession:\s*/gi, '会话：')
    .replace(/\bTip:\s*/gi, '提示：')
    .replace(/Start fresh/gi, '重新开始')
    .replace(/\/reset clears the visible conversation and adds a reset marker so you can start a fresh thread in the same session\./gi, '`/reset` 会清空当前可见对话，并插入一个重置标记，方便你在同一会话中重新开始。')
    .replace(/^new session\s+/i, '已新建会话：')
    .replace(/^deleted session\s+/i, '已删除会话：')
    .replace(/^resumed session\s+(.+?):\s+(\d+)\s+messages?\s+from\s+(.+)$/i, '已恢复会话：$1，共载入 $2 条消息，来源：$3')
    .replace(/\((\d+)\s+resumed messages\)/gi, '（已恢复 $1 条消息）')
    .replace(/\bType \/help for commands\./gi, '输入 `/help` 可查看命令说明。')
}

function lineTitle(line) {
  if (line.kind === 'tool' || line.toolName) {
    const name = exactToolName(line)
    return isPlanToolLine(line) ? '任务计划' : LINE_TITLE_LABELS[name] || name
  }
  if (line.title) return LINE_TITLE_LABELS[line.title] || LINE_TITLE_LABELS[String(line.title).toLowerCase()] || line.title
  if (line.kind === 'assistant') return '助手'
  if (line.kind === 'user') return '你'
  if (line.kind === 'thinking') return '思考'
  return '系统'
}

function exactToolName(line) {
  return String(line?.toolName || 'tool').trim() || 'tool'
}

function isPlanToolLine(line) {
  return line?.kind === 'tool' && exactToolName(line).toLowerCase() === 'plan'
}

function isInlineRichToolLine(line) {
  return isPlanToolLine(line) || isImage2Line(line) || isExposeDownloadsLine(line) || isXhsArtifactLine(line)
}

function isPromptUsageLine(line) {
  return line?.kind === 'meta' && String(line?.title || '') === '提示词用法'
}

function isCompactionLine(line) {
  return Boolean(line?.compaction && typeof line.compaction === 'object')
}

function compactionModeText(line) {
  return line?.compaction?.modelDriven ? '模型生成摘要' : '确定性摘要'
}

function openCompactionDetail(line) {
  if (!isCompactionLine(line)) return
  state.compactionDetailLineId = line.id
  document.body.classList.add('runtime-context-open')
}

function closeCompactionDetail() {
  state.compactionDetailLineId = undefined
  if (!state.runtimeContextModal && !state.runtimeContextDetail) document.body.classList.remove('runtime-context-open')
}

function shouldCollapseToolLine(line) {
  const isToolResult = line?.kind === 'tool' || (line?.kind === 'error' && line?.toolName)
  return isToolResult && !isInlineRichToolLine(line)
}

function openToolDetail(line) {
  if (!line || !line.text) return
  state.toolDetailLineId = line.id
  document.body.classList.add('tool-detail-open')
}

function closeToolDetail() {
  state.toolDetailLineId = undefined
  document.body.classList.remove('tool-detail-open')
}

function handleDocumentImageClick(event) {
  const image = event.target instanceof HTMLImageElement ? event.target : null
  if (!image || image.closest('.image-preview-modal')) return
  const previewSource = image.closest('[data-preview-src]')?.dataset.previewSrc || image.currentSrc || image.src
  if (!previewSource) return
  event.preventDefault()
  event.stopPropagation()
  openImagePreview(previewSource, image.alt)
}

function openImagePreview(src, caption = '') {
  state.imagePreview = { src: String(src || ''), caption: String(caption || '').trim() }
  document.body.classList.add('image-preview-open')
}

function closeImagePreview() {
  state.imagePreview = undefined
  document.body.classList.remove('image-preview-open')
}

function toolResultStatus(line) {
  return toolResultPresentation(line).status
}

function toolResultSummary(line) {
  return toolResultPresentation(line).summary
}

function visibleToolFacts(line) {
  const facts = Array.isArray(line?.toolDisplay?.facts) ? line.toolDisplay.facts : []
  return facts.filter((fact) => String(fact?.label || '').trim() !== '状态')
}

function toolResultPresentation(line) {
  const live = line?.live === true
  const failed = line?.titleStatus === 'failure' || line?.kind === 'error'
  const status = live
    ? { key: 'running', label: '运行中' }
    : failed ? { key: 'failed', label: '失败' } : { key: 'completed', label: '成功' }
  const display = line?.toolDisplay && typeof line.toolDisplay === 'object' ? line.toolDisplay : undefined
  const summary = String(display?.purpose || display?.subject || line?.bodyTitle || '').trim()
  return { status, summary }
}

function truncateSummary(value, maxLength) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

function isImage2Line(line) {
  return line?.kind === 'tool' && String(line?.toolName || '').toLowerCase() === 'image2'
}

function isImage2LiveLine(line) {
  return line?.live && isImage2Line(line)
}

function isImage2PendingReplacementLine(line) {
  return isImage2Line(line) && line?.pendingReplacement === true
}

function shouldHideLine(line) {
  if (isGeneratedImageLine(line) && !isImage2Line(line)) return true
  if (line?.kind !== 'user') return false
  const group = userMessageGroup(line)
  if (userGroupHasImages(group)) return String(userMessageOwner(group)?.id) !== String(line?.id)
  return !lineText(line)
    && directLineImagePreviews(line).length === 0
    && imageLabelsFromText(line?.text).length === 0
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

function backgroundTaskStatusMap(tasks = []) {
  return new Map(tasks.map((task) => [String(task.taskId || task.agentId || task.description || task.type), task.status]))
}

function backgroundTaskKey(task) {
  return String(task?.taskId || task?.agentId || task?.sessionId || '')
}

function backgroundTaskTitle(task) {
  const value = String(task?.description || task?.command || task?.type || '后台任务').replace(/\s+/g, ' ').trim()
  return value || '后台任务'
}

function backgroundTaskDisplayTitle(task) {
  const value = backgroundTaskTitle(task)
  return value.length > 72 ? `${value.slice(0, 72)}…` : value
}

function backgroundTaskKindText(task) {
  if (task?.kind === 'terminal') return '终端'
  if (task?.kind === 'session') return '会话'
  return task?.agentType || task?.type || '任务'
}

function backgroundTaskElapsed(task) {
  const raw = task?.createdAt
  const numeric = Number(raw)
  const createdAt = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(String(raw || ''))
  if (!Number.isFinite(createdAt) || createdAt <= 0) return ''
  return formatDuration(state.clockTick - createdAt)
}

function backgroundTaskPrompt(task) {
  return String(task?.prompt || task?.command || '').trim()
}

function backgroundTaskActivity(task) {
  return String(task?.progress?.lastText || task?.progress?.lastActivity || '').trim()
}

function backgroundTaskLiveOutput(task) {
  return stripAnsi(String(task?.output || ''))
}

function openBackgroundTaskDetail(task) {
  state.backgroundTaskDetail = { ...task }
  document.body.classList.add('tool-detail-open')
}

function closeBackgroundTaskDetail() {
  state.backgroundTaskDetail = undefined
  document.body.classList.remove('tool-detail-open')
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

function loginProviderOptions(providers) {
  return (providers || []).map((provider) => ({ value: provider, label: LOGIN_PROVIDER_LABELS[provider] || provider }))
}

function loginFieldOptions(field) {
  return (field?.options || []).map((option) => ({ value: option, label: option || '默认' }))
}

function shouldMarkdown(line) {
  return !['ansi', 'plain', 'diff'].includes(line.format) && ['assistant', 'thinking', 'system', 'tool'].includes(line.kind)
}

function runtimeToolSummary(tool) {
  const description = String(tool?.description || '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim()
  if (!description) return '未提供说明'
  return description.length > 150 ? `${description.slice(0, 150)}…` : description
}

function runtimeToolSchema(tool) {
  return JSON.stringify(tool?.inputSchema || {}, null, 2)
}

function runtimeSectionLabel(section) {
  return section?.cacheStable ? '稳定缓存段' : '动态段'
}

function openRuntimeContextModal(kind) {
  state.runtimeContextModal = kind
  state.runtimeContextDetail = undefined
  document.body.classList.add('runtime-context-open')
  if (kind === 'plugins') void fetchSessionPlugins()
  if (kind === 'tools') void fetchSessionTools()
}

function closeRuntimeContextModal() {
  state.runtimeContextDetail = undefined
  state.runtimeContextModal = ''
  document.body.classList.remove('runtime-context-open')
}

function closeRuntimeContextDetail() {
  state.runtimeContextDetail = undefined
}

function openRuntimePromptDetail(section) {
  state.runtimeContextDetail = {
    kind: 'prompt',
    title: section.name,
    meta: runtimeSectionLabel(section),
    content: section.content,
  }
}

function openRuntimeFullPromptDetail() {
  state.runtimeContextDetail = {
    kind: 'prompt',
    title: '完整系统提示词',
    meta: `${compactNumber(state.runtimeContext?.prompt?.chars || 0)} 字符`,
    content: state.runtimeContext?.prompt?.systemPrompt || '',
  }
}

function openRuntimeToolDetail(tool) {
  if (!tool) return
  state.runtimeContextDetail = {
    kind: 'tool',
    title: tool.name,
    meta: tool.strict ? '严格模式' : '兼容模式',
    description: tool.description || '',
    schema: runtimeToolSchema(tool),
  }
}

function renderLine(line) {
  if (isPlanToolLine(line)) return renderPlanResult(line)
  if (isImage2ResultLine(line)) return renderImage2Result(line)
  if (isExposeDownloadsLine(line)) return renderExposeDownloadsResult(line)
  if (isReadXhsArtifactLine(line)) return sanitizeMarkdown(marked.parse('已读取稿件'))
  if (isImageNoteLine(line)) return renderImageNoteResult(line)
  if (isSkillReadLine(line)) return renderSkillReadResult(line)
  const text = lineText(line)
  const key = [line.id, line.kind, line.format, line.title, line.titleStatus, line.live ? '1' : '0', text].join('\u001f')
  const cached = renderedLineCache.get(key)
  if (cached !== undefined) return cached
  let html
  if (line.format === 'diff') html = renderDiff(text)
  else if (line.format === 'ansi' || !shouldMarkdown(line)) html = linkify(escapeHtml(stripAnsi(text)))
  else html = sanitizeMarkdown(marked.parse(text || ''))
  renderedLineCache.set(key, html)
  return html
}

function renderToolDetail(line) {
  if (!line) return ''
  if (isImage2Line(line)) return renderImage2Detail(line)
  const text = lineText(line)
  if (line.format === 'diff' || /(?:^|\n)---\s+.+\n\+\+\+\s+/.test(text)) return renderDiff(text)
  if (line.format === 'ansi') return `<pre class="tool-detail-pre">${escapeHtml(stripAnsi(text))}</pre>`
  const parsed = parseFirstJsonObject(text)
  if (parsed) {
    const json = JSON.stringify(parsed, null, 2)
    return sanitizeMarkdown(marked.parse(`\`\`\`json\n${json}\n\`\`\``))
  }
  return `<pre class="tool-detail-pre">${escapeHtml(stripAnsi(text))}</pre>`
}

function renderPlanResult(line) {
  const plan = parsePlanResult(line)
  const items = Array.isArray(plan?.items) ? plan.items : []
  if (!plan || !items.length) return sanitizeMarkdown(marked.parse(lineText(line) || ''))
  const counts = countPlanItems(items)
  const completed = Number.isFinite(Number(plan.completed))
    ? Number(plan.completed)
    : counts.completed
  const total = Number.isFinite(Number(plan.total)) ? Number(plan.total) : counts.total
  const progress = total > 0 ? Math.max(0, Math.min(100, completed / total * 100)) : 0
  const title = escapeHtml(plan.title || '任务计划')
  const rows = renderPlanItems(items)
  const note = plan.note ? `<div class="plan-note"><span>说明</span><p>${escapeHtml(plan.note)}</p></div>` : ''
  return `<section class="plan-card"><div class="plan-card-head"><div><span class="plan-kicker">执行计划</span><strong>${title}</strong></div><span class="plan-progress-label">${completed} / ${total}</span></div><div class="plan-progress-track" aria-label="计划进度 ${Math.round(progress)}%"><span style="width:${progress.toFixed(2)}%"></span></div><ol class="plan-items">${rows}</ol>${note}</section>`
}

function renderPlanItems(items, depth = 0) {
  return items.map((item, index) => {
    const status = normalizePlanStatus(item?.status)
    const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : status === 'failed' ? '!' : String(index + 1)
    const children = Array.isArray(item?.subitems) ? item.subitems : []
    const nested = children.length
      ? `<ol class="plan-subitems" aria-label="${escapeHtml(item?.description || `步骤 ${index + 1}`)}的子步骤">${renderPlanItems(children, depth + 1)}</ol>`
      : ''
    return `<li class="plan-item status-${status}" data-plan-depth="${depth}"><div class="plan-item-row"><span class="plan-item-marker" aria-hidden="true">${icon}</span><span class="plan-item-text">${escapeHtml(item?.description || `步骤 ${index + 1}`)}</span><span class="plan-item-status">${planStatusLabel(status)}</span></div>${nested}</li>`
  }).join('')
}

function countPlanItems(items) {
  return items.reduce((counts, item) => {
    counts.total += 1
    if (normalizePlanStatus(item?.status) === 'completed') counts.completed += 1
    if (Array.isArray(item?.subitems) && item.subitems.length) {
      const nested = countPlanItems(item.subitems)
      counts.total += nested.total
      counts.completed += nested.completed
    }
    return counts
  }, { total: 0, completed: 0 })
}

function parsePlanResult(line) {
  const raw = String(line?.text || '')
  const parsed = parseFirstJsonObject(raw)
  const structured = parsed?.output && typeof parsed.output === 'object' ? parsed.output : parsed
  if (Array.isArray(structured?.items)) return structured

  const lines = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  const summary = /^(\d+)\s*\/\s*(\d+)\s+completed/i.exec(lines[0] || '')
  const itemLines = lines.filter((item) => /^[-*]\s+/.test(item))
  const items = itemLines.map((item) => {
    let description = item.replace(/^[-*]\s+/, '').trim()
    let status = 'pending'
    if (/^~~[\s\S]+~~$/.test(description)) {
      status = 'completed'
      description = description.slice(2, -2).trim()
    } else if (/^[▶►●]\s*/.test(description)) {
      status = 'in_progress'
      description = description.replace(/^[▶►●]\s*/, '').trim()
    } else if (/^[!✗×]\s*/.test(description)) {
      status = 'failed'
      description = description.replace(/^[!✗×]\s*/, '').trim()
    }
    return { description, status }
  })
  const note = lines
    .slice(summary ? 1 : 0)
    .filter((item) => !/^[-*]\s+/.test(item))
    .join(' ')
  return {
    title: '当前执行计划',
    note,
    items,
    completed: summary ? Number(summary[1]) : items.filter((item) => item.status === 'completed').length,
    total: summary ? Number(summary[2]) : items.length,
  }
}

function normalizePlanStatus(status) {
  const value = String(status || 'pending').toLowerCase().replace(/[\s-]+/g, '_')
  if (value === 'complete' || value === 'done') return 'completed'
  if (value === 'running' || value === 'inprogress') return 'in_progress'
  if (value === 'error') return 'failed'
  return ['completed', 'in_progress', 'failed', 'pending'].includes(value) ? value : 'pending'
}

function planStatusLabel(status) {
  return {
    completed: '已完成',
    in_progress: '进行中',
    failed: '失败',
    pending: '待处理',
  }[status] || '待处理'
}

function renderDiff(text) {
  return `<pre class="diff-block">${escapeHtml(text)}</pre>`
}

function isImage2ResultLine(line) {
  return isImage2Line(line) && /\b(ok|failed|generated|edited|image\s+(?:generate|edit)\s+failed)\b/i.test(String(line?.text || ''))
}

function isExposeDownloadsLine(line) {
  const title = String(line?.title || '').toLowerCase()
  return line?.kind === 'tool' && (title === 'expose_downloads' || title === '文件下载')
}

function isReadXhsArtifactLine(line) {
  const title = String(line?.title || '').toLowerCase()
  return line?.kind === 'tool' && title === 'read_xhs_artifact'
}

function isImageNoteLine(line) {
  const title = String(line?.title || '').toLowerCase()
  return line?.kind === 'tool' && title === 'image_note'
}

function isSkillReadLine(line) {
  const title = String(line?.title || '').toLowerCase()
  return line?.kind === 'tool' && title === 'skill_read'
}

function renderSkillReadResult(line) {
  return sanitizeMarkdown(marked.parse(`技能${skillReadName(line?.text || '')}`))
}

function skillReadName(text) {
  const value = String(text || '')
  const name = /\bname:\s*([^\s]+)/i.exec(value)?.[1] ||
    /(?:^|\s)skill:\s*([^\s]+)/i.exec(value)?.[1] ||
    /(?:^|\s)id:\s*([^\s]+)/i.exec(value)?.[1]
  const cleaned = String(name || '').trim()
  return cleaned ? cleaned : ''
}

function renderImageNoteResult(line) {
  return sanitizeMarkdown(marked.parse(`图片记录${imageNoteLabel(line?.text || '')}`))
}

function imageNoteLabel(text) {
  const label = firstImageNoteLabel(text)
  return label ? ` ${label}` : ''
}

function firstImageNoteLabel(text) {
  const value = String(text || '')
  const filename = /(?:^|\s)(?:storagePath|path|file|filename):\s*([^\s]+\.(?:png|jpe?g|webp|gif|bmp|avif|txt))/i.exec(value)?.[1]
  const filenameLabel = filename ? cleanImageNoteLabel(filename.split(/[\\/]/).pop() || '') : ''
  if (filenameLabel) return filenameLabel
  const imageRef = /(?:^|\s)imageRef:\s*([^\s]+)/i.exec(value)?.[1]
  const refLabel = cleanImageNoteLabel(imageRef || '')
  if (refLabel) return refLabel
  const tag = /(?:^|\s)tags:\s*(?:[-*]\s*)?([^\n\r,，]+)/i.exec(value)?.[1] ||
    /(?:^|\s)detectedText:\s*(?:[-*]\s*)?([^\n\r,，]+)/i.exec(value)?.[1] ||
    /(?:^|\s)caption:\s*([^.,，。;\n\r]{2,24})/i.exec(value)?.[1]
  return cleanImageNoteLabel(tag || '')
}

function cleanImageNoteLabel(value) {
  let text = String(value || '').trim()
  text = text.replace(/\.base64\.txt$/i, '').replace(/\.(?:png|jpe?g|webp|gif|bmp|avif|txt)$/i, '')
  text = text.replace(/^[-*]\s*/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text || /^ok$/i.test(text)) return ''
  return text.length > 18 ? `${text.slice(0, 18)}...` : text
}

function isXhsArtifactLine(line) {
  const title = String(line?.title || '').toLowerCase()
  return line?.kind === 'tool' && (title === 'open_xhs_artifact_editor' || title === '小红书产物编辑器')
}

function xhsArtifactForLine(line) {
  const artifact = parseXhsArtifactToolOutput(line?.artifact) || parseXhsArtifactToolOutput(line?.text)
  if (!artifact) return null
  const id = String(artifact.id)
  const current = state.xhsArtifacts[id]
  const selected = selectNewestXhsArtifact(current, artifact)
  if (selected !== current) state.xhsArtifacts[id] = selected
  return state.xhsArtifacts[id]
}

async function repairRuntimeSessionBinding() {
  if (runtimeSessionRepairing || !runtimeSessionId) return
  runtimeSessionRepairing = true
  try {
    const connected = await bindRuntimeSession(runtimeSessionId)
    if (!connected) throw new Error('无法重新绑定目标会话')
  } catch (error) {
    notify(`会话恢复失败：${error.message || error}`)
  } finally {
    runtimeSessionRepairing = false
  }
}

async function bindRuntimeSession(sessionId) {
  const targetSessionId = String(sessionId || '').trim()
  if (!targetSessionId) return false
  disconnectRuntimeEvents()
  runtimeSessionId = targetSessionId
  allowRuntimeSessionChange = false
  sessionStorage.setItem(RUNTIME_SESSION_ID_KEY, targetSessionId)
  const connected = await fetchState({ silent: true })
  if (!connected || String(state.session?.sessionId || '') !== targetSessionId) return false
  connectEvents()
  return true
}

async function restoreRuntimeBinding(tabId, sessionId) {
  disconnectRuntimeEvents()
  runtimeTabId = tabId
  runtimeSessionId = sessionId
  allowRuntimeSessionChange = !sessionId
  sessionStorage.setItem(RUNTIME_TAB_ID_KEY, tabId)
  if (sessionId) sessionStorage.setItem(RUNTIME_SESSION_ID_KEY, sessionId)
  else sessionStorage.removeItem(RUNTIME_SESSION_ID_KEY)
  const restored = await fetchState({ silent: true })
  if (restored) connectEvents()
  return restored
}

function disconnectRuntimeEvents() {
  if (es) es.close()
  es = undefined
  if (syncRaf) cancelAnimationFrame(syncRaf)
  syncRaf = 0
  resetLineTextScheduler()
  pendingSyncPayload = undefined
  hasReceivedEventSync = false
  state.connected = false
  state.connecting = true
}

function handleXhsArtifactSaved(artifact) {
  if (artifact?.id) state.xhsArtifacts[artifact.id] = artifact
}

function handleXhsArtifactError(message) {
  notify(message || '小红书产物保存失败')
}

function renderExposeDownloadsResult(line) {
  const downloads = parseExposeDownloads(line.text || '')
  if (!downloads.length) return linkify(escapeHtml(stripAnsi(lineText(line))))
  const cards = downloads.map((item) => {
    const filename = escapeHtml(item.filename || item.name || 'download')
    const href = escapeHtml(downloadHref(item))
    const size = item.sizeBytes || item.size ? formatBytes(item.sizeBytes || item.size) : ''
    const expires = item.expiresAt ? formatDownloadExpiry(item.expiresAt) : ''
    const meta = [size, expires].filter(Boolean).join(' · ')
    return `<a class="download-card" href="${href}" download><span class="download-icon" aria-hidden="true">↓</span><span class="download-main"><strong>${filename}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</span><span class="download-action">下载</span></a>`
  }).join('')
  return `<div class="download-result"><div class="download-grid">${cards}</div></div>`
}

function parseExposeDownloads(text) {
  const parsed = parseFirstJsonObject(text)
  const downloads = parsed?.downloads || parsed?.output?.downloads || parsed?.result?.downloads
  if (Array.isArray(downloads)) return downloads.filter((item) => item && typeof item === 'object')
  return parseDownloadLinksFromText(text)
}

function parseDownloadLinksFromText(text) {
  const value = String(text || '')
  const urls = Array.from(new Set(value.match(/\/api\/downloads\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+/g) || []))
  if (!urls.length) return []
  const filenames = Array.from(value.matchAll(/filename:\s*([^\n]+)|-\s*([^:\n]+):\s*\/api\/downloads\//g))
    .map((match) => (match[1] || match[2] || '').trim())
    .filter(Boolean)
  return urls.map((url, index) => ({
    id: decodeURIComponent(url.slice('/api/downloads/'.length)),
    url,
    filename: filenames[index] || `下载文件 ${index + 1}`,
  }))
}

function downloadHref(item) {
  const url = String(item?.url || '')
  if (url.startsWith('/api/downloads/')) return url
  return `/api/downloads/${encodeURIComponent(item?.id || '')}`
}

function parseFirstJsonObject(text) {
  const raw = String(text || '')
  if (!raw.includes('{')) return null
  const candidates = balancedJsonObjectCandidates(raw)
  candidates.sort((left, right) => left.start - right.start || right.end - left.end)
  for (const { start, end } of candidates) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {}
  }
  return null
}

function balancedJsonObjectCandidates(raw) {
  const candidates = []
  const stack = []
  let inString = false
  let escaped = false
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      else if (character === '\n' || character === '\r') {
        // Raw newlines are invalid inside JSON strings. Recover so a malformed
        // source snippet cannot hide a valid JSON object later in the output.
        inString = false
        escaped = false
      }
      continue
    }
    if (stack.length && character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      stack.push(index)
      continue
    }
    if (character === '}' && stack.length) {
      candidates.push({ start: stack.pop(), end: index })
    }
  }
  return candidates
}

function formatDownloadExpiry(value) {
  const time = Number(value)
  if (!Number.isFinite(time)) return ''
  const remaining = time - Date.now()
  if (remaining <= 0) return '已过期'
  return `${formatDuration(remaining)} 后过期`
}

function renderImage2Stage(line) {
  const images = lineImagePreviews(line)
  if (images.length) return `<div class="image2-result-block">${renderImage2Result(line)}${renderImageGrid(images)}</div>`
  if (isImage2ResultLine(line)) return renderImage2Result(line)
  return renderImage2Skeleton(line)
}

function renderImage2Skeleton(line) {
  const metadata = image2InvocationMetadata(line)
  const prompt = metadata.prompt
    ? `<div class="image2-stage-prompt"><p>${escapeHtml(truncateSummary(metadata.prompt, 240))}</p></div>`
    : ''
  const diamonds = Array.from({ length: 11 }, (_, index) => `<i class="diamond-${index + 1}"></i>`).join('')
  return `<div class="image2-stage"><div class="image2-diamond-field" aria-hidden="true">${diamonds}<b></b></div>${prompt}</div>`
}

function image2InvocationMetadata(line) {
  const parsed = parseFirstJsonObject(line?.text || '') || {}
  const input = parsed.input || parsed.arguments || parsed.args || parsed
  return {
    mode: String(input.mode || '').toLowerCase(),
    model: String(input.model || ''),
    size: String(input.size || ''),
    prompt: String(input.prompt || ''),
  }
}

function renderImageGrid(images) {
  const items = images.map((item, index) => {
    const caption = escapeHtml(imageCaption(item, index))
    if (!item.available || !item.previewUrl) {
      return `<figure class="message-image-attachment image-unavailable"><div class="image-unavailable-placeholder" role="status">图片不可用</div><figcaption>${caption}</figcaption></figure>`
    }
    const href = escapeHtml(item.originalUrl || item.previewUrl)
    const src = escapeHtml(item.previewUrl)
    const download = escapeHtml(imageDownloadName(item, index))
    return `<figure class="message-image-attachment"><button type="button" class="image-preview-trigger" data-preview-src="${href}" aria-label="预览 ${caption}"><img src="${src}" alt="${caption}" loading="lazy" decoding="async" /></button><figcaption>${caption}</figcaption><a class="image-download" href="${href}" download="${download}">下载</a></figure>`
  }).join('')
  return `<div class="message-image-attachments image2-output-images">${items}</div>`
}

function renderImage2Result(line) {
  const parsed = parseImage2Result(line.text || '')
  const text = String(line.text || '')
  const status = /\bfail(?:ed)?\b|failed/i.test(text) ? '生成失败' : /^edited\b/i.test(text.trim()) ? '修改完成' : '生成完成'
  const chips = [parsed.count ? `${parsed.count} 张` : '', parsed.model, parsed.size, parsed.quality, parsed.outputFormat, parsed.sourceImages ? `源图 ${parsed.sourceImages} 张` : '', parsed.duration].filter(Boolean)
  return `<div class="image2-result"><div class="image2-summary"><strong>${escapeHtml(status)}</strong>${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join('')}</div></div>`
}

function renderImage2Detail(line) {
  const parsed = parseImage2Result(line?.text || '')
  const fields = [
    ['模型', parsed.model],
    ['模式', parsed.mode],
    ['尺寸', parsed.size],
    ['质量', parsed.quality],
    ['格式', parsed.outputFormat],
    ['背景', parsed.background],
    ['图片数量', parsed.count ? `${parsed.count} 张` : ''],
    ['源图数量', parsed.sourceImages ? `${parsed.sourceImages} 张` : ''],
    ['耗时', parsed.duration],
    ['语义名称', parsed.semanticName],
    ['开始时间', parsed.startedAt],
    ['完成时间', parsed.finishedAt],
  ].filter(([, value]) => value)
  const metadata = fields.length
    ? `<dl class="image2-detail-grid">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
    : ''
  const prompt = parsed.prompt
    ? `<section class="image2-detail-prompt"><span>调用提示词</span><p>${escapeHtml(parsed.prompt)}</p></section>`
    : `<section class="image2-detail-prompt empty"><span>调用提示词</span><p>当前历史记录未保存提示词；新执行的 image2 调用会在这里显示。</p></section>`
  const revisedPrompt = parsed.revisedPrompt && parsed.revisedPrompt !== parsed.prompt
    ? `<section class="image2-detail-prompt"><span>修订提示词</span><p>${escapeHtml(parsed.revisedPrompt)}</p></section>`
    : ''
  return `<div class="image2-detail-view">${metadata}${prompt}${revisedPrompt}</div>`
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
    prompt: matchImage2Field(compact, 'prompt', ['revisedPrompt', 'mode', 'semanticName', 'size', 'quality', 'outputFormat', 'background', 'returnedImages', 'startedAt', 'finishedAt', 'duration']),
    mode: matchImage2Field(compact, 'mode', ['semanticName', 'prompt', 'size', 'quality']),
    semanticName: matchImage2Field(compact, 'semanticName', ['prompt', 'size', 'quality', 'outputFormat']),
    size: matchImage2Field(compact, 'size', ['quality', 'outputFormat', 'background', 'returnedImages', 'duration']) || detailParts.find((part) => /^\d+x\d+$/i.test(part)) || '',
    quality: matchImage2Field(compact, 'quality', ['outputFormat', 'background', 'returnedImages', 'duration']) || detailParts.find((part) => ['low', 'medium', 'high'].includes(part.toLowerCase())) || '',
    outputFormat: matchImage2Field(compact, 'outputFormat', ['background', 'returnedImages', 'images', 'duration']) || detailParts.find((part) => ['png', 'jpeg', 'jpg', 'webp'].includes(part.toLowerCase())) || '',
    background: matchImage2Field(compact, 'background', ['returnedImages', 'images', 'startedAt', 'finishedAt', 'duration']),
    sourceImages: matchImage2Field(compact, 'source images', ['prompt', 'mode', 'semanticName', 'duration']),
    count: matchImage2Field(compact, 'returnedImages', ['images', 'index', 'duration']) || generated?.[2] || '',
    revisedPrompt: matchImage2Field(compact, 'revisedPrompt', ['mode', 'semanticName', 'raw', 'created', 'data', 'b64_json', 'background', 'output_format', 'quality', 'size', 'usage', 'startedAt', 'finishedAt', 'duration']),
    usage: matchImage2Field(compact, 'usage', ['duration']),
    startedAt: matchImage2Field(compact, 'startedAt', ['finishedAt', 'duration']),
    finishedAt: matchImage2Field(compact, 'finishedAt', ['duration']),
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
  if (event.key === 'Escape' && state.contextWindowModalOpen) {
    event.preventDefault()
    closeContextWindowModal()
    return
  }
  if (event.key === 'Escape' && state.compactionDetailLineId !== undefined) {
    event.preventDefault()
    closeCompactionDetail()
    return
  }
  if (event.key === 'Escape' && state.backgroundTaskDetail) {
    event.preventDefault()
    closeBackgroundTaskDetail()
    return
  }
  if (event.key === 'Escape' && state.runtimeContextDetail) {
    event.preventDefault()
    closeRuntimeContextDetail()
    return
  }
  if (event.key === 'Escape' && state.runtimeContextModal) {
    event.preventDefault()
    closeRuntimeContextModal()
    return
  }
  if (event.key === 'Escape' && state.confirmDialog.open) {
    event.preventDefault()
    resolveConfirmation(false)
    return
  }
  if (event.key === 'Escape' && state.imagePreview) {
    event.preventDefault()
    closeImagePreview()
    return
  }
  if (event.key === 'Escape' && state.toolDetailLineId !== undefined) {
    event.preventDefault()
    closeToolDetail()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    composer.value?.focus()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !input.value) {
    interrupt()
  }
}

function resolveInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // Fall through to the operating-system preference when storage is unavailable.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value
  document.documentElement.style.colorScheme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#0c0c0f' : '#ffffff')
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // Theme switching still works for the current page when storage is unavailable.
  }
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

async function handlePaste(event) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (!files.length) return
  event.preventDefault()
  const compressionRates = []
  for (const file of files) {
    const id = ++state.attachmentCounter
    const label = `[img#${id}]`
    const payload = await fileToDataUrlPayload(file)
    if (payload.compressionRate > 0) {
      compressionRates.push(payload.compressionRate)
    }
    state.attachments.push({ kind: 'image', imageId: createClientImageId(), label, mimeType: payload.mimeType, data: payload.data, previewUrl: payload.previewUrl, name: file.name || `图片 ${id}` })
  }
  notify(`已添加 ${files.length} 张图片附件`)
  if (compressionRates.length) setTimeout(() => notify(compressionToastText(compressionRates)), 0)
}

function triggerFilePicker() {
  fileInput.value?.click()
}

async function handleFileInputChange(event) {
  const files = Array.from(event?.target?.files || [])
  if (!files.length) return
  await uploadFiles(files)
  if (event?.target) event.target.value = ''
}

async function uploadFiles(files) {
  state.uploadingFiles = true
  try {
    const uploaded = []
    const compressionRates = []
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const payload = await fileToDataUrlPayload(file)
        const label = `[img#${++state.attachmentCounter}]`
        if (payload.compressionRate > 0) compressionRates.push(payload.compressionRate)
        uploaded.push({
          kind: 'image',
          imageId: createClientImageId(),
          label,
          name: file.name || label,
          mimeType: payload.mimeType,
          data: payload.data,
          previewUrl: payload.previewUrl,
        })
        continue
      }
      const payload = await fileToBase64Payload(file)
      const result = await postJson('/api/uploads', {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: payload.data,
      })
      if (!result?.file?.absolutePath) throw new Error('upload response missing path')
      uploaded.push({
        kind: 'file',
        label: `[file#${++state.attachmentCounter}]`,
        name: result.file.name || file.name || `附件 ${state.attachmentCounter}`,
        mimeType: result.file.mimeType || file.type || 'application/octet-stream',
        size: Number(result.file.size || file.size || 0),
        absolutePath: result.file.absolutePath,
        relativePath: result.file.relativePath || '',
      })
    }
    state.attachments.push(...uploaded)
    if (compressionRates.length) setTimeout(() => notify(compressionToastText(compressionRates)), 0)
    notify(`已上传 ${uploaded.length} 个附件`)
  } catch (error) {
    notify(error.message || String(error))
  } finally {
    state.uploadingFiles = false
  }
}

function createClientImageId() {
  if (typeof crypto?.randomUUID === 'function') return `image_${crypto.randomUUID()}`
  return `image_${Date.now().toString(16).slice(-8).padStart(8, '0')}-${Math.random().toString(16).slice(2, 6).padEnd(4, '0')}-4${Math.random().toString(16).slice(2, 5).padEnd(3, '0')}-a${Math.random().toString(16).slice(2, 5).padEnd(3, '0')}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`
}

function textWithAttachmentLabels(text, attachments) {
  if (!attachments.length) return text
  const suffix = attachments.map((attachment) => attachment.label).join(' ')
  return text.trim() ? `${text.trim()}\n\n${suffix}` : suffix
}

function stripImageLabels(text) {
  return String(text).replace(/\s*\[img#\d+\]\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

function stripImageOperationHint(text) {
  return String(text)
    .replace(LEGACY_IMAGE_GENERATION_HINT, '')
    .replace(LEGACY_IMAGE_OPERATION_HINT, '')
    .replace(LEGACY_DOWNLOAD_EXPOSURE_HINT, '')
    .replace(XHS_ARTIFACT_EDITOR_HINT, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function stripHiddenAttachmentManifest(text) {
  return String(text || '')
    .replace(new RegExp(`${escapeRegExp(ATTACHMENT_MANIFEST_START)}[\\s\\S]*?${escapeRegExp(ATTACHMENT_MANIFEST_END)}`, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function imageLabelsFromText(text) {
  return Array.from(new Set(String(text || '').match(/\[img#\d+\]/g) || []))
}

function cacheMessageImagePreviews(attachments) {
  const sessionId = String(state.session?.sessionId || runtimeSessionId || '')
  const previews = attachments
    .filter((attachment) => attachment?.kind === 'image' && attachment.imageId && attachment.previewUrl)
    .map((attachment) => ({
      sessionId,
      imageId: attachment.imageId,
      label: attachment.label,
      mimeType: attachment.mimeType,
      previewUrl: attachment.previewUrl,
      originalUrl: attachment.previewUrl,
      name: attachment.name,
      available: true,
      pending: true,
    }))
  mergeMessageImagePreviews(previews)
}

function syncMessageImagePreviewsFromLines(lines) {
  const previews = []
  for (const line of lines || []) collectLineImageItems(line, previews)
  mergeMessageImagePreviews(previews.map(normalizeImagePreview).filter(Boolean))
}

function imagePreviewIdentity(item) {
  const sessionId = String(item?.sessionId || state.session?.sessionId || runtimeSessionId || '')
  if (item?.imageId) return `${sessionId}:image:${item.imageId}`
  if (item?.messageId && Number.isInteger(Number(item?.blockIndex))) return `${sessionId}:block:${item.messageId}:${Number(item.blockIndex)}`
  return ''
}

function mergeMessageImagePreviews(previews) {
  if (!previews.length) return
  const normalized = previews.map((item) => ({ ...item, sessionId: String(item.sessionId || state.session?.sessionId || runtimeSessionId || '') }))
  const identities = new Set(normalized.map(imagePreviewIdentity).filter(Boolean))
  state.messageImagePreviews = [
    ...state.messageImagePreviews.filter((item) => {
      const identity = imagePreviewIdentity(item)
      return !identity || !identities.has(identity)
    }),
    ...normalized,
  ].slice(-200)
}

function lineImagePreviews(line) {
  if (isImage2Line(line)) return image2LineImages(line)
  const group = line?.kind === 'user' ? userMessageGroup(line) : [line]
  const images = []
  for (const item of group) {
    images.push(...directLineImagePreviews(item))
    for (const label of imageLabelsFromText(item?.text)) {
      const sessionId = String(state.session?.sessionId || runtimeSessionId || '')
      const candidates = state.messageImagePreviews.filter((image) => image.sessionId === sessionId && image.label === label)
      const cached = String(item?.messageId || '').startsWith('web-user-')
        ? [...candidates].reverse().find((image) => image.pending)
        : candidates.length === 1 ? candidates[0] : undefined
      if (cached) images.push(cached)
    }
  }
  return dedupeImages(images)
}

function image2LineImages(line) {
  const images = []
  collectLineImageItems(line, images)
  for (const generatedLine of generatedImageLinesAfter(line)) collectLineImageItems(generatedLine, images)
  return dedupeImages(images.map(normalizeImagePreview).filter(Boolean))
}

function directLineImagePreviews(line) {
  const images = []
  collectLineImageItems(line, images)
  return dedupeImages(images.map((item) => normalizeImagePreview(item, line)).filter(Boolean))
}

function userMessageGroup(line) {
  if (line?.kind !== 'user') return [line]
  const messageId = String(line?.messageId || '')
  if (!messageId) return [line]
  const lines = state.lines || []
  return lines.filter((item) => item?.kind === 'user' && String(item?.messageId || '') === messageId)
}

function userGroupHasImages(group) {
  return group.some((line) => directLineImagePreviews(line).length > 0 || imageLabelsFromText(line?.text).length > 0)
}

function userMessageOwner(group) {
  return group.find((line) => lineText(line))
    || group.find((line) => directLineImagePreviews(line).length > 0 || imageLabelsFromText(line?.text).length > 0)
    || group[0]
}

function generatedImageLinesAfter(line) {
  const lines = state.lines || []
  const toolUseId = String(line?.toolUseId || '')
  if (toolUseId) {
    return lines.filter((item) => isGeneratedImageLine(item) && String(item?.parentToolUseId || '') === toolUseId)
  }
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
  const append = (item) => images.push({
    ...item,
    messageId: item.messageId || line.messageId,
    sessionId: item.sessionId || state.session?.sessionId || runtimeSessionId || '',
  })
  const collections = [line.images, line.imageAttachments, line.attachments, line.thumbnails]
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue
    for (const item of collection) {
      if (!item || (item.kind && item.kind !== 'image') || (item.type && item.type !== 'image')) continue
      append(item)
    }
  }
  if (Array.isArray(line.blocks)) {
    for (const block of line.blocks) {
      if (block?.type === 'image') append(block)
    }
  }
  if (line.image) append(line.image)
}

function normalizeImagePreview(item) {
  if (!item || typeof item !== 'object') return undefined
  const mimeType = item.mimeType || item.thumbnail?.mimeType || item.original?.mimeType || 'image/png'
  const rawPreviewUrl = item.thumbnailSrc || item.thumbnail?.src || item.previewUrl || item.src || item.originalSrc || item.original?.src || dataToImageSrc(item.data, mimeType)
  if (!rawPreviewUrl && item.available !== false) return undefined
  const previewUrl = rawPreviewUrl ? scopedImageUrl(rawPreviewUrl) : ''
  const originalRawUrl = item.originalSrc || item.original?.src || item.src || item.previewUrl || rawPreviewUrl
  return {
    sessionId: String(item.sessionId || state.session?.sessionId || runtimeSessionId || ''),
    messageId: item.messageId,
    blockIndex: Number.isInteger(Number(item.blockIndex ?? item.index)) ? Number(item.blockIndex ?? item.index) : undefined,
    imageId: item.imageId,
    label: item.label,
    mimeType,
    available: item.available !== false && Boolean(previewUrl),
    error: item.error,
    previewUrl,
    originalUrl: originalRawUrl ? scopedImageUrl(originalRawUrl) : '',
    name: item.name || item.filename || item.label,
    sizeBytes: item.sizeBytes,
    pending: item.pending === true,
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
  for (const [index, image] of images.entries()) {
    const key = imagePreviewIdentity(image)
      || (image.previewUrl ? `url:${image.previewUrl}` : `position:${image.messageId || 'unknown'}:${image.blockIndex ?? index}`)
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
  return line?.kind === 'tool' && String(line?.parentToolName || '').toLowerCase() === 'image2'
}

function removeOmittedImageDetails(line) {
  return isGeneratedImageLine(line) && lineImagePreviews(line).length > 0
}

function removeAttachment(label) {
  state.attachments = state.attachments.filter((attachment) => attachment.label !== label)
}

function fileAttachments() {
  return state.attachments.filter((attachment) => attachment.kind === 'file')
}

function imageAttachments() {
  return state.attachments.filter((attachment) => attachment.kind === 'image')
}

function fileAttachmentLabel(item, index) {
  return item?.name || `附件 ${index + 1}`
}

function fileAttachmentMeta(item) {
  return `${fileAttachmentType(item)} · ${formatBytes(item?.size)}`
}

function fileAttachmentType(item) {
  const mimeType = String(item?.mimeType || '').toLowerCase()
  if (!mimeType) return '文件'
  if (mimeType.includes('pdf')) return 'PDF'
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return '表格'
  if (mimeType.includes('word') || mimeType.includes('document')) return '文档'
  if (mimeType.startsWith('text/')) return '文本'
  if (mimeType.startsWith('image/')) return '图片'
  return '文件'
}

function formatBytes(value) {
  const size = Number(value || 0)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0).replace(/\.0$/, '')} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, '')} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '')} GB`
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
  const dataUrl = await readFileAsDataUrl(file)
  return normalizeImageDataUrlPayload(dataUrl, file.type || 'image/png')
}

async function fileToBase64Payload(file) {
  const dataUrl = await readFileAsDataUrl(file)
  const comma = dataUrl.indexOf(',')
  return { mimeType: file.type || 'application/octet-stream', data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl }
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

async function normalizeImageDataUrlPayload(dataUrl, fallbackMimeType = 'image/png') {
  const original = parseImageDataUrl(dataUrl, fallbackMimeType)
  const originalBytes = estimateBase64Bytes(original.base64)
  const image = await loadImageFromDataUrl(original.dataUrl).catch(() => undefined)
  if (!image) {
    const base64 = normalizeBase64Data(original.base64)
    if (!base64) throw new Error('图片格式异常，无法读取为有效图片')
    return { mimeType: original.mimeType, data: base64, previewUrl: `data:${original.mimeType};base64,${base64}`, compressionRate: 0 }
  }

  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
  let width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
  let height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
  let quality = 0.88
  let encoded

  for (let attempt = 0; attempt < 8; attempt += 1) {
    encoded = await encodeImageWithCanvas(image, width, height, 'image/jpeg', quality)
    if (encoded.bytes <= IMAGE_MAX_BYTES || (quality <= IMAGE_MIN_QUALITY && Math.max(width, height) <= 1280)) break
    if (quality > IMAGE_MIN_QUALITY) quality = Math.max(IMAGE_MIN_QUALITY, quality - 0.1)
    else {
      width = Math.max(1, Math.round(width * 0.82))
      height = Math.max(1, Math.round(height * 0.82))
    }
  }

  const base64 = normalizeBase64Data(encoded?.base64)
  if (!base64) throw new Error('图片格式异常，无法转换为有效图片')
  return {
    mimeType: encoded.mimeType,
    data: base64,
    previewUrl: `data:${encoded.mimeType};base64,${base64}`,
    compressionRate: compressionRatePercent(originalBytes, encoded.bytes),
  }
}

function parseImageDataUrl(value, fallbackMimeType) {
  const text = String(value || '').trim()
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(text)
  const mimeType = match?.[1]?.startsWith('image/') ? match[1] : fallbackMimeType
  const base64 = match ? match[2] : text
  return { mimeType, base64, dataUrl: match ? text : `data:${mimeType};base64,${base64}` }
}

function estimateBase64Bytes(value) {
  const normalized = normalizeBase64Data(value)
  if (!normalized) return 0
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(normalized.length * 0.75) - padding)
}

function compressionRatePercent(beforeBytes, afterBytes) {
  if (!beforeBytes || !afterBytes || afterBytes >= beforeBytes) return 0
  return Math.round((1 - afterBytes / beforeBytes) * 100)
}

function compressionToastText(rates) {
  const rate = Math.max(...rates)
  return rates.length > 1 ? `图片已压缩，最高压缩率为 ${rate}%` : `图片已压缩，压缩率为 ${rate}%`
}

function normalizeBase64Data(value) {
  let text = String(value || '').trim().replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '')
  if (!text) return ''
  text = text.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = text.length % 4
  if (remainder) text += '='.repeat(4 - remainder)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return ''
  try {
    atob(text)
    return text
  } catch {
    return ''
  }
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = dataUrl
  })
}

async function encodeImageWithCanvas(image, width, height, mimeType, quality) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas unavailable')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality))
  if (!blob) throw new Error('image encode failed')
  const dataUrl = await readFileAsDataUrl(blob)
  const parsed = parseImageDataUrl(dataUrl, mimeType)
  return { mimeType: parsed.mimeType, base64: parsed.base64, bytes: blob.size }
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

function scopedImageUrl(value) {
  const url = String(value || '')
  return url.startsWith('/api/images/') ? runtimeUrl(url) : url
}

function closeMobileMenu() {
  mobileMenu.value?.removeAttribute('open')
}

function openMobilePanel(panel) {
  closeMobileMenu()
  if (panel === 'sessions') return openSessions()
  if (panel === 'prompts') return openPromptManager()
  if (panel === 'settings') return openLogin()
  state.activePanel = 'chat'
}

function createMobileSession() {
  closeMobileMenu()
  return newSession()
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand-row logo-only">
        <button
          class="theme-toggle celestial-theme-toggle"
          type="button"
          :aria-label="themeToggleLabel"
          :aria-pressed="isDarkTheme"
          :title="themeToggleLabel"
          @click="toggleTheme"
        >
          <span class="theme-orbit-scene" aria-hidden="true">
            <i class="theme-cloud theme-cloud-one"></i>
            <i class="theme-cloud theme-cloud-two"></i>
            <i class="theme-star theme-star-one"></i>
            <i class="theme-star theme-star-two"></i>
            <i class="theme-star theme-star-three"></i>
            <span class="theme-orbit-body">
              <svg class="theme-sun" viewBox="0 0 28 28">
                <circle cx="14" cy="14" r="5.2" />
                <path d="M14 2.5v3M14 22.5v3M2.5 14h3M22.5 14h3M5.9 5.9 8 8M20 20l2.1 2.1M22.1 5.9 20 8M8 20l-2.1 2.1" />
              </svg>
              <svg class="theme-moon" viewBox="0 0 28 28">
                <path d="M20.8 18.8A9.2 9.2 0 0 1 9.2 7.2a9.2 9.2 0 1 0 11.6 11.6Z" />
                <circle cx="10.2" cy="16.8" r="1" />
                <circle cx="15.4" cy="21" r=".75" />
              </svg>
            </span>
          </span>
        </button>
      </div>

      <nav class="nav">
        <button :class="{ active: state.activePanel === 'chat' }" @click="newSession">
          <span class="nav-button-content">
            <svg class="ui-icon nav-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 4v12M4 10h12" />
            </svg>
            <span>新建会话</span>
          </span>
        </button>
        <button :class="{ active: state.activePanel === 'sessions' }" @click="openSessions">
          <span class="nav-button-content">
            <svg class="ui-icon nav-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 4.5h10a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 15 15.5H8l-3.5 2v-3.5A1.5 1.5 0 0 1 3 12.5V6A1.5 1.5 0 0 1 4.5 4.5Z" />
              <path d="M6.75 8h6.5M6.75 11h4.5" />
            </svg>
            <span>会话管理</span>
          </span>
        </button>
        <button :class="{ active: state.activePanel === 'settings' }" @click="openLogin()">
          <span class="nav-button-content">
            <svg class="ui-icon nav-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 3.5v2M10 14.5v2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M3.5 10h2M14.5 10h2M5.4 14.6l1.4-1.4M13.2 6.8l1.4-1.4" />
              <circle cx="10" cy="10" r="2.75" />
            </svg>
            <span>模型配置</span>
          </span>
        </button>
      </nav>

      <button :class="['sidebar-card', 'session-entry', { working: composerRunning }]" type="button" @click="state.activePanel = 'chat'" :title="currentTitle">
        <span class="session-entry-icon" aria-hidden="true">
          <i class="session-diamond"></i>
        </span>
        <span class="session-entry-main">
          <span ref="sessionTitleViewport" :class="['session-title-line', { marquee: titleShouldMarquee }]">
            <strong ref="sessionTitleText">{{ currentTitle }}</strong>
            <strong v-if="titleShouldMarquee" aria-hidden="true">{{ currentTitle }}</strong>
          </span>
        </span>
      </button>

      <section class="sidebar-card prompt-stack">
        <div class="prompt-stack-head">
          <button type="button" class="mini-button" @click="openPromptManager()">提示词管理</button>
        </div>

        <div class="prompt-list">
          <div v-if="state.promptLibraryLoading" class="prompt-list-empty">正在加载…</div>
          <div v-else-if="!state.promptLibrary.length" class="prompt-list-empty">暂无提示词</div>
          <article
            v-else
            v-for="item in state.promptLibrary"
            :key="item.id"
            :class="['prompt-card', { active: activeAppPrompt?.id === item.id }]"
            draggable="true"
            @dragstart="handlePromptDragStart($event, item)"
            @dragend="handlePromptDragEnd"
            @dblclick="applyPromptItem(item)"
          >
            <div class="prompt-card-body">
              <strong>{{ item.title }}</strong>
            </div>
            <div class="prompt-card-actions">
              <button type="button" class="mini-button" @click="applyPromptItem(item)">应用</button>
              <button type="button" class="mini-button" @click="editPromptItem(item)">编辑</button>
            </div>
          </article>
        </div>
      </section>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="top-actions">
          <details ref="mobileMenu" class="mobile-nav-menu">
            <summary aria-label="打开导航菜单" title="导航菜单">
              <svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 5.5h12M4 10h12M4 14.5h12" />
              </svg>
            </summary>
            <nav>
              <button type="button" :class="{ active: state.activePanel === 'chat' }" @click="openMobilePanel('chat')">对话</button>
              <button type="button" :class="{ active: state.activePanel === 'sessions' }" @click="openMobilePanel('sessions')">会话</button>
              <button type="button" :class="{ active: state.activePanel === 'prompts' }" @click="openMobilePanel('prompts')">提示词</button>
              <button type="button" :class="{ active: state.activePanel === 'settings' }" @click="openMobilePanel('settings')">模型配置</button>
              <button type="button" @click="createMobileSession">新建会话</button>
            </nav>
          </details>
          <button
            class="ghost mobile-theme-toggle celestial-theme-toggle"
            type="button"
            :aria-label="themeToggleLabel"
            :aria-pressed="isDarkTheme"
            :title="themeToggleLabel"
            @click="toggleTheme"
          >
            <span class="theme-orbit-scene" aria-hidden="true">
              <i class="theme-cloud theme-cloud-one"></i>
              <i class="theme-cloud theme-cloud-two"></i>
              <i class="theme-star theme-star-one"></i>
              <i class="theme-star theme-star-two"></i>
              <i class="theme-star theme-star-three"></i>
              <span class="theme-orbit-body">
                <svg class="theme-sun" viewBox="0 0 28 28">
                  <circle cx="14" cy="14" r="5.2" />
                  <path d="M14 2.5v3M14 22.5v3M2.5 14h3M22.5 14h3M5.9 5.9 8 8M20 20l2.1 2.1M22.1 5.9 20 8M8 20l-2.1 2.1" />
                </svg>
                <svg class="theme-moon" viewBox="0 0 28 28">
                  <path d="M20.8 18.8A9.2 9.2 0 0 1 9.2 7.2a9.2 9.2 0 1 0 11.6 11.6Z" />
                  <circle cx="10.2" cy="16.8" r="1" />
                  <circle cx="15.4" cy="21" r=".75" />
                </svg>
              </span>
            </span>
          </button>
          <button class="ghost desktop-config-button" @click="openLogin()">配置模型</button>
          <button class="primary new-session-button" @click="createMobileSession">+ 新建</button>
        </div>
      </header>

      <section v-if="state.activePanel === 'chat'" class="content-grid chat-grid">
        <div class="chat-panel">
          <div ref="transcript" class="transcript">
            <section v-if="state.runtimeContext || state.runtimeContextLoading || state.runtimeContextError" class="runtime-context-bar">
              <div class="runtime-context-bar-title">
                <strong>运行上下文</strong>
              </div>
              <div v-if="state.runtimeContext" class="runtime-context-bar-actions">
                <button type="button" @click="openRuntimeContextModal('prompt')"><span>系统提示词</span><strong>{{ runtimePromptSections.length }}</strong></button>
                <button type="button" @click="openRuntimeContextModal('tools')"><span>工具</span><strong>{{ runtimeTools.length }}</strong></button>
                <button type="button" @click="openRuntimeContextModal('plugins')"><span>插件</span><strong>{{ effectiveSessionPluginCount }}</strong></button>
              </div>
              <button v-else-if="state.runtimeContextError" type="button" class="runtime-context-retry" @click="fetchRuntimeContext">重试</button>
              <span v-else class="runtime-context-syncing">同步中</span>
            </section>

            <article v-for="line in visibleLines" :key="line.id" :class="['message', line.kind || 'system', { live: line.live, 'prompt-usage': isPromptUsageLine(line), 'context-compaction': isCompactionLine(line), 'compact-tool': shouldCollapseToolLine(line) }]">
              <div :class="['message-marker', { spinning: line.live }]">
                <svg class="message-marker-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 2.75 17.25 10 10 17.25 2.75 10Z" />
                </svg>
              </div>
              <div v-if="isCompactionLine(line)" class="message-body compaction-message-body">
                <section :class="['compaction-context-bar', { current: line.compaction.current }]">
                  <div class="compaction-context-title">
                    <strong>压缩上下文</strong>
                  </div>
                  <div class="compaction-context-actions">
                    <span><span>摘要</span><strong>{{ compactNumber(String(line.compaction.summary || '').length) }}</strong></span>
                    <span v-if="line.compaction.imageCount"><span>图片</span><strong>{{ line.compaction.imageCount }}</strong></span>
                    <button type="button" @click="openCompactionDetail(line)"><span>详情</span><strong>›</strong></button>
                  </div>
                </section>
              </div>
              <div v-else-if="line.kind === 'thinking'" class="message-body reasoning-body">
                <details class="reasoning-sheet" :open="line.live || undefined">
                  <summary>
                    <span class="reasoning-title-mark" aria-hidden="true"><i></i><i></i><i></i></span>
                    <span class="reasoning-heading">思考</span>
                    <span v-if="lineElapsedText(line)" class="reasoning-elapsed">{{ lineElapsedText(line) }}</span>
                  </summary>
                  <div class="reasoning-reveal">
                    <div class="reasoning-paper">
                      <div class="message-text markdown reasoning-text" v-html="renderLine(line)"></div>
                    </div>
                  </div>
                </details>
              </div>
              <div v-else class="message-body">
                <div v-if="line.kind !== 'tool' && !shouldCollapseToolLine(line)" class="message-head">
                  <strong>{{ lineTitle(line) }}</strong>
                  <span v-if="!line.toolName && line.titleStatus">{{ line.titleStatus }}</span>
                  <span v-if="lineElapsedText(line)" class="elapsed-pill">{{ lineElapsedText(line) }}</span>
                </div>
                <div v-if="isImage2Line(line)" class="image2-result-shell">
                  <div class="message-text markdown image2-stage-wrap" v-html="renderImage2Stage(line)"></div>
                  <button v-if="isImage2ResultLine(line)" type="button" class="image2-detail-button" @click="openToolDetail(line)">详情</button>
                </div>
                <div v-else-if="shouldCollapseToolLine(line)" :class="['tool-result-summary', `status-${toolResultStatus(line).key}`]">
                  <div class="tool-result-title-row">
                    <svg :class="['tool-result-diamond', { spinning: line.live }]" viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M10 2.75 17.25 10 10 17.25 2.75 10Z" />
                    </svg>
                    <strong class="tool-result-name">{{ lineTitle(line) }}</strong>
                    <span v-if="toolResultStatus(line).key === 'failed'" class="tool-result-failure-mark" aria-label="执行失败">×</span>
                  </div>
                  <div class="tool-result-detail-row">
                    <p v-if="line.toolDisplay?.purpose || line.toolDisplay?.subject" class="tool-result-primary">
                      {{ line.toolDisplay?.purpose || line.toolDisplay?.subject }}
                    </p>
                    <div v-if="line.toolDisplay?.previews?.length" class="tool-result-previews">
                      <section v-for="(preview, previewIndex) in line.toolDisplay.previews" :key="`${preview.kind}-${previewIndex}`" :class="['tool-result-preview', `kind-${preview.kind}`]">
                        <span v-if="preview.label">{{ preview.label }}</span>
                        <pre>{{ preview.content }}</pre>
                      </section>
                    </div>
                    <dl v-if="visibleToolFacts(line).length" class="tool-result-facts">
                      <div v-for="fact in visibleToolFacts(line)" :key="`${fact.label}-${fact.value}`" :class="['tool-result-fact', `tone-${fact.tone || 'neutral'}`]">
                        <dt>{{ fact.label }}</dt>
                        <dd :class="{ code: fact.code }">{{ fact.value }}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <template v-else>
                  <template v-if="isXhsArtifactLine(line)">
                    <XhsArtifactEditor
                      v-if="xhsArtifactForLine(line)"
                      :artifact="xhsArtifactForLine(line)"
                      :session-id="state.session?.sessionId || ''"
                      @saved="handleXhsArtifactSaved"
                      @error="handleXhsArtifactError"
                    />
                    <div v-else class="message-text markdown" v-html="renderLine(line)"></div>
                  </template>
                  <div v-else-if="line.kind === 'assistant' && line.live" class="message-text markdown streaming-markdown">
                    <StreamingMarkdown :text="line.text || ''" />
                  </div>
                  <div v-else-if="!removeOmittedImageDetails(line)" class="message-text markdown" v-html="renderLine(line)"></div>
                  <template v-for="images in [lineImagePreviews(line)]" :key="`${line.id}-images`">
                    <div v-if="images.length" class="message-image-attachments">
                      <figure v-for="(item, index) in images" :key="imagePreviewIdentity(item) || item.previewUrl || index" :class="['message-image-attachment', { 'image-unavailable': !item.available }]">
                        <button v-if="item.available && item.previewUrl" type="button" class="image-preview-trigger" :data-preview-src="item.originalUrl || item.previewUrl" :aria-label="`预览 ${imageCaption(item, index)}`">
                          <img :src="item.previewUrl" :alt="imageCaption(item, index)" loading="lazy" decoding="async" />
                        </button>
                        <div v-else class="image-unavailable-placeholder" role="status">图片不可用</div>
                        <figcaption>{{ imageCaption(item, index) }}</figcaption>
                        <a v-if="item.available && item.previewUrl" class="image-download" :href="item.originalUrl || item.previewUrl" :download="imageDownloadName(item, index)">下载</a>
                      </figure>
                    </div>
                  </template>
                </template>
              </div>
            </article>
            <div v-if="showTranscriptLoading" class="message-loading" role="status" aria-live="polite">
              <div class="message-loading-body">
                <span class="message-loading-label">{{ transcriptLoadingLabel }}</span>
              </div>
              <span class="message-loading-emblem" aria-hidden="true">
                <i></i><i></i><i></i>
              </span>
            </div>
          </div>

          <div v-if="state.queuedInput" class="queued">
            <span>已排队：{{ state.queuedInput }}</span>
            <div>
              <button type="button" @click="sendQueuedNow">立即发送</button>
              <button type="button" @click="retractQueuedInput">取消</button>
            </div>
          </div>

          <form
            :class="['composer', { 'drop-active': state.composerDropActive }]"
            @submit.prevent="submit"
            @dragover="handleComposerDragOver"
            @dragleave="handleComposerDragLeave"
            @drop="handleComposerDrop"
          >
            <div v-if="state.appPrompt?.hasActivePrompt" class="composer-app-prompt">
              <span class="composer-app-prompt-label">当前提示词</span>
              <strong>{{ activeAppPromptTitle }}</strong>
              <button type="button" class="mini-button danger" @click="clearAppPrompt">清空</button>
            </div>
            <div v-if="fileAttachments().length" class="attachments file-attachments">
              <figure v-for="(item, index) in fileAttachments()" :key="item.label" class="file-attachment">
                <figcaption>
                  <strong>{{ fileAttachmentLabel(item, index) }}</strong>
                  <span>{{ fileAttachmentMeta(item) }}</span>
                </figcaption>
                <button type="button" aria-label="移除附件" @click="removeAttachment(item.label)">×</button>
              </figure>
            </div>
            <div v-if="imageAttachments().length" class="attachments image-attachments">
              <figure v-for="(item, index) in imageAttachments()" :key="item.label" class="image-attachment">
                <img :src="item.previewUrl" :alt="item.name || `图片 ${index + 1}`" />
                <figcaption>图片 {{ index + 1 }}</figcaption>
                <button type="button" aria-label="移除图片" @click="removeAttachment(item.label)">×</button>
              </figure>
            </div>
            <input ref="fileInput" type="file" multiple hidden @change="handleFileInputChange" />
            <textarea ref="composer" v-model="input" placeholder="在这里输入你的问题、需求或下一步安排…" @keydown="handleKeydown" @paste="handlePaste" @input="autosize"></textarea>
            <details class="mobile-session-options">
              <summary>
                <span>会话选项</span>
                <small>{{ exactPhaseLabel }}</small>
                <svg class="mobile-session-chevron" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" />
                </svg>
              </summary>
              <div class="mobile-session-options-body">
                <dl>
                  <div><dt>模型</dt><dd>{{ modelName }}</dd></div>
                  <div><dt>上下文</dt><dd><button type="button" class="mobile-context-button" @click="openContextWindowModal">{{ composerContextValue }}</button></dd></div>
                  <div><dt>Token</dt><dd>↑ {{ composerInputTokens }} / ↓ {{ composerOutputTokens }}</dd></div>
                </dl>
                <div class="mobile-session-actions">
                  <button
                    type="button"
                    :class="['fast-mode-button', { active: state.fastMode, syncing: state.fastModeMutating }]"
                    :aria-pressed="state.fastMode"
                    @click="toggleFastMode"
                  ><span>{{ state.fastMode ? '快速模式' : '启用快速模式' }}</span></button>
                  <button type="button" class="compact-button" :disabled="active" @click="compressSession">压缩会话</button>
                </div>
              </div>
            </details>
            <div class="composer-footer">
              <div class="composer-metrics" aria-label="运行状态指标">
                <span class="metric-chip model-chip"><em>模型</em><strong>{{ modelName }}</strong></span>
                <button type="button" :class="['metric-chip', 'numeric', 'context-window-trigger', metricBumpClass('context')]" :key="`context-${state.composerMetrics.context.bump}`" @click="openContextWindowModal"><em>上下文</em><strong>{{ composerContextValue }}</strong></button>
                <span :class="['metric-chip numeric', metricBumpClass('inputTokens')]" :key="`input-${state.composerMetrics.inputTokens.bump}`"><em>输入</em><strong>{{ composerInputTokens }}</strong></span>
                <span :class="['metric-chip numeric', metricBumpClass('outputTokens')]" :key="`output-${state.composerMetrics.outputTokens.bump}`"><em>输出</em><strong>{{ composerOutputTokens }}</strong></span>
                <button
                  type="button"
                  :class="['fast-mode-button', { active: state.fastMode, syncing: state.fastModeMutating }]"
                  :aria-pressed="state.fastMode"
                  :title="state.fastMode ? '关闭当前会话的快速模式' : '为当前会话启动快速模式'"
                  @click="toggleFastMode"
                >
                  <span>{{ state.fastMode ? '快速模式' : '快速模式（未启用）' }}</span>
                </button>
                <span class="compress-wrap">
                  <button type="button" class="compact-button" :disabled="active" @click="compressSession">压缩会话</button>
                </span>
              </div>
              <div>
                <button type="button" class="ghost" :disabled="state.uploadingFiles" @click="triggerFilePicker">{{ state.uploadingFiles ? '上传中…' : '上传附件' }}</button>
                <button
                  :type="composerRunning ? 'button' : 'submit'"
                  :class="['primary', 'composer-action', { stop: composerRunning }]"
                  :disabled="!composerRunning && (state.uploadingFiles || (!input.trim() && !state.attachments.length))"
                  :aria-label="composerActionLabel"
                  @click="composerRunning ? interruptAndSubmit() : undefined"
                >{{ composerActionLabel }}</button>
              </div>
            </div>
          </form>
        </div>

        <aside class="right-panel">
          <section class="status-card compact-status cwd-card">
            <strong class="cwd-card-label">CWD</strong>
            <div class="cwd-card-path" :title="currentCwd">{{ currentCwd }}</div>
          </section>
          <section class="background-task-section">
            <div class="background-task-head">
              <div class="panel-title">后台任务</div>
              <strong v-if="backgroundTaskCount" class="background-task-count">{{ backgroundTaskCount }}</strong>
            </div>
            <div v-if="!backgroundTaskCount" class="empty-mini">暂无后台任务</div>
            <button
              v-else
              type="button"
              class="background-task-summary"
              :title="backgroundTaskTitle(primaryBackgroundTask)"
              @click="openBackgroundTaskDetail(primaryBackgroundTask)"
            >
              <span :class="['background-task-dot', `status-${primaryBackgroundTask.status}`]"></span>
              <strong>{{ backgroundTaskDisplayTitle(primaryBackgroundTask) }}</strong>
              <span v-if="backgroundTaskCount > 1" class="background-task-more">+{{ backgroundTaskCount - 1 }}</span>
              <b aria-hidden="true">›</b>
            </button>
          </section>
          <section v-if="currentCpaQuota" class="quota-card">
            <div class="quota-card-head">
              <div>
                <span>周额度 · {{ quotaAccountLabel(currentCpaQuota.account) }}</span>
                <strong>{{ quotaPercent(currentCpaQuota.remainingPercent) }}</strong>
              </div>
              <div class="quota-card-controls">
                <button v-if="state.cpaQuotas.length > 1" type="button" aria-label="上一个凭据" @click="rotateCpaQuota(-1)">‹</button>
                <small>{{ state.cpaQuotas.length > 1 ? `${state.cpaQuotaIndex + 1}/${state.cpaQuotas.length}` : '剩余' }}</small>
                <button v-if="state.cpaQuotas.length > 1" type="button" aria-label="下一个凭据" @click="rotateCpaQuota(1)">›</button>
              </div>
            </div>
            <div class="quota-progress" role="progressbar" aria-label="周额度剩余" :aria-valuenow="normalizedQuotaPercent(currentCpaQuota.remainingPercent)" aria-valuemin="0" aria-valuemax="100">
              <span class="quota-progress-fill" :style="{ '--quota-progress': `${normalizedQuotaPercent(currentCpaQuota.remainingPercent)}%` }"></span>
            </div>
            <div class="quota-card-foot">
              <span>已使用 {{ quotaPercent(currentCpaQuota.usedPercent) }}</span>
              <span>续期时间 {{ formatQuotaReset(currentCpaQuota.resetAt) }}</span>
            </div>
            <div class="quota-card-update">更新于 {{ formatQuotaReset(currentCpaQuota.updatedAt) }}</div>
          </section>
          <section class="quota-card memory-card">
            <div class="memory-card-head">
              <div>
                <span>服务端内存</span>
                <strong>{{ formatMemoryBytes(memoryCurrent?.rss) }}</strong>
              </div>
              <small>RSS</small>
            </div>
            <div v-if="memoryTrendPath" class="memory-chart" @mousemove="updateMemoryHover" @mouseleave="clearMemoryHover">
              <svg class="memory-trend" viewBox="0 0 260 44" preserveAspectRatio="none" role="img" aria-label="最近一小时 RSS 趋势">
                <path :d="memoryTrendPath" />
                <circle
                  v-for="(point, index) in memoryTrendPoints"
                  :key="point.entry.at"
                  :class="['memory-trend-point', { active: index === memoryHoverIndex }]"
                  :cx="point.x"
                  :cy="point.y"
                  :r="index === memoryHoverIndex ? 3.2 : 1.5"
                  tabindex="0"
                  @focus="memoryHoverIndex = index"
                  @blur="clearMemoryHover"
                />
              </svg>
              <div
                v-if="memoryHoveredPoint"
                class="memory-tooltip"
                :style="{ left: `clamp(58px, ${memoryHoveredPoint.x / 260 * 100}%, calc(100% - 58px))`, top: `${memoryHoveredPoint.y / 44 * 100}%` }"
              >
                <strong>{{ formatMemoryBytes(memoryHoveredPoint.entry.rss) }}</strong>
                <span>{{ formatMemoryTooltipTime(memoryHoveredPoint.entry.at) }}</span>
              </div>
            </div>
            <div v-else class="memory-trend-empty">—</div>
            <div class="memory-stats">
              <div><span>V8 堆</span><strong>{{ formatMemoryBytes(memoryCurrent?.heapUsed) }}</strong></div>
              <div><span>外部内存</span><strong>{{ formatMemoryBytes(memoryCurrent?.external) }}</strong></div>
            </div>
            <div class="memory-card-foot">
              <span>更新于 {{ formatMemoryTime(memoryCurrent?.at) }}</span>
            </div>
          </section>
        </aside>
      </section>

      <section v-else-if="state.activePanel === 'sessions'" class="content-grid single">
        <div class="panel-page sessions-page">
          <div class="page-head sessions-page-head">
            <div>
              <h2>会话管理</h2>
              <p>查找、继续或整理历史会话</p>
            </div>
            <button class="primary" @click="newSession">+ 新建会话</button>
          </div>
          <div class="session-toolbar">
            <label class="session-search" aria-label="搜索会话">
              <input v-model="sessionSearch" type="search" placeholder="搜索标题或 ID" autocomplete="off" />
            </label>
            <span class="session-count">{{ sessionSearch.trim() ? `${filteredSessions.length} / ${state.sessions.length}` : `${state.sessions.length} 个会话` }}</span>
          </div>
          <div v-if="state.sessionsLoading" class="empty-state">正在加载会话…</div>
          <div v-else-if="!state.sessions.length" class="empty-state">暂无会话</div>
          <div v-else-if="!filteredSessions.length" class="empty-state">没有匹配的会话</div>
          <div v-else class="session-list">
            <article v-for="session in paginatedSessions" :key="session.sessionId" :class="['session-card', { current: isCurrentSession(session.sessionId), running: isRunningSession(session.sessionId) }]">
              <div class="session-card-main">
                <div class="session-card-title">
                  <strong>{{ displaySessionTitle(session) }}</strong>
                  <span v-if="isCurrentSession(session.sessionId)" class="current-pill">当前</span>
                  <span v-else-if="isRunningSession(session.sessionId)" class="live-pill">运行中</span>
                </div>
                <div class="session-card-meta">
                  <code :title="session.sessionId">ID · {{ session.sessionId }}</code>
                  <time :datetime="session.updatedAt || session.createdAt">更新于 {{ formatSessionTime(session.updatedAt || session.createdAt) }}</time>
                </div>
              </div>
              <div class="session-actions">
                <button :disabled="state.sessionResumeLoading || state.sessionsLoading" @click="resumeSession(session.sessionId)">{{ state.pendingResumeSessionId === session.sessionId && state.sessionResumeLoading ? '打开中…' : '打开' }}</button>
                <button class="danger" :disabled="state.sessionResumeLoading || state.sessionsLoading" @click="deleteSession(session.sessionId)">删除</button>
              </div>
            </article>
          </div>
          <nav v-if="!state.sessionsLoading && filteredSessions.length && sessionTotalPages > 1" class="session-pagination" aria-label="会话分页">
            <button type="button" :disabled="sessionPage === 1" @click="sessionPage -= 1">上一页</button>
            <button
              v-for="page in sessionPageNumbers"
              :key="page"
              type="button"
              :class="{ active: page === sessionPage }"
              :aria-current="page === sessionPage ? 'page' : undefined"
              @click="sessionPage = page"
            >{{ page }}</button>
            <button type="button" :disabled="sessionPage === sessionTotalPages" @click="sessionPage += 1">下一页</button>
          </nav>
        </div>
      </section>

      <section v-else-if="state.activePanel === 'prompts'" class="content-grid single">
        <div class="panel-page prompt-page">
          <div class="page-head">
            <h2>提示词</h2>
            <div class="page-head-actions">
              <button class="ghost" @click="state.activePanel = 'chat'">回到对话</button>
              <button class="primary" @click="newPromptItem">+ 新建提示词</button>
            </div>
          </div>
          <div class="prompt-workbench">
            <aside class="prompt-library-panel">
              <div class="prompt-library-head">
                <strong>{{ state.promptLibrary.length }} 个提示词</strong>
              </div>
              <div class="prompt-library-list">
                <div v-if="state.promptLibraryLoading" class="prompt-list-empty">正在加载…</div>
                <div v-else-if="!state.promptLibrary.length" class="prompt-list-empty">暂无提示词</div>
                <button
                  v-else
                  v-for="item in state.promptLibrary"
                  :key="item.id"
                  :class="['prompt-library-item', {
                    active: selectedPrompt?.id === item.id,
                    applied: activeAppPrompt?.id === item.id,
                    dragging: sortingPromptId === item.id,
                    'drop-before': promptSortTargetId === item.id && promptSortPosition === 'before',
                    'drop-after': promptSortTargetId === item.id && promptSortPosition === 'after',
                  }]"
                  type="button"
                  draggable="true"
                  @click="selectPromptItem(item)"
                  @dblclick="applyPromptItem(item)"
                  @dragstart="handlePromptSortDragStart($event, item)"
                  @dragover="handlePromptSortDragOver($event, item)"
                  @drop="handlePromptSortDrop($event, item)"
                  @dragend="resetPromptSortState"
                >
                  <strong>{{ item.title }}</strong>
                  <span v-if="item.usage">用法：{{ item.usage }}</span>
                </button>
              </div>
            </aside>

            <section class="prompt-editor-panel">
              <div class="prompt-editor-toolbar">
                <strong class="prompt-editor-current">{{ promptDraft.title || '新提示词' }}</strong>
                <div class="prompt-editor-toolbar-actions">
                  <button class="mini-button" type="button" :disabled="!selectedPrompt" @click="selectedPrompt && applyPromptItem(selectedPrompt)">应用</button>
                  <button class="mini-button" type="button" @click="savePromptItem">保存</button>
                  <button class="mini-button danger" type="button" :disabled="!promptDraft.id" @click="deletePromptItem">删除</button>
                </div>
              </div>

              <div class="prompt-editor-grid">
                <label class="prompt-editor-field">
                  <span>名称</span>
                  <input v-model="promptDraft.title" type="text" placeholder="例如：代码评审" />
                </label>
                <label class="prompt-editor-field prompt-editor-field-full">
                  <span>提示词内容</span>
                  <textarea v-model="promptDraft.content" rows="14" placeholder="输入提示词内容"></textarea>
                </label>
                <label class="prompt-editor-field prompt-editor-field-full">
                  <span>用法（选填）</span>
                  <textarea v-model="promptDraft.usage" rows="4" placeholder="输入适用场景"></textarea>
                </label>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section v-else-if="state.activePanel === 'settings'" class="content-grid single">
        <div class="panel-page settings-page">
          <div class="page-head settings-page-head">
            <h2>模型配置</h2>
            <button class="primary" @click="saveLogin" :disabled="!state.login">保存</button>
          </div>
          <div v-if="!state.login" class="empty-state">正在加载配置…</div>
          <form v-else class="settings-form" @submit.prevent="saveLogin">
            <section class="settings-card">
              <header class="settings-card-head"><strong>模型</strong></header>
              <div class="settings-field-grid">
                <label class="settings-field">
                  <span>供应商</span>
                  <NeoSelect v-model="loginProvider" :options="loginProviderOptions(state.login.providers)" aria-label="供应商" @change="switchLoginProvider" />
                </label>
                <label v-for="field in state.login.fields" :key="field.key" class="settings-field">
                  <span>{{ loginFieldLabel(field.label) }}<i v-if="field.required" class="settings-required" aria-label="必填"></i></span>
                  <NeoSelect
                    v-if="field.options"
                    v-model="loginValues[field.key]"
                    :options="loginFieldOptions(field)"
                    :aria-label="loginFieldLabel(field.label)"
                  />
                  <input
                    v-else
                    v-model="loginValues[field.key]"
                    :type="field.secret ? 'password' : 'text'"
                    :placeholder="field.placeholder || `请输入${loginFieldLabel(field.label)}`"
                  />
                </label>
              </div>
            </section>

            <section class="settings-card">
              <header class="settings-card-head"><strong>CPA</strong></header>
              <div class="settings-field-grid">
                <label class="settings-field">
                  <span>URL</span>
                  <input v-model="state.cpaConfig.url" type="text" placeholder="http://127.0.0.1:8317" autocomplete="off" />
                </label>
                <label class="settings-field">
                  <span>管理密码</span>
                  <input v-model="state.cpaConfig.password" type="password" placeholder="请输入管理密码" autocomplete="new-password" />
                </label>
              </div>
            </section>

            <section class="settings-card settings-plugin-card">
              <header class="settings-card-head">
                <div><strong>工具</strong><small>内置与插件工具默认开启，关闭后立即对当前会话生效。</small></div>
                <button type="button" class="mini-button" :disabled="state.busy || state.globalTools.loading" @click="saveGlobalTools">保存</button>
              </header>
              <div class="plugin-settings-list">
                <label v-for="tool in state.globalTools.items" :key="tool.name" class="plugin-settings-row">
                  <span><strong><code>{{ tool.name }}</code></strong><small>{{ tool.source === 'plugin' ? `插件 · ${tool.pluginName || tool.pluginId}` : tool.source === 'external' ? '外部工具' : '内置工具' }}</small></span>
                  <span class="plugin-toggle">
                    <input v-model="tool.configuredEnabled" type="checkbox" :aria-label="tool.name" />
                    <span aria-hidden="true"></span>
                  </span>
                </label>
              </div>
            </section>

            <section class="settings-card settings-plugin-card">
              <header class="settings-card-head">
                <strong>插件</strong>
                <button type="button" class="mini-button" :disabled="state.globalPlugins.locked || state.globalPlugins.loading" @click="saveGlobalPlugins">保存</button>
              </header>
              <div class="plugin-settings-list">
                <label v-for="plugin in state.globalPlugins.items" :key="plugin.id" class="plugin-settings-row">
                  <span><strong>{{ plugin.name }}</strong><small>{{ plugin.tools.length }} 个工具</small></span>
                  <span class="plugin-toggle">
                    <input v-model="plugin.configuredEnabled" type="checkbox" :disabled="state.globalPlugins.locked" :aria-label="plugin.name" />
                    <span aria-hidden="true"></span>
                  </span>
                </label>
              </div>
            </section>
          </form>
        </div>
      </section>

      <section v-else class="content-grid single">
        <div class="panel-page">
          <h2>运行时能力</h2>
          <div class="capability-grid">
            <div v-for="item in ['流式模型循环', '工具执行', '上下文指标', '会话恢复', '后台代理', '登录配置', '图片附件', 'Markdown 输出']" :key="item" class="capability-card">{{ item }}</div>
          </div>
        </div>
      </section>
    </main>

    <div v-if="state.toast" class="toast">{{ state.toast }}</div>
  </div>

  <Teleport to="body">
    <div v-if="state.confirmDialog.open" class="confirm-dialog-backdrop" @click.self="resolveConfirmation(false)">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true" :aria-label="state.confirmDialog.title">
        <div :class="['confirm-dialog-icon', `tone-${state.confirmDialog.tone}`]" aria-hidden="true">!</div>
        <div class="confirm-dialog-content">
          <h3>{{ state.confirmDialog.title }}</h3>
          <p>{{ state.confirmDialog.message }}</p>
        </div>
        <div class="confirm-dialog-actions">
          <button type="button" class="ghost" @click="resolveConfirmation(false)">{{ state.confirmDialog.cancelLabel }}</button>
          <button type="button" :class="['primary', { danger: state.confirmDialog.tone === 'danger' }]" @click="resolveConfirmation(true)">{{ state.confirmDialog.confirmLabel }}</button>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="state.contextWindowModalOpen" class="context-window-backdrop" @click.self="closeContextWindowModal">
      <section class="context-window-modal" role="dialog" aria-modal="true" aria-label="调整上下文窗口">
        <form @submit.prevent="saveContextWindow">
          <label for="context-window-input">调整本次会话上下文窗口大小：</label>
          <div class="context-window-input-wrap">
            <input
              id="context-window-input"
              v-model="state.contextWindowDraft"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              autofocus
              aria-describedby="context-window-unit"
              @input="normalizeContextWindowDraft"
            />
            <span id="context-window-unit">k</span>
          </div>
          <p v-if="state.contextWindowError" class="context-window-error" role="alert">{{ state.contextWindowError }}</p>
          <div class="context-window-actions">
            <button type="button" class="ghost" :disabled="state.contextWindowSaving" @click="closeContextWindowModal">取消</button>
            <button type="submit" class="primary" :disabled="state.contextWindowSaving">{{ state.contextWindowSaving ? '保存中…' : '确认' }}</button>
          </div>
        </form>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="state.imagePreview" class="image-preview-backdrop" @click.self="closeImagePreview">
      <section class="image-preview-modal" role="dialog" aria-modal="true" :aria-label="state.imagePreview.caption || '图片预览'">
        <button type="button" class="image-preview-close" aria-label="关闭图片预览" @click="closeImagePreview">×</button>
        <div class="image-preview-canvas">
          <img :src="state.imagePreview.src" :alt="state.imagePreview.caption || '图片预览'" />
        </div>
        <footer v-if="state.imagePreview.caption" class="image-preview-caption">{{ state.imagePreview.caption }}</footer>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="compactionDetailLine" class="runtime-context-detail-backdrop" @click.self="closeCompactionDetail">
      <section class="runtime-context-detail-modal compaction-detail-modal" role="dialog" aria-modal="true" aria-label="压缩上下文详情">
        <header class="runtime-context-modal-head">
          <div>
            <strong>压缩上下文详情</strong>
          </div>
          <button type="button" aria-label="关闭" @click="closeCompactionDetail">×</button>
        </header>
        <div class="runtime-context-detail-content compaction-detail-content">
          <dl class="compaction-detail-stats">
            <div><dt>压缩方式</dt><dd>{{ compactionModeText(compactionDetailLine) }}</dd></div>
            <div><dt>发生时间</dt><dd>{{ formatSessionTime(compactionDetailLine.compaction.createdAt) }}</dd></div>
            <div><dt>新窗口消息</dt><dd>{{ compactionDetailLine.compaction.newWindowMessages }}</dd></div>
            <div><dt>保留用户消息</dt><dd>{{ compactionDetailLine.compaction.preservedUserMessages }}</dd></div>
            <div><dt>释放字符</dt><dd>{{ compactNumber(compactionDetailLine.compaction.charsFreed) }}</dd></div>
            <div><dt>图片引用</dt><dd>{{ compactionDetailLine.compaction.imageCount || 0 }}</dd></div>
          </dl>
          <h3>实际续接上下文</h3>
          <pre>{{ compactionDetailLine.compaction.continuationState || compactionDetailLine.compaction.summary || '未提供续接上下文' }}</pre>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="state.runtimeContextModal" class="runtime-context-modal-backdrop" @click.self="closeRuntimeContextModal">
      <section class="runtime-context-modal" role="dialog" aria-modal="true" aria-label="运行上下文">
        <header class="runtime-context-modal-head">
          <div>
            <strong>{{ state.runtimeContextModal === 'prompt' ? '系统提示词' : state.runtimeContextModal === 'tools' ? '可用工具' : '会话插件' }}</strong>
          </div>
          <button type="button" aria-label="关闭" @click="closeRuntimeContextModal">×</button>
        </header>

        <div class="runtime-context-modal-content">
          <div v-if="state.runtimeContextModal === 'prompt'" class="runtime-context-index">
            <button type="button" class="runtime-context-index-item featured" @click="openRuntimeFullPromptDetail">
              <span><strong>完整系统提示词</strong><small>{{ compactNumber(state.runtimeContext?.prompt?.chars || 0) }} 字符</small></span>
              <b>›</b>
            </button>
            <button v-for="(section, index) in runtimePromptSections" :key="`${section.name}-${index}`" type="button" class="runtime-context-index-item" @click="openRuntimePromptDetail(section)">
              <span><strong>{{ section.name }}</strong><small>{{ runtimeSectionLabel(section) }} · {{ compactNumber(section.chars || 0) }} 字符</small></span>
              <b>›</b>
            </button>
          </div>

          <div v-else-if="state.runtimeContextModal === 'tools'" class="runtime-plugin-list">
            <div v-if="state.sessionTools.loading" class="runtime-context-empty">同步中</div>
            <template v-else>
              <div class="runtime-tool-status"><span>可用 {{ effectiveSessionToolCount }} / {{ state.sessionTools.items.length }}</span></div>
              <div v-for="tool in state.sessionTools.items" :key="tool.name" class="runtime-plugin-row">
                <button type="button" class="runtime-tool-detail-button" :disabled="!runtimeTools.some((item) => item.name === tool.name)" @click="openRuntimeToolDetail(runtimeTools.find((item) => item.name === tool.name))">
                  <code>{{ tool.name }}</code><small>{{ tool.available === false ? `插件未启用 · ${tool.pluginName || tool.pluginId}` : tool.source === 'plugin' ? `插件 · ${tool.pluginName || tool.pluginId}` : tool.source === 'external' ? '外部工具' : '内置工具' }}</small>
                </button>
                <NeoSelect
                  class="runtime-plugin-control"
                  :model-value="tool.mode"
                  :options="SESSION_PLUGIN_MODE_OPTIONS"
                  :disabled="state.busy || state.sessionTools.busy || tool.available === false"
                  :aria-label="`${tool.name}状态`"
                  :data-mode="tool.mode"
                  @update:model-value="updateSessionTool(tool, $event)"
                />
              </div>
            </template>
          </div>

          <div v-else class="runtime-plugin-list">
            <div v-if="state.sessionPlugins.loading" class="runtime-context-empty">同步中</div>
            <template v-else>
              <div v-for="plugin in state.sessionPlugins.items" :key="plugin.id" class="runtime-plugin-row">
                <span><strong>{{ plugin.name }}</strong><small>{{ plugin.tools.length }} 个工具</small></span>
                <NeoSelect
                  class="runtime-plugin-control"
                  :model-value="plugin.mode"
                  :options="SESSION_PLUGIN_MODE_OPTIONS"
                  :disabled="state.busy || state.sessionPlugins.busy || !plugin.globallyEnabled"
                  :aria-label="`${plugin.name}状态`"
                  :data-mode="plugin.mode"
                  @update:model-value="updateSessionPlugin(plugin, $event)"
                />
              </div>
            </template>
          </div>

        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="state.runtimeContextDetail" class="runtime-context-detail-backdrop" @click.self="closeRuntimeContextDetail">
      <section class="runtime-context-detail-modal" role="dialog" aria-modal="true" :aria-label="state.runtimeContextDetail.title">
        <header class="runtime-context-modal-head">
          <div>
            <span v-if="state.runtimeContextDetail.meta" class="runtime-context-kicker">{{ state.runtimeContextDetail.meta }}</span>
            <strong>{{ state.runtimeContextDetail.title }}</strong>
          </div>
          <button type="button" aria-label="返回" @click="closeRuntimeContextDetail">×</button>
        </header>
        <div class="runtime-context-detail-content">
          <template v-if="state.runtimeContextDetail.kind === 'tool'">
            <p v-if="state.runtimeContextDetail.description">{{ state.runtimeContextDetail.description }}</p>
            <pre>{{ state.runtimeContextDetail.schema }}</pre>
          </template>
          <pre v-else>{{ state.runtimeContextDetail.content }}</pre>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="state.backgroundTaskDetail" class="tool-result-modal-backdrop" @click.self="closeBackgroundTaskDetail">
      <section class="tool-result-modal background-task-modal" role="dialog" aria-modal="true" aria-label="后台任务">
        <header class="tool-result-modal-head">
          <div class="tool-result-modal-title">
            <strong>后台任务</strong>
            <span class="background-task-modal-count">{{ backgroundTaskCount }}</span>
          </div>
          <button type="button" class="tool-result-modal-close" aria-label="关闭" @click="closeBackgroundTaskDetail">×</button>
        </header>
        <div class="tool-result-modal-content background-task-page">
          <nav class="background-task-index" aria-label="后台任务列表">
            <button
              v-for="task in state.backgroundTasks"
              :key="backgroundTaskKey(task)"
              type="button"
              :class="['background-task-index-item', { active: backgroundTaskKey(task) === backgroundTaskKey(state.backgroundTaskDetail) }]"
              :title="backgroundTaskTitle(task)"
              @click="openBackgroundTaskDetail(task)"
            >
              <span :class="['background-task-dot', `status-${task.status}`]"></span>
              <strong>{{ backgroundTaskDisplayTitle(task) }}</strong>
              <small>{{ taskStatusText(task.status) }}</small>
            </button>
          </nav>
          <article class="background-task-detail">
            <header>
              <strong>{{ backgroundTaskDisplayTitle(state.backgroundTaskDetail) }}</strong>
              <span :class="['tool-result-modal-status', `status-${state.backgroundTaskDetail.status}`]">{{ taskStatusText(state.backgroundTaskDetail.status) }}</span>
            </header>
            <dl>
              <div><dt>类型</dt><dd>{{ backgroundTaskKindText(state.backgroundTaskDetail) }}</dd></div>
              <div><dt>运行</dt><dd>{{ backgroundTaskElapsed(state.backgroundTaskDetail) || '—' }}</dd></div>
              <div><dt>开始</dt><dd>{{ formatSessionTime(state.backgroundTaskDetail.createdAt) }}</dd></div>
              <div v-if="state.backgroundTaskDetail.processId"><dt>进程</dt><dd>{{ state.backgroundTaskDetail.processId }}</dd></div>
              <div v-if="state.backgroundTaskDetail.sessionId"><dt>会话</dt><dd>{{ state.backgroundTaskDetail.sessionId }}</dd></div>
              <div v-if="state.backgroundTaskDetail.agentId"><dt>代理</dt><dd>{{ state.backgroundTaskDetail.agentId }}</dd></div>
              <div v-if="state.backgroundTaskDetail.taskId && state.backgroundTaskDetail.kind === 'agent'"><dt>任务</dt><dd>{{ state.backgroundTaskDetail.taskId }}</dd></div>
              <div v-if="state.backgroundTaskDetail.progress"><dt>工具</dt><dd>{{ state.backgroundTaskDetail.progress.totalToolUseCount || 0 }}</dd></div>
              <div v-if="state.backgroundTaskDetail.shell"><dt>Shell</dt><dd>{{ state.backgroundTaskDetail.shell }}{{ state.backgroundTaskDetail.tty ? ' · TTY' : '' }}</dd></div>
              <div v-if="state.backgroundTaskDetail.cwd" class="wide"><dt>目录</dt><dd>{{ state.backgroundTaskDetail.cwd }}</dd></div>
              <div v-if="state.backgroundTaskDetail.outputFile" class="wide"><dt>输出</dt><dd>{{ state.backgroundTaskDetail.outputFile }}</dd></div>
            </dl>
            <pre v-if="backgroundTaskPrompt(state.backgroundTaskDetail)" class="background-task-command">{{ backgroundTaskPrompt(state.backgroundTaskDetail) }}</pre>
            <section v-if="state.backgroundTaskDetail.kind === 'terminal'" class="background-task-output-section">
              <div class="background-task-output-head">
                <strong>实时输出</strong>
                <span v-if="state.backgroundTaskDetail.status === 'running'"><i aria-hidden="true"></i>持续更新</span>
              </div>
              <pre ref="backgroundTaskOutput" class="background-task-live-output">{{ backgroundTaskLiveOutput(state.backgroundTaskDetail) || '等待终端输出…' }}</pre>
            </section>
            <pre v-else-if="backgroundTaskActivity(state.backgroundTaskDetail)" class="background-task-activity">{{ backgroundTaskActivity(state.backgroundTaskDetail) }}</pre>
          </article>
        </div>
      </section>
    </div>

    <div v-if="toolDetailLine" class="tool-result-modal-backdrop" @click.self="closeToolDetail">
      <section class="tool-result-modal" role="dialog" aria-modal="true" :aria-label="`${lineTitle(toolDetailLine)}详情`">
        <header class="tool-result-modal-head">
          <div>
            <div class="tool-result-modal-title">
              <strong>{{ lineTitle(toolDetailLine) }}</strong>
              <span :class="['tool-result-modal-status', `status-${toolResultStatus(toolDetailLine).key}`]">{{ toolResultStatus(toolDetailLine).label }}</span>
            </div>
            <p v-if="toolResultSummary(toolDetailLine)">{{ toolResultSummary(toolDetailLine) }}</p>
          </div>
          <button type="button" class="tool-result-modal-close" aria-label="关闭工具结果" @click="closeToolDetail">×</button>
        </header>
        <div class="tool-result-modal-content">
          <div class="message-text markdown tool-detail-markdown" v-html="renderToolDetail(toolDetailLine)"></div>
        </div>
        <footer class="tool-result-modal-footer">
          <button type="button" class="primary" @click="closeToolDetail">关闭</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
