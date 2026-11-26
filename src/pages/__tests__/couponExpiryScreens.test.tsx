/**
 * @vitest-environment jsdom
 */
/**
 * #265: what the coupon screens say about expiry.
 *
 *  - the opened row (the detail page until the voucher-rows change): absolute date plus a
 *    countdown, and an expired coupon that never reads "Ready to use";
 *  - the list: badges by tone with text and an accessible label, soonest first by default with
 *    "Newest" kept as an option, and an "Expired (N)" group instead of silent removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

const STALL = 'a'.repeat(64)
const DAY = 86_400_000
const h = vi.hoisted(() => ({ rows: [] as VoucherRow[] }))

vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }))
vi.mock('../../hooks/useBranding', () => ({
  useBranding: () => ({ branding: { organizationName: 'Test Stall' }, loading: false }),
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  getVoucherRow: async (id: string) => h.rows.find((r) => r.token_id === id) ?? null,
  listVouchers: async () => h.rows,
  onWalletChanged: () => () => {},
}))
vi.mock('../../lib/nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/nap')>()),
  getSigner: () => ({ pubkey: 'e'.repeat(64) }),
}))

const { CouponRedirect } = await import('../RecordDetailPages')
const { CouponsPage } = await import('../RecordListPages')
const { formatDate } = await import('../../lib/format')
const { voucherStatusKind } = await import('../../lib/voucherStatus')

function row(token_id: string, expiresInMs: number | undefined, over: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id,
    voucher_id: `v-${token_id}`,
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
    ...over,
  }
}

/**
 * Open one voucher the way an old link does: `/coupon/:id` redirects to the stall's list with
 * that voucher open. Resolves to the opened row's panel.
 */
const openCoupon = async (id: string) => {
  render(
    <MemoryRouter initialEntries={[`/coupon/${id}`]}>
      <Routes>
        <Route path="/coupon/:tokenId" element={<CouponRedirect />} />
        <Route path="/merchants/:pubkey/vouchers" element={<CouponsPage />} />
      </Routes>
    </MemoryRouter>,
  )
  const button = await waitFor(() => {
    const open = screen.getAllByRole('button', { expanded: true })
    expect(open).toHaveLength(1)
    return open[0]!
  })
  return document.getElementById(button.getAttribute('aria-controls')!)!
}

const openList = () =>
  render(
    <MemoryRouter initialEntries={[`/merchants/${STALL}/vouchers`]}>
      <Routes>
        <Route path="/merchants/:pubkey/vouchers" element={<CouponsPage />} />
      </Routes>
    </MemoryRouter>,
  )

/** The voucher rows, in order, by token id. Each is a disclosure button, not a link. */
const couponLinks = (root: ParentNode = document) =>
  [...root.querySelectorAll('[data-voucher-row]')].map((el) => `/coupon/${el.getAttribute('data-voucher-row')}`)

beforeEach(() => {
  localStorage.clear()
  h.rows = []
})
afterEach(cleanup)

describe('the opened row (was the coupon detail screen, #265)', () => {
  it('a live coupon inside the week: date plus countdown, a ready badge, and no QR (#419)', async () => {
    h.rows = [row('live', 3 * DAY + 3_600_000)]
    const panel = await openCoupon('live')
    const expires = h.rows[0]!.expires_at!
    expect(within(panel).getByText(`${formatDate(expires)} · in 3 days`)).toBeTruthy()
    expect(within(panel).getByText('Ready to use')).toBeTruthy()
    // The row's own badge carries the urgency the old "Use it before" callout did.
    expect(screen.getByRole('img', { name: /^Expires in 3 days, on / })).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('img', { name: /^Redemption code/i })).toBeNull()
  })

  it('beyond the week: the countdown, but no badge', async () => {
    h.rows = [row('far', 30 * DAY + 3_600_000)]
    const panel = await openCoupon('far')
    expect(within(panel).getByText(/· in 30 days$/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: /^Expires in/ })).toBeNull()
  })

  it('an expired coupon: "Expired", never "Ready to use", opened inside the Expired group', async () => {
    h.rows = [row('gone', -3_600_000)]
    const panel = await openCoupon('gone')
    const expires = h.rows[0]!.expires_at!
    expect(within(panel).queryByText('Ready to use')).toBeNull()
    expect(within(panel).getByText('Expired')).toBeTruthy()
    expect(within(panel).getByText(`Expired on ${formatDate(expires)}`)).toBeTruthy()
    expect(panel.closest('details')?.hasAttribute('open')).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('img', { name: /^Redemption code/i })).toBeNull()
  })

  it('a coupon already spent another way keeps what happened to it, and is not "Expired"', async () => {
    // Review of #269: a swapped-back or spent coupon must read as what happened to it, never as
    // live or expired.
    expect(voucherStatusKind(row('swapped', 3 * DAY, { status: 'swapped_to_sats' }))).toBe('swapped')
    expect(voucherStatusKind(row('spentOld', -3_600_000, { status: 'spent' }))).toBe('spent')
    expect(voucherStatusKind(row('p', DAY, { status: 'pending' }))).toBe('pending')
    expect(voucherStatusKind(row('r', -DAY, { status: 'redeemed' }))).toBe('redeemed')
    expect(voucherStatusKind(row('x', -DAY))).toBe('expired')
  })

  it('a coupon with no expiry says so in the opened row', async () => {
    h.rows = [row('never', undefined)]
    const panel = await openCoupon('never')
    expect(within(panel).getByText('No expiry')).toBeTruthy()
  })

  it('a link to a voucher no longer held says so, with a way home', async () => {
    h.rows = []
    render(
      <MemoryRouter initialEntries={['/coupon/missing']}>
        <Routes>
          <Route path="/coupon/:tokenId" element={<CouponRedirect />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('This voucher is no longer in your wallet.')
    expect(screen.getByRole('link', { name: /Back to Home/ }).getAttribute('href')).toBe('/')
  })
})

describe('coupon list (#265)', () => {
  it('soonest first by default, with badges carrying text, tone and an accessible label', async () => {
    h.rows = [
      row('far', 30 * DAY, { created_at: '2026-10-12T00:00:00Z' }),
      row('week', 5 * DAY + 3_600_000, { created_at: '2026-10-01T00:00:00Z' }),
      row('day', 12 * 3_600_000 + 60_000, { created_at: '2026-10-05T00:00:00Z' }),
    ]
    openList()
    await screen.findByText('3 vouchers')
    const order = couponLinks()
    expect(order).toEqual(['/coupon/day', '/coupon/week', '/coupon/far'])

    const amber = screen.getByRole('img', { name: /^Expires in 5 days, on / })
    expect(amber.getAttribute('data-expiry-tone')).toBe('soon')
    expect(amber.textContent).toBe('Expires in 5 days')
    const red = screen.getByRole('img', { name: /^Expires in 12 hours, on / })
    expect(red.getAttribute('data-expiry-tone')).toBe('urgent')
    // Beyond the week: no badge at all.
    expect(screen.queryByRole('img', { name: /Expires in 30 days/ })).toBeNull()
  })

  it('"Newest" restores the received-date order, and is remembered', async () => {
    h.rows = [
      row('far', 30 * DAY, { created_at: '2026-10-12T00:00:00Z' }),
      row('week', 5 * DAY, { created_at: '2026-10-01T00:00:00Z' }),
    ]
    openList()
    await screen.findByText('2 vouchers')
    fireEvent.click(screen.getByRole('button', { name: 'Newest' }))
    await waitFor(() =>
      expect(couponLinks()).toEqual(['/coupon/far', '/coupon/week']),
    )
    expect(localStorage.getItem('imani-wallet:coupon-sort')).toBe('newest')
  })

  it('expired coupons sit in a collapsed "Expired (N)" group, not counted, not silently gone', async () => {
    h.rows = [row('live', 5 * DAY), row('x1', -DAY), row('x2', -2 * DAY)]
    openList()
    await screen.findByText('1 voucher')
    const summary = screen.getByText('Expired (2)')
    const group = summary.closest('details')!
    expect(group.hasAttribute('open')).toBe(false)
    expect(couponLinks(group)).toEqual(['/coupon/x1', '/coupon/x2'])
    expect(within(group).getAllByText(/^Expired /).length).toBeGreaterThanOrEqual(2)
  })

  it('with only expired coupons, the list says why it is empty', async () => {
    h.rows = [row('x1', -DAY)]
    openList()
    await screen.findByText('No vouchers you can still use.')
    expect(screen.getByText('Expired (1)')).toBeTruthy()
  })
})

describe('one voucher held as several rows reads as ONE voucher', () => {
  // A checkout code's change, a Cashlink take-back: one voucher, one row per proof (faceSplit.ts).
  const sixPieces = () =>
    [566, 283, 35, 9, 4, 1].map((face, i) =>
      row(`piece-${i}`, 30 * DAY, { voucher_id: 'v-one', face_value: face, amount: face }),
    )

  it('the list counts it once, shows its whole value, and links to one row', async () => {
    h.rows = sixPieces()
    openList()
    await screen.findByText('1 voucher')
    expect(screen.queryByText('6 vouchers')).toBeNull()
    expect(couponLinks()).toEqual(['/coupon/piece-0'])
    expect(screen.getByText('€8.98')).toBeTruthy()
  })

  it('still lists two different vouchers as two', async () => {
    h.rows = [...sixPieces(), row('other', 30 * DAY)]
    openList()
    await screen.findByText('2 vouchers')
    expect(couponLinks()).toHaveLength(2)
  })

  it('a link to any of its rows opens the one row, at the whole value', async () => {
    h.rows = sixPieces()
    const panel = await openCoupon('piece-3')
    expect(panel.getAttribute('aria-label')).toBe('€8.98')
  })
})
