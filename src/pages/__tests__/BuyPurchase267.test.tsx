/**
 * @vitest-environment jsdom
 *
 * imani-wallet#267 items 2 and 3, buyer side.
 *
 * - A guest (no wallet) cannot start a card purchase HERE; since #410 they are
 *   pointed to the stall's gifting page, which takes guests.
 * - Stripe returns the buyer to `/buy/done?session_id=…` or `/buy/cancelled`.
 *   `session_id` is never shown or used to look anything up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const startPurchase = vi.fn()
vi.mock('../../lib/purchase', () => ({ startPurchase: (...a: unknown[]) => startPurchase(...a) }))
vi.mock('../../hooks/useBranding', () => ({
  useBranding: (pubkey: string | undefined) => ({
    branding: pubkey ? { organizationName: 'Mama Ngozi Fruits' } : undefined,
    loading: false,
  }),
}))

// #298: whether the purchase issuer can issue for this stall. Ready unless a test says otherwise.
let cardSalesReady = vi.fn(async () => true)
// #312: when set, the readiness answer itself (e.g. 'no-expiry'), overriding the boolean above.
let readinessOverride: string | null = null
vi.mock('../../lib/cardSalesEnrolment', () => ({
  cardSalesReadiness: async (...a: unknown[]) =>
    readinessOverride ?? ((await cardSalesReady(...(a as []))) ? 'ready' : 'not-ready'),
}))

let identity: { nip05?: string } | undefined
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentity: () => identity,
}))

import { BuyPage } from '../BuyPage'
import { CARD_SALES_NEEDS_EXPIRY, CARD_SALES_NOT_READY } from '../../lib/merchantActions'
import { BuyCancelledPage, BuyDonePage } from '../BuyReturnPages'
import { PENDING_PURCHASE_KEY } from '../../lib/pendingPurchase'

const STALL = 'b'.repeat(64)
const BUYER = 'a'.repeat(64)

afterEach(() => {
  cleanup()
  startPurchase.mockReset()
  cardSalesReady = vi.fn(async () => true)
  readinessOverride = null
  sessionStorage.clear()
})

function buy(buyerPubkey: string | null) {
  return render(
    <MemoryRouter initialEntries={[`/buy/${STALL}`]}>
      <Routes>
        <Route path="/buy/:pubkey" element={<BuyPage buyerPubkey={buyerPubkey} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Buy page, guest (#267 item 2, #410)', () => {
  it('points a guest to the gifting page (by handle) and offers no card button here', async () => {
    identity = { nip05: 'mama@imani.casa' }
    buy(null)
    expect(screen.getByText(/buy this voucher by card on the gifting page/)).toBeTruthy()
    const link = (await screen.findByRole('link', { name: 'Buy on the gifting page' })) as HTMLAnchorElement
    expect(link.href).toBe('https://gifting.imani.casa/shop/mama')
    expect(screen.getByRole('link', { name: 'Create a wallet' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /pay by card/i })).toBeNull()
    expect(screen.queryByText(/link to claim your voucher/i)).toBeNull()
    expect(startPurchase).not.toHaveBeenCalled()
  })

  it('a stall with no handle has no gifting link (no hexpub URLs), only Create a wallet', () => {
    identity = undefined
    buy(null)
    expect(screen.queryByRole('link', { name: 'Buy on the gifting page' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Create a wallet' })).toBeTruthy()
  })

  it('lets a wallet holder pay, and remembers the stall for the return page', async () => {
    startPurchase.mockResolvedValue({ kind: 'error', reason: 'stop here' })
    buy(BUYER)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.00' } })
    const pay = screen.getByRole('button', { name: /pay by card/i }) as HTMLButtonElement
    await vi.waitFor(() => expect(pay.disabled).toBe(false))
    fireEvent.click(pay)
    await screen.findByText('stop here')
    expect(startPurchase).toHaveBeenCalledWith({ stallPubkey: STALL, amountMinor: 2500, buyerPubkey: BUYER })
    expect(JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) ?? '{}')).toEqual({ stallPubkey: STALL })
  })
})

/**
 * imani-wallet#298: a link straight to /buy/<stall> skips the stall page's Buy gate, so the Buy
 * page asks too. A stall whose purchase issuer cannot issue is not charged: Pay by card stays
 * disabled with the reason beside it, and is checked again at the tap.
 */
describe('Buy page for a stall whose card sales are not ready (#298)', () => {
  // Not enrolled: the card button is disabled with the reason adjacent, and nothing is started.
  it('disables Pay by card with the reason beside it', async () => {
    cardSalesReady = vi.fn(async () => false)
    buy(BUYER)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.00' } })
    const reason = await screen.findByText(CARD_SALES_NOT_READY)
    const pay = screen.getByRole('button', { name: /pay by card/i }) as HTMLButtonElement
    expect(pay.disabled).toBe(true)
    expect(pay.getAttribute('aria-describedby')).toContain(reason.id)
    expect(startPurchase).not.toHaveBeenCalled()
  })

  // Ready when the page opened, not ready by the tap: refused with the reason, nothing charged.
  it('checks again at the tap and refuses', async () => {
    cardSalesReady = vi.fn(async () => true)
  readinessOverride = null
    buy(BUYER)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.00' } })
    const pay = screen.getByRole('button', { name: /pay by card/i }) as HTMLButtonElement
    await vi.waitFor(() => expect(pay.disabled).toBe(false))
    cardSalesReady = vi.fn(async () => false)
    fireEvent.click(pay)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain(CARD_SALES_NOT_READY)
    expect(startPurchase).not.toHaveBeenCalled()
  })
})

describe('Buy return pages (#267 item 3)', () => {
  function at(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/buy/done" element={<BuyDonePage />} />
          <Route path="/buy/cancelled" element={<BuyCancelledPage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('names the stall from this device, never from session_id', () => {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: STALL }))
    const { container } = at('/buy/done?session_id=cs_test_SECRETISH')
    expect(screen.getByText('Payment received')).toBeTruthy()
    expect(screen.getByText(/Your voucher from Mama Ngozi Fruits is on its way/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to my vouchers' }).getAttribute('href')).toBe('/')
    expect(container.textContent).not.toContain('cs_test_SECRETISH')
  })

  it('still reads sensibly with no remembered stall', () => {
    at('/buy/done?session_id=cs_test_x')
    expect(screen.getByText(/Your voucher is on its way/)).toBeTruthy()
  })

  it('ignores a malformed remembered stall', () => {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, '{"stallPubkey":"<script>"}')
    at('/buy/done')
    expect(screen.getByText(/Your voucher is on its way/)).toBeTruthy()
  })

  it('says nothing was charged on cancel', () => {
    at('/buy/cancelled')
    expect(screen.getByText('Payment cancelled, nothing was charged')).toBeTruthy()
  })
})

describe('Buy page for a stall whose vouchers never expire (#312)', () => {
  // A card voucher must expire (its delegation is finite), so Buy is off with the reason a shopper
  // can understand, and nothing is started.
  it('disables Pay by card and says the shop sells by card only with an expiry date', async () => {
    readinessOverride = 'no-expiry'
    buy(BUYER)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.00' } })
    const reason = await screen.findByText(CARD_SALES_NEEDS_EXPIRY)
    const pay = screen.getByRole('button', { name: /pay by card/i }) as HTMLButtonElement
    expect(pay.disabled).toBe(true)
    expect(pay.getAttribute('aria-describedby')).toContain(reason.id)
    expect(startPurchase).not.toHaveBeenCalled()
  })
})
