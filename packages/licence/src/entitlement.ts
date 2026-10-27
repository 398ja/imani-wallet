import { amountIn, FREE_TIER, type TierCatalog } from './catalog.js'
import type { LicenceGrant, LicenceLimits, SalesPeriod } from './types.js'

/**
 * What a stall may do right now, from every licence it holds plus the free tier (#407 §3).
 *
 * ## The highest wins, and nothing adds up
 *
 * A higher tier always includes the lower ones (#407 Q3), so a stall holding a Basic subscription
 * and a hand grant gets, on each dimension, the best one of them: the largest sales allowance, the
 * most terminals, and every feature any of them names. Two grants of 200 are 200, not 400.
 *
 * ## Where a licence's limits come from
 *
 * 1. Limits the licence itself signed. A hand grant is exactly this.
 * 2. Otherwise its tier's limits in the catalog, so a catalog change reaches bought tiers too.
 * 3. A licence sold before #407 names neither. It was sold as "terminals, however many", so it keeps
 *    unlimited terminals and takes Basic's sales allowance, so a paying stall is never pushed below
 *    what it had by the catalog arriving.
 *
 * Pure: the caller supplies the grants already verified (and grace-carried), the catalog and the
 * clock. Nothing here reads storage or the network.
 */
export interface Entitlement {
  /** The best tier name among the sources, for display. `free` when no licence applies. */
  tier: string
  features: readonly string[]
  /** `null` = unlimited. */
  terminals: number | null
  /** `null` = unlimited. */
  sales: SalesAllowance | null
  /** Latest end among the licences in force, or undefined on the free tier. */
  validUntil?: number
}

export interface SalesAllowance {
  period: SalesPeriod
  /** In minor units of `currency`. */
  amount: number
  currency: string
  /** Where the period starts, unix SECONDS. 0 for `lifetime`. */
  periodStart: number
  /** Allowed past `amount` before a sale is refused (#407 Q7), minor units. */
  overshoot: number
  /** Which grant set it: a subscription id, or `free`. */
  source: string
}

export interface EntitlementOptions {
  catalog: TierCatalog
  /** Grants the licence check let through (verified now, or carried by the grace window). */
  grants: readonly LicenceGrant[]
  /** The stall's selling currency. */
  currency: string
  /** Unix SECONDS. */
  now: number
}

/** Legacy licences (no tier, no limits) are read as this tier for sales. */
const LEGACY_SALES_TIER = 'basic'

interface Source {
  name: string
  tier: string
  features: readonly string[]
  limits: LicenceLimits
  validFrom?: number
  expiresAt?: number
}

export function entitlementOf(options: EntitlementOptions): Entitlement {
  const { catalog, currency, now } = options
  const free = catalog.tiers[FREE_TIER]
  const sources: Source[] = [
    { name: FREE_TIER, tier: FREE_TIER, features: free?.features ?? [], limits: free?.limits ?? {} },
  ]

  for (const grant of options.grants) {
    // A grant outside its own window confers nothing, whatever carried it here.
    if (grant.expiresAt <= now) continue
    if (typeof grant.validFrom === 'number' && now < grant.validFrom) continue
    sources.push({
      name: grant.subscriptionId ?? grant.tier ?? 'licence',
      tier: grant.tier ?? 'custom',
      features: grant.features,
      limits: limitsFor(grant, catalog),
      validFrom: grant.validFrom,
      expiresAt: grant.expiresAt,
    })
  }

  const features = [...new Set(sources.flatMap((s) => s.features))]

  let terminals: number | null = 0
  for (const s of sources) {
    const t = s.limits.terminals
    if (t === undefined) continue
    if (t === null) {
      terminals = null
      break
    }
    if (terminals !== null && t > terminals) terminals = t
  }

  let sales: SalesAllowance | null | undefined
  for (const s of sources) {
    const limit = s.limits.sales
    if (limit === undefined) continue
    if (limit === null) {
      sales = null
      break
    }
    const amount = amountIn(limit.amounts, currency, catalog)
    // No number for this currency, even through the fixed USD rate: skip this source rather than
    // read it as unlimited. The free tier always has USD, so a stall never ends up with no limit
    // by accident unless the catalog itself says so.
    if (amount === undefined) continue
    if (sales === undefined || (sales !== null && amount > sales.amount)) {
      sales = {
        period: limit.period,
        amount,
        currency,
        periodStart: periodStart(limit.period, now, s.validFrom),
        overshoot: Math.floor((amount * catalog.overshootPct) / 100),
        source: s.name,
      }
    }
  }

  const best = bestTier(sources, catalog)
  const ends = sources.map((s) => s.expiresAt).filter((e): e is number => typeof e === 'number')

  return {
    tier: best,
    features,
    terminals,
    // `undefined` here means no source could price this currency at all. Refusing to sell is the
    // conservative reading, so it is reported as an allowance of zero rather than as unlimited.
    sales:
      sales === undefined
        ? { period: 'lifetime', amount: 0, currency, periodStart: 0, overshoot: 0, source: FREE_TIER }
        : sales,
    ...(ends.length ? { validUntil: Math.max(...ends) } : {}),
  }
}

function limitsFor(grant: LicenceGrant, catalog: TierCatalog): LicenceLimits {
  const tierLimits = grant.tier ? catalog.tiers[grant.tier]?.limits : undefined
  if (grant.limits || tierLimits) {
    return { ...(tierLimits ?? {}), ...(grant.limits ?? {}) }
  }
  // Sold before #407: "one voucher, however many terminals", and Basic's sales allowance.
  const legacySales = catalog.tiers[LEGACY_SALES_TIER]?.limits.sales
  return {
    ...(grant.features.includes('terminals') ? { terminals: null } : {}),
    ...(legacySales !== undefined ? { sales: legacySales } : {}),
  }
}

/** The tier to show: the catalog tier with the most sources' worth, else the first paid one. */
function bestTier(sources: readonly Source[], catalog: TierCatalog): string {
  const order = Object.keys(catalog.tiers)
  let best = FREE_TIER
  for (const s of sources) {
    const rank = order.indexOf(s.tier)
    if (rank > order.indexOf(best)) best = s.tier
    else if (rank === -1 && best === FREE_TIER) best = s.tier
  }
  return best
}

/** Start of the period a total is counted over, unix SECONDS. */
export function periodStart(period: SalesPeriod, now: number, validFrom?: number): number {
  if (period === 'lifetime') return 0
  if (period === 'window') return validFrom ?? 0
  const d = new Date(now * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
}

/** One sale, as the meter counts it. */
export interface CountedSale {
  /** Unix SECONDS. */
  at: number
  /** Face value, minor units. */
  amount: number
  currency: string
}

/** Sold in the allowance's currency since its period started. Refunds are negative amounts. */
export function salesInPeriod(sales: readonly CountedSale[], allowance: SalesAllowance): number {
  let total = 0
  for (const s of sales) {
    if (s.currency !== allowance.currency) continue
    if (s.at < allowance.periodStart) continue
    total += s.amount
  }
  return Math.max(0, total)
}

export type SaleDecision =
  | { allowed: true; warn: boolean; used: number; limit: number | null }
  | { allowed: false; reason: 'sales-limit-reached'; used: number; limit: number; message: string }

/** Fraction of the allowance at which the stall is warned (#407 §5). */
export const WARN_AT = 0.8

/**
 * May this stall sell `amount` more, given what it has sold this period?
 *
 * A sale is judged BEFORE it starts and is allowed when the total stays within the allowance plus
 * its overshoot, so a sale is never cut off halfway through and the queue at the counter is served
 * until the margin runs out (#407 §5).
 */
export function maySell(entitlement: Entitlement, used: number, amount: number): SaleDecision {
  const allowance = entitlement.sales
  if (allowance === null) return { allowed: true, warn: false, used, limit: null }
  const after = used + Math.max(0, amount)
  if (after > allowance.amount + allowance.overshoot) {
    return {
      allowed: false,
      reason: 'sales-limit-reached',
      used,
      limit: allowance.amount,
      message:
        allowance.period === 'month'
          ? 'You have reached this month\'s sales limit for your plan. Upgrade to keep selling, or sell again from the 1st.'
          : 'You have reached the sales limit for your plan. Upgrade to keep selling.',
    }
  }
  return { allowed: true, warn: after >= allowance.amount * WARN_AT, used, limit: allowance.amount }
}
