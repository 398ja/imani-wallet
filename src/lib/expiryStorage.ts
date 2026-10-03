/**
 * Keep every stored coupon's `expires_at` in one format: epoch SECONDS (#157).
 *
 * Two halves, both wired by `openWallet`:
 *
 * - `normaliseExpiry` is the store's `normaliseVoucher` hook, so it runs inside
 *   every voucher writer. That covers every save point without touching any of
 *   them: DM receive and the keep token (`saveVoucher`), NIP-60 restore
 *   (`addRestoredVoucher`), imani-apps' tokenRedemption, which carries cashback
 *   redeem and every claimed link (`atomicallyWrite`), and import/backup restore
 *   (`clearAndReplaceAllVouchers`). A writer added later is covered too.
 *
 * - `migrateStoredExpiries` repairs rows written before this existed. Run on
 *   every open rather than gated by a flag: it is idempotent (a canonical row is
 *   left untouched, so a second run writes nothing) and a single cursor pass, so
 *   "every open" costs the same as "once" and needs no marker that could drift
 *   from the data. It is not an IndexedDB version bump on purpose: the same
 *   database is opened at version 2 by `createSharedDatabase` and the legacy
 *   bridge, and a bump would lock them out with a VersionError.
 *
 * A value that cannot be read is KEPT as it is and logged. Never erased, never
 * turned into "no expiry": that is exactly how the #157 coupon came to be spent
 * last. Spend order treats such a coupon as at risk and spends it first.
 */
import type { VoucherRow, WalletStorage } from '@imani/wallet-storage'
import { canonicalExpiresAt, readExpiry } from '@imani/wallet-core'

function warnUnreadable(row: VoucherRow, where: string): void {
  console.warn('[expiry] unreadable expires_at kept as it is', {
    where,
    voucher_id: row.voucher_id,
    token_id: row.token_id,
    expires_at: row.expires_at,
  })
}

/**
 * The row with `expires_at` in the stored format. The SAME object when nothing
 * changes, so a caller can tell a no-op by identity. An omitted field stays
 * omitted: the store's merge skips undefined, so a partial write never erases an
 * expiry already held.
 */
export function normaliseExpiry(row: VoucherRow): VoucherRow {
  if (!('expires_at' in row) || row.expires_at === undefined) return row
  const next = canonicalExpiresAt(row.expires_at)
  if (readExpiry(row.expires_at).kind === 'unreadable') warnUnreadable(row, 'write')
  return Object.is(next, row.expires_at) ? row : { ...row, expires_at: next as VoucherRow['expires_at'] }
}

export interface ExpiryMigrationResult {
  /** Rows whose stored expiry was rewritten into the canonical format. */
  rewritten: number
  /** Rows whose expiry could not be read, left exactly as they were. */
  unreadable: number
}

/**
 * Rewrite every stored `expires_at` into the canonical format.
 *
 * Safe with two tabs open at once and with writes landing meanwhile: the read
 * and the write of each row happen inside one IndexedDB readwrite transaction
 * (`rewriteVouchers`), which IndexedDB serialises against every other write to
 * the store. A concurrent `saveVoucher` therefore commits either before this
 * pass, which then sees it, or after, landing on the repaired row. Never a
 * stale copy written over it.
 */
export async function migrateStoredExpiries(store: WalletStorage): Promise<ExpiryMigrationResult> {
  let unreadable = 0
  const rewritten = await store.rewriteVouchers((row) => {
    if (row.expires_at === undefined) return null
    if (readExpiry(row.expires_at).kind === 'unreadable') {
      unreadable += 1
      warnUnreadable(row, 'migration')
      return null
    }
    const next = normaliseExpiry(row)
    return next === row ? null : next
  })
  if (rewritten > 0) console.info('[expiry] stored expiries repaired', { rewritten })
  return { rewritten, unreadable }
}
