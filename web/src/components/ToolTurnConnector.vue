<script setup>
import '../tool-icons.css'
defineProps({ connection:Object })
</script>
<template>
  <span class="tool-turn-connector" :class="{'is-first':connection.first,'is-last':connection.last}" aria-hidden="true">
    <span class="tool-turn-stem"></span>
    <svg v-if="connection.branch" :class="['activity-icon',{'active':connection.moving}]" viewBox="0 0 12 26" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
      <path v-if="connection.first" d="M3 20v-3q0-4 4-4h4" class="motion route"/>
      <path v-else d="M3 6v3q0 4 4 4h4" class="motion route"/>
    </svg>
  </span>
</template>
<style>
.tool-turn-connector{position:absolute;left:0;top:0;bottom:0;width:12px;color:var(--history-icon,var(--purple));pointer-events:none;--turn-center:13px}
.virtual-message-row:has(>.tool-history-entry.is-tool-group-start)>.tool-turn-connector{--turn-center:23px}
.tool-turn-stem{position:absolute;left:3px;top:0;bottom:0;border-left:1.3px solid currentColor;opacity:.55}
.tool-turn-connector.is-first .tool-turn-stem{top:calc(var(--turn-center) + 4px)}
.tool-turn-connector.is-last .tool-turn-stem{bottom:calc(100% - var(--turn-center) + 4px)}
.tool-turn-connector>.activity-icon{position:absolute;left:0;top:calc(var(--turn-center) - 13px);width:12px;height:26px;color:inherit}
.tool-turn-connector .motion.route{animation-duration:2s;animation-iteration-count:1}
.tool-turn-enter-active,.tool-turn-leave-active{transition:opacity 240ms ease}
.tool-turn-enter-from,.tool-turn-leave-to{opacity:0}
@media(prefers-reduced-motion:reduce){.tool-turn-enter-active,.tool-turn-leave-active{transition:none}}
</style>
