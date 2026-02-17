import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@promptwheel/core/services': path.resolve(__dirname, 'packages/core/src/services/index.ts'),
      '@promptwheel/core/repos': path.resolve(__dirname, 'packages/core/src/repos/index.ts'),
      '@promptwheel/core/scout': path.resolve(__dirname, 'packages/core/src/scout/index.ts'),
      '@promptwheel/core/db': path.resolve(__dirname, 'packages/core/src/db/index.ts'),
      '@promptwheel/core/utils': path.resolve(__dirname, 'packages/core/src/utils/index.ts'),
      '@promptwheel/core/exec': path.resolve(__dirname, 'packages/core/src/exec/index.ts'),
      '@promptwheel/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@promptwheel/sqlite': path.resolve(__dirname, 'packages/sqlite/src/index.ts'),
    },
  },
  test: {
    testTimeout: 30000,
    include: ['packages/*/src/test/**/*.test.ts'],
  },
});
