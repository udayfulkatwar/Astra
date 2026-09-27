import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard talks to the API on the same origin (/api). In development Vite proxies to the
// local API; in production nginx does (infra/docker/nginx.conf). No API URL or token is baked
// into the bundle. `--mode demo` builds a self-contained demo that runs the real engines in the
// browser on simulated data (see src/demo).
const API = process.env.ASTRA_API_PROXY_TARGET ?? 'http://localhost:8080';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __ASTRA_DEMO__: JSON.stringify(mode === 'demo') },
  // Relative asset paths so the demo can be served from any location.
  base: mode === 'demo' ? './' : '/',
  server: {
    port: 5173,
    // The demo bundles the repository's config/ YAML templates.
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/healthz': API,
      '/readyz': API,
    },
  },
  build: {
    sourcemap: mode !== 'demo',
    target: 'es2022',
    // One JavaScript file for the demo so it can be inlined into a single page.
    ...(mode === 'demo' ? { rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
  },
}));
