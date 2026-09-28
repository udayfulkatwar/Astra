import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'news', include: ['test/**/*.test.ts'] },
});
