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

  it('reads the signed face value from the token, not from anywhere else', () => {
    expect(verify().voucher?.signedFaceValue).toBeGreaterThan(0)
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

  it('is not consumed by an outgoing row', () => {
    // The merchant's own issuance. Counting it would spend the ceiling before
    // any customer redeemed anything.
    const face = check().ceiling!.signedFaceValue
    const out = check({ requested: face, priorRedemptions: [{ amount: face, direction: 'out' }] })
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
