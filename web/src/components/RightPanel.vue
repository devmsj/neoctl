<script setup>
// Right column: background tasks, quota and server memory. It renders on its own
// data only; the parent hands in small view models that keep their identity while
// unchanged, so transcript streaming does not re-render this column.
import { computed, ref } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
import TaskStatusIcon from './TaskStatusIcon.vue'

const props = defineProps({
  mobileCard: { type: String, default: '' },
  showTasks: Boolean,
  showMemory: Boolean,
  tasksTitle: { type: String, default: '' },
  memoryTitle: { type: String, default: '' },
  // { count, primary: { key, status, title, displayTitle } | null, history: [...] }
  tasks: { type: Object, required: true },
  // { account, resetAt, remainingPercent, index, total } | null (null hides the card)
  quota: { type: Object, default: null },
  // { current, history } as reported by the memory monitor
  memory: { type: Object, default: null },
})
const emit = defineEmits(['close-card', 'open-task', 'rotate-quota'])

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
function formatMemoryTooltipTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

const memoryCurrent = computed(() => props.memory?.current || null)
const memoryTrendPoints = computed(() => {
  const entries = (props.memory?.history || []).filter((entry) => Number.isFinite(Number(entry?.rss)))
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
// Hover is local presentation state: moving over the chart re-renders only this column.
const memoryHoverIndex = ref(-1)
const memoryHoveredPoint = computed(() => memoryTrendPoints.value[memoryHoverIndex.value] || null)
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
</script>

<template>
  <aside class="right-panel" :class="{ 'mobile-card-open': mobileCard }" :data-mobile-card="mobileCard" @keydown.esc.stop="emit('close-card')">
    <button v-if="mobileCard" type="button" class="mobile-card-close" aria-label="关闭卡片" data-tooltip="关闭" @click="emit('close-card')"><ChromeIcon name="close" /></button>
    <section v-if="showTasks" class="background-task-section" data-card="tasks">
      <div class="background-task-head">
        <div class="panel-title chrome-label"><ChromeIcon name="tasks" />{{ tasksTitle }}</div>
        <strong v-if="tasks.count" class="background-task-count">{{ tasks.count }}</strong>
      </div>
      <p v-if="mobileCard === 'tasks' && !tasks.primary && !tasks.history.length" class="mobile-card-empty">暂无后台任务</p>
      <button
        v-if="tasks.primary"
        type="button"
        class="background-task-summary"
        :data-tooltip="tasks.primary.title"
        @click="emit('open-task', tasks.primary.key)"
      >
        <TaskStatusIcon :status="tasks.primary.status" />
        <strong>{{ tasks.primary.displayTitle }}</strong>
        <span v-if="tasks.count > 1" class="background-task-more">+{{ tasks.count - 1 }}</span>
        <ChromeIcon name="chevron" class="task-entry-chevron" />
      </button>
      <details v-if="tasks.history.length" class="background-task-history">
        <summary><ChromeIcon name="clock" /><span>最近结束</span><strong>{{ tasks.history.length }}</strong><ChromeIcon name="chevron" class="task-history-chevron" /></summary>
        <div class="background-task-history-list">
          <button
            v-for="task in tasks.history"
            :key="task.key"
            type="button"
            class="background-task-summary background-task-history-item"
            :data-tooltip="task.title"
            @click="emit('open-task', task.key)"
          >
            <TaskStatusIcon :status="task.status" />
            <strong>{{ task.displayTitle }}</strong>
            <ChromeIcon name="chevron" class="task-entry-chevron" />
          </button>
        </div>
      </details>
    </section>
    <section v-if="quota" class="quota-card" data-card="quota">
      <div class="quota-card-head">
        <div>
          <span class="chrome-label" :data-tooltip="`周额度：${quotaAccountLabel(quota.account)}\n续期：${formatQuotaReset(quota.resetAt)}`"><ChromeIcon name="quota" />剩余额度</span>
          <strong>{{ quotaPercent(quota.remainingPercent) }}</strong>
        </div>
        <div v-if="quota.total > 1" class="quota-card-controls">
          <button type="button" aria-label="上一个凭据" @click="emit('rotate-quota', -1)">‹</button>
          <small :data-tooltip="quotaAccountLabel(quota.account)">{{ quota.index + 1 }}/{{ quota.total }}</small>
          <button type="button" aria-label="下一个凭据" @click="emit('rotate-quota', 1)">›</button>
        </div>
      </div>
      <div class="quota-progress" role="progressbar" aria-label="周额度剩余" :aria-valuenow="normalizedQuotaPercent(quota.remainingPercent)" aria-valuemin="0" aria-valuemax="100">
        <span class="quota-progress-fill" :style="{ width: `${normalizedQuotaPercent(quota.remainingPercent)}%` }"></span>
      </div>
    </section>
    <section v-if="showMemory" class="quota-card memory-card" data-card="memory">
      <div class="memory-card-head">
        <div>
          <span class="chrome-label" :data-tooltip="memoryTitle"><ChromeIcon name="memory" />内存</span>
          <strong>{{ formatMemoryBytes(memoryCurrent?.rss) }}</strong>
        </div>
      </div>
      <div v-if="memoryTrendPath" class="memory-chart" @mousemove="updateMemoryHover" @mouseleave="clearMemoryHover">
        <svg class="memory-trend" viewBox="0 0 260 44" preserveAspectRatio="none" role="img" aria-label="最近一小时内存趋势">
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
    </section>
  </aside>
</template>
