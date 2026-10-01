/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * #145: a coupon refused before the swap must stay visible on the payment.
 *
 * The toast is gone in ten seconds. On staging the customer was told the
 * payment completed, and the merchant had nothing on screen to say part of it
 * was turned away. These records are what the payment's own screens read.
 */

import { recordRefusal, refusalsFor, refusalSummary } from '../refusedCoupons'

const STALL = 'a'.repeat(64)
const BUNDLE = 'c'.repeat(32)

const refused = (over: Record<string, unknown> = {}) => ({
  eventId: 'wrap-1',
  senderPubkey: 'b'.repeat(64),
  voucherId: '19c4fed1',
  alreadyRedeemed: 89,
  signedFaceValue: 100,
  reason: 'over-redeemed' as const,
  bundleId: BUNDLE,
  bundlePartCount: 2,
  requestId: 'req-1',
  ...over,
})

beforeEach(() => {
  localStorage.clear()
})

describe('remembering a refused coupon (#145)', () => {
  /** A refusal is kept and found by the payment it belonged to. */
  it('finds a refusal by its bundle and by its request', () => {
    // Arrange / Act
    recordRefusal(STALL, refused())

    // Assert
    expect(refusalsFor(STALL, { bundleId: BUNDLE })).toHaveLength(1)
    expect(refusalsFor(STALL, { requestId: 'req-1' })).toHaveLength(1)
    expect(refusalsFor(STALL, { bundleId: 'd'.repeat(32) })).toHaveLength(0)
  })

  /** The same gift wrap refused twice (a re-delivery) is one refused coupon. */
  it('records one delivery once', () => {
    // Arrange / Act
    recordRefusal(STALL, refused())
    recordRefusal(STALL, refused())

    // Assert
    expect(refusalsFor(STALL, { bundleId: BUNDLE })).toHaveLength(1)
  })

  /** Nothing to attach it to means nothing to show on a payment. */
  it('ignores a refusal that names no payment', () => {
    // Arrange / Act
    recordRefusal(STALL, refused({ bundleId: undefined, requestId: undefined }))

    // Assert
    expect(refusalsFor(STALL, { bundleId: BUNDLE })).toHaveLength(0)
  })

  /** One account never sees another's refusals. */
  it('keeps refusals per account', () => {
    // Arrange / Act
    recordRefusal(STALL, refused())

    // Assert
    expect(refusalsFor('e'.repeat(64), { bundleId: BUNDLE })).toHaveLength(0)
  })
})

describe('saying it on the payment (#145)', () => {
  /** The wording the issue asks for: how many of how many, and why. */
  it('says "1 of 2 coupons refused" with the reason', () => {
    // Arrange
    recordRefusal(STALL, refused())

    // Act
    const line = refusalSummary(refusalsFor(STALL, { bundleId: BUNDLE }))

    // Assert
    expect(line).toBe('1 of 2 coupons refused: that coupon is already spent')
  })

  /** Two reasons are both named, so staff can tell the customer each one. */
  it('names every distinct reason', () => {
    // Arrange
    recordRefusal(STALL, refused({ eventId: 'w1', bundlePartCount: 3 }), 1_000)
    recordRefusal(STALL, refused({ eventId: 'w2', reason: 'unwarranted', bundlePartCount: 3 }), 2_000)

    // Act
    const line = refusalSummary(refusalsFor(STALL, { bundleId: BUNDLE }))

    // Assert
    expect(line).toBe('2 of 3 coupons refused: that coupon is already spent; coupon not authorised')
  })

  /** Without a declared count it does not invent one. */
  it('drops the "of N" when the sender declared no count', () => {
    // Arrange
    recordRefusal(STALL, refused({ bundlePartCount: undefined }))

    // Act
    const line = refusalSummary(refusalsFor(STALL, { bundleId: BUNDLE }))

    // Assert
    expect(line).toBe('1 coupon refused: that coupon is already spent')
  })

  /** No refusals, no line. */
  it('says nothing when nothing was refused', () => {
    expect(refusalSummary([])).toBeUndefined()
  })
})
