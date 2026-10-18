import type { EventTemplate, Event } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

import { isRedeemed, spendable } from './merchants'
import { getSigner } from './nap'
import { allEvents, allEventsWithGateway, publish, type PublishResult } from './relay'
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
import { addRestoredVoucher, getWallet, notifyWalletChanged } from './wallet'

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
  // Only once the tombstone is ON the relay: the chunks of a spent coupon are
  // dead weight from here on (#206 review L2).
  try {
    const signer = getSigner()
    const chunks = (await allEvents(signer.pubkey, NIP60_TOKEN_KIND)).filter(
      (e) => isChunkEvent(e) && recordIdOf(e) === tokenId,
    )
    await requestDeletion(chunks.map((e) => e.id))
  } catch (error) {
    console.warn('[voucherRecords] spent coupon chunks not cleaned up', error)
  }
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
    if (!seen || entry.at > seen.at) newest.set(entry.id, { at: entry.at, row })
  }

  return [...newest.entries()].filter(([id]) => !spent.has(id)).map(([, v]) => v.row)
}

async function liveRecords(events: Event[], pubkey: string): Promise<VoucherRow[]> {
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
  return pickLive(entries)
}

/**
 * Is this coupon still spendable, according to the mint?
 *
 * Inconclusive means KEEP. A gateway that is down or a call that throws must not
 * cost the user a live coupon — a phantom coupon fails visibly at spend time,
 * while a dropped one is silently gone. Only a definite SPENT verdict discards.
 */
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
    const candidates = await liveRecords(
      await allEventsWithGateway(pubkey, NIP60_TOKEN_KIND),
      pubkey,
    )
    if (candidates.length === 0) return 0

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
    if (restored + written > 0) notifyWalletChanged()
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
 * The held coupons with NO confirmed backup: no live record on the relay or the
 * gateway whose token is this row's CURRENT token. Each gap is re-published
 * once and checked again; what is still missing is returned.
 *
 * "Confirmed" means readable back by the same path a restore uses, decrypted
 * with this key, untombstoned, and carrying the same token bytes. Matching on
 * the token and not only on `d` is what catches a record that holds an older
 * token for the coupon (a pre-swap or pre-split copy), which a restore would
 * find SPENT.
 *
 * For logout, which deletes the device copy: a coupon in this list is money
 * that exists nowhere else, so logging out would lose it (2026-10-18 incident,
 * and the logout warning promised the opposite). Never throws: a failure to
 * check reports every held coupon as a gap, the safe direction.
 */
export async function couponsWithoutBackup(pubkey: string): Promise<VoucherRow[]> {
  let held: VoucherRow[]
  try {
    held = spendable(await getWallet().getAllVouchers()).filter((row) => row.token)
  } catch {
    // No open store: nothing on this device to lose.
    return []
  }
  if (held.length === 0) return []

  const gaps = async (): Promise<VoucherRow[]> => {
    try {
      const live = await liveRecords(await allEventsWithGateway(pubkey, NIP60_TOKEN_KIND), pubkey)
      const backed = new Set(live.map((row) => row.token))
      return held.filter((row) => !backed.has(row.token))
    } catch (error) {
      console.error('[voucherRecords] could not confirm coupon backups', error)
      return held
    }
  }

  const missing = await gaps()
  if (missing.length === 0) return []
  for (const row of missing) await publishVoucher(row)
  return gaps()
}
