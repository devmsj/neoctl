<script setup>
import { computed } from 'vue'
import { toolIcons } from '../tool-icons.mjs'
import '../tool-icons.css'
const props = defineProps({ name:String, phase:String, paused:Boolean })
const icon = computed(()=>toolIcons[props.name] || toolIcons.plugin)
</script>
<template><svg :class="['activity-icon',{active:['generating','running'].includes(phase),'is-paused':paused,failed:phase==='failed',interrupted:phase==='interrupted'}]" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" role="img" :aria-label="icon.name" v-html="icon.body"></svg></template>
<style>
.activity-icon{width:28px;height:28px;flex-shrink:0;color:var(--purple);overflow:visible}.activity-icon.is-paused .motion{animation-play-state:paused!important}.activity-icon:not(.active) .motion{animation:none!important}.activity-icon.failed{color:var(--history-icon,var(--purple))}.activity-icon.interrupted{opacity:.5}@media(prefers-reduced-motion:reduce){.activity-icon .motion{animation:none!important}}
</style>
