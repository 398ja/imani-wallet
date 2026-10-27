import {
  acceptCatalog,
  BUNDLED_CATALOG,
  entitlementOf,
  maySell,
  parseCatalog,
  salesInPeriod,
  type CountedSale,
  type Entitlement,
  type SaleDecision,
  type SignedCatalog,
  type TierCatalog,
} from '@imani/licence'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils'
import type { TransactionRow } from '@imani/wallet-storage'

import { licenceIssuerPubkey, type LicenceStatus } from './licenceStatus'

/**
 * What this stall may do, in tiers and limits (#407): the join between the licence status, the
 * signed tier catalog, and the stall's own sales.
 *
 * The rules are in `@imani/licence` and are pure. This module only gathers their inputs: which
 * catalog this device holds, and which sales count. It is the one place screens ask, so a gate
 * cannot be built that skips the grace window or reads the wrong catalog.
 *
 * This is the HONEST half. gateway-customer enforces the same limits at issuance from the same
 * signed catalog (`422 SALES_LIMIT_REACHED`), which is what stops a patched client.
 */

const CATALOG_KEY = 'imani.tiers.catalog'

/** Where plans are bought, by card, signed in with the stall's key (#407 §6). Overridable per deployment. */
export const SUBSCRIPTION_SITE_URL =
  ((import.meta.env.VITE_SUBSCRIPTION_SITE_URL as string | undefined) ?? '').trim() ||
  'https://subscription.imani.casa'

/**
 * The catalog this device holds: the highest-version signed catalog it has accepted, or the one
 * compiled in. Re-verified on every read, so a value written into storage by anything else is
 * ignored rather than trusted.
 */
export function currentCatalog(): TierCatalog {
  try {
    const raw = localStorage.getItem(CATALOG_KEY)
    if (!raw) return BUNDLED_CATALOG
    const signed = JSON.parse(raw) as SignedCatalog
    if (typeof signed?.body !== 'string' || typeof signed?.signature !== 'string') return BUNDLED_CATALOG
    if (!catalogSignatureValid(signed)) return BUNDLED_CATALOG
    const catalog = parseCatalog(signed.body)
    return catalog && catalog.version > BUNDLED_CATALOG.version ? catalog : BUNDLED_CATALOG
  } catch {
    return BUNDLED_CATALOG
  }
}

/**
 * Adopt a catalog fetched from the issuer, if it is ours and newer. Returns whether it was taken.
 *
 * Fetching is the caller's job (and is allowed to fail: the device keeps what it has).
 */
export function adoptCatalog(signed: SignedCatalog): boolean {
  const verdict = acceptCatalog(signed, { verifySignature: catalogSignatureValid, current: currentCatalog() })
  if (!verdict.accepted) return false
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(signed))
  } catch {
    return false
  }
  return true
}

/**
 * BIP-340 over sha256 of the exact body bytes, by OUR issuer key, the same build-time key a licence
 * must be signed by (see `licenceIssuerPubkey`). No key configured means no catalog verifies, and the
 * device stays on the bundled one: the safe direction.
 */
export function catalogSignatureValid(signed: SignedCatalog, issuerPublicKey = licenceIssuerPubkey()): boolean {
  if (!/^[0-9a-f]{64}$/i.test(issuerPublicKey) || !/^[0-9a-f]{128}$/i.test(signed.signature)) return false
  try {
    return schnorr.verify(
      hexToBytes(signed.signature),
      sha256(new TextEncoder().encode(signed.body)),
      hexToBytes(issuerPublicKey),
    )
  } catch {
    return false
  }
}

/** Forget an adopted catalog. For tests and a wipe. */
export function forgetCatalog(): void {
  try {
    localStorage.removeItem(CATALOG_KEY)
  } catch {
    // nothing held
  }
}

/** The stall's entitlement right now. */
export function entitlementFor(
  status: LicenceStatus,
  currency: string,
  catalog: TierCatalog = currentCatalog(),
): Entitlement {
  // A status built before #407 (or by hand) carries only its decision: read that grant as the one.
  const grants = status.grants ?? (status.decision.granted ? [status.decision.grant] : [])
  return entitlementOf({ catalog, grants, currency, now: status.checkedAt })
}

/** Terminals the stall may enrol, beyond the owner's own device. `null` = unlimited. */
export function terminalLimit(status: LicenceStatus, catalog?: TierCatalog): number | null {
  return entitlementFor(status, 'USD', catalog).terminals
}

/**
 * The stall's sales, as the meter counts them: every coupon it ISSUED (#407 Q4), on this device and
 * on its terminals (their takings reach the owner's ledger, ADR 0011), at face value.
 *
 * `issued` rows are written per coupon part, so a split sale counts once per part, which sums to the
 * sale. Timestamps on these rows are milliseconds; older ones may be seconds, so both are read.
 */
export function countedSales(rows: readonly TransactionRow[]): CountedSale[] {
  const out: CountedSale[] = []
  for (const r of rows) {
    if (r.type !== 'issued') continue
    const amount = typeof r.amount === 'number' && Number.isFinite(r.amount) ? r.amount : 0
    const unit = typeof r.unit === 'string' ? r.unit : r.face_unit
    if (!unit || amount <= 0) continue
    const t = typeof r.timestamp === 'number' ? r.timestamp : 0
    out.push({ at: t > 1e11 ? Math.floor(t / 1000) : t, amount, currency: unit.toUpperCase() })
  }
  return out
}

export interface SalesPosition {
  entitlement: Entitlement
  /** Sold this period, minor units. */
  used: number
}

/** Where the stall stands against its sales allowance. */
export function salesPosition(
  status: LicenceStatus,
  currency: string,
  rows: readonly TransactionRow[],
  catalog?: TierCatalog,
): SalesPosition {
  const entitlement = entitlementFor(status, currency.toUpperCase(), catalog)
  const used = entitlement.sales ? salesInPeriod(countedSales(rows), entitlement.sales) : 0
  return { entitlement, used }
}

/** May the stall sell `amount` (minor units) more? The Sell screen asks this before it issues. */
export function checkSale(position: SalesPosition, amount: number): SaleDecision {
  return maySell(position.entitlement, position.used, amount)
}

/** Does the stall hold a feature (`api`, `ecommerce`, `terminals`) right now? */
export function hasFeature(status: LicenceStatus, feature: string, catalog?: TierCatalog): boolean {
  // Currency does not affect features, so any will do.
  return entitlementFor(status, 'USD', catalog).features.includes(feature)
}

/** The sale would take the stall past its tier's sales allowance (#407 §5). Nothing was issued. */
export class SalesLimitError extends Error {
  readonly code = 'SALES_LIMIT_REACHED'
  constructor(message: string) {
    super(message)
    this.name = 'SalesLimitError'
  }
}

/** What the gateway's `422 SALES_LIMIT_REACHED` reads as, so both refusals say the same thing. */
export const SALES_LIMIT_MESSAGE =
  'You have reached the sales limit for your plan. Upgrade to keep selling. Redeeming coupons still works.'

/**
 * Whether sales limits are enforced in this build (`VITE_TIER_LIMITS=on`).
 *
 * OFF by default, deliberately. Switching it on puts every existing stall on the free tier's
 * one-off allowance, so it must not ship before `subscription.imani.casa` can sell an upgrade and
 * existing stalls have been granted what they need. The limits are still COMPUTED and shown with it
 * off; only the refusal waits for the flag.
 */
export function salesLimitsEnforced(): boolean {
  return ((import.meta.env.VITE_TIER_LIMITS as string | undefined) ?? '').trim().toLowerCase() === 'on'
}

/**
 * Refuse a sale that would go past the stall's allowance, BEFORE anything is minted.
 *
 * Asked on the owner's device only. A terminal never reads the stall's licence (ADR 0007), so its
 * sales are held to the same allowance by the gateway, which counts every till under the stall
 * (#407 Q8).
 *
 * Fails OPEN when the inputs cannot be gathered: a wallet that cannot be read is not evidence the
 * stall is over its limit, and the gateway refuses regardless.
 */
export async function assertWithinSalesLimit(
  input: { stallPubkey: string; currency: string; amount: number },
  deps: {
    status?: (pubkey: string) => Promise<LicenceStatus>
    transactions?: () => Promise<TransactionRow[]>
    enforced?: boolean
  } = {},
): Promise<void> {
  if (!(deps.enforced ?? salesLimitsEnforced())) return
  let decision: SaleDecision
  try {
    const status = await (deps.status ?? ((pubkey) => import('./licenceStatus').then((m) => m.licenceStatus({ pubkey }))))(
      input.stallPubkey,
    )
    const rows = await (deps.transactions ?? (() => import('./wallet').then((m) => m.listTransactions())))()
    decision = checkSale(salesPosition(status, input.currency, rows), input.amount)
  } catch {
    return
  }
  if (!decision.allowed) throw new SalesLimitError(decision.message)
}
