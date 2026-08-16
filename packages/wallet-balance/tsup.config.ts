import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library (ESM + CJS)
  {
    entry: {
      index: 'src/index.ts',
      'integrations/index': 'src/integrations/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    splitting: false,
    treeshake: true,
  },
  // Browser bundle (IIFE)
  {
    entry: {
      'wallet-balance.browser': 'src/index.ts',
    },
    format: ['iife'],
    globalName: 'ImaniWalletBalance',
    sourcemap: true,
    target: 'es2022',
    minify: false,
  },
]);
