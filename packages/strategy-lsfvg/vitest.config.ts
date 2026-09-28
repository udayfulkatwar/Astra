import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'strategy-lsfvg', include: ['test/**/*.test.ts'] },
});
