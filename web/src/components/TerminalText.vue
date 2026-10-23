<script setup>
import { computed } from 'vue'
import { terminalAnsiSegments } from '../terminal-ansi.mjs'
const props = defineProps({ text: String, segments: Array, trimEnd: Boolean })
const visible = computed(() => {
  const spans = (props.segments ?? terminalAnsiSegments(props.text || '')).slice()
  if (props.trimEnd) {
    while (spans.length) {
      const last = spans.at(-1), text = last.text.trimEnd()
      if (text) { spans[spans.length - 1] = { ...last, text }; break }
      spans.pop()
    }
  }
  return spans
})
</script>
<template><pre class="terminal-text"><span v-for="(span, index) in visible" :key="index" :style="span.style">{{ span.text }}</span></pre></template>
<style>
.terminal-text {
  --terminal-foreground: var(--history-text, var(--chrome-text, #20252d));
  --terminal-background: var(--history-background, var(--chrome-panel, #ffffff));
  --terminal-color-0: #20252d; --terminal-color-1: #b32424; --terminal-color-2: #21752d; --terminal-color-3: #846000;
  --terminal-color-4: #2456bf; --terminal-color-5: #984092; --terminal-color-6: #00737e; --terminal-color-7: #505967;
  --terminal-color-8: #626b78; --terminal-color-9: #c72c35; --terminal-color-10: #237b38; --terminal-color-11: #936600;
  --terminal-color-12: #315fc9; --terminal-color-13: #a33f91; --terminal-color-14: #007a83; --terminal-color-15: #20252d;
  color: var(--terminal-foreground);
}
:root[data-theme='dark'] .terminal-text {
  --terminal-foreground: var(--history-text, var(--chrome-text, #d7dce3));
  --terminal-background: var(--history-background, var(--chrome-panel, #15191f));
  --terminal-color-0: #8a94a3; --terminal-color-1: #cd3131; --terminal-color-2: #0dbc79; --terminal-color-3: #e5b45a;
  --terminal-color-4: #5c85e6; --terminal-color-5: #bc65bc; --terminal-color-6: #36b6c5; --terminal-color-7: #d5d9e0;
  --terminal-color-8: #8993a1; --terminal-color-9: #f14c4c; --terminal-color-10: #23d18b; --terminal-color-11: #f5d76e;
  --terminal-color-12: #7c9eff; --terminal-color-13: #d68bd6; --terminal-color-14: #6cd8e4; --terminal-color-15: #f3f5f7;
}
/* A span carries only protocol-derived colors/styles; terminal output is always escaped by Vue. */
.terminal-text > span { white-space: inherit; }
.terminal-output-reader:not(.is-observation-output) .terminal-text { color: var(--terminal-foreground); background: var(--terminal-background); }
</style>
