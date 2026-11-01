/**
 * How many Cashlinks a sender may have open, by account type (#366, owner decision 2026-10-21).
 *
 * Q5 (2026-10-11) set 10 outstanding links per wallet, enforced on the sender's device. That is
 * right for a person sending a few gifts. An employer sending gifts to its staff through the API
 * sends dozens at once, so the limit is decided per ACCOUNT TYPE:
 *
 * - `individual`: the Q5 limit, 10 outstanding, 10 expired-but-unreturned. Unchanged.
 * - `business`: an account the deployment lists as a business sender (an employer). Higher, and
 *   configured by the deployment, never by the caller.
 *
 * Pure: no I/O, no clock, no storage. The wallet app and wallet-api read the same rules from here,
 * so the two can never disagree about whether one more link is allowed.
 *
 * ## Restore safety
 *
 * A restored wallet finds its links again by deriving link keys `i = 0, 1, 2, …` and asking the
 * relay for wraps, stopping after a gap of empty indices past the last one it knows (spec 3.3,
 * `RESTORE_GAP = 20`). With 10 outstanding links that gap is safe. With 500 it is not: a restore
 * from a device that lost its counter could stop at the first run of 20 claimed (and so empty)
 * links and never see the open ones beyond them, and their value with them. So the gap grows with
 * the limit (`restoreGap`), and an API sender also records a high-water mark (the highest index it
 * has ever used) in its own state, which a restore scans up to before the gap even starts.
 */

export type AccountType = 'individual' | 'business'

export interface LinkLimits {
  accountType: AccountType
  /** Links that are open and before their expiry. */
  maxOutstanding: number
  /**
   * Links past their expiry whose coupon has not come back yet. Kept in proportion to
   * `maxOutstanding`: these can still be opened by whoever holds the link until they are taken
   * back, which is exactly the exposure the outstanding limit bounds (spec 6.7).
   */
  maxExpiredUnreturned: number
  /** How many empty link indices a restore scans past the last known one before it stops. */
  restoreGap: number
}

/** Q5: the individual limits, unchanged. */
export const INDIVIDUAL_MAX_OUTSTANDING = 10
export const INDIVIDUAL_MAX_EXPIRED_UNRETURNED = 10
/** Spec 3.3: the restore gap for the individual limit. Never smaller than this. */
export const BASE_RESTORE_GAP = 20

/** The business default when a deployment lists business senders but sets no number. */
export const DEFAULT_BUSINESS_MAX_OUTSTANDING = 500
/** A hard ceiling no configuration can exceed: every open link is bearer value on a relay. */
export const ABSOLUTE_MAX_OUTSTANDING = 5000

/**
 * The restore gap for a limit: at least `BASE_RESTORE_GAP`, and at least twice the limit, so a
 * restore never gives up inside a run of empty indices one full limit's worth of claimed links
 * could leave behind.
 */
export function restoreGapFor(maxOutstanding: number): number {
  return Math.max(BASE_RESTORE_GAP, 2 * maxOutstanding)
}

/** The expired-unreturned cap for a limit: the same as the outstanding one, never below Q5's 10. */
export function expiredCapFor(maxOutstanding: number): number {
  return Math.max(INDIVIDUAL_MAX_EXPIRED_UNRETURNED, maxOutstanding)
}

export function limitsFor(accountType: AccountType, businessMaxOutstanding = DEFAULT_BUSINESS_MAX_OUTSTANDING): LinkLimits {
  const maxOutstanding = accountType === 'business' ? businessMaxOutstanding : INDIVIDUAL_MAX_OUTSTANDING
  return {
    accountType,
    maxOutstanding,
    maxExpiredUnreturned: expiredCapFor(maxOutstanding),
    restoreGap: restoreGapFor(maxOutstanding),
  }
}

export const INDIVIDUAL_LIMITS: LinkLimits = limitsFor('individual')

/**
 * Which senders are businesses, and their limit. Comes from the deployment (an environment
 * variable or a file), never from the caller.
 */
export interface BusinessSenders {
  /** Lowercase hex pubkeys. */
  pubkeys: ReadonlySet<string>
  maxOutstanding: number
}

export class LinkLimitsConfigError extends Error {}

/**
 * Read the business-sender list: `{"maxOutstanding": 500, "pubkeys": ["<hex>", …]}`. An empty or
 * missing value means nobody is a business sender. Anything malformed THROWS: a typo here must not
 * quietly give every employer the individual limit (or, worse, every caller the business one).
 */
export function parseBusinessSenders(raw: string | undefined | null): BusinessSenders {
  const text = (raw ?? '').trim()
  if (!text) return { pubkeys: new Set(), maxOutstanding: DEFAULT_BUSINESS_MAX_OUTSTANDING }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LinkLimitsConfigError('the business-sender list is not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LinkLimitsConfigError('the business-sender list must be an object: {"maxOutstanding": n, "pubkeys": [...]}')
  }
  const o = parsed as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (k !== 'maxOutstanding' && k !== 'pubkeys') throw new LinkLimitsConfigError(`unknown field ${k} in the business-sender list`)
  }
  const max = o.maxOutstanding === undefined ? DEFAULT_BUSINESS_MAX_OUTSTANDING : o.maxOutstanding
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < INDIVIDUAL_MAX_OUTSTANDING || max > ABSOLUTE_MAX_OUTSTANDING) {
    throw new LinkLimitsConfigError(`maxOutstanding must be a whole number from ${INDIVIDUAL_MAX_OUTSTANDING} to ${ABSOLUTE_MAX_OUTSTANDING}`)
  }
  if (!Array.isArray(o.pubkeys)) throw new LinkLimitsConfigError('pubkeys must be an array of hex public keys')
  const pubkeys = new Set<string>()
  for (const p of o.pubkeys) {
    if (typeof p !== 'string' || !/^[0-9a-f]{64}$/i.test(p)) throw new LinkLimitsConfigError('every pubkey must be 64 hex characters')
    pubkeys.add(p.toLowerCase())
  }
  return { pubkeys, maxOutstanding: max }
}

/** The limits that apply to one sender. */
export function limitsForSender(pubkey: string, business: BusinessSenders): LinkLimits {
  return business.pubkeys.has(pubkey.toLowerCase()) ? limitsFor('business', business.maxOutstanding) : INDIVIDUAL_LIMITS
}

/** A sender's links, counted the way the limit counts them. */
export interface LinkCountsInput {
  /** Open (still on the link) and before `x`. */
  outstanding: number
  /** Still on the link and past `x`: not yet taken back or returned. */
  expiredUnreturned: number
}

export type LinkAllowance =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'too_many_outstanding' | 'too_many_expired'; limit: number }

/** Whether `wanted` more links may be sent now. */
export function linkAllowance(counts: LinkCountsInput, limits: LinkLimits, wanted = 1): LinkAllowance {
  if (counts.expiredUnreturned >= limits.maxExpiredUnreturned) {
    return { ok: false, reason: 'too_many_expired', limit: limits.maxExpiredUnreturned }
  }
  const remaining = limits.maxOutstanding - counts.outstanding
  if (remaining < wanted) return { ok: false, reason: 'too_many_outstanding', limit: limits.maxOutstanding }
  return { ok: true, remaining: remaining - wanted }
}

/**
 * How far a restore must scan: up to the higher of the recorded high-water mark and the last index
 * known locally, then `restoreGap` further. `highWater` is the highest index ever used, or -1.
 */
export function restoreScanEnd(lastKnown: number, highWater: number, limits: LinkLimits): number {
  return Math.max(lastKnown, highWater, -1) + limits.restoreGap
}
