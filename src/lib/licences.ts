import type { LicenceVoucher } from '@imani/licence'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  parseVoucherToken,
  verifyVoucher,
  type SignedVoucherFields,
} from './voucherToken'

/**
 * Telling a licence from money, and holding the one that is current.
 *
 * A licence is a voucher (ADR 0007), delivered by the same gift-wrapped DM as
 * every coupon and landing in the same store. That is the hazard this module
 * exists for: nothing about a licence's SHAPE distinguishes it from a £40 coupon,
 * so a wallet that does not look would offer a subscription for spending and sum
 * its face value into a balance. The spec names the consequence — "a merchant
 * whose takings figure silently includes a subscription they bought is being told
 * something false about their business" — and the failure is silent in both
 * directions: the total is merely wrong, and the "coupon" only fails at the
 * counter, in front of a customer.
 *
 * ## The signal is the signed metadata, and it has to be
 *
 * A voucher carries three things that could mark it: the envelope the DM sender
 * writes, `memo`, and `merchant_metadata`.
 *
 * - **The envelope is out**, for the reason `voucherToken.ts` was written at all:
 *   NIP-17 tells you who sent a DM and nothing about whether their claims about
 *   the token inside it are true. A marker there is a marker anyone can set on
 *   anyone's coupon — and setting it makes that coupon vanish from a balance, so
 *   it is an unauthenticated way to make a merchant's money disappear from their
 *   own screen.
 * - **`memo` is out** because it is display text a merchant chooses freely. A
 *   stall selling "Annual subscription to the gym next door" would have their
 *   coupons silently demonetised by a substring match.
 * - **`merchant_metadata` is in**, because it is covered by the issuer's
 *   signature: `voucherCanonicalBytes` emits it as a `merchant_metadata` tag, so
 *   altering it after issuance breaks `verifyVoucher` and the DM path refuses the
 *   message outright. It is also where the spec already puts the subscription id
 *   ("A subscription id in `merchant_metadata` survives renewal and key loss"),
 *   so the marker rides with the identity rather than beside it.
 *
 * So the rule is: a voucher is a licence when the ISSUER SAID SO, inside the
 * bytes they signed. Only the issuer can demonetise their own voucher, which is
 * the only party who should be able to.
 *
 * ## Recognition does not mean verification
 *
 * This module answers "is this a licence, and which subscription is it for" —
 * never "does it unlock anything". That second question is `@imani/licence`'s,
 * and it needs a clock and a presenting key this module has neither of. Keeping
 * them apart matters for a specific reason: a licence whose signature is broken,
 * whose expiry has passed, or which is locked to a key we do not hold is STILL
 * not money, and must still be kept out of a balance. Folding verification in
 * here would make an expired subscription reappear as spendable value.
 */

/**
 * A licence's own fields, as the issuer signed them into `merchant_metadata`.
 *
 * snake_case because the issuer writes it, in the same register as every other
 * wire shape this app reads (`TokenTransferPayload`, `VoucherRow`).
 */
interface LicenceMetadata {
  /** Stable across renewals and re-issues. The thread support follows. */
  subscription_id?: unknown
  features?: unknown
  pilot?: unknown
  /**
   * The key the licence is locked to.
   *
   * Read from metadata because the wallet's parser reads a plain `VOUCHER`
   * secret, which carries no lock (see `LicenceVoucher.lockKey`). Absent today,
   * and `verifyLicence` REFUSES a voucher without one — so reading it here
   * widens what can be recognised, never what can be granted.
   */
  lock_key?: unknown
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function licenceMetadata(raw: string | null | undefined): LicenceMetadata | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as LicenceMetadata
  } catch {
    // `merchant_metadata` is a free-text field on an ordinary coupon — a merchant
    // name, or nothing at all. Unparseable is the common case, not an error.
    return null
  }
}

/**
 * The signed voucher, read as a licence, or null if it is not one.
 *
 * BOTH a subscription id and at least one feature are required. Either alone is
 * ambiguous: a merchant writing `{"features": [...]}` into their metadata for
 * some unrelated purpose would otherwise demonetise their own coupon, and an id
 * with no grant is not a thing we sell. Two fields together, in bytes the issuer
 * signed, is not something a coupon acquires by accident.
 */
export function licenceOf(signed: SignedVoucherFields): LicenceVoucher | null {
  const meta = licenceMetadata(signed.merchantMetadata)
  if (!meta) return null

  const subscriptionId = asString(meta.subscription_id)
  const features = asStrings(meta.features)
  if (!subscriptionId || features.length === 0) return null

  return {
    subscriptionId,
    issuerPublicKey: signed.issuerPublicKey,
    issuerSignature: signed.issuerSignature,
    lockKey: asString(meta.lock_key),
    expiresAt: signed.expiresAt,
    // The credential is its own receipt (ADR 0007): what was paid, and until
    // when, both read off the voucher rather than off a record we would have to
    // keep. This is the whole of "the customer can see what they paid".
    faceValue: signed.faceValue,
    faceUnit: signed.unit,
    features,
    pilot: meta.pilot === true,
  }
}

/**
 * The licence inside a cashu token, or null.
 *
 * Never throws. A token that is not a voucher — plain ecash — is not a licence,
 * and neither is one this parser cannot read; both are ordinary and must keep
 * flowing.
 */
export function licenceFromToken(token: string | undefined | null): LicenceVoucher | null {
  if (!token) return null
  try {
    return licenceOf(parseVoucherToken(token).voucher)
  } catch {
    return null
  }
}

/**
 * Parsed licences, keyed by the content-derived `token_id`.
 *
 * `spendable` runs on every render of the home screen, over every row the wallet
 * holds, and parsing a token is base64 + CBOR + a JSON parse. The key is
 * `sha256(token)` (spec 017), so an entry can never go stale: a different token
 * is a different id, and the same id is byte-identical input.
 *
 * Rows without a `token_id` are not cached — a row can reach here from a writer's
 * argument before the store derives one (`voucherRecords.ts` names that case),
 * and caching under a placeholder would collide every such row onto one answer.
 */
const parsedByTokenId = new Map<string, LicenceVoucher | null>()

/** Drop the parse cache. For tests. */
export function forgetLicenceParses(): void {
  parsedByTokenId.clear()
}

/**
 * The licence this row carries, or null if it carries money.
 *
 * Derived from the TOKEN every time rather than from a flag on the row. A stored
 * flag would be one more field to write correctly on every receive path — DM,
 * paste, restore from the relay, cashback — and the one path that forgot it would
 * put a subscription back into a balance with nothing to show it had. The token
 * is the same on every one of those paths, and it is signed.
 */
export function licenceIn(row: Pick<VoucherRow, 'token' | 'token_id'>): LicenceVoucher | null {
  const id = row.token_id
  if (!id) return licenceFromToken(row.token)

  const cached = parsedByTokenId.get(id)
  if (cached !== undefined) return cached

  const licence = licenceFromToken(row.token)
  parsedByTokenId.set(id, licence)
  return licence
}

/** Is this row a licence rather than money? */
export function isLicence(row: Pick<VoucherRow, 'token' | 'token_id'>): boolean {
  return licenceIn(row) !== null
}

/** A held licence, with the row it came from. */
export interface HeldLicence {
  licence: LicenceVoucher
  row: VoucherRow
}

/**
 * One licence per subscription, the latest expiry winning.
 *
 * No new store, and nothing deleted. Renewal mints a NEW voucher with a new
 * `voucher_id` and delivers it by DM, so a renewed stall holds two licence rows
 * for one subscription and the wallet must pick between them without the customer
 * doing anything — "a renewal needs no action from the customer" is the
 * requirement, and any flow with an Activate button fails it.
 *
 * Latest expiry rather than latest ARRIVAL, because arrival order is a relay's
 * choice: a delayed renewal landing after a re-delivery of the old voucher would
 * otherwise downgrade a paid-up stall. `expires_at` is signed; `created_at` is
 * whenever this device happened to write the row.
 *
 * Superseding rather than deleting is deliberate. The old voucher is still a
 * receipt for a year the customer paid for, and a store that erased it would
 * destroy the evidence on the customer's own device; it is already excluded from
 * every balance by `spendable`, so keeping it costs nothing but a row.
 */
export function heldLicences(rows: VoucherRow[]): HeldLicence[] {
  const bySubscription = new Map<string, HeldLicence>()

  for (const row of rows) {
    const licence = licenceIn(row)
    if (!licence) continue

    // Grouped by the SIGNED subscription id, which is the point of it existing:
    // "a customer's renewal keeps the same subscription identity, so a year of
    // renewals is one relationship". `voucher_id` changes on every renewal and
    // `lockKey` changes on a re-issue after key loss, so neither can group.
    const key = licence.subscriptionId
    if (!key) continue

    const held = bySubscription.get(key)
    // `>`, not `>=`. Two licences with the SAME expiry are the same entitlement
    // — a re-delivery of one voucher, which the relay does — and letting a tie
    // swap the winner would make this function's answer depend on row order.
    if (!held || expiryOf(licence) > expiryOf(held.licence)) {
      bySubscription.set(key, { licence, row })
    }
  }

  return [...bySubscription.values()]
}

/**
 * A licence with no expiry sorts BELOW every dated one.
 *
 * `verifyLicence` refuses a licence carrying no expiry rather than treating it as
 * eternal, so ranking one first would elect a voucher that can never grant
 * anything over one that can.
 */
function expiryOf(licence: LicenceVoucher): number {
  return typeof licence.expiresAt === 'number' && Number.isFinite(licence.expiresAt)
    ? licence.expiresAt
    : -Infinity
}

/**
 * Whether the issuer's signature over this licence holds.
 *
 * The `verifySignature` `@imani/licence` asks for, bound to the app's
 * canonicalizer. The package deliberately takes it as an injection so it needs
 * neither a crypto dependency nor the app's encoder; this is the wallet's half of
 * that arrangement, and it lives here rather than being written out at each call
 * site so there is one place to get it wrong.
 */
export function licenceSignatureVerifier(
  row: Pick<VoucherRow, 'token'>,
): (voucher: LicenceVoucher) => boolean {
  return () => {
    try {
      return verifyVoucher(parseVoucherToken(row.token).voucher).signatureValid
    } catch {
      return false
    }
  }
}
