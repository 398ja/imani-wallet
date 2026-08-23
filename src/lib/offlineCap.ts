/**
 * How much value a merchant is willing to accept while they cannot check it.
 *
 * Offline you can verify the issuer, the signature and the expiry. You cannot
 * learn whether the proofs are already spent — nothing local can, and no amount
 * of lineage helps, because everything is equally stale without a network. So
 * the exposure is bounded by policy rather than by cryptography, and the policy
 * is the merchant's own appetite for risk.
 *
 * **No value means zero.** A merchant who has not set a cap does not redeem
 * offline, so shipping this adds no exposure to anyone who does not opt in.
 *
 * **The bound is cumulative, not per-redemption.** A ceiling on each redemption
 * is bypassed by presenting three coupons just under it; what has to be bounded
 * is everything accepted-but-not-yet-reconciled at once.
 *
 * **Device-local, deliberately not on the merchant record.** That record is
 * published to a relay and readable by anyone (`merchant.ts`: "metadata,
 * published to a relay, readable by anyone"), so putting the cap there would
 * broadcast exactly how much can be taken offline. Worse, the relay copy is
 * attacker-controllable — `mergeMerchantEvent` clamps relay-sourced values
 * because "anyone can publish a kind-30078 claiming to be you" — and a ceiling
 * someone else can raise fails in precisely the wrong direction.
 *
 * Living under the `imani-wallet:` prefix means logout wipes it, so a merchant
 * returning to a fresh device is back to refusing offline until they choose
 * otherwise. That is the safe way round.
 */

const CAP_KEY_PREFIX = 'imani-wallet:offline-cap:'
const QUEUE_KEY_PREFIX = 'imani-wallet:offline-queue:'

/**
 * Upper bound on the setting itself, in face minor units.
 *
 * Same reasoning as MAX_VALIDITY_DAYS: the point is to catch a mistyped extra
 * zero at the moment it is typed, not to express policy. A stall accepting more
 * than this unverified is not a case this feature is for.
 */
export const MAX_OFFLINE_CAP = 100_000_00

/**
 * The cap, or null for anything that is not one.
 *
 * Null means "not a valid entry", which the form uses to hold a half-typed
 * value. It is NOT the same as an absent cap — `getOfflineCap` reads that as 0.
 */
export function validOfflineCap(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const cap = Number(value)
  return Number.isInteger(cap) && cap >= 0 && cap <= MAX_OFFLINE_CAP ? cap : null
}

/** One provisional redemption: accepted offline, not yet reconciled. */
export interface ProvisionalRedemption {
  voucherId: string
  /** Face minor units credited. */
  amount: number
  /** Epoch milliseconds. */
  at: number
}

function readQueue(pubkey: string): ProvisionalRedemption[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY_PREFIX + pubkey)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is ProvisionalRedemption =>
        !!r &&
        typeof (r as ProvisionalRedemption).voucherId === 'string' &&
        Number.isFinite((r as ProvisionalRedemption).amount),
    )
  } catch {
    // Unreadable storage must not take the till down; it reads as "nothing
    // outstanding", which is the conservative answer — it can only make the
    // remaining allowance look larger, and the cap still bounds the total.
    return []
  }
}

function writeQueue(pubkey: string, queue: ProvisionalRedemption[]): void {
  try {
    localStorage.setItem(QUEUE_KEY_PREFIX + pubkey, JSON.stringify(queue))
  } catch {
    // Quota or a privacy mode with storage disabled. Nothing useful to do here:
    // the caller has already decided to accept, and losing the record costs the
    // reconciliation entry, not the money.
  }
}

/** The configured cap in face minor units. Absent, unreadable or invalid → 0. */
export function getOfflineCap(pubkey: string): number {
  try {
    return validOfflineCap(localStorage.getItem(CAP_KEY_PREFIX + pubkey)) ?? 0
  } catch {
    return 0
  }
}

/** Stores the cap. `null` clears it, which returns the merchant to refusing. */
export function setOfflineCap(pubkey: string, cap: number | null): void {
  try {
    if (cap === null) localStorage.removeItem(CAP_KEY_PREFIX + pubkey)
    else localStorage.setItem(CAP_KEY_PREFIX + pubkey, String(cap))
  } catch {
    // Storage unavailable — the cap stays whatever it was, which for a first
    // run is 0. Refusing to redeem offline is the safe failure.
  }
}

/** Total accepted offline and not yet reconciled. */
export function offlineOutstanding(pubkey: string): number {
  return readQueue(pubkey).reduce((sum, r) => sum + r.amount, 0)
}

export interface OfflineCheck {
  allowed: boolean
  cap: number
  outstanding: number
  requested: number
  /** What could still be accepted offline right now. Never negative. */
  remaining: number
}

/**
 * Whether one more offline redemption fits inside the cap.
 *
 * Only meaningful while offline — when there is a network the proofs can be
 * checked properly and this does not apply.
 */
export function checkOfflineRedemption(pubkey: string, requested: number): OfflineCheck {
  const cap = getOfflineCap(pubkey)
  const outstanding = offlineOutstanding(pubkey)
  return {
    allowed: cap > 0 && outstanding + requested <= cap,
    cap,
    outstanding,
    requested,
    remaining: Math.max(0, cap - outstanding),
  }
}

/** Records a redemption accepted offline, so it counts against the cap. */
export function recordProvisional(pubkey: string, entry: ProvisionalRedemption): void {
  writeQueue(pubkey, [...readQueue(pubkey), entry])
}

/** The queue, for the reconciliation sweep. */
export function listProvisional(pubkey: string): ProvisionalRedemption[] {
  return readQueue(pubkey)
}

/**
 * Drops a reconciled entry, freeing its allowance.
 *
 * Keyed by voucherId AND timestamp: one voucher can legitimately be redeemed
 * more than once, so clearing by voucherId alone would free allowance for
 * redemptions that are still outstanding.
 */
export function clearProvisional(pubkey: string, entry: ProvisionalRedemption): void {
  writeQueue(
    pubkey,
    readQueue(pubkey).filter((r) => !(r.voucherId === entry.voucherId && r.at === entry.at)),
  )
}
