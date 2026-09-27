import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'prop-firm', include: ['test/**/*.test.ts'] },
});
