/**
 * The wallet's reader for voucher ledger v2 (#310): what the public ledger says about one voucher.
 *
 * Kept apart from `voucherLedgerV2.ts` so the codec stays pure (no relay), which is what lets the
 * parity test replay the Java vectors without mocks.
 */
import { allowedIssuerKeys } from './issuerAllowlist'
import { eventsByDTag, GatewayUnreachableError, MAX_LEDGER_EVENTS } from './relay'
import { LEDGER_V2_KIND, locator, resolve, voucherRef, type Resolved } from './voucherLedgerV2'

/**
 * Fetch every event at the voucher's locator and fold them (`resolve`). Null when nothing at the
 * address is accepted. Throws when `issuerId`/`voucherId` are not valid ledger inputs, and
 * `GatewayUnreachableError` when the gateway did not answer: "unreachable" must never read as
 * "no record".
 *
 * `trustedIssuerKeys` are the keys allowed to sign ISSUED besides the stall. The gateway signs
 * ISSUED with the platform voucher-signing key, the same key it signs the vouchers themselves with
 * (gateway-customer `VoucherLedgerV2Publisher`), so the default is this build's issuer allowlist,
 * `VITE_VOUCHER_ISSUER_PUBKEYS`: one list says which platform keys a coupon and its ledger entry
 * may come from. With the allowlist unset, only the stall's own events are accepted, so a
 * gateway-signed ISSUED reads as no entry rather than being trusted from an unknown key.
 */
export async function readVoucherLedgerStatus(
  issuerId: string,
  voucherId: string,
  trustedIssuerKeys: readonly string[] = allowedIssuerKeys(),
): Promise<Resolved | null> {
  const ref = voucherRef(issuerId, voucherId)
  const events = await eventsByDTag(LEDGER_V2_KIND, locator(ref))
  // eventsByDTag already throws above MAX_LEDGER_EVENTS; checked again so a cap is never a truncation.
  if (events.length > MAX_LEDGER_EVENTS) throw new GatewayUnreachableError(`more than ${MAX_LEDGER_EVENTS} ledger events`)
  return resolve(events, ref, trustedIssuerKeys)
}
