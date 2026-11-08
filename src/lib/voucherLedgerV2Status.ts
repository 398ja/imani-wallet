/**
 * The wallet's reader for voucher ledger v2 (#310): what the public ledger says about one voucher.
 *
 * Kept apart from `voucherLedgerV2.ts` so the codec stays pure (no relay), which is what lets the
 * parity test replay the Java vectors without mocks.
 */
import { eventsByDTag } from './relay'
import { LEDGER_V2_KIND, locator, resolve, voucherRef, type Resolved } from './voucherLedgerV2'

/**
 * Fetch every event at the voucher's locator and fold them (`resolve`). Null when nothing at the
 * address is accepted. `trustedIssuerKeys` are the keys allowed to sign ISSUED besides the stall
 * (the platform voucher-signing key). Throws when `issuerId`/`voucherId` are not valid ledger
 * inputs, and `GatewayUnreachableError` when the gateway did not answer: "unreachable" must never
 * read as "no record".
 */
export async function readVoucherLedgerStatus(
  issuerId: string,
  voucherId: string,
  trustedIssuerKeys: readonly string[],
): Promise<Resolved | null> {
  const ref = voucherRef(issuerId, voucherId)
  const events = await eventsByDTag(LEDGER_V2_KIND, locator(ref))
  return resolve(capCandidates(events), ref, trustedIssuerKeys)
}

/** Most candidate events folded per locator, matching the Java reader (cashu-voucher#66). */
export const MAX_LEDGER_CANDIDATES = 256

/**
 * Deterministic cap: sort by `created_at` then `id` (both ascending) and keep the first
 * `MAX_LEDGER_CANDIDATES`, so the same relay set always folds the same way.
 */
export function capCandidates<T extends { created_at: number; id: string }>(events: readonly T[]): T[] {
  return [...events]
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_LEDGER_CANDIDATES)
}
