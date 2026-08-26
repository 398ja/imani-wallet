import { defineConfig } from 'tsup';

export default defineConfig([
  // Node.js builds (ESM + CJS)
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
  },
  // Browser bundle (IIFE) for vanilla JS <script> tags
  {
    entry: { 'money.browser': 'src/index.ts' },
    format: ['iife'],
    globalName: 'ImaniMoney',
    sourcemap: true,
    target: 'es2022',
    minify: true,
    outDir: 'dist',
  },
]);
