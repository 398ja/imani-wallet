import { verifyEvent, type Event } from 'nostr-tools'

import { getSigner } from './nap'
import { allEventsWithGateway, publish } from './relay'
import { mirrorToGateway } from './transferSignature'
import { buildRecordEvents, isChunkEvent, reassembleRecords, recordIdOf, type Sealer } from './chunkedRecord'
import {
  checkoutCodesKey,
  checkoutRefundCounterKey,
  loadCheckoutCodes,
  nextCheckoutRefundIndex,
  onCheckoutCodeSaved,
  remainingOf,
  type CheckoutCodeRecord,
} from './checkoutCodeRecords'

/**
 * The relay backup of the customer's checkout codes (#557), modelled on the cashback stash (#331).
 *
 * WHY. A checkout code's record (`checkoutCodeRecords.ts`) is the only map back to its value: it
 * names each part's refund index `i` and its `lockedToken`. It lived only in localStorage, so logout
 * (which sweeps `imani-wallet:*`) had to refuse while one was outstanding, for up to 7 days, and a
 * code that WAS finished lost its details for good (History rows no longer opened).
 *
 * THE RECORD. One kind-30078 record, `d=imani:checkout-codes`, NIP-44 sealed to the account's own
 * key, chunked when big, published to the relay and mirrored to the gateway. It holds every record
 * (outstanding ones, and the newest finished ones so History details still open after a restore)
 * plus the refund counter. It NEVER holds a part's pre-lock bearer `token`: only `lockedToken`,
 * which is P2PK to the shop key `S` and refundable only by `R` after `x`. `R` is re-derived from the
 * identity key and `i`, so no secret is stored.
 *
 * LOGOUT. A code no longer blocks once a read-back (relay or gateway, signature-checked, decrypted)
 * holds its id and every `lockedToken` (`confirmCheckoutCodeBackup`). A code still being made
 * (locking, arming, depositing) keeps blocking: its parts may hold a bearer token mid-burn.
 *
 * LOGIN. `restoreCheckoutCodes` merges the records into the local ledger (a local record always
 * wins) and lifts the refund counter past every restored `i`, so an `R` is never reused. The usual
 * `/mine` and notice follow-up then carries each code on.
 */

export const CODES_KIND = 30078
export const CODES_D_TAG = 'imani:checkout-codes'
/** Finished codes kept in the backup, newest first. Outstanding ones are always kept. */
export const MAX_DONE_CODES = 200
/** How long a burst of saves waits before one publish. */
export const PUBLISH_DEBOUNCE_MS = 1_500

export interface CodesBackup {
  codes: CheckoutCodeRecord[]
  next: number
}

/** A record as it may be published: no part carries its bearer `token`. */
export function strippedRecord(r: CheckoutCodeRecord): CheckoutCodeRecord {
  return {
    ...r,
    parts: r.parts.map((p) => {
      const { token: _bearer, ...rest } = p
      void _bearer
      return { ...rest }
    }),
  }
}

/** Outstanding codes all, finished codes up to the cap, newest first, stripped. */
export function backupOf(codes: readonly CheckoutCodeRecord[], next: number): CodesBackup {
  const sorted = [...codes].sort((a, b) => b.createdAt - a.createdAt)
  const open = sorted.filter((r) => !r.done)
  const done = sorted.filter((r) => r.done).slice(0, MAX_DONE_CODES)
  const kept = new Set([...open, ...done])
  return { codes: sorted.filter((r) => kept.has(r)).map(strippedRecord), next }
}

/** Merge: every local record, plus the backed ones this device does not have. Never loses one. */
function merged(local: readonly CheckoutCodeRecord[], backed: readonly CheckoutCodeRecord[]): CheckoutCodeRecord[] {
  const ids = new Set(local.map((r) => r.id))
  return [...local, ...backed.filter((r) => !ids.has(r.id))]
}

function selfSealer(): Sealer {
  const signer = getSigner()
  return {
    encrypt: (plain) => signer.nip44Encrypt(signer.pubkey, plain),
    decrypt: (cipher) => signer.nip44Decrypt(signer.pubkey, cipher),
  }
}

function asBackup(text: string): CodesBackup | null {
  try {
    const parsed = JSON.parse(text) as { codes?: unknown; next?: unknown }
    if (!Array.isArray(parsed.codes)) return null
    const codes = parsed.codes.filter(
      (r): r is CheckoutCodeRecord =>
        typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string' && Array.isArray((r as { parts?: unknown }).parts),
    )
    const next = typeof parsed.next === 'number' && Number.isSafeInteger(parsed.next) && parsed.next >= 0 ? parsed.next : 0
    return { codes, next }
  } catch {
    return null
  }
}

let newestAt = 0

/** The newest readable backup, `{codes: [], next: 0}` when none. Null when nothing answered. */
export async function readBackCheckoutCodes(pubkey: string): Promise<CodesBackup | null> {
  let events: Event[]
  try {
    events = await allEventsWithGateway(pubkey, CODES_KIND)
  } catch {
    return null
  }
  const mine = events.filter((e) => {
    if (e.pubkey !== pubkey || e.kind !== CODES_KIND || recordIdOf(e) !== CODES_D_TAG) return false
    const { id, created_at, kind, tags, content, sig } = e
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  })
  const unique = [...new Map(mine.map((e) => [e.id, e])).values()]
  const sealer = selfSealer()
  const candidates: Array<{ at: number; backup: CodesBackup }> = []
  const consider = (at: number, text: string) => {
    const backup = asBackup(text)
    if (backup) candidates.push({ at, backup })
  }
  for (const r of await reassembleRecords(unique, pubkey, sealer)) consider(r.at, r.plaintext)
  for (const e of unique) {
    if (isChunkEvent(e)) continue
    try {
      consider(e.created_at, sealer.decrypt(e.content))
    } catch {
      // Not readable with this key.
    }
  }
  candidates.sort((a, b) => b.at - a.at)
  for (const e of unique) newestAt = Math.max(newestAt, e.created_at)
  return candidates[0]?.backup ?? { codes: [], next: 0 }
}

/** Sign and publish the backup. The plaintext is built from stripped records only. */
export async function publishCheckoutCodes(backup: CodesBackup): Promise<void> {
  const signer = getSigner()
  const plaintext = JSON.stringify({ v: 1, ...backupOf(backup.codes, backup.next) })
  const templates = await buildRecordEvents(CODES_KIND, CODES_D_TAG, plaintext, [], selfSealer())
  const at = Math.max(templates[0]?.created_at ?? 0, newestAt + 1)
  newestAt = at
  for (const template of templates) {
    template.created_at = at
    const event = (await signer.signEvent(template)) as Event
    await Promise.all([publish(event).catch(() => undefined), mirrorToGateway(event).catch(() => false)])
  }
}

function unlocked(): boolean {
  try {
    const signer = getSigner() as { hasKey?: () => boolean; pubkey?: string }
    return typeof signer.hasKey !== 'function' || signer.hasKey()
  } catch {
    return false
  }
}

/**
 * Publish this device's ledger, merged with what the record already holds (another device's codes
 * are kept). Reads first: a blind publish could replace a record it never saw. Never throws.
 */
export async function syncCheckoutCodes(pubkey: string): Promise<boolean> {
  try {
    if (!unlocked()) return false
    const backed = await readBackCheckoutCodes(pubkey)
    if (!backed) return false
    const local = loadCheckoutCodes(pubkey)
    const next = Math.max(nextCheckoutRefundIndex(pubkey), backed.next)
    await publishCheckoutCodes({ codes: merged(local, backed.codes), next })
    return true
  } catch {
    return false
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Debounced publish after a save. */
export function scheduleCheckoutCodesPublish(pubkey: string, delayMs = PUBLISH_DEBOUNCE_MS): void {
  clearTimeout(timers.get(pubkey))
  timers.set(
    pubkey,
    setTimeout(() => {
      timers.delete(pubkey)
      void syncCheckoutCodes(pubkey)
    }, delayMs),
  )
}

/** Cancel pending publishes (logout, tests). */
export function stopCheckoutCodesPublish(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

let wired = false
/** Every save schedules a publish (idempotent). */
export function startCheckoutCodeBackup(): void {
  if (wired) return
  wired = true
  onCheckoutCodeSaved((pubkey) => scheduleCheckoutCodesPublish(pubkey))
}

// --- Logout -----------------------------------------------------------------

/** The code logout names: never the code itself, never a key. */
export interface BlockingCode {
  id: string
  shopUrl: string
  unit: string
  decimals: number
  amount: number
  /** Epoch seconds: when its value comes back on its own. */
  x: number
}

export type CodesCheck =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: 'moving' | 'unconfirmed' | 'locked' | 'store-unreadable'; code?: BlockingCode; fingerprint: string }

const MOVING_STATUSES = new Set(['locking', 'depositing'])
const MOVING_PARTS = new Set(['new', 'arming'])

/** A code whose parts may still be mid-burn: only this device can finish it. */
export const isMoving = (r: CheckoutCodeRecord): boolean =>
  !r.done && (MOVING_STATUSES.has(r.status) || r.parts.some((p) => MOVING_PARTS.has(p.state)))

/** What a read-back must hold for this code: its id and every locked token. */
export function covers(backed: readonly CheckoutCodeRecord[], r: CheckoutCodeRecord): boolean {
  const there = backed.find((b) => b.id === r.id)
  if (!there) return false
  const have = new Set(there.parts.map((p) => p.lockedToken).filter(Boolean))
  return r.parts.every((p) => !p.lockedToken || have.has(p.lockedToken))
}

const blockingOf = (r: CheckoutCodeRecord): BlockingCode => ({
  id: r.id,
  shopUrl: r.shopUrl,
  unit: r.unit,
  decimals: r.decimals,
  amount: remainingOf(r),
  x: r.x,
})

/** Identity of the outstanding codes, for logout's race check. */
export function codesFingerprint(pubkey: string): string {
  try {
    return JSON.stringify(
      loadCheckoutCodes(pubkey)
        .filter((r) => !r.done)
        .map((r) => [r.id, r.status, r.parts.map((p) => [p.state, p.lockedToken ?? ''])]),
    )
  } catch {
    return '\u0000unreadable'
  }
}

export interface CodesCheckOptions {
  rounds?: number
  deadlineMs?: number
  settleMs?: number
}

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), Math.max(0, ms)))),
  ]).finally(() => clearTimeout(timer))
}

/**
 * VERIFIABLE confirmation that every outstanding code is backed up. Publishes, reads back, and
 * answers ok only when the read-back holds each code's id and every `lockedToken`. Bounded, never
 * throws, never ok on a failure to check.
 */
export async function confirmCheckoutCodeBackup(pubkey: string, options: CodesCheckOptions = {}): Promise<CodesCheck> {
  const { rounds = 2, deadlineMs = 30_000, settleMs = 1_500 } = options
  const deadline = Date.now() + deadlineMs
  const left = () => deadline - Date.now()
  let local: CheckoutCodeRecord[]
  try {
    local = loadCheckoutCodes(pubkey)
  } catch {
    return { ok: false, reason: 'store-unreadable', fingerprint: '\u0000unreadable' }
  }
  const fingerprint = codesFingerprint(pubkey)
  const open = local.filter((r) => !r.done)
  if (open.length === 0) return { ok: true, fingerprint }
  const moving = open.find(isMoving)
  if (moving) return { ok: false, reason: 'moving', code: blockingOf(moving), fingerprint }
  if (!unlocked()) return { ok: false, reason: 'locked', code: blockingOf(open[0]), fingerprint }

  let missing = open
  let read = false
  let backedNext = 0
  let backedCodes: CheckoutCodeRecord[] = []
  for (let round = 0; round <= rounds && left() > 0; round++) {
    if (round > 0 && read) {
      const next = Math.max(nextCheckoutRefundIndex(pubkey), backedNext)
      await within(publishCheckoutCodes({ codes: merged(local, backedCodes), next }), left(), undefined)
      await new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, Math.max(0, left()))))
    }
    const backed = await within(readBackCheckoutCodes(pubkey), left(), null)
    if (backed === null) continue
    read = true
    backedNext = backed.next
    backedCodes = backed.codes
    missing = open.filter((r) => !covers(backed.codes, r))
    if (missing.length === 0) return { ok: true, fingerprint }
  }
  return { ok: false, reason: 'unconfirmed', code: blockingOf(missing[0] ?? open[0]), fingerprint }
}

// --- Login ------------------------------------------------------------------

/**
 * Bring the backed-up codes back after login. A local record always wins (it is the newer one or
 * the same). The refund counter is lifted to at least `max(i)+1` over every record, and to the
 * backed counter. Never throws. Returns how many records were added.
 */
export async function restoreCheckoutCodes(pubkey: string): Promise<number> {
  try {
    const backed = await readBackCheckoutCodes(pubkey)
    if (!backed) return 0
    // Read again after the await, so a code saved meanwhile is not lost.
    const local = loadCheckoutCodes(pubkey)
    const ids = new Set(local.map((r) => r.id))
    const add = backed.codes.filter((r) => !ids.has(r.id))
    const all = [...local, ...add].sort((a, b) => b.createdAt - a.createdAt)
    if (add.length > 0) localStorage.setItem(checkoutCodesKey(pubkey), JSON.stringify(all))
    const maxI = all.flatMap((r) => r.parts.map((p) => p.i)).filter((i) => Number.isSafeInteger(i))
    const floor = Math.max(nextCheckoutRefundIndex(pubkey), backed.next, maxI.length ? Math.max(...maxI) + 1 : 0)
    if (floor !== nextCheckoutRefundIndex(pubkey)) localStorage.setItem(checkoutRefundCounterKey(pubkey), String(floor))
    return add.length
  } catch {
    return 0
  }
}
