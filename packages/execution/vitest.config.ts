import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'execution', include: ['test/**/*.test.ts'] },
});
