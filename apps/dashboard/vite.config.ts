import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard talks to the API on the same origin (/api). In development Vite proxies to the
// local API; in production nginx does (infra/docker/nginx.conf). No API URL or token is baked
// into the bundle.
const API = process.env.ASTRA_API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/healthz': API,
      '/readyz': API,
    },
  },
  build: { sourcemap: true, target: 'es2022' },
});
