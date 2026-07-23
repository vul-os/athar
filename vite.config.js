import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // The dev server proxies to the Go backend so the dashboard runs against
      // real data (and real session cookies) without a CORS shim.
      '/api': { target: 'http://localhost:3100', changeOrigin: true },
      '/athar.js': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep upstream licence banners (@license / @preserve / /*!) instead of
    // stripping every comment while minifying. The authoritative attribution is
    // THIRD-PARTY-NOTICES.txt; this is a courtesy on top of it.
    rollupOptions: { output: { comments: { legal: true } } },
  },
})
