import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to @social/api's Fastify server (default port 4000,
// see packages/api/src/dev.ts and the root README's dev command) so the UI
// can call same-origin relative paths in both dev and prod.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.SOCIAL_API_URL ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
});
