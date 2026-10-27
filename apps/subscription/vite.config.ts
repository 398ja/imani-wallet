/**
 * subscription.imani.casa: the same stack as the wallet (React 19, Vite, Tailwind, react-router,
 * lucide), and the wallet's own UI components and theme, imported from ../../src rather than
 * copied, so the two sites cannot drift apart in look or behaviour.
 *
 *   npx vite --config apps/subscription/vite.config.ts           dev, API proxied to :8090
 *   npx vite build --config apps/subscription/vite.config.ts     -> apps/subscription/dist
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('.'),
  plugins: [react()],
  css: { postcss: { plugins: [tailwind({ config: r('./tailwind.config.js') }), autoprefixer()] } },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@imani/licence': r('../../packages/licence/src/index.ts'),
      '@wallet': r('../../src'),
    },
  },
  server: {
    port: 5180,
    proxy: { '/v1': process.env.SUBSCRIPTION_API ?? 'http://localhost:8090' },
  },
  build: { outDir: r('./dist'), emptyOutDir: true },
})
