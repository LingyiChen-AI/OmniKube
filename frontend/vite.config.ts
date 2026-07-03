import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发期把 API 与 WebSocket 同源代理到后端，避免 CORS / 跨源 ws。
      '/api': { target: 'http://localhost:8080', changeOrigin: true, ws: true },
      '/healthz': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    // userEvent types char-by-char; slower CI runners can exceed the 5s default
    // on form-heavy tests. Raise the ceiling so they don't flake.
    testTimeout: 20000,
  },
});
