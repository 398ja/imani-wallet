import { defineConfig } from 'tsup';

export default defineConfig([
  // Node.js builds (ESM and CJS)
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    splitting: false,
    minify: false
  },
  // Browser build (ESM for script type="module" usage)
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'dist',
    outExtension: () => ({ js: '.browser.js' }),
    sourcemap: true,
    target: 'es2020',
    splitting: false,
    minify: true,
    // Bundle all dependencies for browser. `buffer` is a Node built-in that
    // esbuild leaves as a bare specifier unless we alias it to the userland
    // polyfill (the npm package literally named `buffer`). Without this the
    // resulting bundle has `from"buffer"` lines that the browser rejects
    // with "bare specifier was not remapped" — see imani-qr.js:98 crash.
    noExternal: ['qr-scanner', '@gandlaf21/bc-ur', 'buffer'],
    esbuildOptions(options) {
      options.alias = {
        ...(options.alias || {}),
        buffer: 'buffer/'
      };
      // BC-UR's buffer polyfill chain expects a `global` identifier; map it
      // to the browser equivalent so the bundle is fully self-contained.
      options.define = {
        ...(options.define || {}),
        global: 'globalThis'
      };
    }
  }
]);
