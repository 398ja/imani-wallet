/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * imani-wallet#298: on staging three card purchases were PAID for a stall whose purchase issuer
 * was never enrolled, and sat OWED, because Buy only asked whether the stall takes cards. Buy now
 * also asks the issuer whether it can issue for this stall, and fails safe: anything but an
 * explicit yes leaves Buy disabled with the reason beside it (the #281 pattern).
 */

const STALL = 'b'.repeat(64)
let ready: () => Promise<boolean> = async () => true
vi.mock('../../lib/cardSalesEnrolment', () => ({ cardSalesReady: () => ready() }))

const { MerchantActions } = await import('../MerchantActions')
const { CARD_SALES_NOT_READY } = await import('../../lib/merchantActions')

afterEach(cleanup)

function renderActions() {
  render(
    <MemoryRouter>
      <MerchantActions pubkey={STALL} acceptsCards={true} />
    </MemoryRouter>,
  )
}

const buy = () => screen.getByRole('button', { name: 'Buy a voucher with card' }) as HTMLButtonElement

describe('Buy at a stall whose card sales are not ready', () => {
  // Stripe connected, issuer not enrolled: Buy is disabled and says why, right under it.
  it('is disabled with the reason adjacent', async () => {
    ready = async () => false
    renderActions()
    const reason = await screen.findByText(CARD_SALES_NOT_READY)
    expect(buy().disabled).toBe(true)
    expect(buy().getAttribute('aria-describedby')).toBe(reason.id)
  })

  // The readiness check failing (offline, an older issuer) is the same as "not ready".
  it('is disabled when readiness cannot be read', async () => {
    ready = async () => {
      throw new Error('offline')
    }
    renderActions()
    await screen.findByText(CARD_SALES_NOT_READY)
    expect(buy().disabled).toBe(true)
  })

  // Before the answer arrives, Buy does not sell either.
  it('is disabled until the issuer answers, then enabled for a ready stall', async () => {
    let answer: (v: boolean) => void = () => {}
    ready = () => new Promise<boolean>((resolve) => (answer = resolve))
    renderActions()
    expect(buy().disabled).toBe(true)
    answer(true)
    await vi.waitFor(() => expect(buy().disabled).toBe(false))
  })
})
