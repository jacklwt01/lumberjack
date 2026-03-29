import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/gamma': { target: 'https://gamma-api.polymarket.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/gamma/, '') },
      '/api/data': { target: 'https://data-api.polymarket.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/data/, '') },
      '/api/alerts': { target: 'http://127.0.0.1:3847', changeOrigin: true },
    },
  },
})
