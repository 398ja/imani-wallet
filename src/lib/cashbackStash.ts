import { verifyEvent, type Event } from 'nostr-tools'

import { getSigner } from './nap'
import { allEventsWithGateway, publish } from './relay'
import { mirrorToGateway } from './transferSignature'
import { buildRecordEvents, isChunkEvent, reassembleRecords, recordIdOf, type Sealer } from './chunkedRecord'

/**
 * The backup of the cashback stash (#331, owner decision 2026-10-19: "back it up first").
 *
 * WHAT THE STASH HOLDS. `imani:cashback:pending` (cashback.ts) is a JSON list of
 * cashu token strings: cashback claimed from the holding store (a destructive
 * claim, it answers 410 afterwards) and not yet swapped into the wallet. A
 * token waits there when the app died between the claim and the swap, when the
 * trusted-mint gate holds it, when the mint refuses it, or when a merchant
 * account refused another stall's voucher. `replayPendingCashback` retries every
 * entry on each visit to the redeem screen and drops one only when it is banked.
 * The key sits outside the `imani-wallet:` prefix, so logout never sweeps it.
 *
 * THE MECHANISM. Reuse the encrypted record path the terminal roster uses
 * (`terminalRosterSyncNet.ts`): one kind-30078 record, `d=imani:cashback-stash`,
 * NIP-44 sealed to the account's own key, chunked when big, published to the
 * relay AND mirrored to the gateway. Confirmation is a READ BACK from relay ∪
 * gateway, signature-checked, decrypted, holding every token the stash holds,
 * the same standard `confirmBackups` sets for vouchers. Banking the stash into
 * a voucher first was rejected: the stash exists because banking failed or is
 * not allowed (untrusted mint, merchant refusal), so it is neither safe nor
 * bounded to force it at logout.
 *
 * RESTORE. `restoreCashbackStash` merges the record's tokens into the local
 * stash at login, and the redeem screen's replay banks them as before.
 *
 * GARBAGE AND STALE ENTRIES. Only entries that look like a token (`cashu…`) are
 * backed up or required, so a garbage entry never blocks. A stale entry (a
 * token already swapped, perhaps restored from an older record) is backed up
 * like any other, so it cannot block either; the replay drops it once the mint
 * says it is spent (cashback.ts).
 */

export const STASH_KIND = 30078
export const STASH_D_TAG = 'imani:cashback-stash'
export const PENDING_KEY = 'imani:cashback:pending'

/** The raw stash, as cashback.ts reads it. Throws when storage cannot be read. */
function readRawStash(): string[] {
  const raw = localStorage.getItem(PENDING_KEY)
  if (!raw) return []
  if (raw.startsWith('cashu')) return [raw]
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string' && t.length > 0) : []
  } catch {
    return []
  }
}

/** The entries that are value: token strings. Garbage is not money and never blocks. */
export function stashValue(tokens: readonly string[]): string[] {
  return [...new Set(tokens.filter((t) => /^cashu[A-Za-z]/.test(t)))].sort()
}

/** Identity of the stash's value, for logout's race check. */
export function stashFingerprint(): string {
  try {
    return stashValue(readRawStash()).join('|')
  } catch {
    return '\u0000unreadable'
  }
}

function selfSealer(): Sealer {
  const signer = getSigner()
  return {
    encrypt: (plain) => signer.nip44Encrypt(signer.pubkey, plain),
    decrypt: (cipher) => signer.nip44Decrypt(signer.pubkey, cipher),
  }
}

/** The tokens in this account's newest readable stash record ([] when none). Null when nothing answered. */
export async function readBackStash(pubkey: string): Promise<string[] | null> {
  let events: Event[]
  try {
    events = await allEventsWithGateway(pubkey, STASH_KIND)
  } catch {
    return null
  }
  const mine = events.filter((e) => {
    if (e.pubkey !== pubkey || e.kind !== STASH_KIND || recordIdOf(e) !== STASH_D_TAG) return false
    const { id, created_at, kind, tags, content, sig } = e
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  })
  const unique = [...new Map(mine.map((e) => [e.id, e])).values()]
  const sealer = selfSealer()
  const candidates: Array<{ at: number; tokens: string[] }> = []
  const consider = (at: number, text: string) => {
    try {
      const parsed = JSON.parse(text) as { tokens?: unknown }
      if (Array.isArray(parsed.tokens)) {
        candidates.push({ at, tokens: parsed.tokens.filter((t): t is string => typeof t === 'string') })
      }
    } catch {
      // A record that does not parse confirms nothing.
    }
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
  // The NEWEST record is the stash (a replaceable record), so a token banked
  // since an older one is not brought back by a restore.
  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]?.tokens ?? []
}

async function publishStash(tokens: string[]): Promise<void> {
  const signer = getSigner()
  const plaintext = JSON.stringify({ v: 1, tokens })
  const templates = await buildRecordEvents(STASH_KIND, STASH_D_TAG, plaintext, [], selfSealer())
  for (const template of templates) {
    const event = (await signer.signEvent(template)) as Event
    await Promise.all([publish(event).catch(() => undefined), mirrorToGateway(event).catch(() => false)])
  }
}

/** How long an empty stash may spend clearing a stale record at logout. */
const EMPTY_CLEAR_MS = 5_000

/** Replace a non-empty record with an empty one. Best effort, never throws. */
async function clearStaleStash(pubkey: string): Promise<void> {
  // Locked or no session: nothing could be signed, so do not even ask the network.
  const signer = getSigner() as { hasKey?: () => boolean }
  if (typeof signer.hasKey === 'function' && !signer.hasKey()) return
  const backed = await readBackStash(pubkey)
  if (backed && stashValue(backed).length > 0) await publishStash([])
}

export type StashCheck =
  | { ok: true; fingerprint: string; count: number }
  | { ok: false; reason: 'locked' | 'unconfirmed' | 'store-unreadable'; count: number; fingerprint: string }

export interface StashCheckOptions {
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
 * VERIFIABLE confirmation that every token in the stash is backed up. Publishes
 * the stash, reads it back, and answers ok only when every token is in a record
 * signed by this account and decrypted with its key. Bounded. NEVER THROWS, and
 * never answers ok on a failure to check.
 */
export async function confirmStashBackup(pubkey: string, options: StashCheckOptions = {}): Promise<StashCheck> {
  const { rounds = 2, deadlineMs = 30_000, settleMs = 1_500 } = options
  const deadline = Date.now() + deadlineMs
  const left = () => deadline - Date.now()

  let held: string[]
  try {
    held = stashValue(readRawStash())
  } catch {
    return { ok: false, reason: 'store-unreadable', count: 0, fingerprint: '\u0000unreadable' }
  }
  const fingerprint = held.join('|')
  if (held.length === 0) {
    // Nothing to back up, so nothing blocks. But a record left from an earlier
    // logout still names tokens banked since, and the next login's restore would
    // bring them back as phantom "waiting" cashback (review of #334, D1). Cleared
    // best effort, in a short bound: an unreachable relay must not slow logout.
    await within(clearStaleStash(pubkey), Math.min(left(), EMPTY_CLEAR_MS), undefined)
    return { ok: true, fingerprint, count: 0 }
  }

  let unlocked: boolean
  try {
    const signer = getSigner() as { hasKey?: () => boolean }
    unlocked = typeof signer.hasKey !== 'function' || signer.hasKey()
  } catch {
    unlocked = false
  }
  if (!unlocked) return { ok: false, reason: 'locked', count: held.length, fingerprint }

  let missing = held.length
  // Every token is in the newest record: the money is safe. If that record also
  // names tokens banked since, it is republished so a restore does not bring
  // them back (D1); failing that is not a reason to block.
  let covered = false
  for (let round = 0; round <= rounds && left() > 0; round++) {
    if (round > 0) {
      await within(publishStash(held), left(), undefined)
      await new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, Math.max(0, left()))))
    }
    const backed = await within(readBackStash(pubkey), left(), null)
    if (backed === null) continue
    const have = new Set(backed)
    missing = held.filter((t) => !have.has(t)).length
    if (missing === 0) {
      covered = true
      if (stashValue(backed).length === held.length) return { ok: true, fingerprint, count: held.length }
    }
  }
  if (covered) return { ok: true, fingerprint, count: held.length }
  return { ok: false, reason: 'unconfirmed', count: missing, fingerprint }
}

/**
 * Bring a backed-up stash back after login: merge its tokens into the local
 * stash. Never throws, never removes a local entry. Returns how many were added.
 */
export async function restoreCashbackStash(pubkey: string): Promise<number> {
  try {
    const backed = await readBackStash(pubkey)
    if (!backed || backed.length === 0) return 0
    const local = readRawStash()
    const add = stashValue(backed).filter((t) => !local.includes(t))
    if (add.length === 0) return 0
    localStorage.setItem(PENDING_KEY, JSON.stringify([...local, ...add]))
    return add.length
  } catch {
    return 0
  }
}
