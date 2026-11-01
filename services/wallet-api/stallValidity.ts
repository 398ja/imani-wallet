/**
 * How long a stall's coupons live, for a coupon issued headless through this service
 * (imani-wallet#359).
 *
 * Every other issuance path already uses the stall's own term: the Sell screen and the till read
 * `merchant.voucherValidityDays`, cashback sends it to the portal, and card sales read it at mint
 * time (purchase-issuer `stallValidity.ts`, #312/#315). This service stamped a fixed 30 days on
 * any request that named no term, so a 90-day stall issuing from a script got 30-day coupons and
 * a never-expiring stall got coupons that expired.
 *
 * ## What is trusted
 *
 * The same rules as purchase-issuer: kind 30078, exactly one `d=imani:merchant`, authored by the
 * stall, and a BIP-340 signature that verifies. The NEWEST such event wins. The term itself is
 * read by `validityFromRecord` from `@imani/merchant-record`, the one copy of the rules the Sell
 * screen and the card path share.
 *
 * ## What "no answer" means
 *
 * - Read, and the stall has no signed record or no valid term: the stall's DEFAULT
 *   (`DEFAULT_VALIDITY_DAYS`, never expires), exactly what the Sell screen would do.
 * - Could not read: `unreadable`. Nothing is minted on a guess; the caller is told 503 and may
 *   retry, or name a term itself.
 */

import type { Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { MERCHANT_D_TAG, MERCHANT_KIND, validityFromRecord } from '@imani/merchant-record'

export type StallValidity =
  | { kind: 'days'; days: number; source: 'record' | 'default' }
  | { kind: 'unreadable'; reason: string }

export type ValidityReader = (stallPubkey: string) => Promise<StallValidity>

/**
 * NIP-01: the id is sha256 of the canonical array, and the signature is over the id. Verified
 * here with @noble, as `nip98.ts` does, NOT with nostr-tools' `verifyEvent`: this service imports
 * nothing from nostr-tools that can sign (`cannotSpend.test.ts`), and `verifyEvent` trusts a
 * verdict cached on the object, which a spread copy carries along with a forged pubkey.
 */
function signedBy(event: Event): boolean {
  try {
    const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
    const id = bytesToHex(sha256(utf8ToBytes(canonical)))
    if (id !== event.id.toLowerCase()) return false
    const sig = hexToBytes(event.sig.toLowerCase())
    const pub = hexToBytes(event.pubkey.toLowerCase())
    return sig.length === 64 && pub.length === 32 && schnorr.verify(sig, hexToBytes(id), pub)
  } catch {
    return false
  }
}

/** Is this event the stall's own, signed, merchant record? */
export function isStallMerchantRecord(event: Event, stallPubkey: string): boolean {
  if (event.kind !== MERCHANT_KIND) return false
  if (event.pubkey.toLowerCase() !== stallPubkey.toLowerCase()) return false
  const dTags = event.tags.filter((t) => Array.isArray(t) && t[0] === 'd')
  if (dTags.length !== 1 || dTags[0][1] !== MERCHANT_D_TAG) return false
  return signedBy(event)
}

/** The stall's term from candidate events: the newest it signed, else its default. Pure. */
export function validityFromEvents(events: Event[], stallPubkey: string): StallValidity {
  const newest = events
    .filter((e) => isStallMerchantRecord(e, stallPubkey))
    .sort((a, b) => b.created_at - a.created_at)[0]
  if (!newest) return { kind: 'days', days: validityFromRecord('{}'), source: 'default' }
  return { kind: 'days', days: validityFromRecord(newest.content), source: 'record' }
}

/**
 * A reader over an event query. The query THROWS when it could not ask (see `stallLookup.ts`
 * `queryRelay`, which is passed in production), and that throw is the only `unreadable`.
 */
export function createValidityReader(query: (pubkey: string) => Promise<Event[]>): ValidityReader {
  return async (stallPubkey) => {
    const stall = stallPubkey.toLowerCase()
    let events: Event[]
    try {
      events = await query(stall)
    } catch (error) {
      return { kind: 'unreadable', reason: error instanceof Error ? error.message : 'relay error' }
    }
    return validityFromEvents(events, stall)
  }
}
