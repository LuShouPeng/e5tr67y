import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // 开发期同源代理：前端只用相对路径 /api，避免 CORS 与跨域 cookie 的额外心智
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    // React 只在非 production 构建里导出 act（测试工具依赖它）。
    // 宿主的 NODE_ENV 可能是 production（CI/容器里很常见），这里显式钉住。
    env: { NODE_ENV: 'test' },
  },
});
