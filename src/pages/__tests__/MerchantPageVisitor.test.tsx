/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * A visitor with no session opens a stall's page (the shop-sign QR case, and #280's logged-out
 * Buy). No wallet is open, so `getWallet` throws. The page used to subscribe to wallet changes
 * regardless, the throw escaped the effect, and the whole screen rendered blank. The real
 * `lib/wallet` is used here on purpose: a mocked one cannot throw the way the store does.
 */

const STALL = 'a'.repeat(64)

// #434: the stall's open-for-business status is asked of the portal. Open here: these tests
// are about something else, and an unmocked fetch would (correctly) fail closed.
vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => ({ status: 'open', sellsByCard: true, eventId: 'e' }),
}))
vi.mock('../../lib/branding', () => ({
  knownBranding: () => undefined,
  onBrandingChanged: () => () => {},
  merchantBranding: () => Promise.resolve({ organizationName: 'Rosa Green Farm' }),
}))
// The purchase issuer can issue for this stall (#298); without it Buy stays disabled.
vi.mock('../../lib/cardSalesEnrolment', () => ({ cardSalesReadiness: async () => 'ready' }))
vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  fetchMerchantRecord: () =>
    Promise.resolve({ pubkey: STALL, active: true, acceptsCards: true, updatedAt: 0 }),
}))

const { MerchantPage } = await import('../MerchantPage')
const { walletIsOpen } = await import('../../lib/wallet')

afterEach(cleanup)

describe('a stall page opened with no wallet', () => {
  it('renders Buy and Pay instead of crashing', async () => {
    expect(walletIsOpen()).toBe(false)
    render(
      <MemoryRouter initialEntries={[`/merchants/${STALL}`]}>
        <Routes>
          <Route path="/merchants/:pubkey" element={<MerchantPage />} />
        </Routes>
      </MemoryRouter>,
    )
    const buy = (await screen.findByRole('button', { name: 'Buy a voucher with card' })) as HTMLButtonElement
    await vi.waitFor(() => expect(buy.disabled).toBe(false))
    const pay = screen.getByRole('button', { name: 'Pay with your vouchers' }) as HTMLButtonElement
    expect(pay.disabled).toBe(true)
    expect(screen.getByText('Log in to pay with your vouchers')).toBeTruthy()
  })
})
