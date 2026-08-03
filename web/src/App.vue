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

const CONTEXT_COMPRESSION_WARNING_TOKENS = 100_000
const IMAGE_MAX_EDGE = 2048
const IMAGE_MAX_BYTES = 1_800_000
const IMAGE_MIN_QUALITY = 0.62
const IMAGE_GENERATION_HINT = 'System hint: if the user is asking you to draw, render, create, generate, or illustrate a new image, you must call the image2 tool with mode=generate instead of replying with text-only description. After the tool returns images, continue the response normally so the UI can display them in the conversation.'
const IMAGE_OPERATION_HINT = 'System hint: the user attached an image. If this request involves image editing, modification, redraw, background replacement, style transfer, repair, object removal, or localized changes, you must call the image2 tool with mode=edit and use the attached or most recent image as the source image. Image operations may take a while, so wait up to 10 minutes by default unless the tool returns an error or the user interrupts.'
const DOWNLOAD_EXPOSURE_HINT = 'System hint from web UI: if your final answer produces, creates, modifies, exports, packages, or identifies local files that the user should receive, you must call the expose_downloads tool with all relevant absolute file paths before your final textual response. Do not paste absolute paths as the primary delivery method; expose them as browser downloads.'
const XHS_ARTIFACT_EDITOR_HINT = 'System hint from web UI: when you produce a complete structured Xiaohongshu/Miaochengjian post draft, call open_xhs_artifact_editor with a structured payload or Markdown content so the user can review and edit it in a Xiaohongshu-style editor. Before revising an existing artifact, call read_xhs_artifact with its id to get the latest user-edited version.'
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
  Config: '配置',
  Reasoning: '推理过程',
  'Runtime tool': '运行时工具',
  agent: '子任务',
  edit: '编辑文件',
  exec: '执行命令',
  expose_downloads: '文件下载',
  grep: '搜索文本',
  image2: '图片生成',
  image_note: '记录图片说明',
  list: '列出文件',
  load_image: '读取图片',
  plan: '任务计划',
  read: '读取文件',
  search: '网络搜索',
  write: '写入文件',
  '文件下载': '文件下载',
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
const THEME_STORAGE_KEY = 'neoctl-web.theme'
const runtimeTabId = getOrCreateRuntimeTabId()
let runtimeSessionId = sessionStorage.getItem(RUNTIME_SESSION_ID_KEY) || ''

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
  appPrompt: { hasActivePrompt: false, activePrompt: undefined },
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
  activePanel: 'chat',
  toolDetailLineId: undefined,
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
const theme = ref(resolveInitialTheme())
const composer = ref(null)
const fileInput = ref(null)
const transcript = ref(null)
const loginProvider = ref('')
const loginValues = reactive({})
const promptDraft = reactive(createEmptyPromptDraft())
const draggingPromptId = ref('')
let es
let toastTimer
let scrollRaf = 0
let clockTimer
let metricsRaf = 0
let activeThemeTransition
let themeRevealAnimation
let themeTransitionRunId = 0
let requestedTheme = theme.value
let previousBackgroundTaskStatuses = new Map()
const renderedLineCache = new Map()

const phaseLabel = computed(() => phaseText(state.status?.phase))
const exactPhaseLabel = computed(() => {
  if (state.status?.phase === 'running_tools') {
    const tool = state.status?.currentTool
    if (tool?.name) return `调用 ${tool.name}${tool.kind ? ` · ${tool.kind}` : ''}`
  }
  return phaseLabel.value
})

const active = computed(() => isActivePhase(state.status?.phase))
const showTranscriptLoading = computed(() => active.value || state.busy || state.sessionResumeLoading)
const transcriptLoadingLabel = computed(() => state.sessionResumeLoading ? '正在加载会话' : `正在${exactPhaseLabel.value}`)
const realSessionTitle = computed(() => {
  const title = state.session?.title?.trim() || ''
  return title && title !== 'neo' ? title : ''
})
const currentTitle = computed(() => realSessionTitle.value || '未命名设计会话')
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
const composerInputTokens = computed(() => compactNumber(state.composerMetrics.inputTokens.display))
const composerOutputTokens = computed(() => compactNumber(state.composerMetrics.outputTokens.display))
const composerDropHint = computed(() => {
  if (state.composerDropMode === 'files') return state.composerDropActive ? '松开即可上传附件' : '拖入这里即可上传附件'
  return state.composerDropActive ? '松开即可替换应用提示词' : '拖入这里即可替换应用提示词'
})
const currentContextTokens = computed(() => Number(state.status?.metrics?.estimatedInputTokens ?? state.status?.usage?.inputTokens ?? 0))
const showCompressionWarning = computed(() => currentContextTokens.value > CONTEXT_COMPRESSION_WARNING_TOKENS)
const filteredSessions = computed(() => state.sessions || [])
const activePanelLabel = computed(() => ({
  chat: '对话工作台',
  sessions: '会话管理',
  prompts: '提示词管理',
  settings: '模型配置',
}[state.activePanel] || state.activePanel))
const visibleLines = computed(() => state.sessionResumeLoading ? [] : (state.lines || []).filter((line) => !shouldHideLine(line)))
const toolDetailLine = computed(() => state.lines.find((line) => String(line.id) === String(state.toolDetailLineId)) || null)
const activeAppPrompt = computed(() => state.appPrompt?.activePrompt || undefined)
const activeAppPromptTitle = computed(() => activeAppPrompt.value?.title || activeAppPrompt.value?.id || '')
const selectedPrompt = computed(() => state.promptLibrary.find((item) => item.id === state.selectedPromptId) || state.promptLibrary[0] || null)
const isDarkTheme = computed(() => theme.value === 'dark')
const themeToggleLabel = computed(() => isDarkTheme.value ? '切换到日间模式' : '切换到夜间模式')

watch(theme, applyTheme, { immediate: true })

watch(realSessionTitle, (title) => {
  document.title = title || '对话工作台'
}, { immediate: true })

onMounted(async () => {
  await Promise.all([fetchState(), fetchPromptLibrary()])
  connectEvents()
  clockTimer = setInterval(() => { state.clockTick = Date.now() }, 1000)
  window.addEventListener('keydown', handleGlobalKeydown)
})

onBeforeUnmount(() => {
  if (es) es.close()
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  if (metricsRaf) cancelAnimationFrame(metricsRaf)
  if (clockTimer) clearInterval(clockTimer)
  themeTransitionRunId += 1
  themeRevealAnimation?.cancel()
  activeThemeTransition?.skipTransition()
  clearThemeTransitionVisuals()
  document.body.classList.remove('tool-detail-open')
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
  state.lines = payload.lines || []
  if (state.toolDetailLineId !== undefined && !state.lines.some((line) => String(line.id) === String(state.toolDetailLineId))) closeToolDetail()
  syncMessageImagePreviewsFromLines(state.lines)
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
  state.cwd = payload.cwd || ''
  state.appPrompt = payload.appPrompt || { hasActivePrompt: false, activePrompt: undefined }
  rememberRuntimeSession(payload.session)
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
  if (!confirm('确定删除这个提示词吗？')) return
  const removed = state.promptLibrary.find((item) => item.id === id)
  if (!removed) return
  try {
    const result = await postJson('/api/prompt-library/delete', { id })
    syncPromptLibrary(result.items)
  } catch (error) {
    notify(error.message || String(error))
    return
  }
  if (activeAppPrompt.value?.id === removed.id) void clearAppPrompt()
  notify('已删除提示词')
}

async function applyPromptItem(item) {
  const normalized = normalizePromptItem(item)
  if (!normalized) {
    notify('提示词无效')
    return
  }
  try {
    const result = await postJson('/api/app-prompt', {
      id: normalized.id,
      title: normalized.title,
      source: 'sidebar-library',
      content: normalized.content,
    })
    if (result?.ok !== false) {
      state.appPrompt = result.appPrompt || { hasActivePrompt: true, activePrompt: normalized }
      notify(`已应用：${normalized.title}`)
    }
  } catch (error) {
    const message = String(error?.message || error || '')
    if (message.toLowerCase() === 'not found') {
      notify('当前运行中的 runtime 还不支持提示词接口，请重启开发服务。')
      return
    }
    notify(message || '应用提示词失败')
  }
}

async function clearAppPrompt() {
  try {
    const result = await postJson('/api/app-prompt', { clear: true })
    if (result?.ok !== false) {
      state.appPrompt = result.appPrompt || { hasActivePrompt: false, activePrompt: undefined }
      notify('已清空应用提示词')
    }
  } catch (error) {
    const message = String(error?.message || error || '')
    if (message.toLowerCase() === 'not found') {
      notify('当前运行中的 runtime 还不支持提示词接口，请重启开发服务。')
      return
    }
    notify(message || '清空提示词失败')
  }
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
  const submitText = appendHiddenAttachmentManifest(
    textWithDownloadExposureHint(textWithAttachmentLabels(textWithImageToolHint(text, imageAttachments), imageAttachments)),
    fileAttachments
  )
  cacheMessageImagePreviews(imageAttachments)
  input.value = ''
  state.attachments = []
  autosize()
  try {
    const res = await fetch(runtimeUrl('/api/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: submitText, attachments: imageAttachments }),
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
  state.sessionsLoading = true
  try {
    const res = await fetch(runtimeUrl('/api/sessions'))
    const body = await res.json()
    state.sessions = body.sessions || []
    state.runningSessionIds = body.runningSessionIds || []
  } catch (error) {
    notify(error.message || String(error))
  } finally {
    state.sessionsLoading = false
  }
}

async function resumeSession(sessionId) {
  state.pendingResumeSessionId = sessionId
  state.sessionResumeLoading = true
  state.activePanel = 'chat'
  const result = await postJson('/api/sessions/resume', { sessionId })
  if (result?.ok === false) {
    state.sessionResumeLoading = false
    state.pendingResumeSessionId = ''
  }
}

async function newSession() {
  const result = await postJson('/api/sessions/new', {})
  if (result?.ok !== false) {
    state.activePanel = 'chat'
    notify('已创建新会话')
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
  const res = await fetch(runtimeUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await res.json().catch(() => ({}))
  if (!res.ok || value?.error || value?.ok === false) throw new Error(value.error || `request ${res.status}`)
  return value
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
  if (line.kind === 'tool') return isPlanToolLine(line) ? '任务计划' : exactToolName(line)
  if (line.title) return LINE_TITLE_LABELS[line.title] || LINE_TITLE_LABELS[String(line.title).toLowerCase()] || line.title
  if (line.kind === 'assistant') return '助手'
  if (line.kind === 'user') return '你'
  if (line.kind === 'thinking') return '推理过程'
  return '系统'
}

function exactToolName(line) {
  return String(line?.title || line?.metadata?.tool || 'tool').trim() || 'tool'
}

function lineToolKindText(line) {
  if (line?.kind !== 'tool') return ''
  if (line.toolKind) return line.toolKind
  const name = exactToolName(line).toLowerCase()
  if (name === 'image2') return '作图'
  if (name.includes('xhs_artifact_editor') || name === 'edit' || name === 'write' || name.includes('apply_patch')) return '编辑'
  if (name === 'exec' || name.includes('shell') || name.includes('command')) return '执行'
  if (name.includes('download')) return '下载'
  if (name.includes('read') || name.includes('load') || name.includes('list') || name.includes('grep') || name.includes('search') || name.includes('query')) return '查询'
  if (name.includes('plan')) return '计划'
  return '工具'
}

function isPlanToolLine(line) {
  return line?.kind === 'tool' && exactToolName(line).toLowerCase() === 'plan'
}

function isInlineRichToolLine(line) {
  return isPlanToolLine(line) || isImage2Line(line) || isExposeDownloadsLine(line) || isXhsArtifactLine(line)
}

function shouldCollapseToolLine(line) {
  return line?.kind === 'tool' && !isInlineRichToolLine(line)
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

function toolResultStatus(line) {
  if (line?.live) return { key: 'running', label: '执行中' }
  const parsed = parseFirstJsonObject(line?.text || '')
  const failed = parsed?.ok === false || parsed?.error || parsed?.output?.error || /fail|error/i.test(String(line?.titleStatus || '')) || /(^|\s)(error|failed|failure):/i.test(String(line?.text || ''))
  return failed ? { key: 'failed', label: '执行失败' } : { key: 'completed', label: '执行完成' }
}

function toolResultSummary(line) {
  const name = exactToolName(line).toLowerCase()
  const raw = String(line?.text || '')
  const parsed = parseFirstJsonObject(raw)
  const output = parsed?.output && typeof parsed.output === 'object' ? parsed.output : parsed
  const error = output?.error || parsed?.error
  if (error) return truncateSummary(String(error), 150)
  if (name === 'exec' || name.includes('shell') || name.includes('command')) {
    const description = output?.description || output?.command || toolTextField(raw, ['目的', 'description', 'command'])
    const suffix = output?.exitCode !== undefined ? ` · exit ${output.exitCode}` : ''
    return truncateSummary(`${description || '命令执行结束'}${suffix}`, 150)
  }
  if (name === 'read' || name.includes('read')) {
    const range = output?.startLine && output?.endLine ? ` · ${output.startLine}-${output.endLine} 行` : ''
    return truncateSummary(`${output?.path || toolTextField(raw, ['file', 'path']) || '文件读取完成'}${range}`, 150)
  }
  if (name === 'write' || name === 'edit' || name.includes('apply_patch')) {
    const operation = output?.operation ? ` · ${output.operation}` : ''
    const path = output?.path || /^(?:create|edit|write)\s+(.+?)(?:,|$)/im.exec(raw)?.[1]
    return truncateSummary(`${path || '文件更新完成'}${operation}`, 150)
  }
  if (name === 'list') {
    const count = output?.returnedEntries ?? output?.totalFiles
    return truncateSummary(`${output?.path || toolTextField(raw, ['path']) || '目录读取完成'}${count !== undefined ? ` · ${count} 项` : ''}`, 150)
  }
  if (name === 'grep' || name.includes('search') || name.includes('query')) {
    const count = output?.matchCount ?? output?.matches?.length ?? output?.results?.length
    return truncateSummary(`${output?.query || output?.pattern || output?.path || '搜索完成'}${count !== undefined ? ` · ${count} 条` : ''}`, 150)
  }
  const firstLine = raw.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
  return truncateSummary(firstLine || `${exactToolName(line)} 已完成`, 150)
}

function truncateSummary(value, maxLength) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

function toolTextField(text, labels) {
  for (const label of labels) {
    const match = new RegExp(`(?:^|\\n)${escapeRegExp(label)}[:：]\\s*([^\\n]+)`, 'i').exec(String(text || ''))
    if (match?.[1]) return match[1].trim()
  }
  return ''
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
  const completed = Number.isFinite(Number(plan.completed))
    ? Number(plan.completed)
    : items.filter((item) => normalizePlanStatus(item?.status) === 'completed').length
  const total = Number.isFinite(Number(plan.total)) ? Number(plan.total) : items.length
  const progress = total > 0 ? Math.max(0, Math.min(100, completed / total * 100)) : 0
  const title = escapeHtml(plan.title || '任务计划')
  const rows = items.map((item, index) => {
    const status = normalizePlanStatus(item?.status)
    const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : status === 'failed' ? '!' : String(index + 1)
    return `<li class="plan-item status-${status}"><span class="plan-item-marker" aria-hidden="true">${icon}</span><span class="plan-item-text">${escapeHtml(item?.description || `步骤 ${index + 1}`)}</span><span class="plan-item-status">${planStatusLabel(status)}</span></li>`
  }).join('')
  const note = plan.note ? `<div class="plan-note"><span>说明</span><p>${escapeHtml(plan.note)}</p></div>` : ''
  return `<section class="plan-card"><div class="plan-card-head"><div><span class="plan-kicker">执行计划</span><strong>${title}</strong></div><span class="plan-progress-label">${completed} / ${total}</span></div><div class="plan-progress-track" aria-label="计划进度 ${Math.round(progress)}%"><span style="width:${progress.toFixed(2)}%"></span></div><ol class="plan-items">${rows}</ol>${note}</section>`
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
  return sanitizeMarkdown(marked.parse(`已阅读技能${skillReadName(line?.text || '')}`))
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
  return sanitizeMarkdown(marked.parse(`已分析并记录图片${imageNoteLabel(line?.text || '')}`))
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
  const parsed = parseFirstJsonObject(line?.text || '')
  const artifact = line?.artifact || parsed?.artifact || parsed?.output?.artifact || parsed?.result?.artifact || parseXhsArtifactSummary(line?.text)
  if (!artifact?.id) return null
  const id = String(artifact.id)
  if (!state.xhsArtifacts[id] || line?.artifact) state.xhsArtifacts[id] = artifact
  return state.xhsArtifacts[id]
}

function parseXhsArtifactSummary(text) {
  const value = String(text || '')
  const id = /\bid:\s*([^\s]+)/i.exec(value)?.[1]
  if (!id) return null
  const title = /\btitle:\s*([\s\S]*?)\s+(?:payload|content):\s*/i.exec(value)?.[1]?.trim() || '小红书笔记'
  const content = /\bcontent:\s*([\s\S]*)$/i.exec(value)?.[1]?.trim() || ''
  return { id, type: 'xhs-post', title, payload: parseFirstJsonObject(content) || {}, content }
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
    return `<a class="download-card" href="${href}" download><span class="download-icon" aria-hidden="true">↓</span><span class="download-main"><strong>${filename}</strong><span>${escapeHtml(meta || '已生成')}</span></span><span class="download-action">点击下载</span></a>`
  }).join('')
  return `<div class="download-result"><div class="download-result-header"><strong>文件已准备好</strong><span>点击下方链接下载</span></div><div class="download-grid">${cards}</div></div>`
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
  const starts = []
  for (let index = raw.indexOf('{'); index >= 0; index = raw.indexOf('{', index + 1)) starts.push(index)
  for (const start of starts) {
    for (let end = raw.length; end > start; end = raw.lastIndexOf('}', end - 1)) {
      if (end <= start) break
      try {
        return JSON.parse(raw.slice(start, end + 1))
      } catch {}
    }
  }
  return null
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
  const chips = [parsed.count ? `${parsed.count} 张` : '', parsed.model, parsed.size, parsed.quality, parsed.outputFormat, parsed.sourceImages ? `源图 ${parsed.sourceImages} 张` : '', parsed.duration].filter(Boolean)
  const parts = [`<div class="image2-result"><div class="image2-summary"><strong>${escapeHtml(status)}</strong>${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join('')}</div>`]
  const details = [parsed.provider && `provider: ${parsed.provider}`, parsed.background && `background: ${parsed.background}`, parsed.usage && `usage: ${parsed.usage}`].filter(Boolean)
  if (details.length) parts.push(`<div class="image2-details">${escapeHtml(details.join(' · '))}</div>`)
  parts.push('</div>')
  return parts.join('')
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

function clearThemeTransitionVisuals() {
  const root = document.documentElement
  root.classList.remove('theme-transitioning')
  root.style.removeProperty('--theme-transition-x')
  root.style.removeProperty('--theme-transition-y')
}

function toggleTheme(event) {
  const nextTheme = requestedTheme === 'dark' ? 'light' : 'dark'
  requestedTheme = nextTheme
  const trigger = event?.currentTarget
  const rect = trigger?.getBoundingClientRect()
  const originX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
  const originY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  if (activeThemeTransition) {
    themeTransitionRunId += 1
    themeRevealAnimation?.cancel()
    themeRevealAnimation = undefined
    activeThemeTransition.skipTransition()
    clearThemeTransitionVisuals()
    theme.value = nextTheme
    return
  }

  if (!document.startViewTransition || reduceMotion) {
    theme.value = nextTheme
    return
  }

  const root = document.documentElement
  const radius = Math.hypot(
    Math.max(originX, window.innerWidth - originX),
    Math.max(originY, window.innerHeight - originY),
  )
  root.style.setProperty('--theme-transition-x', `${originX}px`)
  root.style.setProperty('--theme-transition-y', `${originY}px`)
  root.classList.add('theme-transitioning')
  const runId = ++themeTransitionRunId
  let transition
  try {
    transition = document.startViewTransition(async () => {
      if (runId !== themeTransitionRunId) return
      theme.value = nextTheme
      await nextTick()
    })
    activeThemeTransition = transition
  } catch {
    clearThemeTransitionVisuals()
    theme.value = nextTheme
    return
  }

  transition.ready.then(() => {
    if (runId !== themeTransitionRunId || activeThemeTransition !== transition) return
    themeRevealAnimation = root.animate(
      {
        clipPath: [
          `circle(0px at ${originX}px ${originY}px)`,
          `circle(${radius}px at ${originX}px ${originY}px)`,
        ],
      },
      {
        duration: 2000,
        easing: 'cubic-bezier(.22,.68,.18,1)',
        fill: 'both',
        pseudoElement: '::view-transition-new(root)',
      },
    )
  }).catch(() => {})

  transition.finished.finally(() => {
    if (activeThemeTransition === transition) activeThemeTransition = undefined
    if (runId !== themeTransitionRunId) return
    themeRevealAnimation = undefined
    clearThemeTransitionVisuals()
  })
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
    state.attachments.push({ kind: 'image', label, mimeType: payload.mimeType, data: payload.data, previewUrl: payload.previewUrl, name: file.name || `图片 ${id}` })
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

function textWithAttachmentLabels(text, attachments) {
  if (!attachments.length) return text
  const suffix = attachments.map((attachment) => attachment.label).join(' ')
  return text.trim() ? `${text.trim()}\n\n${suffix}` : suffix
}

function appendHiddenAttachmentManifest(text, attachments) {
  if (!attachments.length) return text
  const manifest = [
    ATTACHMENT_MANIFEST_START,
    'The user uploaded files for this turn. These paths are hidden from the UI.',
    'Use local tools such as exec to inspect them when helpful.',
    ...attachments.map((attachment, index) => [
      `- file${index + 1}: ${attachment.name || `attachment-${index + 1}`}`,
      `  path: ${attachment.absolutePath}`,
      `  mimeType: ${attachment.mimeType || 'application/octet-stream'}`,
      `  size: ${Number(attachment.size || 0)} bytes`,
    ].join('\n')),
    ATTACHMENT_MANIFEST_END,
  ].join('\n')
  return [text.trim(), manifest].filter(Boolean).join('\n\n')
}

function textWithImageToolHint(text, attachments) {
  const hints = []
  if (looksLikeImageGenerationRequest(text)) hints.push(IMAGE_GENERATION_HINT)
  if (attachments.some((attachment) => attachment.kind === 'image') && looksLikeImageOperationRequest(text)) hints.push(IMAGE_OPERATION_HINT)
  if (!hints.length) return text
  return [text.trim(), ...hints].filter(Boolean).join('\n\n')
}

function textWithDownloadExposureHint(text) {
  return [String(text || '').trim(), DOWNLOAD_EXPOSURE_HINT, XHS_ARTIFACT_EDITOR_HINT].filter(Boolean).join('\n\n')
}

function looksLikeImageGenerationRequest(text) {
  const value = String(text || '').toLowerCase()
  return /绘制|画一张|画个|生成图片|生成一张图|做一张图|出图|配图|插画|海报|封面|头像|draw|illustrate|generate (?:an? )?image|create (?:an? )?image|make (?:an? )?image|render|poster|cover art|concept art|portrait|mascot/.test(value)
}

function looksLikeImageOperationRequest(text) {
  const value = String(text || '').toLowerCase()
  return /修改|编辑|改图|重绘|换背景|去除|移除|修复|润色|调整|变成|改成|替换|加上|添加|保留|风格|edit|modify|change|replace|remove|retouch|inpaint|outpaint|background|style/.test(value)
}

function stripImageLabels(text) {
  return String(text).replace(/\s*\[img#\d+\]\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

function stripImageOperationHint(text) {
  return String(text)
    .replace(IMAGE_GENERATION_HINT, '')
    .replace(IMAGE_OPERATION_HINT, '')
    .replace(DOWNLOAD_EXPOSURE_HINT, '')
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
  const previews = attachments
    .filter((attachment) => attachment?.kind === 'image' && attachment.label && attachment.previewUrl)
    .map((attachment) => ({
      label: attachment.label,
      mimeType: attachment.mimeType,
      previewUrl: attachment.previewUrl,
      originalUrl: attachment.previewUrl,
      name: attachment.name,
    }))
  mergeMessageImagePreviews(previews)
}

function syncMessageImagePreviewsFromLines(lines) {
  const previews = []
  for (const line of lines || []) collectLineImageItems(line, previews)
  mergeMessageImagePreviews(previews.map(normalizeImagePreview).filter((item) => item?.label))
}

function mergeMessageImagePreviews(previews) {
  if (!previews.length) return
  const labels = new Set(previews.map((item) => item.label).filter(Boolean))
  state.messageImagePreviews = [
    ...state.messageImagePreviews.filter((item) => !labels.has(item.label)),
    ...previews,
  ].slice(-100)
}

function lineImagePreviews(line) {
  if (isImage2Line(line)) return image2LineImages(line)
  const group = line?.kind === 'user' ? userMessageGroup(line) : [line]
  const images = []
  for (const item of group) {
    images.push(...directLineImagePreviews(item))
    for (const label of imageLabelsFromText(item?.text)) {
      const cached = state.messageImagePreviews.find((image) => image.label === label)
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
  return dedupeImages(images.map(normalizeImagePreview).filter(Boolean))
}

function userMessageGroup(line) {
  if (line?.kind !== 'user') return [line]
  const lines = state.lines || []
  const index = lines.findIndex((item) => String(item?.id) === String(line?.id))
  if (index < 0) return [line]
  let start = index
  while (start > 0 && lines[start - 1]?.kind === 'user') start -= 1
  let end = start
  while (end + 1 < lines.length && lines[end + 1]?.kind === 'user') end += 1
  return lines.slice(start, end + 1)
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
  return title === 'image2'
    || line?.metadata?.tool === 'image2'
    || line?.metadata?.generatedImages === true
    || isImage2OutputImageLine(line)
    || (line?.kind === 'tool' && /^Generated image \d+$/i.test(String(line?.text || '').trim()))
}

function isImage2OutputImageLine(line) {
  if (line?.kind !== 'tool' || line?.title || directLineImagePreviews(line).length === 0) return false
  const lines = state.lines || []
  const index = lines.findIndex((item) => String(item?.id) === String(line?.id))
  if (index < 0) return false
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = lines[cursor]
    if (isImage2Line(previous)) return true
    if (previous?.kind === 'tool' && !previous?.title && directLineImagePreviews(previous).length > 0) continue
    return false
  }
  return false
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
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand-row logo-only">
        <button class="theme-toggle" type="button" :aria-label="themeToggleLabel" :title="themeToggleLabel" @click="toggleTheme">
          <svg v-if="isDarkTheme" class="ui-icon theme-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="3.2" />
            <path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6 6 6M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4" />
          </svg>
          <svg v-else class="ui-icon theme-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M15.8 12.4A6.1 6.1 0 0 1 7.6 4.2 6.1 6.1 0 1 0 15.8 12.4Z" />
          </svg>
          <span>{{ isDarkTheme ? '日间模式' : '夜间模式' }}</span>
        </button>
      </div>

      <nav class="nav">
        <button :class="{ active: state.activePanel === 'chat' }" @click="state.activePanel = 'chat'">
          <span class="nav-button-content">
            <svg class="ui-icon nav-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 5.5h12M4 10h7M4 14.5h9" />
              <path d="M14.5 12.5 17 10l-2.5-2.5" />
            </svg>
            <span>对话工作台</span>
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

      <button class="sidebar-card session-entry" type="button" @click="state.activePanel = 'chat'">
        <div class="eyebrow">当前会话</div>
        <div class="session-title-line"><span class="dot ok"></span><strong>{{ currentTitle }}</strong></div>
        <div class="muted">{{ currentSessionId }}</div>
      </button>

      <section class="sidebar-card prompt-stack">
        <div class="prompt-stack-head">
          <div>
            <div class="eyebrow">应用提示词</div>
            <strong>卡片拖到对话框生效</strong>
          </div>
          <button type="button" class="mini-button" @click="openPromptManager()">管理</button>
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

      <div class="sidebar-footer">
        <button @click="newSession">
          <span class="nav-button-content">
            <svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 4.5v11M4.5 10h11" />
            </svg>
            <span>新建会话</span>
          </span>
        </button>
        <button @click="interrupt">
          <span class="nav-button-content">
            <svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="5.5" y="5.5" width="9" height="9" rx="1.75" />
            </svg>
            <span>中断任务</span>
          </span>
        </button>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="crumb">
          <svg class="ui-icon crumb-icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4.5 6.5h4v4h-4zM11.5 6.5h4v4h-4zM8.5 8.5h3M10 5.5v9M8.5 11.5h3M4.5 13.5h4v4h-4zM11.5 13.5h4v4h-4z" />
          </svg>
          <span>工作空间 / {{ activePanelLabel }}</span>
        </div>
        <div class="top-actions">
          <button class="ghost mobile-theme-toggle" type="button" :aria-label="themeToggleLabel" :title="themeToggleLabel" @click="toggleTheme">
            <svg v-if="isDarkTheme" class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="3.2" />
              <path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6 6 6M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4" />
            </svg>
            <svg v-else class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.8 12.4A6.1 6.1 0 0 1 7.6 4.2 6.1 6.1 0 1 0 15.8 12.4Z" />
            </svg>
          </button>
          <button class="ghost" @click="openLogin()">配置模型</button>
          <button class="primary" @click="newSession">+ 新建</button>
        </div>
      </header>

      <section v-if="state.activePanel === 'chat'" class="content-grid chat-grid">
        <div class="chat-panel">
          <div ref="transcript" class="transcript">
            <article v-for="line in visibleLines" :key="line.id" :class="['message', line.kind || 'system', { live: line.live }]">
              <div :class="['message-marker', { spinning: line.live }]">
                <svg class="message-marker-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="9" height="9" rx="1.25" transform="rotate(45 10 10)" />
                </svg>
              </div>
              <div class="message-body">
                <div class="message-head">
                  <strong>{{ lineTitle(line) }}</strong>
                  <span v-if="lineToolKindText(line)" class="tool-kind-pill">{{ lineToolKindText(line) }}</span>
                  <span v-if="line.titleStatus">{{ line.titleStatus }}</span>
                  <span v-if="line.live" class="live-pill">实时</span>
                  <span v-if="lineElapsedText(line)" class="elapsed-pill">{{ lineElapsedText(line) }}</span>
                </div>
                <div v-if="isImage2ResultLine(line)" class="image2-result-shell">
                  <div class="message-text markdown image2-stage-wrap" v-html="renderImage2Stage(line)"></div>
                  <button type="button" class="image2-detail-button" @click="openToolDetail(line)">查看调用详情</button>
                </div>
                <div v-else-if="shouldCollapseToolLine(line)" :class="['tool-result-summary', `status-${toolResultStatus(line).key}`]">
                  <div class="tool-result-summary-icon" aria-hidden="true">
                    <svg class="ui-icon" viewBox="0 0 20 20">
                      <path d="M5 5.5h10v9H5zM7.5 8h5M7.5 11h3.5" />
                    </svg>
                  </div>
                  <div class="tool-result-summary-main">
                    <div><strong>{{ toolResultStatus(line).label }}</strong><span>{{ lineToolKindText(line) }}</span></div>
                    <p>{{ toolResultSummary(line) }}</p>
                  </div>
                  <button type="button" class="tool-result-view" :disabled="!line.text" @click="openToolDetail(line)">查看结果</button>
                </div>
                <template v-else>
                  <template v-if="isXhsArtifactLine(line)">
                    <XhsArtifactEditor
                      v-if="xhsArtifactForLine(line)"
                      :artifact="xhsArtifactForLine(line)"
                      @saved="handleXhsArtifactSaved"
                      @error="handleXhsArtifactError"
                    />
                    <div v-else class="message-text markdown" v-html="renderLine(line)"></div>
                  </template>
                  <div v-else-if="!removeOmittedImageDetails(line)" class="message-text markdown" v-html="renderLine(line)"></div>
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
              </div>
            </article>
            <div v-if="showTranscriptLoading" class="message-loading" role="status" aria-live="polite">
              <div class="message-loading-marker" aria-hidden="true"><span></span><span></span><span></span></div>
              <div class="message-loading-body">
                <div class="message-loading-label">{{ transcriptLoadingLabel }}</div>
                <div class="message-loading-track" aria-hidden="true"><span></span></div>
              </div>
            </div>
          </div>

          <div v-if="state.queuedInput" class="queued">
            <span>已排队的下一条消息：{{ state.queuedInput }}</span>
            <button type="button" @click="retractQueuedInput">撤回</button>
          </div>

          <form
            :class="['composer', { 'drop-active': state.composerDropActive }]"
            @submit.prevent="submit"
            @dragover="handleComposerDragOver"
            @dragleave="handleComposerDragLeave"
            @drop="handleComposerDrop"
          >
            <div class="composer-drop-hint">{{ composerDropHint }}</div>
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
                <button type="button" class="ghost" :disabled="state.uploadingFiles" @click="triggerFilePicker">{{ state.uploadingFiles ? '上传中…' : '上传附件' }}</button>
                <button type="button" class="ghost" @click="interrupt">停止</button>
                <button type="submit" class="primary" :disabled="state.uploadingFiles || (!input.trim() && !state.attachments.length)">发送 ↵</button>
              </div>
            </div>
          </form>
        </div>

        <aside class="right-panel">
          <section class="status-card compact-status">
            <div :class="['runtime-phase', { active }]">{{ active ? '●' : '✓' }} {{ exactPhaseLabel }}</div>
            <dl>
              <div><dt>模型</dt><dd>{{ modelName }}</dd></div>
              <div><dt>上下文</dt><dd>{{ contextPercent }}</dd></div>
              <div><dt>Token</dt><dd>↑ {{ inputTokens }} / ↓ {{ outputTokens }}</dd></div>
              <div class="cwd-row"><dt>CWD</dt><dd :title="currentCwd">{{ currentCwd }}</dd></div>
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
            <div><h2>会话管理</h2><p>恢复、删除或新建会话。正在运行的会话可以重新接入。</p></div>
            <button class="primary" @click="newSession">+ 新建会话</button>
          </div>
          <div v-if="state.sessionsLoading" class="empty-state">正在加载会话…</div>
          <div v-else-if="!filteredSessions.length" class="empty-state">暂无已保存会话。</div>
          <div class="session-list">
            <article v-for="session in filteredSessions" :key="session.sessionId" class="session-card">
              <div>
                <strong>{{ session.title || '未命名会话' }}</strong>
                <p>{{ session.sessionId }}</p>
                <small>{{ session.updatedAt || session.createdAt }}</small>
              </div>
              <div class="session-actions">
                <span v-if="state.runningSessionIds.includes(session.sessionId)" class="live-pill">运行中</span>
                <button :disabled="state.sessionResumeLoading || state.sessionsLoading" @click="resumeSession(session.sessionId)">{{ state.pendingResumeSessionId === session.sessionId && state.sessionResumeLoading ? '打开中…' : '打开' }}</button>
                <button class="danger" :disabled="state.sessionResumeLoading || state.sessionsLoading" @click="deleteSession(session.sessionId)">删除</button>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section v-else-if="state.activePanel === 'prompts'" class="content-grid single">
        <div class="panel-page prompt-page">
          <div class="page-head">
            <div><h2>提示词管理</h2><p>在这里编辑、整理和应用应用层提示词。</p></div>
            <div class="page-head-actions">
              <button class="ghost" @click="state.activePanel = 'chat'">回到对话</button>
              <button class="primary" @click="newPromptItem">+ 新建提示词</button>
            </div>
          </div>
          <div class="prompt-workbench">
            <aside class="prompt-library-panel">
              <div class="prompt-library-head">
                <strong>提示词列表</strong>
                <span>{{ state.promptLibrary.length }} 个</span>
              </div>
              <div class="prompt-library-list">
                <div v-if="state.promptLibraryLoading" class="prompt-list-empty">正在加载…</div>
                <div v-else-if="!state.promptLibrary.length" class="prompt-list-empty">暂无提示词</div>
                <button
                  v-else
                  v-for="item in state.promptLibrary"
                  :key="item.id"
                  :class="['prompt-library-item', { active: selectedPrompt?.id === item.id, applied: activeAppPrompt?.id === item.id }]"
                  type="button"
                  @click="selectPromptItem(item)"
                  @dblclick="applyPromptItem(item)"
                >
                  <strong>{{ item.title }}</strong>
                </button>
              </div>
            </aside>

            <section class="prompt-editor-panel">
              <div class="prompt-editor-toolbar">
                <div class="prompt-editor-current">
                  <span class="prompt-editor-kicker">编辑中</span>
                  <strong>{{ promptDraft.title || '新提示词' }}</strong>
                </div>
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
                  <textarea v-model="promptDraft.content" rows="14" placeholder="这里填写应用层 system prompt 内容"></textarea>
                </label>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section v-else-if="state.activePanel === 'settings'" class="content-grid single">
        <div class="panel-page">
          <div class="page-head">
            <div><h2>模型配置</h2><p>配置当前工作台使用的模型供应商参数，并保存到本地环境配置中。</p></div>
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

  <Teleport to="body">
    <div v-if="toolDetailLine" class="tool-result-modal-backdrop" @click.self="closeToolDetail">
      <section class="tool-result-modal" role="dialog" aria-modal="true" :aria-label="`${lineTitle(toolDetailLine)} 执行结果`">
        <header class="tool-result-modal-head">
          <div>
            <span class="tool-result-modal-kicker">工具执行结果</span>
            <div class="tool-result-modal-title">
              <strong>{{ lineTitle(toolDetailLine) }}</strong>
              <span :class="['tool-result-modal-status', `status-${toolResultStatus(toolDetailLine).key}`]">{{ toolResultStatus(toolDetailLine).label }}</span>
            </div>
            <p>{{ toolResultSummary(toolDetailLine) }}</p>
          </div>
          <button type="button" class="tool-result-modal-close" aria-label="关闭工具结果" @click="closeToolDetail">×</button>
        </header>
        <div class="tool-result-modal-content">
          <div class="message-text markdown tool-detail-markdown" v-html="renderToolDetail(toolDetailLine)"></div>
        </div>
        <footer class="tool-result-modal-footer">
          <span>按 Esc 关闭</span>
          <button type="button" class="primary" @click="closeToolDetail">关闭</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
