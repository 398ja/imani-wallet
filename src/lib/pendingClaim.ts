/**
 * Holding claim links across the walk to a wallet.
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
 * ## A short list keyed by ref, not one slot (claim links phase 3, F4-1)
 *
 * Phase 0 to 2 held ONE claim, and parking a second link while logged out
 * overwrote the first: its key existed nowhere else on the device, so that
 * voucher could no longer be resumed (review of #239, O4). Now each ref has its
 * own entry with its own 24 h age, at most {@link MAX_ENTRIES} of them, and
 * "forget" removes one ref, never the others. The newest live entry is the one
 * that is resumed. A single-object value written by an older build is read as
 * a list of one.
 *
 * ## localStorage, and why this differs from `onboardingHandoff`
 *
 * That module parks an nsec and argues hard for sessionStorage: a plaintext
 * secret must not outlive the tab. The reasoning does not transfer, because the
 * journey is not the same shape. Installing a wallet means leaving for an app
 * store and coming back in a NEW tab, and a sessionStorage entry does not
 * survive that (spec 2.5 says so in as many words: "Nothing goes in a query
 * string, in router state or in `sessionStorage`").
 *
 * What is stored is also a different kind of thing. It is a bearer reference
 * plus its key — enough to claim one coupon of known, bounded value, single-use
 * at the server — not a key that controls an entire wallet forever. There is no
 * account key to encrypt it under yet (the visitor has no wallet), and someone
 * who can read localStorage on this device has already lost more than this.
 * It is bounded instead: 24 h per entry, five entries, removed once used.
 *
 * ## Logout (spec 2.5)
 *
 * Logout sweeps every `imani-wallet:*` key but carries the live entries here
 * across it (`carryPendingClaimsAcrossLogout`): the "different account"
 * journey, and **Switch account** on the prompt (CL-SWITCH), both depend on
 * it. A parked claim is an unspent link opened on this DEVICE, not data of the
 * account that was logged in, and nothing else about that account survives:
 * the offered set is memory only and dies with the reload, and an entry is
 * forgotten as soon as any account adds, declines or finds it dead.
 */

const KEY = 'imani-wallet:pending-claim'

/**
 * Long enough to install an app, short enough that a forgotten claim does not
 * resurface weeks later in front of a different person.
 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Enough for anyone opening a few links before finishing one; small enough to stay a list. */
export const MAX_ENTRIES = 5

export interface PendingClaim {
  /** Cashback (`/c/:ref`) today; gifts (`/g`) arrive in phase 4. */
  kind: 'cashback' | 'gift'
  /** The claim reference from the path. */
  ref: string
  /** The decryption key from the fragment. Never sent to a server, never logged. */
  key: string
  /** A gift's own expiry (unix seconds), when the link carries one. */
  x?: number
  /** When this was parked, ms since epoch. */
  at: number
}

/** One entry, or null for any shape that is not a claim (rejected rather than trusted). */
function parseEntry(value: unknown): PendingClaim | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const { kind, ref, key, x, at } = value as Record<string, unknown>
  if (typeof ref !== 'string' || ref === '') return null
  if (typeof key !== 'string' || key === '') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  const entry: PendingClaim = { kind: kind === 'gift' ? 'gift' : 'cashback', ref, key, at }
  if (typeof x === 'number' && Number.isFinite(x)) entry.x = x
  return entry
}

/** Every well-formed entry, live or not, oldest first. A legacy single object is a list of one. */
function readAll(): PendingClaim[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return []
  }
  if (raw === null) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray(value) ? value : [value]
  return items.map(parseEntry).filter((e): e is PendingClaim => e !== null).sort((a, b) => a.at - b.at)
}

function writeAll(entries: PendingClaim[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    // A full or disabled store must not break the claim the user is already
    // holding in the URL. They lose the resumption, not the voucher.
  }
}

/** A clock nudged back a little (NTP) must not drop a claim parked a moment ago. */
const FUTURE_SKEW_MS = 5 * 60 * 1000

function live(entry: PendingClaim, now = Date.now()): boolean {
  // An entry stamped well in the future (a clock that was wrong when it was parked, or a value
  // written by hand) would otherwise be live, and the newest, until that future date plus a day,
  // and would ride every logout (review of #245, F1b).
  return entry.at <= now + FUTURE_SKEW_MS && now - entry.at <= MAX_AGE_MS
}

/** The live entries, oldest first. */
export function listPendingClaims(): PendingClaim[] {
  const now = Date.now()
  return readAll().filter((e) => live(e, now))
}

/**
 * Park a claim under its ref. Parking the same ref again refreshes it (and makes it the newest); a
 * different ref is ADDED, never written over another one. Expired entries are dropped on the way,
 * and past {@link MAX_ENTRIES} the oldest goes.
 */
export function stashPendingClaim(ref: string, key: string, extra: { kind?: PendingClaim['kind']; x?: number } = {}): void {
  const entry: PendingClaim = { kind: extra.kind ?? 'cashback', ref, key, at: Date.now() }
  if (extra.x !== undefined) entry.x = extra.x
  restorePendingClaim(entry)
}

/** Put back an entry exactly as it was, its age included. */
export function restorePendingClaim(entry: PendingClaim): void {
  const now = Date.now()
  const others = readAll().filter((e) => e.ref !== entry.ref && live(e, now))
  writeAll([...others, entry].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES))
}

/** The newest live claim, without consuming it. */
export function peekPendingClaim(): PendingClaim | null {
  const all = listPendingClaims()
  return all.length ? all[all.length - 1] : null
}

/** The live claim parked under `ref`, if any. */
export function peekPendingClaimFor(ref: string): PendingClaim | null {
  return listPendingClaims().find((e) => e.ref === ref) ?? null
}

/**
 * Read and remove the newest live claim. Malformed and expired entries go with it.
 *
 * Consuming on read is what stops a claim being replayed onto a second account
 * on the same device.
 */
export function takePendingClaim(): PendingClaim | null {
  const all = listPendingClaims()
  const newest = all.pop() ?? null
  writeAll(all)
  return newest
}

/** Forget ONE claim (used, dead, or declined). Every other parked claim is left alone. */
export function forgetPendingClaim(ref: string): void {
  const all = readAll()
  const rest = all.filter((e) => e.ref !== ref)
  if (rest.length !== all.length) writeAll(rest)
}

/** Drop every parked claim without acting on any. */
export function clearPendingClaim(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to do; the age check bounds it.
  }
}

/**
 * True when nothing is waiting but a claim was parked here and has aged out, so the banner can say
 * "Open your voucher link again to add it" (spec 5.2) rather than nothing.
 */
export function hasExpiredPendingClaim(): boolean {
  const all = readAll()
  return all.length > 0 && !all.some((e) => live(e))
}

/**
 * Erase aged-out and malformed entries, keys included (review of #245, F1). Hiding them was not
 * enough: an aged-out key stayed on disk with no end date (the claim window is longer than 24 h),
 * and the banner said "Open your voucher link again" on every later visit.
 */
export function prunePendingClaims(): void {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return
  }
  if (raw === null) return
  const kept = listPendingClaims()
  if (JSON.stringify(kept) !== raw) writeAll(kept)
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

/**
 * The parked claim `/` should resume now: the newest one not yet offered, or null. `kind` narrows it
 * to one screen's claims: `/c` resumes cashback and `/g` resumes gifts (phase 4).
 */
export function pendingClaimToResume(pubkey = '', kind?: PendingClaim['kind']): PendingClaim | null {
  prunePendingClaims()
  const all = listPendingClaims().filter((e) => kind === undefined || e.kind === kind)
  for (let i = all.length - 1; i >= 0; i--) {
    if (!offered.has(`${pubkey}:${all[i].ref}`)) return all[i]
  }
  return null
}

/** Tests only: a fresh page session. */
export function resetPendingClaimOffers(): void {
  offered.clear()
}

/**
 * Run `sweep` (logout's storage wipe) and put the live parked claims back afterwards, ages
 * unchanged. Expired and malformed entries do not survive it.
 */
export function carryPendingClaimsAcrossLogout<T>(sweep: () => T): T {
  const kept = listPendingClaims()
  const out = sweep()
  for (const entry of kept) restorePendingClaim(entry)
  return out
}
