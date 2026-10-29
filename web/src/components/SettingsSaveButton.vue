<script setup>
import LoadingRing from './LoadingRing.vue'
import ChromeIcon from './ChromeIcon.vue'
defineProps({ label: { type: String, default: '保存' }, busy: Boolean, disabled: Boolean, type: { type: String, default: 'submit' } })
</script>
<template>
  <button :type="type" class="settings-save-button" :disabled="disabled || busy" :aria-label="busy ? label + '中' : label" :data-tooltip="busy ? label + '中' : label" :aria-busy="busy"><LoadingRing v-if="busy" /><ChromeIcon v-else name="save" /></button>
</template>
