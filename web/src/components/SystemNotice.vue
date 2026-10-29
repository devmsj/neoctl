<script setup>
defineProps({ text: { type: String, default: '' } })
</script>
<template>
  <section class="system-notice" role="note" aria-label="系统消息">
    <svg class="system-notice-symbol" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 5.8v5.1m0 3.1h.01"/></svg>
    <div class="system-notice-content" tabindex="0" role="region" aria-label="系统信息">{{ text }}</div>
  </section>
</template>
<style>
:root[data-theme] .system-notice {
  display:flex; align-items:flex-start; gap:8px; width:100%; min-width:0; box-sizing:border-box;
  margin:8px 0; padding:11px 12px;
  border:var(--appearance-border-width,1px) solid color-mix(in srgb,var(--chrome-accent) 48%,transparent);
  /* Override the legacy universal sharp-corner reset, using the user's radius. */
  border-radius:var(--appearance-radius,6px) !important; color:var(--chrome-accent);
  background:color-mix(in srgb,var(--chrome-accent) 5%,transparent);
  font:inherit; font-size:var(--appearance-ui-size,13px); line-height:1.7;
}
.system-notice-symbol { width:16px; height:16px; margin-top:3px; flex:none; fill:none; stroke:currentColor; stroke-width:1.4; stroke-linecap:round; }
:root[data-theme] .system-notice-content {
  flex:1; min-width:0; max-height:min(300px,40dvh); overflow:auto; overscroll-behavior:contain;
  white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; color:inherit;
  text-overflow:clip; -webkit-line-clamp:unset; user-select:text; padding:0 2px 0 0;
}
.system-notice-content:focus-visible { outline:1px solid currentColor; outline-offset:3px; border-radius:2px; }
</style>
