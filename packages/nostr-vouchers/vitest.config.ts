import { defineConfig } from 'vitest/config';

import { imaniAliases } from '../../vitest.aliases';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      // Sibling packages are consumed from source, so this suite has to
      // resolve them the same way the app does. The local `@` mapping below
      // was here already and is kept.
      ...imaniAliases,
      '@': './src',
    },
  },
});
