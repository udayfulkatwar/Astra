import { defineConfig } from 'tsup';

// Self-contained production bundle: internal workspace packages (TypeScript source) and all
// third-party dependencies are bundled into dist/main.js, so the runtime image needs only
// Node.js, dist/, config/ and the SQL migrations. The banner provides `require` for CommonJS
// dependencies inside the ESM bundle.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __astraCreateRequire } from 'node:module'; const require = __astraCreateRequire(import.meta.url);",
  },
});
