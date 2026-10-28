/**
 * gifting.imani.casa (#410): buy a stall's voucher by card, for yourself, a handle or an email.
 *
 * Same stack as the wallet and as apps/subscription: React 19, Vite, Tailwind, react-router,
 * lucide, and the wallet's own UI components and theme imported from ../../src (never copied).
 *
 *   npx vite --config apps/gifting/vite.config.ts           dev, API proxied to the wallet stack
 *   npx vite build --config apps/gifting/vite.config.ts     -> apps/gifting/dist
 *
 * Its own origin (G0). The key never lives here: signed-in buyers sign through the wallet origin's
 * cross-origin signer (NAP extension 0002, G10).
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const imani = (name: string) => r(`../../packages/${name}/src/index.ts`)
const WORKSPACE = [
  'wallet-storage', 'nostr-vouchers', 'nostr-transactions', 'wallet-balance', 'voucher-send', 'profile-service',
  'blossom-upload', 'gateway-client', 'dm-poll', 'money', 'wallet-core', 'licence', 'merchant-record', 'redemption',
  'reports', 'payment-requests',
]

const API = process.env.GIFTING_API ?? 'http://localhost:28082'

export default defineConfig({
  root: r('.'),
  base: process.env.GIFTING_BASE ?? '/',
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
    port: 5181,
    // COOP must allow the signer popup to keep its opener (NAP 0002): never `same-origin`.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' },
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  build: { outDir: r('./dist'), emptyOutDir: true },
})
