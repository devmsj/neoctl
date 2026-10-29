<script setup>
// Secondary controls share the transcript's restrained outline vocabulary.
defineProps({ name: String })
const paths = {
  plus: 'M10 4v12M4 10h12',
  copy: 'M7 7h10v11H7ZM4 13H2V2h11v2',
  paste: 'M7 4H4v14h12V4h-3M7 2h6v4H7ZM7 10h6m-6 4h6',
  check: 'm4 10 4 4 8-8',
  folderPlus: 'M2.5 5h5l2 2h8v9h-15ZM10 9v5m-2.5-2.5h5',
  drive: 'M5 3h10l3 11v3H2v-3L5 3Zm-3 11h16M5 15.5h.01m3 0h.01',
  home: 'm2 9 8-7 8 7M4 7v11h12V7M8 18v-6h4v6',
  trash: 'M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6',
  back: 'M16 10H4m5-5-5 5 5 5',
  save: 'M4 3h10l3 3v11H3V3Zm3 0v5h6V3M6 17v-6h8v6',
  undo: 'M7 4 3 8l4 4M3 8h8a5 5 0 0 1 0 10',
  lock: 'M6 9V6a4 4 0 0 1 8 0v3M4 9h12v9H4Zm6 4v2',
  context: 'M3 5h14M3 10h9M3 15h12',
  tools: 'M12 3a4 4 0 0 0-4 5L3 13a2.1 2.1 0 0 0 3 3l5-5a4 4 0 0 0 5-5l-3 3-2-2 3-3-2-1Z',
  plugins: 'M7 3v4m6-4v4M5 7h10v3a5 5 0 0 1-10 0V7Zm5 8v3',
  document: 'M5 2.5h7l3 3v12H5Zm7 0v4h3M8 10h4M8 13h4',
  compact: 'M3 3h14M3 17h14M10 5v3m-3-2 3 3 3-3M10 15v-3m-3 2 3-3 3 3',
  image: 'M3 3h14v14H3Zm0 11 4-4 3 3 3-4 4 5M7 6h.01',
  refresh: 'M16 7a6 6 0 1 0 .2 5M16 3v4h-4',
  prompts: 'M5 3.5h10a1.5 1.5 0 0 1 1.5 1.5v12l-3-2-3 2-3-2-3 2V5A1.5 1.5 0 0 1 5 3.5ZM7 7h6M7 10h4',
  apply: 'M4 10h12m-5-5 5 5-5 5',
  edit: 'm12.5 4.5 3 3M4 16l3.5-.5L16 7a2.1 2.1 0 0 0-3-3l-8.5 8.5L4 16Z',
  close: 'm5 5 10 10M15 5 5 15',
  tasks: 'M4 5h12M4 10h7M4 15h7m3-3 3 3-3 3',
  quota: 'M4 15a7 7 0 1 1 12 0M10 10l4-4M7 16h6',
  memory: 'M5 5h10v10H5ZM8 8h4v4H8ZM7 2v3m6-3v3M7 15v3m6-3v3M2 7h3m-3 6h3m10-6h3m-3 6h3',
  clock: 'M10 6v4l3 2M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  fast: 'm11 2-7 9h5l-1 7 8-10h-6l1-6Z',
  queue: 'M3 5h11M3 10h6M3 15h6M17 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-4-2v2l1.5 1',
  sendNow: 'm4 4 9 6-9 6V4Zm12 0v12',
  chevron: 'm7 4 6 6-6 6',
  folder: 'M2.5 5h5l2 2h8v9h-15Z',
  terminal: 'm4 5 5 5-5 5m7 0h5',
  incoming: 'M15 4v6H5m4-4-4 4 4 4',
}
</script>

<template>
  <svg class="chrome-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name]" /></svg>
</template>

<style>
.chrome-icon { display: inline-block; width: 16px; height: 16px; flex: 0 0 16px; vertical-align: middle; }
</style>
