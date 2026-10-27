import type { LicenceLimits } from './types.js'

/**
 * The tier catalog (#407 §1): which tiers exist, what each unlocks, and the limits they set.
 *
 * Configuration, not code. Every number a merchant meets ("you can sell 100", "3 tills") comes from
 * here, so changing one is publishing a new catalog rather than shipping an app (#407 Q2).
 *
 * ## Signed, versioned, and never replayed
 *
 * The app FETCHES the catalog, so it must not trust whoever answers. A catalog is honoured only if
 * our issuer key signed it (the caller injects the check, as `verifyLicence` does), and a lower
 * `version` never replaces a higher one held, so an old, more generous catalog cannot be served
 * back to a device to lift its limits. gateway-customer reads the same signed document, so the
 * client and the server never disagree about a number.
 *
 * ## The free tier needs no licence
 *
 * A stall with no licence is on `free`, and `free` is read from the catalog like every other tier.
 * That is why the free limit can change without an app release, which a constant could not.
 */
export interface TierCatalog {
  /** Monotonic. A device keeps the highest it has seen. */
  version: number
  /** A sale may take the period total up to this far past the limit (#407 Q7). Percent. */
  overshootPct: number
  tiers: Readonly<Record<string, TierDefinition>>
  /**
   * Conversion used ONLY for a currency the catalog has no amount for (#407 Q11): the USD amount,
   * converted at the rate fixed when this catalog was published. Never a live rate, so a stall's
   * limit does not move between catalog versions.
   */
  fx?: Readonly<Record<string, { perUsd: number; decimals: number }>>
}

export interface TierDefinition {
  features: readonly string[]
  limits: LicenceLimits
}

/** The tier a stall with no licence is on. */
export const FREE_TIER = 'free'

/** Decimals of USD minor units, which the fallback converts from. */
const USD_DECIMALS = 2

/**
 * The catalog compiled into the app, used until a signed one has been fetched.
 *
 * Mirrors what #407 decided: 100 one-off (Free), 1,000 a month and 3 tills (Basic), no limits plus
 * API and e-commerce (Pro), in the major currencies, with a 10 % overshoot. Version 1, so any
 * catalog we publish replaces it.
 *
 * The free tier's terminal allowance is 1 ENROLLED terminal on top of the owner's own device, which
 * is how `terminalAllowance` has always counted (the owner's device is counted, never converted).
 */
export const BUNDLED_CATALOG: TierCatalog = {
  version: 1,
  overshootPct: 10,
  tiers: {
    free: {
      features: [],
      limits: { sales: { period: 'lifetime', amounts: majors(100_00) }, terminals: 1 },
    },
    basic: {
      features: ['terminals'],
      limits: { sales: { period: 'month', amounts: majors(1000_00) }, terminals: 3 },
    },
    pro: {
      features: ['terminals', 'api', 'ecommerce'],
      limits: { sales: null, terminals: null },
    },
  },
}

function majors(minor: number): Record<string, number> {
  return { GBP: minor, EUR: minor, USD: minor, CAD: minor, AUD: minor, CHF: minor }
}

/** A catalog as published: the document and our signature over it. */
export interface SignedCatalog {
  /** The canonical JSON the signature covers. Parsed only after the signature verifies. */
  body: string
  signature: string
}

export type CatalogVerdict =
  | { accepted: true; catalog: TierCatalog }
  | { accepted: false; reason: 'bad-signature' | 'malformed' | 'older'; detail: string }

/**
 * Should this device adopt a fetched catalog?
 *
 * Signature first, so nothing below parses bytes an attacker chose. Then shape, read strictly: a
 * catalog with a tier we cannot read is refused whole rather than half-adopted. Then version, so a
 * replay of an older catalog changes nothing.
 */
export function acceptCatalog(
  signed: SignedCatalog,
  options: { verifySignature: (signed: SignedCatalog) => boolean; current: TierCatalog },
): CatalogVerdict {
  if (!options.verifySignature(signed)) {
    return { accepted: false, reason: 'bad-signature', detail: 'the catalog was not signed by us' }
  }
  const catalog = parseCatalog(signed.body)
  if (!catalog) return { accepted: false, reason: 'malformed', detail: 'the catalog could not be read' }
  if (catalog.version <= options.current.version) {
    return {
      accepted: false,
      reason: 'older',
      detail: `catalog version ${catalog.version} is not newer than ${options.current.version}`,
    }
  }
  return { accepted: true, catalog }
}

/** Parse the published (snake_case) catalog. Null for anything that is not exactly a catalog. */
export function parseCatalog(body: string): TierCatalog | null {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const version = raw.version
  const overshoot = raw.overshoot_pct
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null
  if (typeof overshoot !== 'number' || !Number.isFinite(overshoot) || overshoot < 0 || overshoot > 100) return null
  if (!isObject(raw.tiers)) return null

  const tiers: Record<string, TierDefinition> = {}
  for (const [name, def] of Object.entries(raw.tiers)) {
    const tier = parseTier(def)
    if (!tier) return null
    tiers[name] = tier
  }
  if (!tiers[FREE_TIER]) return null

  const fx: Record<string, { perUsd: number; decimals: number }> = {}
  if (raw.fx !== undefined) {
    if (!isObject(raw.fx)) return null
    for (const [currency, rate] of Object.entries(raw.fx)) {
      if (!/^[A-Z]{3}$/.test(currency) || !isObject(rate)) return null
      const perUsd = rate.per_usd
      const decimals = rate.decimals
      if (typeof perUsd !== 'number' || !(perUsd > 0) || !Number.isFinite(perUsd)) return null
      if (typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 8) return null
      fx[currency] = { perUsd, decimals }
    }
  }

  return { version, overshootPct: overshoot, tiers, ...(Object.keys(fx).length ? { fx } : {}) }
}

function parseTier(def: unknown): TierDefinition | null {
  if (!isObject(def)) return null
  const features = def.features
  if (!Array.isArray(features) || !features.every((f) => typeof f === 'string' && f.length > 0)) return null
  if (!isObject(def.limits)) return null
  const limits: LicenceLimits = {}

  const terminals = def.limits.terminals
  if (terminals === null) limits.terminals = null
  else if (typeof terminals === 'number' && Number.isSafeInteger(terminals) && terminals >= 0) limits.terminals = terminals
  else if (terminals !== undefined) return null

  const sales = def.limits.sales
  if (sales === null) limits.sales = null
  else if (sales !== undefined) {
    if (!isObject(sales) || !isObject(sales.amounts)) return null
    const period = sales.period
    if (period !== 'lifetime' && period !== 'month' && period !== 'window') return null
    const amounts: Record<string, number> = {}
    for (const [currency, amount] of Object.entries(sales.amounts)) {
      if (!/^[A-Z]{3}$/.test(currency)) return null
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return null
      amounts[currency] = amount
    }
    limits.sales = { period, amounts }
  }

  return { features: [...features] as string[], limits }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * A limit's amount in the stall's currency, in its minor units.
 *
 * The catalog's own amount when it has one. Otherwise the USD amount converted at the rate fixed in
 * the catalog (#407 Q11), rounded DOWN so a conversion never grants more than the USD figure.
 * `undefined` when neither is possible: the caller then has no number for this currency and must
 * treat the limit as the most conservative one available rather than as unlimited.
 */
export function amountIn(
  amounts: Readonly<Record<string, number>>,
  currency: string,
  catalog: Pick<TierCatalog, 'fx'>,
): number | undefined {
  const own = amounts[currency]
  if (own !== undefined) return own
  const usd = amounts.USD
  const rate = catalog.fx?.[currency]
  if (usd === undefined || !rate) return undefined
  return Math.floor((usd / 10 ** USD_DECIMALS) * rate.perUsd * 10 ** rate.decimals)
}
