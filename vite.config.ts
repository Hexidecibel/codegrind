import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      // The object form, rather than the bare target-string shorthand, for
      // `changeOrigin` alone. Vite normalises that shorthand to
      // `changeOrigin: true`, which REWRITES the Host header to the target
      // (localhost:9416) while leaving the browser's Origin as the dev server
      // (localhost:5173). src/server/cors.ts decides same-origin by comparing
      // those two, so the shorthand made every dev POST look cross-origin and
      // got it refused with a 403. `false` forwards Host untouched, which is
      // the truth of the matter: the browser only ever addressed the dev
      // server, and the proxy is the thing standing in for it.
      '/api': { target: 'http://localhost:9416', changeOrigin: false },
    },
  },
})
