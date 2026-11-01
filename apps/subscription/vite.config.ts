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
const imani = (name: string) => r(`../../packages/${name}/src/index.ts`)
// Same workspace packages the wallet aliases (vite.config.ts at the root): the wallet components
// used here (IdentityInline, Avatar) reach them through src/lib.
const WORKSPACE = [
  'wallet-storage', 'nostr-vouchers', 'nostr-transactions', 'wallet-balance', 'voucher-send', 'profile-service',
  'blossom-upload', 'gateway-client', 'dm-poll', 'money', 'wallet-core', 'licence', 'merchant-record', 'redemption',
  'reports', 'payment-requests',
]

export default defineConfig({
  root: r('.'),
  // Its own origin, subscription.imani.casa (#411). The wallet opens it and signs its login over
  // postMessage, so nothing needs to share the wallet's origin any more. SUBSCRIPTION_BASE mounts it
  // under a path if a deployment needs that (the service's SUBSCRIPTION_BASE_PATH must match).
  base: process.env.SUBSCRIPTION_BASE ?? '/',
  envDir: r('../..'),
  plugins: [react()],
  css: { postcss: { plugins: [tailwind({ config: r('./tailwind.config.js') }), autoprefixer()] } },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      ...Object.fromEntries(WORKSPACE.map((n) => [`@imani/${n}`, imani(n)])),
      'imani-qr': imani('imani-qr'),
      '@wallet': r('../../src'),
      '@': r('../../src'),
    },
  },
  server: {
    port: 5180,
    proxy: { [`${(process.env.SUBSCRIPTION_BASE ?? '/').replace(/\/+$/, '')}/v1`]: process.env.SUBSCRIPTION_API ?? 'http://localhost:8090' },
  },
  build: { outDir: r('./dist'), emptyOutDir: true },
})
