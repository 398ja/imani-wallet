import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gandlaf21/bc-ur': '@gandlaf21/bc-ur/dist/lib/es6/index.js'
    }
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    minThreads: 1,
    maxThreads: 1,
    poolOptions: {
      threads: {
        singleThread: true
      }
    },
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/index.ts']
    }
  }
});
