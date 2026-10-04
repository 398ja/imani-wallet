/**
 * A stall's signed statement that another key may issue coupons for it.
 *
 * The `delegated` issuance warrant (see `issuanceWarrant.ts`) is signed by a
 * key that is NOT the stall's: the purchase issuer's terminal-credential lock
 * key (ADR 0009), which signs card sales at 11pm while the stall is asleep. On
 * its own that signature proves nothing, because anyone can make a key. This is
 * the second half: the STALL, with its own key, says "this key may issue for
 * me, until then". The till checks both, offline.
 *
 * ## Nothing new underneath
 *
 * - **The envelope is a Nostr event**, kind 30078, the same app-data kind every
 *   stall record already uses (`MERCHANT_KIND` in `merchant.ts`). So it is
 *   signed with the stall key exactly as the stall's profile is, it can be
 *   published to the relay beside that profile, and it is checked with
 *   `verifyEvent` exactly as `audit.ts` checks attestations.
 * - **The delegate is a `p` tag** naming a pubkey, as everywhere in Nostr.
 * - **The expiry is NIP-40's `expiration` tag**, so a relay drops the
 *   statement on its own once it lapses.
 * - **The scope is `coupon:issue`**, the permission gateway-portal already
 *   demands of anything that issues (`COUPON_ISSUE` in `merchant.ts`). Not a
 *   new vocabulary: a delegation grants exactly the authority the stall's own
 *   session holds when it sells.
 *
 * ## Why the statement travels inside the warrant
 *
 * The till verifies a coupon at the counter, often with no signal. Looking the
 * delegation up on the relay would put the network back on the redemption
 * path, which the terminals design refuses ("redemption must never wait for a
 * network"). So the whole signed event rides in the warrant, which is itself
 * inside the voucher's signed bytes, and verification needs nothing but the
 * coupon.
 *
 * ## What bounds it
 *
 * The expiry, and only the expiry, at the till. Revoking earlier is done where
 * minting happens: burning the terminal credential (`credentialRevocation.ts`)
 * stops the gateway accepting the delegate's mints at once, so a compromised
 * delegate key cannot mint new coupons. Coupons it already minted stay valid
 * until the delegation lapses, which is the same exposure a stall carries for
 * any coupon it sold.
 */
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools'

import { stripCachedVerdict } from './audit'

/** App-data, the kind every stall record uses (`MERCHANT_KIND`). */
export const DELEGATION_KIND = 30078

/**
 * The authority delegated. Equal to `COUPON_ISSUE` in `merchant.ts`, asserted
 * by `delegatedWarrant.test.ts` rather than imported, so this verifier does not
 * pull the relay client into every bundle that reads a warrant.
 */
export const DELEGATION_SCOPE = 'coupon:issue'

/**
 * The `d` tag. ONE addressable statement per stall, so publishing a new
 * delegation replaces the old one on the relay, exactly as the purchase
 * issuer's vault keeps one credential per stall (`vault.ts` `put`). The
 * delegate lives in the `p` tag rather than here, which also keeps the event
 * small: it is copied into every proof of every coupon it warrants.
 */
export const DELEGATION_D_TAG = 'imani:issuer-delegation'

const HEX64 = /^[0-9a-f]{64}$/

/**
 * The unsigned statement for a stall to sign.
 *
 * Takes the delegate and the expiry and nothing else: the stall is whoever
 * signs, never a field, for the same reason `issueBody` carries no `issuer_id`.
 */
export function issuerDelegationTemplate(input: {
  delegatePubkey: string
  /** Seconds since the epoch. Required: an unbounded delegation is refused. */
  expiresAt: number
  createdAt?: number
}): EventTemplate {
  const delegate = input.delegatePubkey.toLowerCase()
  if (!HEX64.test(delegate)) throw new Error('a delegation must name a 32-byte hex pubkey')
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error('a delegation must carry an expiry')
  }
  return {
    kind: DELEGATION_KIND,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ['d', DELEGATION_D_TAG],
      ['p', delegate],
      ['scope', DELEGATION_SCOPE],
      ['expiration', String(input.expiresAt)],
    ],
    content: '',
  }
}

export type DelegationVerdict =
  | { ok: true; delegatePubkey: string; expiresAt: number }
  | { ok: false; reason: string }

/**
 * When a delegation must have been in force.
 *
 * - A number: the current clock, epoch ms. The delegation must not have
 *   expired yet. This is what a till can check, because a coupon carries no
 *   signed issue time (cashu-voucher's secret has none).
 * - `{ issuedAt }`: the moment the coupon was issued, epoch ms, for a caller
 *   that recorded it (the stall's own issuance ledger). The delegation must
 *   have existed and not yet expired then: `created_at <= issuedAt <
 *   expiration`. A sale made inside the window stays authorised after the
 *   delegation lapses, which is what stops a past card sale flipping to
 *   "failed" in the stall's ledger the day the delegation runs out.
 */
export type DelegationMoment = number | { issuedAt: number }

/**
 * Does this event delegate `coupon:issue` for `issuerId`, at `when`?
 *
 * Every check refuses rather than defaults. The order is cheapest-first, but
 * all of them must hold: a delegation that is genuinely signed by the stall but
 * for a different scope is as useless as a forged one.
 */
export function verifyIssuerDelegation(
  raw: unknown,
  issuerId: string,
  when: DelegationMoment,
): DelegationVerdict {
  const refuse = (reason: string): DelegationVerdict => ({ ok: false, reason })

  if (raw === null || typeof raw !== 'object') return refuse('delegation is not an event')
  const event = raw as Event
  if (event.kind !== DELEGATION_KIND) return refuse('delegation has the wrong kind')
  if (!Array.isArray(event.tags)) return refuse('delegation has no tags')

  // Signed by the coupon's issuer, the stall. A valid signature by anybody
  // else is somebody delegating authority they do not have.
  if (typeof event.pubkey !== 'string' || event.pubkey.toLowerCase() !== issuerId.toLowerCase()) {
    return refuse('delegation is not signed by the coupon\u2019s issuer')
  }

  // The id and BIP-340 signature, on a copy without nostr-tools' cached
  // verdict: `audit.ts` records how a spread event inherits `true` otherwise.
  let signed = false
  try {
    signed = verifyEvent(stripCachedVerdict(event))
  } catch {
    signed = false
  }
  if (!signed) return refuse('delegation signature does not verify')

  const tag = (name: string): string[] => event.tags.filter((t) => t[0] === name).map((t) => t[1])

  // Exactly one of each. Two `p` tags would leave "which key was delegated"
  // to whichever one a reader happened to pick.
  //
  // The `d` tag first: kind 30078 is generic app data, and another app sharing
  // the stall's key could sign a record that happens to carry `p`, `scope` and
  // `expiration`. Only the stall's issuer-delegation record delegates.
  const dTags = tag('d')
  if (dTags.length !== 1 || dTags[0] !== DELEGATION_D_TAG) {
    return refuse(`delegation is not the ${DELEGATION_D_TAG} record`)
  }
  const scopes = tag('scope')
  if (scopes.length !== 1 || scopes[0] !== DELEGATION_SCOPE) {
    return refuse(`delegation scope is not ${DELEGATION_SCOPE}`)
  }
  const delegates = tag('p')
  if (delegates.length !== 1 || typeof delegates[0] !== 'string' || !HEX64.test(delegates[0])) {
    return refuse('delegation must name exactly one delegate key')
  }
  const expirations = tag('expiration')
  const expiresAt = Number(expirations[0])
  if (expirations.length !== 1 || !Number.isSafeInteger(expiresAt)) {
    return refuse('delegation must carry exactly one expiry')
  }
  if (typeof when === 'number') {
    if (expiresAt * 1000 <= when) return refuse('delegation has expired')
  } else {
    if (!Number.isSafeInteger(event.created_at) || event.created_at * 1000 > when.issuedAt) {
      return refuse('the coupon was issued before the delegation was signed')
    }
    if (expiresAt * 1000 <= when.issuedAt) {
      return refuse('the coupon was issued after the delegation expired')
    }
  }

  return { ok: true, delegatePubkey: delegates[0], expiresAt }
}
