/**
 * The warrant reader, under the attack it exists to refuse.
 *
 * The cross-language cases matter most. The merchant's device signs in
 * TypeScript and the gateway verifies in Java, or the reverse, so a digest that
 * differs by one byte between them is a scheme where every genuine coupon is
 * refused and nobody can tell why. `warrantDigestParity.test.ts` pins the
 * digest against vectors produced by the Java implementation.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  parseIssuanceWarrant,
  verifyIssuanceWarrant,
  warrantSaleDigest,
  warrantCovers,
  warrantOverstatement,
} from '../issuanceWarrant'

// A stall key. In production this sits on the merchant's own device and never
// on a server, which is the whole reason a warrant means anything.
const STALL_SK = 'a'.repeat(63) + '1'
const STALL_PUB = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))

// Someone holding the ISSUING SERVICE key but not the stall's.
const ATTACKER_SK = 'b'.repeat(63) + '2'

const SALE_TOTAL = 2500 // EUR 25.00
const DECIMALS = 2
const UNIT = 'EUR'
const NONCE = 'b7f3a1c2d4e5f607'

/** The coupon a warrant is checked against: EUR, 2 decimals, given value. */
function coupon(faceValueMinor: number, unit = UNIT, faceDecimals = DECIMALS) {
  return { faceValueMinor, unit, faceDecimals }
}

function warrantJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    form: 'merchant',
    sale_total: SALE_TOTAL,
    face_decimals: DECIMALS,
    unit: UNIT,
    nonce: NONCE,
    sig: signAsStall(SALE_TOTAL),
    ...over,
  })
}

function signAsStall(saleTotal: number): string {
  return bytesToHex(
    schnorr.sign(
      warrantSaleDigest(STALL_PUB, saleTotal, DECIMALS, UNIT, NONCE),
      hexToBytes(STALL_SK),
    ),
  )
}

describe('the attack', () => {
  it('a genuine warrant verifies offline against the stall', () => {
    const warrant = parseIssuanceWarrant(warrantJson())
    expect(verifyIssuanceWarrant(warrant, STALL_PUB, coupon(SALE_TOTAL))).toEqual({ verdict: 'verified' })
  })

  it('a warrant forged with the SERVICE key is refused', () => {
    // The finding: whoever holds the issuing service key can mint a coupon
    // naming any stall. What they cannot do is warrant it.
    const forged = bytesToHex(
      schnorr.sign(
        warrantSaleDigest(STALL_PUB, SALE_TOTAL, DECIMALS, UNIT, NONCE),
        hexToBytes(ATTACKER_SK),
      ),
    )
    const warrant = parseIssuanceWarrant(warrantJson({ sig: forged }))
    const result = verifyIssuanceWarrant(warrant, STALL_PUB, coupon(SALE_TOTAL))

    expect(result.verdict).toBe('failed')
  })

  it('a GENUINE warrant replayed onto an inflated coupon is refused', () => {
    // The sharp case. No forged signature: a real warrant from a real EUR 25.00
    // sale, attached to a coupon minted for EUR 50,000.00. The signature
    // verifies perfectly. Only the ceiling refuses it.
    const warrant = parseIssuanceWarrant(warrantJson())
    const result = verifyIssuanceWarrant(warrant, STALL_PUB, coupon(5_000_000))

    expect(result.verdict).toBe('failed')
    expect(result).toMatchObject({ reason: expect.stringContaining('exceeds warranted') })
  })

  it('inflating the claimed sale total breaks the signature instead', () => {
    // The other door. If the attacker raises the warrant's own total so the
    // ceiling passes, the digest moves and the real signature stops verifying.
    const warrant = parseIssuanceWarrant(
      warrantJson({ sale_total: 5_000_000 }), // signature still over 2500
    )
    expect(verifyIssuanceWarrant(warrant, STALL_PUB, coupon(5_000_000)).verdict).toBe('failed')
  })

  it('a warrant for a DIFFERENT CURRENCY is refused', () => {
    // Found in review, and it was a real hole.
    //
    // A merchant genuinely authorises XAF 2500, which is about EUR 3.80. The
    // warrant ships inside every coupon of that sale, so it is public. Attach
    // it to a EUR 2500 coupon - EUR 25.00, a hundred times more - and BOTH of
    // the other checks pass:
    //
    //   signature: genuine, recomputed from the warrant's own unit, so valid
    //   ceiling:   2500 <= 2500, passes
    //
    // Every check compares bare NUMBERS, and numbers in different currencies
    // are not comparable. Only an explicit denomination check catches this.
    const nonce = 'xaf-sale'
    const xafDigest = warrantSaleDigest(STALL_PUB, 2500, 0, 'XAF', nonce)
    const xafWarrant = parseIssuanceWarrant(
      JSON.stringify({
        form: 'merchant',
        sale_total: 2500,
        face_decimals: 0,
        unit: 'XAF',
        nonce,
        sig: bytesToHex(schnorr.sign(xafDigest, hexToBytes(STALL_SK))),
      }),
    )

    // Sanity: it is a perfectly good warrant for an XAF coupon.
    expect(
      verifyIssuanceWarrant(xafWarrant, STALL_PUB, coupon(2500, 'XAF', 0)).verdict,
    ).toBe('verified')

    // And useless against a EUR one.
    const result = verifyIssuanceWarrant(xafWarrant, STALL_PUB, coupon(2500, 'EUR', 2))
    expect(result.verdict).toBe('failed')
    expect(result).toMatchObject({ reason: expect.stringContaining('XAF') })
  })

  it('a warrant with matching unit but different DECIMALS is refused', () => {
    // The subtler half. Same currency code, different scale: a warrant for
    // 2500 at 0 decimals is 2500 whole units, while a coupon at 2 decimals is
    // 25.00. Decimals are part of what an amount MEANS.
    const nonce = 'scale'
    const warrant = parseIssuanceWarrant(
      JSON.stringify({
        form: 'merchant',
        sale_total: 2500,
        face_decimals: 0,
        unit: 'EUR',
        nonce,
        sig: bytesToHex(
          schnorr.sign(warrantSaleDigest(STALL_PUB, 2500, 0, 'EUR', nonce), hexToBytes(STALL_SK)),
        ),
      }),
    )

    expect(verifyIssuanceWarrant(warrant, STALL_PUB, coupon(2500, 'EUR', 2)).verdict)
      .toBe('failed')
  })

  it('a warrant cannot be moved to another stall', () => {
    const otherStall = bytesToHex(schnorr.getPublicKey(hexToBytes(ATTACKER_SK)))
    const warrant = parseIssuanceWarrant(warrantJson())

    expect(verifyIssuanceWarrant(warrant, otherStall, coupon(SALE_TOTAL)).verdict).toBe('failed')
  })
})

describe('three absence states, kept apart', () => {
  it('an absent tag reads as absent-legacy', () => {
    expect(parseIssuanceWarrant(undefined)).toEqual({ state: 'absent-legacy' })
    expect(parseIssuanceWarrant(null)).toEqual({ state: 'absent-legacy' })
    expect(parseIssuanceWarrant('')).toEqual({ state: 'absent-legacy' })
  })

  it('a signed `none` is NOT the same as absent', () => {
    // If these collapsed, a compromised service could strip a warrant and have
    // the coupon read as pre-warrant, which is the downgrade `none` prevents.
    const none = parseIssuanceWarrant(JSON.stringify({ form: 'none' }))
    expect(none).toEqual({ state: 'declared-none' })
    expect(none).not.toEqual(parseIssuanceWarrant(undefined))
  })

  it('their verdicts differ, so policy can refuse one and not the other', () => {
    expect(
      verifyIssuanceWarrant(parseIssuanceWarrant(undefined), STALL_PUB, coupon(1)).verdict,
    ).toBe('absent')
    expect(
      verifyIssuanceWarrant(
        parseIssuanceWarrant(JSON.stringify({ form: 'none' })),
        STALL_PUB,
        coupon(1),
      ).verdict,
    ).toBe('unwarranted')
  })
})

describe('malformed warrants are refused, never defaulted', () => {
  it('an unknown form is invalid, not `none`', () => {
    // Defaulting would report "the issuer signed that nothing authorised this"
    // about a shape this build cannot read. Nobody made that claim.
    const w = parseIssuanceWarrant(JSON.stringify({ form: 'merchant-v2' }))
    expect(w.state).toBe('invalid')
  })

  it('bad JSON is invalid, not absent', () => {
    expect(parseIssuanceWarrant('{not json').state).toBe('invalid')
  })

  it('a merchant warrant with no signature is invalid', () => {
    // The signature IS the evidence, so its absence is unreadability rather
    // than a weaker warrant.
    const w = parseIssuanceWarrant(warrantJson({ sig: undefined }))
    expect(w.state).toBe('invalid')
  })

  it('a missing nonce is invalid', () => {
    expect(parseIssuanceWarrant(warrantJson({ nonce: undefined })).state).toBe('invalid')
  })

  it('unreadable signature hex is refused rather than thrown', () => {
    const w = parseIssuanceWarrant(warrantJson({ sig: 'zz'.repeat(64) }))
    expect(verifyIssuanceWarrant(w, STALL_PUB, coupon(SALE_TOTAL)).verdict).toBe('failed')
  })
})

describe('processor warrants are recorded, never verified', () => {
  it('returns `claimed`, which is not `verified`', () => {
    // The issuing service is the thing that reads the processor, so a
    // compromised service can assert a charge that does not exist. The type
    // must make it impossible for UI code to read this as cryptographic proof.
    const w = parseIssuanceWarrant(
      JSON.stringify({
        form: 'processor',
        sale_total: SALE_TOTAL,
        face_decimals: DECIMALS,
        unit: UNIT,
        nonce: NONCE,
        ref: 'ch_3Abc',
      }),
    )
    expect(verifyIssuanceWarrant(w, STALL_PUB, coupon(SALE_TOTAL))).toEqual({
      verdict: 'claimed',
      reference: 'ch_3Abc',
    })
  })

  it('is still subject to the ceiling', () => {
    // Unverifiable does not mean unbounded.
    const w = parseIssuanceWarrant(
      JSON.stringify({
        form: 'processor',
        sale_total: SALE_TOTAL,
        face_decimals: DECIMALS,
        unit: UNIT,
        nonce: NONCE,
      }),
    )
    expect(verifyIssuanceWarrant(w, STALL_PUB, coupon(5_000_000)).verdict).toBe('failed')
  })
})

describe('delegated warrants refuse rather than half-check', () => {
  it('is not accepted on a signature check alone', () => {
    // Verifying delegated needs two steps: the signature against the
    // credential's lock key, THEN that the credential was minted by issuerId.
    // Doing only the first accepts a credential the attacker minted for
    // themselves, so an unimplemented check must refuse.
    const w = parseIssuanceWarrant(warrantJson({ form: 'delegated' }))
    expect(verifyIssuanceWarrant(w, STALL_PUB, coupon(SALE_TOTAL)).verdict).toBe('failed')
  })
})

describe('the ceiling', () => {
  it('covers every part of an auto-split sale', () => {
    // One Sell action mints several coupons and the device could not know how
    // many, so the warrant covers the TOTAL and each part is checked under it.
    for (const part of [834, 833, 833]) {
      expect(warrantCovers(SALE_TOTAL, part)).toBe(true)
    }
  })

  it('keeps covering a coupon as it is spent down', () => {
    let held = SALE_TOTAL
    for (const spend of [400, 600, 900]) {
      held -= spend
      expect(warrantCovers(SALE_TOTAL, held)).toBe(true)
    }
    expect(held).toBe(600)
  })

  it('refuses a coupon larger than its sale', () => {
    expect(warrantCovers(SALE_TOTAL, SALE_TOTAL + 1)).toBe(false)
  })

  it('refuses rather than clamping non-numbers and negatives', () => {
    expect(warrantCovers(SALE_TOTAL, -1)).toBe(false)
    expect(warrantCovers(NaN, 1)).toBe(false)
    expect(warrantCovers(Infinity, Infinity)).toBe(false)
  })

  it('is not equality, which would refuse every part of a split sale', () => {
    // Worth pinning because an earlier draft of this rule WAS equality. That
    // draft was written for the split case in isolation - a warrant describing
    // one coupon, which is over-stated once the coupon is spent down - and
    // equality is right for that reading. It is wrong here: a warrant
    // describes a SALE, a sale splits into parts, and every part is smaller
    // than the whole. Equality would refuse all of them.
    expect(warrantCovers(2500, 834)).toBe(true)
    expect(warrantCovers(2500, 2500)).toBe(true)
  })

  it('is not >=, which would accept the forgery', () => {
    // The other tempting form: "the warrant covers at least what is held",
    // with the operands the wrong way round. Over-statement is the failure
    // mode, so this must refuse.
    expect(warrantCovers(2500, 5_000_000)).toBe(false)
  })

  it('reports the overstatement so the UI can show the issued amount', () => {
    expect(warrantOverstatement(2500, 2100)).toBe(400)
    expect(warrantOverstatement(2500, 2500)).toBe(0)
    // Never negative: an oversized coupon is refused, not "under-stated".
    expect(warrantOverstatement(2100, 2500)).toBe(0)
  })
})

describe('the digest', () => {
  it('changes when ONLY the amount changes', () => {
    // If this fails the scheme has degenerated into a plain countersignature,
    // authenticating the debtor and leaving the amount free.
    expect(bytesToHex(warrantSaleDigest(STALL_PUB, 2500, 2, UNIT, NONCE))).not.toBe(
      bytesToHex(warrantSaleDigest(STALL_PUB, 2501, 2, UNIT, NONCE)),
    )
  })

  it('separates fields that would otherwise collide', () => {
    // Concatenated, both of these are "2500":
    //   total=25   decimals=00
    //   total=2500 decimals=0
    expect(bytesToHex(warrantSaleDigest(STALL_PUB, 25, 0, UNIT, NONCE))).not.toBe(
      bytesToHex(warrantSaleDigest(STALL_PUB, 2, 50, UNIT, NONCE)),
    )
  })

  it('distinguishes currencies and nonces', () => {
    expect(bytesToHex(warrantSaleDigest(STALL_PUB, SALE_TOTAL, DECIMALS, 'EUR', NONCE))).not.toBe(
      bytesToHex(warrantSaleDigest(STALL_PUB, SALE_TOTAL, DECIMALS, 'XAF', NONCE)),
    )
    expect(bytesToHex(warrantSaleDigest(STALL_PUB, SALE_TOTAL, DECIMALS, UNIT, 'aaaa'))).not.toBe(
      bytesToHex(warrantSaleDigest(STALL_PUB, SALE_TOTAL, DECIMALS, UNIT, 'bbbb')),
    )
  })
})
