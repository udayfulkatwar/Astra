import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    include: ['test/**/*.test.ts'],
    // Integration tests share one Postgres server; each file uses its own schema.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
