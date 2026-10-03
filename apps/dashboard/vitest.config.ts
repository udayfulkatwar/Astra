import { defineProject } from 'vitest/config';

export default defineProject({
  define: { __ASTRA_DEMO__: 'false' },
  test: {
    name: 'dashboard',
    include: ['src/**/*.test.{ts,tsx}'],
    // jsdom: the operator-flow tests render real pages; the pure helper tests run there too.
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
});
