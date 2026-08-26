import type { EventTemplate, Event } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

import { isRedeemed } from './merchants'
import { getSigner } from './nap'
import { allEvents, publish } from './relay'
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

function buildRecord(tokenId: string, record: TokenRecord): EventTemplate {
  const signer = getSigner()
  return {
    kind: NIP60_TOKEN_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // `spent` as a tag as well as in the payload: a future reader can skip
    // tombstones without decrypting them.
    tags: [
      ['d', tokenId],
      ['spent', record.spent ? 'true' : 'false'],
    ],
    content: signer.nip44Encrypt(signer.pubkey, JSON.stringify(record)),
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
    await publish(await getSigner().signEvent(buildRecord(row.token_id, { voucher: row })))
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
    await publish(await getSigner().signEvent(buildRecord(tokenId, { spent: true })))
  } catch (error) {
    console.error('[voucherRecords] spent coupon not tombstoned on the relay', error)
  }
}

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

function liveRecords(events: Event[]): VoucherRow[] {
  const entries = []
  for (const event of events) {
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
    const candidates = liveRecords(await allEvents(pubkey, NIP60_TOKEN_KIND))
    if (candidates.length === 0) return 0

    // Sequential on purpose: each check is a NIP-98-signed gateway request, and
    // a wallet with fifty coupons should not open fifty of them at once on a
    // phone. Logins are already past `setReady`, so nothing is waiting on this.
    let restored = 0
    for (const row of candidates) {
      // A burnt coupon is SPENT at the mint BY DESIGN — that is what redeeming
      // one does (see burn.ts). Asking the mint about it would discard the
      // receipt the merchant is meant to keep, so the status answers first.
      if (!isRedeemed(row) && !(await isStillLive(row.token))) continue
      await addRestoredVoucher(row)
      restored += 1
    }

    if (restored > 0) notifyWalletChanged()
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
export async function backfillVouchers(pubkey: string): Promise<number> {
  try {
    const known = new Set(
      (await allEvents(pubkey, NIP60_TOKEN_KIND))
        .map((e) => e.tags.find(([name]) => name === 'd')?.[1])
        .filter((d): d is string => Boolean(d)),
    )

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
