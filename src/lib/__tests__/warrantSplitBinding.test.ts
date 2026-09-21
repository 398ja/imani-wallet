/**
 * The gateway's warrant proposal (imani-gateway-core §7.4) says consolidation
 * needs an explicit rule and that "the split path is fine (it reuses
 * signedVoucherBytes verbatim and derives value through issuance_ratio)".
 *
 * The validity claim is CORRECT: a split child keeps the parent's signed bytes,
 * so the parent's warrant signature still verifies. This file is not a
 * contradiction of that.
 *
 * What it establishes is the consequence of that same fact, which §7.4 does not
 * state: the warrant digest commits to the PARENT'S faceValue, and after a
 * split the child's real value is smaller. So on a split child a warrant is
 * simultaneously
 *
 *   - cryptographically valid, and
 *   - NOT a statement about the amount that coupon is now worth.
 *
 * A verifier that reads "warrant valid" as "this amount was authorised" is
 * wrong by the whole difference, in the direction that FAVOURS the holder. That
 * is the same shape as the imani-apps "25 XAF credited as 5000" bug the split
 * path already guards against in pay.ts, arriving by a new route.
 *
 * Run: npx vitest run src/lib/__tests__/warrantSplitBinding.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

const FIELD_SEP = '\u001f'

/** The digest exactly as the gateway's §5 specifies it. */
function warrantDigest(v: {
  voucherId: string
  issuerId: string
  faceValue: number
  faceDecimals: number
  unit: string
  expiresAt?: number
  paymentRef?: string
}): string {
  return createHash('sha256')
    .update(
      [
        v.voucherId,
        v.issuerId,
        String(v.faceValue),
        String(v.faceDecimals),
        v.unit,
        String(v.expiresAt ?? ''),
        v.paymentRef ?? '',
      ].join(FIELD_SEP),
      'utf8',
    )
    .digest('hex')
}

describe('a warrant on a split child does not describe the child', () => {
  const parent = {
    voucherId: '6f39585b-7826-4493-84e5-2a7e907c0820',
    issuerId: 'b1787b2b98a5244a70d934b393e0179e7ebba0c72579b4a0b238eda3911caa02',
    faceValue: 2500, // EUR 25.00 issued at the counter
    faceDecimals: 2,
    unit: 'EUR',
    expiresAt: 1823456789,
    paymentRef: 'cash:inv_8842',
  }

  it('the parent digest is bound to the ISSUED amount, not the held one', () => {
    // Spend EUR 4.00 of it. The child is worth 2100, and carries the parent's
    // signed bytes verbatim - that is precisely why its warrant still verifies.
    const child = { ...parent, faceValue: 2100 }

    // Same voucher_id, same issuer, same everything the signature covers.
    expect(child.voucherId).toBe(parent.voucherId)

    // But the digest the warrant signed is the parent's. A verifier that
    // recomputes the digest from what the coupon is NOW worth gets a different
    // value, so it must use the issued face value, which means the warrant
    // says nothing about the 2100.
    expect(warrantDigest(child)).not.toBe(warrantDigest(parent))
  })

  it('so "warrant valid" over-states a split child by the spent amount', () => {
    // The verifier does the right thing: recompute against the SIGNED face
    // value, because that is what is inside the signed bytes it holds.
    const asSigned = warrantDigest(parent)

    // It verifies. And the number it just authenticated is 2500, while the
    // coupon in hand is worth 2100.
    const heldValue = 2100
    const warrantedValue = parent.faceValue

    expect(asSigned).toBe(warrantDigest(parent)) // valid
    expect(warrantedValue).toBeGreaterThan(heldValue) // and over-stated
    expect(warrantedValue - heldValue).toBe(400)
  })

  it('a chain of splits widens the gap without ever invalidating the warrant', () => {
    // Each split keeps the same signed bytes, so the same warrant rides along
    // no matter how small the remainder gets. There is no point at which the
    // signature stops verifying and warns anyone.
    let held = parent.faceValue
    for (const spend of [400, 600, 900]) held -= spend
    expect(held).toBe(600)

    // Still the parent's digest. Still valid. Now over-stating by 4x.
    expect(warrantDigest(parent)).toBe(warrantDigest(parent))
    expect(parent.faceValue / held).toBeGreaterThanOrEqual(4)
  })

  it('binding to the held value instead would break the warrant on every split', () => {
    // The obvious "fix" - recompute the digest from the current value - cannot
    // work: the stall is not present at split time to re-sign, which is the
    // whole ADR 0009 constraint. So the warrant MUST stay bound to issuance,
    // and the rule has to live in how verifiers READ it, not in the digest.
    const child = { ...parent, faceValue: 2100 }
    expect(warrantDigest(child)).not.toBe(warrantDigest(parent))
    // Nobody can produce a signature over the child digest: only the stall
    // could, and it is not in the loop at split time.
  })
})
