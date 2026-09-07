import { defineConfig } from 'vitest/config';

import { imaniAliases } from '../../vitest.aliases';

/**
 * dm-poll had no config at all, so its `tests/` directory never ran — three
 * files including DmPollService.test.ts, the suite for the service that
 * redeems every incoming coupon.
 *
 * That mattered beyond the missing coverage: a test added beside the code it
 * covers read as passing while executing nothing. This config is how the whole
 * orphaned-suite problem was found.
 *
 * `src/**` is deliberately NOT included here — the root vite.config.ts already
 * collects `packages/**\/src/**\/*.test.ts`, and listing it in both would run
 * those files twice.
 */
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
  // Matches how the app resolves siblings, so a future import here behaves the
  // same in this suite as it does in the app.
  resolve: { alias: { ...imaniAliases } },
});
