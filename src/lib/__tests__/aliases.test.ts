/**
 * Smoke test for the source-aliasing scheme in vite.config.ts.
 *
 * Nine imani-apps packages and five nap packages are consumed straight from
 * their TypeScript sources rather than built dist bundles. That saves a build
 * step but means any transitive-import assumption a package makes about its own
 * node_modules layout blows up here instead of at runtime. Importing each entry
 * point is the cheapest way to find that out.
 */
import { describe, it, expect } from 'vitest'

const entrypoints = {
  '@imani/money': () => import('@imani/money'),
  '@imani/nostr-vouchers': () => import('@imani/nostr-vouchers'),
  '@imani/wallet-storage': () => import('@imani/wallet-storage'),
  '@imani/wallet-balance': () => import('@imani/wallet-balance'),
  '@imani/nostr-transactions': () => import('@imani/nostr-transactions'),
  '@imani/voucher-send': () => import('@imani/voucher-send'),
  '@imani/profile-service': () => import('@imani/profile-service'),
  '@imani/gateway-client': () => import('@imani/gateway-client'),
  // NOT the 'imani-qr' barrel. The barrel re-exports nut16 (animated QR), whose
  // @gandlaf21/bc-ur dependency ships a CJS build that does require('cborg') —
  // and cborg 4.5.8 is ESM-only, with no "require" condition in its exports. So
  // the barrel cannot load under Node/vitest.
  //
  // This is a test-environment limitation, not a real one: `vite build` resolves
  // the "import" condition and bundles the barrel fine (verified — 79 modules,
  // qr-scanner worker emitted). The app imports the barrel normally. We import
  // the two subpaths the wallet actually uses so this check still fails loudly
  // if the scan/pay path breaks, without tripping over dead animated-QR code.
  'imani-qr/detector': () =>
    import('../../../packages/imani-qr/src/detector/index'),
  'imani-qr/handlers': () =>
    import('../../../packages/imani-qr/src/handlers/index'),
  '@imani/nap-core': () => import('@imani/nap-core'),
  '@imani/nap-client-http': () => import('@imani/nap-client-http'),
  '@imani/nap-client-web': () => import('@imani/nap-client-web'),
  '@imani/nap-react': () => import('@imani/nap-react'),
}

describe('package aliases resolve from source', () => {
  for (const [name, load] of Object.entries(entrypoints)) {
    it(`loads ${name}`, async () => {
      const mod = await load()
      expect(Object.keys(mod).length).toBeGreaterThan(0)
    })
  }
})
