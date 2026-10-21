/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

/**
 * Held coupons are visible, not silent (#133 review, MEDIUM-2).
 *
 * The trusted-mint gate holds a coupon whose mint it cannot confirm. Before this
 * strip the wait showed nothing at all, so a held coupon looked exactly like one
 * lost in the network. These pin that the wallet says so, and stops saying so
 * once the coupon goes through.
 */

vi.mock('../../lib/cashback', () => ({ pendingCashbackCount: () => cashbackWaiting }))
let cashbackWaiting = 0

const { HeldCouponsNotice } = await import('../ui/HeldCouponsNotice')
const { recordHeld, releaseHeld, heldCoupons } = await import('../../lib/heldCoupons')

const ME = 'a'.repeat(64)

function held(eventId: string) {
  return {
    eventId,
    senderPubkey: 'b'.repeat(64),
    voucherId: `v-${eventId}`,
    reason: 'untrusted-mint' as const,
    detail: 'mint not listed',
    token: 'cashuB...',
    createdAt: 1_800_000_000,
  }
}

beforeEach(() => {
  localStorage.clear()
  cashbackWaiting = 0
})

afterEach(() => {
  cleanup()
})

describe('the waiting-to-be-verified notice', () => {
  /** Nothing waiting, nothing shown. */
  it('renders nothing when no coupon is held', () => {
    render(<HeldCouponsNotice pubkey={ME} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  /**
   * A coupon held while the notice is on screen appears at once, says it is
   * waiting rather than failed, and says nothing was taken.
   */
  it('appears when a coupon is held and says nothing was taken', () => {
    render(<HeldCouponsNotice pubkey={ME} />)

    act(() => {
      recordHeld(ME, held('e1'))
    })

    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('1 coupon is waiting to be verified')
    expect(notice.textContent).toContain('Nothing was taken')
  })

  /** The notice clears itself when the held coupon is finally redeemed. */
  it('disappears once the held coupon is released', () => {
    recordHeld(ME, held('e1'))
    render(<HeldCouponsNotice pubkey={ME} />)
    expect(screen.getByRole('status')).toBeTruthy()

    act(() => {
      releaseHeld(ME, 'e1')
    })

    expect(screen.queryByRole('status')).toBeNull()
  })

  /** Claimed cashback held on this device counts too. */
  it('counts cashback waiting on this device', () => {
    cashbackWaiting = 1
    recordHeld(ME, held('e1'))
    render(<HeldCouponsNotice pubkey={ME} />)
    expect(screen.getByRole('status').textContent).toContain('2 coupons are waiting to be verified')
  })
})

describe('the held-coupon record', () => {
  /**
   * The same delivery is offered on every poll; it is recorded once, and only
   * the first hold reports itself as new (which is what keeps the toast to one).
   */
  it('records a delivery once however often it is held', () => {
    expect(recordHeld(ME, held('e1'))).toBe(true)
    expect(recordHeld(ME, held('e1'))).toBe(false)
    expect(heldCoupons(ME)).toHaveLength(1)
  })

  /** One account's held coupons are not another's. */
  it('keeps held coupons per account', () => {
    recordHeld(ME, held('e1'))
    expect(heldCoupons('c'.repeat(64))).toEqual([])
  })
})
