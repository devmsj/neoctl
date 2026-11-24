<script setup>
// Right column: background tasks, quota and server memory. It renders on its own
// data only; the parent hands in small view models that keep their identity while
// unchanged, so transcript streaming does not re-render this column.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
import TaskStatusIcon from './TaskStatusIcon.vue'
import { SPEED_SERIES, SPEED_WAVE_HEIGHT, SPEED_WAVE_WIDTH, formatElapsed, formatSpeed, latestSpeed, speedFirstTokenY, speedValue, speedWave, speedWaveHit } from '../model-speed.mjs'

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
  showSpeed: Boolean,
  speedTitle: { type: String, default: '' },
  // Latest model requests in time order: [{ at, model, firstTokenMs, tokensPerSecond? }]
  speed: { type: Array, default: () => [] },
  // Requests in flight: [{ id, model, startedAt (performance.now clock), firstTokenMs? }]
  speedLive: { type: Array, default: () => [] },
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

// Model speed: a mirrored waveform, speed above the axis, first token below; one wave per model.
const [speedUpSeries, speedDownSeries] = SPEED_SERIES
const speedWaveLayout = computed(() => speedWave(props.speed, props.speedLive))
const speedHasData = computed(() => props.speed.length > 0 || props.speedLive.length > 0)

// Requests in flight count on a frame clock while any exist: the first-token bar grows until the
// first output, the timer runs until the request completes and turns into part of the wave.
const speedClock = ref(performance.now())
let speedFrame = 0
function tickSpeedClock() {
  speedClock.value = performance.now()
  speedFrame = props.speedLive.length ? requestAnimationFrame(tickSpeedClock) : 0
}
watch(() => props.speedLive.length, (count) => {
  if (count && !speedFrame) speedFrame = requestAnimationFrame(tickSpeedClock)
}, { immediate: true })
onBeforeUnmount(() => { if (speedFrame) cancelAnimationFrame(speedFrame) })
const speedLiveSlots = computed(() => {
  const wave = speedWaveLayout.value
  return props.speedLive.map((entry, order) => {
    const index = wave.liveStart + order
    const elapsed = Math.max(0, speedClock.value - entry.startedAt)
    const waiting = entry.firstTokenMs === undefined
    const x = wave.xs[index], width = wave.widths[index]
    // The bar keeps a regular slot's width, centered in the (wider) lane of the newest request.
    const barWidth = Math.max(2, Math.min(wave.slot, 12) - 2)
    return { id: entry.id, index, x, width, barX: x + (width - barWidth) / 2, barWidth, elapsed, waiting, firstTokenMs: entry.firstTokenMs, model: entry.model, bottom: speedFirstTokenY(waiting ? elapsed : entry.firstTokenMs) }
  })
})
// The stopwatch of the newest request in flight lives in that request's own lane, above the axis: its
// speed is not known yet, so that space is free; nothing of the wave is covered or squeezed.
const speedTimer = computed(() => {
  const slot = speedLiveSlots.value.find(item => item.index === speedWaveLayout.value.laneIndex)
  if (!slot) return null
  const wave = speedWaveLayout.value
  return {
    text: formatElapsed(slot.elapsed),
    waiting: slot.waiting,
    style: { left: `${slot.x / SPEED_WAVE_WIDTH * 100}%`, width: `${slot.width / SPEED_WAVE_WIDTH * 100}%`, top: `${wave.axisY / SPEED_WAVE_HEIGHT * 100}%` },
  }
})
// Values are plain text in the theme's colors; only the waveform carries the speed colors.
const speedUpLatest = computed(() => formatSpeed(speedUpSeries, latestSpeed(props.speed, speedUpSeries)))
const speedDownLatest = computed(() => formatSpeed(speedDownSeries, latestSpeed(props.speed, speedDownSeries)))
const speedHoverIndexValue = ref(-1)
function updateSpeedHover(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  speedHoverIndexValue.value = speedWaveHit(speedWaveLayout.value, (event.clientX - rect.left) / Math.max(1, rect.width) * SPEED_WAVE_WIDTH)
}
function clearSpeedHover() {
  speedHoverIndexValue.value = -1
}

// Chart tooltips (memory and speed) float in <body> at viewport coordinates, so neither the cards'
// clipping nor the panel's scrolling cuts them. Anchored at the hovered point: above it, flipped
// below near the window top, and shifted sideways to stay inside the window.
const memoryChartEl = ref(null)
const speedChartEl = ref(null)
const chartTooltipEl = ref(null)
const chartTooltip = computed(() => {
  if (memoryHoveredPoint.value) {
    const point = memoryHoveredPoint.value
    return { kind: 'memory', chart: memoryChartEl.value, x: point.x / 260, y: point.y / 44 }
  }
  const index = speedHoverIndexValue.value
  const wave = speedWaveLayout.value
  if (index < 0 || wave.xs[index] === undefined) return null
  const anchor = { kind: 'speed', key: `speed:${index}`, chart: speedChartEl.value, x: (wave.xs[index] + wave.widths[index] / 2) / SPEED_WAVE_WIDTH, y: wave.tops[index] / SPEED_WAVE_HEIGHT }
  const live = speedLiveSlots.value.find(slot => slot.index === index)
  if (live) {
    return {
      ...anchor,
      values: [
        { key: 'elapsed', text: `进行中 ${formatElapsed(live.elapsed)}` },
        { key: 'first', text: `首字 ${live.waiting ? '等待中' : formatSpeed(speedDownSeries, live.firstTokenMs)}` },
      ],
      model: live.model,
    }
  }
  const sample = props.speed[index]
  if (!sample) return null
  return {
    ...anchor,
    values: SPEED_SERIES.map(series => ({ key: series.key, text: `${series.label} ${formatSpeed(series, speedValue(sample, series))}` })),
    model: sample.model,
    time: formatMemoryTooltipTime(sample.at),
  }
})
const chartTooltipPosition = ref(null)
const TOOLTIP_GAP = 7
const VIEWPORT_MARGIN = 8
// Re-placed whenever the content changes (a live timer changes every frame); hidden only while a new
// target's first placement is measured, so a running timer never flickers.
let chartTooltipKey = ''
watch(chartTooltip, async (tooltip) => {
  const key = tooltip ? (tooltip.key || tooltip.kind + ':' + tooltip.x) : ''
  if (key !== chartTooltipKey) chartTooltipPosition.value = null
  chartTooltipKey = key
  if (!tooltip?.chart) return
  await nextTick()
  const element = chartTooltipEl.value
  if (!element || chartTooltip.value !== tooltip) return
  const rect = tooltip.chart.getBoundingClientRect()
  const anchorX = rect.left + tooltip.x * rect.width
  const anchorY = rect.top + tooltip.y * rect.height
  const { width, height } = element.getBoundingClientRect()
  const left = Math.min(Math.max(VIEWPORT_MARGIN, anchorX - width / 2), window.innerWidth - width - VIEWPORT_MARGIN)
  const above = anchorY - TOOLTIP_GAP - height
  chartTooltipPosition.value = { left: `${left}px`, top: `${above >= VIEWPORT_MARGIN ? above : anchorY + TOOLTIP_GAP}px` }
})
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
      <div v-if="memoryTrendPath" ref="memoryChartEl" class="memory-chart" @mousemove="updateMemoryHover" @mouseleave="clearMemoryHover">
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
      </div>
      <div v-else class="memory-trend-empty">—</div>
    </section>
    <section v-if="showSpeed" class="quota-card memory-card speed-card" data-card="speed">
      <div class="memory-card-head">
        <div>
          <span class="chrome-label" :data-tooltip="speedTitle"><ChromeIcon name="fast" />模型速度</span>
        </div>
      </div>
      <template v-if="speedHasData">
        <div class="speed-row">
          <span>{{ speedUpSeries.label }} ↑</span>
          <strong>{{ speedUpLatest }}</strong>
        </div>
        <div ref="speedChartEl" class="speed-chart" @mousemove="updateSpeedHover" @mouseleave="clearSpeedHover">
          <svg class="speed-wave" :viewBox="`0 0 ${SPEED_WAVE_WIDTH} ${SPEED_WAVE_HEIGHT}`" preserveAspectRatio="none" role="img" aria-label="最近模型请求：上方速度越高越快，下方首字越深越慢">
            <defs>
              <!-- Color follows the distance from the axis: fast green near the outer edge on top, slow red at the bottom. -->
              <linearGradient id="speed-wave-up" gradientUnits="userSpaceOnUse" x1="0" :y1="speedWaveLayout.axisY" x2="0" :y2="speedWaveLayout.axisY - speedWaveLayout.reach">
                <stop offset="0" style="stop-color: var(--speed-slow)" />
                <stop offset="0.5" style="stop-color: var(--speed-mid)" />
                <stop offset="1" style="stop-color: var(--speed-fast)" />
              </linearGradient>
              <linearGradient id="speed-wave-down" gradientUnits="userSpaceOnUse" x1="0" :y1="speedWaveLayout.axisY" x2="0" :y2="speedWaveLayout.axisY + speedWaveLayout.reach">
                <stop offset="0" style="stop-color: var(--speed-fast)" />
                <stop offset="0.5" style="stop-color: var(--speed-mid)" />
                <stop offset="1" style="stop-color: var(--speed-slow)" />
              </linearGradient>
              <!-- Fills fade in toward the outer edge, so a wave reads by the color at its crest, not a mix. -->
              <linearGradient id="speed-wave-up-fill" gradientUnits="userSpaceOnUse" x1="0" :y1="speedWaveLayout.axisY" x2="0" :y2="speedWaveLayout.axisY - speedWaveLayout.reach">
                <stop offset="0" style="stop-color: var(--speed-slow); stop-opacity: .04" />
                <stop offset="0.5" style="stop-color: var(--speed-mid); stop-opacity: .22" />
                <stop offset="1" style="stop-color: var(--speed-fast); stop-opacity: .45" />
              </linearGradient>
              <linearGradient id="speed-wave-down-fill" gradientUnits="userSpaceOnUse" x1="0" :y1="speedWaveLayout.axisY" x2="0" :y2="speedWaveLayout.axisY + speedWaveLayout.reach">
                <stop offset="0" style="stop-color: var(--speed-fast); stop-opacity: .04" />
                <stop offset="0.5" style="stop-color: var(--speed-mid); stop-opacity: .22" />
                <stop offset="1" style="stop-color: var(--speed-slow); stop-opacity: .45" />
              </linearGradient>
            </defs>
            <rect
              v-if="chartTooltip?.kind === 'speed'"
              class="speed-wave-hover"
              :x="speedWaveLayout.xs[speedHoverIndexValue]"
              y="0"
              :width="speedWaveLayout.widths[speedHoverIndexValue]"
              :height="SPEED_WAVE_HEIGHT"
            />
            <!-- A request in flight: a first-token bar that grows while it waits. -->
            <g v-for="slot in speedLiveSlots" :key="slot.id" class="speed-wave-live" :data-waiting="slot.waiting || undefined">
              <rect
                class="speed-wave-live-bar"
                :x="slot.barX"
                :y="speedWaveLayout.axisY + 2"
                :width="slot.barWidth"
                :height="Math.max(0, slot.bottom - speedWaveLayout.axisY - 2)"
                fill="url(#speed-wave-down)"
              />
            </g>
            <line v-for="piece in speedWaveLayout.axis" :key="piece.x1" class="speed-wave-axis" :x1="piece.x1" :x2="piece.x2" :y1="speedWaveLayout.axisY" :y2="speedWaveLayout.axisY" />
            <g v-for="(wave, order) in speedWaveLayout.waves" :key="order">
              <path class="speed-wave-area" :d="wave.area" :fill="`url(#speed-wave-${wave.side}${wave.line ? '-fill' : ''})`" />
              <path v-if="wave.line" class="speed-wave-line" :d="wave.line" :stroke="`url(#speed-wave-${wave.side})`" />
            </g>
            <circle v-for="dot in speedWaveLayout.missing" :key="`m${dot.index}`" class="speed-wave-missing" :cx="dot.x" :cy="dot.y" r="1.8" />
            <path
              v-for="mark in speedWaveLayout.over"
              :key="`o${mark.side}${mark.index}`"
              class="speed-wave-over"
              :data-side="mark.side"
              :d="mark.side === 'up' ? `M ${mark.x - 3} 5 L ${mark.x + 3} 5 L ${mark.x} 0 Z` : `M ${mark.x - 3} ${mark.y - 5} L ${mark.x + 3} ${mark.y - 5} L ${mark.x} ${mark.y} Z`"
            />
          </svg>
          <!-- Stopwatch of the newest request in flight, standing on the axis inside that request's lane. -->
          <div v-if="speedTimer" class="speed-timer" :data-waiting="speedTimer.waiting || undefined" :style="speedTimer.style">
            <i aria-hidden="true"></i>{{ speedTimer.text }}
          </div>
        </div>
        <div class="speed-row">
          <span>{{ speedDownSeries.label }} ↓</span>
          <strong>{{ speedDownLatest }}</strong>
        </div>
      </template>
      <div v-else class="memory-trend-empty">—</div>
    </section>
    <Teleport to="body">
      <div
        v-if="chartTooltip"
        ref="chartTooltipEl"
        class="memory-tooltip chart-tooltip"
        :style="chartTooltipPosition || { left: '0px', top: '0px', visibility: 'hidden' }"
      >
        <template v-if="chartTooltip.kind === 'memory'">
          <strong>{{ formatMemoryBytes(memoryHoveredPoint.entry.rss) }}</strong>
          <span>{{ formatMemoryTooltipTime(memoryHoveredPoint.entry.at) }}</span>
        </template>
        <template v-else>
          <strong v-for="value in chartTooltip.values" :key="value.key">{{ value.text }}</strong>
          <span>{{ chartTooltip.model }}</span>
          <span v-if="chartTooltip.time">{{ chartTooltip.time }}</span>
        </template>
      </div>
    </Teleport>
  </aside>
</template>
