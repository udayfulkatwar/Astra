import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'research', include: ['test/**/*.test.ts'] },
});
