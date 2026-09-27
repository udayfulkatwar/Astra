import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
