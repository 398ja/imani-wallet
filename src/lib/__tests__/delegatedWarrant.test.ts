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

import { parseIssuanceWarrant, verifyIssuanceWarrant, warrantSaleDigest } from '../issuanceWarrant'
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

/** The delegate's signature over the sale digest, the same bytes `merchant` signs. */
function delegateSig(saleTotal = SALE_TOTAL, issuer = STALL, sk = DELEGATE_SK): string {
  return bytesToHex(
    schnorr.sign(warrantSaleDigest(issuer, saleTotal, DECIMALS, UNIT, NONCE), hexToBytes(sk)),
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
    ref: 'pi_3PzCard',
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
