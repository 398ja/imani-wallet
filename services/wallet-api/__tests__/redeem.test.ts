import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  parseVerifyInput,
  verifyCoupon,
  parseCheckInput,
  checkRedemption,
  receiveBody,
  REFUSAL,
} from '../redeem.js'

/**
 * Taking a coupon a customer presents.
 *
 * Against the credential a REAL gateway minted, because the point of this
 * endpoint is agreeing with a gateway we do not control about whether
 * somebody's money is genuine. A fixture we wrote ourselves would only prove
 * the parser reads what the parser writes.
 *
 * Mostly negatives. Every refusal here is a case where accepting would cost
 * someone real money: a forged coupon taken as genuine, or a coupon taken twice
 * for its full face.
 */

const TOKEN = readFileSync(
  join(__dirname, '..', '..', '..', 'src', 'lib', '__tests__', 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()

const MINTED = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'src', 'lib', '__tests__', 'fixtures', 'live-terminal-credential.json'),
    'utf8',
  ),
) as { stall: string }

const NOW = 1_800_000_000

describe('reading the request', () => {
  it('requires a token', () => {
    const r = parseVerifyInput({}, MINTED.stall, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('token')
  })

  it('takes the stall from the SIGNING key, not the body', () => {
    // A caller naming a different stall could otherwise ask us to confirm a
    // coupon is theirs to honour when it is not.
    const r = parseVerifyInput({ token: TOKEN, stallPubkey: 'b'.repeat(64) }, MINTED.stall, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.stallPubkey).toBe(MINTED.stall)
  })
})

describe('verifying a real coupon', () => {
  const verify = (over: Record<string, unknown> = {}) =>
    verifyCoupon({ token: TOKEN, now: NOW, stallPubkey: MINTED.stall, ...over })

  it('accepts one this stall issued', () => {
    const v = verify()
    expect(v.ok).toBe(true)
    expect(v.voucher?.issuerId).toBe(MINTED.stall)
  })

  // The face value comes from the signed token, never the request. Shown on an
  // unlocked coupon built and signed by the fixture issuer, whose sats count.
  it('reads the signed face value from the token, not from anywhere else', async () => {
    const { buildVoucherToken } = await import('../../../src/lib/__tests__/voucherFixtures')
    const built = buildVoucherToken({ issuanceRatio: 1, faceValue: 1000, expiresAt: undefined }, [400])
    const v = verifyCoupon({ token: built.token, now: NOW, stallPubkey: built.voucher.issuerId })
    expect(v.voucher?.signedFaceValue).toBe(400)
  })

  // The live credential is a pre-#141 LOCKED voucher with no max_sats. Round 3
  // (imani-gateway-customer#141): it keeps the pre-#141 rule, crediting its
  // sats bounded by face, rather than 0, which stranded real customer money.
  it('credits a pre-#141 untagged locked coupon under the legacy rule', () => {
    const v = verify()
    expect(v.ok).toBe(true)
    expect(v.voucher?.signedFaceValue).toBeGreaterThan(0)
  })

  it('REFUSES a coupon issued by another stall', () => {
    // A stall cannot honour what it did not issue. Taking it would leave the
    // customer paid and the taker holding something unredeemable.
    const v = verify({ stallPubkey: 'b'.repeat(64) })
    expect(v.ok).toBe(false)
    expect(v.refusal).toBe(REFUSAL.ANOTHER_STALL)
  })

  it('REFUSES a coupon whose expiry has passed', () => {
    const expiry = verify().voucher?.expiresAt
    expect(expiry).toBeDefined()
    const v = verify({ now: expiry! + 1 })
    expect(v.ok).toBe(false)
    expect(v.refusal).toBe(REFUSAL.EXPIRED)
  })

  it('accepts it one second before that', () => {
    // The boundary in the other direction, so "expired" is not simply always
    // true.
    const expiry = verify().voucher?.expiresAt
    expect(verify({ now: expiry! - 1 }).ok).toBe(true)
  })

  it('REFUSES a tampered token', () => {
    const tampered = TOKEN.slice(0, 60) + (TOKEN[60] === 'a' ? 'b' : 'a') + TOKEN.slice(61)
    const v = verify({ token: tampered })
    expect(v.ok).toBe(false)
    expect([REFUSAL.BAD_SIGNATURE, REFUSAL.NOT_A_VOUCHER]).toContain(v.refusal)
  })

  it('REFUSES something that is not a voucher at all', () => {
    // Plain ecash takes this path legitimately, so it must be a named refusal
    // rather than a crash.
    const v = verify({ token: 'cashuBnonsense' })
    expect(v.ok).toBe(false)
    expect(v.refusal).toBe(REFUSAL.NOT_A_VOUCHER)
  })

  it('says nothing about whether it has been SPENT', () => {
    // That is the mint's answer. Asking here would turn a local check into a
    // network round trip at the slowest possible moment.
    expect(JSON.stringify(verify())).not.toMatch(/spent/i)
  })
})

describe('the ceiling', () => {
  const check = (over: Record<string, unknown> = {}) => {
    const parsed = parseCheckInput(
      { token: TOKEN, requested: 1, priorRedemptions: [], ...over },
      MINTED.stall,
      NOW,
    )
    if (!parsed.ok) throw new Error(`${parsed.error.field}: ${parsed.error.detail}`)
    return checkRedemption(parsed.value)
  }

  it('comes from the VERIFIED voucher, never the caller', () => {
    // A ceiling the presenter chose is not a ceiling. An inflated face value in
    // the body must change nothing at all.
    const honest = check()
    const lying = check({ signedFaceValue: 100_000 })
    expect(lying.ceiling?.signedFaceValue).toBe(honest.ceiling?.signedFaceValue)
  })

  it('refuses a request that would exceed what was issued', () => {
    const face = check().ceiling!.signedFaceValue
    const out = check({ requested: 1, priorRedemptions: [{ amount: face, direction: 'in' }] })
    expect(out.ceiling?.allowed).toBe(false)
  })

  it('is not consumed by an outgoing row', async () => {
    // The merchant's own issuance. Counting it would spend the ceiling before
    // any customer redeemed anything. On a fully funded unlocked coupon, since
    // the live credential is untagged and locked, so worth nothing (#141).
    const { buildVoucherToken } = await import('../../../src/lib/__tests__/voucherFixtures')
    const built = buildVoucherToken({ issuanceRatio: 1, faceValue: 1000, expiresAt: undefined }, [1000])
    const parsed = parseCheckInput(
      { token: built.token, requested: 1000, priorRedemptions: [{ amount: 1000, direction: 'out' }] },
      built.voucher.issuerId,
      NOW,
    )
    if (!parsed.ok) throw new Error(parsed.error.detail)
    const out = checkRedemption(parsed.value)
    expect(out.ceiling?.allowed).toBe(true)
  })

  it('is not computed at all for a coupon that failed verification', () => {
    // Answering "you may take 400" about a forged coupon would be worse than
    // refusing: it reads as permission.
    const out = check({ token: 'cashuBnonsense' })
    expect(out.verdict.ok).toBe(false)
    expect(out.ceiling).toBeNull()
  })

  it('requires a direction on every prior row', () => {
    // Guessing 'in' would consume a ceiling nothing had spent; guessing 'out'
    // would disable it entirely. Neither default is safe, so it is required.
    const parsed = parseCheckInput(
      { token: TOKEN, requested: 1, priorRedemptions: [{ amount: 100 }] },
      MINTED.stall,
      NOW,
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.field).toBe('priorRedemptions[0].direction')
  })

  it('refuses a fractional amount rather than rounding it', () => {
    const parsed = parseCheckInput({ token: TOKEN, requested: 2.5 }, MINTED.stall, NOW)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.field).toBe('requested')
  })
})

describe('what to sign to accept a coupon', () => {
  it('is serialised once, so the caller signs bytes rather than rebuilding them', () => {
    // NIP-98 commits to a sha256 of the body. Re-serialising with a different
    // key order changes the hash, and the gateway refuses the request from a
    // service the caller never addressed directly.
    expect(receiveBody('cashuBabc')).toBe('{"token":"cashuBabc"}')
  })
})

describe('the ceiling on a fractional-ratio part', () => {
  // Built here, signed by the test: the service's rule is the same `checkPart`
  // the till calls, so it must agree with the till on both cases.
  const partToken = async (proofs: number, ratio: number) => {
    const { buildVoucherToken } = await import('../../../src/lib/__tests__/voucherFixtures')
    // The fixture signs with its own key and names it as issuer, so the stall
    // this check runs as is that key.
    const built = buildVoucherToken({ issuanceRatio: ratio, faceValue: 1000, expiresAt: undefined }, [proofs])
    return { token: built.token, issuer: built.voucher.issuerId }
  }
  const run = (token: string, issuer: string, body: Record<string, unknown>) => {
    const parsed = parseCheckInput({ token, ...body }, issuer, NOW)
    if (!parsed.ok) throw new Error(`${parsed.error.field}: ${parsed.error.detail}`)
    return checkRedemption(parsed.value)
  }

  it('lets the last honest part of a 9 + 9 + 17802 split book 999', async () => {
    const RATIO = 0.05611672278338945
    const { token, issuer } = await partToken(17802, RATIO)
    const priorRedemptions = [
      { amount: 0, direction: 'in', exact: 9 * RATIO },
      { amount: 1, direction: 'in', exact: 9 * RATIO },
    ]
    const out = run(token, issuer, { requested: 999, priorRedemptions })
    expect(out.ceiling?.allowed).toBe(true)
    expect(out.ceiling?.creditable).toBe(999)
  })

  it('refuses a tiny part asking for its per-part rounding', async () => {
    // Worth 0.5, rounds to 1 on its own; the cumulative credit is 0.
    const { token, issuer } = await partToken(1, 0.5)
    const out = run(token, issuer, { requested: 1, priorRedemptions: [] })
    expect(out.ceiling?.creditable).toBe(0)
    expect(out.ceiling?.allowed).toBe(false)
  })

  it('never approves more than the part is worth, whatever exact the caller claims (R8)', async () => {
    // The reviewer's example: a prior booked 0 but claims an exact of 999, and
    // a 1-sat part at ratio 0.5 (worth 0.5) asks for 999.
    const { token, issuer } = await partToken(1, 0.5)
    const out = run(token, issuer, {
      requested: 999,
      priorRedemptions: [{ amount: 0, direction: 'in', exact: 999 }],
    })
    expect(out.ceiling?.allowed).toBe(false)
    expect(out.ceiling?.creditable).toBeLessThanOrEqual(1)
  })

  it('refuses a tiny part once the genuine value is booked', async () => {
    const { token, issuer } = await partToken(1, 0.5)
    const priorRedemptions = Array.from({ length: 2000 }, (_, i) => ({
      amount: i % 2,
      direction: 'in',
      exact: 0.5,
    }))
    const out = run(token, issuer, { requested: 1, priorRedemptions })
    expect(out.ceiling?.allowed).toBe(false)
  })

  it('rejects a negative exact figure', async () => {
    const { token, issuer } = await partToken(1, 0.5)
    const parsed = parseCheckInput(
      { token, requested: 1, priorRedemptions: [{ amount: 0, direction: 'in', exact: -5 }] },
      issuer,
      NOW,
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.field).toBe('priorRedemptions[0].exact')
  })
})
