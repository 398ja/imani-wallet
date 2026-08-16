import { defineConfig } from 'tsup';

export default defineConfig([
  // Node.js builds (ESM + CJS) — consumed by other packages and by Node test runners
  // (vitest in this package, vitest in imani-apps, and POSSA Merchant's build pipeline).
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
    external: [],
  },
  // Browser bundle (IIFE) — exposes `BlossomUpload` global for the vanilla-JS
  // bridge `shared/blossomUploadIntegration.js` to consume via
  // `window.BlossomUpload`. Mirrors the pattern used by other @imani packages
  // that ship a browser-loadable surface alongside the Node module.
  {
    entry: { 'blossom-upload.browser': 'src/index.ts' },
    format: ['iife'],
    globalName: 'BlossomUpload',
    splitting: false,
    sourcemap: true,
    treeshake: true,
    minify: true,
    target: 'es2020',
    outDir: 'dist',
    // @noble/hashes is bundled into the IIFE — no external in the browser variant.
    noExternal: ['@noble/hashes'],
  },
]);
