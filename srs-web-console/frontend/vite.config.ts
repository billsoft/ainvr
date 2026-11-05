
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    // dev 阶段把 BFF 与 SRS 拉流代理到同源，规避跨域（生产由 nginx 反代）
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/live': 'http://127.0.0.1:8080',
    },
  },
  test: {
    environment: 'jsdom',
    // Let jsdom own browser Storage; Node 26's native globals otherwise mask
    // its per-window storage when no --localstorage-file was supplied.
    execArgv: ['--no-experimental-webstorage'],
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
})
