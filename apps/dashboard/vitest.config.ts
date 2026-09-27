import { defineProject } from 'vitest/config';

export default defineProject({
  define: { __ASTRA_DEMO__: 'false' },
  test: { name: 'dashboard', include: ['src/**/*.test.ts'], environment: 'node' },
});
