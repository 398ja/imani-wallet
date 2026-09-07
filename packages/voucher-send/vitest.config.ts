import { defineConfig } from 'vitest/config';

import { imaniAliases } from '../../vitest.aliases';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
  // Sibling packages are consumed from source, so this suite has to resolve
  // them the same way the app does. Without it every file here failed to load
  // on "Cannot find package '@imani/money'".
  resolve: { alias: { ...imaniAliases } },
});
