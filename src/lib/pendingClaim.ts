/**
 * Holding a claim link across the walk to a wallet.
 *
 * A bearer claim URL is opened by someone who may have no wallet at all: that
 * is the whole point of the hosted purchase and cashback flows. They land on
 * `/c/:ref`, get sent to onboarding, and by the time they are back the route
 * that carried the claim is long gone — `PublicRoutes` sends every unknown path
 * to `Entry` and deliberately does not preserve it, because every authed route
 * needs a wallet that does not exist yet.
 *
 * So the claim is parked here first, and picked up on the other side.
 *
 * ## localStorage, and why this differs from `onboardingHandoff`
 *
 * That module parks an nsec and argues hard for sessionStorage: a plaintext
 * secret must not outlive the tab. The reasoning does not transfer, because the
 * journey is not the same shape. Installing a wallet means leaving for an app
 * store and coming back in a NEW tab, and a sessionStorage entry does not
 * survive that. A claim held only for the life of one tab would be lost in
 * exactly the case this exists to serve.
 *
 * What is stored is also a different kind of thing. It is a bearer reference
 * plus its key — enough to claim one coupon of known, bounded value, single-use
 * at the server — not a key that controls an entire wallet forever. Someone who
 * can read localStorage on this device has already lost more than this.
 *
 * It is still deleted on first read, and it still expires, because a claim left
 * lying around after it has been used is only a way to show someone a
 * misleading screen later.
 */

const KEY = 'imani-wallet:pending-claim'

/**
 * Long enough to install an app, short enough that a forgotten claim does not
 * resurface weeks later in front of a different person.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface PendingClaim {
  /** The claim reference from the path. */
  ref: string
  /** The decryption key from the fragment. Never sent to a server. */
  key: string
  /** When this was parked, ms since epoch. */
  at: number
}

/** Shapes that are not a claim, rejected rather than trusted. */
function parse(raw: string): PendingClaim | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const { ref, key, at } = value as Record<string, unknown>
  if (typeof ref !== 'string' || ref === '') return null
  if (typeof key !== 'string' || key === '') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  return { ref, key, at }
}

export function stashPendingClaim(ref: string, key: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ref, key, at: Date.now() } satisfies PendingClaim))
  } catch {
    // A full or disabled store must not break the claim the user is already
    // holding in the URL. They lose the resumption, not the voucher.
  }
}

/**
 * Read and remove, refusing anything stale.
 *
 * Consuming on read is what stops a claim being replayed onto a second account
 * on the same device, which would show a "voucher unavailable" screen to
 * someone who did nothing wrong.
 */
export function takePendingClaim(): PendingClaim | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (raw === null) return null

  try {
    localStorage.removeItem(KEY)
  } catch {
    // Ignore: the age check below still bounds a store we cannot clear.
  }

  const parsed = parse(raw)
  if (!parsed) return null
  if (Date.now() - parsed.at > MAX_AGE_MS) return null
  return parsed
}

/**
 * Read without consuming, to decide whether there is anywhere to go.
 *
 * The resume path needs to know a claim is parked BEFORE it navigates to the
 * screen that will spend it. Consuming here would drop the claim on the floor
 * between the two.
 */
export function peekPendingClaim(): PendingClaim | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (raw === null) return null

  const parsed = parse(raw)
  if (!parsed) return null
  if (Date.now() - parsed.at > MAX_AGE_MS) return null
  return parsed
}

/** Drop a parked claim without acting on it. */
export function clearPendingClaim(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to do; the age check bounds it.
  }
}

/**
 * Refs whose prompt has already been shown in this page session (memory only, never stored).
 *
 * `/` sends a device holding a parked claim to `/c`. Without this, every way back home from the
 * prompt ("Open my wallet" on a network failure, a deployment that cannot claim, a dead link)
 * bounced straight back to it, and the customer could not reach their wallet until the claim aged
 * out (review of claim links phase 1). A claim still waiting is offered again on the next launch
 * or unlock, which is what "Your voucher is still waiting" promises.
 */
const offered = new Set<string>()

/** Keyed by account too, so a claim shown to one account is still resumed after switching to another. */
export function markPendingClaimOffered(ref: string, pubkey = ''): void {
  offered.add(`${pubkey}:${ref}`)
}

/** The parked claim `/` should resume now, or null when there is none or it was already offered. */
export function pendingClaimToResume(pubkey = ''): PendingClaim | null {
  const pending = peekPendingClaim()
  return pending && !offered.has(`${pubkey}:${pending.ref}`) ? pending : null
}

/** Tests only: a fresh page session. */
export function resetPendingClaimOffers(): void {
  offered.clear()
}
