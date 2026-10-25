<script setup>
import { computed } from 'vue'
const props = defineProps({ status: String })
const state = computed(() => ({ pending: ['clock', '排队中'], running: ['running', '运行中'], completed: ['check', '已完成'], succeeded: ['check', '已完成'], exited: ['check', '已退出'], failed: ['error', '失败'], killed: ['stop', '已停止'], stopped: ['stop', '已停止'], lost: ['unknown', '已失联'] }[props.status] || ['unknown', '未知状态']))
const paths = { clock: 'M10 6v4l3 2M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', running: 'M10 3a7 7 0 1 1-7 7', check: 'm4 10 4 4 8-8', error: 'm6 6 8 8m0-8-8 8', stop: 'M5 5h10v10H5Z', unknown: 'M10 13v.5M8 7a2 2 0 1 1 3 1.8c-1 .5-1 1-1 1.7M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z' }
</script>
<template>
  <svg :class="['task-status-icon', `task-state-${state[0]}`]" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" :aria-label="state[1]"><title>{{ state[1] }}</title><path :d="paths[state[0]]" /></svg>
</template>
<style>
.task-status-icon { width: 16px; height: 16px; flex: 0 0 16px; color: var(--chrome-faint); }
.task-state-running { color: var(--chrome-accent); animation: task-status-turn 2s linear infinite; }
.task-state-check { color: var(--chrome-success); }
.task-state-error { color: var(--chrome-danger); }
@keyframes task-status-turn { to { transform: rotate(360deg); } }
@media(prefers-reduced-motion: reduce) { .task-state-running { animation: none; } }
</style>
