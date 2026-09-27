import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'risk', include: ['test/**/*.test.ts'] },
});
