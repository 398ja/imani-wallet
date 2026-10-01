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
const BUNDLE = 'c'.repeat(32)

afterEach(cleanup)
beforeEach(() => localStorage.clear())

describe('RefusedCouponsNote', () => {
  /** A two-coupon payment with one refused shows "1 of 2 coupons refused" and the reason. */
  it('shows the refusal on the payment it belonged to', () => {
    // Arrange
    recordRefusal(STALL, {
      eventId: 'w1',
      senderPubkey: 'b'.repeat(64),
      voucherId: '19c4fed1',
      alreadyRedeemed: 89,
      signedFaceValue: 100,
      reason: 'over-redeemed',
      bundleId: BUNDLE,
      bundlePartCount: 2,
    })

    // Act
    render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} />)

    // Assert
    expect(screen.getByRole('status').textContent).toContain('1 of 2 coupons refused: that coupon is already spent')
    expect(screen.getByRole('status').textContent).toMatch(/ask the customer to pay the rest/i)
  })

  /** A payment with nothing refused renders nothing at all. */
  it('renders nothing when no coupon of the payment was refused', () => {
    // Act
    const { container } = render(<RefusedCouponsNote pubkey={STALL} bundleId={BUNDLE} />)

    // Assert
    expect(container.innerHTML).toBe('')
  })
})
