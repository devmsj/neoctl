import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url))

// Deliberately independent of the main Web config and engine build hooks.
export default defineConfig({
  root: here('./'),
  base: '/viewer/',
  publicDir: false,
  plugins: [vue()],
  build: {
    outDir: here('../control/viewer-dist/'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: here('./control-viewer.html') },
  },
})
