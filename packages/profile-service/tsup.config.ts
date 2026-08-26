import { defineConfig } from 'tsup';

export default defineConfig([
  // ESM and CJS builds
  {
    entry: {
      index: 'src/index.ts',
      'types/index': 'src/types/index.ts',
      'adapters/index': 'src/adapters/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['@imani/nostr-app-storage', 'nostr-tools'],
  },
  // Browser bundle (IIFE with bundled dependencies)
  {
    entry: { 'profile-service.browser': 'src/index.ts' },
    format: ['iife'],
    globalName: 'ImaniProfileService',
    outExtension: () => ({ js: '.global.js' }),
    noExternal: ['nostr-tools'],
    platform: 'browser',
    minify: true,
    sourcemap: true,
  },
]);
