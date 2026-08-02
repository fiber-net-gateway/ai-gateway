import { defineConfig } from 'vite'

export default defineConfig({
  // Keep the production bundle portable when served from a repository subpath.
  base: './',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
