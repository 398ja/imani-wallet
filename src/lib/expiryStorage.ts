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
 *   every open rather than gated by a flag that could drift from the data, but
 *   cheaply: a read-only scan decides whether anything needs repair, and only
 *   then does the idempotent readwrite cursor pass run. A repaired wallet pays
 *   one getAll per open and never takes the store's write lock for it. It is
 *   not an IndexedDB version bump on purpose: the same
 *   database is opened at version 2 by `createSharedDatabase` and the legacy
 *   bridge, and a bump would lock them out with a VersionError.
 *
 * A value that cannot be read is KEPT as it is and logged. Never erased, never
 * turned into "no expiry": that is exactly how the #157 coupon came to be spent
 * last. Spend order treats such a coupon as at risk and spends it first.
 */
import type { VoucherRow, WalletStorage } from '@imani/wallet-storage'
import { canonicalExpiresAt, readExpiry } from '@imani/wallet-core'

import { parseVoucherToken } from './voucherToken'

function warnUnreadable(row: VoucherRow, where: string): void {
  console.warn('[expiry] unreadable expires_at kept as it is', {
    where,
    voucher_id: row.voucher_id,
    token_id: row.token_id,
    expires_at: row.expires_at,
  })
}

/**
 * The expiry the issuer SIGNED into the coupon's own token, in epoch seconds,
 * or undefined when the token carries none or is not a voucher token.
 *
 * The authority when the stored copy is unreadable: the stored value is only a
 * cache of what /inspect or a DM said about this token, and the signed tag is
 * what the mint enforces.
 */
function signedExpiry(row: VoucherRow): number | undefined {
  if (!row.token) return undefined
  try {
    const seconds = parseVoucherToken(row.token).voucher.expiresAt
    return seconds !== undefined && readExpiry(seconds).kind === 'at' ? seconds : undefined
  } catch {
    return undefined
  }
}

/**
 * What `expires_at` should be stored as for this row, and whether the value
 * given is beyond repair. Readable values become epoch seconds; an unreadable
 * one is replaced by the token's signed expiry when there is one, and
 * otherwise kept exactly as it was.
 */
function canonicalFor(row: VoucherRow): { value: unknown; unreadable: boolean } {
  if (readExpiry(row.expires_at).kind !== 'unreadable') {
    return { value: canonicalExpiresAt(row.expires_at), unreadable: false }
  }
  const signed = signedExpiry(row)
  return signed === undefined
    ? { value: row.expires_at, unreadable: true }
    : { value: signed, unreadable: false }
}

/**
 * The row with `expires_at` in the stored format. The SAME object when nothing
 * changes, so a caller can tell a no-op by identity. An omitted field stays
 * omitted: the store's merge skips undefined, so a partial write never erases an
 * expiry already held.
 */
export function normaliseExpiry(row: VoucherRow): VoucherRow {
  if (!('expires_at' in row) || row.expires_at === undefined) return row
  const { value, unreadable } = canonicalFor(row)
  if (unreadable) warnUnreadable(row, 'write')
  return Object.is(value, row.expires_at) ? row : { ...row, expires_at: value as VoucherRow['expires_at'] }
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
 *
 * Only `expires_at` is ever changed: the replacement row is the stored row
 * spread with that one field, and the store pins the primary key.
 */
export async function migrateStoredExpiries(store: WalletStorage): Promise<ExpiryMigrationResult> {
  // A read-only look first. Once repaired, a wallet never needs the pass again,
  // and a readwrite cursor over the whole store would hold the store's write
  // lock on every open: measured on fake-indexeddb, 1000 rows cost ~25 ms as a
  // no-op readwrite pass against ~9 ms for this read, and a write from another
  // tab (a DM arriving) would queue behind it. The read decides only WHETHER to
  // run; which rows change is decided again inside the readwrite transaction,
  // against the row as it is then, so nothing read here can be written stale.
  const pending = (await store.getAllVouchers())
    .filter((row) => row.expires_at !== undefined)
    .map((row) => ({ row, next: canonicalFor(row) }))
  if (pending.every(({ row, next }) => Object.is(next.value, row.expires_at))) {
    const stuck = pending.filter(({ next }) => next.unreadable)
    for (const { row } of stuck) warnUnreadable(row, 'migration')
    return { rewritten: 0, unreadable: stuck.length }
  }

  let unreadable = 0
  const rewritten = await store.rewriteVouchers((row) => {
    if (row.expires_at === undefined) return null
    const { value, unreadable: stuck } = canonicalFor(row)
    if (stuck) {
      unreadable += 1
      warnUnreadable(row, 'migration')
      return null
    }
    return Object.is(value, row.expires_at)
      ? null
      : { ...row, expires_at: value as VoucherRow['expires_at'] }
  })
  if (rewritten > 0) console.info('[expiry] stored expiries repaired', { rewritten })
  return { rewritten, unreadable }
}
