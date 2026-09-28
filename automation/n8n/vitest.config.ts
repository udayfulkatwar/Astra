import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'n8n', include: ['test/**/*.test.ts'] },
});
