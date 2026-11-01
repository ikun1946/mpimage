import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// 版本号只在 web/package.json 里维护一处，构建时注入为 __APP_VERSION__，
// 反馈上报的客户端版本因此不会和安装包版本走散。
const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))

export default defineConfig({
  root: '.',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    // 0.0.0.0 = 允许局域网设备访问开发服务器
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    open: false,
    proxy: {
      // 局域网设备直连前端时，API 转发给本机后端（前端 API_BASE 为同源相对路径）
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        batch: 'batch.html',
        login: 'login.html',
      },
    },
  },
})
