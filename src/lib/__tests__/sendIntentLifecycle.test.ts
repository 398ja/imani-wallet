/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { gatewayAnswered, keyForSend, forgetSendIntent, pendingIntentVoucher } from '../sendIntent'

/**
 * #179 review: pins which gateway answers free a send's Idempotency-Key, and which fields make
 * "the same send". Each case maps to a mutant that survived the PR's own tests.
 */
describe('gatewayAnswered: only an answer that proves nothing ran frees the key (#179)', () => {
  const err = (status?: number, code?: string) => Object.assign(new Error('x'), { status, code })

  it.each([500, 502, 503, 504])('a %d keeps the key: the send may have started', (status) => {
    expect(gatewayAnswered(err(status))).toBe(false)
  })
  it.each([408, 429])('a %d keeps the key: the gateway asked for a retry', (status) => {
    expect(gatewayAnswered(err(status))).toBe(false)
  })
  it('a 409 that is not one of the two definite codes keeps the key (the same key may still be running)', () => {
    expect(gatewayAnswered(err(409, 'UNKNOWN_ERROR'))).toBe(false)
    expect(gatewayAnswered(err(409))).toBe(false)
  })
  it('the two definite 409s free it', () => {
    expect(gatewayAnswered(err(409, 'SEND_CONCURRENT'))).toBe(true)
    expect(gatewayAnswered(err(409, 'SEND_IDEMPOTENCY_MISMATCH'))).toBe(true)
  })
  it('a plain refusal frees it', () => {
    expect(gatewayAnswered(err(400))).toBe(true)
    expect(gatewayAnswered(err(403))).toBe(true)
  })
  it('no status (network, timeout) keeps it', () => {
    expect(gatewayAnswered(err())).toBe(false)
    expect(gatewayAnswered(new TypeError('Failed to fetch'))).toBe(false)
  })
})

describe('keyForSend: a different send never borrows a key (#179)', () => {
  const payer = 'a'.repeat(64)
  const base = { recipientPubkey: 'b'.repeat(64), amount: 500, voucherId: 'v1', memo: 'lunch' }
  beforeEach(() => localStorage.clear())

  it('the same send gets the same key, case of the recipient aside', () => {
    const k = keyForSend(payer, base)
    expect(keyForSend(payer, { ...base, recipientPubkey: 'B'.repeat(64) })).toBe(k)
  })
  it.each([
    ['amount', { amount: 501 }],
    ['voucher', { voucherId: 'v2' }],
    ['memo', { memo: 'dinner' }],
    ['recipient', { recipientPubkey: 'c'.repeat(64) }],
  ])('another %s is another send, with another key', (_field, change) => {
    const k = keyForSend(payer, base)
    expect(keyForSend(payer, { ...base, ...change })).not.toBe(k)
  })
  it('once forgotten, the same send is a new send', () => {
    const k = keyForSend(payer, base)
    forgetSendIntent(payer, k)
    expect(keyForSend(payer, base)).not.toBe(k)
    expect(pendingIntentVoucher(payer, base.recipientPubkey, base.amount, base.memo)).toBe('v1')
  })
  it('storage that refuses the write refuses the send: no key leaves without being stored', () => {
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    try {
      expect(() => keyForSend(payer, base)).toThrow()
    } finally {
      Storage.prototype.setItem = real
    }
  })
})
