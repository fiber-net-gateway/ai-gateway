import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  // Keep the production bundle portable when served from a repository subpath.
  base: './',
  resolve: {
    alias: {
      '@ai-gateway/i18n': fileURLToPath(new URL('./src/i18n', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
