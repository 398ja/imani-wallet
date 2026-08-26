import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
      js: '/* @imani/nostr-transactions - Transaction management for Nostr */',
    };
  },
});
