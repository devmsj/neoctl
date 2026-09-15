import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const neoRuntimeTarget = process.env.VITE_NEO_RUNTIME_TARGET || 'http://127.0.0.1:3101'

export default defineConfig({
  base: process.env.NEO_WEB_BASE_PATH || "/",
  plugins: [vue()],
  server: {
    proxy: {
      '/api': neoRuntimeTarget,
      '/events': neoRuntimeTarget,
      '/vendor': neoRuntimeTarget,
    },
  },
})
