import type { SignedVoucherFields } from './voucherFields.js'
import type { LicenceLimits, LicenceVoucher, SalesPeriod } from './types.js'

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
  tier?: unknown
  valid_from?: unknown
  limits?: unknown
  grant_kind?: unknown
}

const SALES_PERIODS: readonly SalesPeriod[] = ['lifetime', 'month', 'window']

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * The signed limits, read STRICTLY. Anything malformed is dropped rather than guessed at, and the
 * one shape that means "unlimited" is an explicit `null`. A garbled amount must never read as
 * "no cap", so a limit we cannot read is absent, which leaves the stall at whatever else grants it.
 */
function asLimits(value: unknown): LicenceLimits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as { sales?: unknown; terminals?: unknown }
  const out: LicenceLimits = {}

  if (raw.terminals === null) out.terminals = null
  else {
    const t = asCount(raw.terminals)
    if (t !== undefined) out.terminals = t
  }

  if (raw.sales === null) out.sales = null
  else if (raw.sales && typeof raw.sales === 'object' && !Array.isArray(raw.sales)) {
    const s = raw.sales as { period?: unknown; amounts?: unknown }
    const period = SALES_PERIODS.find((p) => p === s.period)
    const amounts: Record<string, number> = {}
    if (s.amounts && typeof s.amounts === 'object' && !Array.isArray(s.amounts)) {
      for (const [currency, amount] of Object.entries(s.amounts as Record<string, unknown>)) {
        const n = asCount(amount)
        if (n !== undefined && /^[A-Z]{3}$/.test(currency)) amounts[currency] = n
      }
    }
    if (period && Object.keys(amounts).length > 0) out.sales = { period, amounts }
  }

  return out.sales !== undefined || out.terminals !== undefined ? out : undefined
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
 * A subscription id is required, and so is something it confers: at least one feature, or (since
 * #407) a limit. Either alone is ambiguous: a merchant writing `{"features": [...]}` into their
 * metadata for some unrelated purpose would otherwise demonetise their own coupon, and an id
 * with no grant is not a thing we sell. Two fields together, in bytes the issuer
 * signed, is not something a coupon acquires by accident.
 */
export function licenceOf(signed: SignedVoucherFields): LicenceVoucher | null {
  const meta = licenceMetadata(signed.merchantMetadata)
  if (!meta) return null

  const subscriptionId = asString(meta.subscription_id)
  const features = asStrings(meta.features)
  const limits = asLimits(meta.limits)
  if (!subscriptionId || (features.length === 0 && !limits)) return null
  const validFrom = asCount(meta.valid_from)

  return {
    subscriptionId,
    issuerPublicKey: signed.issuerPublicKey,
    issuerSignature: signed.issuerSignature,
    lockKey: asString(meta.lock_key),
    mintLockKey: asString(signed.lockKey),
    issuerId: asString(signed.issuerId),
    expiresAt: signed.expiresAt,
    // The credential is its own receipt (ADR 0007): what was paid, and until
    // when, both read off the voucher rather than off a record we would have to
    // keep. This is the whole of "the customer can see what they paid".
    faceValue: signed.faceValue,
    faceUnit: signed.unit,
    features,
    pilot: meta.pilot === true,
    ...(limits ? { limits } : {}),
    ...(asString(meta.tier) ? { tier: asString(meta.tier) } : {}),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(asString(meta.grant_kind) ? { grantKind: asString(meta.grant_kind) } : {}),
  }
}

