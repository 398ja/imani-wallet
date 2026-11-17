/**
 * @vitest-environment jsdom
 *
 * imani-wallet#277: the badge on a refunded, partly refunded or disputed card voucher. Text and an
 * icon, never colour alone, with the date, and an accessible name that says what it means.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { CardPaymentBadge, CardPaymentNotice } from '../CardPaymentBadge'
import type { CardPaymentState } from '../../lib/cardPaymentState'

afterEach(cleanup)

const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`
const at = '2026-11-17T10:00:00Z'

const partly: CardPaymentState = { status: 'partly_refunded', paidMinor: 1000, refundedMinor: 300, backedMinor: 700, reversedAt: at }
const refunded: CardPaymentState = { status: 'refunded', paidMinor: 1000, refundedMinor: 1000, backedMinor: 0, reversedAt: at }
const disputed: CardPaymentState = { status: 'disputed', paidMinor: 1000, refundedMinor: 0, backedMinor: 0 }

describe('the card payment badge', () => {
  it('says "Partly refunded £x of £y" with the date', () => {
    render(<CardPaymentBadge state={partly} money={gbp} />)
    const badge = screen.getByRole('status')
    expect(badge.textContent).toContain('Partly refunded £3.00 of £10.00')
    expect(badge.getAttribute('aria-label')).toMatch(/^Partly refunded £3\.00 of £10\.00, /)
    expect(badge.querySelector('svg')).not.toBeNull()
  })

  it('says "Refunded" and "Disputed"', () => {
    render(<CardPaymentBadge state={refunded} money={gbp} />)
    expect(screen.getByRole('status').textContent).toContain('Refunded')
    cleanup()
    render(<CardPaymentBadge state={disputed} money={gbp} />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Disputed')
  })

  it('shows nothing for a paid or unknown payment', () => {
    const { container } = render(
      <>
        <CardPaymentBadge state={undefined} money={gbp} />
        <CardPaymentBadge state={{ status: 'paid', paidMinor: 1000, refundedMinor: 0, backedMinor: 1000 }} money={gbp} />
      </>,
    )
    expect(container.textContent).toBe('')
  })

  it('tells the holder it cannot be spent, and the stall what is left', () => {
    render(<CardPaymentNotice state={refunded} money={gbp} audience="holder" />)
    expect(screen.getByTestId('card-payment-notice').textContent).toContain('Can’t be spent: the card payment for this voucher was refunded.')
    cleanup()
    render(<CardPaymentNotice state={partly} money={gbp} audience="stall" />)
    expect(screen.getByTestId('card-payment-notice').textContent).toContain('At most £7.00 of this voucher can still be redeemed')
  })
})
