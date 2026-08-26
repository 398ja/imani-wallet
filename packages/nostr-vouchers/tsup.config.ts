import { defineConfig } from 'tsup';

export default defineConfig([
  // Node.js builds (ESM and CJS)
  {
    entry: ['src/index.ts', 'src/database/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    external: ['nostr-tools'],
    esbuildOptions(options) {
      options.banner = {
        js: '/* @imani/nostr-vouchers - Voucher management for Nostr */',
      };
    },
  },
  // Browser bundle (IIFE with bundled dependencies)
  {
    entry: { 'nostr-vouchers.browser': 'src/index.ts' },
    format: ['iife'],
    globalName: 'NostrVouchers',
    splitting: false,
    sourcemap: true,
    treeshake: true,
    minify: true,
    noExternal: ['nostr-tools'],
    platform: 'browser',
    esbuildOptions(options) {
      options.banner = {
        js: '/* @imani/nostr-vouchers - Browser bundle */',
      };
    },
  },
]);