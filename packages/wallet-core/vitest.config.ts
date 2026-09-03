import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // The TYPE file, not the package index — the index pulls in adapters and
      // resolvers this package has no use for. Mirrors tsconfig.json.
      '@imani/voucher-send': r('../voucher-send/src/types/voucher.ts'),
    },
  },
  test: {
    // node, not jsdom. If a DOM ever becomes necessary to run these, something
    // browser-shaped has been let into the package and the test environment
    // should be the thing that objects.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
