import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'journal', include: ['test/**/*.test.ts'] },
});
