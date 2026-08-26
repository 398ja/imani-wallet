import { defineConfig } from 'tsup';

export default defineConfig([
  // Node.js builds (ESM + CJS) — consumed by other packages and by Node test runners.
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: 'es2020',
    outDir: 'dist',
    external: ['@imani/nostr-vouchers'],
  },
  // Browser bundle (IIFE) — exposes `WalletStorage` global for the
  // vanilla-JS bridge `shared/walletStorageIntegration.js` to consume
  // via `window.WalletStorage`. Mirrors the pattern used by
  // `packages/nostr-vouchers` for its IIFE bundle.
  {
    entry: { 'wallet-storage.browser': 'src/index.ts' },
    format: ['iife'],
    globalName: 'WalletStorage',
    splitting: false,
    sourcemap: true,
    treeshake: true,
    minify: true,
    target: 'es2020',
    outDir: 'dist',
    // The IIFE bundle does NOT externalize @imani/nostr-vouchers — but it
    // doesn't import from it either (the package's public surface defines
    // its own StoreDefinition shape; only the shared-database consumer
    // needs the cross-package handoff). So nothing to bundle in here.
    noExternal: [],
  },
]);
