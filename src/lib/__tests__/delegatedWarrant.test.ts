/**
 * The till verifies a `delegated` issuance warrant (#152 follow-through).
 *
 * A delegated warrant is the card path's answer to "who outside the issuing
 * service authorised this coupon": the stall signs ONE delegation naming a key
 * it trusts to issue for it (the purchase issuer's terminal-credential lock
 * key), and that key signs each sale over the same digest a `merchant` warrant
 * signs. The till checks both signatures offline.
 *
 * Every refusal below is a forgery a compromised issuing service, or a stranger,
 * could otherwise put in front of a customer.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent } from 'nostr-tools/pure'

import {
  delegatedSaleDigest,
  parseIssuanceWarrant,
  verifyIssuanceWarrant,
  warrantSaleDigest,
} from '../issuanceWarrant'
import {
  DELEGATION_KIND,
  DELEGATION_SCOPE,
  issuerDelegationTemplate,
  verifyIssuerDelegation,
} from '../issuerDelegation'
import { COUPON_ISSUE } from '../merchant'

const STALL_SK = 'a'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const OTHER_STALL_SK = 'c'.repeat(63) + '3'
const DELEGATE_SK = 'd'.repeat(63) + '4'
const DELEGATE = bytesToHex(schnorr.getPublicKey(hexToBytes(DELEGATE_SK)))

const NOW_MS = 1_800_000_000_000
const IN_A_YEAR_S = Math.floor(NOW_MS / 1000) + 400 * 86_400
const SALE_TOTAL = 2500
const DECIMALS = 2
const UNIT = 'GBP'
const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const REF = 'pi_3PzCard'

function coupon(faceValueMinor = SALE_TOTAL) {
  return { faceValueMinor, unit: UNIT, faceDecimals: DECIMALS }
}

/** A delegation event signed by `signerSk`, with any field overridden. */
function delegation(
  over: { signerSk?: string; delegate?: string; scope?: string; expiresAt?: number } = {},
) {
  const template = issuerDelegationTemplate({
    delegatePubkey: over.delegate ?? DELEGATE,
    expiresAt: over.expiresAt ?? IN_A_YEAR_S,
    createdAt: Math.floor(NOW_MS / 1000) - 60,
  })
  if (over.scope !== undefined) {
    template.tags = template.tags.map((t) => (t[0] === 'scope' ? ['scope', over.scope!] : t))
  }
  return finalizeEvent(template, hexToBytes(over.signerSk ?? STALL_SK))
}

/** The delegate's signature over the sale digest plus the processor reference. */
function delegateSig(saleTotal = SALE_TOTAL, issuer = STALL, sk = DELEGATE_SK): string {
  return bytesToHex(
    schnorr.sign(
      delegatedSaleDigest(issuer, saleTotal, DECIMALS, UNIT, NONCE, REF),
      hexToBytes(sk),
    ),
  )
}

function warrantJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    form: 'delegated',
    sale_total: SALE_TOTAL,
    face_decimals: DECIMALS,
    unit: UNIT,
    nonce: NONCE,
    sig: delegateSig(),
    delegation: delegation(),
    ref: REF,
    ...over,
  })
}

function verify(json: string, issuer = STALL, face = SALE_TOTAL) {
  return verifyIssuanceWarrant(parseIssuanceWarrant(json), issuer, coupon(face), { now: NOW_MS })
}

describe('a delegated warrant from a validly delegated key', () => {
  // The happy path: the stall delegated coupon:issue to this key, it has not
  // expired, and the key signed this sale. The till accepts it as verified.
  it('is verified', () => {
    expect(verify(warrantJson())).toEqual({ verdict: 'verified' })
  })

  // A split part of the sale is still under the ceiling, so it still verifies.
  it('covers a split part of the sale, like any warrant', () => {
    expect(verify(warrantJson(), STALL, 900).verdict).toBe('verified')
  })

  // The processor reference survives parsing, so reconciliation can still
  // match a card coupon to its payment.
  it('keeps the processor reference for reconciliation', () => {
    const w = parseIssuanceWarrant(warrantJson())
    expect(w).toMatchObject({ state: 'present', form: 'delegated', reference: 'pi_3PzCard' })
  })

  // The scope string is the gateway's own issuance permission, not a new one.
  it('uses the existing coupon:issue permission as its scope', () => {
    expect(DELEGATION_SCOPE).toBe(COUPON_ISSUE)
  })
})

describe('a delegated warrant the till refuses', () => {
  // Someone delegates to their own key and names our stall as the issuer. The
  // delegation's signature is valid, just not by the coupon's issuer.
  it('refuses a delegation signed by a different merchant', () => {
    const json = warrantJson({ delegation: delegation({ signerSk: OTHER_STALL_SK }) })
    expect(verify(json).verdict).toBe('failed')
  })

  // The stall's authority lapsed. A delegation is bounded, and past its expiry
  // it authorises nothing.
  it('refuses an expired delegation', () => {
    const json = warrantJson({
      delegation: delegation({ expiresAt: Math.floor(NOW_MS / 1000) - 1 }),
    })
    expect(verify(json).verdict).toBe('failed')
  })

  // A delegation for some other purpose must not be stretched to issuance.
  it('refuses a delegation with the wrong scope', () => {
    const json = warrantJson({ delegation: delegation({ scope: 'coupon:redeem' }) })
    expect(verify(json).verdict).toBe('failed')
  })

  // The delegate signed a different sale (a smaller total) and the signature
  // was replayed onto a bigger one: different bytes, refused.
  it('refuses a delegate signature over different bytes', () => {
    const json = warrantJson({ sig: delegateSig(100) })
    expect(verify(json).verdict).toBe('failed')
  })

  // The delegate signed for another stall's digest. Same delegate, wrong bytes.
  it('refuses a delegate signature made for another issuer', () => {
    const json = warrantJson({ sig: delegateSig(SALE_TOTAL, 'e'.repeat(64)) })
    expect(verify(json).verdict).toBe('failed')
  })

  // A key the stall never delegated signs the sale, carrying a genuine
  // delegation for someone else. The delegation names a different key.
  it('refuses a signature by a key the delegation does not name', () => {
    const json = warrantJson({ sig: delegateSig(SALE_TOTAL, STALL, '5'.repeat(63) + 'f') })
    expect(verify(json).verdict).toBe('failed')
  })

  // A delegation that was edited after signing (here: pointed at a new key)
  // no longer verifies as the stall's event.
  it('refuses a tampered delegation', () => {
    const d = delegation()
    const tampered = {
      ...JSON.parse(JSON.stringify(d)),
      tags: d.tags.map((t) => (t[0] === 'p' ? ['p', 'f'.repeat(64)] : t)),
    }
    expect(verify(warrantJson({ delegation: tampered })).verdict).toBe('failed')
  })

  // No delegation at all: a bare signature by an unknown key proves nothing.
  // Refused at parse rather than half-checked.
  it('refuses a delegated warrant that carries no delegation', () => {
    const json = warrantJson({ delegation: undefined })
    expect(parseIssuanceWarrant(json).state).toBe('invalid')
    expect(verify(json).verdict).toBe('failed')
  })

  // An unsigned processor warrant is still a claim nobody here can check.
  it('still reports an unsigned processor warrant as only claimed', () => {
    const json = JSON.stringify({
      form: 'processor',
      sale_total: SALE_TOTAL,
      face_decimals: DECIMALS,
      unit: UNIT,
      nonce: NONCE,
      ref: 'pi_3PzForged',
    })
    expect(verify(json).verdict).toBe('claimed')
  })
})

describe('the delegation statement on its own', () => {
  // The statement is a kind-30078 app-data event like every other stall record,
  // so the stall can publish it to the relay and see what it has delegated.
  it('is an addressable kind-30078 event naming the delegate', () => {
    const d = delegation()
    expect(d.kind).toBe(DELEGATION_KIND)
    expect(DELEGATION_KIND).toBe(30078)
    expect(d.tags).toContainEqual(['d', 'imani:issuer-delegation'])
    expect(d.tags).toContainEqual(['p', DELEGATE])
  })

  // Verifies to the delegate key when everything holds, so the issuing service
  // can check its own configuration before it mints anything.
  it('verifies to the delegate key for its own stall', () => {
    expect(verifyIssuerDelegation(delegation(), STALL, NOW_MS)).toEqual({
      ok: true,
      delegatePubkey: DELEGATE,
      expiresAt: IN_A_YEAR_S,
    })
  })

  // The cached-verdict hole `audit.ts` documents: spreading a verified event
  // and replacing its signature must not inherit the earlier `true`.
  it('does not trust a cached verification on a copied event', () => {
    const d = delegation()
    expect(verifyIssuerDelegation(d, STALL, NOW_MS).ok).toBe(true)
    const forged = { ...d, sig: 'ff'.repeat(64) }
    expect(verifyIssuerDelegation(forged, STALL, NOW_MS).ok).toBe(false)
  })
})

describe('the processor reference is part of what the delegate signed (#176 review)', () => {
  // Someone rewrites the Stripe reference on a genuine card coupon so the
  // stall's ledger points at a different payment. The delegate signed the
  // original reference, so the edited warrant no longer verifies.
  it('refuses a warrant whose ref was changed after signing', () => {
    const json = warrantJson({ ref: 'pi_3PzSomeoneElse' })
    expect(verify(json).verdict).toBe('failed')
  })

  // Dropping the reference is an edit too: the delegate signed one, and a
  // warrant without it is not the warrant that was signed.
  it('refuses a warrant whose ref was removed after signing', () => {
    const json = warrantJson({ ref: undefined })
    expect(verify(json).verdict).toBe('failed')
  })

  // The delegate signing the plain sale digest (the `merchant` bytes, which do
  // not cover the reference) is not a delegated warrant either.
  it('refuses a delegate signature over the merchant digest', () => {
    const merchantBytes = bytesToHex(
      schnorr.sign(
        warrantSaleDigest(STALL, SALE_TOTAL, DECIMALS, UNIT, NONCE),
        hexToBytes(DELEGATE_SK),
      ),
    )
    expect(verify(warrantJson({ sig: merchantBytes })).verdict).toBe('failed')
  })
})

describe('the delegation must be the stall issuer-delegation record (#176 review)', () => {
  /** A stall-signed delegation whose `d` tags are replaced by `dTags`. */
  function withDTags(dTags: string[][]) {
    const template = issuerDelegationTemplate({
      delegatePubkey: DELEGATE,
      expiresAt: IN_A_YEAR_S,
      createdAt: Math.floor(NOW_MS / 1000) - 60,
    })
    template.tags = [...dTags, ...template.tags.filter((t) => t[0] !== 'd')]
    return finalizeEvent(template, hexToBytes(STALL_SK))
  }

  // Another app's kind-30078 record, signed by the same stall key, that happens
  // to carry p, scope and expiration tags. It was never meant as a delegation.
  it('refuses a stall-signed event with a foreign d tag', () => {
    const json = warrantJson({ delegation: withDTags([['d', 'some-other-app:settings']]) })
    expect(verify(json).verdict).toBe('failed')
  })

  // No d tag at all is not the addressable delegation record either.
  it('refuses a stall-signed event with no d tag', () => {
    expect(verify(warrantJson({ delegation: withDTags([]) })).verdict).toBe('failed')
  })

  // Two d tags leave "which record is this" to whichever one a reader picks.
  it('refuses a delegation carrying two d tags', () => {
    const json = warrantJson({
      delegation: withDTags([['d', 'imani:issuer-delegation'], ['d', 'other']]),
    })
    expect(verify(json).verdict).toBe('failed')
  })
})

describe('judging a past sale by when it was issued (#176 review)', () => {
  const EXPIRES_S = Math.floor(NOW_MS / 1000) + 30 * 86_400
  const LATER_MS = (EXPIRES_S + 90 * 86_400) * 1000
  const short = () => delegation({ expiresAt: EXPIRES_S })

  // The stall's own ledger looks back at a card sale made while the delegation
  // was live. Months later the delegation has lapsed, but the sale was
  // authorised when it happened, so the ledger still reads it as verified.
  it('verifies a sale issued inside the delegation window after it lapses', () => {
    const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(warrantJson({ delegation: short() })), STALL, coupon(), {
      now: LATER_MS,
      issuedAt: NOW_MS,
    })
    expect(verdict).toEqual({ verdict: 'verified' })
  })

  // A sale recorded after the delegation lapsed was never authorised by it.
  it('refuses a sale issued after the delegation expired', () => {
    const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(warrantJson({ delegation: short() })), STALL, coupon(), {
      now: LATER_MS,
      issuedAt: (EXPIRES_S + 1) * 1000,
    })
    expect(verdict.verdict).toBe('failed')
  })

  // A sale recorded before the stall had signed the delegation was not
  // authorised by it either: the delegation did not exist yet.
  it('refuses a sale issued before the delegation was created', () => {
    const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(warrantJson({ delegation: short() })), STALL, coupon(), {
      now: NOW_MS,
      issuedAt: NOW_MS - 2 * 86_400_000,
    })
    expect(verdict.verdict).toBe('failed')
  })

  // With no recorded issue time (the till, holding a coupon that carries no
  // signed issue time) the check stays at the current clock, as before.
  it('still checks against now when no issue time is known', () => {
    const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(warrantJson({ delegation: short() })), STALL, coupon(), {
      now: LATER_MS,
    })
    expect(verdict.verdict).toBe('failed')
  })
})
