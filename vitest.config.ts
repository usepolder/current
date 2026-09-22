import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against core's source so `npm test` works on a fresh clone,
    // even though the published package entry points at the built lib/.
    alias: {
      '@usepolder/current-core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    env: { NO_COLOR: '1' },
  },
});
