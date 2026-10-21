/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * The apple-design pass over the screens added around card purchase and Cashlinks.
 *
 * What is pinned here is behaviour a screen reader or a keyboard sees, not the paint:
 * - every outcome is announced (`role="status"`), with good news never in the red `alert`;
 * - nobody is trapped on Stripe's return pages: there is always a way back to the stall;
 * - a link that is a screen's main action looks like the house `Button`, not a one-off pill.
 */

vi.mock('../../hooks/useBranding', () => ({
  useBranding: (pubkey: string | undefined) => ({
    branding: pubkey ? { organizationName: 'Mama Ngozi Fruits' } : undefined,
    loading: false,
  }),
}))
const h = vi.hoisted(() => ({ recovered: false }))
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  replayPendingCashback: async () => h.recovered,
}))

import { BuyCancelledPage, BuyDonePage } from '../BuyReturnPages'
import { CashbackCodeRetiredPage } from '../CashbackCodeRetiredPage'
import { Outcome } from '../ClaimLandingPage'
import { buttonClasses } from '../../components/ui'
import { PENDING_PURCHASE_KEY } from '../../lib/pendingPurchase'

const STALL = 'b'.repeat(64)

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  h.recovered = false
})

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/buy/done" element={<BuyDonePage />} />
        <Route path="/buy/cancelled" element={<BuyCancelledPage />} />
        <Route path="/receive/cashback" element={<CashbackCodeRetiredPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Stripe return pages', () => {
  it('announces the outcome and leads back to the stall it came from', () => {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: STALL }))
    at('/buy/done')
    expect(screen.getByRole('status').textContent).toContain('Payment received')
    expect(screen.getByRole('link', { name: 'Back to the stall' }).getAttribute('href')).toBe(`/merchants/${STALL}`)
    expect(screen.getByRole('link', { name: 'Go to my vouchers' }).className).toContain(buttonClasses('primary', 'lg'))
  })

  it('offers no stall link when this device remembers none', () => {
    at('/buy/done')
    expect(screen.queryByRole('link', { name: 'Back to the stall' })).toBeNull()
  })

  it('on cancel, offers the wallet as well as Try again', () => {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: STALL }))
    at('/buy/cancelled')
    expect(screen.getByRole('status').textContent).toContain('nothing was charged')
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(`/buy/${STALL}`)
    expect(screen.getByRole('link', { name: 'Back to my wallet' }).getAttribute('href')).toBe('/')
  })

  it('does not repeat the wallet link when it is already the main action', () => {
    at('/buy/cancelled')
    expect(screen.getAllByRole('link', { name: 'Back to my wallet' })).toHaveLength(1)
  })
})

describe('Outcome', () => {
  it('is announced, and its tone is carried by a glyph as well as the words', () => {
    const { container } = render(<Outcome tone="success" title="Voucher added" body="It is in your wallet." onDone={() => {}} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Voucher added')
    expect(status.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('[data-outcome="success"]')).not.toBeNull()
  })

  it('keeps Open my wallet as the only primary when there is no other action', () => {
    const done = vi.fn()
    render(<Outcome tone="unavailable" title="Voucher unavailable" body="x" onDone={done} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open my wallet' }))
    expect(done).toHaveBeenCalled()
  })
})

describe('/receive/cashback', () => {
  it('reports a recovered Cashlink as good news, not as an error', async () => {
    h.recovered = true
    at('/receive/cashback')
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('An earlier Cashlink finished arriving')
    expect(note.getAttribute('data-tone')).toBe('success')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('makes Done the primary action', () => {
    at('/receive/cashback')
    expect(screen.getByRole('button', { name: 'Done' }).className).toContain('bg-mono-900')
  })
})
