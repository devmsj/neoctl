<script setup>
// The subagent tool glyph (one agent routing to two). The filled node shows
// whose transcript is in view: the root for the main agent, a branch for a subagent.
defineProps({ active: { type: String, default: 'main' } })
</script>
<template>
  <svg class="agent-tree-icon" :data-active="active" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect class="agent-tree-node" :class="{ filled: active === 'main' }" x="2" y="10" width="7" height="7" rx="1.5" />
    <path d="M9 13.5h6V6.5h5M15 13.5v8h5" />
    <rect class="agent-tree-node" :class="{ filled: active === 'sub' }" x="20" y="3" width="6" height="7" rx="1.5" />
    <rect class="agent-tree-node" x="20" y="18" width="6" height="7" rx="1.5" />
  </svg>
</template>
<style>
.agent-tree-icon { display: block; overflow: visible; }
.agent-tree-node.filled { fill: currentColor; }
</style>
