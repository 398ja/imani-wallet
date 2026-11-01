/**
 * The `@imani/*` aliases, in one place so a package suite and the app agree.
 *
 * These packages are consumed from SOURCE, never from a built `dist/`, so
 * every config that runs their tests needs the same mapping. The app's own
 * vite.config.ts carries a longer list including the `@nostr/*` aliases and
 * the single-React pinning; this file is only the workspace-internal packages,
 * which is all a package's own test run needs to resolve its siblings.
 *
 * Without it, `packages/*\/vitest.config.ts` resolved `@imani/money` against
 * node_modules, found nothing, and nine test files failed to load with
 * "Cannot find package '@imani/money'" — while the same specifier worked
 * perfectly in the app.
 */

import { fileURLToPath } from 'node:url'

/** Absolute path to a package's source entry point. */
const src = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

/**
 * Every workspace package that another package may import.
 *
 * Kept as a plain map rather than derived from the filesystem: an alias that
 * silently appears because a directory was created is harder to reason about
 * than one somebody added deliberately.
 */
export const imaniAliases = {
  '@imani/money': src('money'),
  '@imani/wallet-core': src('wallet-core'),
  '@imani/wallet-storage': src('wallet-storage'),
  '@imani/wallet-balance': src('wallet-balance'),
  '@imani/nostr-transactions': src('nostr-transactions'),
  '@imani/nostr-vouchers': src('nostr-vouchers'),
  '@imani/voucher-send': src('voucher-send'),
  '@imani/profile-service': src('profile-service'),
  '@imani/blossom-upload': src('blossom-upload'),
  '@imani/gateway-client': src('gateway-client'),
  '@imani/dm-poll': src('dm-poll'),
  '@imani/licence': src('licence'),
  '@imani/merchant-record': src('merchant-record'),
  '@imani/redemption': src('redemption'),
  '@imani/reports': src('reports'),
  '@imani/payment-requests': src('payment-requests'),
  // Unscoped on purpose: this package is published as `imani-qr`, not
  // `@imani/qr`, and that is the specifier the app imports.
  'imani-qr': src('imani-qr'),
} as const
