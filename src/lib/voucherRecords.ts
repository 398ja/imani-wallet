import { verifyEvent, type EventTemplate, type Event } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

import { isRedeemed, spendable } from './merchants'
import { getSigner } from './nap'
import { allEventsWithGateway, eventsByD, publish, type PublishResult } from './relay'
import { noteSpentLocally } from './spentCoupons'
import {
  buildRecordEvents,
  isChunkEvent,
  reassembleChunkSets,
  reassembleRecords,
  recordIdOf,
  type ChunkingOptions,
  type Sealer,
} from './chunkedRecord'
import { legacyApi } from './legacyBridge'
import { addRestoredVoucher, getWallet, notifyWalletChanged, openWallet } from './wallet'
import { signedFetch } from './nip98'

/**
 * The coupons themselves, backed by the key instead of the browser.
 *
 * `txRecords.ts` put the LEDGER on the relay and deliberately left the money on
 * the device: a wiped browser kept the record of what it had done and lost every
 * unspent coupon. That is survivable for a merchant, whose screens are a ledger.
 * It is not survivable for a customer, whose coupons ARE the wallet — a customer
 * who logged out came back to "No coupons yet" and a zero balance, and nothing
 * could bring it back. Re-reading the gift wraps cannot: the tokens were swapped
 * at the mint when they first arrived, so replaying them fails.
 *
 * So each unspent coupon is also published as a NIP-60 token event (kind 7375),
 * `d` = the coupon's `token_id`, NIP-44 sealed to the owner's OWN key. This DOES
 * put bearer value on the relay, as ciphertext — the deliberate reversal of the
 * rule `txRecords.ts` states. The tradeoff was taken knowingly: whoever holds the
 * nsec already holds the money, and imani-apps' kind-37375 snapshot has been
 * publishing tokens the same way all along.
 *
 * Two rules make it safe to read back:
 *
 * - **A spend publishes a tombstone**, and a tombstone is FINAL. A coupon whose
 *   proofs are burnt must never come back as a balance, and `token_id` is
 *   sha256(token) — content-derived — so an id that was spent is spent forever.
 *   Any tombstone therefore beats every record for that id, regardless of
 *   `created_at`. Newest-wins would be a race: publish and spend within the same
 *   second and the relay may replay them in either order.
 * - **Restore asks the mint.** Even with tombstones, a publish lost to a closing
 *   tab could leave a spent coupon looking live. NUT-07 checkstate, via the
 *   gateway's `/api/v1/wallet/token/validate`, is the authority on that.
 */

/**
 * `restore_flag` on a restored row the mint calls SPENT although no tombstone
 * says this wallet spent it. See `restoreVouchers`.
 */
export const RESTORE_FLAG_MINT_SPENT = 'mint-spent-without-tombstone'

/** swapBack.SWAPPED_TO_SATS_STATUS, compared here without importing swapBack's mint graph. */
function isSwappedToSats(row: Pick<VoucherRow, 'status'>): boolean {
  return (row.status ?? '').toLowerCase() === 'swapped_to_sats'
}

/** NIP-60's token event. Regular kind, like 7376 — `d` is identity, not replacement. */
export const NIP60_TOKEN_KIND = 7375

/**
 * A coupon record, or the note that its coupon is gone.
 *
 * The row goes in VERBATIM rather than field-by-field. It is already the shape
 * `saveVoucher` accepts, the store re-derives `token_id` on write, and a
 * hand-picked subset is how a field like `issuance_ratio` — which every merchant
 * total is computed from — goes missing on the device that restores.
 */
export interface TokenRecord {
  spent?: boolean
  voucher?: VoucherRow
}

/**
 * How big a single record may get before it is chunked, set HERE rather than
 * through the library's global `configure()`: its defaults (400 KB / 350 KB)
 * suit relays far looser than strfry's 65,536, and other users of the library
 * should keep them. See chunkedRecord.ts for the size model.
 */
export const VOUCHER_CHUNKING: ChunkingOptions = {}

function selfSealer(): Sealer {
  const signer = getSigner()
  return {
    encrypt: (plain) => signer.nip44Encrypt(signer.pubkey, plain),
    decrypt: (cipher) => signer.nip44Decrypt(signer.pubkey, cipher),
  }
}

/**
 * The events for one record (#203).
 *
 * A record that fits is ONE plain NIP-60 kind-7375 event, `d` = token_id, exactly
 * as before and readable by any NIP-60 wallet. One that would not fit under the
 * relay's 65,536-byte limit after NIP-44 (a terminal coupon with 7 warrant-laden
 * proofs is about 66 KB) goes out as gzip-compressed chunks: `d` = `<token_id>-chunk-<n>`,
 * sharing a snapshot_id and payload_hash. Tombstones are tiny and always plain.
 */
function buildRecords(tokenId: string, record: TokenRecord): Promise<EventTemplate[]> {
  // `spent` as a tag as well as in the payload: a future reader can skip
  // tombstones without decrypting them.
  return buildRecordEvents(
    NIP60_TOKEN_KIND,
    tokenId,
    JSON.stringify(record),
    [['spent', record.spent ? 'true' : 'false']],
    selfSealer(),
    VOUCHER_CHUNKING,
  )
}

/**
 * Sign and publish every event of a record. Throws with the relay's own reason
 * when any event is not accepted: a record missing one chunk is not backed up.
 */
async function publishRecords(templates: EventTemplate[]): Promise<void> {
  const signer = getSigner()
  for (const template of templates) {
    const result: PublishResult = await publish(await signer.signEvent(template))
    if (result.ok === 0) {
      throw new Error(`relay refused the record: ${result.errors.join('; ') || 'no reason given'}`)
    }
  }
}

/**
 * Publish one coupon. Never throws.
 *
 * The coupon is already in IndexedDB and the money has already moved; a relay
 * that will not take the record has not undone either. The cost of a failure is
 * one coupon unrecoverable until the next login, when `backfillVouchers`
 * publishes it.
 */
export async function publishVoucher(row: VoucherRow): Promise<void> {
  try {
    if (!row.token_id || !row.token) {
      // Loud, because this returning quietly is what cost a staging customer
      // their coupons: `token_id` is derived by the store, so a row taken from
      // a writer's ARGUMENT rather than from the store has none, and every
      // coupon went unbacked-up with nothing in the console to say so. Callers
      // now hand over stored rows (`mirrorWritten` in wallet.ts); a row
      // reaching here without an id is a bug in a caller, not a normal case.
      console.warn('[voucherRecords] coupon has no token_id — not backed up', {
        voucher_id: row.voucher_id,
      })
      return
    }
    await publishRecords(await buildRecords(row.token_id, { voucher: row }))
  } catch (error) {
    console.error('[voucherRecords] coupon not backed up to the relay', error)
  }
}

/**
 * Mark a coupon spent. Never throws.
 *
 * A failure here is the dangerous direction — the coupon stays restorable and
 * would come back as money that cannot be spent — so `restoreVouchers` checks
 * every proof against the mint rather than trusting tombstones alone.
 */
export async function tombstoneVoucher(tokenId: string): Promise<void> {
  try {
    if (!tokenId) return
    await publishRecords(await buildRecords(tokenId, { spent: true }))
  } catch (error) {
    console.error('[voucherRecords] spent coupon not tombstoned on the relay', error)
    return
  }
  // #540 F7: this device's own tombstone goes into the warm spent set at once, so the next send
  // neither offers the coupon nor re-reads every record to learn it.
  try {
    noteSpentLocally(getSigner().pubkey, tokenId)
  } catch {
    // No signer: nothing cached for it either.
  }
  // Only once the tombstone is ON the relay: the chunks of a spent coupon are
  // dead weight from here on (#206 review L2).
  try {
    const signer = getSigner()
    // #540 F6: only this coupon's chunks, by their `d` tags, never every 7375 event of the
    // account (1.5 MB per spend on a large one). The chunk filter stays as a check.
    const chunks = (await eventsByD(signer.pubkey, NIP60_TOKEN_KIND, chunkDTags(tokenId))).filter(
      (e) => isChunkEvent(e) && recordIdOf(e) === tokenId,
    )
    await requestDeletion(chunks.map((e) => e.id))
  } catch (error) {
    console.warn('[voucherRecords] spent coupon chunks not cleaned up', error)
  }
}

/**
 * #540 F6: every `d` a chunk of one record can carry: `<id>-state` for a record of one chunk and
 * `<id>-chunk-<n>` otherwise (nostr-chunked-events). A coupon record is at most about 66 KB, a
 * couple of chunks, so `MAX_RECORD_CHUNKS` is far above any real one.
 */
export const MAX_RECORD_CHUNKS = 64
export function chunkDTags(tokenId: string): string[] {
  return [`${tokenId}-state`, ...Array.from({ length: MAX_RECORD_CHUNKS }, (_, n) => `${tokenId}-chunk-${n}`)]
}

/**
 * Ask the relay to delete our own kind-7375 events (NIP-09). ADVISORY ONLY: a
 * relay may ignore it, so nothing ever depends on it. A tombstone stays the
 * authority on spent, and newest-complete-snapshot stays the rule on restore.
 * It exists to bound growth, which also keeps a wallet under the relay's
 * per-filter cap for longer (#206 review L2, M2).
 */
async function requestDeletion(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return
  const signer = getSigner()
  // Bounded batches keep each kind-5 event far under the relay's size limit.
  for (let i = 0; i < eventIds.length; i += DELETION_BATCH) {
    const ids = eventIds.slice(i, i + DELETION_BATCH)
    const result = await publish(
      await signer.signEvent({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [...ids.map((id) => ['e', id]), ['k', String(NIP60_TOKEN_KIND)]],
        content: 'superseded or spent coupon backup',
      }),
    )
    if (result.ok === 0) console.warn('[voucherRecords] relay refused a deletion request', result.errors)
  }
}

/** 500 `e` tags is about 38 KB: well under 65,536. */
const DELETION_BATCH = 500

/**
 * Snapshot keys already warned about this session (#206 review L3). An orphan
 * of a failed publish stays on the relay; without this it warned on every
 * restore, forever. Orphans of a coupon that has since been republished are
 * not reported at all (see reassembleRecords).
 */
const warnedChunkSets = new Set<string>()

function parseRecord(event: Event): { id: string; record: TokenRecord } | null {
  try {
    const id = event.tags.find(([name]) => name === 'd')?.[1]
    if (!id) return null
    const signer = getSigner()
    const record = JSON.parse(signer.nip44Decrypt(signer.pubkey, event.content)) as TokenRecord
    return { id, record }
  } catch {
    // Written by another key, or by a version that changed the shape. One
    // unreadable record must not abort the restore of all the others.
    return null
  }
}

/**
 * Two records of one coupon in the SAME second: which is newer? (review of #326)
 *
 * `created_at` is seconds, and swapBack writes `fully_redeemed` then
 * `swapped_to_sats` around one mint round trip, so both records often share a
 * second. First-seen used to win, so the relay's replay order decided whether
 * a restore showed the sats. The row's own millisecond `updated_at` decides,
 * then the serialised row, so the answer never depends on order.
 */
function laterRow(candidate: VoucherRow, current: VoucherRow): boolean {
  const a = String(candidate.updated_at ?? '')
  const b = String(current.updated_at ?? '')
  if (a !== b) return a > b
  return JSON.stringify(candidate) > JSON.stringify(current)
}

/**
 * Newest record per `token_id`, with any tombstone winning outright.
 *
 * Exported for tests: "a tombstone always wins" is the rule standing between a
 * restore and a wallet full of coupons whose proofs are already burnt, and it
 * has to hold whatever order the relay replays events in.
 */
export function pickLive(entries: { id: string; at: number; record: TokenRecord }[]): VoucherRow[] {
  const spent = new Set<string>()
  const newest = new Map<string, { at: number; row: VoucherRow }>()

  for (const entry of entries) {
    if (entry.record.spent) {
      spent.add(entry.id)
      continue
    }
    const row = entry.record.voucher
    if (!row?.token) continue
    const seen = newest.get(entry.id)
    if (!seen || entry.at > seen.at || (entry.at === seen.at && laterRow(row, seen.row))) {
      newest.set(entry.id, { at: entry.at, row })
    }
  }

  return [...newest.entries()].filter(([id]) => !spent.has(id)).map(([, v]) => v.row)
}

/** Every coupon id a tombstone says is spent, with its newest tombstone's `created_at` (seconds). */
export function tombstonedIds(entries: { id: string; at: number; record: TokenRecord }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of entries) if (e.record.spent) out.set(e.id, Math.max(out.get(e.id) ?? 0, e.at))
  return out
}

async function liveRecords(events: Event[], pubkey: string): Promise<VoucherRow[]> {
  return pickLive(await recordEntries(events, pubkey))
}

async function recordEntries(
  events: Event[],
  pubkey: string,
): Promise<{ id: string; at: number; record: TokenRecord }[]> {
  const entries: { id: string; at: number; record: TokenRecord }[] = []

  // Chunked records (#203): reassembled, hash-checked and decompressed first.
  // An incomplete or corrupted set is skipped, never half-read.
  const chunked = await reassembleRecords(events, pubkey, selfSealer(), (id, reason, set) => {
    const key = set.snapshotId ?? set.eventIds.slice().sort().join(',')
    if (warnedChunkSets.has(key)) return
    warnedChunkSets.add(key)
    console.warn('[voucherRecords] chunked coupon record unreadable; skipped', { id, reason })
  })
  for (const { id, at, plaintext } of chunked) {
    try {
      entries.push({ id, at, record: JSON.parse(plaintext) as TokenRecord })
    } catch {
      // Same rule as parseRecord: one bad record does not abort the rest.
    }
  }

  for (const event of events) {
    if (isChunkEvent(event)) continue
    // Skip a tombstone without decrypting it.
    //
    // `buildRecord` puts `spent` in a TAG as well as in the payload, exactly so
    // a reader can do this — the comment there says so — but the reader
    // decrypted everything anyway. Every decrypt is a NIP-44 open, and a wallet
    // accumulates one tombstone per coupon it has ever spent, so on a wallet
    // with history most of that work was for records `pickLive` then discarded.
    //
    // Measured on a 120-coupon fixture: 240 relay events, all tombstoned,
    // every one decrypted and every one thrown away.
    //
    // The tag is only a hint, and it is treated as one: it can only make the
    // reader do LESS work, and a tombstone that reaches `pickLive` undecrypted
    // is still a tombstone. An event whose tag says `false`, or which carries
    // no such tag, takes the old path untouched.
    const spentTag = event.tags.find(([name]) => name === 'spent')?.[1]
    if (spentTag === 'true') {
      const id = event.tags.find(([name]) => name === 'd')?.[1]
      if (id) {
        entries.push({ id, at: event.created_at, record: { spent: true } as TokenRecord })
        continue
      }
    }

    const parsed = parseRecord(event)
    if (parsed) entries.push({ id: parsed.id, at: event.created_at, record: parsed.record })
  }
  return entries
}

/**
 * Rows the cross-device passes may mark: plain held money only. Anything else is either settled
 * (spent, redeemed, swapped) or mid-flight (a send, lock, split, return), whose own saga owns the
 * row and will settle it; marking it under that saga could hide its change or its return.
 */
function markable(row: VoucherRow): boolean {
  const status = (row.status ?? '').toLowerCase()
  return status === '' || status === 'active'
}

/**
 * The token ids an in-flight ledger still holds (pending send, bundle, checkout code, Cashlink
 * intent). Read through pay.ts's `withoutInFlight`, imported lazily: pay.ts imports wallet.ts,
 * which imports this file. `null` when it cannot be read, so the caller marks nothing.
 */
async function inFlightIds(pubkey: string | undefined, rows: VoucherRow[]): Promise<Set<string> | null> {
  try {
    const owner = pubkey ?? getSigner().pubkey
    const { withoutInFlight } = await import('./pay')
    const free = new Set(withoutInFlight(rows, owner).map((r) => r.token_id))
    return new Set(rows.filter((r) => r.token_id && !free.has(r.token_id)).map((r) => r.token_id!))
  } catch (error) {
    console.warn('[voucherRecords] in-flight ledgers unreadable, nothing marked', error)
    return null
  }
}

/** The row's last local write (receive, restore, return), in seconds. 0 when unknown. */
function lastWriteSec(row: VoucherRow): number {
  const ms = Math.max(Date.parse(row.updated_at ?? '') || 0, Date.parse(row.created_at ?? '') || 0)
  return Math.floor(ms / 1000)
}

/**
 * Mark held coupons a tombstone names as spent. Returns how many changed.
 * Written through `addRestoredVoucher`, so it does not republish anything.
 *
 * Only a tombstone NEWER than the row's last local write counts: the same token_id can come back
 * after its tombstone (a Cashlink taken back, an aborted or returned send, a restore), and that
 * copy is money again. An older tombstone is left to the mint check.
 */
async function applyTombstones(spentAt: Map<string, number>, pubkey?: string): Promise<number> {
  if (spentAt.size === 0) return 0
  const rows = (await getWallet().getAllVouchers()).filter(
    (row) => row.token_id && markable(row) && (spentAt.get(row.token_id) ?? -1) > lastWriteSec(row),
  )
  if (rows.length === 0) return 0
  const held = await inFlightIds(pubkey, rows)
  if (!held) return 0
  let changed = 0
  for (const row of rows) {
    if (held.has(row.token_id!)) continue
    await addRestoredVoucher({ ...row, status: 'spent' } as VoucherRow)
    noteSpent(row.token_id!)
    changed += 1
  }
  return changed
}

function noteSpent(tokenId: string): void {
  try {
    noteSpentLocally(getSigner().pubkey, tokenId)
  } catch {
    // No signer: nothing cached for it either.
  }
}

/**
 * NUT-07 pass over the coupons this device counts as money (#cross-device).
 *
 * The local store is not the authority on balance: a spend made on another
 * device whose tombstone never reached this one (lost publish, closed tab,
 * relay gap) leaves a row here that the mint has already burnt. Only a
 * definite SPENT answer marks a row; anything inconclusive keeps it.
 * Rows are marked `spent` (never deleted), so a wrong answer is visible and
 * recoverable. Never throws. Returns how many rows it marked.
 */
export async function pruneMintSpent(pubkey?: string): Promise<number> {
  try {
    const all = (await getWallet().getAllVouchers()).filter((row) => row.token && row.token_id && markable(row))
    if (all.length === 0) return 0
    const held = await inFlightIds(pubkey, all)
    if (!held) return 0
    const rows = all.filter((row) => !held.has(row.token_id!))
    // The gateway's validate endpoint takes one token, so no batch: a bounded pool instead, and
    // the first network error stops the pass, so a mint that is down costs one timeout, not N.
    const api = (await legacyApi()) as unknown as {
      validateToken(token: string): Promise<{ valid?: boolean; state?: string } | null>
    }
    const spent: VoucherRow[] = []
    let next = 0
    let down = false
    const worker = async () => {
      while (!down && next < rows.length) {
        const row = rows[next++]
        try {
          if (((await api.validateToken(row.token))?.state ?? '').toUpperCase() === 'SPENT') spent.push(row)
        } catch (error) {
          if (!down) console.warn('[voucherRecords] mint unreachable, state check stopped', error)
          down = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PRUNE_CONCURRENCY, rows.length) }, worker))
    let changed = 0
    for (const row of spent) {
      await addRestoredVoucher({ ...row, status: 'spent' } as VoucherRow)
      noteSpent(row.token_id!)
      changed += 1
    }
    if (changed > 0) {
      console.info(`[voucherRecords] ${changed} coupon(s) spent at the mint marked spent`)
      notifyWalletChanged()
    }
    return changed
  } catch (error) {
    console.warn('[voucherRecords] mint state check skipped', error)
    return 0
  }
}

/** NUT-07 calls in flight at once during `pruneMintSpent`. */
export const PRUNE_CONCURRENCY = 4

/**
 * Is this coupon still spendable, according to the mint?
 *
 * Inconclusive means KEEP. A gateway that is down or a call that throws must not
 * cost the user a live coupon — a phantom coupon fails visibly at spend time,
 * while a dropped one is silently gone. Only a definite SPENT verdict discards.
 */
// #261 review: kept as a single read. The relay record is not deleted on SPENT: the row is written
// as `spent` with RESTORE_FLAG_MINT_SPENT and the relay copy stays, so nothing is lost for good, and
// support can find it by that flag. Not re-read automatically, on purpose: a flagged row is skipped on
// later restores (see `flagged`) so a coupon the mint refuses is never turned back into a balance.
async function isStillLive(token: string): Promise<boolean> {
  try {
    const api = (await legacyApi()) as unknown as {
      validateToken(token: string): Promise<{ valid?: boolean; state?: string }>
    }
    const result = await api.validateToken(token)
    return result?.state !== 'SPENT'
  } catch (error) {
    console.warn('[voucherRecords] could not check a coupon against the mint; keeping it', error)
    return true
  }
}

/**
 * Rebuild this device's coupons from the relay.
 *
 * Runs on every login, not only on an empty wallet — a coupon received on
 * another device belongs here too, and `saveVoucher` keys on the
 * content-derived `token_id`, so re-writing one this device already has is an
 * overwrite rather than a duplicate.
 *
 * Writes through `addRestoredVoucher`, which bypasses the publish hook;
 * otherwise every login would republish everything it just read.
 *
 * Never throws. Returns how many coupons were written.
 */
export async function restoreVouchers(pubkey: string): Promise<number> {
  try {
    // Relay AND gateway (#2026-10-18 incident). Relay-only, a browser that
    // could not open a socket to strfry read as "no coupons" and restored a
    // zero balance over a coupon whose record was sitting on the relay.
    const entries = await recordEntries(await allEventsWithGateway(pubkey, NIP60_TOKEN_KIND), pubkey)
    const candidates = pickLive(entries)
    // Cross-device spends: a tombstone published by ANOTHER device for a
    // coupon THIS device holds. `pickLive` only answers "what is live", so the
    // held copy used to stay `active` forever and kept counting as balance.
    const applied = await applyTombstones(tombstonedIds(entries), pubkey)
    if (candidates.length === 0) {
      if (applied > 0) notifyWalletChanged()
      return 0
    }

    // What this device already has, read once.
    //
    // A coupon already in the store is not being restored — it is being
    // re-read — and asking the mint about it buys nothing: it is already the
    // customer's, it will be checked at spend time like any other, and a
    // wallet that dropped it on a bad answer would be losing money it holds
    // over a network round trip it did not need to make.
    //
    // Measured before this: a returning customer with 120 coupons made 120
    // sequential gateway calls on every login and took 12.8s to finish, having
    // restored nothing it did not already have (#44).
    const heldRows = await getWallet().getAllVouchers()
    const held = new Set(
      heldRows.map((row) => row.token_id).filter((id): id is string => Boolean(id)),
    )
    // A row this device already flagged as SPENT-without-tombstone stays
    // flagged: the relay copy says `active`, and re-writing it would turn a
    // coupon the mint refuses back into a balance.
    const flagged = new Set(
      heldRows
        .filter((row) => (row as { restore_flag?: string }).restore_flag === RESTORE_FLAG_MINT_SPENT)
        .map((row) => row.token_id),
    )

    // Sequential on purpose: each check is a NIP-98-signed gateway request, and
    // a wallet with fifty coupons should not open fifty of them at once on a
    // phone. Logins are already past `setReady`, so nothing is waiting on this.
    let restored = 0
    let written = 0
    for (const row of candidates) {
      // Already here. Written through anyway, because the relay copy may be
      // newer than this device's — `saveVoucher` keys on the content-derived
      // token_id, so this is an overwrite — but with no mint call, which is
      // the expensive half.
      if (row.token_id && held.has(row.token_id)) {
        if (flagged.has(row.token_id)) continue
        await addRestoredVoucher(row)
        // Counted as written, not as restored. `restored` drives the log line
        // and the change notification, and a relay copy that is newer than
        // this device's still changed the store — the screens reading it need
        // to hear that, even though nothing was recovered.
        written += 1
        continue
      }

      // A burnt coupon is SPENT at the mint BY DESIGN — that is what redeeming
      // one does (see burn.ts). Asking the mint about it would discard the
      // receipt the merchant is meant to keep, so the status answers first.
      // A coupon swapped back to sats is SPENT at the mint by design too: the
      // swap back consumed its proofs, and its value lives in `sats_token`.
      // Asking about the original token flipped it to 'spent' and hid the
      // sats (review of #326), so its status and `sats_token` stand as backed up.
      if (!isRedeemed(row) && !isSwappedToSats(row) && !(await isStillLive(row.token))) {
        // The mint says SPENT, yet no tombstone says THIS wallet spent it.
        // That is either a spend whose tombstone was lost (benign) or a coupon
        // whose backup holds proofs this wallet never got to keep — money
        // lost on the way to the backup, the case this restore used to drop
        // without a trace. Kept as a row the wallet does not count as money
        // (`isSpent` reads 'spent' everywhere, wallet-core included), with a
        // flag that says why, and reported loudly, so support can see it.
        await addRestoredVoucher({
          ...row,
          status: 'spent',
          restore_flag: RESTORE_FLAG_MINT_SPENT,
        } as VoucherRow)
        console.error(
          '[voucherRecords] restored coupon is SPENT at the mint with no tombstone; kept as flagged',
          { token_id: row.token_id, voucher_id: row.voucher_id },
        )
        written += 1
        continue
      }
      await addRestoredVoucher(row)
      restored += 1
    }

    // Any write at all, not only a recovery: a screen showing a stale copy of
    // a coupon this device already had is still showing the wrong thing.
    if (restored + written + applied > 0) notifyWalletChanged()
    return restored
  } catch (error) {
    console.error('[voucherRecords] could not restore coupons from the relay', error)
    return 0
  }
}

/**
 * Publish records for coupons this device holds that the relay does not know —
 * everything received before this existed, or whose publish lost the race with a
 * closing tab. Cheap: one query, then only what is missing.
 */
async function pruneSuperseded(
  records: { id: string; at: number; eventIds: string[] }[],
  rejected: { id?: string; eventIds: string[] }[],
): Promise<void> {
  // Keep the newest verified snapshot of each coupon; everything else chunked
  // for that coupon (older snapshots, orphans of a failed publish) is dead.
  // A coupon with no verified snapshot keeps all its chunks: never delete the
  // only copy of anything.
  try {
    const newest = new Map<string, { at: number; eventIds: string[] }>()
    for (const r of records) {
      const cur = newest.get(r.id)
      if (!cur || r.at > cur.at) newest.set(r.id, r)
    }
    const keep = new Set([...newest.values()].flatMap((r) => r.eventIds))
    const dead = [...records, ...rejected]
      .filter((r) => r.id !== undefined && newest.has(r.id))
      .flatMap((r) => r.eventIds)
      .filter((id) => !keep.has(id))
    await requestDeletion([...new Set(dead)])
  } catch (error) {
    console.warn('[voucherRecords] superseded coupon chunks not cleaned up', error)
  }
}

export async function backfillVouchers(pubkey: string): Promise<number> {
  try {
    // Both stores, for the same reason restore reads both: a relay read that
    // failed would otherwise make every coupon look missing and republish all
    // of them. Harmless (records are idempotent by `d`) but wasteful, and the
    // republish would fail against the same unreachable relay anyway.
    const events = await allEventsWithGateway(pubkey, NIP60_TOKEN_KIND)
    // A plain record counts by its `d`; a chunked one only once a snapshot
    // decrypts, validates and matches its payload hash, so a half-landed or
    // corrupt set is published again (#203, #206 review L4). Once per login.
    const { records, rejected } = await reassembleChunkSets(events, pubkey, selfSealer())
    const known = new Set(records.map((r) => r.id))
    await pruneSuperseded(records, rejected)
    for (const event of events) {
      if (isChunkEvent(event)) continue
      const id = recordIdOf(event)
      if (id) known.add(id)
    }

    const missing = (await getWallet().getAllVouchers()).filter(
      (row) => row.token_id && !known.has(row.token_id),
    )

    for (const row of missing) await publishVoucher(row)
    return missing.length
  } catch (error) {
    console.error('[voucherRecords] could not back-fill coupons to the relay', error)
    return 0
  }
}

/**
 * The rows logout must see backed up (owner rule 2026-10-18, review of #326):
 * money (`spendable`), and the two statuses that are not money to spend but
 * still carry value. `fully_redeemed` proofs are still the holder's (they are
 * offered "Swap back to sats"), and a `swapped_to_sats` row's value lives in
 * its `sats_token`. A licence or a terminal credential is not a held coupon.
 */
export function rowsNeedingBackup(rows: VoucherRow[]): VoucherRow[] {
  return rows.filter((row) => {
    if (!row.token) return false
    if (spendable([row]).length === 1) return true
    const status = (row.status ?? '').toLowerCase()
    return status === 'fully_redeemed' || status === 'swapped_to_sats'
  })
}

/**
 * Does this backed-up row hold what the device holds?
 *
 * The token BYTES must be equal: a record of an older token (pre-swap,
 * pre-split) restores as SPENT. For the value-carrying statuses the status
 * must match too, and a `swapped_to_sats` row's `sats_token` must be equal,
 * because that token IS the value: a backup of the row as `fully_redeemed`
 * would restore proofs the swap back has already spent.
 */
function sameValue(backed: VoucherRow, held: VoucherRow): boolean {
  if (backed.token !== held.token) return false
  const status = (held.status ?? '').toLowerCase()
  if (status === 'fully_redeemed' || status === 'swapped_to_sats') {
    if ((backed.status ?? '').toLowerCase() !== status) return false
  }
  if (status === 'swapped_to_sats') {
    const a = (backed as { sats_token?: string }).sats_token
    const b = (held as { sats_token?: string }).sats_token
    if (!b || a !== b) return false
  }
  return true
}

/** One held coupon whose backup could not be confirmed. No token: it goes to the UI. */
export interface UnconfirmedCoupon {
  token_id: string
  face_value?: number
  face_unit?: string
  face_decimals?: number
  status?: string
  /** For a coupon swapped back to sats, its value. */
  sats_amount?: number
}

export type BackupCheck =
  | {
      ok: true
      /** How many held coupons were confirmed. */
      confirmed: number
      /** Identity of the confirmed set: logout's race check compares it. */
      fingerprint: string
    }
  | {
      ok: false
      /** 'locked': the key is not unlocked, so no backup can be read back or made. */
      reason: 'unconfirmed' | 'locked' | 'store-unreadable'
      unconfirmed: UnconfirmedCoupon[]
      fingerprint: string
    }

/** Bounds for `confirmBackups`. Every one is a ceiling, so the UI never hangs. */
export interface ConfirmOptions {
  /** Re-publish-and-re-read rounds after the first read. Default 2. */
  rounds?: number
  /** The whole check, publishes included. Default 45 s. */
  deadlineMs?: number
  /** Let a fresh publish reach the gateway's cache before reading back. Default 1.5 s. */
  settleMs?: number
}

const CONFIRM_DEFAULTS: Required<ConfirmOptions> = { rounds: 2, deadlineMs: 45_000, settleMs: 1_500 }

/** The held set's identity: token_id, token hash and status per row, sorted. */
export function heldFingerprint(rows: VoucherRow[]): string {
  return rowsNeedingBackup(rows)
    .map((row) => {
      const sats = (row as { sats_token?: string }).sats_token ?? ''
      return `${row.token_id}:${row.status ?? ''}:${row.token.length}:${hashish(row.token)}:${hashish(sats)}`
    })
    .sort()
    .join('|')
}

/** A cheap, non-cryptographic digest: the fingerprint compares, it does not protect. */
function hashish(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function describeCoupon(row: VoucherRow): UnconfirmedCoupon {
  return {
    token_id: row.token_id,
    face_value: row.face_value,
    face_unit: row.face_unit,
    face_decimals: row.face_decimals,
    status: row.status,
    ...(typeof (row as { sats_amount?: number }).sats_amount === 'number'
      ? { sats_amount: (row as { sats_amount?: number }).sats_amount }
      : {}),
  }
}

/**
 * Read every coupon record back from the relay AND the gateway and keep only
 * what this user signed (review of #326).
 *
 * `allEventsWithGateway` already checks the gateway's copies. The relay's are
 * checked here as well: for logout this read is the only thing standing
 * between a delete and the money, so it does not lean on the relay library
 * having verified what it handed over.
 */
async function readBackRecords(pubkey: string): Promise<VoucherRow[]> {
  const events = (await allEventsWithGateway(pubkey, NIP60_TOKEN_KIND)).filter((event) => {
    if (event.pubkey !== pubkey || event.kind !== NIP60_TOKEN_KIND) return false
    const { id, created_at, kind, tags, content, sig } = event
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  })
  return liveRecords(events, pubkey)
}

/** The held rows with no read-back record of the same value. */
function gapsIn(held: VoucherRow[], backed: VoucherRow[]): VoucherRow[] {
  const byId = new Map<string, VoucherRow[]>()
  for (const row of backed) {
    const list = byId.get(row.token_id) ?? []
    list.push(row)
    byId.set(row.token_id, list)
  }
  // Also by token: `d` is the store's token_id, but match on the bytes either way.
  const byToken = new Map<string, VoucherRow[]>()
  for (const row of backed) {
    const list = byToken.get(row.token) ?? []
    list.push(row)
    byToken.set(row.token, list)
  }
  return held.filter((row) => {
    const candidates = [...(byId.get(row.token_id) ?? []), ...(byToken.get(row.token) ?? [])]
    return !candidates.some((backedRow) => sameValue(backedRow, row))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `promise`, or `fallback` once `ms` has passed. Never rejects. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), Math.max(0, ms)))),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * VERIFIABLE confirmation that every held coupon is backed up (owner rule
 * 2026-10-18 17:52Z: "Never allow a logout until we have verifiable
 * confirmation that the vouchers were backed up").
 *
 * For each row in `rowsNeedingBackup`, a record must be READ BACK from the
 * relay ∪ the gateway, signed by this user, decrypted with this key, not
 * tombstoned, and holding the SAME token bytes (and status / `sats_token` for
 * the value-carrying statuses). A relay saying OK to a publish is not
 * confirmation; only reading it back is.
 *
 * Gaps are re-published and read back again, up to `rounds` times, inside one
 * overall deadline. NEVER THROWS, and never answers `ok` on a failure to
 * check: an unreadable store, a locked key, a deadline or an exception all
 * answer "not confirmed", the direction that keeps the money.
 *
 * Opens the store if it is not open: logout from the "Session expired" dialog
 * runs with no wallet open, and "nothing open" is NOT "nothing held".
 */
export async function confirmBackups(pubkey: string, options: ConfirmOptions = {}): Promise<BackupCheck> {
  const { rounds, deadlineMs, settleMs } = { ...CONFIRM_DEFAULTS, ...options }
  const deadline = Date.now() + deadlineMs
  const left = () => deadline - Date.now()

  let held: VoucherRow[]
  try {
    // THIS user's store, whatever is open: `openWallet` is a no-op for the
    // identity already open, and logout erases `imani-wallet-<pubkey>`, so
    // that is the store whose rows must be counted. Reading whatever handle
    // happened to be open could count another account's (empty) coupons.
    const ws = await openWallet(pubkey)
    held = rowsNeedingBackup(await ws.getAllVouchers())
  } catch (error) {
    console.error('[voucherRecords] could not read the coupons to confirm their backup', errorName(error))
    return { ok: false, reason: 'store-unreadable', unconfirmed: [], fingerprint: '' }
  }
  const fingerprint = heldFingerprint(held)
  if (held.length === 0) return { ok: true, confirmed: 0, fingerprint }

  // Reading back needs the key (NIP-44), and so does re-publishing.
  // An idle lock keeps the signer object and zeroes its key (`clearKey`), so
  // "no signer" alone misses the common case (second check of #326).
  let unlocked: boolean
  try {
    const signer = getSigner() as { hasKey?: () => boolean }
    unlocked = typeof signer.hasKey !== 'function' || signer.hasKey()
  } catch {
    unlocked = false
  }
  if (!unlocked) return { ok: false, reason: 'locked', unconfirmed: held.map(describeCoupon), fingerprint }

  let missing = held
  for (let round = 0; round <= rounds && left() > 0; round++) {
    if (round > 0) {
      for (const row of missing) {
        if (left() <= 0) break
        await within(publishVoucher(row), left(), undefined)
        await within(mirrorRecordToGateway(row), left(), undefined)
      }
      await sleep(Math.min(settleMs, Math.max(0, left())))
    }
    const backed = await within(readBackRecords(pubkey), left(), null)
    if (backed === null) continue
    missing = gapsIn(held, backed)
    if (missing.length === 0) return { ok: true, confirmed: held.length, fingerprint }
  }
  console.warn('[voucherRecords] coupon backups not confirmed', { count: missing.length })
  return { ok: false, reason: 'unconfirmed', unconfirmed: missing.map(describeCoupon), fingerprint }
}

/** An error's NAME only: messages from the store or a relay can quote a row. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/**
 * Store a coupon's record in the gateway's cache as well (review of #326).
 * NEVER THROWS.
 *
 * The 2026-10-18 incident was a browser that could not reach the relay. A
 * re-publish to that same relay fails the same way, so logout could never
 * confirm. `POST /api/v1/nostr/events` (NIP-98, signature re-checked by the
 * gateway) puts the signed event where `/nostr/query` reads, which is the
 * read the restore falls back on. The event is NIP-44 sealed to this user;
 * the gateway learns no more than it already serves.
 */
async function mirrorRecordToGateway(row: VoucherRow): Promise<void> {
  try {
    if (!row.token_id) return
    const signer = getSigner()
    for (const template of await buildRecords(row.token_id, { voucher: row })) {
      const event = await signer.signEvent(template)
      const response = await signedFetch(
        '/api/v1/nostr/events',
        'POST',
        {
          id: event.id,
          pubkey: event.pubkey,
          createdAt: event.created_at,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: event.sig,
        },
        undefined,
        { signal: AbortSignal.timeout(8_000) },
      )
      if (!response.ok) return
    }
  } catch {
    // Best effort; the read-back is the verdict either way.
  }
}
