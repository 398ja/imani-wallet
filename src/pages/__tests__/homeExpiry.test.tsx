/**
 * @vitest-environment jsdom
 */
/**
 * #265 on home: the "N vouchers expire this week" banner, its dismissal, the deck's expiry cue,
 * and the note under the balance when expired coupons were left out of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

const ME = 'e'.repeat(64)
const STALL = 'a'.repeat(64)
const DAY = 86_400_000
const h = vi.hoisted(() => ({ rows: [] as VoucherRow[] }))

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: async () => h.rows,
  listTransactions: async () => [],
  onWalletChanged: () => () => {},
}))
vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: async () => ({ organizationName: 'Test Stall' }),
}))

const { MerchantsPage } = await import('../MerchantsPage')

function row(token_id: string, expiresInMs: number | undefined): VoucherRow {
  return {
    token_id,
    token: `cashuB-${token_id}`,
    amount: 250,
    face_value: 250,
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: STALL,
    status: 'active',
    expires_at: expiresInMs === undefined ? undefined : Math.floor((Date.now() + expiresInMs) / 1000),
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  }
}

const open = () =>
  render(
    <MemoryRouter>
      <MerchantsPage pubkey={ME} />
    </MemoryRouter>,
  )

beforeEach(() => {
  localStorage.clear()
  h.rows = []
})
afterEach(cleanup)

describe('home (#265)', () => {
  it('shows the banner, linking to the expiring list, and the deck cue under the card', async () => {
    h.rows = [row('a', 3 * DAY + 3_600_000), row('b', 5 * DAY + 3_600_000), row('c', 30 * DAY)]
    open()
    const link = await screen.findByRole('link', { name: '2 vouchers expire this week' })
    expect(link.getAttribute('href')).toBe('/coupons/expiring')
    // The deck shows the stall's SOONEST.
    expect(screen.getByRole('img', { name: /^Expires in 3 days, on / })).toBeTruthy()
  })

  it('dismissed, the banner stays gone on the next visit', async () => {
    h.rows = [row('a', 3 * DAY + 3_600_000)]
    open()
    await screen.findByText('1 voucher expires this week')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('1 voucher expires this week')).toBeNull()
    cleanup()
    open()
    await screen.findByText('Total balance')
    await screen.findAllByRole('img', { name: /^Expires in/ })
    expect(screen.queryByText('1 voucher expires this week')).toBeNull()
  })

  it('switch off: no banner, though the badge still shows', async () => {
    localStorage.setItem(`imani-wallet:notification-prefs:${ME}`, JSON.stringify({ couponExpiring: false }))
    h.rows = [row('a', 3 * DAY + 3_600_000)]
    open()
    await screen.findByRole('img', { name: /^Expires in 3 days/ })
    expect(screen.queryByText(/expires? this week/)).toBeNull()
  })

  it('notes expired coupons under the balance, which leaves them out', async () => {
    h.rows = [row('live', 30 * DAY), row('x1', -DAY), row('x2', -2 * DAY)]
    open()
    await screen.findByText('2 expired vouchers are not counted.')
    // The total is the one live coupon: the balance line sits right after its label.
    const total = screen.getByText('Total balance').nextElementSibling
    expect(total?.textContent).toBe('€2.50')
  })
})
