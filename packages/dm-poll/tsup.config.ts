import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library (ESM + CJS)
  {
    entry: {
      index: 'src/index.ts',
      'adapters/index': 'src/adapters/index.ts',
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
      'dm-poll.browser': 'src/index.ts',
    },
    format: ['iife'],
    globalName: 'ImaniDmPoll',
    sourcemap: true,
    target: 'es2022',
    minify: false,
  },
]);
