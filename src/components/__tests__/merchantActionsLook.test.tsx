/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The purchase issuer says this stall's card sales are ready (#298), so Buy is enabled when the
// stall takes cards. `merchantActionsCardSales.test.tsx` covers the not-ready states.
// #434: the stall's open-for-business status is asked of the portal. Open here: these tests
// are about something else, and an unmocked fetch would (correctly) fail closed.
vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => ({ status: 'open', sellsByCard: true, eventId: 'e' }),
}))
vi.mock('../../lib/cardSalesEnrolment', () => ({ cardSalesReadiness: async () => 'ready' }))
const { MerchantActions } = await import('../MerchantActions')

/**
 * A disabled action must LOOK disabled, and both disabled actions must carry the same weight.
 * A disabled Buy used to keep the solid primary fill, which read as pressable and heavier than
 * the disabled Pay beside it (review of #281).
 */

const STALL = 'b'.repeat(64)

afterEach(cleanup)

function buttons(acceptsCards: boolean) {
  render(
    <MemoryRouter>
      <MerchantActions pubkey={STALL} acceptsCards={acceptsCards} />
    </MemoryRouter>,
  )
  return {
    buy: screen.getByRole('button', { name: 'Buy a voucher with card' }),
    pay: screen.getByRole('button', { name: 'Pay with your vouchers' }),
  }
}

describe('Buy and Pay styling', () => {
  it('gives a disabled Buy the same quiet look as a disabled Pay', () => {
    const { buy, pay } = buttons(false)
    expect((buy as HTMLButtonElement).disabled).toBe(true)
    expect((pay as HTMLButtonElement).disabled).toBe(true)
    expect(buy.className).not.toContain('bg-mono-900')
    expect(buy.className).toBe(pay.className)
  })

  it('keeps an enabled Buy as the primary action', async () => {
    const { buy } = buttons(true)
    await vi.waitFor(() => expect((buy as HTMLButtonElement).disabled).toBe(false))
    expect(buy.className).toContain('bg-mono-900')
  })
})
