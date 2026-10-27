<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import LoadingRing from './LoadingRing.vue'
const props = defineProps({ loadPage: Function, current: Object, runningIds: { type: Array, default: () => [] }, pendingKey: String, revision: Number, admin: Boolean })
const emit = defineEmits(['open', 'context'])
const rows = ref([]), query = ref(''), searchOpen = ref(false), searchInput = ref(null)
const viewport = ref(null), sentinel = ref(null), loading = ref(false), error = ref(''), finished = ref(false)
let page = 0, version = 0, controller, observer, resizeObserver, debounce, disposed = false
const key = item => `${item?.ownerUsername || ''}:${item?.sessionId || ''}`
const currentKey = computed(() => key(props.current))
const visibleRows = computed(() => {
  const items = rows.value.map(item => key(item) === currentKey.value ? { ...item, title: props.current.title || item.title } : item)
  // Empty/new sessions are not yet in the persisted list. Keep the active one reachable.
  if (props.current?.sessionId && !query.value.trim() && !items.some(item => key(item) === currentKey.value)) items.unshift(props.current)
  return items
})
function group(item) {
  const value = Date.parse(item.updatedAt || item.createdAt || '')
  if (!Number.isFinite(value)) return key(item) === currentKey.value ? '今天' : '更早'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  return value >= +today ? '今天' : value >= +yesterday ? '昨天' : '更早'
}
function nearEnd() {
  const el = viewport.value
  return el && el.clientHeight > 0 && el.scrollHeight - el.clientHeight - el.scrollTop <= 4
}
function checkEnd() { if (nearEnd() && !error.value) void more() }
async function more() {
  if (disposed || loading.value || finished.value) return
  loading.value = true; error.value = ''
  const request = version, nextPage = page + 1
  controller = new AbortController()
  try {
    const result = await props.loadPage({ page: nextPage, pageSize: 10, q: query.value.trim(), signal: controller.signal })
    if (disposed || request !== version) return
    const batch = Array.isArray(result.sessions) ? result.sessions : []
    const known = new Set(rows.value.map(key))
    rows.value.push(...batch.filter(item => { const id = key(item); if (known.has(id)) return false; known.add(id); return true }))
    page = nextPage
    finished.value = batch.length === 0 || (Number.isFinite(result.totalPages) ? nextPage >= result.totalPages : nextPage * 10 >= (result.total ?? batch.length)) || (result.page && result.page < nextPage)
  } catch (cause) {
    if (request === version && cause.name !== 'AbortError') error.value = '加载失败，重试'
  } finally {
    if (request === version && !disposed) { loading.value = false; await nextTick(); checkEnd() }
  }
}
function reset() {
  version++; controller?.abort(); clearTimeout(debounce)
  rows.value = []; page = 0; finished.value = false; error.value = ''; loading.value = false
  if (viewport.value) viewport.value.scrollTop = 0
  void more()
}
watch(query, () => {
  version++; controller?.abort(); clearTimeout(debounce)
  loading.value = true; error.value = ''
  debounce = setTimeout(reset, 250)
})
watch(() => props.revision, reset)
async function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) { await nextTick(); searchInput.value?.focus() }
  else if (query.value) query.value = ''
}
onMounted(() => {
  observer = new IntersectionObserver(checkEnd, { root: viewport.value, rootMargin: '0px 0px 36px 0px' })
  observer.observe(sentinel.value)
  resizeObserver = new ResizeObserver(checkEnd); resizeObserver.observe(viewport.value)
  void more()
})
onBeforeUnmount(() => { disposed = true; version++; controller?.abort(); clearTimeout(debounce); observer?.disconnect(); resizeObserver?.disconnect() })
</script>

<template>
  <section class="quick-sessions" aria-label="会话快速切换">
    <div class="quick-head"><span>最近会话</span><button class="quick-search-toggle" type="button" aria-label="搜索最近会话" title="搜索会话" :aria-expanded="searchOpen" @click="toggleSearch"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5"/><path d="m12.5 12.5 4 4"/></svg></button></div>
    <div v-if="searchOpen" class="quick-search"><input ref="searchInput" v-model="query" type="search" placeholder="搜索会话" aria-label="搜索最近会话标题" autocomplete="off" @keydown.esc="toggleSearch" /></div>
    <div ref="viewport" class="quick-scroll" tabindex="0" aria-label="最近会话列表" :aria-busy="loading" @scroll.passive="checkEnd">
      <template v-for="(item, index) in visibleRows" :key="key(item)">
        <div v-if="index === 0 || group(item) !== group(visibleRows[index - 1])" class="quick-group">{{ group(item) }}</div>
        <button type="button" class="quick-session" :aria-current="key(item) === currentKey ? 'true' : undefined" :aria-busy="pendingKey === key(item)" :title="`${item.title || '未命名会话'}${admin ? ' / ' + item.ownerUsername : ''}`" @click="emit('open', item)" @contextmenu.prevent.stop="emit('context', $event, item)" @keydown.shift.f10.prevent.stop="emit('context', $event, item)">
          <span class="quick-title">{{ item.title || '未命名会话' }}</span>
          <span v-if="admin" class="quick-owner">{{ item.ownerUsername }}</span>
          <LoadingRing v-if="pendingKey === key(item)" class="quick-loading" />
          <span v-else-if="runningIds.includes(item.sessionId)" class="quick-running" role="img" aria-label="运行中" title="运行中"><i/><i/></span>
          <span v-if="key(item) === currentKey" class="quick-selection-frame" aria-hidden="true">
            <span class="frame-top-right" />
            <span class="frame-bottom-left" />
          </span>
        </button>
      </template>
      <div v-if="!loading && !visibleRows.length && !error" class="quick-empty">{{ query.trim() ? '没有匹配的会话' : '暂无会话' }}</div>
      <div ref="sentinel" class="quick-load" role="status" aria-live="polite">
        <LoadingRing v-if="loading" aria-label="正在加载会话" />
        <button v-else-if="error" class="quick-retry" type="button" @click="more">{{ error }}</button>
        <span v-else-if="finished && visibleRows.length > 10">已显示全部</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.quick-sessions{min-height:0;flex:1;display:flex;flex-direction:column;margin:2px 12px 8px;color:var(--chrome-muted,var(--muted))}
.quick-head{display:flex;align-items:center;justify-content:space-between;padding:0 10px 8px;flex-shrink:0;font-size:11px;letter-spacing:.04em}
.quick-sessions .quick-search-toggle{display:grid;place-items:center;width:28px;height:28px;min-height:0;padding:0;border:0!important;background:none!important;color:inherit!important;box-shadow:none!important}
.quick-search-toggle svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round}
.quick-search{padding:0 4px 10px}.quick-search input{width:100%;min-width:0;height:33px!important;padding:0 9px!important;font-size:12px!important}
.quick-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;flex:1;padding:0 0 14px;scrollbar-width:none;mask-image:linear-gradient(to bottom,#000 calc(100% - 14px),transparent)}
.quick-scroll::-webkit-scrollbar{display:none}.quick-scroll:focus-visible{outline:1px solid var(--pink);outline-offset:2px}
.quick-group{color:var(--chrome-muted,var(--muted));opacity:.7;font-size:10px;line-height:18px;margin:10px 10px 6px;letter-spacing:.06em}.quick-group:first-child{margin-top:1px}
.quick-sessions .quick-session{position:relative;display:flex;align-items:center;width:100%;height:42px;min-height:42px;text-align:left;border:0!important;border-radius:5px!important;padding:0 11px!important;gap:9px;box-shadow:none!important;background:transparent!important;color:var(--chrome-muted,var(--muted))!important;transition:background .16s,color .16s;transform:none!important}
.quick-sessions .quick-session:hover{color:var(--chrome-text,var(--text))!important;background:color-mix(in srgb,var(--pink) 5%,transparent)!important}
.quick-sessions .quick-session[aria-current='true']{color:var(--chrome-text,var(--text))!important;background:transparent!important;border-radius:0!important}
.quick-sessions .quick-selection-frame{position:absolute;inset:0;pointer-events:none;opacity:.75}
.quick-selection-frame>span{position:absolute;inset:0;box-sizing:border-box;border:0 solid var(--pink);clip-path:inset(0);animation-duration:.5s;animation-timing-function:linear;animation-fill-mode:both}
.quick-selection-frame .frame-top-right{border-top-width:1px;border-right-width:1px;animation-name:quick-frame-top-right}
.quick-selection-frame .frame-bottom-left{border-bottom-width:1px;border-left-width:1px;animation-name:quick-frame-bottom-left}
@keyframes quick-frame-top-right{0%{clip-path:inset(0 100% calc(100% - 1px) 0)}85%{clip-path:inset(0 0 calc(100% - 1px) 0)}100%{clip-path:inset(0)}}
@keyframes quick-frame-bottom-left{0%{clip-path:inset(calc(100% - 1px) 0 0 100%)}85%{clip-path:inset(calc(100% - 1px) 0 0 0)}100%{clip-path:inset(0)}}
@media(prefers-reduced-motion:reduce){.quick-selection-frame>span{animation:none}}
.quick-sessions .quick-session[aria-busy='true']{color:var(--pink)!important}.quick-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0;flex:1;font-size:12px;line-height:18px;font-weight:400}.quick-owner{max-width:48px;overflow:hidden;text-overflow:ellipsis;font-size:10px;opacity:.6}
.quick-sessions .quick-loading{width:12px!important;height:12px!important;flex:0 0 12px;color:var(--pink)!important}.quick-running{display:flex;align-items:center;justify-content:center;gap:3px;width:12px;height:12px;flex:0 0 12px}.quick-running i{width:1px;height:6px;background:var(--pink);animation:quick-pulse 1.5s ease-in-out infinite}.quick-running i+i{animation-delay:.4s}
.quick-load{min-height:34px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--chrome-muted,var(--muted))}.quick-load .loading-ring{width:15px;height:15px}.quick-sessions .quick-retry{border:0!important;background:none!important;font-size:11px;color:var(--pink)!important;padding:6px!important}.quick-empty{padding:18px 10px;font-size:12px}
@keyframes quick-pulse{50%{opacity:.25;transform:scaleY(.5)}}@media(prefers-reduced-motion:reduce){.quick-running i{animation:none}.quick-session{transition:none}}
</style>
