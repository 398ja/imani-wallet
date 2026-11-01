/**
 * @vitest-environment jsdom
 *
 * #145: the payment itself says a coupon of it was refused, for as long as the
 * payment is on screen, not only in a toast.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { RefusedCouponsNote } from '../RefusedCouponsNote'
import { recordRefusal } from '../../../lib/refusedCoupons'

const STALL = 'a'.repeat(64)
const PAYER = 'b'.repeat(64)
const STRANGER = 'd'.repeat(64)
const BUNDLE = 'c'.repeat(32)

afterEach(cleanup)
beforeEach(() => localStorage.clear())

/** A refused coupon from `sender`, naming the bundle. */
const refusedFrom = (sender: string, eventId = 'w1') =>
  recordRefusal(STALL, {
    eventId,
    senderPubkey: sender,
    voucherId: '19c4fed1',
    alreadyRedeemed: 89,
    signedFaceValue: 100,
    reason: 'over-redeemed',
    bundleId: BUNDLE,
    bundlePartCount: 2,
  })

describe('RefusedCouponsNote', () => {
  /** A two-coupon payment with one refused, from its own payer, shows the count, the reason and what to do. */
  it("shows the refusal on the payment, with what to do, when the payment's payer sent it", () => {
    // Arrange
    refusedFrom(PAYER)

    // Act
    render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} payer={PAYER} />)

    // Assert
    const text = screen.getByRole('status').textContent
    expect(text).toContain('1 of 2 coupons refused: that coupon is already spent')
    expect(text).toMatch(/ask the customer to pay the rest/i)
  })

  /**
   * Review of #145 (F3): a sender writes the bundle and request ids, so a
   * stranger can name someone else's payment. Their refusal must not tell staff
   * to collect more from that customer.
   */
  it('words a refusal from someone else neutrally and gives no instruction', () => {
    // Arrange
    refusedFrom(STRANGER)

    // Act
    render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} payer={PAYER} pending />)

    // Assert
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toMatch(/a coupon naming this payment was refused/i)
    expect(text).not.toMatch(/pay the rest/i)
    expect(text).not.toMatch(/of 2/)
  })

  /** Once the payment is settled, a stranger's refusal naming it is not shown at all. */
  it('hides a refusal from someone else once the payment is no longer pending', () => {
    // Arrange
    refusedFrom(STRANGER)

    // Act
    const { container } = render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} payer={PAYER} />)

    // Assert
    expect(container.innerHTML).toBe('')
  })

  /** Two refused coupons read as "them", not "it". */
  it('pluralises the instruction for two refused coupons', () => {
    // Arrange
    refusedFrom(PAYER, 'w1')
    refusedFrom(PAYER, 'w2')

    // Act
    render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} payer={PAYER} />)

    // Assert
    expect(screen.getByRole('status').textContent).toMatch(/nothing was taken for them/i)
  })

  /** A payment with nothing refused renders nothing at all. */
  it('renders nothing when no coupon of the payment was refused', () => {
    // Act
    const { container } = render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} payer={PAYER} pending />)

    // Assert
    expect(container.innerHTML).toBe('')
  })
})
