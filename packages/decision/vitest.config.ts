import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'decision', include: ['test/**/*.test.ts'] },
});
