import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // 允許用任何網域（例如 Cloudflare Tunnel 配發的網址）存取這個 dev server，
    // 預設 Vite 只信任 localhost/區網 IP，外部網域會被擋下（DNS rebinding 防護）
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', xfwd: true },
      '/auth': { target: 'http://localhost:4000', xfwd: true },
      '/health': { target: 'http://localhost:4000', xfwd: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, xfwd: true },
    },
  },
})
