import type { SignedVoucherFields } from './voucherFields.js'
import type { LicenceVoucher } from './types.js'

/**
 * Reading a licence out of a signed voucher.
 *
 * Moved from `src/lib/licences.ts` (API ticket 09) so the wallet API can read
 * one too. That module cannot be imported by a Node service: it type-imports
 * `VoucherRow` from `@imani/wallet-storage`, and TypeScript loads the whole
 * module even for a type-only import — reaching `IDBDatabase`, a browser global
 * a Node project has no types for. Fifteen typecheck errors arrived that way.
 *
 * Reading is not deciding. `verifyLicence` still owns every question about what
 * a licence GRANTS; this only says what the issuer wrote.
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

