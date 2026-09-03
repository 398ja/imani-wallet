/**
 * Where a coupon may be sent.
 *
 * Three outcomes, and the order they are decided in is the whole design.
 */
import { describe, expect, it } from 'vitest'

import { checkRecipient, needsRecipientLookup } from '../recipient'

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const CUSTOMER = 'c'.repeat(64)
const SENDER = 'd'.repeat(64)

const check = (over: Record<string, unknown> = {}) =>
  checkRecipient({
    senderPubkey: SENDER,
    recipientPubkey: CUSTOMER,
    issuerPubkey: STALL,
    recipientRole: 'customer',
    ...over,
  } as never)

describe('redemption', () => {
  /**
   * The overwhelmingly common case, and the one a market stall depends on. It
   * must work during an outage, which is why it is decided from the keys alone.
   */
  it('allows a stall its own coupons back, whatever the network says', () => {
    for (const recipientRole of ['stall', 'customer', 'unknown'] as const) {
      expect(check({ recipientPubkey: STALL, recipientRole })).toEqual({
        allowed: true,
        kind: 'redemption',
      })
    }
  })

  it('needs no lookup at all', () => {
    expect(needsRecipientLookup(SENDER, STALL, STALL)).toBe(false)
  })

  it('matches the issuer case-insensitively', () => {
    expect(
      check({ recipientPubkey: STALL.toUpperCase(), recipientRole: 'unknown' }).allowed,
    ).toBe(true)
  })
})

describe('a transfer to someone who is not a stall', () => {
  it('is allowed', () => {
    expect(check({ recipientRole: 'customer' })).toEqual({ allowed: true, kind: 'transfer' })
  })
})

describe('a send to a different stall', () => {
  it('is refused, naming the mismatch', () => {
    const verdict = check({ recipientPubkey: OTHER_STALL, recipientRole: 'stall' })

    expect(verdict).toMatchObject({ allowed: false, reason: 'wrong-stall' })
    if (!verdict.allowed) {
      // Both keys, so a caller can see which coupon went where.
      expect(verdict.detail).toContain(STALL)
      expect(verdict.detail).toContain(OTHER_STALL)
      expect(verdict.detail).toContain('Nothing has moved')
    }
  })

  it('needs a lookup, because the keys alone cannot decide it', () => {
    expect(needsRecipientLookup(SENDER, OTHER_STALL, STALL)).toBe(true)
  })
})

describe('an unreachable network', () => {
  /**
   * The asymmetry that decides this: a send blocked by an outage is retried a
   * minute later, while a coupon that lands on a stall which cannot honour it
   * is gone. Only the second is unrecoverable.
   */
  it('refuses rather than allowing, and says nothing has moved', () => {
    const verdict = check({ recipientPubkey: OTHER_STALL, recipientRole: 'unknown' })

    expect(verdict).toMatchObject({ allowed: false, reason: 'recipient-unknown' })
    if (!verdict.allowed) {
      expect(verdict.detail).toContain('Nothing has moved')
      // Says the check could not be made, not that the recipient is wrong.
      expect(verdict.detail).toContain('Could not check')
    }
  })

  it('is refused distinguishably from a wrong stall', () => {
    const unknown = check({ recipientPubkey: OTHER_STALL, recipientRole: 'unknown' })
    const wrong = check({ recipientPubkey: OTHER_STALL, recipientRole: 'stall' })

    expect(unknown).toMatchObject({ reason: 'recipient-unknown' })
    expect(wrong).toMatchObject({ reason: 'wrong-stall' })
  })
})

describe('a send to oneself', () => {
  /**
   * Checked before redemption. A stall redeeming to ITSELF is still a round
   * trip that burns a coupon and mints an equal one for a fee — and checking
   * this second would let it through for the one identity where it is most
   * likely a loop bug.
   */
  it('is refused even when it would otherwise be a redemption', () => {
    const verdict = checkRecipient({
      senderPubkey: STALL,
      recipientPubkey: STALL,
      issuerPubkey: STALL,
      recipientRole: 'stall',
    })

    expect(verdict).toMatchObject({ allowed: false, reason: 'self-send' })
  })

  it('is refused for a customer sending to themselves', () => {
    expect(
      checkRecipient({
        senderPubkey: CUSTOMER,
        recipientPubkey: CUSTOMER,
        issuerPubkey: STALL,
        recipientRole: 'customer',
      }),
    ).toMatchObject({ allowed: false, reason: 'self-send' })
  })

  it('matches the sender case-insensitively', () => {
    expect(
      check({ senderPubkey: SENDER.toUpperCase(), recipientPubkey: SENDER }),
    ).toMatchObject({ reason: 'self-send' })
  })

  it('needs no lookup', () => {
    expect(needsRecipientLookup(SENDER, SENDER, STALL)).toBe(false)
  })
})
